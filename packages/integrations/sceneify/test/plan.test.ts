import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import type { ArtifactHost } from "@ballast/core";
import { Effect } from "effect";
import { plan } from "@ballast/planner";

const sceneifyExample = fileURLToPath(
  new URL("../../../../examples/obs-sceneify.ts", import.meta.url),
);
const alertOverlay = fileURLToPath(
  new URL("../../../../examples/obs-alert-overlay/ballast.ts", import.meta.url),
);
const syncInInit = fileURLToPath(
  new URL("./fixtures/sync-in-init.ts", import.meta.url),
);

describe("plan Sceneify scripts", () => {
  it.effect("declaring scenes records no grants beyond obs/*", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(sceneifyExample);
      expect(manifest.requests).toEqual([
        { integration: "obs", slot: "main", request: "obs/*", scopes: [] },
      ]);
    }),
  );

  it.effect("reads the artifact URL in init when an artifact host is present", () =>
    Effect.gen(function* () {
      const artifactHost: ArtifactHost = {
        origin: "http://127.0.0.1:47831",
        stableToken: "a1.obs-alert-overlay.test",
      };
      const manifest = yield* plan(alertOverlay, { artifactHost });

      expect(manifest.artifacts).toMatchObject([
        { name: "alerts", entry: "./artifacts/alerts/main.ts", title: "Alert overlay" },
      ]);
      expect(manifest.unresolved).toEqual([]);
    }),
  );

  it.effect("records an unresolved artifact when planning without an artifact host", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(alertOverlay);

      expect(manifest.unresolved).toEqual([
        expect.objectContaining({ path: "artifact:alerts" }),
      ]);
      expect(manifest.unresolved[0]?.reason).toContain("no URL while planning");
    }),
  );

  it.effect("kills the plan client when init syncs a declared scene", () =>
    Effect.gen(function* () {
      const error = yield* plan(syncInInit).pipe(Effect.flip);
      expect(error.message).toContain("RequestCalledDuringPlanError");
    }),
  );
});
