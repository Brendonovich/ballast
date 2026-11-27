import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan } from "@ballast/planner";

const example = fileURLToPath(new URL("../../../../examples/ws-bridge.ts", import.meta.url));

describe("plan WebSocket scripts", () => {
  it.effect("scopes connect and listen grants to their declared targets", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);

      expect(
        manifest.requests.map((request) => ({
          request: request.integration + "/" + request.slot + "/" + request.request,
          scopes: request.scopes,
        })),
      ).toEqual([
        { request: "websocket-client/upstream/websocket/*", scopes: [] },
        {
          request: "websocket-client/upstream/websocket/connect",
          scopes: ["ws:connect:*"],
        },
        { request: "websocket-server/bridge/websocket/*", scopes: [] },
        {
          request: "websocket-server/bridge/websocket/listen",
          scopes: ["ws:listen:127.0.0.1:1890/bridge"],
        },
      ]);
    }),
  );
});
