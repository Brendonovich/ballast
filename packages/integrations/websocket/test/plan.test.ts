import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan } from "@ballast/planner";

const example = fileURLToPath(new URL("../../../../examples/ws-bridge.ts", import.meta.url));

describe("plan WebSocket scripts", () => {
  it.effect("records client/server namespaces and scoped listen/connect capabilities", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);

      expect(manifest.project).toEqual({ id: "ws-bridge", entry: "ws-bridge.ts" });
      expect(manifest.connections).toEqual([
        { integration: "websocket", slot: "bridge", location: "local" },
        { integration: "websocket", slot: "upstream", location: "local" },
      ]);
      expect(manifest.topics.map((topic) => topic.slot + ":" + topic.topic)).toEqual([
        "bridge:websocket/server/message",
        "upstream:websocket/message",
      ]);
      expect(
        manifest.requests.map((request) => ({
          request: request.integration + "/" + request.slot + "/" + request.request,
          scopes: request.scopes,
        })),
      ).toEqual([
        { request: "websocket/bridge/websocket/*", scopes: [] },
        {
          request: "websocket/bridge/websocket/listen",
          scopes: ["ws:listen:127.0.0.1:1890/bridge"],
        },
        { request: "websocket/upstream/websocket/*", scopes: [] },
        {
          request: "websocket/upstream/websocket/connect",
          scopes: ["ws:connect:*"],
        },
      ]);
    }),
  );
});
