import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ShareRow, SharesApiRpc } from "@ballast/shares-api";
import type { RelayServerMessage } from "@ballast/cloud-protocol";

import { makeShareRoutes } from "../src/shares/routes.ts";
import type { MachineRow } from "../src/store.ts";

const machine = (id: string, userId: string): MachineRow => ({
  id,
  userId,
  name: id,
  tokenHash: "hash-" + id,
  createdAt: 0,
  lastSeenAt: 0,
});

const row: ShareRow = {
  id: "shr_1",
  ownerUserId: "user_a",
  ownerMachineId: "m_a",
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
const fakeApi = (subscribed: Set<string>): SharesApiRpc => ({
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
      subscribers: [...subscribed],
    }),
  subscribe: ({ machineId }) => Effect.sync(() => void subscribed.add(machineId)),
  unsubscribe: ({ machineId }) => Effect.sync(() => void subscribed.delete(machineId)),
  isSubscribed: ({ machineId }) => Effect.succeed(subscribed.has(machineId)),
  listSubscriptions: () => Effect.succeed([]),
  setInstalledSha: () => Effect.void,
  diff: () => Effect.die("unused"),
});

describe("share routes", () => {
  it("routes /api/shares/* and authorizes owners and subscribers", async () => {
    const subscribed = new Set<string>();
    const notified: Array<{ machineId: string; message: RelayServerMessage }> = [];
    const routes = makeShareRoutes({
      api: fakeApi(subscribed),
      relay: {
        enqueueEvent: () => Effect.void,
        enqueueWebhook: () => Effect.void,
        notify: (machineId, message) => Effect.sync(() => void notified.push({ machineId, message })),
      },
      enforceRateLimit: () => Effect.void,
    });
    const call = async (who: MachineRow, method: string, path: string, body?: unknown) => {
      const url = new URL("http://cloud.test" + path);
      const handler = routes.route(
        who,
        {
          method,
          url: url.toString(),
          headers: {},
          body: new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body)),
        },
        url,
      );
      if (handler === undefined) return { status: 404 };
      const result = await Effect.runPromise(Effect.result(handler));
      return result._tag === "Success"
        ? { status: result.success.status, body: JSON.parse(String(result.success.body)) }
        : { status: result.failure.status };
    };
    const owner = machine("m_a", "user_a");
    const ownersOtherMachine = machine("m_a2", "user_a");
    const subscriber = machine("m_b", "user_b");

    const created = await call(owner, "POST", "/api/shares", { name: "Demo" });
    expect(created).toMatchObject({ status: 201, body: { shareCode: "ABCD-EFGH-JKLM", share: { owner: true } } });
    expect((await call(owner, "GET", "/api/shares/elsewhere/unknown")).status).toBe(404);

    // Only the owner's user may get a write token; strangers cannot read.
    expect((await call(ownersOtherMachine, "POST", "/api/shares/shr_1/deploy-token")).status).toBe(200);
    expect((await call(subscriber, "POST", "/api/shares/shr_1/deploy-token")).status).toBe(403);
    expect((await call(subscriber, "GET", "/api/shares/shr_1")).status).toBe(403);

    // A share code grants subscribe, which grants reads.
    expect((await call(subscriber, "POST", "/api/shares/subscriptions", { shareCode: "abcd-efgh-jklm" })).status).toBe(200);
    expect((await call(subscriber, "GET", "/api/shares/shr_1")).status).toBe(200);
    expect((await call(subscriber, "GET", "/api/shares/subscriptions")).status).toBe(200);

    const deployed = await call(owner, "POST", "/api/shares/shr_1/deploys", { sha: "a".repeat(40), message: "v1" });
    expect(deployed).toMatchObject({ status: 200, body: { notified: 1 } });
    expect(notified).toEqual([
      {
        machineId: "m_b",
        message: { _tag: "share_update", shareId: "shr_1", sha: "a".repeat(40), message: "v1", deployedAt: 5 },
      },
    ]);
  });
});
