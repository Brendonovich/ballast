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
        script: { id: "obs-scene" },
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
            scopes: [],
            onStale: "drop",
            maxAgeMs: 60_000,
          },
        ],
        requests: [{ integration: "obs", slot: "main", request: "obs/*", scopes: [] }],
        unresolved: [],
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
