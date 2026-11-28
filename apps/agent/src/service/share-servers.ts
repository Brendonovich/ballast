import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  ShareServerUser,
  agentError,
  type AgentError,
  type ShareServerSummary,
  type ShareServersStatus,
  type ShareSignIn,
} from "@ballast/agent-protocol";
import {
  ApiErrorBody,
  SHARE_AUTH_LOGIN_PATH,
  SHARE_AUTH_LOGOUT_PATH,
  SHARE_AUTH_TOKEN_PATH,
  ShareAuthTokenResponse,
} from "@ballast/cloud-protocol";

import { CloudLink } from "./cloud-link.ts";
import { defaultCloudUrl, machineName } from "./config.ts";
import { readJson, writeJsonAtomic } from "./fs.ts";
import { ProjectManager } from "./projects.ts";
import { Logs, ServiceHub } from "./telemetry.ts";

/** Where the share server sends the browser back to this service. */
export const SHARE_AUTH_CALLBACK_ROUTE = "/share-auth/callback";

/**
 * Share servers (decision 0014): which server new shares use, and this
 * machine's session with each. A session comes from a browser sign-in the
 * server runs against its identity provider ("Sign in with Anomaly" for the
 * hosted cloud); the service only sees the server's bearer token.
 */
export interface ShareServersService {
  readonly status: Effect.Effect<ShareServersStatus>;
  /** A normalized server URL: the one given, or the default. */
  readonly resolve: (server?: string) => Effect.Effect<string, AgentError>;
  readonly beginSignIn: (server?: string) => Effect.Effect<ShareSignIn, AgentError>;
  /** The loopback callback; answers with the page the browser shows. */
  readonly completeSignIn: (query: URLSearchParams) => Effect.Effect<{ readonly ok: boolean; readonly message: string }>;
  readonly signOut: (server: string) => Effect.Effect<ShareServersStatus, AgentError>;
  readonly setDefault: (server?: string) => Effect.Effect<ShareServersStatus, AgentError>;
  readonly isSignedIn: (server: string) => Effect.Effect<boolean>;
  /** An unauthenticated share-server call (share-code reads). */
  readonly fetchPublic: <A>(server: string, schema: Schema.Codec<A, unknown>, route: string) => Effect.Effect<A, AgentError>;
  /** A share-server API call with this machine's session; a 401 signs the server out. */
  readonly call: <A>(
    server: string,
    schema: Schema.Codec<A, unknown>,
    method: "GET" | "POST",
    route: string,
    body?: unknown,
  ) => Effect.Effect<A, AgentError>;
  /** Set once the HTTP server is listening, e.g. `http://127.0.0.1:47830`. */
  readonly setCallbackBase: (base: string) => Effect.Effect<void>;
}

export class ShareServers extends Context.Service<ShareServers, ShareServersService>()(
  "ballast/service/ShareServers",
) {}

const Session = Schema.Struct({
  token: Schema.String,
  user: ShareServerUser,
  signedInAt: Schema.Number,
});
type Session = typeof Session.Type;

const StoredServers = Schema.Struct({
  version: Schema.Literal(1),
  defaultServer: Schema.optionalKey(Schema.String),
  sessions: Schema.Record(Schema.String, Session),
});
type StoredServers = typeof StoredServers.Type;

const SIGN_IN_TTL_MS = 15 * 60_000;
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * A share server's base URL without a trailing slash. Tokens never travel
 * over plain http except to this machine (local development).
 */
export const normalizeShareServer = (value: string): string | undefined => {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHosts.has(url.hostname))) return undefined;
    if (url.username !== "" || url.password !== "") return undefined;
    return (url.origin + url.pathname).replace(/\/+$/, "");
  } catch {
    return undefined;
  }
};

const errorText = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
    ? cause.message
    : String(cause);

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const randomUrlToken = (): string => base64Url(crypto.getRandomValues(new Uint8Array(32)));

const s256 = async (verifier: string): Promise<string> =>
  base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

const tagOf = (status: number, tag: string | undefined): AgentError["tag"] =>
  tag === "not_found"
    ? "not-found"
    : tag === "conflict"
      ? "conflict"
      : tag === "invalid_request"
        ? "invalid"
        : tag === "unauthorized" || tag === "forbidden" || status === 401
          ? "unauthorized"
          : "upstream";

/** One HTTP call to a share server, decoding `{ error }` bodies into AgentError. */
const request = <A>(
  server: string,
  schema: Schema.Codec<A, unknown>,
  method: "GET" | "POST",
  route: string,
  body: unknown,
  token: string | undefined,
): Effect.Effect<{ readonly status: number; readonly value: A }, AgentError & { readonly status?: number }> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(server + route, {
          method,
          headers: {
            accept: "application/json",
            ...(token === undefined ? {} : { authorization: "Bearer " + token }),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(60_000),
        }),
      catch: (cause) => agentError("upstream", "Could not reach the share server " + server + ": " + errorText(cause)),
    });
    const json = yield* Effect.tryPromise({
      try: async (): Promise<unknown> => {
        const text = await response.text();
        return text.trim() === "" ? undefined : JSON.parse(text);
      },
      catch: () => agentError("upstream", "The share server returned invalid JSON (" + response.status + ")"),
    });
    if (!response.ok) {
      const parsed = Schema.decodeUnknownOption(ApiErrorBody)(json);
      const message = Option.isSome(parsed)
        ? parsed.value.error.message
        : "Share server request failed (" + response.status + ")";
      const tag = Option.isSome(parsed) ? parsed.value.error.tag : undefined;
      return yield* Effect.fail({ ...agentError(tagOf(response.status, tag), message), status: response.status });
    }
    const value = yield* Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.mapError((cause) => agentError("upstream", "Unexpected share server response: " + cause.message)),
    );
    return { status: response.status, value };
  });

const withoutStatus = (error: AgentError & { readonly status?: number }): AgentError => {
  const { status: _status, ...rest } = error;
  return rest;
};

export const ShareServersLive = (options: {
  readonly dataDir: string;
  /** `BALLAST_SHARE_SERVER` / `--share-server`. */
  readonly shareServer: string | undefined;
  /** `BALLAST_CLOUD_URL` / `--cloud`, the fallback default. */
  readonly cloudUrl: string | undefined;
}) =>
  Layer.effect(
    ShareServers,
    Effect.gen(function* () {
      const cloud = yield* CloudLink;
      const projects = yield* ProjectManager;
      const hub = yield* ServiceHub;
      const logs = yield* Logs;
      const path = yield* Path.Path;
      const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom>();
      const file = path.join(options.dataDir, "share-servers.json");

      const loaded = yield* readJson(file).pipe(
        Effect.flatMap((value) =>
          value === undefined ? Effect.succeed(undefined) : Schema.decodeUnknownEffect(StoredServers)(value),
        ),
        Effect.provideContext(platform),
        Effect.catch((error) =>
          logs
            .write({ level: "warn", source: "agent", message: "ignoring unreadable share-servers.json: " + errorText(error) })
            .pipe(Effect.as(undefined)),
        ),
      );
      const stored = yield* Ref.make<StoredServers>(loaded ?? { version: 1, sessions: {} });
      const pending = yield* Ref.make(
        new Map<string, { readonly server: string; readonly verifier: string; readonly expiresAt: number }>(),
      );
      const callbackBase = yield* Ref.make<string | undefined>(undefined);

      const save = (next: StoredServers) =>
        Effect.gen(function* () {
          yield* Ref.set(stored, next);
          yield* writeJsonAtomic(file, next).pipe(
            Effect.provideContext(platform),
            Effect.mapError((cause) => agentError("internal", "Could not save share servers: " + errorText(cause))),
          );
        });

      const builtInDefault = Effect.gen(function* () {
        for (const candidate of [options.shareServer, options.cloudUrl, (yield* cloud.status).cloudUrl, defaultCloudUrl]) {
          const normalized = candidate === undefined ? undefined : normalizeShareServer(candidate);
          if (normalized !== undefined) return normalized;
        }
        return undefined;
      });

      const defaultServer = Effect.gen(function* () {
        return (yield* Ref.get(stored)).defaultServer ?? (yield* builtInDefault);
      });

      const status: Effect.Effect<ShareServersStatus> = Effect.gen(function* () {
        const current = yield* Ref.get(stored);
        const fallback = yield* defaultServer;
        const counts = new Map<string, number>();
        for (const project of yield* projects.projects) {
          const server = project.share?.server;
          if (server !== undefined) counts.set(server, (counts.get(server) ?? 0) + 1);
        }
        const urls = new Set<string>([
          ...(fallback === undefined ? [] : [fallback]),
          ...Object.keys(current.sessions),
          ...counts.keys(),
        ]);
        const servers: Array<ShareServerSummary> = [...urls].sort().map((url) => {
          const session = current.sessions[url];
          return {
            url,
            default: url === fallback,
            projects: counts.get(url) ?? 0,
            ...(session === undefined ? {} : { user: session.user, signedInAt: session.signedInAt }),
          };
        });
        return { ...(fallback === undefined ? {} : { defaultServer: fallback }), servers };
      });

      const publish = (signIn?: { readonly server: string; readonly ok: boolean; readonly error?: string }) =>
        Effect.flatMap(status, (next) =>
          hub.publish({ _tag: "share-servers", status: next, ...(signIn === undefined ? {} : { signIn }) }),
        );

      const resolve = (server?: string): Effect.Effect<string, AgentError> =>
        Effect.gen(function* () {
          if (server !== undefined) {
            const normalized = normalizeShareServer(server);
            if (normalized === undefined)
              return yield* Effect.fail(
                agentError("invalid", `"${server}" is not a share server URL (https://, or http:// on this machine)`),
              );
            return normalized;
          }
          const fallback = yield* defaultServer;
          if (fallback === undefined)
            return yield* Effect.fail(
              agentError(
                "invalid",
                "No share server is configured. Set one in Settings → Sharing, pass --server, or set BALLAST_SHARE_SERVER.",
              ),
            );
          return fallback;
        });

      const outdated = (server: string) =>
        agentError(
          "upstream",
          `${server} does not support share links or Sign in with Anomaly yet; it needs to be updated to the current Ballast cloud`,
        );

      const forget = (server: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(stored);
          if (current.sessions[server] === undefined) return;
          const { [server]: _removed, ...sessions } = current.sessions;
          yield* save({ ...current, sessions }).pipe(Effect.ignore);
          yield* publish();
        });

      const beginSignIn = (server?: string) =>
        Effect.gen(function* () {
          const target = yield* resolve(server);
          const base = yield* Ref.get(callbackBase);
          if (base === undefined)
            return yield* Effect.fail(agentError("internal", "The service is not listening for sign-in callbacks yet"));
          // A server without sign-in answers its old machine-token 401; say so before opening a browser.
          const probe = yield* Effect.tryPromise({
            try: () => fetch(target + SHARE_AUTH_LOGIN_PATH, { redirect: "manual", signal: AbortSignal.timeout(10_000) }),
            catch: (cause) => agentError("upstream", "Could not reach the share server " + target + ": " + errorText(cause)),
          });
          if (probe.status === 401) return yield* Effect.fail(outdated(target));
          const state = randomUrlToken();
          const verifier = randomUrlToken();
          const now = Date.now();
          const expiresAt = now + SIGN_IN_TTL_MS;
          yield* Ref.update(pending, (current) => {
            const next = new Map([...current].filter(([, entry]) => entry.expiresAt > now));
            next.set(state, { server: target, verifier, expiresAt });
            return next;
          });
          const query = new URLSearchParams({
            redirect_uri: base + SHARE_AUTH_CALLBACK_ROUTE,
            state,
            code_challenge: yield* Effect.promise(() => s256(verifier)),
            code_challenge_method: "S256",
          });
          return { server: target, url: target + SHARE_AUTH_LOGIN_PATH + "?" + query.toString(), expiresAt };
        });

      const completeSignIn = (query: URLSearchParams) =>
        Effect.gen(function* () {
          const state = query.get("state") ?? "";
          const entry = (yield* Ref.get(pending)).get(state);
          if (entry === undefined || entry.expiresAt <= Date.now())
            return { ok: false, message: "This sign-in has expired or was already used. Start again from Ballast." };
          yield* Ref.update(pending, (current) => {
            const next = new Map(current);
            next.delete(state);
            return next;
          });
          const failed = (message: string) =>
            Effect.gen(function* () {
              yield* logs.write({ level: "warn", source: "agent", message: `sign-in to ${entry.server} failed: ${message}` });
              yield* publish({ server: entry.server, ok: false, error: message });
              return { ok: false, message };
            });
          const error = query.get("error");
          if (error !== null)
            return yield* failed(error === "access_denied" ? "Sign-in was cancelled" : query.get("error_description") ?? error);
          const code = query.get("code");
          if (code === null) return yield* failed("The share server sent no sign-in code");
          const exchanged = yield* Effect.result(
            request(entry.server, ShareAuthTokenResponse, "POST", SHARE_AUTH_TOKEN_PATH, {
              code,
              codeVerifier: entry.verifier,
              deviceName: machineName(),
            }, undefined),
          );
          if (exchanged._tag === "Failure")
            return yield* failed(
              exchanged.failure.status === 401 ? outdated(entry.server).message : exchanged.failure.message,
            );
          const { token, user } = exchanged.success.value;
          const current = yield* Ref.get(stored);
          const saved = yield* Effect.result(
            save({ ...current, sessions: { ...current.sessions, [entry.server]: { token, user, signedInAt: Date.now() } } }),
          );
          if (saved._tag === "Failure") return yield* failed(saved.failure.message);
          const who = user.username ?? user.name ?? user.id;
          yield* logs.write({ level: "info", source: "agent", message: `signed in to ${entry.server} as ${who}` });
          yield* publish({ server: entry.server, ok: true });
          return { ok: true, message: `Signed in to Ballast sharing as ${who}. You can close this tab.` };
        });

      const signOut = (server: string) =>
        Effect.gen(function* () {
          const target = yield* resolve(server);
          const session = (yield* Ref.get(stored)).sessions[target];
          if (session !== undefined)
            yield* request(target, Schema.Unknown, "POST", SHARE_AUTH_LOGOUT_PATH, undefined, session.token).pipe(
              Effect.ignore,
            );
          yield* forget(target);
          return yield* status;
        });

      const setDefault = (server?: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(stored);
          if (server === undefined) {
            const { defaultServer: _previous, ...rest } = current;
            yield* save(rest);
          } else {
            yield* save({ ...current, defaultServer: yield* resolve(server) });
          }
          yield* publish();
          return yield* status;
        });

      const call = <A>(
        server: string,
        schema: Schema.Codec<A, unknown>,
        method: "GET" | "POST",
        route: string,
        body?: unknown,
      ): Effect.Effect<A, AgentError> =>
        Effect.gen(function* () {
          const session = (yield* Ref.get(stored)).sessions[server];
          if (session === undefined)
            return yield* Effect.fail(
              agentError("unauthorized", `Sign in to ${server} to publish projects (ballast shares login --server ${server})`),
            );
          return yield* request(server, schema, method, route, body, session.token).pipe(
            Effect.map((response) => response.value),
            Effect.catch((error) =>
              error.status === 401
                ? Effect.andThen(
                    forget(server),
                    Effect.fail(agentError("unauthorized", `Your session with ${server} ended; sign in again`)),
                  )
                : Effect.fail(withoutStatus(error)),
            ),
          );
        });

      return ShareServers.of({
        status,
        resolve,
        beginSignIn,
        completeSignIn,
        signOut,
        setDefault,
        fetchPublic: (server, schema, route) =>
          request(server, schema, "GET", route, undefined, undefined).pipe(
            Effect.map((response) => response.value),
            // These routes take no credentials; a 401 means the server predates them.
            Effect.mapError((error) =>
              error.status === 401 ? outdated(server) : withoutStatus(error),
            ),
          ),
        isSignedIn: (server) => Effect.map(Ref.get(stored), (current) => current.sessions[server] !== undefined),
        call,
        setCallbackBase: (base) => Ref.set(callbackBase, base),
      });
    }),
  );
