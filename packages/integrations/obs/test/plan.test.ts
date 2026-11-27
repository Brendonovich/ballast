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
const connectionState = fileURLToPath(
  new URL("./fixtures/connection-state.ts", import.meta.url),
);

describe("plan OBS script", () => {
  it.effect("records a single obs/* request grant for every OBS request", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);

      expect(manifest.requests).toEqual([
        { integration: "obs", slot: "main", request: "obs/*", scopes: [] },
      ]);
    }),
  );

  it.effect("records OBS connection state with history off", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(connectionState);

      expect(manifest.topics).toEqual([
        {
          integration: "obs",
          slot: "main",
          topic: "obs/ConnectionState",
          name: "obs-state",
          scopes: [],
          onStale: "drop",
          maxAgeMs: 60_000,
          history: false,
          schemaFingerprint: expect.any(String),
        },
      ]);
    }),
  );

  it.effect("kills the plan client when init calls a request", () =>
    Effect.gen(function* () {
      const error = yield* plan(callRequest).pipe(Effect.flip);
      expect(error.message).toContain("RequestCalledDuringPlanError");
    }),
  );
});
