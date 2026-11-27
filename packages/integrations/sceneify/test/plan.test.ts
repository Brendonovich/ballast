import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import type { ArtifactHost } from "@ballast/core";
import { Effect } from "effect";
import { plan } from "@ballast/planner";

const sceneifyExample = fileURLToPath(
  new URL("../../../../examples/obs-sceneify.ts", import.meta.url),
);
const sceneifyStream = fileURLToPath(
  new URL("../../../../examples/sceneify-stream/ballast.ts", import.meta.url),
);
const alertOverlay = fileURLToPath(
  new URL("../../../../examples/obs-alert-overlay/ballast.ts", import.meta.url),
);
const syncInInit = fileURLToPath(
  new URL("./fixtures/sync-in-init.ts", import.meta.url),
);

describe("plan Sceneify scripts", () => {
  it.effect("bundles declared scenes without recording extra grants", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(sceneifyExample);
      expect(manifest).toMatchObject({
        project: { id: "obs-sceneify", entry: "obs-sceneify.ts" },
        params: [{ key: "message", type: "string", title: "Banner text", default: "BRB" }],
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
          },
        ],
        requests: [{ integration: "obs", slot: "main", request: "obs/*", scopes: [] }],
        timers: [],
        runs: [],
        artifacts: [],
        stores: [],
      });
    }),
  );

  it.effect("plans the multi-file sceneify-stream project", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(sceneifyStream);
      expect(manifest.connections).toEqual([
        { integration: "obs", slot: "main", location: "local" },
        { integration: "twitch", slot: "broadcaster", location: "either" },
      ]);
      expect(manifest.topics.map((topic) => topic.name).sort()).toEqual([
        "alert-video-ended",
        "chat-commands",
        "cheer",
        "follow",
        "raid",
        "stream-online",
        "subscribe",
      ]);
      expect(manifest.requests.map((request) => request.request)).toEqual([
        "obs/*",
        "helix/sendChatMessage",
      ]);
      expect(manifest.timers.map((timer) => timer.name).sort()).toEqual(["go-live", "hype-off"]);
      expect(manifest.runs.map((run) => run.name)).toEqual(["sync-layout"]);
      expect(manifest.params.map((param) => param.key)).toHaveLength(8);
    }),
  );

  it.effect("reads the artifact URL in init when an artifact host is present", () =>
    Effect.gen(function* () {
      const artifactHost: ArtifactHost = {
        origin: "http://127.0.0.1:47831",
        readToken: "r1.obs-alert-overlay.test",
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
