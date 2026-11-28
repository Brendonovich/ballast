import { protocol, session } from "electron";

/**
 * The window loads the UI from `ballast://app/` instead of the agent's
 * loopback URL directly (which fails on some Windows setups). The main process
 * proxies each request to the running agent with the service token.
 */
export const APP_SCHEME = "ballast";
export const APP_ORIGIN = APP_SCHEME + "://app";
/** Same-origin endpoint the UI reads its agent URL and token from, so the token never appears in the page URL. */
export const APP_CONNECTION_PATH = "/.ballast/connection";

export interface AppProtocolTarget {
  readonly url: string;
  readonly token: string;
}

let target: AppProtocolTarget | null = null;

export const setAppProtocolTarget = (next: AppProtocolTarget | null): void => {
  target = next;
};

/** Must run before `app.whenReady()`. */
export const registerAppScheme = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
};

const forwardedHeaders = ["accept", "accept-language", "content-type", "range", "if-none-match", "if-modified-since"];

export const handleAppProtocol = (): void => {
  session.defaultSession.protocol.handle(APP_SCHEME, async (request) => {
    const current = target;
    const requested = new URL(request.url);
    if (current === null || requested.host !== "app") {
      return new Response("Ballast service is not available", { status: 502 });
    }
    if (requested.pathname === APP_CONNECTION_PATH) {
      return Response.json(
        { service: current.url, token: current.token },
        { headers: { "cache-control": "no-store" } },
      );
    }
    const upstream = new URL(requested.pathname + requested.search, current.url);
    const headers = new Headers({ authorization: "Bearer " + current.token });
    for (const name of forwardedHeaders) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    try {
      const response = await fetch(upstream, {
        method: request.method,
        headers,
        redirect: "manual",
        ...(hasBody ? { body: await request.arrayBuffer() } : {}),
      });
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("set-cookie");
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (cause) {
      return new Response(cause instanceof Error ? cause.message : String(cause), { status: 502 });
    }
  });
};
