import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { Schema } from "effect";

import {
  ArtifactCancelTimerInput,
  ArtifactEvent,
  ArtifactEventHistoryInput,
  ArtifactEventHistoryResult,
  ArtifactEventsInput,
  ArtifactLogLine,
  ArtifactLogsInput,
  ArtifactParam,
  ArtifactProject,
  ArtifactSetParamInput,
  ArtifactTimers,
  ArtifactUnit,
  ArtifactWorkflows,
} from "./artifacts.ts";

export const ArtifactErrorReason = Schema.Literals([
  "forbidden",
  "invalid",
  "not-found",
  "reloading",
  "internal",
]);
export type ArtifactErrorReason = typeof ArtifactErrorReason.Type;

export const ArtifactError = Schema.TaggedStruct("ArtifactError", {
  reason: ArtifactErrorReason,
  message: Schema.String,
});
export type ArtifactError = typeof ArtifactError.Type;

/**
 * Built-in metadata procedures on the artifact gateway. Custom project API
 * procedures share the socket; these names are reserved.
 */
export const ArtifactMetadataRpcs = RpcGroup.make(
  Rpc.make("Project", {
    success: ArtifactProject,
    error: ArtifactError,
  }),
  Rpc.make("Units", {
    success: Schema.Array(ArtifactUnit),
    error: ArtifactError,
  }),
  Rpc.make("Params", {
    success: Schema.Array(ArtifactParam),
    error: ArtifactError,
  }),
  Rpc.make("Logs", {
    payload: ArtifactLogsInput,
    stream: true,
    success: ArtifactLogLine,
    error: ArtifactError,
  }),
  Rpc.make("Events", {
    payload: ArtifactEventsInput,
    stream: true,
    success: ArtifactEvent,
    error: ArtifactError,
  }),
  /** Read-only durable history for one subscription, newest first. */
  Rpc.make("EventHistory", {
    payload: ArtifactEventHistoryInput,
    success: ArtifactEventHistoryResult,
    error: ArtifactError,
  }),
  Rpc.make("Timers", {
    success: ArtifactTimers,
    error: ArtifactError,
  }),
  Rpc.make("Workflows", {
    success: ArtifactWorkflows,
    error: ArtifactError,
  }),
  Rpc.make("SetParam", {
    payload: ArtifactSetParamInput,
    success: Schema.Void,
    error: ArtifactError,
  }),
  Rpc.make("CancelTimer", {
    payload: ArtifactCancelTimerInput,
    success: Schema.Boolean,
    error: ArtifactError,
  }),
);
export type ArtifactMetadataRpcs = typeof ArtifactMetadataRpcs;

export const ARTIFACT_METADATA_PROCEDURES: ReadonlySet<string> = new Set(
  ArtifactMetadataRpcs.requests.keys(),
);
