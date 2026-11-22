import { Schema } from "effect";

import {
  DEFAULT_MAX_BUFFERED_EVENTS,
  DEFAULT_RETENTION_MS,
  EventEnvelope,
  type RelayServerMessage,
  type WebhookRelayDelivery,
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

export const StoredRelayWebhook = Schema.Struct({
  seq: Schema.Number,
  delivery: Schema.Struct({
    hookId: Schema.String,
    deliveryId: Schema.String,
    method: Schema.String,
    path: Schema.String,
    query: Schema.Record(Schema.String, Schema.String),
    headers: Schema.Record(Schema.String, Schema.String),
    bodyBase64: Schema.String,
    receivedAt: Schema.Number,
  }),
  maxAgeMs: Schema.Number,
  onStale: Schema.Literals(["drop", "deliver"]),
  receivedAt: Schema.Number,
  ackedAt: Schema.NullOr(Schema.Number),
  droppedAt: Schema.NullOr(Schema.Number),
  deliveredAt: Schema.NullOr(Schema.Number),
});
export type StoredRelayWebhook = typeof StoredRelayWebhook.Type;

export const RelaySnapshot = Schema.Struct({
  nextSeq: Schema.Number,
  events: Schema.Array(StoredRelayEvent),
  webhooks: Schema.Array(StoredRelayWebhook),
  /** Event id -> first time it was accepted, for duplicate suppression. */
  seen: Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
});
export type RelaySnapshot = typeof RelaySnapshot.Type;

export const emptyRelaySnapshot: RelaySnapshot = {
  nextSeq: 1,
  events: [],
  webhooks: [],
  seen: [],
};

export interface RelayOptions {
  readonly retentionMs?: number;
  readonly maxBufferedEvents?: number;
}

const options = (input: RelayOptions | undefined) => ({
  retentionMs: input?.retentionMs ?? DEFAULT_RETENTION_MS,
  maxBufferedEvents: input?.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS,
});

/** Snapshots persisted before webhooks existed have no webhooks array. */
const webhooksOf = (snapshot: RelaySnapshot): ReadonlyArray<StoredRelayWebhook> =>
  snapshot.webhooks ?? [];

const prune = (
  snapshot: RelaySnapshot,
  now: number,
  retentionMs: number,
  maxBufferedEvents: number,
): RelaySnapshot => {
  const cutoff = now - retentionMs;
  const retainedEvents = snapshot.events
    .filter((event) => event.receivedAt >= cutoff)
    .sort((left, right) => left.seq - right.seq);
  const retainedWebhooks = webhooksOf(snapshot)
    .filter((webhook) => webhook.receivedAt >= cutoff)
    .sort((left, right) => left.seq - right.seq);
  const combined = [
    ...retainedEvents.map((event) => ({ seq: event.seq, kind: "event" as const, event })),
    ...retainedWebhooks.map((webhook) => ({
      seq: webhook.seq,
      kind: "webhook" as const,
      webhook,
    })),
  ].sort((left, right) => left.seq - right.seq);
  const kept = maxBufferedEvents > 0 ? combined.slice(-maxBufferedEvents) : [];
  const events: Array<StoredRelayEvent> = [];
  const webhooks: Array<StoredRelayWebhook> = [];
  for (const entry of kept) {
    if (entry.kind === "event") events.push(entry.event);
    else webhooks.push(entry.webhook);
  }
  const seen = snapshot.seen.filter(([, at]) => at >= cutoff);
  return { nextSeq: snapshot.nextSeq, events, webhooks, seen };
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
      webhooks: [...webhooksOf(snapshot)],
      seen: [...snapshot.seen, [envelope.id, now]],
    },
    now,
    retentionMs,
    maxBufferedEvents,
  );
  return { snapshot: next, result: { duplicate: false, seq } };
};

/** Accept one webhook delivery. Each accepted request is a separate delivery. */
export const enqueueWebhook = (
  snapshot: RelaySnapshot,
  delivery: WebhookRelayDelivery,
  policy: { readonly maxAgeMs: number; readonly onStale: "drop" | "deliver" },
  now: number,
  input?: RelayOptions,
): { readonly snapshot: RelaySnapshot; readonly result: EnqueueResult } => {
  const { retentionMs, maxBufferedEvents } = options(input);
  const seq = snapshot.nextSeq;
  const webhook: StoredRelayWebhook = {
    seq,
    delivery,
    maxAgeMs: policy.maxAgeMs,
    onStale: policy.onStale,
    receivedAt: now,
    ackedAt: null,
    droppedAt: null,
    deliveredAt: null,
  };
  const next = prune(
    {
      nextSeq: seq + 1,
      events: [...snapshot.events],
      webhooks: [...webhooksOf(snapshot), webhook],
      seen: [...snapshot.seen],
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

export interface PendingWebhook {
  readonly seq: number;
  readonly delivery: WebhookRelayDelivery;
  readonly stale: boolean;
}

export type PendingRelayMessage =
  | { readonly _tag: "event"; readonly event: PendingEvent }
  | { readonly _tag: "webhook"; readonly webhook: PendingWebhook };

/**
 * Entries to send to a freshly connected agent. Stale entries are either
 * dropped or delivered once with stale: true, depending on their policy.
 * Acked entries are never replayed.
 */
export const pendingMessages = (
  snapshot: RelaySnapshot,
  now: number,
  input?: RelayOptions,
): {
  readonly snapshot: RelaySnapshot;
  readonly messages: ReadonlyArray<PendingRelayMessage>;
} => {
  const { retentionMs, maxBufferedEvents } = options(input);
  const messages: Array<PendingRelayMessage> = [];
  const events = snapshot.events.map((event) => {
    if (event.ackedAt !== null || event.droppedAt !== null) return event;
    const age = now - event.receivedAt;
    if (age > event.envelope.maxAgeMs) {
      if (event.envelope.onStale === "drop") return { ...event, droppedAt: now };
      messages.push({
        _tag: "event",
        event: { seq: event.seq, envelope: event.envelope, stale: true },
      });
      return { ...event, deliveredAt: event.deliveredAt ?? now };
    }
    messages.push({
      _tag: "event",
      event: { seq: event.seq, envelope: event.envelope, stale: false },
    });
    return { ...event, deliveredAt: event.deliveredAt ?? now };
  });
  const webhooks = webhooksOf(snapshot).map((webhook) => {
    if (webhook.ackedAt !== null || webhook.droppedAt !== null) return webhook;
    const age = now - webhook.receivedAt;
    if (age > webhook.maxAgeMs) {
      if (webhook.onStale === "drop") return { ...webhook, droppedAt: now };
      messages.push({
        _tag: "webhook",
        webhook: { seq: webhook.seq, delivery: webhook.delivery, stale: true },
      });
      return { ...webhook, deliveredAt: webhook.deliveredAt ?? now };
    }
    messages.push({
      _tag: "webhook",
      webhook: { seq: webhook.seq, delivery: webhook.delivery, stale: false },
    });
    return { ...webhook, deliveredAt: webhook.deliveredAt ?? now };
  });
  return {
    snapshot: prune({ ...snapshot, events, webhooks }, now, retentionMs, maxBufferedEvents),
    messages: messages.sort(
      (left, right) =>
        (left._tag === "event" ? left.event.seq : left.webhook.seq) -
        (right._tag === "event" ? right.event.seq : right.webhook.seq),
    ),
  };
};

/** Event-only view retained for existing callers and tests. */
export const pendingEvents = (
  snapshot: RelaySnapshot,
  now: number,
  input?: RelayOptions,
): { readonly snapshot: RelaySnapshot; readonly events: ReadonlyArray<PendingEvent> } => {
  const pending = pendingMessages(snapshot, now, input);
  return {
    snapshot: pending.snapshot,
    events: pending.messages.flatMap((message) =>
      message._tag === "event" ? [message.event] : [],
    ),
  };
};

export const ackMessages = (
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
    webhooks: webhooksOf(snapshot).map((webhook) =>
      acked.has(webhook.seq) && webhook.ackedAt === null
        ? { ...webhook, ackedAt: now }
        : webhook,
    ),
  };
};

/** Event-only ack retained for existing callers and tests. */
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
  snapshot.events.filter((event) => event.ackedAt === null && event.droppedAt === null).length +
  webhooksOf(snapshot).filter((webhook) => webhook.ackedAt === null && webhook.droppedAt === null)
    .length;

export const eventMessage = (event: PendingEvent): RelayServerMessage => ({
  _tag: "event",
  seq: event.seq,
  envelope: event.envelope,
  stale: event.stale,
});

export const webhookMessage = (webhook: PendingWebhook): RelayServerMessage => ({
  _tag: "webhook_delivery",
  seq: webhook.seq,
  stale: webhook.stale,
  delivery: webhook.delivery,
});
