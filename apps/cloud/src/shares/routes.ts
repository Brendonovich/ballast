import {
  CreateShareRequest,
  FinalizeDeployRequest,
  ShareIdRequest,
  ReportInstalledRequest,
  SubscribeRequest,
  type CreateShareResponse,
  type DeployTokenResponse,
  type FinalizeDeployResponse,
  type ListShareSubscriptionsResponse,
  type ShareInfo,
  type SubscribeResponse,
} from "@ballast/cloud-protocol";
import {
  formatShareCode,
  type ShareRow,
  type SharesApiError,
  type SharesApiRpc,
} from "@ballast/shares-api";
import { Clock, Effect } from "effect";

import { HttpError, forbidden, notFound, upstreamError } from "../errors.ts";
import { decodeJson, json } from "../http.ts";
import type { HttpRequest, HttpResponse } from "../http.ts";
import type { RelayGatewayService } from "../relay/gateway.ts";
import type { MachineRow } from "../store.ts";

/** Subscribe attempts per machine in one window; share codes are guessable only by brute force. */
export const SUBSCRIBE_LIMIT = 20;
export const SUBSCRIBE_WINDOW_MS = 15 * 60_000;
export const SHARES_PER_WINDOW = 20;

export interface ShareRoutesDeps {
  /**
   * The shares API (`@ballast/shares-api`) over its service binding: repo
   * storage, the shares database and manifest diffs.
   */
  readonly api: SharesApiRpc;
  readonly relay: RelayGatewayService;
  readonly enforceRateLimit: (
    bucket: string,
    limit: number,
    windowMs: number,
    now: number,
  ) => Effect.Effect<void, HttpError>;
}

const infoOf = (row: ShareRow, machine: MachineRow): ShareInfo => ({
  shareId: row.id,
  name: row.name,
  currentSha: row.currentSha,
  message: row.message,
  deployedAt: row.deployedAt,
  owner: row.ownerUserId === machine.userId,
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
 * `/api/shares/*` (decision 0013). The cloud authenticates the machine
 * and authorizes every call (owner = the share's user; readers = owner
 * or subscribed machines; share codes grant subscribe); the shares API Worker
 * stores and serves the files. Deploys notify subscribers over the relay.
 */
export const makeShareRoutes = (deps: ShareRoutesDeps) => {
  const { api, relay } = deps;

  const share = (id: string) =>
    Effect.flatMap(api.getShare(id), (row) =>
      row === null ? Effect.fail(notFound("Unknown share")) : Effect.succeed(row),
    );

  const owned = (machine: MachineRow, id: string) =>
    Effect.flatMap(share(id), (row) =>
      row.ownerUserId === machine.userId
        ? Effect.succeed(row)
        : Effect.fail(forbidden("Only the share's owner can deploy it")),
    );

  const readable = (machine: MachineRow, id: string) =>
    Effect.gen(function* () {
      const row = yield* share(id);
      if (row.ownerUserId === machine.userId) return row;
      if (!(yield* api.isSubscribed({ shareId: id, machineId: machine.id })))
        return yield* forbidden("This machine is not subscribed to that share");
      return row;
    });

  const create = (machine: MachineRow, request: HttpRequest) =>
    Effect.gen(function* () {
      const body = yield* decodeJson(CreateShareRequest, request.body);
      yield* deps.enforceRateLimit(
        "share:" + machine.userId,
        SHARES_PER_WINDOW,
        SUBSCRIBE_WINDOW_MS,
        yield* Clock.currentTimeMillis,
      );
      const row = yield* api
        .createShare({ ownerUserId: machine.userId, ownerMachineId: machine.id, name: body.name })
        .pipe(Effect.mapError(fromSharesApi));
      return json(201, {
        share: infoOf(row, machine),
        shareCode: formatShareCode(row.shareCode),
      } satisfies CreateShareResponse);
    });

  const get = (machine: MachineRow, id: string) =>
    Effect.gen(function* () {
      const row = yield* readable(machine, id);
      return json(200, {
        share: infoOf(row, machine),
        ...(row.ownerUserId === machine.userId ? { shareCode: formatShareCode(row.shareCode) } : {}),
      });
    });

  const deployToken = (machine: MachineRow, id: string) =>
    Effect.gen(function* () {
      yield* owned(machine, id);
      const token = yield* api.deployToken(id).pipe(Effect.mapError(fromSharesApi));
      return json(200, token satisfies DeployTokenResponse);
    });

  const finalize = (machine: MachineRow, id: string, request: HttpRequest) =>
    Effect.gen(function* () {
      const body = yield* decodeJson(FinalizeDeployRequest, request.body);
      yield* owned(machine, id);
      const deployed = yield* api
        .recordDeploy({ id, sha: body.sha, message: body.message?.trim().slice(0, 500) || null })
        .pipe(Effect.mapError(fromSharesApi));
      let notified = 0;
      const row = deployed.share;
      for (const machineId of deployed.subscribers) {
        const sent = yield* relay
          .notify(machineId, {
            _tag: "share_update",
            shareId: row.id,
            sha: body.sha,
            message: row.message,
            deployedAt: row.deployedAt ?? (yield* Clock.currentTimeMillis),
          })
          .pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)));
        if (sent) notified += 1;
      }
      return json(200, {
        share: infoOf(row, machine),
        manifestHash: deployed.manifestHash,
        notified,
      } satisfies FinalizeDeployResponse);
    });

  const subscribe = (machine: MachineRow, request: HttpRequest) =>
    Effect.gen(function* () {
      const body = yield* decodeJson(SubscribeRequest, request.body);
      yield* deps.enforceRateLimit(
        "subscribe:" + machine.id,
        SUBSCRIBE_LIMIT,
        SUBSCRIBE_WINDOW_MS,
        yield* Clock.currentTimeMillis,
      );
      const found = yield* api.findShareByCode(body.shareCode);
      if (found === null) return yield* notFound("Unknown share code");
      yield* api.subscribe({ shareId: found.id, machineId: machine.id });
      return json(200, { share: infoOf(found, machine) } satisfies SubscribeResponse);
    });

  const unsubscribe = (machine: MachineRow, request: HttpRequest) =>
    Effect.gen(function* () {
      const body = yield* decodeJson(ShareIdRequest, request.body);
      yield* api.unsubscribe({ shareId: body.shareId, machineId: machine.id });
      return json(200, { ok: true });
    });

  const installed = (machine: MachineRow, request: HttpRequest) =>
    Effect.gen(function* () {
      const body = yield* decodeJson(ReportInstalledRequest, request.body);
      yield* readable(machine, body.shareId);
      yield* api.setInstalledSha({ shareId: body.shareId, machineId: machine.id, sha: body.sha });
      return json(200, { ok: true });
    });

  const list = (machine: MachineRow) =>
    Effect.map(api.listSubscriptions(machine.id), (rows) =>
      json(200, {
        subscriptions: rows.map((row) => ({
          share: infoOf(row.share, machine),
          installedSha: row.installedSha,
        })),
      } satisfies ListShareSubscriptionsResponse),
    );

  const diff = (machine: MachineRow, id: string, url: URL) =>
    Effect.gen(function* () {
      yield* readable(machine, id);
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const result = yield* api
        .diff({ id, from: from === null || from === "" ? null : from, to: to === null || to === "" ? null : to })
        .pipe(Effect.mapError(fromSharesApi));
      return json(200, result);
    });

  /** Undefined when the path is not a share route. */
  const route = (
    machine: MachineRow,
    request: HttpRequest,
    url: URL,
  ): Effect.Effect<HttpResponse, HttpError> | undefined => {
    const path = url.pathname;
    if (path !== "/api/shares" && !path.startsWith("/api/shares/")) return undefined;
    const method = request.method;
    if (method === "POST" && path === "/api/shares") return create(machine, request);
    if (method === "POST" && path === "/api/shares/subscriptions") return subscribe(machine, request);
    if (method === "GET" && path === "/api/shares/subscriptions") return list(machine);
    if (method === "POST" && path === "/api/shares/unsubscribe") return unsubscribe(machine, request);
    if (method === "POST" && path === "/api/shares/installed") return installed(machine, request);
    const match = /^\/api\/shares\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
    if (match === null || match[1] === undefined) return undefined;
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    if (method === "GET" && action === undefined) return get(machine, id);
    if (method === "POST" && action === "deploy-token") return deployToken(machine, id);
    if (method === "POST" && action === "deploys") return finalize(machine, id, request);
    if (method === "GET" && action === "diff") return diff(machine, id, url);
    return undefined;
  };

  return { route };
};
