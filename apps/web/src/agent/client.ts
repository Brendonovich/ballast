import {
  AGENT_RPC_PATH,
  AgentRpcs,
  MockAgentLayer,
  makeMockAgentLayer,
} from "@ballast/agent-protocol";
import { testOnboarding } from "../lib/onboarding.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { RpcClient, RpcSerialization, RpcTest } from "effect/rpc";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as Socket from "effect/socket/Socket";

/**
 * The UI talks to the agent through one long-lived Effect client. Both
 * transports below produce the same `AgentClient`; the store never knows which
 * one is active.
 */
/**
 * The protocol's client shape, widened with the transport error the WebSocket
 * client can add. The in-browser mock never produces it, but both transports
 * satisfy this type.
 */
export type WebAgentClient = RpcClient.FromGroup<typeof AgentRpcs, RpcClientError>;

export class AgentClientService extends Context.Service<
  AgentClientService,
  WebAgentClient
>()("ballast/web/AgentClient") {}

const MockClientLive: Layer.Layer<AgentClientService> = Layer.effect(
  AgentClientService,
  RpcTest.makeClient(AgentRpcs).pipe(
    Effect.provide(testOnboarding ? makeMockAgentLayer({ fresh: true }) : MockAgentLayer),
  ),
);

const websocketClientLive = (rpcUrl: string): Layer.Layer<AgentClientService> => {
  const socket = Socket.layerWebSocket(rpcUrl).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(socket),
  );
  return Layer.effect(AgentClientService, RpcClient.make(AgentRpcs)).pipe(
    Layer.provide(protocol),
  );
};

export type TransportKind = "mock" | "websocket";

/**
 * How the UI reached (or failed to reach) an agent. `note` is user-facing and
 * explains a fallback, such as an invalid service URL or a missing token.
 */
export interface TransportConfig {
  readonly kind: TransportKind;
  readonly label: string;
  readonly origin?: string;
  readonly rpcUrl?: string;
  readonly token?: string;
  readonly note?: string;
}

export interface WebEnv {
  readonly VITE_SERVICE_URL?: string | undefined;
  readonly VITE_SERVICE_TOKEN?: string | undefined;
}

export interface ResolveTransportOptions {
  readonly search?: string;
  readonly env?: WebEnv;
  readonly baseHref?: string;
}

const isBrowser = (): boolean => typeof window !== "undefined";

const normalizeServiceUrl = (raw: string, baseHref: string): URL | undefined => {
  const value = raw.trim();
  if (value === "") return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `http://${value}`;
  try {
    return new URL(withScheme, baseHref);
  } catch {
    return undefined;
  }
};

/**
 * Transport selection, in priority order:
 *
 * 1. `?service=<url>&token=<token>` — used by the desktop shell and by hand
 *    while developing.
 * 2. `VITE_SERVICE_URL` / `VITE_SERVICE_TOKEN`.
 * 3. The in-browser mock (`MockAgentLayer`), so `pnpm dev` works alone.
 *
 * Browsers cannot set an `Authorization` header on a WebSocket upgrade, so the
 * token is appended to the RPC URL. The service can also authenticate the
 * WebSocket with the `HttpOnly` session cookie set by `/?token=…`.
 */
export const resolveTransport = (
  options: ResolveTransportOptions = {},
): TransportConfig => {
  const search = options.search ?? (isBrowser() ? window.location.search : "");
  const baseHref =
    options.baseHref ??
    (isBrowser() ? window.location.href : "http://localhost:5173/");
  const env = options.env ?? import.meta.env;
  const params = new URLSearchParams(search);
  const service = params.get("service") ?? env.VITE_SERVICE_URL;
  const token = params.get("token") ?? env.VITE_SERVICE_TOKEN;

  if (service === undefined || service.trim() === "") {
    return {
      kind: "mock",
      label: "In-browser mock",
      note: "Using MockAgentLayer. Add ?service=http://127.0.0.1:PORT&token=… to connect to a live service.",
    };
  }

  const base = normalizeServiceUrl(service, baseHref);
  if (base === undefined) {
    return {
      kind: "mock",
      label: "In-browser mock",
      note: `Ignoring invalid service URL "${service}".`,
    };
  }

  const rpc = new URL(AGENT_RPC_PATH, base);
  rpc.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  if (token !== undefined && token !== "") {
    rpc.searchParams.set("token", token);
  }

  return {
    kind: "websocket",
    label: base.host,
    origin: base.origin,
    rpcUrl: rpc.toString(),
    ...(token === undefined || token === "" ? {} : { token }),
    ...(token === undefined || token === ""
      ? {
          note: "No token was provided. The agent will use the session cookie, if present.",
        }
      : {}),
  };
};

/**
 * When the service serves the UI itself there is no `?service=` parameter:
 * the page origin is the agent. Probe the unauthenticated `/health` endpoint
 * and use a same-origin WebSocket (the session cookie authorized it) when it
 * identifies a Ballast agent. Vite dev and the standalone mock fall through to
 * `MockAgentLayer`.
 */
export const probeSameOriginService = async (): Promise<TransportConfig | undefined> => {
  if (!isBrowser()) return undefined;
  // Vite dev is always the mock unless an explicit service URL is configured;
  // do not let a missing /health show up as a console 404.
  if (import.meta.env.DEV) return undefined;
  const { protocol, host, origin } = window.location;
  if (protocol !== "http:" && protocol !== "https:") return undefined;
  try {
    const response = await fetch(new URL("/health", origin), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object") return undefined;
    if (!("name" in body) || body.name !== "ballast-agent") return undefined;
    if (!("apiVersion" in body) || body.apiVersion !== 1) return undefined;
    const rpc = new URL(AGENT_RPC_PATH, origin);
    rpc.protocol = protocol === "https:" ? "wss:" : "ws:";
    return {
      kind: "websocket",
      label: host,
      origin,
      rpcUrl: rpc.toString(),
      note: "Using the agent that served this page (session cookie).",
    };
  } catch {
    return undefined;
  }
};

/**
 * The desktop shell serves the UI from `ballast://app` and hands the agent
 * URL and token to the page through a same-origin endpoint
 * (apps/desktop/src/main/app-protocol.ts).
 */
export const probeDesktopService = async (): Promise<TransportConfig | undefined> => {
  if (!isBrowser() || window.location.protocol !== "ballast:") return undefined;
  try {
    const response = await fetch("/.ballast/connection", { cache: "no-store" });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object") return undefined;
    if (!("service" in body) || typeof body.service !== "string") return undefined;
    if (!("token" in body) || typeof body.token !== "string") return undefined;
    const configured = resolveTransport({
      search: "?" + new URLSearchParams({ service: body.service, token: body.token }).toString(),
    });
    return configured.kind === "websocket" ? configured : undefined;
  } catch {
    return undefined;
  }
};

/** Explicit transport first; otherwise detect the agent that served this page. */
export const resolvePageTransport = async (): Promise<TransportConfig> => {
  const configured = resolveTransport();
  if (configured.kind === "websocket") return configured;
  return (await probeDesktopService()) ?? (await probeSameOriginService()) ?? configured;
};

export interface AgentRuntime {
  readonly client: WebAgentClient;
  readonly transport: TransportConfig;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  /**
   * Starts a background effect on the runtime's root fiber and returns an
   * interruptor. Streams live here, not in a component scope, so they survive
   * route changes and are stopped with `dispose`.
   */
  readonly start: <A, E>(effect: Effect.Effect<A, E>) => () => void;
  readonly dispose: () => Promise<void>;
}

export const createAgentRuntime = async (
  config: TransportConfig = resolveTransport(),
): Promise<AgentRuntime> => {
  const layer =
    config.kind === "mock" || config.rpcUrl === undefined
      ? MockClientLive
      : websocketClientLive(config.rpcUrl);
  const runtime = ManagedRuntime.make(layer);
  const client = await runtime.runPromise(Effect.service(AgentClientService));

  return {
    client,
    transport: config,
    run: (effect) => runtime.runPromise(effect),
    start: (effect) => {
      const interrupt = runtime.runCallback(effect);
      return () => interrupt();
    },
    dispose: () => runtime.dispose(),
  };
};

/** A background loop that survives transient failures without spinning. */
export const runResilient = <E>(
  effect: Effect.Effect<void, E>,
  onFailure: (error: unknown) => void,
  retryDelay: Duration.Input = "1 second",
): Effect.Effect<void> =>
  Effect.forever(
    effect.pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.sync(() => onFailure(Cause.squash(cause))).pipe(
                Effect.andThen(Effect.sleep(retryDelay)),
              ),
        onSuccess: () => Effect.sleep("500 millis"),
      }),
    ),
  );
