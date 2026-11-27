import { Schema } from "effect";

import { CloudStatus } from "./cloud.ts";
import { ConnectionSummary } from "./connections.ts";
import { HealthStatus, ServiceInfo } from "./service.ts";
import {
  ArtifactUrlConfirmation,
  ArtifactUrlSummary,
} from "./artifacts.ts";
import { ProjectConsentRequest, ProjectSummary, SourceLocation } from "./project.ts";
import { TimerSummary } from "./timers.ts";
import { ProjectUpdateAvailable } from "./shares.ts";

/**
 * The complete state a UI needs to render its first frame. `WatchService`
 * sends one snapshot before any incremental event, so a client can drop its
 * loading state without issuing a second round of requests.
 */
export const ServiceSnapshot = Schema.Struct({
  info: ServiceInfo,
  health: HealthStatus,
  projects: Schema.Array(ProjectSummary),
  connections: Schema.Array(ConnectionSummary),
  cloud: CloudStatus,
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
  /** A subscribed project's share has a new deploy to apply. */
  Schema.TaggedStruct("share-update-available", {
    projectId: Schema.String,
    shareId: Schema.String,
    update: ProjectUpdateAvailable,
  }),
  Schema.TaggedStruct("connection", {
    connection: ConnectionSummary,
  }),
  Schema.TaggedStruct("cloud", {
    cloud: CloudStatus,
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
  /** An artifact bundle changed; connected artifact pages reload. */
  Schema.TaggedStruct("artifact-changed", {
    projectId: Schema.String,
    artifact: Schema.String,
    fingerprint: Schema.String,
  }),
  Schema.TaggedStruct("artifact-url", {
    url: ArtifactUrlSummary,
  }),
  Schema.TaggedStruct("artifact-url-confirmation", {
    confirmation: ArtifactUrlConfirmation,
  }),
  Schema.TaggedStruct("artifact-url-confirmation-resolved", {
    confirmationId: Schema.String,
    approved: Schema.Boolean,
  }),
]);
export type ServiceEvent = typeof ServiceEvent.Type;

export const WatchServiceRequest = Schema.Struct({
  /** Reserved: replay state changes after this sequence. v1 always starts with a snapshot. */
  afterSeq: Schema.optionalKey(Schema.Number),
});
export type WatchServiceRequest = typeof WatchServiceRequest.Type;
