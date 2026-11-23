import { createServer } from "node:http";
import { Effect, Fiber, Layer } from "effect";
import * as Deferred from "effect/Deferred";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { NodeHttpServer } from "@effect/platform-node";
import { GetServiceInfo } from "@ballast/agent-protocol";
import type { ServiceInfo } from "@ballast/agent-protocol";
import { describe, expect, it } from "vitest";

import { makeAgentGateway } from "../src/client.ts";

const serviceInfo: ServiceInfo = {
  name: "ballast-agent",
  version: "0.1.0-old",
  apiVersion: 1,
  pid: process.pid,
  startedAt: 0,
  stateDir: "/tmp/ballast-old/state",
  dataDir: "/tmp/ballast-old/data",
  platform:
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "win32"
        : "linux",
  arch: process.arch,
  nodeVersion: process.version,
  capabilities: ["projects", "connections", "logs", "events", "consent"],
};

describe("stale service RPCs", () => {
  it("reports an unknown request tag as an older service", async () => {
    const port = Deferred.makeUnsafe<number>();
    const group = RpcGroup.make(GetServiceInfo);
    const handlers = group.toLayer({
      GetServiceInfo: () => Effect.succeed(serviceInfo),
    });

    const app = HttpRouter.use((router) =>
      Effect.gen(function* () {
        yield* router.add(
          "GET",
          "/health",
          HttpServerResponse.jsonUnsafe({
            ok: true,
            apiVersion: 1,
            version: serviceInfo.version,
          }),
        );
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (!("port" in address) || typeof address.port !== "number") {
          return yield* Effect.fail(new Error("server has no port"));
        }
        yield* Deferred.succeed(port, address.port);
        const protocol = yield* RpcServer.makeProtocolWebsocket({ path: "/rpc" });
        yield* RpcServer.make(group).pipe(
          Effect.provideService(RpcServer.Protocol, protocol),
          Effect.forkScoped,
        );
        yield* HttpServer.serveEffect()(router.asHttpEffect());
      }),
    );

    const layer = app.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeHttpServer.layer(() => createServer(), {
            host: "127.0.0.1",
            port: 0,
          }),
          HttpRouter.layer,
          RpcSerialization.layerJson,
          handlers,
        ),
      ),
    );

    const fiber = Effect.runFork(
      Layer.launch(layer).pipe(
        Effect.tapCause((cause) => Effect.logError("fake server stopped", cause)),
      ),
    );

    try {
      const boundPort = await Effect.runPromise(Deferred.await(port));
      const gateway = makeAgentGateway({
        config: {
          dataDir: undefined,
          stateDir: undefined,
          serviceUrl: "http://127.0.0.1:" + boundPort,
          serviceToken: "test",
        },
        env: {},
        platform: process.platform,
        home: process.cwd(),
      });
      const error = await Effect.runPromise(
        Effect.flip(gateway.listArtifacts("proj_test")),
      );
      expect(error.kind).toBe("unsupported-service");
      expect(error.feature).toBe("ListArtifacts");
      expect(error.serviceVersion).toBe("0.1.0-old");
      expect(error.message).toContain(
        "The running Ballast service (version 0.1.0-old) is older than this MCP and lacks project artifact support (ListArtifacts).",
      );
      expect(error.message).toContain("Restart the Ballast app");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  }, 30_000);
});
