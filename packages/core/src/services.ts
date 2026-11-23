import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {
  ConnectionManifest,
  ParamManifest,
  RequestManifest,
  TimerManifest,
  TopicManifest,
  UnresolvedManifest,
  WorkflowManifest,
} from "./manifest.ts";
import type { RequestRef } from "./request.ts";

/**
 * Plan-only sink for everything a script declares. The planner owns the
 * `Ref<Manifest>` behind it; scripts and integrations never see the ref.
 */
export interface ManifestRecorderService {
  readonly script: (id: string) => Effect.Effect<void>;
  readonly param: (param: ParamManifest) => Effect.Effect<void>;
  readonly connection: (connection: ConnectionManifest) => Effect.Effect<void>;
  readonly topic: (topic: TopicManifest) => Effect.Effect<void>;
  readonly request: (request: RequestManifest) => Effect.Effect<void>;
  readonly unresolved: (unresolved: UnresolvedManifest) => Effect.Effect<void>;
  readonly timer: (timer: TimerManifest) => Effect.Effect<void>;
  readonly workflow: (workflow: WorkflowManifest) => Effect.Effect<void>;
}

export class ManifestRecorder extends Context.Service<ManifestRecorder, ManifestRecorderService>()(
  "Ballast/ManifestRecorder",
) {}

/**
 * Runtime settings, provided by the agent. Reads are live: a settings change
 * while a script runs is visible to the next `Param.get`.
 */
export interface SettingsService {
  readonly get: (key: string) => Effect.Effect<unknown>;
}

export class Settings extends Context.Service<Settings, SettingsService>()("Ballast/Settings") {}

/**
 * Runtime event delivery, provided by the agent's event bus. The bus decodes
 * payloads and calls the handler once per delivery. Registrations are dropped
 * when the script worker is replaced.
 */
export interface EventBusService {
  readonly subscribe: <A>(
    topicKey: string,
    handler: (event: A) => Effect.Effect<void, never, never>,
  ) => Effect.Effect<void>;
}

export class EventBus extends Context.Service<EventBus, EventBusService>()("Ballast/EventBus") {}

/**
 * Runtime request clients, provided by the agent. Keys are
 * `integration/slot/request`, exactly as they appear in the manifest.
 */
export interface RequestClientsService {
  readonly client: <A, B>(
    request: RequestRef<A, B>,
  ) => Effect.Effect<(input: A) => Effect.Effect<B>>;
}

export class RequestClients extends Context.Service<RequestClients, RequestClientsService>()(
  "Ballast/RequestClients",
) {}

/** Collects long-running loops registered with `Ballast.run` during init. */
export interface ScriptRunnerService {
  readonly run: (effect: Effect.Effect<void, never, never>) => Effect.Effect<void>;
}

export class ScriptRunner extends Context.Service<ScriptRunner, ScriptRunnerService>()(
  "Ballast/ScriptRunner",
) {}

