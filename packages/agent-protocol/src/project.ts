import { Schema } from "effect";

import { ParamValue } from "./common.ts";
import { ConnectionSummary } from "./connections.ts";
import {
  ConsentReason,
  ManifestConnection,
  ManifestDiff,
  ManifestRequest,
  ParamView,
  ScriptSummary,
  UnresolvedEntry,
} from "./scripts.ts";

/** Where a declaration lives in the project. */
export const SourceLocation = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
});
export type SourceLocation = typeof SourceLocation.Type;

export const UnitKind = Schema.Literals(["topic", "timer", "workflow", "param", "run"]);
export type UnitKind = typeof UnitKind.Type;

export const UnitStatus = Schema.Literals(["active", "waiting", "error"]);
export type UnitStatus = typeof UnitStatus.Type;

/**
 * One named declaration in a project bundle. The manifest carries the
 * kind-specific fields; this view is the common row the UI renders.
 */
export const UnitSummary = Schema.Struct({
  kind: UnitKind,
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(SourceLocation),
  status: UnitStatus,
  /** Last time this unit handled work or changed state, epoch ms. */
  lastActivityAt: Schema.optionalKey(Schema.Number),
});
export type UnitSummary = typeof UnitSummary.Type;

export const ProjectStatus = Schema.Literals([
  "stopped",
  "running",
  "needs-consent",
  "error",
]);
export type ProjectStatus = typeof ProjectStatus.Type;

export const ManifestTopicUnit = Schema.Struct({
  name: Schema.String,
  integration: Schema.String,
  slot: Schema.String,
  topic: Schema.String,
  scopes: Schema.Array(Schema.String),
  onStale: Schema.Literals(["drop", "deliver"]),
  maxAgeMs: Schema.Number,
  source: Schema.optionalKey(SourceLocation),
  condition: Schema.optionalKey(Schema.Json),
});
export type ManifestTopicUnit = typeof ManifestTopicUnit.Type;

export const ManifestTimerUnit = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  onStale: Schema.Literals(["drop", "deliver"]),
  maxAgeMs: Schema.Number,
  payloadFingerprint: Schema.String,
  source: Schema.optionalKey(SourceLocation),
});
export type ManifestTimerUnit = typeof ManifestTimerUnit.Type;

export const ManifestWorkflowUnit = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  fingerprint: Schema.String,
  source: Schema.optionalKey(SourceLocation),
});
export type ManifestWorkflowUnit = typeof ManifestWorkflowUnit.Type;

export const ManifestRunUnit = Schema.Struct({
  name: Schema.String,
  source: Schema.optionalKey(SourceLocation),
});
export type ManifestRunUnit = typeof ManifestRunUnit.Type;

/** The project manifest on the wire. Activities stay out of it. */
export const ProjectManifest = Schema.Struct({
  project: Schema.Struct({
    id: Schema.String,
    entry: Schema.String,
  }),
  params: Schema.Array(ParamView),
  connections: Schema.Array(ManifestConnection),
  topics: Schema.Array(ManifestTopicUnit),
  requests: Schema.Array(ManifestRequest),
  timers: Schema.Array(ManifestTimerUnit),
  workflows: Schema.Array(ManifestWorkflowUnit),
  runs: Schema.Array(ManifestRunUnit),
  unresolved: Schema.Array(UnresolvedEntry),
});
export type ProjectManifest = typeof ProjectManifest.Type;

export const emptyProjectManifest = (id: string, entry: string): ProjectManifest => ({
  project: { id, entry },
  params: [],
  connections: [],
  topics: [],
  requests: [],
  timers: [],
  workflows: [],
  runs: [],
  unresolved: [],
});

/** One project-level consent request; there is no per-script consent. */
export const ProjectRequirement = Schema.Struct({
  integration: Schema.String,
  slot: Schema.String,
  location: Schema.Literals(["local", "cloud", "either"]),
  boundInstanceId: Schema.optionalKey(Schema.String),
  /** Pre-filled when exactly one instance of this integration exists. */
  proposedInstanceId: Schema.optionalKey(Schema.String),
});
export type ProjectRequirement = typeof ProjectRequirement.Type;

export const ProjectBinding = Schema.Struct({
  integration: Schema.String,
  slot: Schema.String,
  instanceId: Schema.String,
});
export type ProjectBinding = typeof ProjectBinding.Type;

export const ProjectConsentRequest = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  projectName: Schema.String,
  createdAt: Schema.Number,
  reason: ConsentReason,
  summary: Schema.String,
  diff: ManifestDiff,
  /** Proposed slot → instance bindings confirmed by approving/starting. */
  bindings: Schema.Array(ProjectBinding),
});
export type ProjectConsentRequest = typeof ProjectConsentRequest.Type;

export const ProjectSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  /** Project-relative entry path; absent while entry resolution is failing. */
  entry: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
  status: ProjectStatus,
  unitCount: Schema.Number,
  /** Legacy per-script count, kept for the desktop/UI cutover. */
  scriptCount: Schema.optionalKey(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  lastError: Schema.optionalKey(Schema.String),
});
export type ProjectSummary = typeof ProjectSummary.Type;

export const ProjectDetail = Schema.Struct({
  summary: ProjectSummary,
  manifest: ProjectManifest,
  requirements: Schema.Array(ProjectRequirement),
  units: Schema.Array(UnitSummary),
  appliedAt: Schema.optionalKey(Schema.Number),
  pendingConsent: Schema.optionalKey(ProjectConsentRequest),
  lastErrorSource: Schema.optionalKey(SourceLocation),
  /** Legacy script rows for the script-oriented cutover UI. */
  scripts: Schema.Array(ScriptSummary),
  appliedManifest: Schema.optionalKey(ProjectManifest),
});
export type ProjectDetail = typeof ProjectDetail.Type;

export const ProjectFileKind = Schema.Literals(["file", "directory"]);
export type ProjectFileKind = typeof ProjectFileKind.Type;

export const ProjectFile = Schema.Struct({
  path: Schema.String,
  kind: ProjectFileKind,
});
export type ProjectFile = typeof ProjectFile.Type;

export const ListProjectFilesRequest = Schema.Struct({
  projectId: Schema.String,
});
export type ListProjectFilesRequest = typeof ListProjectFilesRequest.Type;

export const ListProjectFilesResponse = Schema.Struct({
  entry: Schema.String,
  files: Schema.Array(ProjectFile),
});
export type ListProjectFilesResponse = typeof ListProjectFilesResponse.Type;

export const ReadProjectFileRequest = Schema.Struct({
  projectId: Schema.String,
  path: Schema.String,
});
export type ReadProjectFileRequest = typeof ReadProjectFileRequest.Type;

export const ProjectFileContent = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  sha256: Schema.String,
  updatedAt: Schema.Number,
  language: Schema.Literals(["typescript", "json", "text"]),
});
export type ProjectFileContent = typeof ProjectFileContent.Type;

export const SetProjectParamRequest = Schema.Struct({
  projectId: Schema.String,
  key: Schema.String,
  value: ParamValue,
});
export type SetProjectParamRequest = typeof SetProjectParamRequest.Type;

export const SetProjectEnabledRequest = Schema.Struct({
  projectId: Schema.String,
  enabled: Schema.Boolean,
});
export type SetProjectEnabledRequest = typeof SetProjectEnabledRequest.Type;

export const SetProjectBindingRequest = Schema.Struct({
  projectId: Schema.String,
  integration: Schema.String,
  slot: Schema.String,
  /** Null removes the binding; the project then cannot start until rebound. */
  instanceId: Schema.NullOr(Schema.String),
});
export type SetProjectBindingRequest = typeof SetProjectBindingRequest.Type;

export const ProjectDiagnostic = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  code: Schema.String,
  message: Schema.String,
});
export type ProjectDiagnostic = typeof ProjectDiagnostic.Type;

export const ProjectUnitChange = Schema.Struct({
  kind: UnitKind,
  name: Schema.String,
  change: Schema.Literals(["added", "removed", "changed"]),
  before: Schema.optionalKey(Schema.Unknown),
  after: Schema.optionalKey(Schema.Unknown),
  source: Schema.optionalKey(SourceLocation),
});
export type ProjectUnitChange = typeof ProjectUnitChange.Type;

/** Non-applying project analysis: typecheck, bundle, plan and diff. */
export const ProjectCheckResult = Schema.Struct({
  summary: ProjectSummary,
  ok: Schema.Boolean,
  /** Absent when bundling/planning failed before a manifest existed. */
  manifest: Schema.optionalKey(ProjectManifest),
  appliedManifest: Schema.optionalKey(ProjectManifest),
  units: Schema.Array(UnitSummary),
  changes: Schema.Array(ProjectUnitChange),
  requiresConsent: Schema.Boolean,
  requirements: Schema.Array(ProjectRequirement),
  missingConnections: Schema.Array(ProjectRequirement),
  missingScopes: Schema.Array(Schema.String),
  availableConnections: Schema.Array(ConnectionSummary),
  pendingConsent: Schema.optionalKey(ProjectConsentRequest),
  diagnostics: Schema.Array(ProjectDiagnostic),
  error: Schema.optionalKey(Schema.String),
});
export type ProjectCheckResult = typeof ProjectCheckResult.Type;

export const CreateProjectRequest = Schema.Struct({
  name: Schema.String,
  /** Absolute destination; defaults to <projects dir>/<slug(name)>. */
  directory: Schema.optionalKey(Schema.String),
});
export type CreateProjectRequest = typeof CreateProjectRequest.Type;
