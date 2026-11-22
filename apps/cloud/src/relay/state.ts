import { Schema } from "effect";

import {
  DEFAULT_MAX_BUFFERED_EVENTS,
  DEFAULT_RETENTION_MS,
  EventEnvelope,
  type RelayServerMessage,
} from "@ballast/cloud-protocol";

export const StoredRelayEvent = Schema.Struct({
  seq: Schema.Number,
  envelope: EventEnvelope,
  receivedAt: Schema.Number,
  ackedAt: Schema.NullOr(Schema.Number),
  droppedAt: Schema.NullOr(Schema.Number),
  deliveredAt: Schema.NullOr(Schema.Number),
});
export type StoredRelayEvent = typeof StoredRelayEvent.Type;

export const RelaySnapshot = Schema.Struct({
  nextSeq: Schema.Number,
  events: Schema.Array(StoredRelayEvent),
  /** Event id -> first time it was accepted, for duplicate suppression. */
  seen: Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
});
export type RelaySnapshot = typeof RelaySnapshot.Type;

export const emptyRelaySnapshot: RelaySnapshot = { nextSeq: 1, events: [], seen: [] };

export interface RelayOptions {
  readonly retentionMs?: number;
  readonly maxBufferedEvents?: number;
}

const options = (input: RelayOptions | undefined) => ({
  retentionMs: input?.retentionMs ?? DEFAULT_RETENTION_MS,
  maxBufferedEvents: input?.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS,
});

const prune = (
  snapshot: RelaySnapshot,
  now: number,
  retentionMs: number,
  maxBufferedEvents: number,
): RelaySnapshot => {
  const cutoff = now - retentionMs;
  const retained = snapshot.events
    .filter((event) => event.receivedAt >= cutoff)
    .sort((left, right) => left.seq - right.seq);
  const events = maxBufferedEvents > 0 ? retained.slice(-maxBufferedEvents) : [];
  const seen = snapshot.seen.filter(([, at]) => at >= cutoff);
  return { nextSeq: snapshot.nextSeq, events, seen };
};

export interface EnqueueResult {
  readonly duplicate: boolean;
  readonly seq: number | null;
}

/**
 * Accept one event into the relay buffer. The event id is the dedupe key, so a
 * provider retry (Twitch repeats the same EventSub message id) is a no-op.
 */
export const enqueueEvent = (
  snapshot: RelaySnapshot,
  envelope: EventEnvelope,
  now: number,
  input?: RelayOptions,
): { readonly snapshot: RelaySnapshot; readonly result: EnqueueResult } => {
  const { retentionMs, maxBufferedEvents } = options(input);
  if (snapshot.seen.some(([id]) => id === envelope.id))
    return { snapshot, result: { duplicate: true, seq: null } };

  const seq = snapshot.nextSeq;
  const event: StoredRelayEvent = {
    seq,
    envelope,
    receivedAt: now,
    ackedAt: null,
    droppedAt: null,
    deliveredAt: null,
  };
  const next = prune(
    {
      nextSeq: seq + 1,
      events: [...snapshot.events, event],
      seen: [...snapshot.seen, [envelope.id, now]],
    },
    now,
    retentionMs,
    maxBufferedEvents,
  );
  return { snapshot: next, result: { duplicate: false, seq } };
};

export interface PendingEvent {
  readonly seq: number;
  readonly envelope: EventEnvelope;
  readonly stale: boolean;
}

/**
 * Events to send to a freshly connected agent. Stale events are either
 * dropped (the subscription's `onStale: "drop"`) or delivered once with
 * `stale: true`. Acked events are never replayed.
 */
export const pendingEvents = (
  snapshot: RelaySnapshot,
  now: number,
  input?: RelayOptions,
): { readonly snapshot: RelaySnapshot; readonly events: ReadonlyArray<PendingEvent> } => {
  const { retentionMs, maxBufferedEvents } = options(input);
  const messages: Array<PendingEvent> = [];
  const events = snapshot.events.map((event) => {
    if (event.ackedAt !== null || event.droppedAt !== null) return event;
    const age = now - event.receivedAt;
    if (age > event.envelope.maxAgeMs) {
      if (event.envelope.onStale === "drop") {
        return { ...event, droppedAt: now };
      }
      messages.push({ seq: event.seq, envelope: event.envelope, stale: true });
      return { ...event, deliveredAt: event.deliveredAt ?? now };
    }
    messages.push({ seq: event.seq, envelope: event.envelope, stale: false });
    return { ...event, deliveredAt: event.deliveredAt ?? now };
  });
  return {
    snapshot: prune({ ...snapshot, events }, now, retentionMs, maxBufferedEvents),
    events: messages,
  };
};

export const ackEvents = (
  snapshot: RelaySnapshot,
  seqs: ReadonlyArray<number>,
  now: number,
): RelaySnapshot => {
  const acked = new Set(seqs);
  return {
    ...snapshot,
    events: snapshot.events.map((event) =>
      acked.has(event.seq) && event.ackedAt === null ? { ...event, ackedAt: now } : event,
    ),
  };
};

export const pruneRelay = (
  snapshot: RelaySnapshot,
  now: number,
  input?: RelayOptions,
): RelaySnapshot => {
  const { retentionMs, maxBufferedEvents } = options(input);
  return prune(snapshot, now, retentionMs, maxBufferedEvents);
};

export const pendingCount = (snapshot: RelaySnapshot): number =>
  snapshot.events.filter((event) => event.ackedAt === null && event.droppedAt === null).length;

export const eventMessage = (event: PendingEvent): RelayServerMessage => ({
  _tag: "event",
  seq: event.seq,
  envelope: event.envelope,
  stale: event.stale,
});
