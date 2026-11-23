import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stdio from "effect/Stdio";
import type { HttpClient } from "effect/http";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Twitch from "@ballast/module-twitch";
import { makeCallbackServer } from "@ballast/module-twitch/oauth/callback-server";
import { DEFAULT_TWITCH_CALLBACK_PORT } from "@ballast/agent-protocol";

import {
  oauthConfigOf,
  writeStoredTwitchAccount,
} from "./config.ts";
import type { StoredTwitchAccount, TwitchAppConfig } from "./config.ts";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const defaultOpenUrl = (
  url: string,
): Effect.Effect<void, never, ChildProcessSpawner | Stdio.Stdio> =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const spawner = yield* ChildProcessSpawner;
    const isTerminal = yield* stdio.stdoutIsTerminal;
    const ci = yield* Config.String("CI").pipe(
      Config.option,
      Effect.map((value) => Option.contains(value, "1")),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (!isTerminal || ci) return;
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "cmd"
          : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    yield* spawner.exitCode(ChildProcess.make(command, args)).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          console.warn("Could not open the browser: " + cause.message);
        }),
      ),
    );
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

export type TwitchAuthChallenge =
  | {
      readonly _tag: "browser";
      readonly url: string;
      readonly expiresAt: number;
    }
  | {
      readonly _tag: "device-code";
      readonly verificationUrl: string;
      readonly userCode: string;
      readonly expiresAt: number;
    };

type AuthPlatformServices =
  | ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | Stdio.Stdio;

export interface StartedTwitchAuth {
  /** The URL/code to show the user. */
  readonly auth: TwitchAuthChallenge;
  /** Completes when the user finishes the flow and the token is stored. */
  readonly wait: Effect.Effect<StoredTwitchAccount, Error>;
}

/**
 * Begin the local OAuth flow and return the URL or device code immediately.
 * The caller keeps the returned scope open while awaiting `wait`; closing the
 * scope shuts down the loopback callback server.
 */
export const startTwitchAuth = (
  options: AuthorizeTwitchAccountOptions,
): Effect.Effect<
  StartedTwitchAuth,
  Error,
  AuthPlatformServices | Scope.Scope | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const oauth = yield* Twitch.OAuth.make(oauthConfigOf(options.config));
    const scopes = [...new Set(options.scopes)];
    const open = options.openUrl ?? defaultOpenUrl;

    const finish = (
      token: Twitch.OAuth.OAuthToken,
    ): Effect.Effect<StoredTwitchAccount, Error> =>
      Effect.gen(function* () {
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

        yield* writeStoredTwitchAccount(account, options.dataDir).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new Error("Could not store the Twitch token: " + errorMessage(cause)),
          ),
        );

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
      });

    if (options.device === true || options.config.clientSecret === undefined) {
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
      return {
        auth: {
          _tag: "device-code",
          verificationUrl: authorization.verificationUri,
          userCode: authorization.userCode,
          expiresAt: Date.now() + authorization.expiresIn * 1000,
        },
        wait: oauth
          .waitForDeviceToken({
            deviceCode: authorization.deviceCode,
            scopes,
            intervalSeconds: authorization.intervalSeconds,
            expiresIn: authorization.expiresIn,
          })
          .pipe(
            Effect.mapError((error) => new Error(error.message)),
            Effect.flatMap(finish),
          ),
      };
    }

    const state = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const port =
      options.callbackPort ??
      options.config.callbackPort ??
      DEFAULT_TWITCH_CALLBACK_PORT;
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
    return {
      auth: {
        _tag: "browser",
        url,
        expiresAt: Date.now() + 10 * 60_000,
      },
      wait: server.wait.pipe(
        Effect.mapError((error) => new Error(error.message)),
        Effect.flatMap((result) =>
          oauth.exchangeCode({ code: result.code, redirectUri: result.redirectUri }),
        ),
        Effect.mapError((error) => new Error(error.message)),
        Effect.flatMap(finish),
      ),
    };
  });

/**
 * Run the local OAuth flow and store the refresh token under the Ballast data
 * directory. Authorization-code + localhost redirect for confidential apps;
 * device code when there is no client secret (or `device` is set).
 */
export const authorizeTwitchAccount = (
  options: AuthorizeTwitchAccountOptions,
): Effect.Effect<StoredTwitchAccount, Error, AuthPlatformServices | HttpClient.HttpClient> =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* startTwitchAuth(options);
      return yield* started.wait;
    }),
  );
