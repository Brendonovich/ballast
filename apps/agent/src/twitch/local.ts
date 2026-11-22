import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { HttpClient } from "effect/http";
import { Socket } from "effect/socket";
import * as Twitch from "@ballast/module-twitch";

import { oauthConfigOf } from "./config.ts";
import type { StoredTwitchAccount, TwitchAppConfig } from "./config.ts";
import { TwitchTransportError, transportError } from "./errors.ts";
import type { TwitchIdentity, TwitchSubscriptionSpec, TwitchTransport } from "./transport.ts";
import { busTopic, subscriptionKey } from "./transport.ts";

export interface TwitchAccountStore {
  readonly save: (account: StoredTwitchAccount) => Effect.Effect<void, TwitchTransportError>;
}

export interface LocalTwitchTransportOptions {
  readonly slot: string;
  readonly config: TwitchAppConfig;
  readonly account: StoredTwitchAccount;
  readonly store: TwitchAccountStore;
  readonly publish: (topicKey: string, payload: unknown) => void;
}

const identityOf = (account: StoredTwitchAccount): TwitchIdentity => ({
  userId: account.userId,
  login: account.login,
  ...(account.displayName === undefined ? {} : { displayName: account.displayName }),
  scopes: account.scopes,
  accessToken: account.accessToken,
  expiresAt: account.expiresAt,
  clientId: account.clientId,
});

const accessTokenMarginMs = 60_000;

/**
 * The user's own Twitch application: OAuth refresh on the machine, EventSub
 * over WebSocket, Helix called directly. Token storage is a JSON file for now
 * (see docs/integrations/twitch.md); the keychain is a later change.
 */
export const startLocalTwitchTransport = (
  options: LocalTwitchTransportOptions,
): Effect.Effect<
  TwitchTransport,
  TwitchTransportError,
  Scope.Scope | HttpClient.HttpClient | Socket.WebSocketConstructor
> =>
  Effect.gen(function* () {
    const slot = options.slot;
    const transportScope = yield* Scope.Scope;
    const webSocketConstructor = yield* Socket.WebSocketConstructor;
    const current = yield* Ref.make(options.account);
    const oauth = yield* Twitch.OAuth.make(oauthConfigOf(options.config));
    /** Identity and scopes are refreshed from Twitch's validate endpoint. */
    let validated = false;

    const refreshToken = (): Effect.Effect<StoredTwitchAccount, TwitchTransportError> =>
      Effect.gen(function* () {
        const value = yield* Ref.get(current);
        if (value.refreshToken === "") {
          return yield* transportError(
            "No refresh token for twitch/" +
              slot +
              "; run 'ballast auth twitch " +
              slot +
              "'",
          );
        }
        const token = yield* oauth.refreshToken(value.refreshToken).pipe(
          Effect.mapError(
            (error) =>
              new TwitchTransportError({
                reason: "Could not refresh the Twitch token for " + slot + ": " + error.message,
                ...(error.status === undefined ? {} : { status: error.status }),
              }),
          ),
        );
        const next: StoredTwitchAccount = {
          ...value,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken ?? value.refreshToken,
          expiresAt: Date.now() + token.expiresIn * 1000,
          scopes: token.scopes.length === 0 ? value.scopes : token.scopes,
        };
        yield* options.store.save(next);
        yield* Ref.set(current, next);
        validated = false;
        console.log("[twitch:" + slot + "] refreshed access token");
        return next;
      });

    const account = (): Effect.Effect<StoredTwitchAccount, TwitchTransportError> =>
      Effect.gen(function* () {
        let value = yield* Ref.get(current);
        if (value.accessToken === "" || value.expiresAt - accessTokenMarginMs <= Date.now()) {
          value = yield* refreshToken();
        }
        if (!validated) {
          const validation = yield* oauth.validateToken(value.accessToken).pipe(
            Effect.mapError(
              (error) =>
                new TwitchTransportError({
                  reason:
                    "Could not validate the Twitch token for " + slot + ": " + error.message,
                  ...(error.status === undefined ? {} : { status: error.status }),
                }),
            ),
          );
          value = {
            ...value,
            userId: validation.userId,
            login: validation.login,
            scopes: validation.scopes,
            expiresAt: Date.now() + validation.expiresIn * 1000,
          };
          yield* options.store.save(value);
          yield* Ref.set(current, value);
          validated = true;
        }
        return value;
      });

    const tokenProvider: Twitch.Protocol.TokenProviderService = {
      getToken: account().pipe(
        Effect.map((value) => ({
          accessToken: value.accessToken,
          clientId: options.config.clientId,
        })),
        Effect.mapError((error) => new Twitch.Protocol.TokenProviderError(error.message)),
      ),
      refresh: refreshToken().pipe(
        Effect.map((value) => ({
          accessToken: value.accessToken,
          clientId: options.config.clientId,
        })),
        Effect.mapError((error) => new Twitch.Protocol.TokenProviderError(error.message)),
      ),
    };

    const helix = yield* Twitch.Helix.make({ baseUrl: options.config.helixBaseUrl }).pipe(
      Effect.provideService(Twitch.Protocol.TokenProvider, tokenProvider),
    );

    let startedKey: string | undefined;

    const subscribe = (
      specs: ReadonlyArray<TwitchSubscriptionSpec>,
    ): Effect.Effect<void, TwitchTransportError> =>
      Effect.gen(function* () {
        const key = JSON.stringify(specs.map(subscriptionKey).sort());
        if (startedKey === key) return yield* Effect.void;
        if (startedKey !== undefined) {
          return yield* transportError(
            "Twitch transport for " +
              slot +
              " already has subscriptions; restart it to apply new topics.",
          );
        }

        const requests: ReadonlyArray<Twitch.EventSub.SubscriptionRequest> = specs.map(
          (spec) => ({ type: spec.type, version: spec.version, condition: spec.condition }),
        );

        console.log(
          "[twitch:" +
            slot +
            "] connecting EventSub at " +
            options.config.eventSubUrl +
            " (" +
            (specs.length === 0
              ? "no subscriptions"
              : specs.map((spec) => spec.type).join(", ")) +
            ")",
        );

        const registrar = Twitch.EventSub.layerRegistrarFromFunction((sessionId, request) =>
          helix
            .createEventSubSubscription({
              type: request.type,
              version: String(request.version),
              condition: request.condition,
              transport: { method: "websocket", session_id: sessionId },
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new Twitch.EventSub.EventSubSubscriptionError({ reason: error.message }),
              ),
              Effect.tap(() =>
                Effect.sync(() => {
                  console.log(
                    "[twitch:" + slot + "] subscribed " + request.type,
                  );
                }),
              ),
              Effect.asVoid,
            ),
        );

        yield* Effect.gen(function* () {
          const socket = yield* Twitch.EventSub.makeSocket({
            url: options.config.eventSubUrl,
            subscriptions: requests,
          }).pipe(Effect.provide(registrar));

          yield* socket.notifications.pipe(
            Stream.runForEach((notification) =>
              Effect.sync(() => {
                console.log("[twitch:" + slot + "] event " + notification.topic);
                options.publish(busTopic(slot, notification.topic), notification.payload);
              }),
            ),
            Effect.forkScoped,
          );
        }).pipe(
          Effect.provideService(Scope.Scope, transportScope),
          Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
        );

        startedKey = key;
      });

    const request = (
      name: Twitch.Helix.RequestName,
      input: unknown,
    ): Effect.Effect<unknown, TwitchTransportError> =>
      Twitch.Helix.helixRequests[name].execute(helix, input).pipe(
        Effect.mapError(
          (error) =>
            new TwitchTransportError({
              reason: error.message,
              ...("status" in error && error.status !== undefined
                ? { status: error.status }
                : {}),
            }),
        ),
      );

    return {
      mode: "local-app",
      slot,
      connectionId: "local:" + slot,
      getToken: Effect.map(account(), identityOf),
      subscribe,
      request,
    };
  });
