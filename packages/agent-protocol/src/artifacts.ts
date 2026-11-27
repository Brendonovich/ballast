import { Schema } from "effect";

import { ParamValue } from "./common.ts";
import { LogLevel } from "./logs.ts";
import { ProjectStatus, SourceLocation, UnitKind } from "./project.ts";

export const ArtifactStatus = Schema.Literals(["ready", "building", "error"]);
export type ArtifactStatus = typeof ArtifactStatus.Type;

/** One artifact declared by the project manifest. */
export const ArtifactSummary = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  entry: Schema.String,
  source: Schema.optionalKey(SourceLocation),
  fingerprint: Schema.String,
  status: ArtifactStatus,
  /** Present when the last build failed. */
  error: Schema.optionalKey(Schema.String),
  /**
   * Stable URL for this artifact. Derived from the project secret and the
   * fixed artifact origin, so it survives service restarts and is the same URL
   * init sees from `Ballast.Artifact(...)`.
   */
  stableUrl: Schema.optionalKey(Schema.String),
});
export type ArtifactSummary = typeof ArtifactSummary.Type;

export const ListArtifactsRequest = Schema.Struct({
  projectId: Schema.String,
});
export type ListArtifactsRequest = typeof ListArtifactsRequest.Type;

export const ListArtifactsResponse = Schema.Struct({
  artifacts: Schema.Array(ArtifactSummary),
});
export type ListArtifactsResponse = typeof ListArtifactsResponse.Type;

/**
 * A short-lived view token for the app's own iframe. Artifacts are private to
 * the project, so the token grants the same access as any other artifact URL.
 */
export const GetArtifactViewRequest = Schema.Struct({
  projectId: Schema.String,
  artifact: Schema.String,
});
export type GetArtifactViewRequest = typeof GetArtifactViewRequest.Type;

export const ArtifactView = Schema.Struct({
  /** Artifact origin without a trailing slash. */
  url: Schema.String,
  /** Full page URL including the short-lived token. */
  pageUrl: Schema.String,
  token: Schema.String,
  expiresAt: Schema.Number,
});
export type ArtifactView = typeof ArtifactView.Type;

/** Extend an open view's token in place; the page and socket token stay valid. */
export const RenewArtifactViewRequest = Schema.Struct({
  token: Schema.String,
});
export type RenewArtifactViewRequest = typeof RenewArtifactViewRequest.Type;

export const RenewArtifactViewResponse = Schema.Struct({
  /** The same token, with a later expiry. */
  token: Schema.String,
  expiresAt: Schema.Number,
});
export type RenewArtifactViewResponse = typeof RenewArtifactViewResponse.Type;

/** A persistent URL. The plaintext token is returned only when it is created. */
export const ArtifactUrlSummary = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  artifact: Schema.String,
  transparent: Schema.Boolean,
  createdAt: Schema.Number,
  lastUsedAt: Schema.optionalKey(Schema.Number),
  revokedAt: Schema.optionalKey(Schema.Number),
  /** URL with the token redacted, safe to show in a list. */
  urlPreview: Schema.String,
  /** Stable fingerprint for audits; never the token itself. */
  tokenFingerprint: Schema.String,
  /**
   * Full URL when the service still has (or persisted) its token. Persistent
   * URLs are stored 0600 under project state so the user can copy them again
   * after a restart; short-lived view tokens never appear here.
   */
  url: Schema.optionalKey(Schema.String),
});
export type ArtifactUrlSummary = typeof ArtifactUrlSummary.Type;

export const CreateArtifactUrlRequest = Schema.Struct({
  projectId: Schema.String,
  artifact: Schema.String,
  transparent: Schema.Boolean,
});
export type CreateArtifactUrlRequest = typeof CreateArtifactUrlRequest.Type;

export const CreateArtifactUrlResult = Schema.Struct({
  url: ArtifactUrlSummary,
  /** Full URL with its token. */
  copyUrl: Schema.String,
});
export type CreateArtifactUrlResult = typeof CreateArtifactUrlResult.Type;

export const ListArtifactUrlsRequest = Schema.Struct({
  projectId: Schema.optionalKey(Schema.String),
  artifact: Schema.optionalKey(Schema.String),
});
export type ListArtifactUrlsRequest = typeof ListArtifactUrlsRequest.Type;

export const ListArtifactUrlsResponse = Schema.Struct({
  urls: Schema.Array(ArtifactUrlSummary),
});
export type ListArtifactUrlsResponse = typeof ListArtifactUrlsResponse.Type;

export const RevokeArtifactUrlRequest = Schema.Struct({
  id: Schema.String,
});
export type RevokeArtifactUrlRequest = typeof RevokeArtifactUrlRequest.Type;

/** Built-in, service-handled metadata API exposed on the artifact gateway. */
export const ArtifactUnitKind = Schema.Literals([
  "topic",
  "timer",
  "workflow",
  "param",
  "run",
  "artifact",
  "api",
  "store",
  "database",
]);
export type ArtifactUnitKind = typeof ArtifactUnitKind.Type;

export const ArtifactProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  entry: Schema.String,
  status: ProjectStatus,
  generation: Schema.Number,
  startedAt: Schema.optionalKey(Schema.Number),
  lastError: Schema.optionalKey(
    Schema.Struct({
      message: Schema.String,
      file: Schema.optionalKey(Schema.String),
      line: Schema.optionalKey(Schema.Number),
      column: Schema.optionalKey(Schema.Number),
    }),
  ),
});
export type ArtifactProject = typeof ArtifactProject.Type;

export const ArtifactUnit = Schema.Struct({
  kind: Schema.String,
  name: Schema.String,
  status: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(SourceLocation),
});
export type ArtifactUnit = typeof ArtifactUnit.Type;

export const ArtifactParam = Schema.Struct({
  key: Schema.String,
  type: Schema.Literals(["string", "number", "boolean", "enum", "strings"]),
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  value: Schema.Unknown,
  default: Schema.optionalKey(ParamValue),
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  optionsSource: Schema.optionalKey(
    Schema.Struct({
      integration: Schema.String,
      slot: Schema.String,
      source: Schema.String,
    }),
  ),
  writable: Schema.Boolean,
});
export type ArtifactParam = typeof ArtifactParam.Type;

export const ArtifactLogsInput = Schema.Struct({
  unit: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(UnitKind),
  levels: Schema.optionalKey(Schema.Array(LogLevel)),
  afterSeq: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
});
export type ArtifactLogsInput = typeof ArtifactLogsInput.Type;

export const ArtifactEventsInput = Schema.Struct({
  unit: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(UnitKind),
  integration: Schema.optionalKey(Schema.String),
  topic: Schema.optionalKey(Schema.String),
  afterSeq: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
});
export type ArtifactEventsInput = typeof ArtifactEventsInput.Type;

export const ArtifactEventHistoryInput = Schema.Struct({
  subscription: Schema.String,
  limit: Schema.optionalKey(Schema.Number),
  before: Schema.optionalKey(Schema.String),
});
export type ArtifactEventHistoryInput = typeof ArtifactEventHistoryInput.Type;

export const ArtifactEventHistoryEntry = Schema.Struct({
  cursor: Schema.String,
  receivedAt: Schema.Number,
  fingerprint: Schema.String,
  event: Schema.Unknown,
});
export type ArtifactEventHistoryEntry = typeof ArtifactEventHistoryEntry.Type;

export const ArtifactEventHistoryResult = Schema.Struct({
  subscription: Schema.String,
  entries: Schema.Array(ArtifactEventHistoryEntry),
});
export type ArtifactEventHistoryResult = typeof ArtifactEventHistoryResult.Type;

export const ArtifactSetParamInput = Schema.Struct({
  key: Schema.String,
  value: ParamValue,
});
export type ArtifactSetParamInput = typeof ArtifactSetParamInput.Type;

export const ArtifactCancelTimerInput = Schema.Struct({
  name: Schema.String,
  key: Schema.String,
});
export type ArtifactCancelTimerInput = typeof ArtifactCancelTimerInput.Type;

export const ArtifactLogLine = Schema.Struct({
  at: Schema.Number,
  level: Schema.Literals(["debug", "info", "warning", "error"]),
  message: Schema.String,
  unitName: Schema.optionalKey(Schema.String),
  unitKind: Schema.optionalKey(Schema.String),
});
export type ArtifactLogLine = typeof ArtifactLogLine.Type;

export const ArtifactEvent = Schema.Struct({
  at: Schema.Number,
  event: Schema.String,
  unitName: Schema.optionalKey(Schema.String),
  payload: Schema.optionalKey(Schema.Unknown),
});
export type ArtifactEvent = typeof ArtifactEvent.Type;

export const ArtifactTimer = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  onStale: Schema.Literals(["drop", "deliver"]),
  maxAgeMs: Schema.Number,
  pending: Schema.Number,
  fired: Schema.Number,
});
export type ArtifactTimer = typeof ArtifactTimer.Type;
export const ArtifactTimers = Schema.Array(ArtifactTimer);
export type ArtifactTimers = typeof ArtifactTimers.Type;

export const ArtifactWorkflow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  startedAt: Schema.optionalKey(Schema.Number),
  finishedAt: Schema.optionalKey(Schema.Number),
});
export type ArtifactWorkflow = typeof ArtifactWorkflow.Type;
export const ArtifactWorkflows = Schema.Array(ArtifactWorkflow);
export type ArtifactWorkflows = typeof ArtifactWorkflows.Type;
