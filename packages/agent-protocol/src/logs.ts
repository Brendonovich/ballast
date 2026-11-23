import { Schema } from "effect";

import { UnitKind } from "./project.ts";

export const LogLevel = Schema.Literals(["debug", "info", "warn", "error"]);
export type LogLevel = typeof LogLevel.Type;

export const LogSource = Schema.Literals(["agent", "worker", "connection", "cloud"]);
export type LogSource = typeof LogSource.Type;

/**
 * One line in the service's ring buffer. `seq` is global and monotonic, so a
 * client can resume after a reconnect with `afterSeq`. Entries are kept in
 * memory for the current service run; persistence comes with the project store.
 */
export const LogEntry = Schema.Struct({
  seq: Schema.Number,
  at: Schema.Number,
  level: LogLevel,
  source: LogSource,
  message: Schema.String,
  projectId: Schema.optionalKey(Schema.String),
  /** Legacy script id; project-mode logs use the unit fields instead. */
  scriptId: Schema.optionalKey(Schema.String),
  unitKind: Schema.optionalKey(UnitKind),
  unitName: Schema.optionalKey(Schema.String),
  /** Structured context, for example `{ topic, connectionId }`. */
  fields: Schema.optionalKey(Schema.Json),
});
export type LogEntry = typeof LogEntry.Type;

export const StreamLogsRequest = Schema.Struct({
  projectId: Schema.optionalKey(Schema.String),
  scriptId: Schema.optionalKey(Schema.String),
  unitKind: Schema.optionalKey(UnitKind),
  unitName: Schema.optionalKey(Schema.String),
  afterSeq: Schema.optionalKey(Schema.Number),
  levels: Schema.optionalKey(Schema.Array(LogLevel)),
  /** Replay at most this many buffered entries before following live output. */
  limit: Schema.optionalKey(Schema.Number),
});
export type StreamLogsRequest = typeof StreamLogsRequest.Type;

export const EventDirection = Schema.Literals(["inbound", "outbound"]);
export type EventDirection = typeof EventDirection.Type;

/**
 * An event as the inspector sees it: either something delivered to a script
 * (inbound) or a request a script made (outbound). `seq` is global and
 * monotonic for resume; `id` is the stable envelope id used for dedupe.
 */
export const EventRecord = Schema.Struct({
  seq: Schema.Number,
  id: Schema.String,
  at: Schema.Number,
  direction: EventDirection,
  integration: Schema.String,
  topic: Schema.String,
  connectionId: Schema.optionalKey(Schema.String),
  projectId: Schema.optionalKey(Schema.String),
  scriptId: Schema.optionalKey(Schema.String),
  unitKind: Schema.optionalKey(UnitKind),
  unitName: Schema.optionalKey(Schema.String),
  payload: Schema.Json,
  /** Set when the relay delivered an event past its freshness window. */
  stale: Schema.optionalKey(Schema.Boolean),
  /** Set when the agent dropped the event before delivery (stale or no subscriber). */
  dropped: Schema.optionalKey(Schema.Boolean),
  /** For outbound records, the request name; for inbound, absent. */
  request: Schema.optionalKey(Schema.String),
});
export type EventRecord = typeof EventRecord.Type;

export const StreamEventsRequest = Schema.Struct({
  projectId: Schema.optionalKey(Schema.String),
  scriptId: Schema.optionalKey(Schema.String),
  unitKind: Schema.optionalKey(UnitKind),
  unitName: Schema.optionalKey(Schema.String),
  integration: Schema.optionalKey(Schema.String),
  topic: Schema.optionalKey(Schema.String),
  afterSeq: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
});
export type StreamEventsRequest = typeof StreamEventsRequest.Type;
