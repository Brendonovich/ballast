import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { createServer } from "node:http";
import type { Server } from "node:http";

/**
 * Node-only helper for the local authorization-code flow: listen on a
 * loopback port, open the browser at the returned authorize URL, and wait for
 * Twitch to redirect back with a code. Kept behind the
 * `@ballast/module-twitch/oauth/callback-server` subpath so cloud bundles
 * never import node:http.
 */

export class OAuthCallbackError extends Schema.TaggedError<OAuthCallbackError>()(
  "OAuthCallbackError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

export interface CallbackServerOptions {
  /** Defaults to 127.0.0.1; Twitch requires an exact redirect URI match. */
  readonly host?: string;
  /** Defaults to 0, which lets the OS choose a free port. */
  readonly port?: number;
  /** Defaults to "/callback". */
  readonly path?: string;
  /** When set, the callback must echo this state value. */
  readonly state?: string;
  /** Defaults to 5 minutes. */
  readonly timeout?: Duration.Input;
  readonly successHtml?: string;
  readonly failureHtml?: string;
}

export interface OAuthCallbackResult {
  readonly code: string;
  readonly state: string | undefined;
  /** The exact redirect URI to send to the token endpoint. */
  readonly redirectUri: string;
}

export interface OAuthCallbackServer {
  readonly redirectUri: string;
  readonly wait: Effect.Effect<OAuthCallbackResult, OAuthCallbackError>;
}

type CallbackMessage =
  | { readonly _tag: "authorized"; readonly code: string; readonly state: string | undefined }
  | { readonly _tag: "failed"; readonly reason: string };

const defaultSuccessHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Twitch connected</title></head>
  <body style="font-family: system-ui, sans-serif; padding: 2rem">
    <h1>Twitch connected</h1>
    <p>You can close this tab and return to Ballast.</p>
  </body>
</html>`;

const defaultFailureHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Twitch connection failed</title></head>
  <body style="font-family: system-ui, sans-serif; padding: 2rem">
    <h1>Twitch connection failed</h1>
    <p>Return to Ballast and try again.</p>
  </body>
</html>`;

const respond = (response: import("node:http").ServerResponse, status: number, body: string) => {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
};

/**
 * Start a loopback callback server. The server lives for the caller's scope;
 * `wait` resolves once, on the first matching callback.
 */
export const makeCallbackServer = (
  options: CallbackServerOptions = {},
): Effect.Effect<OAuthCallbackServer, OAuthCallbackError, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 0;
    const path = options.path ?? "/callback";
    const results = yield* Queue.unbounded<CallbackMessage>();
    let redirectUri = "";

    const server = yield* Effect.acquireRelease(
      Effect.callback<Server, OAuthCallbackError>((resume) => {
        const started = createServer((request, response) => {
          const url = new URL(request.url ?? "/", "http://" + host + (port === 0 ? "" : ":" + port));
          if (url.pathname !== path) {
            respond(response, 404, "<!doctype html><p>Not found</p>");
            return;
          }

          const error = url.searchParams.get("error");
          if (error !== null) {
            respond(response, 400, options.failureHtml ?? defaultFailureHtml);
            Queue.offerUnsafe(results, {
              _tag: "failed",
              reason: url.searchParams.get("error_description") ?? error,
            });
            return;
          }

          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state") ?? undefined;
          if (code === null || code.length === 0) {
            respond(response, 400, options.failureHtml ?? defaultFailureHtml);
            Queue.offerUnsafe(results, { _tag: "failed", reason: "Callback did not include a code" });
            return;
          }
          if (options.state !== undefined && state !== options.state) {
            respond(response, 400, options.failureHtml ?? defaultFailureHtml);
            Queue.offerUnsafe(results, {
              _tag: "failed",
              reason: "Callback state did not match the authorization request",
            });
            return;
          }

          respond(response, 200, options.successHtml ?? defaultSuccessHtml);
          Queue.offerUnsafe(results, { _tag: "authorized", code, state });
        });

        const onError = (cause: Error) =>
          resume(
            Effect.fail(
              new OAuthCallbackError({
                reason: "Could not start the Twitch callback server: " + cause.message,
              }),
            ),
          );

        started.once("error", onError);
        started.listen(port, host, () => {
          started.off("error", onError);
          resume(Effect.succeed(started));
        });

        return Effect.sync(() => {
          started.off("error", onError);
          started.close();
        });
      }),
      (started) => Effect.sync(() => started.close()),
    );

    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* new OAuthCallbackError({
        reason: "The Twitch callback server did not report a TCP port",
      });
    }
    redirectUri = "http://" + host + ":" + address.port + path;

    const wait = Queue.take(results).pipe(
      Effect.timeoutOrElse({
        duration: options.timeout ?? "5 minutes",
        orElse: () =>
          Effect.fail(
            new OAuthCallbackError({
              reason: "Timed out waiting for the Twitch authorization callback",
            }),
          ),
      }),
      Effect.flatMap((message) =>
        message._tag === "failed"
          ? Effect.fail(new OAuthCallbackError({ reason: message.reason }))
          : Effect.succeed({
              code: message.code,
              state: message.state,
              redirectUri,
            }),
      ),
    );

    return { redirectUri, wait };
  });

/** One-shot convenience: start the server, wait, and close it. */
export const waitForAuthorizationCode = (
  options: CallbackServerOptions = {},
): Effect.Effect<OAuthCallbackResult, OAuthCallbackError, import("effect/Scope").Scope> =>
  Effect.flatMap(makeCallbackServer(options), (server) => server.wait);
