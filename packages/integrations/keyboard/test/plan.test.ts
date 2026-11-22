import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan } from "@ballast/planner";

const example = fileURLToPath(
  new URL("../../../../examples/keyboard-hotkey.ts", import.meta.url),
);
const callRequest = fileURLToPath(new URL("./fixtures/call-request.ts", import.meta.url));

describe("plan keyboard scripts", () => {
  it.effect("records the connection, KeyDown, a filtered Hotkey and the tap request", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);

      expect(manifest).toEqual({
        script: { id: "keyboard-hotkey" },
        params: [],
        connections: [{ integration: "keyboard", slot: "main", location: "local" }],
        topics: [
          {
            integration: "keyboard",
            slot: "main",
            topic: "keyboard/Hotkey",
            scopes: [],
            onStale: "drop",
            maxAgeMs: 60_000,
            condition: { keys: "Ctrl+Shift+F1", state: "down" },
          },
          {
            integration: "keyboard",
            slot: "main",
            topic: "keyboard/KeyDown",
            scopes: [],
            onStale: "drop",
            maxAgeMs: 60_000,
          },
        ],
        requests: [{ integration: "keyboard", slot: "main", request: "keyboard/tap", scopes: [] }],
        unresolved: [],
      });
    }),
  );

  it.effect("kills the plan client when init calls tap", () =>
    Effect.gen(function* () {
      const error = yield* plan(callRequest).pipe(Effect.flip);
      expect(error.message).toContain("RequestCalledDuringPlanError");
    }),
  );
});
