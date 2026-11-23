import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { McpConfig } from "../src/config.ts";
import { discoverService } from "../src/discovery.ts";

const roots: Array<string> = [];

const tempDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "ballast-mcp-discovery-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const config = (stateDir: string | undefined): McpConfig => ({
  stateDir,
  dataDir: undefined,
  serviceUrl: undefined,
  serviceToken: undefined,
});

const options = (stateDir: string | undefined) => ({
  config: config(stateDir),
  env: {},
  platform: "darwin" as NodeJS.Platform,
  home: "/Users/nobody",
});

const listen = async (): Promise<{ url: string; close: () => Promise<void> }> => {
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, apiVersion: 1 }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port");
  return {
    url: "http://127.0.0.1:" + address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

describe("discovery", () => {
  it("reads service.json and verifies /health", async () => {
    const state = await tempDir();
    const healthy = await listen();
    try {
      await writeFile(
        join(state, "service.json"),
        JSON.stringify({
          schemaVersion: 1,
          apiVersion: 1,
          name: "ballast-agent",
          version: "0.1.0",
          url: healthy.url,
          token: "token",
          pid: process.pid,
          startedAt: Date.now(),
        }),
      );
      const found = await Effect.runPromise(discoverService(options(state)));
      expect(found.url).toBe(healthy.url);
      expect(found.token).toBe("token");
      expect(found.source).toBe(state);
    } finally {
      await healthy.close();
    }
  });

  it("reports a clear error when no service is running", async () => {
    const state = await tempDir();
    const error = await Effect.runPromise(
      Effect.flip(discoverService(options(state))),
    );
    expect(error.message).toContain("Ballast is not running");
    expect(error.message).toContain("ballast serve");
    expect(error.tried).toContain(state);
  });

  it("reports a stale service.json instead of hanging", async () => {
    const state = await tempDir();
    await writeFile(
      join(state, "service.json"),
      JSON.stringify({
        schemaVersion: 1,
        apiVersion: 1,
        name: "ballast-agent",
        version: "0.1.0",
        url: "http://127.0.0.1:1",
        token: "token",
        pid: 999999,
        startedAt: Date.now(),
      }),
    );
    const error = await Effect.runPromise(
      Effect.flip(discoverService(options(state))),
    );
    expect(error.message).toContain("pid 999999 is not responding");
  });

  it("rejects non-loopback explicit URLs", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        discoverService({
          ...options(undefined),
          config: {
            stateDir: undefined,
            dataDir: undefined,
            serviceUrl: "http://example.com",
            serviceToken: "token",
          },
        }),
      ),
    );
    expect(error.message).toContain("loopback");
  });

  it("requires both explicit URL and token", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        discoverService({
          ...options(undefined),
          config: {
            stateDir: undefined,
            dataDir: undefined,
            serviceUrl: "http://127.0.0.1:1234",
            serviceToken: undefined,
          },
        }),
      ),
    );
    expect(error.message).toContain("must be set together");
  });
});
