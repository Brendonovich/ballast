import { Schema } from "effect";

/** The lifecycle state of one durable timer instance. */
export const TimerState = Schema.Literals(["pending", "fired", "dropped"]);
export type TimerState = typeof TimerState.Type;

/** One persisted timer instance, as the UI sees it. */
export const TimerSummary = Schema.Struct({
  projectId: Schema.String,
  timer: Schema.String,
  title: Schema.optionalKey(Schema.String),
  key: Schema.String,
  payload: Schema.Json,
  payloadFingerprint: Schema.String,
  scheduledAt: Schema.Number,
  dueAt: Schema.Number,
  onStale: Schema.Literals(["drop", "deliver"]),
  maxAgeMs: Schema.Number,
  state: TimerState,
  lastFiredAt: Schema.optionalKey(Schema.Number),
  lateByMs: Schema.optionalKey(Schema.Number),
});
export type TimerSummary = typeof TimerSummary.Type;

export const ListTimersRequest = Schema.Struct({
  projectId: Schema.optionalKey(Schema.String),
  /** Legacy filter; project-mode timers are project-scoped. */
  scriptId: Schema.optionalKey(Schema.String),
  /** Include fired/dropped rows. Pending only by default. */
  includeFinished: Schema.optionalKey(Schema.Boolean),
});
export type ListTimersRequest = typeof ListTimersRequest.Type;

export const ListTimersResponse = Schema.Struct({
  timers: Schema.Array(TimerSummary),
});
export type ListTimersResponse = typeof ListTimersResponse.Type;

export const CancelTimerRequest = Schema.Struct({
  projectId: Schema.String,
  /** Legacy metadata; ignored by the project-scoped timer store. */
  scriptId: Schema.optionalKey(Schema.String),
  timer: Schema.String,
  key: Schema.String,
});
export type CancelTimerRequest = typeof CancelTimerRequest.Type;

export const CancelTimerResponse = Schema.Struct({
  cancelled: Schema.Boolean,
});
export type CancelTimerResponse = typeof CancelTimerResponse.Type;
