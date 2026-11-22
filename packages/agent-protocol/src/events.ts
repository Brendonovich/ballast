import { Schema } from "effect";

import { CloudStatus } from "./cloud.ts";
import { ConnectionSummary } from "./connections.ts";
import { ProjectSummary } from "./projects.ts";
import { HealthStatus, ServiceInfo } from "./service.ts";
import { ConsentRequest, ScriptSummary } from "./scripts.ts";

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
]);
export type ServiceEvent = typeof ServiceEvent.Type;

export const WatchServiceRequest = Schema.Struct({
  /** Reserved: replay state changes after this sequence. v1 always starts with a snapshot. */
  afterSeq: Schema.optionalKey(Schema.Number),
});
export type WatchServiceRequest = typeof WatchServiceRequest.Type;
