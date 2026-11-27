import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RpcTest } from "effect/rpc";

import { AgentRpcs, ConnectionSummary, MockAgentLayer, ProjectDetail } from "../src/index.ts";

const client = RpcTest.makeClient(AgentRpcs).pipe(
  Effect.provide(MockAgentLayer),
);

describe("@ballast/agent-protocol RPC group", () => {
  it.effect("round-trips project details and connections through JSON", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const detail = yield* agent.GetProject({ projectId: "proj_main" });
      const encodedDetail = Schema.encodeSync(Schema.fromJsonString(ProjectDetail))(detail);
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(ProjectDetail))(encodedDetail)).toEqual(
        detail,
      );

      const [connection] = (yield* agent.ListConnections()).connections;
      if (connection === undefined) return;
      const encodedConnection = Schema.encodeSync(
        Schema.fromJsonString(ConnectionSummary),
      )(connection);
      expect(
        Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionSummary))(encodedConnection),
      ).toEqual(connection);
    }),
  );
});
