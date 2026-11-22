import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { HttpClient } from "effect/http";
import * as Twitch from "@ballast/module-twitch";
import { makeCallbackServer } from "@ballast/module-twitch/oauth/callback-server";

import {
  oauthConfigOf,
  writeStoredTwitchAccount,
} from "./config.ts";
import type { StoredTwitchAccount, TwitchAppConfig } from "./config.ts";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const defaultOpenUrl = (url: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (process.stdout.isTTY !== true || process.env["CI"] === "1") return;
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "cmd"
          : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          execFile(command, args, (error) => {
            if (error === null) resolve();
            else reject(error);
          });
        }),
      catch: (cause) => new Error("Could not open the browser: " + errorMessage(cause)),
    }).pipe(Effect.ignore);
  });

export interface AuthorizeTwitchAccountOptions {
  readonly slot: string;
  readonly config: TwitchAppConfig;
  readonly dataDir: string;
  readonly scopes: ReadonlyArray<string>;
  /** Force the device-code flow (public clients, or no client secret). */
  readonly device?: boolean;
  /** Fixed localhost callback port; Twitch requires an exact redirect URI. */
  readonly callbackPort?: number;
  readonly openUrl?: (url: string) => Effect.Effect<void>;
}

/**
 * Run the local OAuth flow and store the refresh token under the Ballast data
 * directory. Authorization-code + localhost redirect for confidential apps;
 * device code when there is no client secret (or \`device\` is set).
 */
export const authorizeTwitchAccount = (
  options: AuthorizeTwitchAccountOptions,
): Effect.Effect<StoredTwitchAccount, Error, HttpClient.HttpClient> =>
  Effect.scoped(
    Effect.gen(function* () {
      const oauth = yield* Twitch.OAuth.make(oauthConfigOf(options.config));
      const scopes = [...new Set(options.scopes)];
      const open = options.openUrl ?? defaultOpenUrl;

      const deviceFlow: Effect.Effect<
        Twitch.OAuth.OAuthToken,
        Error,
        Scope.Scope | HttpClient.HttpClient
      > = Effect.gen(function* () {
        const authorization = yield* oauth.startDeviceAuthorization(scopes).pipe(
          Effect.mapError((error) => new Error(error.message)),
        );
        console.log(
          "[twitch:" +
            options.slot +
            "] open " +
            authorization.verificationUri +
            " and enter code " +
            authorization.userCode,
        );
        yield* open(authorization.verificationUri);
        return yield* oauth
          .waitForDeviceToken({
            deviceCode: authorization.deviceCode,
            scopes,
            intervalSeconds: authorization.intervalSeconds,
            expiresIn: authorization.expiresIn,
          })
          .pipe(Effect.mapError((error) => new Error(error.message)));
      });

      const codeFlow: Effect.Effect<
        Twitch.OAuth.OAuthToken,
        Error,
        Scope.Scope | HttpClient.HttpClient
      > = Effect.gen(function* () {
        const state = randomUUID();
        const port = options.callbackPort ?? options.config.callbackPort;
        const server = yield* makeCallbackServer({
          state,
          ...(port === undefined ? {} : { port }),
        });
        const url = oauth.authorizeUrl({
          redirectUri: server.redirectUri,
          scopes,
          state,
        });
        console.log("[twitch:" + options.slot + "] authorize: " + url);
        yield* open(url);
        const result = yield* server.wait.pipe(
          Effect.mapError((error) => new Error(error.message)),
        );
        return yield* oauth
          .exchangeCode({ code: result.code, redirectUri: result.redirectUri })
          .pipe(Effect.mapError((error) => new Error(error.message)));
      });

      const token = yield* (options.device === true || options.config.clientSecret === undefined
        ? deviceFlow
        : codeFlow);

      const validation = yield* oauth
        .validateToken(token.accessToken)
        .pipe(Effect.mapError((error) => new Error(error.message)));

      if (token.refreshToken === undefined || token.refreshToken === "") {
        return yield* Effect.fail(
          new Error(
            "Twitch did not return a refresh token; try the authorization-code flow with a client secret",
          ),
        );
      }

      const granted = token.scopes.length > 0 ? token.scopes : validation.scopes;
      const missing = scopes.filter((scope) => !granted.includes(scope));
      if (missing.length > 0) {
        console.warn(
          "[twitch:" +
            options.slot +
            "] warning: Twitch did not grant: " +
            missing.join(", "),
        );
      }

      const account: StoredTwitchAccount = {
        version: 1,
        slot: options.slot,
        clientId: options.config.clientId,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: Date.now() + token.expiresIn * 1000,
        scopes: granted,
        userId: validation.userId,
        login: validation.login,
      };

      yield* Effect.tryPromise({
        try: () => writeStoredTwitchAccount(account, options.dataDir),
        catch: (cause) =>
          new Error("Could not store the Twitch token: " + errorMessage(cause)),
      });

      console.log(
        "[twitch:" +
          options.slot +
          "] authorized as " +
          validation.login +
          " (" +
          validation.userId +
          ", scopes: " +
          (granted.length === 0 ? "(none)" : granted.join(", ")) +
          ")",
      );

      return account;
    }),
  );
