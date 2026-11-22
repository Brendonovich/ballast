import { describe, expect, it } from "vitest";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Layer } from "effect";

import type { EventEnvelope } from "@ballast/cloud-protocol";

import {
  RelayBuffer,
  RelayError,
  layerMemoryRelayState,
  layerRelayBuffer,
} from "../src/relay/buffer.ts";
import {
  ackEvents,
  emptyRelaySnapshot,
  enqueueEvent,
  pendingCount,
  pendingEvents,
  pruneRelay,
} from "../src/relay/state.ts";

const envelope = (id: string, overrides: Partial<EventEnvelope> = {}): EventEnvelope => ({
  id,
  integration: "twitch",
  topic: "twitch/channel.cheer",
  connectionId: "account-1",
  occurredAt: 1_000,
  receivedAt: 1_000,
  payload: { bits: 100 },
  onStale: "drop",
  maxAgeMs: 60_000,
  ...overrides,
});

describe("relay state", () => {
  it("assigns increasing sequence numbers and dedupes by event id", () => {
    const first = enqueueEvent(emptyRelaySnapshot, envelope("e1"), 1_000);
    expect(first.result).toEqual({ duplicate: false, seq: 1 });
    const second = enqueueEvent(first.snapshot, envelope("e2"), 1_001);
    expect(second.result).toEqual({ duplicate: false, seq: 2 });
    const duplicate = enqueueEvent(second.snapshot, envelope("e1"), 1_002);
    expect(duplicate.result).toEqual({ duplicate: true, seq: null });
    expect(duplicate.snapshot.events).toHaveLength(2);
    expect(pendingCount(duplicate.snapshot)).toBe(2);
  });

  it("drops stale events when onStale is drop", () => {
    const enqueued = enqueueEvent(emptyRelaySnapshot, envelope("e1", { maxAgeMs: 5_000 }), 1_000);
    const pending = pendingEvents(enqueued.snapshot, 10_000);
    expect(pending.events).toHaveLength(0);
    expect(pending.snapshot.events[0]?.droppedAt).toBe(10_000);
    expect(pendingCount(pending.snapshot)).toBe(0);
  });

  it("delivers stale events once when onStale is deliver", () => {
    const enqueued = enqueueEvent(
      emptyRelaySnapshot,
      envelope("e1", { maxAgeMs: 5_000, onStale: "deliver" }),
      1_000,
    );
    const pending = pendingEvents(enqueued.snapshot, 10_000);
    expect(pending.events).toEqual([
      expect.objectContaining({ seq: 1, stale: true }),
    ]);
    const again = pendingEvents(pending.snapshot, 11_000);
    expect(again.events).toHaveLength(1);
    expect(again.events[0]?.stale).toBe(true);
    // The event stays unacked until the agent acknowledges it.
    expect(pendingCount(again.snapshot)).toBe(1);
  });

  it("acknowledges only unacked events", () => {
    const first = enqueueEvent(emptyRelaySnapshot, envelope("e1"), 1_000);
    const second = enqueueEvent(first.snapshot, envelope("e2"), 1_001);
    const acked = ackEvents(second.snapshot, [1, 99], 2_000);
    expect(acked.events[0]?.ackedAt).toBe(2_000);
    expect(acked.events[1]?.ackedAt).toBeNull();
    expect(pendingCount(acked)).toBe(1);
    expect(pendingEvents(acked, 2_001).events.map((event) => event.seq)).toEqual([2]);
  });

  it("prunes events and dedupe entries after the retention window", () => {
    const first = enqueueEvent(emptyRelaySnapshot, envelope("e1"), 1_000);
    const second = enqueueEvent(first.snapshot, envelope("e2"), 1_001);
    const pruned = pruneRelay(second.snapshot, 1_001 + 86_400_001, { retentionMs: 86_400_000 });
    expect(pruned.events).toHaveLength(0);
    expect(pruned.seen).toHaveLength(0);
  });

  it("evicts the oldest events when the buffer is full", () => {
    let snapshot = emptyRelaySnapshot;
    for (let index = 0; index < 5; index++) {
      snapshot = enqueueEvent(snapshot, envelope(`e${index}`), 1_000 + index, {
        maxBufferedEvents: 3,
      }).snapshot;
    }
    expect(snapshot.events.map((event) => event.envelope.id)).toEqual(["e2", "e3", "e4"]);
    expect(snapshot.nextSeq).toBe(6);
  });
});

const testRuntimeContext = RuntimeContext.of({
  Type: "test",
  id: "test",
  env: {},
  get: () => Effect.succeed(undefined),
  set: () => Effect.succeed("test"),
});

describe("relay buffer service", () => {
  const run = <A>(effect: Effect.Effect<A, RelayError, RelayBuffer | RuntimeContext>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(layerRelayBuffer().pipe(Layer.provide(layerMemoryRelayState()))),
        Effect.provideService(RuntimeContext, testRuntimeContext),
      ),
    );

  it("persists events and acks across service calls", async () => {
    const result = await run(
      Effect.gen(function* () {
        const buffer = yield* RelayBuffer;
        const first = yield* buffer.enqueue(envelope("e1"));
        const duplicate = yield* buffer.enqueue(envelope("e1"));
        const pending = yield* buffer.pending;
        yield* buffer.ack([1]);
        const count = yield* buffer.count;
        return { first, duplicate, pending, count };
      }),
    );
    expect(result.first).toEqual({ duplicate: false, seq: 1 });
    expect(result.duplicate).toEqual({ duplicate: true, seq: null });
    expect(result.pending).toHaveLength(1);
    expect(result.count).toBe(0);
  });
});
