import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan } from "@ballast/planner";

const example = fileURLToPath(
  new URL("../../../../examples/keyboard-hotkey.ts", import.meta.url),
);
const callRequest = fileURLToPath(new URL("./fixtures/call-request.ts", import.meta.url));

describe("plan keyboard scripts", () => {
  it.effect("records a Hotkey subscription with its canonical combo as the condition", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);
      const hotkey = manifest.topics.find((entry) => entry.topic === "keyboard/Hotkey");

      expect(hotkey?.condition).toEqual({ keys: "Ctrl+Shift+F1", state: "down" });
    }),
  );

  it.effect("kills the plan client when init calls tap", () =>
    Effect.gen(function* () {
      const error = yield* plan(callRequest).pipe(Effect.flip);
      expect(error.message).toContain("RequestCalledDuringPlanError");
    }),
  );
});
