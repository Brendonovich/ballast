import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { AgentEventBus } from "../src/event-bus.ts";
import { bundleScript } from "../src/bundle.ts";
import { startRuntimeSession } from "../src/runtime-session.ts";
import type { RuntimeSettings } from "../src/runtime-session.ts";

const fixture = fileURLToPath(new URL("./fixtures/tick-report.ts", import.meta.url));
const tickKey = "fake/main/fake/tick";

const settings: RuntimeSettings = {
  get: (key) => (key === "prefix" ? "test" : undefined),
};

const request = (requests: Queue.Queue<string>) => (
  _integration: string,
  _request: string,
  _slot: string,
  input: unknown,
) => {
  const text =
    typeof input === "object" && input !== null && "text" in input
      ? String(input.text)
      : "";
  Queue.offerUnsafe(requests, text);
  return Effect.succeed({ text });
};

describe("runtime worker", () => {
  it.live(
    "routes each tick to exactly one active generation after a swap",
    () =>
      Effect.gen(function* () {
        const requests = yield* Queue.unbounded<string>();
        const bus = new AgentEventBus();

        const bundleA = yield* bundleScript(fixture, 0).pipe(
          Effect.mapError((error) => new Error(error.message)),
        );
        const sessionA = yield* Effect.acquireRelease(
          startRuntimeSession({
            bundlePath: bundleA.path,
            generation: 0,
            settings,
            request: request(requests),
          }),
          (session) => session.close,
        );
        yield* sessionA.ready;
        bus.setActive(sessionA);

        bus.publish(tickKey, { n: 1 });
        expect(yield* Queue.take(requests)).toBe("test tick 1");

        const bundleB = yield* bundleScript(fixture, 1).pipe(
          Effect.mapError((error) => new Error(error.message)),
        );
        const sessionB = yield* Effect.acquireRelease(
          startRuntimeSession({
            bundlePath: bundleB.path,
            generation: 1,
            settings,
            request: request(requests),
          }),
          (session) => session.close,
        );
        yield* sessionB.ready;

        // Swap first, then publish while the old worker is still alive. Only
        // the active generation may receive the tick.
        bus.setActive(sessionB);
        bus.publish(tickKey, { n: 2 });
        expect(yield* Queue.take(requests)).toBe("test tick 2");

        const extra = yield* Queue.take(requests).pipe(
          Effect.timeoutOption("300 millis"),
        );
        expect(Option.isNone(extra)).toBe(true);

        yield* sessionA.close;
      }),
    20_000,
  );
});
