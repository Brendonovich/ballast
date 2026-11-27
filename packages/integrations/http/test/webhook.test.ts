import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { createHmac } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { encodeBase64 } from "../src/base64.ts";
import type { WebhookDefinition } from "../src/index.ts";
import {
  WebhookDriver,
  WebhookRelay,
  webhookLayer,
} from "../src/driver/index.ts";
import type {
  WebhookRegistration,
  WebhookRelayDelivery,
} from "../src/driver/index.ts";

const platformLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const startRuntime = (definitions: ReadonlyArray<WebhookDefinition>) =>
  Effect.gen(function* () {
    const driver = yield* WebhookDriver;
    const runtime = yield* driver.start(definitions);
    const statuses = yield* runtime.statuses;
    const address = statuses[0]?.address;
    if (address === undefined) throw new Error("no local webhook address");
    const match = /^(.*):(\d+)(\/.*)$/.exec(address);
    if (match === null) throw new Error("unexpected address " + address);
    const host = match[1];
    const port = Number(match[2]);
    const path = match[3];
    if (host === undefined || path === undefined || !Number.isFinite(port)) {
      throw new Error("unexpected address " + address);
    }
    return { runtime, host, port, path };
  });

const responseText = (response: Response): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new Error(String(cause)),
  });

const fetchWebhook = (
  url: string,
  headers: Readonly<Record<string, string>>,
  body: string,
) =>
  Effect.tryPromise({
    try: () =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      }),
    catch: (cause) => new Error(String(cause)),
  });

const localDefinition = (overrides: Partial<WebhookDefinition> = {}): WebhookDefinition => ({
  slot: "kofi",
  transport: "local",
  local: { host: "127.0.0.1", port: 0 },
  maxBodyBytes: 1024,
  ...overrides,
});

describe("webhook local listener", () => {
  it.live("delivers a verified request and returns the static response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const definition = localDefinition({
          verification: {
            type: "shared-secret",
            header: "x-kofi-token",
            secret: "s3cret",
          },
          response: { status: 200, body: "ok", contentType: "text/plain" },
        });
        const { runtime, host, port, path } = yield* startRuntime([definition]);

        const rejected = yield* fetchWebhook(
          "http://" + host + ":" + port + path,
          { "x-kofi-token": "wrong" },
          JSON.stringify({ amount: 5 }),
        );
        expect(rejected.status).toBe(401);
        expect(yield* responseText(rejected)).toBe("");

        const deliveryFiber = yield* runtime.deliveries.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const accepted = yield* fetchWebhook(
          "http://" + host + ":" + port + path,
          { "x-kofi-token": "s3cret" },
          JSON.stringify({ amount: 5 }),
        );
        expect(accepted.status).toBe(200);
        expect(yield* responseText(accepted)).toBe("ok");

        const deliveries = Array.from(yield* Fiber.join(deliveryFiber));
        expect(deliveries).toHaveLength(1);
        const delivery = deliveries[0];
        if (delivery === undefined) throw new Error("missing delivery");
        expect(delivery.hook).toBe("kofi");
        expect(delivery.method).toBe("POST");
        expect(delivery.path).toBe(path);
        expect(JSON.parse(new TextDecoder().decode(delivery.body))).toEqual({ amount: 5 });
        expect(delivery.headers["x-kofi-token"]).toBe("s3cret");
      }),
    ).pipe(Effect.provide(webhookLayer), Effect.provide(platformLayer)),
  );

  it.live("verifies HMAC SHA-256 over the raw body and defaults to 204", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secret = "hmac-secret";
        const definition = localDefinition({
          verification: {
            type: "hmac-sha256",
            header: "x-signature",
            secret,
            encoding: "hex",
            prefix: "sha256=",
          },
        });
        const { runtime, host, port, path } = yield* startRuntime([definition]);
        const body = JSON.stringify({ amount: 9 });
        const signature =
          "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

        const deliveryFiber = yield* runtime.deliveries.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const accepted = yield* fetchWebhook(
          "http://" + host + ":" + port + path,
          { "x-signature": signature },
          body,
        );
        expect(accepted.status).toBe(204);
        expect(yield* responseText(accepted)).toBe("");

        const rejected = yield* fetchWebhook(
          "http://" + host + ":" + port + path,
          { "x-signature": "sha256=deadbeef" },
          body,
        );
        expect(rejected.status).toBe(401);
        const deliveries = Array.from(yield* Fiber.join(deliveryFiber));
        expect(deliveries).toHaveLength(1);
      }),
    ).pipe(Effect.provide(webhookLayer), Effect.provide(platformLayer)),
  );
});

describe("webhook cloud mode", () => {
  it.live("registers hooks and receives relayed deliveries", () =>
    Effect.gen(function* () {
      const deliveries = yield* Queue.unbounded<WebhookRelayDelivery>();
      const registered = yield* Ref.make<ReadonlyArray<WebhookRegistration>>([]);
      const unregistered = yield* Ref.make<ReadonlyArray<string>>([]);
      const relay = Layer.succeed(
        WebhookRelay,
        WebhookRelay.of({
          register: (hooks) =>
            Effect.gen(function* () {
              yield* Ref.set(registered, hooks);
              return hooks.map((hook) => ({
                hookId: hook.hookId,
                url: "https://cloud.example/hooks/machine/" + hook.hookId,
              }));
            }),
          unregister: (hookIds) => Ref.set(unregistered, hookIds),
          deliveries: Stream.fromQueue(deliveries),
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* WebhookDriver;
          const runtime = yield* driver.start([
            {
              slot: "kofi",
              hookId: "hook_abc",
              transport: "cloud",
              verification: {
                type: "shared-secret",
                header: "x-kofi-token",
                secret: "s3cret",
              },
              response: { status: 200, body: "ok" },
              cloud: { maxAgeMs: 5000, onStale: "deliver" },
            },
          ]);

          const statuses = yield* runtime.statuses;
          expect(statuses).toEqual([
            {
              slot: "kofi",
              hookId: "hook_abc",
              transport: "cloud",
              status: "registered",
              url: "https://cloud.example/hooks/machine/hook_abc",
            },
          ]);
          expect(yield* Ref.get(registered)).toEqual([
            {
              hookId: "hook_abc",
              maxAgeMs: 5000,
              onStale: "deliver",
              verification: {
                type: "shared-secret",
                header: "x-kofi-token",
                secret: "s3cret",
              },
              response: { status: 200, body: "ok" },
            },
          ]);

          const body = JSON.stringify({ amount: 12 });
          yield* Queue.offer(deliveries, {
            hookId: "hook_abc",
            deliveryId: "delivery-1",
            method: "POST",
            path: "/hooks/kofi",
            query: {},
            headers: { "x-kofi-token": "s3cret" },
            bodyBase64: encodeBase64(new TextEncoder().encode(body)),
            receivedAt: Date.now(),
          });

          const received = Array.from(
            yield* runtime.deliveries.pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.timeout("2 seconds"),
            ),
          );
          expect(received[0]?.id).toBe("delivery-1");
          expect(received[0]?.source).toBe("cloud");
          expect(JSON.parse(new TextDecoder().decode(received[0]?.body))).toEqual({ amount: 12 });

          const dropped = yield* runtime.deliveries.pipe(
            Stream.take(1),
            Stream.runDrain,
            Effect.timeout("200 millis"),
            Effect.exit,
          );
          expect(Exit.isFailure(dropped)).toBe(true);
        }),
      ).pipe(
        Effect.provide(relay),
        Effect.provide(webhookLayer),
        Effect.provide(platformLayer),
      );

      expect(yield* Ref.get(unregistered)).toEqual(["hook_abc"]);
    }),
  );
});
