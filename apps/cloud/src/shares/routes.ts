import {
  CreateShareRequest,
  FinalizeDeployRequest,
  SHARE_CODE_PATH_PREFIX,
  type CreateShareResponse,
  type DeployTokenResponse,
  type FinalizeDeployResponse,
  type ShareInfo,
  type SharedProjectResponse,
} from "@ballast/cloud-protocol";
import {
  formatShareCode,
  type ShareRow,
  type SharesApiError,
  type SharesApiRpc,
} from "@ballast/shares-api";
import { Clock, Effect } from "effect";

import { HttpError, forbidden, notFound, upstreamError } from "../errors.ts";
import { clientIp, decodeJson, json } from "../http.ts";
import type { HttpRequest, HttpResponse } from "../http.ts";
import type { SharePrincipal } from "./auth.ts";

export const SHARE_WINDOW_MS = 15 * 60_000;
export const SHARES_PER_WINDOW = 20;
/**
 * Share-code reads per client IP in one window. A subscriber polls each
 * subscription every 5 minutes; codes (60 random bits) are not guessable,
 * so this bounds cost more than brute force.
 */
export const CODE_READS_PER_WINDOW = 300;

export interface ShareRoutesDeps {
  /**
   * The shares API (`@ballast/shares-api`) over its service binding: repo
   * storage, the shares database and manifest diffs.
   */
  readonly api: SharesApiRpc;
  readonly enforceRateLimit: (
    bucket: string,
    limit: number,
    windowMs: number,
    now: number,
  ) => Effect.Effect<void, HttpError>;
}

const infoOf = (row: ShareRow, who: SharePrincipal | undefined): ShareInfo => ({
  shareId: row.id,
  name: row.name,
  currentSha: row.currentSha,
  message: row.message,
  deployedAt: row.deployedAt,
  owner: who !== undefined && row.ownerUserId === who.user.id,
});

/**
 * The shares API answers with the status and tag to use. Over the service
 * binding the error arrives as a plain `{ _tag, ...fields }` object; a
 * transport failure has another shape and becomes a 502.
 */
const fromSharesApi = (error: SharesApiError): HttpError =>
  error._tag === "SharesApiError" && typeof error.status === "number"
    ? new HttpError({
        status: error.status,
        tag: error.tag,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      })
    : upstreamError("The shares API could not be reached");

/**
 * `/api/shares/*` (decisions 0013, 0014). Publishing is for signed-in
 * people: the owner (the share's user) creates, reads and deploys. Reading
 * a share needs only its share code, so subscribers never sign in; the
 * shares API Worker stores and serves the files. Subscribers poll.
 */
export const makeShareRoutes = (deps: ShareRoutesDeps) => {
  const { api } = deps;

  const owned = (who: SharePrincipal, id: string) =>
    Effect.flatMap(api.getShare(id), (row) =>
      row === null
        ? Effect.fail(notFound("Unknown share"))
        : row.ownerUserId === who.user.id
          ? Effect.succeed(row)
          : Effect.fail(forbidden("Only the share's owner can do that")),
    );

  const create = (who: SharePrincipal, request: HttpRequest) =>
    Effect.gen(function* () {
      const body = yield* decodeJson(CreateShareRequest, request.body);
      yield* deps.enforceRateLimit("share:" + who.user.id, SHARES_PER_WINDOW, SHARE_WINDOW_MS, yield* Clock.currentTimeMillis);
      const row = yield* api
        .createShare({ ownerUserId: who.user.id, name: body.name })
        .pipe(Effect.mapError(fromSharesApi));
      return json(201, {
        share: infoOf(row, who),
        shareCode: formatShareCode(row.shareCode),
      } satisfies CreateShareResponse);
    });

  const get = (who: SharePrincipal, id: string) =>
    Effect.map(owned(who, id), (row) =>
      json(200, { share: infoOf(row, who), shareCode: formatShareCode(row.shareCode) }),
    );

  const deployToken = (who: SharePrincipal, id: string) =>
    Effect.gen(function* () {
      yield* owned(who, id);
      const token = yield* api.deployToken(id).pipe(Effect.mapError(fromSharesApi));
      return json(200, token satisfies DeployTokenResponse);
    });

  const finalize = (who: SharePrincipal, id: string, request: HttpRequest) =>
    Effect.gen(function* () {
      const body = yield* decodeJson(FinalizeDeployRequest, request.body);
      yield* owned(who, id);
      const deployed = yield* api
        .recordDeploy({ id, sha: body.sha, message: body.message?.trim().slice(0, 500) || null })
        .pipe(Effect.mapError(fromSharesApi));
      return json(200, {
        share: infoOf(deployed.share, who),
        manifestHash: deployed.manifestHash,
      } satisfies FinalizeDeployResponse);
    });

  const byCode = (request: HttpRequest, code: string) =>
    Effect.gen(function* () {
      yield* deps.enforceRateLimit(
        "share-code:" + clientIp(request),
        CODE_READS_PER_WINDOW,
        SHARE_WINDOW_MS,
        yield* Clock.currentTimeMillis,
      );
      const row = yield* api.findShareByCode(code);
      if (row === null) return yield* notFound("Unknown share code");
      return row;
    });

  const diff = (row: ShareRow, url: URL) =>
    Effect.gen(function* () {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const result = yield* api
        .diff({ id: row.id, from: from === null || from === "" ? null : from, to: to === null || to === "" ? null : to })
        .pipe(Effect.mapError(fromSharesApi));
      return json(200, result);
    });

  /** Share-code reads; undefined when the path is not one. No sign-in. */
  const publicRoute = (request: HttpRequest, url: URL): Effect.Effect<HttpResponse, HttpError> | undefined => {
    if (request.method !== "GET" || !url.pathname.startsWith(SHARE_CODE_PATH_PREFIX)) return undefined;
    const match = /^([^/]+)(\/diff)?$/.exec(url.pathname.slice(SHARE_CODE_PATH_PREFIX.length));
    if (match === null || match[1] === undefined) return undefined;
    const code = decodeURIComponent(match[1]);
    return Effect.flatMap(byCode(request, code), (row) =>
      match[2] === undefined
        ? Effect.succeed(json(200, { share: infoOf(row, undefined) } satisfies SharedProjectResponse))
        : diff(row, url),
    );
  };

  /** Publishing routes for the signed-in owner; undefined when the path is not one. */
  const route = (
    who: SharePrincipal,
    request: HttpRequest,
    url: URL,
  ): Effect.Effect<HttpResponse, HttpError> | undefined => {
    const path = url.pathname;
    const method = request.method;
    if (method === "POST" && path === "/api/shares") return create(who, request);
    const match = /^\/api\/shares\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
    if (match === null || match[1] === undefined) return undefined;
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    if (method === "GET" && action === undefined) return get(who, id);
    if (method === "POST" && action === "deploy-token") return deployToken(who, id);
    if (method === "POST" && action === "deploys") return finalize(who, id, request);
    return undefined;
  };

  return { route, publicRoute };
};
