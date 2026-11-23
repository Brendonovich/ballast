import { Schema } from "effect";

import { CloudStatus } from "./cloud.ts";
import { ConnectionSummary } from "./connections.ts";
import { HealthStatus, ServiceInfo } from "./service.ts";
import { ProjectConsentRequest, ProjectSummary, SourceLocation } from "./project.ts";
import { ConsentRequest, ScriptSummary } from "./scripts.ts";
import { TimerSummary } from "./timers.ts";

/**
 * The complete state a UI needs to render its first frame. `WatchService`
 * sends one snapshot before any incremental event, so a client can drop its
 * loading state without issuing a second round of requests.
 */
export const ServiceSnapshot = Schema.Struct({
  info: ServiceInfo,
  health: HealthStatus,
  projects: Schema.Array(ProjectSummary),
  scripts: Schema.Array(ScriptSummary),
  connections: Schema.Array(ConnectionSummary),
  cloud: CloudStatus,
  consents: Schema.Array(ConsentRequest),
});
export type ServiceSnapshot = typeof ServiceSnapshot.Type;

/**
 * Incremental state changes. Each event is a complete replacement for the
 * matching item (or a removal), so clients never need to merge partial fields.
 */
export const ServiceEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    snapshot: ServiceSnapshot,
  }),
  Schema.TaggedStruct("project", {
    project: ProjectSummary,
  }),
  Schema.TaggedStruct("project-changed", {
    project: ProjectSummary,
  }),
  /**
   * A project reload failed (typecheck, bundle or plan). The previous worker
   * keeps running when there was one.
   */
  Schema.TaggedStruct("reload-failed", {
    projectId: Schema.String,
    message: Schema.String,
    source: Schema.optionalKey(SourceLocation),
    at: Schema.Number,
  }),
  /**
   * A project file changed on disk. Open source viewers refetch the file.
   */
  Schema.TaggedStruct("project-file-changed", {
    projectId: Schema.String,
    path: Schema.String,
    sha256: Schema.String,
    updatedAt: Schema.Number,
  }),
  Schema.TaggedStruct("project-consent", {
    consent: ProjectConsentRequest,
  }),
  Schema.TaggedStruct("project-consent-resolved", {
    projectId: Schema.String,
    consentId: Schema.String,
    approved: Schema.Boolean,
    project: ProjectSummary,
  }),
  Schema.TaggedStruct("project-removed", {
    projectId: Schema.String,
  }),
  Schema.TaggedStruct("script", {
    script: ScriptSummary,
  }),
  Schema.TaggedStruct("script-removed", {
    projectId: Schema.String,
    scriptId: Schema.String,
  }),
  /**
   * The entry file changed on disk. Open source viewers refetch
   * `GetScriptSource`; clients that do not show source can ignore it.
   */
  Schema.TaggedStruct("script-source-changed", {
    projectId: Schema.String,
    scriptId: Schema.String,
    sha256: Schema.String,
    updatedAt: Schema.Number,
  }),
  Schema.TaggedStruct("connection", {
    connection: ConnectionSummary,
  }),
  Schema.TaggedStruct("cloud", {
    cloud: CloudStatus,
  }),
  Schema.TaggedStruct("consent", {
    consent: ConsentRequest,
  }),
  Schema.TaggedStruct("consent-resolved", {
    projectId: Schema.String,
    scriptId: Schema.String,
    consentId: Schema.String,
    approved: Schema.Boolean,
    /** The script's state after the decision. */
    script: ScriptSummary,
  }),
  Schema.TaggedStruct("health", {
    health: HealthStatus,
  }),
  /**
   * A durable timer was taken and posted to the active worker generation.
   * The timer row is a snapshot for a UI timer list.
   */
  Schema.TaggedStruct("timer-fired", {
    timer: TimerSummary,
  }),
]);
export type ServiceEvent = typeof ServiceEvent.Type;

export const WatchServiceRequest = Schema.Struct({
  /** Reserved: replay state changes after this sequence. v1 always starts with a snapshot. */
  afterSeq: Schema.optionalKey(Schema.Number),
});
export type WatchServiceRequest = typeof WatchServiceRequest.Type;
