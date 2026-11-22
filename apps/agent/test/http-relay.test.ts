import { createServer } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import type { RelayServerMessage } from "@ballast/cloud-protocol";
import { WebhookRelay } from "@ballast/module-http/driver";
import { CloudLink } from "../src/service/cloud-link.ts";
import type { CloudLinkService } from "../src/service/cloud-link.ts";
import { WebhookRelayAgentLive } from "../src/service/http-relay.ts";

const startServer = (): Effect.Effect<
  { readonly url: string; readonly bodies: Array<string>; readonly close: () => Promise<void> },
  Error,
  import("effect/Scope").Scope
> =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ url: string; bodies: Array<string>; close: () => Promise<void> }>(
          (resolve, reject) => {
            const bodies: Array<string> = [];
            const server = createServer((request, response) => {
              let body = "";
              request.on("data", (chunk) => {
                body += chunk.toString();
              });
              request.on("end", () => {
                bodies.push(body);
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ hooks: [] }));
              });
            });
            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (address === null || typeof address === "string") {
                reject(new Error("no address"));
                return;
              }
              resolve({
                url: "http://127.0.0.1:" + address.port,
                bodies,
                close: () => new Promise<void>((done) => server.close(() => done())),
              });
            });
          },
        ),
    ),
    (server) => Effect.promise(() => server.close()),
  );

const fakeCloud = (baseUrl: string) => {
  let listener: ((message: RelayServerMessage) => Effect.Effect<void>) | undefined;
  const service: CloudLinkService = {
    status: Effect.succeed({ state: "linked" as const }),
    api: Effect.succeed(undefined),
    relay: Effect.succeed({
      ready: Effect.void,
      listen: (next: (message: RelayServerMessage) => Effect.Effect<void>) =>
        Effect.sync(() => {
          listener = next;
        }),
    }),
    beginPairing: () => Effect.die("unused"),
    pair: () => Effect.die("unused"),
    unpair: () => Effect.die("unused"),
    credentials: Effect.succeed({ baseUrl, machineToken: "token", machineId: "machine" }),
    noteEvent: () => Effect.void,
    fail: () => Effect.void,
    close: () => Effect.void,
  };
  return {
    service,
    send: (message: RelayServerMessage) =>
      listener === undefined ? Effect.void : listener(message),
  };
};

describe("agent webhook relay", () => {
  it.live("registers an empty hook set and routes webhook_delivery frames", () =>
    Effect.scoped(
      Effect.gen(function* () {
                const server = yield* startServer();
                const cloud = fakeCloud(server.url);
        const layer = WebhookRelayAgentLive.pipe(
          Layer.provide(Layer.succeed(CloudLink, cloud.service)),
        );
                const value = yield* Effect.gen(function* () {
                    const relay = yield* WebhookRelay;
                    yield* relay.register([]).pipe(Effect.timeout("3 seconds"));
                    expect(server.bodies).toEqual([JSON.stringify({ hooks: [] })]);
          const collecting = yield* relay.deliveries.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Effect.sleep("50 millis");
          yield* cloud.send({
            _tag: "webhook_delivery",
            seq: 3,
            stale: false,
            delivery: {
              hookId: "hook-000000000000000000000000",
              deliveryId: "delivery-1",
              method: "POST",
              path: "/hooks/kofi",
              query: {},
              headers: {},
              bodyBase64: "e30=",
              receivedAt: Date.now(),
            },
          });
          return yield* Fiber.join(collecting);
        }).pipe(Effect.provide(layer));
        expect(Array.from(value)[0]?.deliveryId).toBe("delivery-1");
      }),
    ),
  );
});
