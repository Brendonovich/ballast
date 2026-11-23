// Minimal stand-in for `ballast serve` (apps/agent is building the real one).
//
// It implements only what the desktop launcher needs to exercise end to end:
//   - service.json + service.lock in BALLAST_STATE_DIR
//   - GET /health (unauthenticated)
//   - GET /?token=... -> HttpOnly session cookie -> redirect to /
//   - POST /shutdown (auth) -> exit 0
//
// Environment: BALLAST_STATE_DIR, BALLAST_DATA_DIR, BALLAST_SERVICE_PORT.
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const startedAt = Date.now();
const token = randomBytes(32).toString("base64url");

const stateDir = resolve(
  process.env.BALLAST_STATE_DIR ?? join(process.env.HOME ?? ".", ".local", "state", "ballast"),
);
const dataDir = resolve(process.env.BALLAST_DATA_DIR ?? join(stateDir, "..", "data"));
const registrationFile = join(stateDir, "service.json");
const lockFile = join(stateDir, "service.lock");
const port = Number(process.env.BALLAST_SERVICE_PORT ?? "0");

async function readVersion() {
  if (process.env.BALLAST_SERVICE_VERSION) return process.env.BALLAST_SERVICE_VERSION;
  try {
    const parsed = JSON.parse(await readFile(join(here, "version.json"), "utf8"));
    if (typeof parsed?.version === "string" && parsed.version.length > 0) return parsed.version;
  } catch {
    // fall through
  }
  return "0.0.0-stub";
}

const version = await readVersion();

function sameSecret(candidate) {
  if (typeof candidate !== "string") return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

function cookie(request) {
  const header = request.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "ballast_session") return rest.join("=");
  }
  return undefined;
}

function authorized(request) {
  return sameSecret(bearer(request)) || sameSecret(cookie(request));
}

async function atomicWrite(file, value, mode) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + process.pid + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode });
  await rename(temporary, file);
}

async function cleanup() {
  await rm(registrationFile, { force: true }).catch(() => {});
  await rm(lockFile, { force: true }).catch(() => {});
}

async function exitSoon(code) {
  await cleanup();
  setTimeout(() => process.exit(code), 75);
}

const page = await readFile(join(here, "web", "index.html"), "utf8").catch(
  () => "<!doctype html><title>Ballast stub</title><h1>Ballast stub service</h1>",
);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        ok: true,
        apiVersion: 1,
        name: "ballast-agent",
        version,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        projects: { total: 1, running: 0, needsConsent: 1, error: 0 },
        connections: { total: 1, connected: 0, error: 0 },
        cloud: "unlinked",
        lastLogSeq: 0,
        lastEventSeq: 0,
      }),
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
    if (!sameSecret(url.searchParams.get("token"))) {
      response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("invalid token\n");
      return;
    }
    response.writeHead(302, {
      Location: "/",
      "Set-Cookie": "ballast_session=" + token + "; HttpOnly; SameSite=Strict; Path=/",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    if (!authorized(request)) {
      response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("missing session\n");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }

  if (request.method === "POST" && url.pathname === "/shutdown") {
    if (!authorized(request)) {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    response.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
    await exitSoon(0);
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("not found\n");
});

async function shutdown(signal) {
  console.error("stub service received " + signal + ", exiting 0");
  await cleanup();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

server.listen(port, "127.0.0.1", async () => {
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no server address");
  const baseUrl = "http://127.0.0.1:" + address.port;
  await atomicWrite(
    registrationFile,
    {
      schemaVersion: 1,
      apiVersion: 1,
      name: "ballast-agent",
      version,
      url: baseUrl,
      token,
      pid: process.pid,
      defaultProjectId: "proj_stub",
      startedAt,
      stateDir,
      dataDir,
    },
    0o600,
  );
  await atomicWrite(lockFile, { pid: process.pid, startedAt }, 0o600);
  console.log("ballast stub service listening on " + baseUrl + " (pid " + process.pid + ", version " + version + ")");
});

server.on("error", (error) => {
  console.error("stub service failed: " + error.message);
  process.exit(1);
});
