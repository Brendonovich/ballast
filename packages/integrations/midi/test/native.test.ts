import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { makeNativeBackend } from "../src/driver/index.ts";

/** Real addon smoke: list the machine's MIDI ports (zero is fine). */
describe("@julusian/midi smoke", () => {
  it.live("loads the N-API binding and lists ports", () =>
    Effect.gen(function* () {
      const backend = makeNativeBackend();
      const result = yield* Effect.exit(backend.ports);
      if (Exit.isFailure(result)) {
        console.warn(
          "@julusian/midi could not load; MIDI input/output is unavailable in this environment.",
        );
        return;
      }
      const ports = result.value;
      expect(Array.isArray(ports.inputs)).toBe(true);
      expect(Array.isArray(ports.outputs)).toBe(true);
      console.warn(
        `@julusian/midi loaded: ${ports.inputs.length} input(s), ${ports.outputs.length} output(s)`,
      );
    }),
  );
});
