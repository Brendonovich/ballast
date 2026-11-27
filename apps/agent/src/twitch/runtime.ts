import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/http";
import type { HttpClient } from "effect/http";
import { Socket } from "effect/socket";
import type { Manifest } from "@ballast/core";
import * as Twitch from "@ballast/module-twitch";

import type { ConnectionOptions } from "../connection-config.ts";
import { readEnvironment } from "../service/config.ts";
import {
  readCloudPairing,
  readStoredTwitchAccount,
  resolveDataDir,
  resolveTwitchAppConfig,
  resolveTwitchMode,
  writeCloudPairing,
  writeStoredTwitchAccount,
} from "./config.ts";
import type {
  CloudPairing,
  StoredTwitchAccount,
  TwitchMode,
  TwitchModeOptions,
} from "./config.ts";
import { missingScopes, requiredScopes, subscriptionSpecs } from "./conditions.ts";
import {
  TwitchMissingScopes,
  TwitchTransportError,
} from "./errors.ts";
import { makeCloudApi, startCloudRelay, startCloudTwitchTransport } from "./cloud.ts";
import type { CloudApi, CloudRelay } from "./cloud.ts";
import { startLocalTwitchTransport } from "./local.ts";
import type { TwitchAccountStore } from "./local.ts";
import { subscriptionKey } from "./transport.ts";
import type {
  TwitchIdentity,
  TwitchSubscriptionSpec,
  TwitchTransport,
} from "./transport.ts";

const envValue = (
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined => {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
};

const connectionEnvKey = (slot: string): string =>
  "BALLAST_TWITCH_" +
  slot.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_") +
  "_CONNECTION";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export interface TwitchRuntimeOptions extends TwitchModeOptions {
  readonly options: ConnectionOptions;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly dataDir?: string;
  readonly publish: (topicKey: string, payload: unknown) => void;
  /**
   * Interactive local-mode re-auth. Returns true when the account was
   * re-authorized; the runtime then retries once. Tests and non-interactive
   * runs leave this undefined and get a missing-scopes error instead.
   */
  readonly reauthorize?: (
    slot: string,
    scopes: ReadonlyArray<string>,
  ) => Effect.Effect<boolean, Error>;
}

export interface TwitchRuntime {
  /**
   * Resolve every Twitch slot, refresh tokens, create EventSub subscriptions
   * (local) or reconcile them (cloud), and hot-swap the previous transports.
   */
  readonly sync: (
    manifest: Manifest,
  ) => Effect.Effect<void, TwitchTransportError | TwitchMissingScopes>;
  /** Execute a manifest request such as \`helix/sendChatMessage\`. */
  readonly request: (
    slot: string,
    request: string,
    input: unknown,
  ) => Effect.Effect<unknown, TwitchTransportError>;
  readonly close: Effect.Effect<void>;
}

interface SlotState {
  readonly slot: string;
  readonly transport: TwitchTransport;
  readonly scope: Scope.Closeable;
}

interface PreparedSlot extends SlotState {
  readonly identity: TwitchIdentity;
}

const effectiveTwitchMode = (
  slot: string,
  options: TwitchRuntimeOptions,
  paired: boolean,
  env: Readonly<Record<string, string | undefined>>,
): TwitchMode => resolveTwitchMode(slot, options, paired, env);

const scopeError = (cause: unknown): TwitchTransportError =>
  new TwitchTransportError({
    reason: "Could not read Ballast local state: " + errorMessage(cause),
  });

export const startTwitchRuntime = (
  runtimeOptions: TwitchRuntimeOptions,
): Effect.Effect<
  TwitchRuntime,
  never,
  SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const runtimeScope = yield* Scope.Scope;
    const path = yield* Path.Path;
    const platform = yield* Effect.context<
      SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path
    >();
    const provide = <A, E>(
      effect: Effect.Effect<A, E, SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path>,
    ): Effect.Effect<A, E> => Effect.provideContext(effect, platform);
    const env = runtimeOptions.env ?? (yield* readEnvironment([
      "BALLAST_DATA_DIR",
      "XDG_DATA_HOME",
      "LOCALAPPDATA",
      "HOME",
      "BALLAST_TWITCH_CONNECTION",
      "BALLAST_TWITCH_MODE",
      "BALLAST_TWITCH_CLIENT_ID",
      "BALLAST_TWITCH_CLIENT_SECRET",
      "BALLAST_TWITCH_CALLBACK_PORT",
      "BALLAST_TWITCH_AUTHORIZATION_URL",
      "BALLAST_TWITCH_TOKEN_URL",
      "BALLAST_TWITCH_VALIDATE_URL",
      "BALLAST_TWITCH_DEVICE_URL",
      "BALLAST_TWITCH_REVOKE_URL",
      "BALLAST_TWITCH_HELIX_URL",
      "BALLAST_TWITCH_EVENTSUB_URL",
    ]));
    const dataDir = runtimeOptions.dataDir ?? resolveDataDir(path, env);
    const connectionOptions = runtimeOptions.options;

    let states = new Map<string, SlotState>();
    let relay: CloudRelay | undefined;
    let cloudApi: CloudApi | undefined;
    let pairing: CloudPairing | undefined;
    let cloudUrl: string | undefined;

    const loadPairing = (): Effect.Effect<CloudPairing | undefined, TwitchTransportError> =>
      provide(readCloudPairing(dataDir)).pipe(Effect.mapError(scopeError));

    const loadAccount = (
      slot: string,
    ): Effect.Effect<StoredTwitchAccount | undefined, TwitchTransportError> =>
      provide(readStoredTwitchAccount(slot, dataDir)).pipe(Effect.mapError(scopeError));

    const accountStore = (): TwitchAccountStore => ({
      save: (account) =>
        provide(writeStoredTwitchAccount(account, dataDir)).pipe(Effect.mapError(scopeError)),
    });

    const closeStates = (reconcileRemoved = false): Effect.Effect<void> =>
      Effect.forEach(
        [...states.values()],
        (state) =>
          Effect.gen(function* () {
            if (
              reconcileRemoved &&
              state.transport.mode === "cloud" &&
              cloudApi !== undefined
            ) {
              yield* cloudApi
                .reconcile(state.transport.connectionId, [])
                .pipe(Effect.ignore);
            }
            yield* Scope.close(state.scope, Exit.void);
          }),
        { discard: true },
      );

    const closePrepared = (prepared: ReadonlyArray<SlotState>): Effect.Effect<void> =>
      Effect.forEach(
        prepared,
        (state) => Scope.close(state.scope, Exit.void),
        { discard: true },
      );

    const prepareLocal = (
      slot: string,
      manifest: Manifest,
      reauthorized: boolean,
    ): Effect.Effect<
      PreparedSlot,
      TwitchTransportError | TwitchMissingScopes,
      Scope.Scope | HttpClient.HttpClient | Socket.WebSocketConstructor
    > =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(runtimeScope, "parallel");
        return yield* Effect.gen(function* () {
          const stored = yield* loadAccount(slot);
          if (stored === undefined) {
            return yield* new TwitchTransportError({
              reason:
                "No local Twitch token for twitch/" +
                slot +
                ". Run 'ballast auth twitch " +
                slot +
                "' first.",
            });
          }

          const config = yield* Effect.try({
            try: () => resolveTwitchAppConfig(slot, connectionOptions, stored, env),
            catch: (cause) => new TwitchTransportError({ reason: errorMessage(cause) }),
          });

          const transport = yield* startLocalTwitchTransport({
            slot,
            config,
            account: stored,
            store: accountStore(),
            publish: runtimeOptions.publish,
          }).pipe(Effect.provideService(Scope.Scope, scope));

          const identity = yield* transport.getToken;
          const required = requiredScopes(manifest, slot);
          const missing = missingScopes(required, identity.scopes);

          if (missing.length > 0) {
            if (!reauthorized && runtimeOptions.reauthorize !== undefined) {
              const approved = yield* runtimeOptions.reauthorize(slot, required).pipe(
                Effect.mapError(
                  (error) =>
                    new TwitchTransportError({
                      reason: "Twitch re-authorization failed: " + error.message,
                    }),
                ),
              );
              if (approved) {
                yield* Scope.close(scope, Exit.void);
                return yield* prepareLocal(slot, manifest, true);
              }
            }
            return yield* new TwitchMissingScopes({
              slot,
              mode: "local-app",
              missing,
            });
          }

          console.log(
            "[twitch:" +
              slot +
              "] mode local-app (account " +
              identity.login +
              ", " +
              identity.userId +
              ")",
          );

          return { slot, transport, scope, identity };
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      });

    const resolveCloudConnection = (
      slot: string,
      api: CloudApi,
    ): Effect.Effect<string, TwitchTransportError> =>
      Effect.gen(function* () {
        const connections = yield* api.listConnections;
        const explicit =
          connectionOptions.connections.get("twitch/" + slot) ??
          envValue(env, connectionEnvKey(slot));
        const bound = pairing?.bindings?.[slot];
        const candidate = explicit ?? bound;

        if (candidate !== undefined) {
          const matches = connections.filter(
            (connection) =>
              connection.id === candidate || connection.login === candidate,
          );
          if (matches.length === 1 && matches[0] !== undefined) {
            const connection = matches[0];
            if (pairing !== undefined && pairing.bindings?.[slot] !== connection.id) {
              const updated: CloudPairing = {
                ...pairing,
                bindings: { ...pairing.bindings, [slot]: connection.id },
              };
              pairing = updated;
              yield* provide(writeCloudPairing(updated, dataDir)).pipe(Effect.ignore);
            }
            return connection.id;
          }
          return yield* new TwitchTransportError({
            reason:
              "Twitch slot twitch/" +
              slot +
              " is bound to '" +
              candidate +
              "', which is not one of the cloud's connections. Available: " +
              (connections.length === 0
                ? "(none)"
                : connections.map((connection) => connection.login).join(", ")),
          });
        }

        if (connections.length === 1 && connections[0] !== undefined) {
          const connection = connections[0];
          if (pairing !== undefined) {
            const updated: CloudPairing = {
              ...pairing,
              bindings: { ...pairing.bindings, [slot]: connection.id },
            };
            pairing = updated;
            yield* provide(writeCloudPairing(updated, dataDir)).pipe(Effect.ignore);
          }
          return connection.id;
        }

        return yield* new TwitchTransportError({
          reason:
            "Choose a cloud Twitch connection for twitch/" +
            slot +
            " with --connection twitch/" +
            slot +
            "=<login>. Available: " +
            (connections.length === 0
              ? "(none)"
              : connections.map((connection) => connection.login).join(", ")),
        });
      });

    const prepareCloud = (
      slot: string,
      manifest: Manifest,
      api: CloudApi,
      relayService: CloudRelay,
      connectionId: string,
    ): Effect.Effect<
      PreparedSlot,
      TwitchTransportError | TwitchMissingScopes,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(runtimeScope, "parallel");
        return yield* Effect.gen(function* () {
          const transport = yield* startCloudTwitchTransport({
            slot,
            connectionId,
            api,
            relay: relayService,
            publish: runtimeOptions.publish,
          }).pipe(Effect.provideService(Scope.Scope, scope));

          const identity = yield* transport.getToken;
          const required = requiredScopes(manifest, slot);
          const missing = missingScopes(required, identity.scopes);
          if (missing.length > 0) {
            return yield* new TwitchMissingScopes({
              slot,
              mode: "cloud",
              missing,
            });
          }

          console.log(
            "[twitch:" +
              slot +
              "] mode cloud (account " +
              identity.login +
              ", connection " +
              connectionId +
              ")",
          );

          return { slot, transport, scope, identity };
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      });

    const ensureCloud = (
      pairingValue: CloudPairing,
    ): Effect.Effect<{ api: CloudApi; relay: CloudRelay; url: string }, TwitchTransportError> =>
      Effect.gen(function* () {
        const url = runtimeOptions.cloudUrl ?? pairingValue.url;
        if (cloudApi === undefined || cloudUrl !== url) {
          cloudApi = makeCloudApi({ baseUrl: url, machineToken: pairingValue.machineToken });
          cloudUrl = url;
        }
        if (relay === undefined) {
          relay = yield* startCloudRelay({
            baseUrl: url,
            machineId: pairingValue.machineId,
            machineToken: pairingValue.machineToken,
          }).pipe(Effect.provideService(Scope.Scope, runtimeScope));
        }
        return { api: cloudApi, relay, url };
      });

    const provideRuntime = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        Scope.Scope | HttpClient.HttpClient | Socket.WebSocketConstructor
      >,
    ): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.provide(
          Layer.merge(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal),
        ),
      );

    const sync = (
      manifest: Manifest,
    ): Effect.Effect<void, TwitchTransportError | TwitchMissingScopes> =>
      provideRuntime(Effect.gen(function* () {
        pairing = yield* loadPairing();

        const twitchConnections = manifest.connections.filter(
          (connection) => connection.integration === "twitch",
        );
        const usesTwitch =
          manifest.topics.some((topic) => topic.integration === "twitch") ||
          manifest.requests.some((request) => request.integration === "twitch");

        if (!usesTwitch || twitchConnections.length === 0) {
          yield* closeStates(true);
          states = new Map();
          return;
        }

        const prepared: Array<PreparedSlot> = [];
        const setup = Effect.gen(function* () {
          for (const connection of twitchConnections) {
            const slot = connection.slot;
            const mode = effectiveTwitchMode(
              slot,
              runtimeOptions,
              pairing !== undefined,
              env,
            );

            if (mode === "cloud") {
              if (pairing === undefined) {
                return yield* new TwitchTransportError({
                  reason:
                    "Twitch slot twitch/" +
                    slot +
                    " is set to cloud, but this machine is not paired. Run 'ballast pair <code> --cloud <url>'.",
                });
              }
              const cloud = yield* ensureCloud(pairing);
              const connectionId = yield* resolveCloudConnection(slot, cloud.api);
              prepared.push(
                yield* prepareCloud(slot, manifest, cloud.api, cloud.relay, connectionId),
              );
              continue;
            }

            prepared.push(yield* prepareLocal(slot, manifest, false));
          }
        });

        yield* setup.pipe(
          Effect.onError(() => closePrepared(prepared)),
        );

        const accountSlots = new Map(
          prepared.map((slot) => [slot.slot, slot.identity.userId] as const),
        );

        const specsBySlot = new Map<string, ReadonlyArray<TwitchSubscriptionSpec>>();
        for (const slot of prepared) {
          specsBySlot.set(
            slot.slot,
            yield* subscriptionSpecs(manifest, slot.slot, accountSlots),
          );
        }

        // Two slots can point at the same cloud connection; reconcile the
        // union so the second slot does not erase the first's topics.
        const cloudSpecs = new Map<string, Array<TwitchSubscriptionSpec>>();
        for (const slot of prepared) {
          if (slot.transport.mode !== "cloud") continue;
          const merged = cloudSpecs.get(slot.transport.connectionId) ?? [];
          for (const spec of specsBySlot.get(slot.slot) ?? []) {
            const key = subscriptionKey(spec);
            if (!merged.some((existing) => subscriptionKey(existing) === key)) {
              merged.push(spec);
            }
          }
          cloudSpecs.set(slot.transport.connectionId, merged);
        }

        const subscribeAll = Effect.gen(function* () {
          for (const slot of prepared) {
            const specs = specsBySlot.get(slot.slot) ?? [];
            if (slot.transport.mode === "cloud") {
              yield* slot.transport.subscribe(
                cloudSpecs.get(slot.transport.connectionId) ?? [],
              );
              continue;
            }
            // Local mode has no socket to open when the slot only makes
            // Helix requests; skip the EventSub connection.
            if (specs.length === 0) continue;
            yield* slot.transport.subscribe(specs);
          }
        });

        yield* subscribeAll.pipe(
          Effect.onError(() => closePrepared(prepared)),
        );

        const nextCloudConnections = new Set(
          prepared
            .filter((slot) => slot.transport.mode === "cloud")
            .map((slot) => slot.transport.connectionId),
        );
        yield* Effect.forEach(
          [...states.values()],
          (state) =>
            Effect.gen(function* () {
              if (
                state.transport.mode === "cloud" &&
                !nextCloudConnections.has(state.transport.connectionId) &&
                cloudApi !== undefined
              ) {
                yield* cloudApi
                  .reconcile(state.transport.connectionId, [])
                  .pipe(Effect.ignore);
              }
              yield* Scope.close(state.scope, Exit.void);
            }),
          { discard: true },
        );
        states = new Map(
          prepared.map((slot) => [
            slot.slot,
            { slot: slot.slot, transport: slot.transport, scope: slot.scope },
          ]),
        );
      }));

    const request = (
      slot: string,
      requestName: string,
      input: unknown,
    ): Effect.Effect<unknown, TwitchTransportError> =>
      Effect.gen(function* () {
        const state = states.get(slot);
        if (state === undefined) {
          return yield* new TwitchTransportError({
            reason: "No active Twitch connection for slot '" + slot + "'",
          });
        }
        const name = Twitch.parseHelixRequestName(requestName);
        if (name === undefined) {
          return yield* new TwitchTransportError({
            reason: "Unknown Twitch request '" + requestName + "'",
          });
        }
        return yield* state.transport.request(name, input);
      });

    const close = Effect.gen(function* () {
      yield* closeStates();
      states = new Map();
    });

    return { sync, request, close };
  });
