import { Schema } from "effect";

import type { Timestamp } from "./common.ts";

/** The API version the service and its clients must agree on. */
export const AGENT_API_VERSION = 1;

export const ServiceInfo = Schema.Struct({
  name: Schema.Literal("ballast-agent"),
  /** The agent build, for example `0.1.0-dev.20261122`. */
  version: Schema.String,
  apiVersion: Schema.Literal(AGENT_API_VERSION),
  pid: Schema.Number,
  startedAt: Schema.Number,
  /** The first project added, for clients that need a landing project. */
  defaultProjectId: Schema.optionalKey(Schema.String),
  stateDir: Schema.String,
  dataDir: Schema.String,
  platform: Schema.Literals(["darwin", "win32", "linux"]),
  arch: Schema.String,
  nodeVersion: Schema.String,
  /**
   * Feature flags a client can use to hide unsupported screens. Unknown values
   * must be ignored; treat the list as open-ended.
   */
  capabilities: Schema.Array(Schema.String),
});
export type ServiceInfo = typeof ServiceInfo.Type;

export const HealthStatus = Schema.Struct({
  ok: Schema.Boolean,
  /** The service build, matching `ServiceInfo.version` and `/health`. */
  version: Schema.optionalKey(Schema.String),
  /** The API version, matching `/health` and `ServiceInfo.apiVersion`. */
  apiVersion: Schema.optionalKey(Schema.Literal(AGENT_API_VERSION)),
  pid: Schema.optionalKey(Schema.Number),
  uptimeMs: Schema.Number,
  projects: Schema.Struct({
    total: Schema.Number,
  }),
  scripts: Schema.Struct({
    total: Schema.Number,
    running: Schema.Number,
    needsConsent: Schema.Number,
    error: Schema.Number,
  }),
  connections: Schema.Struct({
    total: Schema.Number,
    connected: Schema.Number,
    error: Schema.Number,
  }),
  cloud: Schema.Literals(["unlinked", "linking", "linked", "error"]),
  lastLogSeq: Schema.Number,
  lastEventSeq: Schema.Number,
});
export type HealthStatus = typeof HealthStatus.Type;

/** A coarse, human-readable summary used by the titlebar and tray menu. */
export const ServiceSummary = Schema.Struct({
  health: HealthStatus,
  info: ServiceInfo,
});
export type ServiceSummary = typeof ServiceSummary.Type;

export interface UptimeInput {
  readonly startedAt: Timestamp;
  readonly now: Timestamp;
}

export const uptimeMs = (input: UptimeInput): number =>
  Math.max(0, input.now - input.startedAt);
