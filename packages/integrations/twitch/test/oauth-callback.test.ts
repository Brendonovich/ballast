import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeCallbackServer } from "../src/oauth/callback-server.ts";

describe("OAuth localhost callback server", () => {
  it.effect("returns the code and checks state", () =>
    Effect.gen(function* () {
      const server = yield* makeCallbackServer({ port: 0, state: "state-1" });
      const response = yield* Effect.promise(() =>
        fetch(server.redirectUri + "?code=auth-code&state=state-1"),
      );
      expect(response.status).toBe(200);
      const result = yield* server.wait;
      expect(result.code).toBe("auth-code");
      expect(result.state).toBe("state-1");
      expect(result.redirectUri).toBe(server.redirectUri);
    }),
  );

  it.effect("serves localhost over both IPv4 and IPv6", () =>
    Effect.gen(function* () {
      const server = yield* makeCallbackServer({ port: 0 });
      const port = new URL(server.redirectUri).port;
      const responses = yield* Effect.promise(() =>
        Promise.all([
          fetch(`http://127.0.0.1:${port}/callback?code=v4`),
          fetch(`http://[::1]:${port}/callback?code=v6`),
        ]),
      );
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
    }),
  );

  it.effect("reports a busy fixed callback port", () =>
    Effect.gen(function* () {
      const first = yield* makeCallbackServer({ port: 0 });
      const port = Number(new URL(first.redirectUri).port);
      const error = yield* makeCallbackServer({ port }).pipe(Effect.flip);
      expect(error.message).toContain(`port ${port} is already in use`);
      expect(error.message).toContain("BALLAST_TWITCH_CALLBACK_PORT");
    }),
  );

  it.effect("rejects a mismatched state", () =>
    Effect.gen(function* () {
      const server = yield* makeCallbackServer({ port: 0, state: "state-1" });
      const response = yield* Effect.promise(() =>
        fetch(server.redirectUri + "?code=auth-code&state=wrong"),
      );
      expect(response.status).toBe(400);
      const error = yield* Effect.flip(server.wait);
      expect(error.reason).toContain("state");
    }),
  );
});
