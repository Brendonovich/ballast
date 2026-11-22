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
