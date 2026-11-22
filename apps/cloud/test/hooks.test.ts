import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Result, Schema } from "effect";
import { WebSocket, WebSocketServer } from "ws";

import {
  RelayClientMessage,
  encodeRelayServerMessage,
  type RelayServerMessage,
} from "@ballast/cloud-protocol";

import {
  ackMessages,
  emptyRelaySnapshot,
  enqueueWebhook,
  pendingCount,
  pendingMessages,
  webhookMessage,
  type RelaySnapshot,
} from "../src/relay/state.ts";
import type { RelayGatewayService } from "../src/relay/gateway.ts";
import { makeTestApp } from "./support/test-app.ts";

const hookId = "N3xAbcdefghijklmnopqrstuv";
const hookId2 = "Q7zAbcdefghijklmnopqrstuv";

class MemoryHookRelay {
  private snapshots = new Map<string, RelaySnapshot>();
  private sockets = new Map<string, WebSocket>();

  readonly gateway: RelayGatewayService = {
    enqueueEvent: (_machineId, _envelope) => Effect.void,
    notify: () => Effect.void,
    enqueueWebhook: (machineId, delivery, policy) =>
      Effect.sync(() => {
        const next = enqueueWebhook(this.snapshot(machineId), delivery, policy, Date.now());
        this.snapshots.set(machineId, next.snapshot);
        const socket = this.sockets.get(machineId);
        if (socket !== undefined && next.result.seq !== null) {
          socket.send(
            encodeRelayServerMessage({
              _tag: "webhook_delivery",
              seq: next.result.seq,
              stale: false,
              delivery,
            }),
          );
        }
      }),
  };

  private snapshot(machineId: string): RelaySnapshot {
    return this.snapshots.get(machineId) ?? emptyRelaySnapshot;
  }

  connect(machineId: string, socket: WebSocket): void {
    this.sockets.set(machineId, socket);
    const pending = pendingMessages(this.snapshot(machineId), Date.now());
    this.snapshots.set(machineId, pending.snapshot);
    socket.send(
      encodeRelayServerMessage({
        _tag: "hello",
        machineId,
        serverTime: Date.now(),
        pending: pending.messages.length,
      }),
    );
    for (const message of pending.messages) {
      socket.send(
        encodeRelayServerMessage(
          message._tag === "event"
            ? { _tag: "event", seq: message.event.seq, envelope: message.event.envelope, stale: message.event.stale }
            : webhookMessage(message.webhook),
        ),
      );
    }
  }

  message(machineId: string, data: string): void {
    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(RelayClientMessage))(data);
    if (decoded._tag === "ack")
      this.snapshots.set(
        machineId,
        ackMessages(this.snapshot(machineId), decoded.seqs, Date.now()),
      );
  }

  pending(machineId: string): number {
    return pendingCount(this.snapshot(machineId));
  }
}

const waitFor = async <A>(
  values: ReadonlyArray<A>,
  predicate: (value: A) => boolean,
): Promise<A> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const found = values.find(predicate);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for a relay message");
};

const headerRecord = (headers: Readonly<Record<string, string | string[] | undefined>>) =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      typeof value === "string"
        ? [[name.toLowerCase(), value] as const]
        : Array.isArray(value)
          ? [[name.toLowerCase(), value.join(",")] as const]
          : [],
    ),
  );

const register = (
  test: Awaited<ReturnType<typeof makeTestApp>>,
  token: string,
  hooks: ReadonlyArray<unknown>,
) =>
  test.request({
    method: "POST",
    path: "/api/hooks/register",
    headers: { authorization: `Bearer ${token}` },
    body: { hooks },
  });

const unregister = (
  test: Awaited<ReturnType<typeof makeTestApp>>,
  token: string,
  hookIds: ReadonlyArray<string>,
) =>
  test.request({
    method: "POST",
    path: "/api/hooks/unregister",
    headers: { authorization: `Bearer ${token}` },
    body: { hookIds },
  });

const postHook = (
  test: Awaited<ReturnType<typeof makeTestApp>>,
  machineId: string,
  id: string,
  options: {
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly method?: string;
  } = {},
) =>
  test.request({
    method: options.method ?? "POST",
    path: `/hooks/${machineId}/${id}`,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.body === undefined ? {} : { rawBody: options.body }),
  });

const hmac = (
  secret: string,
  timestamp: string | undefined,
  body: string,
  encoding: "hex" | "base64",
): string => {
  const digest = createHmac("sha256", secret);
  digest.update(timestamp === undefined ? body : timestamp + "." + body);
  return digest.digest(encoding);
};

describe("cloud hook registration", () => {
  it("replaces the full set, returns URLs and never leaks secrets", async () => {
    const test = await makeTestApp();
    const machine = await test.seedMachine("user-1");
    const created = await register(test, machine.token, [
      {
        hookId,
        label: "Ko-fi",
        verification: { type: "shared-secret", header: "x-kofi-token", secret: "super-secret" },
        response: { status: 200, body: "ok", headers: { "x-hook": "yes" } },
      },
      { hookId: hookId2 },
    ]);
    expect(created.status).toBe(200);
    expect(JSON.parse(created.body ?? "{}")).toEqual({
      hooks: [
        { hookId, url: `http://localhost:1338/hooks/${machine.machineId}/${hookId}` },
        { hookId: hookId2, url: `http://localhost:1338/hooks/${machine.machineId}/${hookId2}` },
      ],
    });

    const listed = await test.request({
      method: "GET",
      path: "/api/hooks",
      headers: { authorization: `Bearer ${machine.token}` },
    });
    expect(listed.status).toBe(200);
    expect(listed.body).not.toContain("super-secret");

    const replaced = await register(test, machine.token, [{ hookId: hookId2 }]);
    expect(replaced.status).toBe(200);
    const rows = await Effect.runPromise(test.store.listHooks(machine.machineId));
    expect(rows.map((row) => row.hookId)).toEqual([hookId2]);

    const cleared = await register(test, machine.token, []);
    expect(cleared.status).toBe(200);
    expect(await Effect.runPromise(test.store.listHooks(machine.machineId))).toHaveLength(0);

    await register(test, machine.token, [{ hookId: hookId2 }]);
    const removed = await unregister(test, machine.token, [hookId2]);
    expect(removed.status).toBe(204);
    expect(await Effect.runPromise(test.store.listHooks(machine.machineId))).toHaveLength(0);
  });

  it("rejects malformed ids, duplicates and oversized sets", async () => {
    const test = await makeTestApp();
    const machine = await test.seedMachine("user-1");
    expect((await register(test, machine.token, [{ hookId: "short" }])).status).toBe(400);
    expect(
      (await register(test, machine.token, [{ hookId }, { hookId }])).status,
    ).toBe(400);
    expect(
      (
        await register(
          test,
          machine.token,
          Array.from({ length: 33 }, (_, index) => ({
            hookId: "A".repeat(21) + String(index % 10),
          })),
        )
      ).status,
    ).toBe(400);
  });

  it("returns a generic 404 for unknown or malformed hooks", async () => {
    const test = await makeTestApp();
    const machine = await test.seedMachine("user-1");
    expect((await postHook(test, machine.machineId, hookId)).status).toBe(404);
    expect((await postHook(test, "m_unknown", hookId)).status).toBe(404);
    expect((await postHook(test, machine.machineId, "bad")).status).toBe(404);
  });
});

describe("cloud hook ingress", () => {
  it("verifies shared secrets and HMAC signatures", async () => {
    const test = await makeTestApp();
    const machine = await test.seedMachine("user-1");
    const shared = await register(test, machine.token, [
      {
        hookId,
        verification: { type: "shared-secret", header: "x-hook-secret", secret: "shared" },
      },
      {
        hookId: hookId2,
        verification: {
          type: "hmac-sha256",
          header: "x-hook-signature",
          secret: "hmac-secret",
          encoding: "hex",
          prefix: "sha256=",
          timestampHeader: "x-hook-timestamp",
          toleranceSeconds: 30,
        },
        response: { status: 200, body: "accepted", contentType: "text/plain" },
      },
    ]);
    expect(shared.status).toBe(200);

    expect(
      (
        await postHook(test, machine.machineId, hookId, {
          headers: { "x-hook-secret": "wrong" },
          body: "hello",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await postHook(test, machine.machineId, hookId, {
          headers: { "x-hook-secret": "shared" },
          body: "hello",
        })
      ).status,
    ).toBe(204);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = "sha256=" + hmac("hmac-secret", timestamp, "hello", "hex");
    const accepted = await postHook(test, machine.machineId, hookId2, {
      headers: { "x-hook-signature": signature, "x-hook-timestamp": timestamp },
      body: "hello",
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toBe("accepted");
    expect(accepted.headers?.["content-type"]).toBe("text/plain");

    expect(
      (
        await postHook(test, machine.machineId, hookId2, {
          headers: { "x-hook-signature": signature, "x-hook-timestamp": timestamp },
          body: "tampered",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await postHook(test, machine.machineId, hookId2, {
          headers: {
            "x-hook-signature": "sha256=" + hmac("hmac-secret", "1", "hello", "hex"),
            "x-hook-timestamp": "1",
          },
          body: "hello",
        })
      ).status,
    ).toBe(401);
  });

  it("rejects oversized bodies with 413", async () => {
    const test = await makeTestApp();
    const machine = await test.seedMachine("user-1");
    await register(test, machine.token, [{ hookId }]);
    const oversized = await postHook(test, machine.machineId, hookId, {
      body: "x".repeat(64 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
  });

  it("rate-limits per hook with Retry-After", async () => {
    const test = await makeTestApp();
    const machine = await test.seedMachine("user-1");
    await register(test, machine.token, [{ hookId }]);
    for (let request = 0; request < 60; request++) {
      const response = await postHook(test, machine.machineId, hookId);
      expect(response.status).toBe(204);
    }
    const limited = await postHook(test, machine.machineId, hookId);
    expect(limited.status).toBe(429);
    expect(limited.headers?.["retry-after"]).toBe("60");
  });
});

describe("cloud hook relay delivery", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it(
    "delivers buffered and live hooks over the relay WebSocket and honors acks",
    async () => {
      const relay = new MemoryHookRelay();
      const test = await makeTestApp({ relay: relay.gateway });
      const machine = await test.seedMachine("user-1");
      await register(test, machine.token, [
        {
          hookId,
          maxAgeMs: 60_000,
          onStale: "drop",
          response: { status: 202, body: "queued" },
        },
      ]);

      const offline = await postHook(test, machine.machineId, hookId, {
        body: "offline-body",
        headers: { "content-type": "text/plain", "x-provider": "kofi" },
      });
      expect(offline.status).toBe(202);
      expect(offline.body).toBe("queued");
      expect(relay.pending(machine.machineId)).toBe(1);

      const wss = new WebSocketServer({ noServer: true });
      let port = 0;
      const server = createServer(async (request, response) => {
        const chunks: Array<Uint8Array> = [];
        for await (const chunk of request) chunks.push(new Uint8Array(chunk));
        const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
        const result = await Effect.runPromise(
          test.app.fetch({
            method: request.method ?? "GET",
            url: `http://127.0.0.1:${port}${request.url ?? "/"}`,
            headers: headerRecord(request.headers),
            body: new Uint8Array(body),
          }),
        );
        response.writeHead(result.status, result.headers ?? {});
        response.end(result.body);
      });

      server.on("upgrade", async (request, socket, head) => {
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
        const prefix = "/relay/";
        if (!url.pathname.startsWith(prefix)) {
          socket.destroy();
          return;
        }
        const machineId = decodeURIComponent(url.pathname.slice(prefix.length));
        const auth = await Effect.runPromise(
          test.app
            .authenticateMachine({
              method: "GET",
              url: url.toString(),
              headers: headerRecord(request.headers),
              body: new Uint8Array(),
            })
            .pipe(Effect.result),
        );
        if (Result.isFailure(auth) || auth.success.id !== machineId) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          relay.connect(machineId, ws);
          ws.on("message", (data) => relay.message(machineId, data.toString()));
        });
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
      servers.push({
        close: () =>
          new Promise<void>((resolve) => {
            wss.close();
            server.close(() => resolve());
          }),
      });

      const messages: Array<RelayServerMessage> = [];
      const connect = async () => {
        const client = new WebSocket(`ws://127.0.0.1:${port}/relay/${machine.machineId}`, {
          headers: { authorization: `Bearer ${machine.token}` },
        });
        client.on("message", (data) => {
          messages.push(JSON.parse(data.toString()) as RelayServerMessage);
        });
        await new Promise<void>((resolve, reject) => {
          client.once("open", resolve);
          client.once("error", reject);
        });
        return client;
      };

      const first = await connect();
      const hello = await waitFor(messages, (message) => message._tag === "hello");
      if (hello._tag !== "hello") throw new Error("Expected hello");
      expect(hello.pending).toBe(1);
      const buffered = await waitFor(
        messages,
        (message) => message._tag === "webhook_delivery",
      );
      if (buffered._tag !== "webhook_delivery") throw new Error("Expected delivery");
      expect(buffered.delivery.hookId).toBe(hookId);
      expect(Buffer.from(buffered.delivery.bodyBase64, "base64").toString()).toBe("offline-body");
      expect(buffered.delivery.headers["x-provider"]).toBe("kofi");
      expect(buffered.stale).toBe(false);

      first.send(JSON.stringify({ _tag: "ack", seqs: [buffered.seq] }));
      for (let attempt = 0; attempt < 100 && relay.pending(machine.machineId) > 0; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(relay.pending(machine.machineId)).toBe(0);
      first.close();

      const live = await postHook(test, machine.machineId, hookId, { body: "live-body" });
      expect(live.status).toBe(202);
      const second = await connect();
      const secondHello = await waitFor(
        messages.filter((message) => message._tag === "hello").slice(-1),
        () => true,
      );
      if (secondHello._tag !== "hello") throw new Error("Expected hello");
      expect(secondHello.pending).toBe(1);
      const delivered = await waitFor(
        messages.filter((message) => message._tag === "webhook_delivery"),
        (message) =>
          message._tag === "webhook_delivery" &&
          Buffer.from(message.delivery.bodyBase64, "base64").toString() === "live-body",
      );
      if (delivered._tag !== "webhook_delivery") throw new Error("Expected delivery");
      second.send(JSON.stringify({ _tag: "ack", seqs: [delivered.seq] }));
      second.close();
    },
    20_000,
  );
});
