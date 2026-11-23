import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan } from "@ballast/planner";

const example = fileURLToPath(new URL("../../../../examples/webhook-to-obs.ts", import.meta.url));

describe("plan HTTP scripts", () => {
  it.effect("records webhook, host and OBS capabilities", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);

      expect(manifest.project).toEqual({ id: "webhook-to-obs", entry: "webhook-to-obs.ts" });
      expect(manifest.connections).toEqual([
        { integration: "http", slot: "kofi", location: "either" },
        { integration: "http", slot: "kofi-api", location: "local" },
        { integration: "obs", slot: "main", location: "local" },
      ]);
      expect(manifest.topics).toEqual([
        {
          integration: "http",
          slot: "kofi",
          topic: "http/webhook",
          name: "donation",
          scopes: ["http:webhook:kofi"],
          onStale: "drop",
          maxAgeMs: 60_000,
          history: { maxEntries: 1000, retentionMs: 7 * 24 * 60 * 60_000 },
          schemaFingerprint: expect.any(String),
          condition: { hook: "kofi" },
        },
      ]);
      expect(manifest.requests).toEqual([
        {
          integration: "http",
          slot: "kofi-api",
          request: "http/request",
          scopes: ["http:host:api.example.com"],
        },
        { integration: "obs", slot: "main", request: "obs/*", scopes: [] },
      ]);
      expect(manifest.params).toEqual([
        {
          key: "scene",
          type: "string",
          title: "Scene",
          options: { integration: "obs", slot: "main", source: "scenes" },
        },
      ]);
    }),
  );
});
