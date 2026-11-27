/**
 * `@ballast/module-vtube-studio/driver`: the VTube Studio connection driver.
 *
 * Standalone by design: it does not import `apps/agent` and knows nothing
 * about scripts or RPC. The agent's future ConnectionManager creates one
 * driver layer per configured `(integration, slot)`, provides a
 * `Socket.WebSocketConstructor`, pumps `statusChanges` into
 * `ConnectionSummary`, forwards request RPCs to `request`, calls
 * `setTopics` with the union of running manifests, and calls
 * `resolveOptions` for params that reference `vts/<slot>/<source>`.
 */
import type { ParamOptionSource, TopicCondition } from "@ballast/core";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Socket } from "effect/socket";
import { INTEGRATION } from "../constants.ts";
import {
  APIStateResponseSchema,
  AuthenticationResponseSchema,
  AuthenticationTokenResponseSchema,
  AvailableModelsResponseSchema,
  ExpressionStateResponseSchema,
  HotkeysInCurrentModelResponseSchema,
  RequestSchemas,
  isDriverOwnedRequestName,
  isScriptRequestName,
} from "../protocol.ts";
import type {
  APIStateResponse,
  AuthenticationResponse,
  ScriptRequestName,
  VTubeStudioRequests,
} from "../protocol.ts";
import {
  TOPIC_EVENT_NAMES,
  configOfCondition,
  eventNameOfTopic,
  topicKey,
  topicNameForEvent,
} from "../topics.ts";
import type { EventName } from "../topics.ts";
import { connectSession } from "./connection.ts";
import type { VTubeStudioEventPacket, VTubeStudioSession } from "./connection.ts";
import {
  VTubeStudioAuthenticationError,
  VTubeStudioConfigError,
  VTubeStudioConnectionError,
  VTubeStudioOptionError,
  VTubeStudioProtocolError,
  VTubeStudioRequestError,
  VTubeStudioStorageError,
  errorMessage,
} from "./errors.ts";
import type { VTubeStudioError } from "./errors.ts";
import { fileTokenStore } from "./token-store.ts";
import type { StoredVTubeStudioToken, VTubeStudioTokenStore } from "./token-store.ts";

export type VTubeStudioDriverState =
  | "disconnected"
  | "connecting"
  | "waiting-for-approval"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "error";

export interface VTubeStudioDriverStatus {
  readonly slot: string;
  readonly url: string;
  readonly state: VTubeStudioDriverState;
  /** Human-readable detail: the last error, or "allow the plugin" while waiting. */
  readonly message: string | undefined;
  readonly authenticated: boolean;
  readonly vTubeStudioVersion: string | undefined;
  readonly attempts: number;
  readonly lastConnectedAt: number | undefined;
  readonly updatedAt: number;
}

/** One manifest topic for this connection, including its recorded condition. */
export interface VTubeStudioSubscription {
  /** `vts/ModelLoaded` or `ModelLoaded`. */
  readonly topic: string;
  /** The `condition` from `manifest.topics[]`, holding the event config JSON. */
  readonly condition?: TopicCondition;
}

export interface VTubeStudioDriverReconnectOptions {
  readonly initialDelay?: Duration.Input;
  readonly maxDelay?: Duration.Input;
  /** Exponential factor; defaults to 2. */
  readonly factor?: number;
}

export interface VTubeStudioDriverOptions {
  readonly slot: string;
  /** Defaults to `ws://127.0.0.1:8001`. Loopback only. */
  readonly url?: string;
  /** Plugin identity shown in the VTube Studio approval dialog. */
  readonly pluginName?: string;
  readonly pluginDeveloper?: string;
  /** Base64 PNG/JPG, exactly 128x128, optional. */
  readonly pluginIcon?: string;
  /** Initial topics; `setTopics` replaces them at runtime. */
  readonly subscriptions?: ReadonlyArray<VTubeStudioSubscription>;
  /** Publish an event on the agent bus: `vts/<slot>/vts/<topic>`. */
  readonly publish?: (topicKey: string, payload: unknown) => void;
  /** Defaults to `resolveDataDir()`; the agent should pass its data dir. */
  readonly dataDir?: string;
  /** Overrides the file store (tests, or a future keychain). */
  readonly tokenStore?: VTubeStudioTokenStore;
  /** Defaults to 30 seconds. */
  readonly requestTimeout?: Duration.Input;
  /** How long to wait for the user to click Allow. Defaults to 5 minutes. */
  readonly approvalTimeout?: Duration.Input;
  readonly reconnect?: VTubeStudioDriverReconnectOptions;
}

export interface VTubeStudioDriverService {
  readonly slot: string;
  readonly url: string;
  readonly status: Effect.Effect<VTubeStudioDriverStatus>;
  /** Current status first, then every change. */
  readonly statusChanges: Stream.Stream<VTubeStudioDriverStatus>;
  /** Completes after the first successful plugin authentication. */
  readonly ready: Effect.Effect<void>;
  /**
   * Send one request by its protocol name. Rejects authentication and event
   * subscription requests, which the driver owns.
   */
  readonly request: (request: string, input: unknown) => Effect.Effect<unknown, VTubeStudioError>;
  /** Typed request helper for tests and adapter code. */
  readonly invoke: <K extends ScriptRequestName>(
    name: K,
    input: VTubeStudioRequests[K]["input"],
  ) => Effect.Effect<VTubeStudioRequests[K]["output"], VTubeStudioError>;
  /** Replace the desired subscriptions; reconciles on the live session. */
  readonly setTopics: (
    subscriptions: ReadonlyArray<VTubeStudioSubscription>,
  ) => Effect.Effect<void, VTubeStudioConfigError>;
  /** Resolve `VTS.hotkeys`, `VTS.models` or `VTS.expressions`. */
  readonly resolveOptions: (
    source: ParamOptionSource,
  ) => Effect.Effect<ReadonlyArray<string>, VTubeStudioError>;
}

/**
 * The VTube Studio driver for one connection slot. Create it with
 * {@link layer}; it connects immediately, reconnects with exponential backoff,
 * and owns authentication, request correlation and event subscriptions.
 */
export class VTubeStudioDriver extends Context.Service<
  VTubeStudioDriver,
  VTubeStudioDriverService
>()("Ballast/VTubeStudioDriver") {
  static readonly layer = (
    options: VTubeStudioDriverOptions,
  ): Layer.Layer<
    VTubeStudioDriver,
    VTubeStudioConfigError,
    SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path | Socket.WebSocketConstructor
  > => layer(options);
}

interface NormalizedConfig {
  readonly slot: string;
  readonly url: string;
  readonly pluginName: string;
  readonly pluginDeveloper: string;
  readonly pluginIcon: string | undefined;
  readonly publish: ((topicKey: string, payload: unknown) => void) | undefined;
  readonly tokenStore: VTubeStudioTokenStore;
  readonly requestTimeout: Duration.Input;
  readonly approvalTimeout: Duration.Input;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Validate and normalise a VTube Studio API URL. Throws `VTubeStudioConfigError`. */
export const normalizeUrl = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VTubeStudioConfigError({ message: 'Invalid VTube Studio url "' + raw + '"' });
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new VTubeStudioConfigError({
      message: 'VTube Studio url must use ws:// or wss://, got "' + raw + '"',
    });
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new VTubeStudioConfigError({
      message:
        "VTube Studio is a local integration; use localhost, 127.0.0.1 or [::1], got " +
        url.hostname,
    });
  }
  if (url.username !== "" || url.password !== "") {
    throw new VTubeStudioConfigError({
      message: "VTube Studio url must not contain credentials",
    });
  }
  if (url.search !== "" || url.hash !== "") {
    throw new VTubeStudioConfigError({
      message: "VTube Studio url must not contain a query or hash",
    });
  }
  if (url.port === "") url.port = "8001";
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
};

const normalizePluginIdentity = (
  label: string,
  value: string,
): string => {
  if (value.length < 3 || value.length > 32) {
    throw new VTubeStudioConfigError({
      message: label + ' must be between 3 and 32 characters, got "' + value + '"',
    });
  }
  return value;
};

const positiveMs = (label: string, value: Duration.Input): number => {
  const millis = Duration.toMillis(value);
  if (!Number.isFinite(millis) || millis < 0) {
    throw new VTubeStudioConfigError({ message: label + " must be a non-negative duration" });
  }
  return millis;
};

const normalizeConfig = (options: VTubeStudioDriverOptions): NormalizedConfig => {
  const slot = options.slot.trim();
  if (slot === "") {
    throw new VTubeStudioConfigError({ message: "VTube Studio slot must not be empty" });
  }
  if (options.slot !== slot) {
    throw new VTubeStudioConfigError({
      message: 'VTube Studio slot "' + options.slot + '" must not have surrounding whitespace',
    });
  }

  const initialDelayMs = positiveMs(
    "reconnect.initialDelay",
    options.reconnect?.initialDelay ?? 1000,
  );
  const maxDelayMs = Math.max(
    initialDelayMs,
    positiveMs("reconnect.maxDelay", options.reconnect?.maxDelay ?? 30_000),
  );
  const factor = options.reconnect?.factor ?? 2;
  if (!Number.isFinite(factor) || factor < 1) {
    throw new VTubeStudioConfigError({
      message: "reconnect.factor must be a number greater than or equal to 1",
    });
  }

  return {
    slot,
    url: normalizeUrl(options.url ?? "ws://127.0.0.1:8001"),
    pluginName: normalizePluginIdentity("pluginName", options.pluginName ?? "Ballast"),
    pluginDeveloper: normalizePluginIdentity(
      "pluginDeveloper",
      options.pluginDeveloper ?? "Ballast",
    ),
    pluginIcon: options.pluginIcon,
    publish: options.publish,
    tokenStore: options.tokenStore ?? fileTokenStore(options.dataDir),
    requestTimeout: options.requestTimeout ?? "30 seconds",
    approvalTimeout: options.approvalTimeout ?? "5 minutes",
    initialDelayMs,
    maxDelayMs,
    factor,
  };
};

const decode = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  value: unknown,
  label: string,
): Effect.Effect<A, VTubeStudioProtocolError> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new VTubeStudioProtocolError({
          message: "Invalid " + label + ": " + errorMessage(cause),
        }),
    ),
  );

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)];

const identityOf = (config: NormalizedConfig) => ({
  pluginName: config.pluginName,
  pluginDeveloper: config.pluginDeveloper,
});

interface ParsedSubscription {
  readonly eventName: EventName;
  readonly config: Readonly<Record<string, unknown>>;
  readonly configJson: string;
}

const parseSubscriptions = (
  subscriptions: ReadonlyArray<VTubeStudioSubscription>,
): Effect.Effect<ReadonlyMap<EventName, ParsedSubscription>, VTubeStudioConfigError> =>
  Effect.gen(function* () {
    const parsed = new Map<EventName, ParsedSubscription>();
    for (const subscription of subscriptions) {
      const eventName = eventNameOfTopic(subscription.topic);
      if (eventName === undefined) {
        return yield* new VTubeStudioConfigError({
          message: 'Unknown VTube Studio topic "' + subscription.topic + '"',
        });
      }
      const raw = configOfCondition(subscription.condition);
      let value: unknown = {};
      if (raw !== undefined) {
        value = yield* Effect.try({
          try: () => {
            const parsedJson: unknown = JSON.parse(raw);
            return parsedJson;
          },
          catch: (cause) =>
            new VTubeStudioConfigError({
              message:
                'Invalid event config for "' +
                subscription.topic +
                '": ' +
                errorMessage(cause),
            }),
        });
      }
      const config = yield* Schema.decodeUnknownEffect(
        Schema.Record(Schema.String, Schema.Unknown),
      )(value).pipe(
        Effect.mapError(
          (cause) =>
            new VTubeStudioConfigError({
              message:
                'Invalid event config for "' +
                subscription.topic +
                '": ' +
                errorMessage(cause),
            }),
        ),
      );
      parsed.set(eventName, {
        eventName,
        config,
        configJson: JSON.stringify(config),
      });
    }
    return parsed;
  });

type StatusPatch = Partial<
  Pick<
    VTubeStudioDriverStatus,
    | "state"
    | "message"
    | "authenticated"
    | "vTubeStudioVersion"
    | "attempts"
    | "lastConnectedAt"
  >
>;

export const layer = (
  options: VTubeStudioDriverOptions,
): Layer.Layer<
  VTubeStudioDriver,
  VTubeStudioConfigError,
  SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path | Socket.WebSocketConstructor
> =>
  Layer.effect(
    VTubeStudioDriver,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const config = yield* Effect.try({
        try: () => normalizeConfig(options),
        catch: (cause) =>
          cause instanceof VTubeStudioConfigError
            ? cause
            : new VTubeStudioConfigError({ message: errorMessage(cause) }),
      });
      type ProvidedTokenStore = {
        readonly read: (
          slot: string,
        ) => Effect.Effect<StoredVTubeStudioToken | undefined, VTubeStudioStorageError>;
        readonly write: (
          token: StoredVTubeStudioToken,
        ) => Effect.Effect<void, VTubeStudioStorageError>;
        readonly remove: (
          slot: string,
        ) => Effect.Effect<void, VTubeStudioStorageError>;
      };
      const tokenStore: ProvidedTokenStore = {
        read: (slot) =>
          config.tokenStore.read(slot).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
        write: (token) =>
          config.tokenStore.write(token).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
        remove: (slot) =>
          config.tokenStore.remove(slot).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
      };
      const desired = yield* parseSubscriptions(options.subscriptions ?? []);
      const ready = yield* Deferred.make<void>();
      const initialStatus: VTubeStudioDriverStatus = {
        slot: config.slot,
        url: config.url,
        state: "disconnected",
        message: undefined,
        authenticated: false,
        vTubeStudioVersion: undefined,
        attempts: 0,
        lastConnectedAt: undefined,
        updatedAt: Date.now(),
      };
      const statusRef = yield* SubscriptionRef.make(initialStatus);
      const desiredRef = yield* Ref.make(desired);
      const subscribedRef = yield* Ref.make<ReadonlyMap<EventName, string>>(new Map());
      const sessionRef = yield* Ref.make<VTubeStudioSession | undefined>(undefined);
      const reconcileLock = yield* Semaphore.make(1);

      const updateStatus = (patch: StatusPatch): Effect.Effect<void> =>
        SubscriptionRef.update(statusRef, (current) => ({
          ...current,
          ...patch,
          updatedAt: Date.now(),
        }));

      const onEvent = (packet: VTubeStudioEventPacket): void => {
        const name = topicNameForEvent(packet.messageType);
        if (name === undefined) return;
        config.publish?.(topicKey(config.slot, name), packet.data);
      };

      const authenticateWithToken = (
        session: VTubeStudioSession,
        token: string,
      ): Effect.Effect<AuthenticationResponse, VTubeStudioError> =>
        session
          .call(
            "Authentication",
            { ...identityOf(config), authenticationToken: token },
            { invalidateOnAuthError: false },
          )
          .pipe(
            Effect.flatMap((data) =>
              decode(AuthenticationResponseSchema, data, "AuthenticationResponse"),
            ),
            Effect.catchTag("VTubeStudioRequestError", (error) =>
              Effect.succeed({
                authenticated: false,
                reason: error.message,
              } satisfies AuthenticationResponse),
            ),
          );

      const authenticate = (session: VTubeStudioSession): Effect.Effect<APIStateResponse, VTubeStudioError> =>
        Effect.gen(function* () {
          yield* updateStatus({
            state: "authenticating",
            message: undefined,
            authenticated: false,
          });

          const apiState = yield* session
            .call("APIState", {}, { invalidateOnAuthError: false })
            .pipe(
              Effect.flatMap((data) =>
                decode(APIStateResponseSchema, data, "APIStateResponse"),
              ),
            );
          if (!apiState.active) {
            return yield* new VTubeStudioAuthenticationError({
              message:
                "VTube Studio's plugin API is not active. Enable \"Allow Plugin API access\" in VTube Studio.",
              invalidatedToken: false,
            });
          }

          const stored = yield* tokenStore.read(config.slot);
          if (stored !== undefined) {
            const response = yield* authenticateWithToken(session, stored.authenticationToken);
            if (response.authenticated) return apiState;

            yield* tokenStore.remove(config.slot).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  "Could not remove the rejected VTube Studio token: " + error.message,
                ),
              ),
            );
            yield* Effect.logWarning(
              "Stored VTube Studio token was rejected; requesting a new one",
            );
          }

          yield* updateStatus({
            state: "waiting-for-approval",
            message:
              'Allow the "' +
              config.pluginName +
              '" plugin in VTube Studio (the request is waiting for the user)',
            authenticated: false,
          });

          const tokenResponse = yield* session
            .call(
              "AuthenticationToken",
              {
                ...identityOf(config),
                ...(config.pluginIcon === undefined
                  ? {}
                  : { pluginIcon: config.pluginIcon }),
              },
              { timeout: config.approvalTimeout, invalidateOnAuthError: false },
            )
            .pipe(
              Effect.flatMap((data) =>
                decode(
                  AuthenticationTokenResponseSchema,
                  data,
                  "AuthenticationTokenResponse",
                ),
              ),
            );
          if (tokenResponse.authenticationToken === "") {
            return yield* new VTubeStudioAuthenticationError({
              message: "VTube Studio returned an empty authentication token",
              invalidatedToken: false,
            });
          }

          const storedToken: StoredVTubeStudioToken = {
            version: 1,
            slot: config.slot,
            url: config.url,
            pluginName: config.pluginName,
            pluginDeveloper: config.pluginDeveloper,
            authenticationToken: tokenResponse.authenticationToken,
            updatedAt: Date.now(),
          };
          yield* tokenStore.write(storedToken).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                "Could not save the VTube Studio token (it will be requested again on reconnect): " +
                  error.message,
              ),
            ),
          );

          yield* updateStatus({
            state: "authenticating",
            message: undefined,
            authenticated: false,
          });
          const response = yield* authenticateWithToken(
            session,
            tokenResponse.authenticationToken,
          );
          if (!response.authenticated) {
            return yield* new VTubeStudioAuthenticationError({
              message:
                response.reason ??
                "VTube Studio did not authenticate the plugin after approval",
              invalidatedToken: true,
            });
          }
          return apiState;
        });

      const reconcile = (session?: VTubeStudioSession): Effect.Effect<void> =>
        reconcileLock.withPermit(
          Effect.gen(function* () {
            const active = session ?? (yield* Ref.get(sessionRef));
            if (active === undefined) return;

            const desiredTopics = yield* Ref.get(desiredRef);
            const subscribed = yield* Ref.get(subscribedRef);

            for (const eventName of [...subscribed.keys()]) {
              if (desiredTopics.has(eventName)) continue;
              yield* active
                .call("EventSubscription", {
                  eventName: TOPIC_EVENT_NAMES[eventName],
                  subscribe: false,
                })
                .pipe(
                  Effect.tap(() =>
                    Ref.update(subscribedRef, (current) => {
                      const next = new Map(current);
                      next.delete(eventName);
                      return next;
                    }),
                  ),
                  Effect.catch((error) =>
                    Effect.logWarning(
                      "Could not unsubscribe from " +
                        TOPIC_EVENT_NAMES[eventName] +
                        ": " +
                        error.message,
                    ),
                  ),
                );
            }

            const afterUnsubscribe = yield* Ref.get(subscribedRef);
            for (const [eventName, subscription] of desiredTopics) {
              if (afterUnsubscribe.get(eventName) === subscription.configJson) continue;
              yield* active
                .call("EventSubscription", {
                  eventName: TOPIC_EVENT_NAMES[eventName],
                  subscribe: true,
                  config: { ...subscription.config },
                })
                .pipe(
                  Effect.tap(() =>
                    Ref.update(subscribedRef, (current) =>
                      new Map(current).set(eventName, subscription.configJson),
                    ),
                  ),
                  Effect.catch((error) =>
                    Effect.gen(function* () {
                      yield* updateStatus({
                        message:
                          "Could not subscribe to " +
                          TOPIC_EVENT_NAMES[eventName] +
                          ": " +
                          error.message,
                      });
                      yield* Effect.logWarning(
                        "Could not subscribe to " +
                          TOPIC_EVENT_NAMES[eventName] +
                          ": " +
                          error.message,
                      );
                    }),
                  ),
                );
            }
          }),
        );

      const runConnection = Effect.gen(function* () {
        const session = yield* connectSession({
          url: config.url,
          requestTimeout: config.requestTimeout,
          onEvent,
        });
        const apiState = yield* authenticate(session);
        yield* Ref.set(sessionRef, session);
        yield* updateStatus({
          state: "connected",
          message: undefined,
          authenticated: true,
          vTubeStudioVersion: apiState.vTubeStudioVersion,
          attempts: 0,
          lastConnectedAt: Date.now(),
        });
        yield* Deferred.succeed(ready, undefined);
        yield* reconcile(session);
        yield* Effect.raceFirst(session.closed, session.authInvalid);
      });

      let attempt = 0;
      const connectLoop = Effect.gen(function* () {
        while (true) {
          yield* updateStatus({
            state: attempt === 0 ? "connecting" : "reconnecting",
            message: undefined,
            authenticated: false,
            attempts: attempt,
          });

          const result = yield* Effect.exit(Effect.scoped(runConnection));
          if (Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)) {
            return yield* Effect.interrupt;
          }
          yield* Ref.set(sessionRef, undefined);
          yield* Ref.set(subscribedRef, new Map());

          const failure = Exit.isFailure(result)
            ? Option.getOrUndefined(Cause.findErrorOption(result.cause))
            : undefined;
          const connectionFailed = failure !== undefined;
          if (
            failure !== undefined &&
            failure._tag === "VTubeStudioAuthenticationError" &&
            failure.invalidatedToken
          ) {
            yield* tokenStore.remove(config.slot).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  "Could not remove the invalid VTube Studio token: " + error.message,
                ),
              ),
            );
          }

          // A clean exit always means an authenticated session ended, so the
          // next reconnect starts again at the initial delay.
          attempt = connectionFailed ? attempt + 1 : 0;
          const delay = Math.min(
            config.initialDelayMs *
              Math.pow(config.factor, Math.min(Math.max(attempt - 1, 0), 10)),
            config.maxDelayMs,
          );
          const reason = failure === undefined ? "connection closed" : failure.message;
          yield* updateStatus({
            state:
              failure !== undefined && failure._tag === "VTubeStudioAuthenticationError"
                ? "error"
                : "reconnecting",
            message: reason,
            authenticated: false,
            vTubeStudioVersion: undefined,
            attempts: attempt,
          });
          yield* Effect.sleep(delay);
        }
      });

      const requestRaw = (
        name: ScriptRequestName,
        input: unknown,
      ): Effect.Effect<unknown, VTubeStudioError> =>
        Effect.gen(function* () {
          const schemas = RequestSchemas[name];
          const decodedInput = yield* decode(
            schemas.input,
            input === undefined ? {} : input,
            name + "Request",
          );
          const session = yield* Ref.get(sessionRef);
          if (session === undefined) {
            return yield* new VTubeStudioConnectionError({
              message: "VTube Studio " + config.slot + " is not connected",
            });
          }
          return yield* session.call(name, decodedInput);
        });

      const request = (name: string, input: unknown): Effect.Effect<unknown, VTubeStudioError> =>
        Effect.suspend(() => {
          if (isScriptRequestName(name)) return requestRaw(name, input);
          if (isDriverOwnedRequestName(name)) {
            return Effect.fail(
              new VTubeStudioConfigError({
                message:
                  'VTube Studio request "' + name + '" is managed by the driver',
              }),
            );
          }
          return Effect.fail(
            new VTubeStudioRequestError({
              requestType: name,
              message: 'Unknown VTube Studio request "' + name + '"',
            }),
          );
        });

      const invoke = <K extends ScriptRequestName>(
        name: K,
        input: VTubeStudioRequests[K]["input"],
      ): Effect.Effect<VTubeStudioRequests[K]["output"], VTubeStudioError> =>
        requestRaw(name, input).pipe(
          Effect.flatMap((raw) =>
            decode(RequestSchemas[name].output, raw, name + "Response"),
          ),
        );

      const setTopics = (
        subscriptions: ReadonlyArray<VTubeStudioSubscription>,
      ): Effect.Effect<void, VTubeStudioConfigError> =>
        Effect.gen(function* () {
          const parsed = yield* parseSubscriptions(subscriptions);
          yield* Ref.set(desiredRef, parsed);
          yield* reconcile();
        });

      const resolveOptions = (
        source: ParamOptionSource,
      ): Effect.Effect<ReadonlyArray<string>, VTubeStudioError> =>
        Effect.gen(function* () {
          if (source.integration !== INTEGRATION || source.slot !== config.slot) {
            return yield* new VTubeStudioOptionError({
              message:
                "Option source " +
                source.integration +
                "/" +
                source.slot +
                "/" +
                source.source +
                " does not belong to VTube Studio " +
                config.slot,
            });
          }
          switch (source.source) {
            case "models": {
              const response = yield* requestRaw("AvailableModels", {}).pipe(
                Effect.flatMap((raw) =>
                  decode(AvailableModelsResponseSchema, raw, "AvailableModelsResponse"),
                ),
              );
              return unique(response.availableModels.map((model) => model.modelID));
            }
            case "hotkeys": {
              const response = yield* requestRaw("HotkeysInCurrentModel", {}).pipe(
                Effect.flatMap((raw) =>
                  decode(
                    HotkeysInCurrentModelResponseSchema,
                    raw,
                    "HotkeysInCurrentModelResponse",
                  ),
                ),
              );
              return unique(
                response.availableHotkeys.map((hotkey) =>
                  hotkey.name === "" ? hotkey.hotkeyID : hotkey.name,
                ),
              );
            }
            case "expressions": {
              const response = yield* requestRaw("ExpressionState", {
                details: false,
              }).pipe(
                Effect.flatMap((raw) =>
                  decode(ExpressionStateResponseSchema, raw, "ExpressionStateResponse"),
                ),
              );
              return unique(response.expressions.map((expression) => expression.file));
            }
            default:
              return yield* new VTubeStudioOptionError({
                message:
                  'Unknown VTube Studio option source "' + source.source + '"',
              });
          }
        });

      yield* Effect.forkScoped(
        connectLoop.pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Effect.logError(
                  "VTube Studio driver loop stopped: " +
                    errorMessage(Cause.squash(exit.cause)),
                )
              : Effect.void,
          ),
        ),
      );

      return VTubeStudioDriver.of({
        slot: config.slot,
        url: config.url,
        status: SubscriptionRef.get(statusRef),
        statusChanges: SubscriptionRef.changes(statusRef),
        ready: Deferred.await(ready),
        request,
        invoke,
        setTopics,
        resolveOptions,
      });
    }),
  );

export {
  VTubeStudioAuthenticationError,
  VTubeStudioConfigError,
  VTubeStudioConnectionError,
  VTubeStudioOptionError,
  VTubeStudioProtocolError,
  VTubeStudioRequestError,
  VTubeStudioStorageError,
};
export type { VTubeStudioError };
export {
  StoredTokenSchema,
  fileTokenStore,
  resolveDataDir,
  tokenPath,
} from "./token-store.ts";
export type { StoredVTubeStudioToken, VTubeStudioTokenStore } from "./token-store.ts";
