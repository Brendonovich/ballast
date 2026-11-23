import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopConfig } from "../src/main/config.ts";
import {
  adoptService,
  isLoopbackUrl,
  parseRegistration,
  probeHealth,
} from "../src/main/service/registration.ts";
import { configFor } from "./support.ts";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ballast-registration-"));
  roots.push(root);
  return root;
}

async function registryServer(apiVersion: number, needsConsent: number): Promise<{ url: string; pid: number }> {
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          apiVersion,
          version: "1.2.3",
          pid: process.pid,
          projects: { needsConsent },
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  return { url: "http://127.0.0.1:" + address.port, pid: process.pid };
}

async function addRegistration(config: DesktopConfig, url: string, apiVersion = 1): Promise<void> {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(config.stateDir, "service.json"),
    JSON.stringify({
      schemaVersion: 1,
      apiVersion,
      name: "ballast-agent",
      version: "1.2.3",
      url,
      token: "test-token",
      pid: process.pid,
      startedAt: Date.now(),
      defaultProjectId: "proj_main",
    }),
    { mode: 0o600 },
  );
}

describe("service discovery and adoption", () => {
  it("only accepts loopback HTTP registrations", () => {
    expect(isLoopbackUrl("http://127.0.0.1:1234")).toBe(true);
    expect(isLoopbackUrl("http://localhost:1234")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:1234")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.2:1234")).toBe(false);
    expect(isLoopbackUrl("https://example.com")).toBe(false);
    expect(isLoopbackUrl("file:///tmp/service.json")).toBe(false);
  });

  it("adopts a compatible service and exposes health counts, never the token", async () => {
    const root = await temp();
    const config = configFor(root);
    const service = await registryServer(1, 2);
    await addRegistration(config, service.url);

    const adopted = await adoptService(config);
    expect(adopted?.compatible).toBe(true);
    expect(adopted?.registration.version).toBe("1.2.3");
    expect(adopted?.health.pendingConsents).toBe(2);
    expect(adopted?.health.pid).toBe(process.pid);
    expect(JSON.stringify(adopted?.registration)).toContain("test-token");
    expect(adopted?.reason).toBeNull();
  });

  it("refuses a service with a different apiVersion and treats dead ports as stopped", async () => {
    const root = await temp();
    const config = configFor(root);
    const service = await registryServer(2, 0);
    await addRegistration(config, service.url);
    const incompatible = await adoptService(config);
    expect(incompatible?.compatible).toBe(false);
    expect(incompatible?.reason).toContain("apiVersion 2");

    const dead = configFor(await temp());
    await addRegistration(dead, "http://127.0.0.1:9");
    expect(await adoptService(dead)).toBeUndefined();
    expect(await probeHealth("http://127.0.0.1:9", 100)).toBeUndefined();
  });

  it("falls back to the data directory registration and rejects malformed files", async () => {
    const root = await temp();
    const config = configFor(root);
    const service = await registryServer(1, 0);
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(
      path.join(config.dataDir, "service.json"),
      JSON.stringify({
        schemaVersion: 1,
        apiVersion: 1,
        name: "ballast-agent",
        version: "0.9.0",
        url: service.url,
        token: "token",
        pid: process.pid,
        startedAt: Date.now(),
      }),
    );
    expect((await adoptService(config))?.registration.version).toBe("0.9.0");

    expect(parseRegistration({ schemaVersion: 1, name: "ballast-agent" })).toBeUndefined();
    expect(
      parseRegistration({
        schemaVersion: 1,
        apiVersion: 1,
        name: "ballast-agent",
        version: "1",
        url: "http://10.0.0.1:1234",
        token: "t",
        pid: 1,
        startedAt: 1,
      }),
    ).toBeUndefined();
  });
});
