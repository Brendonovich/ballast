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

const projectWithSource = async (
  root: string,
  name: string,
  source: string,
): Promise<string> => {
  const project = join(root, name);
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "ballast.ts"), source, "utf8");
  return project;
};

const twitchProjectSource = (marker: string, title: string): string =>
  [
    'import * as Twitch from "@ballast/module-twitch";',
    'import { Effect } from "effect";',
    "",
    `export const title = "${title}";`,
    "",
    "export default Effect.gen(function* () {",
    '  const broadcaster = yield* Twitch.Account("broadcaster");',
    '  yield* Twitch.ChannelPointsRedemption.subscribe("redemption", broadcaster, (event) =>',
    `    Effect.sync(() => console.log("E2E_REWARD:${marker}:" + event.reward.title)),`,
    "  );",
    '  yield* Effect.log("E2E_STARTED");',
    "});",
    "",
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

interface LogCollector {
  readonly entries: Ref.Ref<ReadonlyArray<LogEntry>>;
  readonly close: Effect.Effect<void>;
}

const collectLogs = (
  client: Client,
  projectId: string,
  scriptId?: string,
): Effect.Effect<LogCollector> =>
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyArray<LogEntry>>([]);
    const fiber = yield* client
      .StreamLogs({
        projectId,
        ...(scriptId === undefined ? {} : { scriptId }),
        afterSeq: 0,
      })
      .pipe(
        Stream.runForEach((entry) => Ref.update(entries, (current) => [...current, entry])),
        Effect.forkChild,
      );
    return { entries, close: Fiber.interrupt(fiber).pipe(Effect.asVoid) };
  });

const waitForWorkerReady = (
  client: Client,
  projectId: string,
  scriptId: string | undefined,
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

const twitchConnectionReady = (client: Client, connectionId: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt++) {
      const connections = yield* client.ListConnections().pipe(
        Effect.catch(() => Effect.succeed({ connections: [] })),
      );
      const connection = connections.connections.find(
        (entry) => entry.id === connectionId,
      );
      if (connection?.status === "connected") return connection;
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(new Error("Cloud Twitch connection did not connect"));
  });

const startProjectAndApprove = (client: Client, projectId: string) =>
  Effect.gen(function* () {
    let lastStatus: string | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      const detail = yield* client
        .GetProject({ projectId })
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      lastStatus =
        detail === undefined
          ? "missing"
          : detail.summary.status +
            (detail.summary.issues.length === 0
              ? ""
              : ": " +
                detail.summary.issues
                  .map((issue) => issue.title)
                  .join("; "));
      if (detail?.summary.status === "running" && detail.pendingConsent === undefined) {
        return detail;
      }
      if (detail?.pendingConsent !== undefined) {
        yield* client
          .ApproveProjectConsent({ consentId: detail.pendingConsent.id })
          .pipe(Effect.catch(() => Effect.void));
      } else if (detail?.summary.status !== "running") {
        yield* client.StartProject({ projectId }).pipe(Effect.catch(() => Effect.void));
      }
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(
      new Error(
        "Project did not start: " + projectId + " (lastStatus=" + (lastStatus ?? "unknown") + ")",
      ),
    );
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
      const root = await mkdtemp(join(tmpdir(), "ballast-e2e-twitch-"));
      const one = await projectWithSource(
        root,
        "one",
        twitchProjectSource("ONE", "E2E One"),
      );
      const two = await projectWithSource(
        root,
        "two",
        twitchProjectSource("TWO", "E2E Two"),
      );
      let service: ServiceProcess = await startService({
        root: join(root, "service"),
        cloudUrl: process.url,
      });
      try {
        const setup = await withAgentClient(service.registration, (client) =>
          Effect.gen(function* () {
            yield* pair(client, process.url);
            const first = yield* client.AddProject({ path: one, name: "E2E One" });
            const second = yield* client.AddProject({ path: two, name: "E2E Two" });
            const connection = yield* client.CreateConnection({
              integration: "twitch",
              label: "E2E Twitch",
              config: {},
              mode: "cloud",
            });
            for (const project of [first, second]) {
              yield* client.SetProjectBinding({
                projectId: project.summary.id,
                integration: "twitch",
                slot: "broadcaster",
                instanceId: connection.id,
              });
            }
            return {
              first: first.summary.id,
              second: second.summary.id,
              connectionId: connection.id,
            };
          }),
        );

        const subscription = await withAgentClient(service.registration, (client) =>
          Effect.gen(function* () {
            yield* startProjectAndApprove(client, setup.first);
            yield* startProjectAndApprove(client, setup.second);
            yield* waitForWorkerReady(client, setup.first, undefined, "E2E_STARTED");
            yield* waitForWorkerReady(client, setup.second, undefined, "E2E_STARTED");
            yield* twitchConnectionReady(client, setup.connectionId);
            return yield* Effect.promise(() =>
              waitFor(async () => {
                const value = [...twitch.subscriptions.values()][0];
                return value === undefined ? undefined : value;
              }),
            );
          }),
        );
        expect(twitch.subscriptions.size).toBe(1);

        await withAgentClient(service.registration, (client) =>
          Effect.gen(function* () {
            const firstLogs = yield* collectLogs(client, setup.first);
            const secondLogs = yield* collectLogs(client, setup.second);
            yield* Effect.sleep("300 millis");
            const status = yield* Effect.promise(() =>
              postEventSub(process.url, subscription, "e2e-online", "Hydrate"),
            );
            expect(status).toBe(204);
            yield* waitForLogs(firstLogs, (message) =>
              message.includes("E2E_REWARD:ONE:Hydrate"),
            ).pipe(
              Effect.catch((cause) =>
                Effect.fail(
                  new Error(
                    cause.message +
                      " logs=" +
                      JSON.stringify(Ref.getUnsafe(firstLogs.entries)),
                  ),
                ),
              ),
            );
            yield* waitForLogs(secondLogs, (message) =>
              message.includes("E2E_REWARD:TWO:Hydrate"),
            );
            yield* firstLogs.close;
            yield* secondLogs.close;
          }),
        );

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
            yield* twitchConnectionReady(client, setup.connectionId).pipe(
              Effect.catch(() => Effect.void),
            );
            const firstLogs = yield* collectLogs(client, setup.first);
            const secondLogs = yield* collectLogs(client, setup.second);
            const first = yield* waitForLogs(firstLogs, (message) =>
              message.includes("E2E_REWARD:ONE:Offline Hydrate"),
            );
            const second = yield* waitForLogs(secondLogs, (message) =>
              message.includes("E2E_REWARD:TWO:Offline Hydrate"),
            );
            yield* Effect.sleep("1 second");
            expect(
              first.filter((entry) =>
                entry.message.includes("E2E_REWARD:ONE:Offline Hydrate"),
              ),
            ).toHaveLength(1);
            expect(
              second.filter((entry) =>
                entry.message.includes("E2E_REWARD:TWO:Offline Hydrate"),
              ),
            ).toHaveLength(1);
            yield* firstLogs.close;
            yield* secondLogs.close;
          }),
        );

        await withAgentClient(service.registration, (client) =>
          client.StopProject({ projectId: setup.first }).pipe(
            Effect.catch(() => Effect.void),
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(twitch.subscriptions.size).toBe(1);

        await withAgentClient(service.registration, (client) =>
          client.StopProject({ projectId: setup.second }).pipe(
            Effect.catch(() => Effect.void),
          ),
        );
        await waitFor(async () => (twitch.subscriptions.size === 0 ? true : undefined));
      } catch (cause) {
        const detail =
          cause instanceof Error
            ? (cause.stack ?? cause.message)
            : typeof cause === "object" && cause !== null
              ? JSON.stringify(cause)
              : String(cause);
        throw new Error(
          detail + "\n--- service log ---\n" + service.process.log().slice(-12_000),
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
      const root = await mkdtemp(join(tmpdir(), "ballast-e2e-webhook-"));
      const project = await projectWithSource(root, "project", kofiScript);
      const service = await startService({ root: join(root, "service"), cloudUrl: process.url });
      try {
        const webhook = await withAgentClient(service.registration, (client) =>
          Effect.gen(function* () {
            yield* pair(client, process.url);
            const detail = yield* client.AddProject({ path: project, name: "E2E Webhook" });
            const connection = yield* client.CreateConnection({
              integration: "http",
              label: "Ko-fi",
              config: {
                webhookTransport: "cloud",
                webhookHookId: hookId,
                webhookVerification: "hmac-sha256",
                webhookHeader: "x-kofi-signature",
                webhookSecret: secret,
                webhookResponseStatus: "200",
                webhookResponseBody: "ok",
              },
            });
            yield* client.SetProjectBinding({
              projectId: detail.summary.id,
              integration: "http",
              slot: "kofi",
              instanceId: connection.id,
            });
            yield* startProjectAndApprove(client, detail.summary.id);
            let last: { readonly status: string; readonly detail?: string; readonly error?: string } | undefined;
            for (let attempt = 0; attempt < 300; attempt++) {
              const current = yield* client
                .GetConnection({ connectionId: connection.id })
                .pipe(Effect.catch(() => Effect.succeed(undefined)));
              last = current === undefined
                ? undefined
                : {
                    status: current.status,
                    ...(current.detail === undefined ? {} : { detail: current.detail }),
                    ...(current.lastError === undefined ? {} : { error: current.lastError }),
                  };
              if (current?.status === "connected" && current.detail?.startsWith("http"))
                return { projectId: detail.summary.id, url: current.detail };
              yield* Effect.sleep("100 millis");
            }
            return yield* Effect.fail(
              new Error("Cloud webhook was not registered: " + JSON.stringify(last ?? null)),
            );
          }),
        );

        const body = "kofi-payload";
        const signature = createHmac("sha256", secret).update(body).digest("hex");
        await withAgentClient(service.registration, (client) =>
          Effect.gen(function* () {
            const collector = yield* collectLogs(client, webhook.projectId);
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
          client.StopProject({ projectId: webhook.projectId }).pipe(
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
        const detail =
          cause instanceof Error
            ? (cause.stack ?? cause.message)
            : typeof cause === "object" && cause !== null
              ? JSON.stringify(cause)
              : String(cause);
        throw new Error(
          detail + "\n--- service log ---\n" + service.process.log().slice(-12_000),
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
