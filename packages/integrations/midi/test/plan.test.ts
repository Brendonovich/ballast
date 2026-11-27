import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan } from "@ballast/planner";

const example = fileURLToPath(new URL("../../../../examples/midi-cc.ts", import.meta.url));
const callRequest = fileURLToPath(new URL("./fixtures/call-request.ts", import.meta.url));

describe("plan MIDI scripts", () => {
  it.effect("grants the whole midi/* request namespace and records the outputs option source", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);

      expect(manifest.requests).toEqual([
        { integration: "midi", slot: "controller", request: "midi/*", scopes: [] },
      ]);
      expect(manifest.params[0]?.options).toEqual({
        integration: "midi",
        slot: "controller",
        source: "outputs",
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
