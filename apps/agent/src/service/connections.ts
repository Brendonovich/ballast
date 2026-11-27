import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stdio from "effect/Stdio";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/http";
import { Socket } from "effect/socket";
import {
  agentError,
  connectionIntegrations,
  DEFAULT_TWITCH_CALLBACK_PORT,
  type AgentError,
  type ConnectionApproval,
  type ConnectionAuth,
  type ConnectionField,
  type ConnectionIntegration,
  type ConnectionMode,
  type ConnectionSummary,
  type ConnectionValue,
  type PermissionStatus,
} from "@ballast/agent-protocol";
import {
  ConnectionUnavailable,
  ConnectionRequestFailed,
  connectionRequestError,
  type ConnectionRequestError,
} from "@ballast/core";
import type { Manifest } from "@ballast/core";
import { RequestSchemas } from "@ballast/module-obs";
import { VTubeStudioDriver } from "@ballast/module-vtube-studio/driver";
import type { VTubeStudioDriverService, VTubeStudioSubscription } from "@ballast/module-vtube-studio/driver";
import { Driver as KeyboardDriver, layer as keyboardLayer } from "@ballast/module-keyboard/driver";
import type { DriverService as KeyboardDriverService } from "@ballast/module-keyboard/driver";
import { Driver as MidiDriver, layer as midiLayer } from "@ballast/module-midi/driver";
import type { DriverService as MidiDriverService } from "@ballast/module-midi/driver";
import {
  WebSocketClientDriver,
  WebSocketServerDriver,
  layerNode as webSocketLayerNode,
} from "@ballast/module-websocket/driver";
import type {
  WebSocketClientConnection,
  WebSocketServerConnection,
} from "@ballast/module-websocket/driver";
import {
  WebhookDriver,
  WebhookRelay,
  webhookLayer,
} from "@ballast/module-http/driver";
import type { WebhookRuntime } from "@ballast/module-http/driver";
import type { WebhookDefinition } from "@ballast/module-http";
import * as Twitch from "@ballast/module-twitch";
import { handleFakeRequest } from "../fake.ts";
import { obsPasswordEnvKey, resolveObsConnectionConfig } from "../connection-config.ts";
import type { ConnectionOptions } from "../connection-config.ts";
import { startObsDriver } from "../obs-driver.ts";
import type { ObsDriver } from "../obs-driver.ts";
import { startTwitchAuth } from "../twitch/auth.ts";
import {
  readStoredTwitchAccount,
  resolveTwitchAppConfig,
  twitchEnvKeys,
  writeStoredTwitchAccount,
} from "../twitch/config.ts";
import { readEnvironment } from "./config.ts";
import { missingScopes, subscriptionSpecs } from "../twitch/conditions.ts";
import { TwitchTransportError } from "../twitch/errors.ts";
import { startCloudTwitchTransport } from "../twitch/cloud.ts";
import type { CloudApi } from "../twitch/cloud.ts";
import { startLocalTwitchTransport } from "../twitch/local.ts";
import { subscriptionKey } from "../twitch/transport.ts";
import type { TwitchIdentity, TwitchSubscriptionSpec, TwitchTransport } from "../twitch/transport.ts";
import { CloudLink } from "./cloud-link.ts";
import { WebhookRelayAgentLive } from "./http-relay.ts";
import { ensureDir, readJson, sha256, writeJsonAtomic } from "./fs.ts";
import { Logs } from "./telemetry.ts";
import { EventRouter } from "./telemetry.ts";

export interface ActiveScript {
  readonly projectId: string;
  readonly scriptId: string;
  readonly manifest: Manifest;
  readonly enabled: boolean;
}

export interface ReconcileInput {
  /** Scripts with a live worker generation. */
  readonly running: ReadonlyArray<ActiveScript>;
  /** Every discovered script with a current manifest, for bindings and scopes. */
  readonly known: ReadonlyArray<ActiveScript>;
  /** projectId -> "integration/slot" -> connection instance id. */
  readonly bindings?: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

const boundIdFor = (
  input: ReconcileInput,
  entry: ActiveScript,
  integration: string,
  slot: string,
): string | undefined =>
  input.bindings?.get(entry.projectId)?.get(integration + "/" + slot);

const slotsFor = (
  input: ReconcileInput,
  entry: ActiveScript,
  record: Pick<ConnectionRecord, "id" | "integration">,
): ReadonlyArray<string> =>
  entry.manifest.connections
    .filter(
      (connection) =>
        connection.integration === record.integration &&
        boundIdFor(input, entry, connection.integration, connection.slot) === record.id,
    )
    .map((connection) => connection.slot);

const usesConnection = (
  input: ReconcileInput,
  entry: ActiveScript,
  record: Pick<ConnectionRecord, "id" | "integration">,
): boolean => slotsFor(input, entry, record).length > 0;

interface ConnectionRecord {
  readonly id: string;
  readonly integration: string;
  readonly slot: string;
  readonly mode: ConnectionMode;
  readonly values: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly label: string;
  readonly manual: boolean;
  /** The user pressed Disconnect; do not reconnect until Connect. */
  readonly disabled: boolean;
  readonly driver: DriverState | undefined;
  readonly status: ConnectionSummary["status"];
  readonly lastError: string | undefined;
  readonly lastConnectedAt: number | undefined;
  readonly nextRetryAt: number | undefined;
  readonly identity: TwitchIdentity | undefined;
  readonly grantedScopes: ReadonlyArray<string>;
  readonly account: { readonly id: string; readonly login: string; readonly displayName?: string } | undefined;
  readonly needsReauth: boolean;
  /** A pending out-of-app approval (VTube Studio, macOS Accessibility). */
  readonly approval: ConnectionApproval | undefined;
  readonly cloudConnectionId: string | undefined;
  readonly owners: ReadonlySet<string>;
  readonly ownerSpecs: ReadonlyMap<string, string>;
  readonly detailText: string | undefined;
}

interface DriverState {
  readonly kind:
    | "obs"
    | "fake"
    | "twitch-local"
    | "twitch-cloud"
    | "vts"
    | "keyboard"
    | "midi"
    | "websocket-client"
    | "websocket-server";
  readonly scope: Scope.Closeable;
  readonly configKey: string;
  readonly topicsKey: string;
  readonly obs: ObsDriver | undefined;
  readonly twitch: TwitchTransport | undefined;
  readonly vts: VTubeStudioDriverService | undefined;
  readonly keyboard: KeyboardDriverService | undefined;
  readonly midi: MidiDriverService | undefined;
  readonly webSocketClient: WebSocketClientConnection | undefined;
  /** One listener per bound slot; slots that share an address share a listener. */
  readonly webSocketServers: ReadonlyMap<string, WebSocketServerConnection>;
  readonly cloudApi: CloudApi | undefined;
  readonly cloudConnectionId: string | undefined;
}

interface StoredConnections {
  readonly version: 1;
  readonly connections: ReadonlyArray<{
    readonly id: string;
    readonly integration: string;
    readonly slot: string;
    readonly mode: ConnectionMode;
    readonly values: Readonly<Record<string, string>>;
    readonly label: string;
    readonly disabled?: boolean;
  }>;
}

interface StoredSecrets {
  readonly version: 1;
  readonly secrets: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const connectionsJsonPath = (path: Path.Path, dataDir: string): string =>
  path.join(dataDir, "connections.json");
const secretsJsonPath = (path: Path.Path, dataDir: string): string =>
  path.join(dataDir, "secrets.json");

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const splitId = (id: string): { integration: string; slot: string } | undefined => {
  const index = id.indexOf("/");
  if (index <= 0 || index === id.length - 1) return undefined;
  return { integration: id.slice(0, index), slot: id.slice(index + 1) };
};

const integrationDefinition = (integration: string): ConnectionIntegration | undefined =>
  connectionIntegrations.find((entry) => entry.integration === integration);

const titleOf = (integration: string): string =>
  integrationDefinition(integration)?.title ?? integration;

const locationOf = (integration: string): ConnectionSummary["location"] =>
  integrationDefinition(integration)?.location ?? "local";

const fieldsFor = (integration: string): ReadonlyArray<ConnectionField> =>
  integrationDefinition(integration)?.fields ?? [];

export interface ConnectionManagerService {
  /** Integration descriptors for the Add connection dialog. */
  readonly integrations: () => ReadonlyArray<ConnectionIntegration>;
  readonly summaries: () => Effect.Effect<ReadonlyArray<ConnectionSummary>>;
  readonly summary: (connectionId: string) => Effect.Effect<ConnectionSummary | undefined>;
  readonly require: (connectionId: string) => Effect.Effect<ConnectionSummary, AgentError>;
  readonly create: (input: {
    readonly integration: string;
    readonly label: string;
    readonly config: Readonly<Record<string, string>>;
    readonly mode?: ConnectionMode;
  }) => Effect.Effect<ConnectionSummary, AgentError>;
  readonly update: (input: {
    readonly id: string;
    readonly label?: string;
    readonly config?: Readonly<Record<string, string>>;
    readonly mode?: ConnectionMode;
  }) => Effect.Effect<ConnectionSummary, AgentError>;
  readonly remove: (id: string) => Effect.Effect<void, AgentError>;
  readonly configure: (input: {
    readonly connectionId: string;
    readonly values: ReadonlyArray<{ readonly key: string; readonly value: string }>;
    readonly mode?: ConnectionMode;
  }) => Effect.Effect<ConnectionSummary, AgentError>;
  readonly connect: (connectionId: string) => Effect.Effect<ConnectionSummary, AgentError>;
  readonly disconnect: (connectionId: string) => Effect.Effect<ConnectionSummary, AgentError>;
  readonly startAuth: (input: {
    readonly connectionId: string;
    readonly mode?: ConnectionMode;
    readonly scopes?: ReadonlyArray<string>;
  }) => Effect.Effect<ConnectionAuth, AgentError>;
  readonly reconcile: (input: ReconcileInput) => Effect.Effect<void>;
  /** Shell-owned permissions, for `GetHealth.permissions`. */
  readonly permissions: () => Effect.Effect<{ readonly accessibility: PermissionStatus }>;
  /** Apply a shell-reported permission and reconcile keyboard drivers. */
  readonly reportShellPermission: (input: {
    readonly permission: "accessibility";
    readonly status: PermissionStatus;
  }) => Effect.Effect<void>;
  readonly request: (input: {
    readonly integration: string;
    readonly slot: string;
    /** Resolve a bound project slot to a service-level instance. */
    readonly connectionId?: string;
    readonly request: string;
    readonly input: unknown;
  }) => Effect.Effect<unknown, ConnectionRequestError>;
  readonly optionValues: (source: {
    readonly integration: string;
    readonly slot: string;
    readonly source: string;
    /** The bound connection instance, when the slot has one. */
    readonly connectionId?: string;
  }) => Effect.Effect<ReadonlyArray<string>, AgentError>;
  readonly close: () => Effect.Effect<void>;
}

export class ConnectionManager extends Context.Service<
  ConnectionManager,
  ConnectionManagerService
>()("ballast/service/ConnectionManager") {}

const noneRecord = (
  integration: string,
  slot: string,
): ConnectionRecord => ({
  id: `${integration}/${slot}`,
  integration,
  slot,
  mode: "auto",
  values: {},
  secrets: {},
  label: titleOf(integration),
  manual: false,
  disabled: false,
  driver: undefined,
  status: "unconfigured",
  lastError: undefined,
  lastConnectedAt: undefined,
  nextRetryAt: undefined,
  identity: undefined,
  grantedScopes: [],
  account: undefined,
  needsReauth: false,
  approval: undefined,
  cloudConnectionId: undefined,
  owners: new Set(),
  ownerSpecs: new Map(),
  detailText: undefined,
});

const loadStored = (
  dataDir: string,
): Effect.Effect<
  {
    records: ReadonlyArray<ConnectionRecord>;
    secrets: Readonly<Record<string, Readonly<Record<string, string>>>>;
  },
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
  const path = yield* Path.Path;
  const connectionsValue = yield* readJson(connectionsJsonPath(path, dataDir)).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  const secretsValue = yield* readJson(secretsJsonPath(path, dataDir)).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  const records: Array<ConnectionRecord> = [];
  if (typeof connectionsValue === "object" && connectionsValue !== null) {
    const list = (connectionsValue as { connections?: unknown }).connections;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item !== "object" || item === null) continue;
        const entry = item as Record<string, unknown>;
        if (
          typeof entry["id"] !== "string" ||
          typeof entry["integration"] !== "string" ||
          typeof entry["slot"] !== "string"
        ) {
          continue;
        }
        const values: Record<string, string> = {};
        if (typeof entry["values"] === "object" && entry["values"] !== null) {
          for (const [key, value] of Object.entries(entry["values"] as object)) {
            if (typeof value === "string") values[key] = value;
          }
        }
        const mode: ConnectionMode =
          entry["mode"] === "local-app" || entry["mode"] === "cloud"
            ? entry["mode"]
            : "auto";
        const storedLabel =
          typeof entry["label"] === "string" && entry["label"] !== entry["slot"]
            ? entry["label"]
            : titleOf(entry["integration"]);
        records.push({
          ...noneRecord(entry["integration"], entry["slot"]),
          id: entry["id"],
          mode,
          values,
          label: storedLabel,
          disabled: entry["disabled"] === true,
        });
      }
    }
  }
  const secrets: Record<string, Readonly<Record<string, string>>> = {};
  if (typeof secretsValue === "object" && secretsValue !== null) {
    const value = (secretsValue as { secrets?: unknown }).secrets;
    if (typeof value === "object" && value !== null) {
      for (const [id, fields] of Object.entries(value as object)) {
        if (typeof fields !== "object" || fields === null) continue;
        const entry: Record<string, string> = {};
        for (const [key, secret] of Object.entries(fields as object)) {
          if (typeof secret === "string") entry[key] = secret;
        }
        secrets[id] = entry;
      }
    }
  }
  return { records, secrets };
  });

export interface ConnectionManagerOptions {
  readonly dataDir: string;
  readonly keyboardLayer?: Layer.Layer<KeyboardDriver>;
  readonly midiLayer?: Layer.Layer<MidiDriver>;
}

export const ConnectionManagerLive = (options: ConnectionManagerOptions) =>
  Layer.effect(
    ConnectionManager,
    Effect.gen(function* () {
      const logs = yield* Logs;
      const router = yield* EventRouter;
      const cloud = yield* CloudLink;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const context = yield* Effect.context<never>();
      const platform = yield* Effect.context<
        | ChildProcessSpawner
        | SecureRandom.SecureRandom
        | FileSystem.FileSystem
        | Path.Path
        | Stdio.Stdio
      >();
      const provide = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          ChildProcessSpawner | SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path | Stdio.Stdio
        >,
      ): Effect.Effect<A, E> => Effect.provideContext(effect, platform);
      const parentScope = yield* Effect.scope;
      const authScopes = new Set<Scope.Closeable>();

      const loaded = yield* loadStored(options.dataDir).pipe(
        Effect.catch(() =>
          Effect.succeed({
            records: [] as ReadonlyArray<ConnectionRecord>,
            secrets: {} as Readonly<Record<string, Readonly<Record<string, string>>>>,
          }),
        ),
      );

      const state = yield* Ref.make<ReadonlyMap<string, ConnectionRecord>>(
        new Map(
          loaded.records.map((record) => [
            record.id,
            { ...record, secrets: loaded.secrets[record.id] ?? {} },
          ]),
        ),
      );
      const secretState = yield* Ref.make<Readonly<Record<string, Readonly<Record<string, string>>>>>(
        loaded.secrets,
      );
      const lastInput = yield* Ref.make<ReconcileInput>({ running: [], known: [] });
      /** Retry schedule for drivers that failed to start: id -> attempts and next try. */
      const retries = yield* Ref.make<
        ReadonlyMap<string, { readonly attempts: number; readonly nextAt: number }>
      >(new Map());
      const shellPermissions = yield* Ref.make<{ accessibility: PermissionStatus }>({
        accessibility: "unknown",
      });
      const semaphore = yield* Semaphore.make(1);
      const webSocketContext = yield* Layer.build(webSocketLayerNode);
      const webSocketClientDriver = Context.get(webSocketContext, WebSocketClientDriver);
      const webSocketServerDriver = Context.get(webSocketContext, WebSocketServerDriver);
      const relayContext = yield* Layer.build(
        WebhookRelayAgentLive.pipe(Layer.provide(Layer.succeed(CloudLink, cloud))),
      );
      const webhookContext = yield* Layer.build(
        webhookLayer.pipe(
          Layer.provide(Layer.succeed(WebhookRelay, Context.get(relayContext, WebhookRelay))),
        ),
      );
      const webhookDriver = Context.get(webhookContext, WebhookDriver);
      const webhookRuntime = yield* Ref.make<
        | {
            readonly key: string;
            readonly scope: Scope.Closeable;
            readonly runtime: WebhookRuntime;
          }
        | undefined
      >(undefined);
      const sceneCache = yield* Ref.make<
        ReadonlyMap<string, { readonly at: number; readonly values: ReadonlyArray<string> }>
      >(new Map());

      const persist = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          const records = yield* Ref.get(state);
          const secrets = yield* Ref.get(secretState);
          yield* provide(Effect.gen(function* () {
            const stored: StoredConnections = {
              version: 1,
              connections: [...records.values()].map((record) => ({
                id: record.id,
                integration: record.integration,
                slot: record.slot,
                mode: record.mode,
                values: record.values,
                label: record.label,
                disabled: record.disabled,
              })),
            };
            yield* ensureDir(options.dataDir);
            yield* writeJsonAtomic(
              connectionsJsonPath(path, options.dataDir),
              stored,
              0o600,
            );
            const secretFile: StoredSecrets = { version: 1, secrets };
            yield* writeJsonAtomic(
              secretsJsonPath(path, options.dataDir),
              secretFile,
              0o600,
            );
          })).pipe(
            Effect.mapError(errorMessage),
          ).pipe(
            Effect.catch((reason) =>
              logs.write({
                level: "error",
                source: "connection",
                message: `could not save connection settings: ${reason}`,
              }),
            ),
          );
        });

      const records = (): Effect.Effect<ReadonlyArray<ConnectionRecord>> =>
        Effect.map(Ref.get(state), (current) => [...current.values()]);

      const getRecord = (id: string): Effect.Effect<ConnectionRecord | undefined> =>
        Effect.map(Ref.get(state), (current) => current.get(id));

      const ensureRecord = (id: string): Effect.Effect<ConnectionRecord> =>
        Effect.gen(function* () {
          const existing = yield* getRecord(id);
          if (existing !== undefined) return existing;
          const parts = splitId(id);
          if (parts === undefined) {
            return yield* Effect.die(new Error(`Invalid connection id "${id}"`));
          }
          const record = noneRecord(parts.integration, parts.slot);
          yield* Ref.update(state, (current) => {
            const next = new Map(current);
            next.set(id, record);
            return next;
          });
          return record;
        });

      const updateRecord = (
        id: string,
        update: (record: ConnectionRecord) => ConnectionRecord,
      ): Effect.Effect<ConnectionRecord> =>
        Effect.gen(function* () {
          const existing = yield* ensureRecord(id);
          const next = update(existing);
          yield* Ref.update(state, (current) => {
            const map = new Map(current);
            map.set(id, next);
            return map;
          });
          return next;
        });

      const closeDriver = (record: ConnectionRecord): Effect.Effect<void> =>
        record.driver === undefined
          ? Effect.void
          : Scope.close(record.driver.scope, Exit.void).pipe(
              Effect.andThen(
                updateRecord(record.id, (current) => ({
                  ...current,
                  driver: undefined,
                  status: "disconnected",
                  nextRetryAt: undefined,
                })),
              ),
              Effect.asVoid,
            );

      const requiredFieldsSet = (
        record: ConnectionRecord,
        mode: ConnectionMode = record.mode,
      ): boolean => {
        const fields = fieldsFor(record.integration);
        const valueOf = (key: string): string | undefined =>
          record.values[key] ?? record.secrets[key];
        if (record.integration === "obs") {
          return (valueOf("url") ?? "").length > 0;
        }
        if (record.integration === "websocket-client") {
          return (valueOf("url") ?? "").length > 0;
        }
        // A server's port normally comes from the script's listen scope; the
        // connection setting is only a fallback, so no field is required here.
        if (record.integration === "websocket-server") return true;
        if (record.integration === "fake") return true;
        // Cloud mode uses the machine's linked Twitch account; client id and
        // secret are only needed for a local-app OAuth flow.
        if (record.integration === "twitch" && mode === "cloud") return true;
        return fields.some((field) => field.required && (valueOf(field.key) ?? "") === "")
          ? false
          : true;
      };

      const scopesRequiredFor = (record: ConnectionRecord): ReadonlyArray<string> => {
        const input = Effect.runSync(Ref.get(lastInput));
        const enabled = input.known.filter(
          (entry) =>
            entry.enabled ||
            input.running.some(
              (running) =>
                running.projectId === entry.projectId && running.scriptId === entry.scriptId,
            ),
        );
        return [
          ...new Set(
            enabled.flatMap((entry) =>
              entry.manifest.topics
                .filter(
                  (topic) =>
                    topic.integration === record.integration &&
                    boundIdFor(input, entry, topic.integration, topic.slot) === record.id,
                )
                .flatMap((topic) => topic.scopes)
                .concat(
                  entry.manifest.requests
                    .filter(
                      (request) =>
                        request.integration === record.integration &&
                        boundIdFor(input, entry, request.integration, request.slot) ===
                          record.id,
                    )
                    .flatMap((request) => request.scopes),
                ),
            ),
          ),
        ];
      };

      const statusOf = (record: ConnectionRecord): ConnectionSummary["status"] => {
        if (record.status === "error") return "error";
        if (
          ["vts", "keyboard", "midi", "websocket-client", "websocket-server", "http"].includes(
            record.integration,
          )
        ) {
          return record.status;
        }
        if (record.integration === "twitch") {
          if (record.needsReauth) return "reauth-required";
          const required = scopesRequiredFor(record);
          if (missingScopes(required, record.grantedScopes).length > 0) {
            return "reauth-required";
          }
          if (record.driver !== undefined) {
            return record.status === "connecting" ? "connecting" : "connected";
          }
          if (record.account !== undefined) return "disconnected";
          return requiredFieldsSet(record) ? "disconnected" : "unconfigured";
        }
        if (record.driver !== undefined) {
          return record.status;
        }
        return requiredFieldsSet(record) ? "disconnected" : "unconfigured";
      };

      const summaryOf = (record: ConnectionRecord): ConnectionSummary => {
        const input = Effect.runSync(Ref.get(lastInput));
        const boundBy: Array<{ readonly projectId: string; readonly slot: string }> = [];
        for (const entry of input.known) {
          for (const connection of entry.manifest.connections) {
            const explicit = input.bindings
              ?.get(entry.projectId)
              ?.get(connection.integration + "/" + connection.slot);
            if (explicit === record.id) {
              boundBy.push({ projectId: entry.projectId, slot: connection.slot });
            }
          }
        }
        const required = scopesRequiredFor(record);
        const granted =
          record.integration === "twitch"
            ? record.grantedScopes
            : record.integration === "fake"
              ? ["fake:read", "fake:write", "fake:chat"]
              : record.integration === "websocket-client" ||
                  record.integration === "websocket-server" ||
                  record.integration === "http"
                ? scopesRequiredFor(record)
                : [];
        const missing = missingScopes(required, granted);
        const fields = fieldsFor(record.integration);
        const values: Array<ConnectionValue> = fields.map((field) => {
          if (field.kind === "secret") {
            return {
              key: field.key,
              isSecret: true,
              isSet: (record.secrets[field.key] ?? "").length > 0,
            };
          }
          const value = record.values[field.key];
          return {
            key: field.key,
            ...(value === undefined ? {} : { value }),
            isSecret: false,
            isSet: value !== undefined && value !== "",
          };
        });
        const status = statusOf(record);
        const detail =
          record.detailText ??
          (record.integration === "obs"
            ? record.values["url"]
            : record.integration === "fake"
              ? "In-process test driver"
              : record.integration === "twitch"
                ? `${record.mode}${record.account === undefined ? "" : ` · ${record.account.login}`}`
                : undefined);
        return {
          id: record.id,
          integration: record.integration,
          title: titleOf(record.integration),
          label: record.label,
          location: locationOf(record.integration),
          mode: record.mode,
          status,
          fields,
          values,
          scopes: { granted, required, missing },
          boundBy,
          ...(record.account === undefined ? {} : { account: record.account }),
          ...(detail === undefined ? {} : { detail }),
          ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
          ...(record.nextRetryAt === undefined
            ? {}
            : { nextRetryAt: record.nextRetryAt }),
          ...(record.lastConnectedAt === undefined
            ? {}
            : { lastConnectedAt: record.lastConnectedAt }),
          ...(record.approval === undefined ? {} : { approval: record.approval }),
          requiresAuth:
            record.integration === "twitch" &&
            (record.account === undefined || missing.length > 0 || record.needsReauth),
        };
      };

      const callbackPortEnv = yield* readEnvironment(["BALLAST_TWITCH_CALLBACK_PORT"]);
      const integrations = (): ReadonlyArray<ConnectionIntegration> => {
        const configured = callbackPortEnv["BALLAST_TWITCH_CALLBACK_PORT"];
        const parsed =
          configured === undefined || configured.trim() === ""
            ? DEFAULT_TWITCH_CALLBACK_PORT
            : Number(configured);
        const port =
          Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
            ? parsed
            : DEFAULT_TWITCH_CALLBACK_PORT;
        const redirectUrl = "http://localhost:" + port + "/callback";
        return connectionIntegrations.map((entry) =>
          entry.integration === "twitch" ? { ...entry, redirectUrl } : entry,
        );
      };

      const summaries = (): Effect.Effect<ReadonlyArray<ConnectionSummary>> =>
        Effect.map(records(), (items) => items.map(summaryOf));

      const summary = (id: string): Effect.Effect<ConnectionSummary | undefined> =>
        Effect.map(getRecord(id), (record) =>
          record === undefined ? undefined : summaryOf(record),
        );

      const require = (id: string): Effect.Effect<ConnectionSummary, AgentError> =>
        Effect.gen(function* () {
          const found = yield* summary(id);
          if (found === undefined) {
            return yield* Effect.fail(
              agentError("not-found", `No connection "${id}"`),
            );
          }
          return found;
        });

      const connectionOptions = (record: ConnectionRecord): ConnectionOptions => {
        const primary =
          record.integration === "obs"
            ? record.values["url"]
            : record.integration === "twitch"
              ? record.values["clientId"]
              : record.values["prefix"];
        const secret =
          record.integration === "obs"
            ? record.secrets["password"]
            : record.integration === "twitch"
              ? record.secrets["clientSecret"]
              : undefined;
        const key = record.integration + "/" + record.slot;
        return {
          connections: new Map<string, string>(
            primary === undefined || primary === "" ? [] : [[key, primary]],
          ),
          secrets: new Map<string, string>(
            secret === undefined || secret === "" ? [] : [[key, secret]],
          ),
        };
      };

      const twitchAccountSlots = (
        input: ReconcileInput,
        extra: ReadonlyArray<{
          readonly slot: string;
          readonly identity: TwitchIdentity;
        }> = [],
      ): Effect.Effect<ReadonlyMap<string, string>> =>
        Effect.gen(function* () {
          const map = new Map<string, string>();
          const items = yield* records();
          const entries = [...input.known, ...input.running];
          for (const item of items) {
            if (item.integration !== "twitch") continue;
            const userId = item.identity?.userId ?? item.account?.id;
            if (userId === undefined) continue;
            // Legacy records are named by their slot. Instances are opaque, so
            // resolve the project requirement slots explicitly bound to them.
            map.set(item.slot, userId);
            for (const entry of entries) {
              for (const slot of slotsFor(input, entry, item)) {
                map.set(slot, userId);
              }
            }
          }
          for (const item of extra) map.set(item.slot, item.identity.userId);
          return map;
        });

      const unionSpecs = (
        record: ConnectionRecord,
        input: ReconcileInput,
        accountSlots: ReadonlyMap<string, string>,
      ): Effect.Effect<ReadonlyArray<TwitchSubscriptionSpec>, AgentError> =>
        Effect.gen(function* () {
          const specs: Array<TwitchSubscriptionSpec> = [];
          const seen = new Set<string>();
          for (const entry of input.running) {
            for (const slot of slotsFor(input, entry, record)) {
              const next = yield* subscriptionSpecs(entry.manifest, slot, accountSlots).pipe(
                Effect.mapError((error) => agentError("upstream", error.message)),
              );
              for (const spec of next) {
                const key = subscriptionKey(spec);
                if (seen.has(key)) continue;
                seen.add(key);
                specs.push(spec);
              }
            }
          }
          return specs;
        });

      const refreshTwitchMetadata: Effect.Effect<void> = Effect.gen(function* () {
        const all = yield* records();
        const twitchRecords = all.filter((record) => record.integration === "twitch");
        if (twitchRecords.length === 0) return;
        const cloudStatus = yield* cloud.status;
        const api = yield* cloud.api;
        let cloudConnections:
          | ReadonlyArray<{
              readonly id: string;
              readonly twitchUserId: string;
              readonly login: string;
              readonly displayName: string;
              readonly scopes: ReadonlyArray<string>;
              readonly needsReauth?: boolean;
            }>
          | undefined;
        let cloudError: string | undefined;
        if (cloudStatus.state === "linked" && api !== undefined) {
          const listed = yield* api.listConnections.pipe(
            Effect.map((value) => value),
            Effect.catch((error) => {
              cloudError = error.message;
              return Effect.succeed(undefined);
            }),
          );
          cloudConnections = listed;
        }
        for (const record of twitchRecords) {
          const mode =
            record.mode === "auto"
              ? cloudStatus.state === "linked"
                ? "cloud"
                : "local-app"
              : record.mode;
          if (mode === "cloud") {
            if (cloudConnections === undefined) {
              yield* updateRecord(record.id, (current) => ({
                ...current,
                account: undefined,
                grantedScopes: [],
                needsReauth: false,
                lastError: cloudError ?? "Cloud is not linked",
              }));
              continue;
            }
            const configured = currentValue(record, "connection");
            const matches =
              configured === undefined
                ? cloudConnections
                : cloudConnections.filter(
                    (connection) =>
                      connection.id === configured || connection.login === configured,
                  );
            const connection =
              matches.length === 1
                ? matches[0]
                : configured === undefined && cloudConnections.length === 1
                  ? cloudConnections[0]
                  : undefined;
            if (connection === undefined) {
              yield* updateRecord(record.id, (current) => ({
                ...current,
                account: undefined,
                grantedScopes: [],
                lastError:
                  configured === undefined
                    ? "Choose a cloud Twitch connection for this slot"
                    : `Cloud connection "${configured}" was not found`,
              }));
              continue;
            }
            yield* updateRecord(record.id, (current) => {
              // A re-authorized account has different scopes. Its previous
              // reconcile result no longer applies, so let the next pass
              // recreate the subscriptions instead of keeping the cached key.
              const scopesChanged =
                current.grantedScopes.length !== connection.scopes.length ||
                connection.scopes.some(
                  (scope) => !current.grantedScopes.includes(scope),
                );
              const reauthorized = current.needsReauth && connection.needsReauth !== true;
              return {
                ...current,
                ...(scopesChanged || reauthorized
                  ? { ownerSpecs: new Map(), owners: new Set<string>() }
                  : {}),
                cloudConnectionId: connection.id,
                grantedScopes: connection.scopes,
                needsReauth: connection.needsReauth === true,
                account: {
                  id: connection.twitchUserId,
                  login: connection.login,
                  displayName: connection.displayName,
                },
                lastError:
                  connection.needsReauth === true
                    ? "Twitch requires this account to be reconnected in the Ballast cloud"
                    : undefined,
              };
            });
            continue;
          }
          const stored = yield* provide(readStoredTwitchAccount(record.slot, options.dataDir)).pipe(
            Effect.mapError((cause) => new Error(errorMessage(cause))),
            Effect.catch(() => Effect.succeed(undefined)),
          );
          yield* updateRecord(record.id, (current) => ({
            ...current,
            grantedScopes: stored?.scopes ?? [],
            account:
              stored === undefined
                ? undefined
                : {
                    id: stored.userId,
                    login: stored.login,
                    ...(stored.displayName === undefined
                      ? {}
                      : { displayName: stored.displayName }),
                  },
            needsReauth: false,
          }));
        }
      });

      const startTwitchDriver = (
        record: ConnectionRecord,
        input: ReconcileInput,
        mode: "local-app" | "cloud",
        configKey: string,
      ): Effect.Effect<ConnectionRecord, AgentError> =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const publish = (key: string, payload: unknown): void => {
            const prefix = `${record.integration}/${record.slot}/`;
            const topic = key.startsWith(prefix) ? key.slice(prefix.length) : key;
            Effect.runForkWith(context)(
              router.publishInbound({
                integration: record.integration,
                slot: record.slot,
                topic,
                payload,
                connectionId: record.id,
              }),
            );
            Effect.runForkWith(context)(cloud.noteEvent(Date.now()));
          };

          const started = yield* Effect.gen(function* () {
            if (mode === "local-app") {
              const stored = yield* provide(readStoredTwitchAccount(record.slot, options.dataDir)).pipe(
                Effect.mapError((cause) =>
                  agentError(
                    "internal",
                    `Could not read the Twitch token: ${errorMessage(cause)}`,
                  ),
                ),
              );
              if (stored === undefined) {
                return yield* Effect.fail(
                  agentError(
                    "unauthorized",
                    `Twitch connection ${record.id} has no local account. Run StartConnectionAuth first.`,
                  ),
                );
              }
              const twitchEnv = yield* readEnvironment(twitchEnvKeys(record.slot));
              const resolved = yield* Effect.try({
                try: () =>
                  resolveTwitchAppConfig(record.slot, connectionOptions(record), stored, twitchEnv),
                catch: (cause) =>
                  agentError("invalid", errorMessage(cause)),
              });
              const transport = yield* startLocalTwitchTransport({
                slot: record.slot,
                config: resolved,
                account: stored,
                store: {
                  save: (account) =>
                    provide(writeStoredTwitchAccount(account, options.dataDir)).pipe(
                      Effect.mapError((cause) =>
                        new TwitchTransportError({
                          reason: `Could not store the Twitch token: ${errorMessage(cause)}`,
                        }),
                      ),
                    ),
                },
                publish,
              }).pipe(
                Effect.provideService(Scope.Scope, scope),
                Effect.provide(Layer.merge(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
                Effect.mapError((error) => agentError("upstream", error.message)),
              );
              const identity = yield* transport.getToken.pipe(
                Effect.mapError((error) => agentError("upstream", error.message)),
              );
              const accountSlots = yield* twitchAccountSlots(input, [
                { slot: record.slot, identity },
              ]);
              const specs = yield* unionSpecs(record, input, accountSlots);
              if (specs.length > 0) {
                yield* transport.subscribe(specs).pipe(
                  Effect.mapError((error) => agentError("upstream", error.message)),
                );
              }
              return { transport, identity, api: undefined, cloudConnectionId: undefined, kind: "twitch-local" as const };
            }

            const api = yield* cloud.api;
            const relay = yield* cloud.relay;
            if (api === undefined || relay === undefined) {
              return yield* Effect.fail(
                agentError("invalid", "Twitch cloud mode requires a paired machine"),
              );
            }
            const connections = yield* api.listConnections.pipe(
              Effect.mapError((error) => agentError("upstream", error.message)),
            );
            const configured = currentValue(record, "connection");
            const matches =
              configured === undefined
                ? connections
                : connections.filter(
                    (connection) =>
                      connection.id === configured || connection.login === configured,
                  );
            const connection =
              matches.length === 1
                ? matches[0]
                : configured === undefined && connections.length === 1
                  ? connections[0]
                  : undefined;
            if (connection === undefined) {
              return yield* Effect.fail(
                agentError(
                  "invalid",
                  configured === undefined
                    ? "Choose a cloud Twitch connection for this slot"
                    : `Cloud connection "${configured}" was not found`,
                ),
              );
            }
            const transport = yield* startCloudTwitchTransport({
              slot: record.slot,
              connectionId: connection.id,
              api,
              relay,
              publish,
            }).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError((error) => agentError("upstream", error.message)),
            );
            const identity = yield* transport.getToken.pipe(
              Effect.mapError((error) => agentError("upstream", error.message)),
            );
            return {
              transport,
              identity,
              api,
              cloudConnectionId: connection.id,
              kind: "twitch-cloud" as const,
            };
          }).pipe(
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );

          const driver: DriverState = {
            kind: started.kind,
            scope,
            configKey,
            topicsKey: "",
            obs: undefined,
            twitch: started.transport,
            vts: undefined,
            keyboard: undefined,
            midi: undefined,
            webSocketClient: undefined,
            webSocketServers: new Map(),
            cloudApi: started.api,
            cloudConnectionId: started.cloudConnectionId,
          };
          yield* logs.write({
            level: "info",
            source: "connection",
            message: `${record.id} connected (${mode})`,
          });
          return yield* updateRecord(record.id, (current) => ({
            ...current,
            driver,
            status: "connected",
            lastConnectedAt: Date.now(),
            grantedScopes: started.identity.scopes,
            account: {
              id: started.identity.userId,
              login: started.identity.login,
              ...(started.identity.displayName === undefined
                ? {}
                : { displayName: started.identity.displayName }),
            },
            identity: started.identity,
            cloudConnectionId: started.cloudConnectionId ?? current.cloudConnectionId,
            lastError: undefined,
          }));
        });

      const currentValue = (record: ConnectionRecord, key: string): string | undefined => {
        const value = record.values[key] ?? record.secrets[key];
        return value === undefined || value === "" ? undefined : value;
      };

      const startObs = (
        record: ConnectionRecord,
        input: ReconcileInput,
        configKey: string,
      ): Effect.Effect<ConnectionRecord, AgentError> =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const obsEnv = yield* readEnvironment([obsPasswordEnvKey(record.slot)]);
          const resolved = yield* Effect.try({
            try: () =>
              resolveObsConnectionConfig(
                record.slot,
                connectionOptions(record),
                obsEnv,
              ),
            catch: (cause) => agentError("invalid", errorMessage(cause)),
          });
          const topics = [
            ...new Set(
              input.running.flatMap((entry) => {
                const slots = new Set(slotsFor(input, entry, record));
                return entry.manifest.topics
                  .filter(
                    (topic) =>
                      topic.integration === record.integration && slots.has(topic.slot),
                  )
                  .map((topic) => topic.topic);
              }),
            ),
          ];
          const driver = yield* provide(startObsDriver({
            slot: record.slot,
            url: resolved.url,
            ...(resolved.password === undefined ? {} : { password: resolved.password }),
            topics: topics.map((topic) => {
              const prefix = `${record.integration}/`;
              return topic.startsWith(prefix) ? topic.slice(prefix.length) : topic;
            }),
            publish: (key, payload) => {
              const prefix = `${record.integration}/${record.slot}/`;
              const topic = key.startsWith(prefix) ? key.slice(prefix.length) : key;
              Effect.runForkWith(context)(
                router.publishInbound({
                  integration: record.integration,
                  slot: record.slot,
                  topic,
                  payload,
                  connectionId: record.id,
                }),
              );
            },
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          ));
          const state: DriverState = {
            kind: "obs",
            scope,
            configKey,
            topicsKey: "",
            obs: driver,
            twitch: undefined,
            vts: undefined,
            keyboard: undefined,
            midi: undefined,
            webSocketClient: undefined,
            webSocketServers: new Map(),
            cloudApi: undefined,
            cloudConnectionId: undefined,
          };
          yield* driver.statuses.pipe(
            Stream.runForEach((status) =>
              Effect.gen(function* () {
                const lastError =
                  status._tag === "disconnected"
                    ? status.error +
                      " · retrying at " +
                      new Date(status.retryAt).toLocaleTimeString()
                    : status._tag === "error"
                      ? status.error
                      : undefined;
                yield* updateRecord(record.id, (current) =>
                  current.driver === state
                    ? {
                        ...current,
                        status:
                          status._tag === "connected"
                            ? "connected"
                            : status._tag === "error"
                              ? "error"
                              : status._tag === "disconnected"
                                ? "disconnected"
                                : "connecting",
                        lastError,
                        nextRetryAt:
                          status._tag === "disconnected" ? status.retryAt : undefined,
                        detailText:
                          status._tag === "connected"
                            ? resolved.url
                            : status._tag === "disconnected" || status._tag === "error"
                              ? status.error
                              : current.detailText,
                        ...(status._tag === "connected"
                          ? { lastConnectedAt: Date.now() }
                          : {}),
                      }
                    : current,
                );
                if (status._tag === "connected") {
                  yield* logs.write({
                    level: "info",
                    source: "connection",
                    message: `${record.id} connected (${resolved.url})`,
                  });
                }
                if (status._tag === "error") {
                  yield* logs.write({
                    level: "error",
                    source: "connection",
                    message: `${record.id}: ${status.error}`,
                  });
                }
              }),
            ),
            Effect.forkIn(scope),
          );
          return yield* updateRecord(record.id, (current) => ({
            ...current,
            driver: state,
            status: "connecting",
            lastError: undefined,
            nextRetryAt: undefined,
          }));
        });

      const startFake = (
        record: ConnectionRecord,
        configKey: string,
      ): Effect.Effect<ConnectionRecord> =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const publish = (key: string, payload: unknown): void => {
            const prefix = `${record.integration}/${record.slot}/`;
            const topic = key.startsWith(prefix) ? key.slice(prefix.length) : key;
            Effect.runForkWith(context)(
              router.publishInbound({
                integration: record.integration,
                slot: record.slot,
                topic,
                payload,
                connectionId: record.id,
              }),
            );
          };
          yield* Effect.gen(function* () {
            let tick = 0;
            yield* Effect.forever(
              Effect.gen(function* () {
                yield* Effect.sleep("1 second");
                tick += 1;
                publish(`${record.integration}/${record.slot}/fake/tick`, { n: tick });
              }),
            );
          }).pipe(Effect.forkIn(scope));
          yield* Effect.gen(function* () {
            let chat = 0;
            yield* Effect.forever(
              Effect.gen(function* () {
                yield* Effect.sleep("3 seconds");
                chat += 1;
                publish(`${record.integration}/${record.slot}/fake/chat`, {
                  text: `hello chat ${chat}`,
                });
              }),
            );
          }).pipe(Effect.forkIn(scope));
          const state: DriverState = {
            kind: "fake",
            scope,
            configKey,
            topicsKey: "",
            obs: undefined,
            twitch: undefined,
            vts: undefined,
            keyboard: undefined,
            midi: undefined,
            webSocketClient: undefined,
            webSocketServers: new Map(),
            cloudApi: undefined,
            cloudConnectionId: undefined,
          };
          return yield* updateRecord(record.id, (current) => ({
            ...current,
            driver: state,
            status: "connected",
            lastConnectedAt: Date.now(),
            lastError: undefined,
          }));
        });

      const topicsFor = (record: ConnectionRecord, input: ReconcileInput) =>
        input.running.flatMap((entry) => {
          const slots = new Set(slotsFor(input, entry, record));
          return entry.manifest.topics.filter(
            (topic) => topic.integration === record.integration && slots.has(topic.slot),
          );
        });

      const scopesFor = (record: ConnectionRecord, input: ReconcileInput): ReadonlyArray<string> =>
        [
          ...new Set(
            input.running.flatMap((entry) => {
              const slots = new Set(slotsFor(input, entry, record));
              return entry.manifest.topics
                .filter(
                  (topic) =>
                    topic.integration === record.integration && slots.has(topic.slot),
                )
                .flatMap((topic) => topic.scopes)
                .concat(
                  entry.manifest.requests
                    .filter(
                      (request) =>
                        request.integration === record.integration &&
                        slots.has(request.slot),
                    )
                    .flatMap((request) => request.scopes),
                );
            }),
          ),
        ];

      const numberOf = (raw: string | undefined): number | undefined => {
        if (raw === undefined || raw.trim() === "") return undefined;
        const value = Number(raw);
        return Number.isInteger(value) ? value : undefined;
      };

      const publishFor = (record: ConnectionRecord) => (key: string, payload: unknown): void => {
        const prefix = `${record.integration}/${record.slot}/`;
        const topic = key.startsWith(prefix) ? key.slice(prefix.length) : key;
        Effect.runForkWith(context)(
          router.publishInbound({
            integration: record.integration,
            slot: record.slot,
            topic,
            payload,
            connectionId: record.id,
            key,
          }),
        );
      };

      const stableHookId = (slot: string): Effect.Effect<string> =>
        sha256(new TextEncoder().encode("ballast-http-webhook:" + slot)).pipe(
          Effect.map((digest) => Base64Url.encode(digest).slice(0, 32)),
        );

      const startVts = (
        record: ConnectionRecord,
        input: ReconcileInput,
        configKey: string,
        topicsKey: string,
      ): Effect.Effect<ConnectionRecord, AgentError> =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const topics = topicsFor(record, input);
          const subscriptions: ReadonlyArray<VTubeStudioSubscription> = topics.map((topic) => ({
            topic: topic.topic,
            ...(topic.condition === undefined ? {} : { condition: topic.condition }),
          }));
          const layer = VTubeStudioDriver.layer({
            slot: record.slot,
            dataDir: options.dataDir,
            subscriptions,
            ...(record.values["url"] === undefined ? {} : { url: record.values["url"] }),
            ...(record.values["pluginName"] === undefined
              ? {}
              : { pluginName: record.values["pluginName"] }),
            ...(record.values["pluginDeveloper"] === undefined
              ? {}
              : { pluginDeveloper: record.values["pluginDeveloper"] }),
            ...(record.values["pluginIcon"] === undefined
              ? {}
              : { pluginIcon: record.values["pluginIcon"] }),
            publish: publishFor(record),
          }).pipe(
            Layer.provide(NodeWS.layerWebSocketConstructor),
            Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
            Layer.provide(Layer.succeed(Path.Path, path)),
            Layer.provide(Layer.succeed(SecureRandom.SecureRandom, crypto)),
          );
          const built = yield* Layer.buildWithScope(layer, scope).pipe(
            Effect.mapError((error) => agentError("invalid", error.message)),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          const driver = Context.get(built, VTubeStudioDriver);
          const state: DriverState = {
            kind: "vts",
            scope,
            configKey,
            topicsKey,
            obs: undefined,
            twitch: undefined,
            vts: driver,
            keyboard: undefined,
            midi: undefined,
            webSocketClient: undefined,
            webSocketServers: new Map(),
            cloudApi: undefined,
            cloudConnectionId: undefined,
          };
          yield* driver.statusChanges.pipe(
            Stream.runForEach((status) => {
              const mapped: ConnectionSummary["status"] =
                status.state === "connected"
                  ? "connected"
                  : status.state === "error"
                    ? "error"
                    : status.state === "disconnected"
                      ? "disconnected"
                      : "connecting";
              const approval: ConnectionApproval | undefined =
                status.state === "waiting-for-approval"
                  ? {
                      kind: "vtuber-studio",
                      ...(status.message === undefined ? {} : { message: status.message }),
                    }
                  : undefined;
              return updateRecord(record.id, (current) => ({
                ...current,
                status: mapped,
                needsReauth: false,
                approval,
                lastError: status.message,
                detailText:
                  status.state === "connected"
                    ? `VTube Studio${status.vTubeStudioVersion === undefined ? "" : " " + status.vTubeStudioVersion}`
                    : status.message,
                ...(status.state === "connected"
                  ? { lastConnectedAt: status.lastConnectedAt ?? Date.now() }
                  : {}),
              }));
            }),
            Effect.forkIn(scope),
          );
          yield* logs.write({
            level: "info",
            source: "connection",
            message: `${record.id} VTube Studio driver started (${driver.url})`,
          });
          return yield* updateRecord(record.id, (current) => ({
            ...current,
            driver: state,
            status: "connecting",
            lastError: undefined,
          }));
        });

      const startKeyboard = (
        record: ConnectionRecord,
        input: ReconcileInput,
        configKey: string,
        topicsKey: string,
      ): Effect.Effect<ConnectionRecord, AgentError> =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const built = yield* Layer.buildWithScope(options.keyboardLayer ?? keyboardLayer, scope).pipe(
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          const driver = Context.get(built, KeyboardDriver);
          const reported = (yield* Ref.get(shellPermissions)).accessibility;
          const configured = record.values["permission"];
          const permission: PermissionStatus | undefined =
            reported === "unknown"
              ? configured === "granted" || configured === "denied" || configured === "unknown"
                ? configured
                : undefined
              : reported;
          yield* driver
            .connect({
              slot: record.slot,
              topics: topicsFor(record, input).map((topic) => ({
                topic: topic.topic,
                ...(topic.condition === undefined ? {} : { condition: topic.condition }),
              })),
              ...(permission === undefined ? {} : { permission }),
            })
            .pipe(Effect.mapError((error) => agentError("upstream", error.message)));
          const state: DriverState = {
            kind: "keyboard",
            scope,
            configKey,
            topicsKey,
            obs: undefined,
            twitch: undefined,
            vts: undefined,
            keyboard: driver,
            midi: undefined,
            webSocketClient: undefined,
            webSocketServers: new Map(),
            cloudApi: undefined,
            cloudConnectionId: undefined,
          };
          yield* driver.events.pipe(
            Stream.runForEach((event) =>
              router.publishInbound({
                integration: "keyboard",
                slot: record.slot,
                topic: event.topic,
                payload: event.payload,
                connectionId: record.id,
                key: event.key,
              }),
            ),
            Effect.forkIn(scope),
          );
          yield* driver.status.pipe(
            Effect.flatMap((status) => {
              const mapped: ConnectionSummary["status"] =
                status.state === "listening"
                  ? "connected"
                  : status.state === "error"
                    ? "error"
                    : status.state === "disconnected"
                      ? "disconnected"
                      : "connecting";
              const permission = "permission" in status ? status.permission : undefined;
              const approval: ConnectionApproval | undefined =
                status.platform === "darwin" &&
                permission !== undefined &&
                permission !== "granted"
                  ? {
                      kind: "accessibility",
                      status: permission,
                      ...("hint" in status && status.hint !== undefined
                        ? { message: status.hint }
                        : {}),
                    }
                  : undefined;
              return updateRecord(record.id, (current) => ({
                ...current,
                status: mapped,
                approval,
                lastError: status.state === "listening" ? undefined : ("message" in status ? status.message : undefined),
                detailText: status.state === "listening" ? (status.hint ?? `Keyboard ${status.platform}`) : ("message" in status ? ("hint" in status ? (status.hint ?? status.message) : status.message) : undefined),
                ...(status.state === "listening" ? { lastConnectedAt: Date.now() } : {}),
              }));
            }),
          );
          yield* logs.write({
            level: "info",
            source: "connection",
            message: `${record.id} keyboard hook listening`,
          });
          return yield* updateRecord(record.id, (current) => ({
            ...current,
            driver: state,
            status: "connected",
            lastConnectedAt: Date.now(),
            lastError: undefined,
          }));
        });

      const startMidi = (
        record: ConnectionRecord,
        input: ReconcileInput,
        configKey: string,
        topicsKey: string,
      ): Effect.Effect<ConnectionRecord, AgentError> =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const built = yield* Layer.buildWithScope(options.midiLayer ?? midiLayer, scope).pipe(
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          const driver = Context.get(built, MidiDriver);
          yield* driver
            .connect({
              slot: record.slot,
              topics: topicsFor(record, input).map((topic) => ({
                topic: topic.topic,
                ...(topic.condition === undefined ? {} : { condition: topic.condition }),
              })),
              ...(record.values["input"] === undefined
                ? {}
                : { input: record.values["input"] }),
              ...(record.values["output"] === undefined
                ? {}
                : { output: record.values["output"] }),
            })
            .pipe(Effect.mapError((error) => agentError("upstream", error.message)));
          const state: DriverState = {
            kind: "midi",
            scope,
            configKey,
            topicsKey,
            obs: undefined,
            twitch: undefined,
            vts: undefined,
            keyboard: undefined,
            midi: driver,
            webSocketClient: undefined,
            webSocketServers: new Map(),
            cloudApi: undefined,
            cloudConnectionId: undefined,
          };
          yield* driver.events.pipe(
            Stream.runForEach((event) =>
              router.publishInbound({
                integration: "midi",
                slot: record.slot,
                topic: event.topic,
                payload: event.payload,
                connectionId: record.id,
                key: event.key,
              }),
            ),
            Effect.forkIn(scope),
          );
          yield* driver.status.pipe(
            Effect.flatMap((status) =>
              updateRecord(record.id, (current) => ({
                ...current,
                status:
                  status.state === "connected"
                    ? "connected"
                    : status.state === "error"
                      ? "error"
                      : status.state === "disconnected"
                        ? "disconnected"
                        : "connecting",
                lastError: status.state === "error" ? status.message : undefined,
                detailText:
                  status.state === "connected"
                    ? `MIDI ${status.input ?? "(no input)"} -> ${status.output ?? "(no output)"}`
                    : status.state === "error"
                      ? status.message
                      : undefined,
                ...(status.state === "connected" ? { lastConnectedAt: Date.now() } : {}),
              })),
            ),
          );
          return yield* updateRecord(record.id, (current) => ({
            ...current,
            driver: state,
            status: "connected",
            lastConnectedAt: Date.now(),
            lastError: undefined,
          }));
        });

      const webSocketAllowed = (
        record: ConnectionRecord,
        input: ReconcileInput,
        scope: string,
      ): boolean => {
        const scopes = scopesFor(record, input);
        if (scopes.length === 0) return true;
        return scopes.includes("ws:connect:*") || scopes.includes("ws:listen:*") || scopes.includes(scope);
      };

      interface WebSocketServerListen {
        readonly slot: string;
        readonly host: string;
        readonly port: number;
        readonly path: string | undefined;
        readonly scope: string;
      }

      const parseListenScope = (
        scope: string,
      ): { host: string; port: number; path?: string } | undefined => {
        const match = /^ws:listen:([^:]+):(\d+)(\/.*)?$/.exec(scope);
        if (match === null) return undefined;
        const port = Number(match[2]);
        if (!Number.isInteger(port)) return undefined;
        const path = match[3];
        return {
          host: match[1] ?? "127.0.0.1",
          port,
          ...(path === undefined || path === "" ? {} : { path }),
        };
      };

      /**
       * One entry per bound slot that declares a WebSocket server. A slot's
       * declared `ws:listen:` scope wins; the connection's port setting is the
       * fallback for a script that declared only `ws:listen:*`. Slots that
       * share an address share one listener.
       */
      const webSocketServerListens = (
        record: ConnectionRecord,
        input: ReconcileInput,
      ): {
        readonly listens: ReadonlyArray<WebSocketServerListen>;
        readonly missing: ReadonlyArray<string>;
      } => {
        const configuredPort = numberOf(record.values["port"]);
        const listens: WebSocketServerListen[] = [];
        const missing: string[] = [];
        for (const entry of input.running) {
          for (const slot of new Set(slotsFor(input, entry, record))) {
            const declared = entry.manifest.requests
              .filter(
                (request) =>
                  request.integration === record.integration &&
                  request.slot === slot &&
                  request.request === "websocket/listen",
              )
              .flatMap((request) =>
                request.scopes.flatMap((scope) => {
                  const parsed = parseListenScope(scope);
                  return parsed === undefined
                    ? []
                    : [
                        {
                          slot,
                          host: parsed.host,
                          port: parsed.port,
                          path: parsed.path,
                          scope,
                        },
                      ];
                }),
              );
            if (declared.length > 0) {
              listens.push(...declared);
              continue;
            }
            if (configuredPort === undefined) {
              missing.push(slot);
              continue;
            }
            listens.push({
              slot,
              host: "127.0.0.1",
              port: configuredPort,
              path: undefined,
              scope: "ws:listen:127.0.0.1:" + String(configuredPort),
            });
          }
        }
        return { listens, missing };
      };

      const startWebSocket = (
        record: ConnectionRecord,
        input: ReconcileInput,
        configKey: string,
        topicsKey: string,
      ): Effect.Effect<ConnectionRecord, AgentError> =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          if (record.integration === "websocket-client") {
            const url = record.values["url"];
            if (url === undefined || url === "") {
              return yield* Effect.fail(
                agentError("invalid", `WebSocket ${record.id} needs a client URL in connection settings`),
              );
            }
            if (!webSocketAllowed(record, input, `ws:connect:${new URL(url).host}`)) {
              return yield* Effect.fail(
                agentError(
                  "unauthorized",
                  `No running script allows ${record.id} to connect to ${url}`,
                ),
              );
            }
            const connection = yield* webSocketClientDriver
              .connect({ slot: record.slot, url })
              .pipe(
                Effect.provideService(Scope.Scope, scope),
                Effect.mapError((error) => agentError("upstream", error.reason)),
              );
            const state: DriverState = {
              kind: "websocket-client",
              scope,
              configKey,
              topicsKey,
              obs: undefined,
              twitch: undefined,
              vts: undefined,
              keyboard: undefined,
              midi: undefined,
              webSocketClient: connection,
              webSocketServers: new Map(),
              cloudApi: undefined,
              cloudConnectionId: undefined,
            };
            yield* connection.events.pipe(
              Stream.runForEach((event) => {
                if (event._tag === "open") {
                  return router.publishInbound({
                    integration: record.integration,
                    slot: record.slot,
                    topic: "websocket/open",
                    payload: event.open,
                    connectionId: record.id,
                  });
                }
                if (event._tag === "close") {
                  return router.publishInbound({
                    integration: record.integration,
                    slot: record.slot,
                    topic: "websocket/close",
                    payload: event.close,
                    connectionId: record.id,
                  });
                }
                return router.publishInbound({
                  integration: record.integration,
                  slot: record.slot,
                  topic: "websocket/message",
                  payload: event.message,
                  connectionId: record.id,
                });
              }),
              Effect.forkIn(scope),
            );
            yield* connection.statusChanges.pipe(
              Stream.runForEach((status) =>
                updateRecord(record.id, (current) => ({
                  ...current,
                  status:
                    status === "open"
                      ? "connected"
                      : status === "error"
                        ? "error"
                        : status === "closed"
                          ? "disconnected"
                          : "connecting",
                  detailText: status,
                  ...(status === "open"
                    ? { lastConnectedAt: Date.now(), lastError: undefined }
                    : {}),
                })),
              ),
              Effect.forkIn(scope),
            );
            return yield* updateRecord(record.id, (current) => ({
              ...current,
              driver: state,
              status: "connecting",
              lastError: undefined,
            }));
          }

          const { listens, missing } = webSocketServerListens(record, input);
          if (missing.length > 0) {
            return yield* Effect.fail(
              agentError(
                "invalid",
                `WebSocket ${record.id} needs a port for ${missing.join(", ")}: declare one in the script or set one in connection settings`,
              ),
            );
          }
          if (listens.length === 0) {
            // Manually connected with nothing bound: there is nothing to listen
            // for yet; wait quietly for a script instead of reporting an error.
            if (!input.running.some((entry) => usesConnection(input, entry, record))) {
              return yield* updateRecord(record.id, (current) => ({
                ...current,
                driver: undefined,
                status: "disconnected",
                lastError: undefined,
                nextRetryAt: undefined,
                detailText: undefined,
              }));
            }
            return yield* Effect.fail(
              agentError(
                "invalid",
                `WebSocket ${record.id} has no running script listening on a port`,
              ),
            );
          }

          // Slots that declare the same address share one listener; a slot with
          // its own declared port gets its own.
          const grouped = new Map<
            string,
            { listen: WebSocketServerListen; slots: ReadonlyArray<string> }
          >();
          for (const listen of listens) {
            const key = `${listen.host}:${listen.port}${listen.path ?? ""}`;
            const existing = grouped.get(key);
            if (existing === undefined) {
              grouped.set(key, { listen, slots: [listen.slot] });
            } else if (!existing.slots.includes(listen.slot)) {
              grouped.set(key, { ...existing, slots: [...existing.slots, listen.slot] });
            }
          }

          const servers = new Map<string, WebSocketServerConnection>();
          const addresses: string[] = [];
          const running = yield* Ref.make(new Set<string>());
          yield* Effect.gen(function* () {
            for (const group of grouped.values()) {
              const { listen } = group;
              if (!webSocketAllowed(record, input, listen.scope)) {
                return yield* Effect.fail(
                  agentError(
                    "unauthorized",
                    `No running script allows ${record.id} to listen on ${listen.host}:${listen.port}${listen.path ?? ""}`,
                  ),
                );
              }
              const connection = yield* webSocketServerDriver
                .listen({
                  slot: record.slot,
                  host: listen.host,
                  port: listen.port,
                  ...(listen.path === undefined ? {} : { path: listen.path }),
                })
                .pipe(
                  Effect.provideService(Scope.Scope, scope),
                  Effect.mapError((error) => agentError("upstream", error.reason)),
                );
              for (const slot of group.slots) servers.set(slot, connection);
              const address = `${listen.host}:${connection.address.port}${listen.path ?? ""}`;
              addresses.push(address);
              yield* Ref.update(running, (current) => new Set(current).add(address));
              const owner = group.slots[0] ?? record.slot;
              yield* connection.events.pipe(
                Stream.runForEach((event) => {
                  if (event._tag === "client_connected") {
                    return router.publishInbound({
                      integration: record.integration,
                      slot: owner,
                      topic: "websocket/server/client.connected",
                      payload: event.client,
                      connectionId: record.id,
                    });
                  }
                  if (event._tag === "client_disconnected") {
                    return router.publishInbound({
                      integration: record.integration,
                      slot: owner,
                      topic: "websocket/server/client.disconnected",
                      payload: event.client,
                      connectionId: record.id,
                    });
                  }
                  return router.publishInbound({
                    integration: record.integration,
                    slot: owner,
                    topic: "websocket/server/message",
                    payload: event.message,
                    connectionId: record.id,
                  });
                }),
                Effect.forkIn(scope),
              );
              yield* connection.statusChanges.pipe(
                Stream.runForEach((status) => {
                  if (status !== "closed") return Effect.void;
                  return Effect.gen(function* () {
                    const remaining = yield* Ref.modify(running, (current) => {
                      const next = new Set(current);
                      next.delete(address);
                      return [next, next];
                    });
                    if (remaining.size > 0) return;
                    yield* updateRecord(record.id, (current) => ({
                      ...current,
                      status: "disconnected",
                      lastError: "WebSocket listeners closed",
                      detailText: addresses.join(", "),
                    }));
                  });
                }),
                Effect.forkIn(scope),
              );
            }
          }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));

          const state: DriverState = {
            kind: "websocket-server",
            scope,
            configKey,
            topicsKey,
            obs: undefined,
            twitch: undefined,
            vts: undefined,
            keyboard: undefined,
            midi: undefined,
            webSocketClient: undefined,
            webSocketServers: servers,
            cloudApi: undefined,
            cloudConnectionId: undefined,
          };
          return yield* updateRecord(record.id, (current) => ({
            ...current,
            driver: state,
            status: "connected",
            lastConnectedAt: Date.now(),
            detailText: addresses.join(", "),
            lastError: undefined,
            nextRetryAt: undefined,
          }));
        });

      const markDriverError = (
        record: ConnectionRecord,
        error: AgentError,
      ): Effect.Effect<ConnectionRecord> =>
        updateRecord(record.id, (current) => ({
          ...current,
          status: "error",
          lastError: error.message,
          detailText: error.message,
        })).pipe(
          Effect.andThen(
            logs.write({
              level: "warn",
              source: "connection",
              message: `${record.id}: ${error.message}`,
            }),
          ),
          Effect.as(record),
        );

      const httpWebhookDefinitions = (
        input: ReconcileInput,
      ): Effect.Effect<ReadonlyArray<WebhookDefinition>, AgentError> =>
        Effect.gen(function* () {
          const definitions = new Map<string, WebhookDefinition>();
          for (const entry of input.running) {
            const topics = entry.manifest.topics.filter(
              (topic) => topic.integration === "http" && topic.topic === "http/webhook",
            );
            for (const topic of topics) {
              const instanceId = boundIdFor(input, entry, topic.integration, topic.slot);
              if (instanceId === undefined) continue;
              const record = yield* getRecord(instanceId);
              if (record === undefined) continue;
              const definitionKey = record.id + ":" + topic.slot;
              if (definitions.has(definitionKey)) continue;
              const values = record.values;
              const transport = values["webhookTransport"] === "cloud" ? "cloud" : "local";
              const verificationType = values["webhookVerification"];
              const secret = record.secrets["webhookSecret"];
              const header = values["webhookHeader"];
              const toleranceSeconds = numberOf(values["webhookTolerance"]);
              const verification =
                secret === undefined || secret === "" || header === undefined || header === ""
                  ? undefined
                  : verificationType === "hmac-sha256"
                    ? {
                        type: "hmac-sha256" as const,
                        header,
                        secret,
                        encoding: "hex" as const,
                        ...(values["webhookTimestampHeader"] === undefined
                          ? {}
                          : { timestampHeader: values["webhookTimestampHeader"] }),
                        ...(toleranceSeconds === undefined ? {} : { toleranceSeconds }),
                      }
                    : verificationType === "shared-secret"
                      ? { type: "shared-secret" as const, header, secret }
                      : undefined;
              const responseStatus = numberOf(values["webhookResponseStatus"]);
              const response =
                responseStatus === undefined && values["webhookResponseBody"] === undefined
                  ? undefined
                  : {
                      ...(responseStatus === undefined ? {} : { status: responseStatus }),
                      ...(values["webhookResponseBody"] === undefined
                        ? {}
                        : { body: values["webhookResponseBody"] }),
                    };
              const hookId =
                values["webhookHookId"] ??
                (yield* stableHookId(record.id + ":" + topic.slot));
              const maxAgeMs = numberOf(values["webhookMaxAgeMs"]) ?? topic.maxAgeMs;
              definitions.set(definitionKey, {
                slot: record.id,
                hookId,
                transport,
                ...(verification === undefined ? {} : { verification }),
                ...(response === undefined ? {} : { response }),
                ...(transport === "local"
                  ? {
                      local: {
                        host: values["webhookHost"] ?? "127.0.0.1",
                        port: numberOf(values["webhookPort"]) ?? 8787,
                        path: values["webhookPath"] ?? `/hooks/${topic.slot}`,
                        // Definition slot is the instance id for status/routing;
                        // keep the user-facing path on the project slot.
                      },
                    }
                  : {
                      cloud: {
                        ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
                        onStale: values["webhookOnStale"] === "deliver" ? "deliver" : topic.onStale,
                      },
                    }),
              });
            }
          }
          return [...definitions.values()];
        });

      const ensureWebhooks = (input: ReconcileInput): Effect.Effect<void> =>
        Effect.gen(function* () {
          const definitions = yield* httpWebhookDefinitions(input);
          const key = JSON.stringify(definitions);
          const current = yield* Ref.get(webhookRuntime);
          if (definitions.length === 0) {
            if (current !== undefined) {
              yield* Ref.set(webhookRuntime, undefined);
              yield* Scope.close(current.scope, Exit.void);
            }
            return;
          }
          if (current !== undefined && current.key === key) return;
          if (current !== undefined) {
            yield* Ref.set(webhookRuntime, undefined);
            yield* Scope.close(current.scope, Exit.void);
          }
          const scope = yield* Scope.make();
          const started = yield* webhookDriver.start(definitions).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError((error) => error.reason),
            Effect.exit,
          );
          if (Exit.isFailure(started)) {
            const message = Cause.squash(started.cause);
            const reason = message instanceof Error ? message.message : String(message);
            yield* Scope.close(scope, Exit.void);
            yield* logs.write({
              level: "error",
              source: "connection",
              message: `http webhooks failed: ${reason}`,
            });
            for (const definition of definitions) {
              yield* updateRecord(definition.slot, (record) => ({
                ...record,
                status: "error",
                lastError: reason,
                detailText: reason,
              }));
            }
            return;
          }
          const runtime = started.value;
          yield* Ref.set(webhookRuntime, { key, scope, runtime });
          yield* Stream.runForEach(runtime.deliveries, (delivery) =>
            router.publishInbound({
              integration: "http",
              slot: delivery.hook,
              topic: "http/webhook",
              payload: delivery,
              connectionId: delivery.hook,
            }),
          ).pipe(Effect.forkIn(scope));
          const statuses = yield* runtime.statuses;
          for (const status of statuses) {
            yield* updateRecord(status.slot, (record) => ({
              ...record,
              status:
                status.status === "error"
                  ? "error"
                  : status.status === "listening" || status.status === "registered"
                    ? "connected"
                    : "connecting",
              lastError: status.error,
              detailText: status.url ?? status.address ?? status.error,
              ...(status.status === "listening" || status.status === "registered"
                ? { lastConnectedAt: Date.now() }
                : {}),
            }));
          }
          yield* logs.write({
            level: "info",
            source: "connection",
            message: `http webhooks started (${definitions.length} hook${definitions.length === 1 ? "" : "s"})`,
          });
        }).pipe(Effect.catchCause((cause) =>
          logs.write({
            level: "error",
            source: "connection",
            message: `http webhook reconcile failed: ${Cause.pretty(cause)}`,
          }),
        ));

      const ensureDriver = (record: ConnectionRecord): Effect.Effect<ConnectionRecord> =>
        Effect.gen(function* () {
          const input = yield* Ref.get(lastInput);
          const scheduled = (yield* Ref.get(retries)).get(record.id);
          if (
            record.driver === undefined &&
            scheduled !== undefined &&
            scheduled.nextAt > Date.now()
          ) {
            return record;
          }
          const uses = input.running.filter((entry) => usesConnection(input, entry, record));
          const active = !record.disabled && (uses.length > 0 || record.manual);
          const cloudStatus = yield* cloud.status;
          const mode =
            record.mode === "auto"
              ? cloudStatus.state === "linked"
                ? "cloud"
                : "local-app"
              : record.mode;
          const topicEntries = topicsFor(record, input).map((topic) => ({
            topic: topic.topic,
            ...(topic.condition === undefined ? {} : { condition: topic.condition }),
            scopes: topic.scopes,
            onStale: topic.onStale,
            maxAgeMs: topic.maxAgeMs,
          }));
          const topicsKey = JSON.stringify(topicEntries);
          const shellPermission = (yield* Ref.get(shellPermissions)).accessibility;
          const configKey = JSON.stringify({
            active,
            mode,
            ...(record.integration === "websocket-server"
              ? { listens: webSocketServerListens(record, input) }
              : {}),
            ...(record.integration === "vts" ? {} : { topics: topicEntries }),
            values: record.values,
            secrets: Object.keys(record.secrets).sort(),
            cloud: cloudStatus.state,
            ...(record.integration === "keyboard" ? { permission: shellPermission } : {}),
          });

          if (!active) {
            const driver = record.driver;
            if (
              driver?.kind === "twitch-cloud" &&
              driver.cloudApi !== undefined &&
              driver.cloudConnectionId !== undefined
            ) {
              for (const owner of record.owners) {
                yield* driver.cloudApi
                  .reconcile(driver.cloudConnectionId, [], owner)
                  .pipe(
                    Effect.catch((error) =>
                      logs.write({
                        level: "warn",
                        source: "connection",
                        message: `${record.id}: could not clear subscriptions for ${owner}: ${error.message}`,
                      }),
                    ),
                  );
              }
            }
            if (record.driver !== undefined) yield* closeDriver(record);
            const current = yield* getRecord(record.id);
            if (current === undefined) return record;
            return yield* updateRecord(record.id, (value) => ({
              ...value,
              status: requiredFieldsSet(value) ? "disconnected" : "unconfigured",
            }));
          }
          if (record.driver !== undefined && record.driver.configKey === configKey) {
            if (
              record.integration === "vts" &&
              record.driver.vts !== undefined &&
              record.driver.topicsKey !== topicsKey
            ) {
              yield* record.driver.vts
                .setTopics(
                  topicsFor(record, input).map((topic) => ({
                    topic: topic.topic,
                    ...(topic.condition === undefined ? {} : { condition: topic.condition }),
                  })),
                )
                .pipe(
                  Effect.catch((error) =>
                    logs.write({
                      level: "warn",
                      source: "connection",
                      message: `${record.id}: could not update VTube Studio topics: ${error.message}`,
                    }),
                  ),
                );
              yield* updateRecord(record.id, (current) => ({
                ...current,
                driver:
                  current.driver === undefined
                    ? undefined
                    : { ...current.driver, topicsKey },
              }));
            }
            return record;
          }
          if (record.driver !== undefined) yield* closeDriver(record);
          if (record.integration === "twitch" && record.needsReauth) {
            return yield* updateRecord(record.id, (current) => ({
              ...current,
              status: "reauth-required",
              lastError:
                current.lastError ??
                "Twitch requires this account to be reconnected before it can run",
            }));
          }
          if (!requiredFieldsSet(record, mode)) {
            return yield* updateRecord(record.id, (current) => ({
              ...current,
              status: "unconfigured",
              lastError: "Connection settings are incomplete",
            }));
          }
          if (record.integration === "obs") {
            return yield* startObs(record, input, configKey).pipe(
              Effect.catch((error) =>
                updateRecord(record.id, (current) => ({
                  ...current,
                  status: "error",
                  lastError: error.message,
                })).pipe(
                  Effect.andThen(
                    logs.write({
                      level: "error",
                      source: "connection",
                      message: `${record.id}: ${error.message}`,
                    }),
                  ),
                  Effect.as(record),
                ),
              ),
            );
          }
          if (record.integration === "fake") {
            return yield* startFake(record, configKey);
          }
          if (record.integration === "vts") {
            return yield* startVts(record, input, configKey, topicsKey).pipe(
              Effect.catch((error) => markDriverError(record, error)),
            );
          }
          if (record.integration === "keyboard") {
            return yield* startKeyboard(record, input, configKey, topicsKey).pipe(
              Effect.catch((error) => markDriverError(record, error)),
            );
          }
          if (record.integration === "midi") {
            return yield* startMidi(record, input, configKey, topicsKey).pipe(
              Effect.catch((error) => markDriverError(record, error)),
            );
          }
          if (
            record.integration === "websocket-client" ||
            record.integration === "websocket-server"
          ) {
            return yield* startWebSocket(record, input, configKey, topicsKey).pipe(
              Effect.catch((error) => markDriverError(record, error)),
            );
          }
          if (record.integration === "http") {
            const hasWebhook = topicsFor(record, input).some(
              (topic) => topic.topic === "http/webhook",
            );
            return yield* updateRecord(record.id, (current) => ({
              ...current,
              status: hasWebhook
                ? "connected"
                : requiredFieldsSet(current)
                  ? "disconnected"
                  : "unconfigured",
              ...(hasWebhook ? { lastError: undefined } : {}),
              detailText: hasWebhook
                ? (current.detailText ?? "Webhook listener")
                : undefined,
            }));
          }
          if (record.integration === "twitch") {
            return yield* startTwitchDriver(record, input, mode, configKey).pipe(
              Effect.catch((error) =>
                updateRecord(record.id, (current) => ({
                  ...current,
                  status: "error",
                  lastError: error.message,
                  needsReauth:
                    error.tag === "unauthorized" || current.needsReauth,
                })).pipe(
                  Effect.andThen(
                    logs.write({
                      level: "warn",
                      source: "connection",
                      message: `${record.id}: ${error.message}`,
                    }),
                  ),
                  Effect.as(record),
                ),
              ),
            );
          }
          return record;
        });

      const reconcileTwitchOwners = (input: ReconcileInput): Effect.Effect<void> =>
        Effect.gen(function* () {
          const all = yield* records();
          const twitchCloud = all.filter(
            (record) => record.driver?.kind === "twitch-cloud",
          );
          if (twitchCloud.length === 0) return;
          const accountSlots = yield* twitchAccountSlots(input);
          for (const record of twitchCloud) {
            const driver = record.driver;
            if (driver?.cloudApi === undefined || driver.cloudConnectionId === undefined) {
              continue;
            }
            const uses = input.running.filter((entry) => usesConnection(input, entry, record));
            const owners = new Map<string, string>();
            for (const use of uses) {
              for (const slot of slotsFor(input, use, record)) {
              const owner = `${use.projectId}/${slot}`;
              const specs = yield* subscriptionSpecs(
                use.manifest,
                slot,
                accountSlots,
              ).pipe(
                Effect.catch((error) => {
                  return Effect.gen(function* () {
                    yield* logs.write({
                      level: "warn",
                      source: "connection",
                      message: `${record.id}: ${error.message}`,
                    });
                    return [];
                  });
                }),
              );
              const key = specs
                .map(subscriptionKey)
                .sort()
                .join("|");
              owners.set(owner, key);
              if (record.ownerSpecs.get(owner) === key) continue;
              yield* driver.cloudApi
                .reconcile(driver.cloudConnectionId, specs, owner)
                .pipe(
                  Effect.retry({
                    while: (error: TwitchTransportError) => error.tag === "rate_limited",
                    times: 3,
                    schedule: Schedule.exponential("500 millis"),
                  }),
                  Effect.catch((error) => {
                    return Effect.gen(function* () {
                      const rateLimited = error.tag === "rate_limited";
                      yield* logs.write({
                        level: rateLimited ? "warn" : "error",
                        source: "connection",
                        message: `${record.id}: subscription reconcile for ${owner} failed${
                          rateLimited ? " (rate limited; retried with backoff)" : ""
                        }: ${error.message}`,
                      });
                      yield* updateRecord(record.id, (current) => ({
                        ...current,
                        status: rateLimited ? current.status : "error",
                        lastError: error.message,
                      }));
                    });
                  }),
                );
              yield* updateRecord(record.id, (current) => ({
                ...current,
                ownerSpecs: new Map(current.ownerSpecs).set(owner, key),
                owners: new Set([...current.owners, owner]),
              }));
              }
            }
            for (const owner of record.owners) {
              if (owners.has(owner)) continue;
              yield* driver.cloudApi
                .reconcile(driver.cloudConnectionId, [], owner)
                .pipe(
                  Effect.catch((error) =>
                    logs.write({
                      level: "warn",
                      source: "connection",
                      message: `${record.id}: could not remove subscriptions for ${owner}: ${error.message}`,
                    }),
                  ),
                );
              yield* updateRecord(record.id, (current) => {
                const next = new Map(current.ownerSpecs);
                next.delete(owner);
                const ownersNext = new Set(current.owners);
                ownersNext.delete(owner);
                return { ...current, ownerSpecs: next, owners: ownersNext };
              });
            }
          }
        });

      const reconcile = (input: ReconcileInput): Effect.Effect<void> =>
        semaphore.withPermit(
          Effect.gen(function* () {
            yield* Ref.set(lastInput, input);
            const ids = new Set<string>();
            for (const record of yield* records()) ids.add(record.id);
            for (const entry of [...input.known, ...input.running]) {
              const projectBindings = input.bindings?.get(entry.projectId);
              if (projectBindings === undefined) continue;
              for (const connection of entry.manifest.connections) {
                const bound = projectBindings.get(
                  connection.integration + "/" + connection.slot,
                );
                if (bound !== undefined) ids.add(bound);
              }
            }
            for (const id of ids) yield* ensureRecord(id);
            yield* refreshTwitchMetadata;
            for (const record of yield* records()) {
              yield* ensureDriver(record);
            }
            yield* ensureWebhooks(input);
            yield* reconcileTwitchOwners(input);
          }),
        );

      const retryDelay = (attempts: number): number =>
        Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));

      /**
       * Reconnect policy: an active connection that failed to start keeps
       * retrying with exponential backoff until it connects, its settings
       * change, or the user disconnects it (`disabled`). Explicit Connect,
       * Disconnect and Configure clear the schedule and reconcile at once.
       */
      yield* Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("1 second");
          const input = yield* Ref.get(lastInput);
          const current = yield* Ref.get(state);
          const now = Date.now();
          const next = new Map(yield* Ref.get(retries));
          const due: string[] = [];
          for (const record of current.values()) {
            if (record.driver !== undefined) {
              // Drivers with their own retry loop (OBS) publish nextRetryAt
              // themselves; only clear the deadline this loop scheduled.
              const ours = next.delete(record.id);
              if (ours && record.nextRetryAt !== undefined) {
                yield* updateRecord(record.id, (value) => ({
                  ...value,
                  nextRetryAt: undefined,
                }));
              }
              continue;
            }
            const active =
              !record.disabled &&
              (record.manual || input.running.some((entry) => usesConnection(input, entry, record)));
            if (
              !active ||
              record.integration === "http" ||
              record.needsReauth ||
              !requiredFieldsSet(record) ||
              (record.status !== "error" && record.status !== "disconnected")
            ) {
              next.delete(record.id);
              if (record.nextRetryAt !== undefined) {
                yield* updateRecord(record.id, (value) => ({
                  ...value,
                  nextRetryAt: undefined,
                }));
              }
              continue;
            }
            const entry = next.get(record.id);
            if (entry === undefined) {
              next.set(record.id, { attempts: 0, nextAt: now + 1_000 });
              continue;
            }
            if (entry.nextAt <= now) due.push(record.id);
          }
          if (due.length === 0) {
            yield* Ref.set(retries, next);
            continue;
          }
          // Let this attempt pass the backoff gate; failures are scheduled
          // again below with the next delay.
          for (const id of due) {
            next.set(id, { attempts: next.get(id)?.attempts ?? 0, nextAt: now });
          }
          yield* Ref.set(retries, next);
          yield* reconcile(input);
          const after = yield* Ref.get(state);
          for (const id of due) {
            const record = after.get(id);
            if (record?.driver !== undefined || record?.status === "connected") continue;
            const attempts = (next.get(id)?.attempts ?? 0) + 1;
            const nextAt = Date.now() + retryDelay(attempts);
            yield* Ref.update(retries, (latest) => {
              const updated = new Map(latest);
              updated.set(id, { attempts, nextAt });
              return updated;
            });
            yield* updateRecord(id, (value) => ({ ...value, nextRetryAt: nextAt }));
          }
        }
      }).pipe(Effect.forkIn(parentScope));

      const permissions = (): Effect.Effect<{ readonly accessibility: PermissionStatus }> =>
        Effect.map(Ref.get(shellPermissions), (value) => ({
          accessibility: value.accessibility,
        }));

      const reportShellPermission = (input: {
        readonly permission: "accessibility";
        readonly status: PermissionStatus;
      }): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* Ref.set(shellPermissions, { accessibility: input.status });
          yield* reconcile(yield* Ref.get(lastInput));
        });

      const configure = (input: {
        readonly connectionId: string;
        readonly values: ReadonlyArray<{ readonly key: string; readonly value: string }>;
        readonly mode?: ConnectionMode;
      }): Effect.Effect<ConnectionSummary, AgentError> =>
        Effect.gen(function* () {
          const existing = yield* getRecord(input.connectionId);
          const parts = existing === undefined ? splitId(input.connectionId) : undefined;
          if (existing === undefined && parts === undefined) {
            return yield* Effect.fail(
              agentError("invalid", `Invalid connection id "${input.connectionId}"`),
            );
          }
          const integration = existing?.integration ?? parts?.integration ?? "";
          if (integrationDefinition(integration) === undefined) {
            return yield* Effect.fail(
              agentError(
                "invalid",
                `Unknown connection integration "${integration}"`,
              ),
            );
          }
          const record = existing ?? (yield* ensureRecord(input.connectionId));
          const fields = new Map(fieldsFor(record.integration).map((field) => [field.key, field]));
          const values = { ...record.values };
          const secrets = { ...record.secrets };
          for (const value of input.values) {
            const field = fields.get(value.key);
            if (field === undefined) {
              return yield* Effect.fail(
                agentError(
                  "invalid",
                  `Connection ${record.id} has no field "${value.key}"`,
                ),
              );
            }
            if (field.kind === "secret") {
              if (value.value === "") delete secrets[value.key];
              else secrets[value.key] = value.value;
            } else if (value.value === "") {
              delete values[value.key];
            } else {
              values[value.key] = value.value;
            }
          }
          const mode = input.mode ?? record.mode;
          yield* Ref.update(retries, (current) => {
            if (!current.has(record.id)) return current;
            const next = new Map(current);
            next.delete(record.id);
            return next;
          });
          yield* updateRecord(record.id, (current) => ({
            ...current,
            values,
            secrets,
            mode,
            disabled: false,
            lastError: undefined,
            nextRetryAt: undefined,
          }));
          yield* Ref.update(secretState, (current) => ({
            ...current,
            [record.id]: secrets,
          }));
          yield* persist();
          yield* reconcile(yield* Ref.get(lastInput));
          return yield* require(record.id);
        });

      const create = (input: {
        readonly integration: string;
        readonly label: string;
        readonly config: Readonly<Record<string, string>>;
        readonly mode?: ConnectionMode;
      }): Effect.Effect<ConnectionSummary, AgentError> =>
        Effect.gen(function* () {
          const label = input.label.trim();
          if (label === "") {
            return yield* Effect.fail(agentError("invalid", "A connection label is required"));
          }
          const fields = new Map(fieldsFor(input.integration).map((field) => [field.key, field]));
          if (fields.size === 0) {
            return yield* Effect.fail(
              agentError("invalid", `Unknown connection integration "${input.integration}"`),
            );
          }
          const id = `conn_${Hex.encode(yield* crypto.randomBytes(6).pipe(Effect.orDie))}`;
          const values: Record<string, string> = {};
          const secrets: Record<string, string> = {};
          for (const [key, value] of Object.entries(input.config)) {
            const field = fields.get(key);
            if (field === undefined) {
              return yield* Effect.fail(
                agentError("invalid", `Connection ${input.integration} has no field "${key}"`),
              );
            }
            if (field.kind === "secret") secrets[key] = value;
            else values[key] = value;
          }
          const record: ConnectionRecord = {
            ...noneRecord(input.integration, id),
            id,
            label,
            values,
            secrets,
            mode: input.mode ?? "auto",
          };
          yield* Ref.update(state, (current) => {
            const next = new Map(current);
            next.set(id, record);
            return next;
          });
          yield* Ref.update(secretState, (current) => ({ ...current, [id]: secrets }));
          yield* persist();
          return yield* require(id);
        });

      const update = (input: {
        readonly id: string;
        readonly label?: string;
        readonly config?: Readonly<Record<string, string>>;
        readonly mode?: ConnectionMode;
      }): Effect.Effect<ConnectionSummary, AgentError> =>
        Effect.gen(function* () {
          const record = yield* getRecord(input.id);
          if (record === undefined) {
            return yield* Effect.fail(agentError("not-found", `No connection "${input.id}"`));
          }
          const label = input.label?.trim() ?? record.label;
          if (label === "") {
            return yield* Effect.fail(agentError("invalid", "A connection label is required"));
          }
          const fields = new Map(fieldsFor(record.integration).map((field) => [field.key, field]));
          const values = { ...record.values };
          const secrets = { ...record.secrets };
          for (const [key, value] of Object.entries(input.config ?? {})) {
            const field = fields.get(key);
            if (field === undefined) {
              return yield* Effect.fail(
                agentError("invalid", `Connection ${record.integration} has no field "${key}"`),
              );
            }
            if (field.kind === "secret") {
              if (value === "") delete secrets[key];
              else secrets[key] = value;
            } else if (value === "") {
              delete values[key];
            } else {
              values[key] = value;
            }
          }
          yield* updateRecord(input.id, (current) => ({
            ...current,
            label,
            values,
            secrets,
            mode: input.mode ?? current.mode,
            lastError: undefined,
          }));
          yield* Ref.update(secretState, (current) => ({ ...current, [input.id]: secrets }));
          yield* persist();
          yield* reconcile(yield* Ref.get(lastInput));
          return yield* require(input.id);
        });

      const remove = (id: string): Effect.Effect<void, AgentError> =>
        Effect.gen(function* () {
          const record = yield* getRecord(id);
          if (record === undefined) {
            return yield* Effect.fail(agentError("not-found", `No connection "${id}"`));
          }
          const boundBy = summaryOf(record).boundBy;
          if (boundBy.length > 0) {
            return yield* Effect.fail(
              agentError(
                "conflict",
                `Connection "${record.label}" is bound to ${boundBy.length} project slot(s); unbind it first`,
              ),
            );
          }
          yield* closeDriver(record);
          yield* Ref.update(state, (current) => {
            if (!current.has(id)) return current;
            const next = new Map(current);
            next.delete(id);
            return next;
          });
          yield* Ref.update(secretState, (current) => {
            const next = { ...current };
            delete next[id];
            return next;
          });
          yield* persist();
        });

      const connect = (connectionId: string): Effect.Effect<ConnectionSummary, AgentError> =>
        Effect.gen(function* () {
          const record = yield* getRecord(connectionId);
          if (record === undefined) {
            return yield* Effect.fail(
              agentError("not-found", `No connection "${connectionId}"`),
            );
          }
          yield* Ref.update(retries, (current) => {
            if (!current.has(connectionId)) return current;
            const next = new Map(current);
            next.delete(connectionId);
            return next;
          });
          yield* updateRecord(connectionId, (current) => ({
            ...current,
            manual: true,
            disabled: false,
            nextRetryAt: undefined,
          }));
          yield* reconcile(yield* Ref.get(lastInput));
          yield* ready([connectionId]).pipe(Effect.catch(() => Effect.void));
          return yield* require(connectionId);
        });

      const disconnect = (connectionId: string): Effect.Effect<ConnectionSummary, AgentError> =>
        Effect.gen(function* () {
          const record = yield* getRecord(connectionId);
          if (record === undefined) {
            return yield* Effect.fail(
              agentError("not-found", `No connection "${connectionId}"`),
            );
          }
          yield* Ref.update(retries, (current) => {
            if (!current.has(connectionId)) return current;
            const next = new Map(current);
            next.delete(connectionId);
            return next;
          });
          yield* updateRecord(connectionId, (current) => ({
            ...current,
            manual: false,
            disabled: true,
            nextRetryAt: undefined,
          }));
          yield* reconcile(yield* Ref.get(lastInput));
          return yield* require(connectionId);
        });

      const startAuth = (input: {
        readonly connectionId: string;
        readonly mode?: ConnectionMode;
        readonly scopes?: ReadonlyArray<string>;
      }): Effect.Effect<ConnectionAuth, AgentError> =>
        Effect.gen(function* () {
          const record = yield* ensureRecord(input.connectionId);
          if (record.integration !== "twitch") {
            return yield* Effect.fail(
              agentError("invalid", `${record.id} does not use a browser authorization flow`),
            );
          }
          const cloudStatus = yield* cloud.status;
          const requestedMode = input.mode ?? record.mode;
          const mode =
            requestedMode === "auto"
              ? cloudStatus.state === "linked"
                ? "cloud"
                : "local-app"
              : requestedMode;
          if (mode === "cloud") {
            const cloudUrl = cloudStatus.cloudUrl;
            if (cloudStatus.state !== "linked" || cloudUrl === undefined) {
              return {
                _tag: "none",
                message:
                  "Pair this machine with the Ballast cloud before linking a Twitch account.",
              };
            }
            const required = [
              ...new Set([
                ...record.grantedScopes,
                ...scopesRequiredFor(record),
                ...(input.scopes ?? []),
              ]),
            ];
            const scopes = required.length === 0 ? ["user:read:email"] : required;
            return {
              _tag: "browser",
              url:
                cloudUrl.replace(/\/$/, "") +
                "/oauth/twitch/start?scopes=" +
                encodeURIComponent(scopes.join(",")),
              expiresAt: Date.now() + 10 * 60_000,
            };
          }
          const stored = yield* provide(readStoredTwitchAccount(record.slot, options.dataDir)).pipe(
            Effect.mapError((cause) => new Error(errorMessage(cause))),
            Effect.catch(() => Effect.succeed(undefined)),
          );
          const twitchEnv = yield* readEnvironment(twitchEnvKeys(record.slot));
          const config = yield* Effect.try({
            try: () => resolveTwitchAppConfig(record.slot, connectionOptions(record), stored, twitchEnv),
            catch: (cause) => agentError("invalid", errorMessage(cause)),
          });
          const required = [
            ...new Set([
              ...scopesRequiredFor(record),
              ...(input.scopes ?? []),
            ]),
          ];
          const scopes = required.length === 0 ? ["user:read:email"] : required;
          const scope = yield* Scope.fork(parentScope, "parallel");
          authScopes.add(scope);
          const started = yield* startTwitchAuth({
            slot: record.slot,
            config,
            dataDir: options.dataDir,
            scopes,
            openUrl: () => Effect.void,
            ...(config.clientSecret === undefined ? { device: true } : {}),
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provide(FetchHttpClient.layer),
            provide,
            Effect.mapError((cause) => agentError("upstream", errorMessage(cause))),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          yield* Effect.gen(function* () {
            const account = yield* started.wait;
            yield* logs.write({
              level: "info",
              source: "connection",
              message: `Twitch ${record.id} authorized as ${account.login}`,
            });
            yield* reconcile(yield* Ref.get(lastInput));
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.catch((cause) =>
              logs.write({
                level: "error",
                source: "connection",
                message: `Twitch ${record.id} authorization failed: ${errorMessage(cause)}`,
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                authScopes.delete(scope);
              }).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
            ),
            Effect.forkDetach,
          );
          return started.auth;
        });

      const request = (input: {
        readonly integration: string;
        readonly slot: string;
        readonly connectionId?: string;
        readonly request: string;
        readonly input: unknown;
      }): Effect.Effect<unknown, ConnectionRequestError> =>
        Effect.gen(function* () {
          const id = input.connectionId ?? `${input.integration}/${input.slot}`;
          const record = yield* getRecord(id);
          if (record === undefined) {
            return yield* Effect.fail(
              new ConnectionUnavailable({
                integration: input.integration,
                slot: input.slot,
                connectionId: id,
                message: `No connection ${id}`,
              }),
            );
          }
          const unavailable = (message: string): ConnectionUnavailable =>
            new ConnectionUnavailable({
              integration: record.integration,
              slot: record.slot,
              connectionId: record.id,
              message,
            });
          const failed = (message: string): ConnectionRequestError =>
            connectionRequestError({
              integration: record.integration,
              slot: record.slot,
              connectionId: record.id,
              message,
            });
          if (record.driver === undefined) {
            return yield* Effect.fail(unavailable(`Connection ${id} is not connected`));
          }
          if (input.integration === "fake") {
            return yield* handleFakeRequest(input.request, input.slot, input.input).pipe(
              Effect.mapError(failed),
            );
          }
          if (input.integration === "obs") {
            if (record.driver.obs === undefined) {
              return yield* Effect.fail(unavailable(`OBS ${id} is not connected`));
            }
            return yield* record.driver.obs.request(input.request, input.input);
          }
          if (input.integration === "vts") {
            if (record.driver.vts === undefined) {
              return yield* Effect.fail(unavailable(`VTube Studio ${id} is not connected`));
            }
            return yield* record.driver.vts.request(input.request, input.input).pipe(
              Effect.mapError((error) => failed(error.message)),
            );
          }
          if (input.integration === "keyboard") {
            if (record.driver.keyboard === undefined) {
              return yield* Effect.fail(unavailable(`Keyboard ${id} is not connected`));
            }
            return yield* record.driver.keyboard.request(input.request, input.input).pipe(
              Effect.mapError((error) => failed(error.message)),
            );
          }
          if (input.integration === "midi") {
            if (record.driver.midi === undefined) {
              return yield* Effect.fail(unavailable(`MIDI ${id} is not connected`));
            }
            return yield* record.driver.midi.request(input.request, input.input).pipe(
              Effect.mapError((error) => failed(error.message)),
            );
          }
          if (input.integration === "websocket-client") {
            const client = record.driver.webSocketClient;
            if (input.request === "websocket/connect") {
              return client === undefined
                ? yield* Effect.fail(unavailable(`WebSocket ${id} is not connected`))
                : {};
            }
            if (input.request === "websocket/send") {
              if (client === undefined) {
                return yield* Effect.fail(
                  unavailable(`WebSocket ${id} is not a connected client`),
                );
              }
              const message = Schema.decodeUnknownSync(
                Schema.Union([
                  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
                  Schema.Struct({ type: Schema.Literal("binary"), base64: Schema.String }),
                  Schema.Struct({ type: Schema.Literal("json"), value: Schema.Unknown }),
                ]),
              )(input.input);
              yield* client.send(message).pipe(Effect.mapError((error) => failed(error.reason)));
              return {};
            }
            return yield* Effect.fail(
              new ConnectionRequestFailed({
                integration: record.integration,
                slot: record.slot,
                connectionId: record.id,
                message: `Unknown WebSocket client request "${input.request}"`,
              }),
            );
          }
          if (input.integration === "websocket-server") {
            const server = record.driver.webSocketServers.get(input.slot);
            if (server === undefined) {
              return yield* Effect.fail(
                unavailable(`WebSocket ${id} is not listening for slot ${input.slot}`),
              );
            }
            if (input.request === "websocket/sendToClient") {
              const value = Schema.decodeUnknownSync(
                Schema.Struct({
                  clientId: Schema.String,
                  message: Schema.Union([
                    Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
                    Schema.Struct({ type: Schema.Literal("binary"), base64: Schema.String }),
                    Schema.Struct({ type: Schema.Literal("json"), value: Schema.Unknown }),
                  ]),
                }),
              )(input.input);
              yield* server
                .sendToClient(value.clientId, value.message)
                .pipe(Effect.mapError((error) => failed(error.reason)));
              return {};
            }
            if (input.request === "websocket/broadcast") {
              const message = Schema.decodeUnknownSync(
                Schema.Union([
                  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
                  Schema.Struct({ type: Schema.Literal("binary"), base64: Schema.String }),
                  Schema.Struct({ type: Schema.Literal("json"), value: Schema.Unknown }),
                ]),
              )(input.input);
              return yield* server.broadcast(message).pipe(
                Effect.mapError((error) => failed(error.reason)),
              );
            }
            return yield* Effect.fail(
              new ConnectionRequestFailed({
                integration: record.integration,
                slot: record.slot,
                connectionId: record.id,
                message: `Unknown WebSocket server request "${input.request}"`,
              }),
            );
          }
          if (input.integration === "twitch") {
            if (record.driver.twitch === undefined) {
              return yield* Effect.fail(unavailable(`Twitch ${id} is not connected`));
            }
            const name = Twitch.parseHelixRequestName(input.request);
            if (name === undefined) {
              return yield* Effect.fail(
                new ConnectionRequestFailed({
                  integration: record.integration,
                  slot: record.slot,
                  connectionId: record.id,
                  message: `Unknown Twitch request "${input.request}"`,
                }),
              );
            }
            return yield* record.driver.twitch.request(name, input.input).pipe(
              Effect.mapError((error) => failed(error.message)),
            );
          }
          return yield* Effect.fail(
            new ConnectionRequestFailed({
              integration: record.integration,
              slot: record.slot,
              connectionId: record.id,
              message: `No request handler for integration "${input.integration}"`,
            }),
          );
        });

      const optionValues = (source: {
        readonly integration: string;
        readonly slot: string;
        readonly source: string;
        readonly connectionId?: string;
      }): Effect.Effect<ReadonlyArray<string>, AgentError> =>
        Effect.gen(function* () {
          const id = source.connectionId ?? `${source.integration}/${source.slot}`;
          if (source.integration === "vts") {
            const record = yield* ensureRecord(id);
            if (!record.manual) {
              yield* updateRecord(id, (current) => ({ ...current, manual: true }));
              yield* reconcile(yield* Ref.get(lastInput));
            }
            const updated = yield* getRecord(id);
            yield* waitForConnected(id).pipe(Effect.catch(() => Effect.void));
            const refreshed = yield* getRecord(id);
            const driver = refreshed?.driver?.vts;
            if (driver === undefined) {
              return yield* Effect.fail(
                agentError("upstream", updated?.lastError ?? `VTube Studio ${id} is not connected`),
              );
            }
            return yield* driver.resolveOptions(source).pipe(
              Effect.mapError((error) => agentError("upstream", error.message)),
            );
          }
          if (source.integration === "keyboard") {
            const record = yield* ensureRecord(id);
            if (!record.manual) {
              yield* updateRecord(id, (current) => ({ ...current, manual: true }));
              yield* reconcile(yield* Ref.get(lastInput));
            }
            const updated = yield* getRecord(id);
            const driver = updated?.driver?.keyboard;
            if (driver === undefined) {
              return yield* Effect.fail(
                agentError("upstream", updated?.lastError ?? `Keyboard ${id} is not connected`),
              );
            }
            return yield* driver.options(source.source).pipe(
              Effect.mapError((error) => agentError("upstream", error.message)),
            );
          }
          if (source.integration === "midi") {
            const record = yield* ensureRecord(id);
            if (!record.manual) {
              yield* updateRecord(id, (current) => ({ ...current, manual: true }));
              yield* reconcile(yield* Ref.get(lastInput));
            }
            const updated = yield* getRecord(id);
            const driver = updated?.driver?.midi;
            if (driver === undefined) {
              return yield* Effect.fail(
                agentError("upstream", updated?.lastError ?? `MIDI ${id} is not connected`),
              );
            }
            return yield* driver.options(source.source).pipe(
              Effect.mapError((error) => agentError("upstream", error.message)),
            );
          }
          if (source.integration !== "obs" || source.source !== "scenes") {
            return yield* Effect.fail(
              agentError(
                "invalid",
                `No option provider for ${source.integration}/${source.slot}/${source.source}`,
              ),
            );
          }
          const cacheKey = `${id}:${source.source}`;
          const cached = (yield* Ref.get(sceneCache)).get(cacheKey);
          if (cached !== undefined && Date.now() - cached.at < 5_000) {
            return cached.values;
          }
          const record = yield* ensureRecord(id);
          if (!record.manual) {
            yield* updateRecord(id, (current) => ({ ...current, manual: true }));
            yield* reconcile(yield* Ref.get(lastInput));
          }
          const updated = yield* getRecord(id);
          const driver = updated?.driver?.obs;
          if (driver === undefined) {
            return yield* Effect.fail(
              agentError(
                "upstream",
                updated?.lastError ?? `OBS ${id} is not connected`,
              ),
            );
          }
          yield* driver.ready.pipe(
            Effect.timeout("10 seconds"),
            Effect.mapError(() =>
              agentError("upstream", `OBS ${id} did not connect within 10s`),
            ),
          );
          const response = yield* driver.request("GetSceneList", {}).pipe(
            Effect.mapError((error) => agentError("upstream", error.message)),
          );
          const decoded = yield* Effect.try({
            try: () => Schema.decodeUnknownSync(RequestSchemas.GetSceneList.output)(response),
            catch: (cause) =>
              agentError("upstream", `Unexpected GetSceneList response: ${errorMessage(cause)}`),
          });
          const values = decoded.scenes.flatMap((scene) => {
            const name = scene["sceneName"];
            return typeof name === "string" ? [name] : [];
          });
          if (values.length === 0) {
            return yield* Effect.fail(
              agentError("upstream", `OBS ${id} returned no scenes`),
            );
          }
          yield* Ref.update(sceneCache, (current) => {
            const next = new Map(current);
            next.set(cacheKey, { at: Date.now(), values });
            return next;
          });
          return values;
        });

      const close = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          const webhooks = yield* Ref.get(webhookRuntime);
          if (webhooks !== undefined) {
            yield* Ref.set(webhookRuntime, undefined);
            yield* Scope.close(webhooks.scope, Exit.void);
          }
          for (const scope of authScopes) {
            yield* Scope.close(scope, Exit.void);
          }
          authScopes.clear();
          for (const record of yield* records()) {
            yield* closeDriver(record);
          }
        });

      const waitForConnected = (id: string): Effect.Effect<void, AgentError> =>
        Effect.gen(function* () {
          const started = Date.now();
          while (Date.now() - started < 10_000) {
            const record = yield* getRecord(id);
            if (record === undefined) {
              return yield* Effect.fail(agentError("not-found", `No connection "${id}"`));
            }
            if (record?.status === "connected") return;
            if (record?.status === "error" || record?.status === "reauth-required") {
              return yield* Effect.fail(
                agentError(
                  record.status === "reauth-required" ? "unauthorized" : "upstream",
                  record.lastError ?? `Connection ${id} is not connected`,
                ),
              );
            }
            yield* Effect.sleep("100 millis");
          }
          const record = yield* getRecord(id);
          return yield* Effect.fail(
            agentError(
              "upstream",
              record?.lastError ?? `Connection ${id} did not connect within 10s`,
            ),
          );
        });

      /** Used by the user-facing Connect action, never to gate a project start. */
      const ready = (
        connectionKeys: ReadonlyArray<string>,
      ): Effect.Effect<void, AgentError> =>
        Effect.gen(function* () {
          for (const key of connectionKeys) {
            const record = yield* getRecord(key);
            if (record === undefined) {
              return yield* Effect.fail(
                agentError("not-found", `No connection "${key}"`),
              );
            }
            if (record.driver === undefined && record.integration !== "http") {
              return yield* Effect.fail(
                agentError(
                  "upstream",
                  record.lastError ?? `Connection ${key} is not connected`,
                ),
              );
            }
            if (record.driver?.obs !== undefined) {
              yield* record.driver.obs.ready.pipe(
                Effect.timeout("10 seconds"),
                Effect.mapError(() =>
                  agentError("upstream", `Connection ${key} did not connect within 10s`),
                ),
              );
              yield* updateRecord(key, (current) => ({
                ...current,
                status: "connected",
                lastConnectedAt: Date.now(),
                lastError: undefined,
              }));
            }
            if (
              ["vts", "keyboard", "midi", "websocket-client", "websocket-server", "http"].includes(
                record.integration,
              )
            ) {
              yield* waitForConnected(key);
            }
          }
        });

      yield* Effect.addFinalizer(() => close());

      return {
        integrations,
        summaries,
        summary,
        require,
        create,
        update,
        remove,
        configure,
        connect,
        disconnect,
        startAuth,
        reconcile,
        permissions,
        reportShellPermission,
        request,
        optionValues,
        close,
      };
    }),
  );
