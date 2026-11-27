import { describe, expect, it } from "vitest";

import { resolveTransport } from "./client.ts";

describe("resolveTransport", () => {
  it("uses the in-browser mock when no service is configured", () => {
    const transport = resolveTransport({ search: "", env: {}, baseHref: "http://localhost:5173/" });
    expect(transport.kind).toBe("mock");
  });

  it("prefers query parameters over the Vite environment", () => {
    const transport = resolveTransport({
      search: "?service=http://127.0.0.1:53124&token=abc123",
      env: { VITE_SERVICE_URL: "http://127.0.0.1:9999", VITE_SERVICE_TOKEN: "env" },
      baseHref: "http://localhost:5173/",
    });
    expect(transport.kind).toBe("websocket");
    expect(transport.origin).toBe("http://127.0.0.1:53124");
    expect(transport.rpcUrl).toBe("ws://127.0.0.1:53124/rpc?token=abc123");
    expect(transport.token).toBe("abc123");
  });

  it("upgrades an https service URL to wss", () => {
    const transport = resolveTransport({
      search: "",
      env: {
        VITE_SERVICE_URL: "https://service.example.test",
        VITE_SERVICE_TOKEN: "env-token",
      },
      baseHref: "http://localhost:5173/",
    });
    expect(transport.kind).toBe("websocket");
    expect(transport.rpcUrl).toBe("wss://service.example.test/rpc?token=env-token");
  });

  it("normalizes a bare host:port to a ws URL without a token", () => {
    const transport = resolveTransport({
      search: "?service=127.0.0.1:53124",
      env: {},
      baseHref: "http://localhost:5173/",
    });
    expect(transport.kind).toBe("websocket");
    expect(transport.rpcUrl).toBe("ws://127.0.0.1:53124/rpc");
  });

  it("falls back to the mock for an invalid service URL", () => {
    const transport = resolveTransport({
      search: "?service=http://%zz",
      env: {},
      baseHref: "http://localhost:5173/",
    });
    expect(transport.kind).toBe("mock");
  });
});
