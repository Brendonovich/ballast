import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan } from "@ballast/planner";

const example = fileURLToPath(new URL("../../../../examples/midi-cc.ts", import.meta.url));
const callRequest = fileURLToPath(new URL("./fixtures/call-request.ts", import.meta.url));

describe("plan MIDI scripts", () => {
  it.effect("records the device option source, topics and midi namespace", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);

      expect(manifest).toEqual({
        project: { id: "midi-cc", entry: "midi-cc.ts" },
        params: [
          {
            key: "output",
            type: "string",
            title: "MIDI output",
            options: { integration: "midi", slot: "controller", source: "outputs" },
          },
        ],
        connections: [{ integration: "midi", slot: "controller", location: "local" }],
        topics: [
          {
            integration: "midi",
            slot: "controller",
            topic: "midi/ControlChange",
            name: "control-change",
            scopes: [],
            onStale: "drop",
            maxAgeMs: 60_000,
            history: false,
            schemaFingerprint: expect.any(String),
          },
          {
            integration: "midi",
            slot: "controller",
            topic: "midi/RawMessage",
            name: "raw-message",
            scopes: [],
            onStale: "drop",
            maxAgeMs: 60_000,
            history: false,
            schemaFingerprint: expect.any(String),
          },
        ],
        requests: [
          { integration: "midi", slot: "controller", request: "midi/*", scopes: [] },
        ],
        unresolved: [],
        timers: [],
        workflows: [],
        runs: [],
        artifacts: [],
        stores: [],
        databases: [],
      });
    }),
  );

  it.effect("kills the plan client when init sends a note", () =>
    Effect.gen(function* () {
      const error = yield* plan(callRequest).pipe(Effect.flip);
      expect(error.message).toContain("RequestCalledDuringPlanError");
    }),
  );
});
