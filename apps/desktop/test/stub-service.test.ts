import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const stubMain = fileURLToPath(new URL("../dev/stub-service/main.mjs", import.meta.url));
const roots: string[] = [];
const children = new Set<ChildProcess>();

interface Stub {
  readonly child: ChildProcess;
  readonly root: string;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly pid: number;
  readonly url: string;
  readonly token: string;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(file);
      return;
    } catch {
      await delay(50);
    }
  }
  throw new Error("timed out waiting for " + file);
}

async function startStub(): Promise<Stub> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ballast-stub-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const dataDir = path.join(root, "data");
  await mkdir(stateDir, { recursive: true });
  const child = spawn(process.execPath, [stubMain, "serve", "--standalone"], {
    env: {
      ...process.env,
      BALLAST_STATE_DIR: stateDir,
      BALLAST_DATA_DIR: dataDir,
      BALLAST_SERVICE_PORT: "0",
      BALLAST_SERVICE_VERSION: "9.9.9-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.on("exit", () => children.delete(child));

  const registrationFile = path.join(stateDir, "service.json");
  await waitForFile(registrationFile);
  const registration: unknown = JSON.parse(await readFile(registrationFile, "utf8"));
  if (
    typeof registration !== "object" ||
    registration === null ||
    !("url" in registration) ||
    !("token" in registration) ||
    !("pid" in registration)
  ) {
    throw new Error("bad registration");
  }
  const url = registration.url;
  const token = registration.token;
  const pid = registration.pid;
  if (typeof url !== "string" || typeof token !== "string" || typeof pid !== "number") {
    throw new Error("bad registration fields");
  }
  return { child, root, stateDir, dataDir, pid, url, token };
}

async function exitCode(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stub service (serve contract used by the launcher)", () => {
  it("writes service.json, answers /health, and exchanges the token for a cookie", async () => {
    const stub = await startStub();
    const health = await fetch(stub.url + "/health").then((response) => response.json());
    expect(health).toMatchObject({
      ok: true,
      apiVersion: 1,
      version: "9.9.9-test",
      pid: stub.pid,
      scripts: { needsConsent: 1 },
    });

    const exchange = await fetch(stub.url + "/?token=" + encodeURIComponent(stub.token), { redirect: "manual" });
    expect(exchange.status).toBe(302);
    expect(exchange.headers.get("location")).toBe("/");
    const cookie = exchange.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const session = cookie?.split(";")[0];
    if (session === undefined) throw new Error("no session cookie");

    const page = await fetch(stub.url + "/", { headers: { Cookie: session } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Ballast service (stub)");
  });

  it("exits 0 on shutdown and removes service.json", async () => {
    const stub = await startStub();
    const response = await fetch(stub.url + "/shutdown", {
      method: "POST",
      headers: { Authorization: "Bearer " + stub.token },
    });
    expect(response.status).toBe(202);
    expect(await exitCode(stub.child)).toBe(0);
    await expect(stat(path.join(stub.stateDir, "service.json"))).rejects.toThrow();
  });

  it("exits 75 on restart so launchd / Task Scheduler starts a new generation", async () => {
    const stub = await startStub();
    const response = await fetch(stub.url + "/restart", {
      method: "POST",
      headers: { Authorization: "Bearer " + stub.token },
    });
    expect(response.status).toBe(202);
    expect(await exitCode(stub.child)).toBe(75);
    // Exit 75 is a restart, not a stop: the registration is cleaned and the
    // supervisor starts a fresh generation that rewrites it.
  });

  it("requires the bearer token for control endpoints and exits 0 on SIGTERM", async () => {
    const stub = await startStub();
    const unauthorized = await fetch(stub.url + "/shutdown", { method: "POST" });
    expect(unauthorized.status).toBe(401);
    stub.child.kill("SIGTERM");
    expect(await exitCode(stub.child)).toBe(0);
  });
});
