import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan } from "@ballast/planner";

const example = fileURLToPath(
  new URL("../../../../examples/obs-scene.ts", import.meta.url),
);
const callRequest = fileURLToPath(
  new URL("./fixtures/call-request.ts", import.meta.url),
);

describe("plan OBS script", () => {
  it.effect("records one obs/* request grant and the typed topic", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);

      expect(manifest).toEqual({
        project: { id: "obs-scene", entry: "obs-scene.ts" },
        params: [
          {
            key: "scene",
            type: "string",
            options: { integration: "obs", slot: "main", source: "scenes" },
          },
        ],
        connections: [{ integration: "obs", slot: "main", location: "local" }],
        topics: [
          {
            integration: "obs",
            slot: "main",
            topic: "obs/CurrentProgramSceneChanged",
            name: "scene-changed",
            scopes: [],
            onStale: "drop",
            maxAgeMs: 60_000,
            history: { maxEntries: 1000, retentionMs: 7 * 24 * 60 * 60_000 },
            schemaFingerprint: expect.any(String),
          },
        ],
        requests: [{ integration: "obs", slot: "main", request: "obs/*", scopes: [] }],
        unresolved: [],
        timers: [],
        workflows: [],
        runs: [{ name: "scene-loop" }],
        artifacts: [],
        stores: [],
        databases: [],
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
