import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Default durable event-history policy for a subscription. */
export const DEFAULT_HISTORY_MAX_ENTRIES = 1000;
export const DEFAULT_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export const HistoryPolicySchema = Schema.Struct({
  maxEntries: Schema.Number,
  retentionMs: Schema.Number,
});
export type HistoryPolicy = Schema.Schema.Type<typeof HistoryPolicySchema>;

export const HistoryPolicyManifestSchema = Schema.Union([
  HistoryPolicySchema,
  Schema.Literal(false),
]);
export type HistoryPolicyManifest = Schema.Schema.Type<typeof HistoryPolicyManifestSchema>;

/** A stored inbound event, before the worker decodes it against the current schema. */
export const HistoryRecordSchema = Schema.Struct({
  cursor: Schema.String,
  receivedAt: Schema.Number,
  fingerprint: Schema.String,
  event: Schema.Unknown,
});
export type HistoryRecord = Schema.Schema.Type<typeof HistoryRecordSchema>;

export interface HistoryQuery {
  readonly limit?: number;
  readonly before?: string;
  /** Include entries whose schema fingerprint differs from the current topic. */
  readonly includeLegacy?: boolean;
}

export type HistoryEntry<A> =
  | {
      readonly _tag: "Event";
      readonly cursor: string;
      readonly receivedAt: number;
      readonly event: A;
    }
  | {
      readonly _tag: "Legacy";
      readonly cursor: string;
      readonly receivedAt: number;
      readonly raw: unknown;
      readonly fingerprint: string;
    };

/** Internal service the worker uses to persist and watch subscription history. */
export interface EventHistoryHostService {
  readonly record: (input: {
    readonly name: string;
    readonly fingerprint: string;
    readonly event: Schema.Json;
  }) => Effect.Effect<void>;
  readonly query: (input: {
    readonly name: string;
    readonly limit: number;
    readonly before?: string;
  }) => Effect.Effect<ReadonlyArray<HistoryRecord>>;
  readonly watch: (name: string) => Effect.Effect<import("effect/PubSub").PubSub<HistoryRecord>>;
}
