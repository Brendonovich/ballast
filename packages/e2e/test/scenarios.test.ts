import { createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { Effect, Fiber, Ref, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OAuthCallbackResponse } from "@ballast/cloud-protocol";
import type { AgentClient, LogEntry } from "@ballast/agent-protocol";
import type { RpcClientError } from "effect/rpc/RpcClientError";

import { startFakeTwitch, type FakeTwitch, type FakeTwitchSubscription } from "./support/fake-twitch.ts";
import {
  startCloud,
  startService,
  waitFor,
  type CloudProcess,
  type ServiceProcess,
} from "./support/process.ts";
import { withAgentClient } from "./support/rpc.ts";

type Client = AgentClient<RpcClientError>;

let fake: FakeTwitch | undefined;
let cloud: CloudProcess | undefined;
let skipReason: string | undefined;

beforeAll(async () => {
  try {
    fake = await startFakeTwitch();
    cloud = await startCloud({ twitchBaseUrl: fake.url });
  } catch (cause) {
    skipReason = cause instanceof Error ? cause.message : String(cause);
  }
}, 120_000);

afterAll(async () => {
  if (cloud !== undefined) await cloud.process.stop();
  if (fake !== undefined) await fake.close();
}, 30_000);

const requireCloud = (
  ctx: { skip: (note?: string) => void },
): CloudProcess | undefined => {
  if (cloud === undefined || fake === undefined) {
    ctx.skip(skipReason ?? "alchemy dev is unavailable");
    return undefined;
  }
  return cloud;
};

const projectWithScripts = async (
  scripts: Readonly<Record<string, string>>,
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "ballast-e2e-project-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  for (const [name, source] of Object.entries(scripts)) {
    await writeFile(join(root, "scripts", name), source, "utf8");
  }
  return root;
};

const redeemScript = [
  'import * as Ballast from "@ballast/core";',
  'import * as Twitch from "@ballast/module-twitch";',
  'import { Effect } from "effect";',
  '',
  'export const title = "E2E Redemption";',
  '',
  'export default Effect.gen(function* () {',
  '  const broadcaster = yield* Twitch.Account("broadcaster");',
  '  yield* Twitch.ChannelPointsRedemption.subscribe("redemption", broadcaster, (event) =>',
  '    Effect.sync(() => console.log("E2E_REWARD:" + event.reward.title)),',
  '  );',
  '  yield* Effect.log("E2E_STARTED");',
  '});',
].join("\n");

const secondScript = [
  'import * as Ballast from "@ballast/core";',
  'import * as Twitch from "@ballast/module-twitch";',
  'import { Effect } from "effect";',
  '',
  'export const title = "E2E Second";',
  '',
  'export default Effect.gen(function* () {',
  '  const broadcaster = yield* Twitch.Account("broadcaster");',
  '  yield* Twitch.ChannelPointsRedemption.subscribe("redemption", broadcaster, () => Effect.void);',
  '});',
].join("\n");

const kofiScript = [
  'import * as Http from "@ballast/module-http";',
  'import { Effect } from "effect";',
  '',
  'export const title = "E2E Ko-fi";',
  '',
  'export default Effect.gen(function* () {',
  '  const hook = yield* Http.Webhook("kofi");',
  '  yield* Http.Webhook.subscribe("donation", hook, (delivery) =>',
  '    Effect.sync(() => console.log("E2E_HOOK:" + new TextDecoder().decode(delivery.body))),',
  '  );',
  '});',
].join("\n");

const pair = (client: Client, cloudUrl: string) =>
  Effect.gen(function* () {
    const start = yield* Effect.promise(() =>
      fetch(cloudUrl + "/oauth/twitch/start?scopes=user:read:email,channel:read:redemptions", {
        redirect: "manual",
      }),
    );
    const location = start.headers.get("location");
    if (location === null) return yield* Effect.fail(new Error("OAuth start had no redirect"));
    const state = new URL(location).searchParams.get("state");
    if (state === null) return yield* Effect.fail(new Error("OAuth start had no state"));
    const callback = yield* Effect.promise(() =>
      fetch(cloudUrl + "/oauth/twitch/callback?code=e2e&state=" + state + "&format=json"),
    );
    const body: unknown = yield* Effect.promise(() => callback.json());
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(OAuthCallbackResponse)(body),
      catch: (cause) => new Error("Invalid OAuth callback: " + String(cause)),
    });
    yield* client.PairCloud({ code: decoded.pairingCode, machineName: "e2e service" });
    for (let attempt = 0; attempt < 150; attempt++) {
      const status = yield* client.GetCloudStatus();
      if (status.state === "linked" && status.relay?.connected === true) return status;
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(new Error("cloud pairing did not connect the relay"));
  });

const startAndApprove = (client: Client, projectId: string, scriptId: string) =>
  Effect.gen(function* () {
    let startError: string | undefined;
    yield* client.StartScript({ projectId, scriptId }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          startError = error.message;
        }),
      ),
    );
    let lastStatus: string | undefined;
    for (let attempt = 0; attempt < 150; attempt++) {
      const detail = yield* client
        .GetScript({ projectId, scriptId })
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      lastStatus = detail === undefined
        ? "missing"
        : detail.summary.status + (detail.summary.lastError === undefined ? "" : ": " + detail.summary.lastError);
      if (detail?.summary.status === "running") return detail;
      const consents = yield* client
        .ListConsents({ projectId })
        .pipe(Effect.catch(() => Effect.succeed({ consents: [] })));
      const consent = consents.consents.find((item) => item.scriptId === scriptId);
      if (consent !== undefined)
        yield* client.ApproveConsent({ consentId: consent.id }).pipe(Effect.catch(() => Effect.void));
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(
      new Error(
        "Script did not start: " +
          scriptId +
          " (startError=" +
          (startError ?? "none") +
          ", lastStatus=" +
          (lastStatus ?? "unknown") +
          ")",
      ),
    );
  });

interface LogCollector {
  readonly entries: Ref.Ref<ReadonlyArray<LogEntry>>;
  readonly close: Effect.Effect<void>;
}

const collectLogs = (
  client: Client,
  projectId: string,
  scriptId: string,
): Effect.Effect<LogCollector> =>
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyArray<LogEntry>>([]);
    const fiber = yield* client.StreamLogs({ projectId, scriptId, afterSeq: 0 }).pipe(
      Stream.runForEach((entry) => Ref.update(entries, (current) => [...current, entry])),
      Effect.forkChild,
    );
    return { entries, close: Fiber.interrupt(fiber).pipe(Effect.asVoid) };
  });

const waitForWorkerReady = (
  client: Client,
  projectId: string,
  scriptId: string,
  marker?: string,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const collector = yield* collectLogs(client, projectId, scriptId);
    yield* waitForLogs(collector, (message) =>
      marker === undefined
        ? message.includes("[runtime] generation") && message.includes("ready")
        : message.includes(marker),
    );
    yield* collector.close;
  });

const waitForLogs = (
  collector: LogCollector,
  predicate: (message: string) => boolean,
  minimum = 1,
): Effect.Effect<ReadonlyArray<LogEntry>, Error> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt++) {
      const entries = yield* Ref.get(collector.entries);
      if (entries.filter((entry) => predicate(entry.message)).length >= minimum) return entries;
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(new Error("Timed out waiting for a script log"));
  });

const subscriptionEvent = (
  subscription: FakeTwitchSubscription,
  redemptionId: string,
  title: string,
) => ({
  subscription: {
    id: subscription.id,
    status: "enabled",
    type: subscription.type,
    version: subscription.version,
    condition: subscription.condition,
  },
  event: {
    id: redemptionId,
    broadcaster_user_id: "12345",
    broadcaster_user_login: "streamer",
    broadcaster_user_name: "Streamer",
    user_id: "999",
    user_login: "viewer",
    user_name: "Viewer",
    user_input: "",
    status: "unfulfilled",
    reward: { id: "reward-1", title, cost: 100, prompt: "E2E reward" },
    redeemed_at: new Date().toISOString(),
  },
});

const postEventSub = async (
  cloudUrl: string,
  subscription: FakeTwitchSubscription,
  messageId: string,
  title: string,
): Promise<number> => {
  const timestamp = new Date().toISOString();
  const body = JSON.stringify(subscriptionEvent(subscription, messageId, title));
  const signature =
    "sha256=" +
    createHmac("sha256", subscription.transport.secret)
      .update(messageId + timestamp + body)
      .digest("hex");
  const path = new URL(subscription.transport.callback).pathname;
  const response = await fetch(cloudUrl + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "twitch-eventsub-message-id": messageId,
      "twitch-eventsub-message-timestamp": timestamp,
      "twitch-eventsub-message-signature": signature,
      "twitch-eventsub-message-type": "notification",
    },
    body,
  });
  return response.status;
};

const twitchConnectionReady = (client: Client) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt++) {
      const connections = yield* client.ListConnections().pipe(
        Effect.catch(() => Effect.succeed({ connections: [] })),
      );
      const connection = connections.connections.find(
        (entry) => entry.integration === "twitch" && entry.slot === "broadcaster",
      );
      if (connection?.status === "connected") return connection;
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(new Error("Cloud Twitch connection did not connect"));
  });

const readMachineToken = async (dataDir: string): Promise<string | undefined> => {
  try {
    const value: unknown = JSON.parse(await readFile(join(dataDir, "cloud.json"), "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    return typeof record["machineToken"] === "string" ? record["machineToken"] : undefined;
  } catch {
    return undefined;
  }
};

describe("real cloud + real desktop service", () => {
  it(
    "Twitch cloud mode: pairing, consent, delivery, buffering and owner reconcile",
    async (ctx) => {
      const process = requireCloud(ctx);
      if (process === undefined || fake === undefined) return;
      const twitch = fake;
      const root = await projectWithScripts({ "redeem.ts": redeemScript, "second.ts": secondScript });
      let service: ServiceProcess = await startService({
        root: join(root, "service"),
        cloudUrl: process.url,
      });
      try {
        const projectId = await withAgentClient(service.registration, (client) =>
          Effect.gen(function* () {
            yield* pair(client, process.url);
            const detail = yield* client.AddProject({ path: root, name: "E2E Twitch" });
            return detail.summary.id;
          }),
        );

        const subscription = await withAgentClient(service.registration, (client) =>
          Effect.gen(function* () {
            yield* startAndApprove(client, projectId, "scripts/redeem.ts");
            yield* startAndApprove(client, projectId, "scripts/second.ts");
            yield* waitForWorkerReady(client, projectId, "scripts/redeem.ts", "E2E_STARTED");
            yield* twitchConnectionReady(client);
            return yield* Effect.promise(() =>
              waitFor(async () => {
                const value = [...twitch.subscriptions.values()][0];
                return value === undefined ? undefined : value;
              }),
            );
          }),
        );
        expect(twitch.subscriptions.size).toBe(1);

        const online = await withAgentClient(service.registration, (client) =>
          Effect.gen(function* () {
            const collector = yield* collectLogs(client, projectId, "scripts/redeem.ts");
            yield* Effect.sleep("300 millis");
            const status = yield* Effect.promise(() =>
              postEventSub(process.url, subscription, "e2e-online", "Hydrate"),
            );
            expect(status).toBe(204);
            const entries = yield* waitForLogs(collector, (message) =>
              message.includes("E2E_REWARD:Hydrate"),
            ).pipe(
              Effect.catch((cause) =>
                Effect.fail(
                  new Error(
                    cause.message +
                      " logs=" +
                      JSON.stringify(Ref.getUnsafe(collector.entries)),
                  ),
                ),
              ),
            );
            yield* collector.close;
            return entries;
          }),
        );
        expect(online.filter((entry) => entry.message.includes("E2E_REWARD:Hydrate"))).toHaveLength(1);

        await service.process.stop();
        const offlineStatus = await postEventSub(
          process.url,
          subscription,
          "e2e-offline",
          "Offline Hydrate",
        );
        expect(offlineStatus).toBe(204);

        service = await startService({
          root: join(root, "service"),
          stateDir: service.stateDir,
          dataDir: service.dataDir,
          cloudUrl: process.url,
        });
        await withAgentClient(service.registration, (client) =>
          Effect.gen(function* () {
            yield* twitchConnectionReady(client).pipe(Effect.catch(() => Effect.void));
            const collector = yield* collectLogs(client, projectId, "scripts/redeem.ts");
            const entries = yield* waitForLogs(collector, (message) =>
              message.includes("E2E_REWARD:Offline Hydrate"),
            );
            yield* Effect.sleep("1 second");
            expect(
              entries.filter((entry) => entry.message.includes("E2E_REWARD:Offline Hydrate")),
            ).toHaveLength(1);
            yield* collector.close;
          }),
        );

        await withAgentClient(service.registration, (client) =>
          client.StopScript({ projectId, scriptId: "scripts/redeem.ts" }).pipe(
            Effect.catch(() => Effect.void),
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(twitch.subscriptions.size).toBe(1);

        await withAgentClient(service.registration, (client) =>
          client.StopScript({ projectId, scriptId: "scripts/second.ts" }).pipe(
            Effect.catch(() => Effect.void),
          ),
        );
        await waitFor(async () => (twitch.subscriptions.size === 0 ? true : undefined));
      } catch (cause) {
        throw new Error(
          (cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)) +
            "\n--- service log ---\n" +
            service.process.log().slice(-12_000),
        );
      } finally {
        await service.process.stop();
      }
    },
    150_000,
  );

  it(
    "cloud webhooks: register, signed delivery, rejection and clear on stop",
    async (ctx) => {
      const process = requireCloud(ctx);
      if (process === undefined) return;
      const hookId = "kofi_" + randomBytes(18).toString("base64url");
      const secret = "e2e-webhook-secret";
      const root = await projectWithScripts({ "kofi.ts": kofiScript });
      const service = await startService({ root: join(root, "service"), cloudUrl: process.url });
      try {
        const webhook = await withAgentClient(service.registration, (client) =>
          Effect.gen(function* () {
            yield* pair(client, process.url);
            const detail = yield* client.AddProject({ path: root, name: "E2E Webhook" });
            yield* client.ConfigureConnection({
              connectionId: "http/kofi",
              values: [
                { key: "webhookTransport", value: "cloud" },
                { key: "webhookHookId", value: hookId },
                { key: "webhookVerification", value: "hmac-sha256" },
                { key: "webhookHeader", value: "x-kofi-signature" },
                { key: "webhookSecret", value: secret },
                { key: "webhookResponseStatus", value: "200" },
                { key: "webhookResponseBody", value: "ok" },
              ],
            });
            yield* startAndApprove(client, detail.summary.id, "scripts/kofi.ts");
            yield* waitForWorkerReady(client, detail.summary.id, "scripts/kofi.ts");
            for (let attempt = 0; attempt < 300; attempt++) {
              const connection = yield* client
                .GetConnection({ connectionId: "http/kofi" })
                .pipe(Effect.catch(() => Effect.succeed(undefined)));
              if (connection?.status === "connected" && connection.detail?.startsWith("http"))
                return { projectId: detail.summary.id, url: connection.detail };
              yield* Effect.sleep("100 millis");
            }
            return yield* Effect.fail(new Error("Cloud webhook was not registered"));
          }),
        );

        const body = "kofi-payload";
        const signature = createHmac("sha256", secret).update(body).digest("hex");
        await withAgentClient(service.registration, (client) =>
          Effect.gen(function* () {
            const collector = yield* collectLogs(client, webhook.projectId, "scripts/kofi.ts");
            yield* Effect.sleep("300 millis");
            const response = yield* Effect.promise(() =>
              fetch(webhook.url, {
                method: "POST",
                headers: { "content-type": "text/plain", "x-kofi-signature": signature },
                body,
              }),
            );
            const text = yield* Effect.promise(() => response.text());
            expect(response.status).toBe(200);
            expect(text).toBe("ok");
            const entries = yield* waitForLogs(collector, (message) =>
              message.includes("E2E_HOOK:" + body),
            );
            expect(entries.filter((entry) => entry.message.includes("E2E_HOOK:" + body))).toHaveLength(1);

            const rejected = yield* Effect.promise(() =>
              fetch(webhook.url, {
                method: "POST",
                headers: { "content-type": "text/plain", "x-kofi-signature": "00" },
                body: "forged",
              }),
            );
            expect(rejected.status).toBe(401);
            yield* Effect.sleep("400 millis");
            const after = yield* Ref.get(collector.entries);
            expect(after.filter((entry) => entry.message.includes("E2E_HOOK:"))).toHaveLength(1);
            yield* collector.close;
          }),
        );

        await withAgentClient(service.registration, (client) =>
          client.StopScript({ projectId: webhook.projectId, scriptId: "scripts/kofi.ts" }).pipe(
            Effect.catch(() => Effect.void),
          ),
        );
        const token = await readMachineToken(service.dataDir);
        expect(token).toBeDefined();
        await waitFor(async () => {
          if (token === undefined) return undefined;
          const response = await fetch(process.url + "/api/hooks", {
            headers: { authorization: "Bearer " + token },
          });
          const value: unknown = await response.json();
          if (typeof value !== "object" || value === null) return undefined;
          const hooks = (value as Record<string, unknown>)["hooks"];
          return Array.isArray(hooks) && hooks.length === 0 ? true : undefined;
        });
      } catch (cause) {
        throw new Error(
          (cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)) +
            "\n--- service log ---\n" +
            service.process.log().slice(-12_000),
        );
      } finally {
        await service.process.stop();
      }
    },
    120_000,
  );

  it("Twitch local-app mode against the Twitch CLI is skipped", (ctx) => {
    ctx.skip(
      "twitch CLI 1.1.7 mock-api serves generated data for its own twitch api commands, not a drop-in Helix/OAuth base URL: /helix/users and /oauth2/token both return 404. The agent's existing mock EventSub WebSocket still covers the WebSocket path.",
    );
  });
});
