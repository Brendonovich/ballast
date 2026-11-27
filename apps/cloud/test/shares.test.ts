import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ShareRow, SharesApiRpc } from "@ballast/shares-api";

import type { SharePrincipal } from "../src/shares/auth.ts";
import { makeShareRoutes } from "../src/shares/routes.ts";

const signedIn = (sessionId: string, userId: string): SharePrincipal => ({
  session: { id: sessionId, userId, tokenHash: "hash-" + sessionId, deviceName: sessionId, createdAt: 0, lastUsedAt: 0 },
  user: { id: userId, issuer: "https://account.anoma.ly", subject: "sub-" + userId, name: null, username: null, createdAt: 0, updatedAt: 0 },
});

const row: ShareRow = {
  id: "shr_1",
  ownerUserId: "user_a",
  name: "Demo",
  repo: "ballast-1",
  shareCode: "ABCDEFGHJKLM",
  currentSha: null,
  manifestHash: null,
  message: null,
  deployedAt: null,
  createdAt: 0,
  updatedAt: 0,
};

/** Only what the routes call in these tests; everything else is unused. */
const fakeApi = (): SharesApiRpc => ({
  createShare: (input) => Effect.succeed({ ...row, ownerUserId: input.ownerUserId, name: input.name }),
  getShare: (id) => Effect.succeed(id === row.id ? row : null),
  findShareByCode: (code) => Effect.succeed(code.replaceAll("-", "").toUpperCase() === row.shareCode ? row : null),
  deployToken: () =>
    Effect.succeed({ remote: "memory://repo", token: "t", expiresAt: "2099-01-01T00:00:00Z", currentSha: null }),
  recordDeploy: (input) =>
    Effect.succeed({
      share: { ...row, currentSha: input.sha, message: input.message, deployedAt: 5 },
      manifestHash: "h",
      recorded: true,
    }),
  diff: (input) =>
    Effect.succeed({
      shareId: input.id,
      from: input.from,
      to: "a".repeat(40),
      message: null,
      manifest: { version: 1, name: "Demo", files: {} },
      files: [],
      deleted: [],
    }),
});

describe("share routes", () => {
  it("lets only the signed-in owner publish and anyone with the code read", async () => {
    const buckets: Array<string> = [];
    const routes = makeShareRoutes({
      api: fakeApi(),
      enforceRateLimit: (bucket) => Effect.sync(() => void buckets.push(bucket)),
    });
    const call = async (who: SharePrincipal | undefined, method: string, path: string, body?: unknown) => {
      const url = new URL("http://cloud.test" + path);
      const request = {
        method,
        url: url.toString(),
        headers: { "cf-connecting-ip": "203.0.113.9" },
        body: new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body)),
      };
      const handler = who === undefined ? routes.publicRoute(request, url) : routes.route(who, request, url);
      if (handler === undefined) return { status: 404 };
      const result = await Effect.runPromise(Effect.result(handler));
      return result._tag === "Success"
        ? { status: result.success.status, body: JSON.parse(String(result.success.body)) }
        : { status: result.failure.status };
    };
    const owner = signedIn("ses_a", "user_a");
    const ownersOtherMachine = signedIn("ses_a2", "user_a");
    const stranger = signedIn("ses_b", "user_b");

    const created = await call(owner, "POST", "/api/shares", { name: "Demo" });
    expect(created).toMatchObject({ status: 201, body: { shareCode: "ABCD-EFGH-JKLM", share: { owner: true } } });
    expect((await call(owner, "GET", "/api/shares/elsewhere/unknown")).status).toBe(404);

    // Publishing is the owner's, from any of their machines.
    expect((await call(ownersOtherMachine, "POST", "/api/shares/shr_1/deploy-token")).status).toBe(200);
    expect((await call(stranger, "POST", "/api/shares/shr_1/deploy-token")).status).toBe(403);
    expect((await call(stranger, "GET", "/api/shares/shr_1")).status).toBe(403);
    const deployed = await call(owner, "POST", "/api/shares/shr_1/deploys", { sha: "a".repeat(40), message: "v1" });
    expect(deployed).toMatchObject({ status: 200, body: { share: { currentSha: "a".repeat(40), owner: true } } });

    // Reading needs only the share code: no session at all.
    expect(await call(undefined, "GET", "/api/shares/code/abcdefghjklm")).toMatchObject({
      status: 200,
      body: { share: { shareId: "shr_1", owner: false } },
    });
    expect((await call(undefined, "GET", "/api/shares/code/ABCDEFGHJKLM/diff?to=" + "a".repeat(40))).status).toBe(200);
    expect((await call(undefined, "GET", "/api/shares/code/WRONGWRONGWR")).status).toBe(404);
    expect(buckets.filter((bucket) => bucket === "share-code:203.0.113.9")).toHaveLength(3);
    // The id alone grants nothing.
    expect(routes.publicRoute({ method: "GET", url: "http://cloud.test/api/shares/shr_1/diff", headers: {}, body: new Uint8Array() }, new URL("http://cloud.test/api/shares/shr_1/diff"))).toBeUndefined();
  });
});
