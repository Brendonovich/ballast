import { Schema } from "effect";

import {
  ConnectionLocation,
  ConnectionStatus,
  ParamType,
  ParamValue,
} from "./common.ts";

export const ScriptStatus = Schema.Literals([
  "idle",
  "planning",
  "starting",
  "running",
  "stopping",
  "stopped",
  "needs-consent",
  "error",
]);
export type ScriptStatus = typeof ScriptStatus.Type;

export const ScriptRef = Schema.Struct({
  projectId: Schema.String,
  scriptId: Schema.String,
});
export type ScriptRef = typeof ScriptRef.Type;

export const ScriptSummary = Schema.Struct({
  projectId: Schema.String,
  id: Schema.String,
  name: Schema.String,
  /** The script's path relative to the project root. */
  entry: Schema.String,
  status: ScriptStatus,
  /**
   * Whether the service starts this script when the service starts. New
   * scripts default to false and always need an explicit Start. Starting sets
   * it true; stopping sets it false; `SetScriptEnabled` changes it explicitly.
   */
  enabled: Schema.Boolean,
  /** Increments on every worker generation; 0 means it has never run. */
  generation: Schema.Number,
  updatedAt: Schema.Number,
  lastError: Schema.optionalKey(Schema.String),
});
export type ScriptSummary = typeof ScriptSummary.Type;

export const ParamOptionSource = Schema.Struct({
  integration: Schema.String,
  slot: Schema.String,
  source: Schema.String,
});
export type ParamOptionSource = typeof ParamOptionSource.Type;

/**
 * A parameter as the UI sees it: the declaration from the manifest plus the
 * current value (or the declared default). `options` is filled for enums whose
 * values are known statically; `optionsSource` is filled for enums resolved
 * from a live connection (for example OBS scenes).
 */
export const ParamView = Schema.Struct({
  key: Schema.String,
  type: ParamType,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  default: Schema.optionalKey(ParamValue),
  value: Schema.optionalKey(ParamValue),
  required: Schema.Boolean,
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  optionsSource: Schema.optionalKey(ParamOptionSource),
  /** Present when the value cannot be used, for example a missing required param. */
  error: Schema.optionalKey(Schema.String),
});
export type ParamView = typeof ParamView.Type;

export const ManifestConnection = Schema.Struct({
  integration: Schema.String,
  slot: Schema.String,
  location: ConnectionLocation,
  /** The connection this slot is bound to, if the user has bound one. */
  connectionId: Schema.optionalKey(Schema.String),
  connectionStatus: Schema.optionalKey(ConnectionStatus),
});
export type ManifestConnection = typeof ManifestConnection.Type;

export const ManifestTopic = Schema.Struct({
  integration: Schema.String,
  slot: Schema.String,
  topic: Schema.String,
  scopes: Schema.Array(Schema.String),
  onStale: Schema.Literals(["drop", "deliver"]),
  maxAgeMs: Schema.Number,
  /** Transport-specific conditions, such as Twitch EventSub conditions. */
  condition: Schema.optionalKey(Schema.Json),
});
export type ManifestTopic = typeof ManifestTopic.Type;

export const ManifestRequest = Schema.Struct({
  integration: Schema.String,
  slot: Schema.String,
  request: Schema.String,
  scopes: Schema.Array(Schema.String),
});
export type ManifestRequest = typeof ManifestRequest.Type;

export const UnresolvedEntry = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
});
export type UnresolvedEntry = typeof UnresolvedEntry.Type;

/**
 * The declarative view of a planned script. This mirrors
 * `@ballast/core`'s `Manifest` on the wire so the protocol package does not
 * depend on the script runtime. The agent maps one to the other at its edge.
 */
export const ScriptManifest = Schema.Struct({
  params: Schema.Array(ParamView),
  connections: Schema.Array(ManifestConnection),
  topics: Schema.Array(ManifestTopic),
  requests: Schema.Array(ManifestRequest),
  unresolved: Schema.Array(UnresolvedEntry),
});
export type ScriptManifest = typeof ScriptManifest.Type;

/** One node of a future graph view. The v1 UI ignores these. */
export const GraphNode = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["trigger", "request", "handler", "param", "state"]),
});
export type GraphNode = typeof GraphNode.Type;

export const GraphEdge = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  label: Schema.optionalKey(Schema.String),
});
export type GraphEdge = typeof GraphEdge.Type;

export const GraphView = Schema.Struct({
  nodes: Schema.Array(GraphNode),
  edges: Schema.Array(GraphEdge),
});
export type GraphView = typeof GraphView.Type;

/**
 * How the UI should present a script. `kind` is `"script"` in v1. A graph
 * view is a presentation of the same manifest, so adding graphs later only
 * populates `graph` (and switches `kind`) rather than changing the manifest.
 */
export const ScriptView = Schema.Struct({
  kind: Schema.Literals(["script", "graph"]),
  graph: Schema.optionalKey(GraphView),
});
export type ScriptView = typeof ScriptView.Type;

export const ManifestDiff = Schema.Struct({
  requiresConsent: Schema.Boolean,
  added: Schema.Struct({
    connections: Schema.Array(ManifestConnection),
    topics: Schema.Array(ManifestTopic),
    requests: Schema.Array(ManifestRequest),
    scopes: Schema.Array(Schema.String),
    params: Schema.Array(ParamView),
  }),
  removed: Schema.Struct({
    connections: Schema.Array(ManifestConnection),
    topics: Schema.Array(ManifestTopic),
    requests: Schema.Array(ManifestRequest),
    scopes: Schema.Array(Schema.String),
    params: Schema.Array(ParamView),
  }),
});
export type ManifestDiff = typeof ManifestDiff.Type;

export const ConsentReason = Schema.Literals(["scopes", "connections", "both"]);
export type ConsentReason = typeof ConsentReason.Type;

/**
 * A plan that adds scopes or connection slots and is waiting for the user.
 * Approving applies the plan and starts the new generation; rejecting keeps
 * the applied manifest and the old generation running.
 */
export const ConsentRequest = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  scriptId: Schema.String,
  scriptName: Schema.String,
  createdAt: Schema.Number,
  reason: ConsentReason,
  /** A one-line explanation suitable for a notification. */
  summary: Schema.String,
  diff: ManifestDiff,
});
export type ConsentRequest = typeof ConsentRequest.Type;

export const ScriptDetail = Schema.Struct({
  summary: ScriptSummary,
  manifest: ScriptManifest,
  /** The manifest that was applied and is currently running, if any. */
  appliedManifest: Schema.optionalKey(ScriptManifest),
  appliedAt: Schema.optionalKey(Schema.Number),
  /** Set while the latest plan is waiting for consent. */
  pendingConsent: Schema.optionalKey(ConsentRequest),
  view: ScriptView,
});
export type ScriptDetail = typeof ScriptDetail.Type;

export const emptyManifest = (): ScriptManifest => ({
  params: [],
  connections: [],
  topics: [],
  requests: [],
  unresolved: [],
});

export const scriptView = (graph?: GraphView): ScriptView =>
  graph === undefined ? { kind: "script" } : { kind: "graph", graph };
