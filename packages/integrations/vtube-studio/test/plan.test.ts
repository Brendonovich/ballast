import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan } from "@ballast/planner";

const example = fileURLToPath(new URL("../../../../examples/vts-hotkey.ts", import.meta.url));
const callRequest = fileURLToPath(new URL("./fixtures/call-request.ts", import.meta.url));

describe("plan VTube Studio script", () => {
  it.effect("records the vts/* request grant, hotkey param and configured topic", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);

      expect(manifest).toEqual({
        script: { id: "vts-hotkey" },
        params: [
          {
            key: "hotkey",
            type: "string",
            title: "Hotkey",
            options: { integration: "vts", slot: "main", source: "hotkeys" },
          },
        ],
        connections: [{ integration: "vts", slot: "main", location: "local" }],
        topics: [
          {
            integration: "vts",
            slot: "main",
            topic: "vts/HotkeyTriggered",
            name: "hotkey-triggered",
            scopes: [],
            onStale: "drop",
            maxAgeMs: 60_000,
            condition: { config: '{"ignoreHotkeysTriggeredByAPI":true}' },
          },
        ],
        requests: [{ integration: "vts", slot: "main", request: "vts/*", scopes: [] }],
        unresolved: [],
        timers: [],
        workflows: [],
        runs: [{ name: "hotkey-loop" }],
      });
    }),
  );

  it.effect("kills the plan client when init calls a request", () =>
    Effect.gen(function* () {
      const error = yield* plan(callRequest).pipe(Effect.flip);
      expect(error.message).toContain("RequestCalledDuringPlanError");
    }),
  );
});
