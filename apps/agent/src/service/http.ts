import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { AGENT_NAME, hostAllowed, originAllowed, tokenEquals } from "./config.ts";
import type { LifecycleService } from "./lifecycle.ts";
import { fileExists } from "./fs.ts";

const SESSION_COOKIE = "ballast_session";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const PLACEHOLDER = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ballast</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:3rem auto;max-width:40rem;padding:0 1.5rem;color:#222}code{background:#f2f2f2;padding:.1rem .3rem;border-radius:.25rem}</style>
</head>
<body><h1>Ballast</h1><p>The service is running, but the web UI has not been built yet.</p><p>Run <code>pnpm --filter @ballast/web build</code> and restart the service, or pass <code>--web-dir</code>.</p></body>
</html>`;

const authorized = (
  request: HttpServerRequest.HttpServerRequest,
  token: string,
  devToken: string | undefined,
  dev: boolean,
): boolean => {
  const header = request.headers["authorization"];
  if (header !== undefined) {
    const value = Array.isArray(header) ? header[0] : header;
    if (value !== undefined && value.startsWith("Bearer ")) {
      const candidate = value.slice("Bearer ".length);
      if (tokenEquals(candidate, token)) return true;
      if (dev && devToken !== undefined && tokenEquals(candidate, devToken)) return true;
    }
  }
  const cookie = request.cookies[SESSION_COOKIE];
  if (cookie !== undefined && tokenEquals(cookie, token)) return true;
  if (dev && devToken !== undefined && cookie !== undefined && tokenEquals(cookie, devToken)) {
    return true;
  }
  return false;
};

const pathOf = (request: HttpServerRequest.HttpServerRequest): { pathname: string; url: URL } => {
  const url = new URL(request.url, "http://127.0.0.1");
  return { pathname: url.pathname, url };
};

const unauthorized = () =>
  HttpServerResponse.text("Unauthorized\n", {
    status: 401,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const forbidden = () =>
  HttpServerResponse.text("Forbidden\n", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const contentType = (path: string): string =>
  MIME[extname(path).toLowerCase()] ?? "application/octet-stream";

const staticResponse = (webDir: string | undefined, pathname: string): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.gen(function* () {
    if (webDir === undefined) {
      return HttpServerResponse.text(PLACEHOLDER, {
        contentType: "text/html; charset=utf-8",
        headers: { "referrer-policy": "no-referrer" },
      });
    }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const candidate = resolve(webDir, normalize(relative));
    if (!candidate.startsWith(resolve(webDir) + "/") && candidate !== resolve(webDir, "index.html")) {
      return HttpServerResponse.text("Not found\n", { status: 404 });
    }
    const exists = yield* Effect.promise(() => fileExists(candidate));
    let file = candidate;
    if (!exists) {
      if (relative !== "index.html" && extname(relative) !== "") {
        return HttpServerResponse.text("Not found\n", { status: 404 });
      }
      file = join(webDir, "index.html");
    }
    const content = yield* Effect.tryPromise({
      try: () => readFile(file),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (content === undefined) {
      return HttpServerResponse.text(PLACEHOLDER, {
        contentType: "text/html; charset=utf-8",
        headers: { "referrer-policy": "no-referrer" },
      });
    }
    return HttpServerResponse.uint8Array(content, {
      headers: {
        "content-type": contentType(file),
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  });

export interface HttpRoutesOptions {
  readonly token: string;
  readonly dev: boolean;
  readonly devToken: string | undefined;
  readonly port: Ref.Ref<number>;
  readonly webDir: string | undefined;
  readonly startedAt: number;
  readonly version: string;
  readonly health: () => Effect.Effect<Record<string, unknown>>;
}

export const registerHttpRoutes = (
  router: HttpRouter.HttpRouter,
  options: HttpRoutesOptions,
  lifecycle: LifecycleService,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* router.addGlobalMiddleware((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const port = yield* Ref.get(options.port);
        const host = request.headers["host"];
        if (!hostAllowed(Array.isArray(host) ? host[0] : host, port, options.dev)) {
          return forbidden();
        }
        const origin = request.headers["origin"];
        if (!originAllowed(Array.isArray(origin) ? origin[0] : origin, port, options.dev)) {
          return forbidden();
        }
        const { pathname, url } = pathOf(request);
        if (pathname === "/health") return yield* effect;
        const queryToken = url.searchParams.get("token");
        if (
          (pathname === "/" || pathname === "/auth") &&
          queryToken !== null
        ) {
          if (!tokenEquals(queryToken, options.token)) return unauthorized();
          const response = HttpServerResponse.redirect("/");
          return yield* HttpServerResponse.setCookie(response, SESSION_COOKIE, options.token, {
            httpOnly: true,
            sameSite: "strict",
            path: "/",
          }).pipe(Effect.orDie);
        }
        // The desktop main process uses the Node global WebSocket, which cannot
        // set an Authorization header. Scope the query-token form to the RPC
        // upgrade; the UI exchange and CLI keep cookies/headers.
        if (pathname === "/rpc" && queryToken !== null) {
          if (!tokenEquals(queryToken, options.token)) return unauthorized();
          return yield* effect;
        }
        if (!authorized(request, options.token, options.devToken, options.dev)) {
          return unauthorized();
        }
        return yield* effect;
      }),
    );

    const control = (code: number): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
      Effect.gen(function* () {
        yield* Effect.forkDetach(
          Effect.sleep("100 millis").pipe(Effect.andThen(lifecycle.stop(code))),
        );
        return yield* HttpServerResponse.json(
          { ok: true, restarting: code === 75 },
          { status: 202 },
        ).pipe(Effect.orDie);
      });

    yield* router.add("POST", "/shutdown", () => control(0));
    yield* router.add("POST", "/restart", () => control(75));

    yield* router.add(
      "GET",
      "/health",
      Effect.gen(function* () {
        const body = yield* options.health();
        return yield* HttpServerResponse.json({
          ok: true,
          name: AGENT_NAME,
          version: options.version,
          apiVersion: 1,
          pid: process.pid,
          startedAt: options.startedAt,
          uptimeMs: Math.max(0, Date.now() - options.startedAt),
          ...body,
        }).pipe(Effect.orDie);
      }),
    );

    const serveStatic = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const { pathname } = pathOf(request);
        return yield* staticResponse(options.webDir, pathname);
      });

    yield* router.add("GET", "/", serveStatic);
    yield* router.add("GET", "/auth", HttpServerResponse.redirect("/"));
    yield* router.add("GET", "/*", serveStatic);
  });
