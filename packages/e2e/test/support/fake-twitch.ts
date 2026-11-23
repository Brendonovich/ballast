import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface FakeTwitchSubscription {
  readonly id: string;
  type: string;
  version: string;
  condition: Readonly<Record<string, string>>;
  status: string;
  transport: { readonly method: "webhook"; readonly callback: string; secret: string };
  readonly createdAt: string;
}

export interface FakeTwitch {
  readonly url: string;
  readonly subscriptions: Map<string, FakeTwitchSubscription>;
  readonly close: () => Promise<void>;
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const objectOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : undefined;

const stringField = (value: Readonly<Record<string, unknown>>, key: string): string | undefined =>
  typeof value[key] === "string" ? value[key] : undefined;

const conditionOf = (value: unknown): Readonly<Record<string, string>> | undefined => {
  const object = objectOf(value);
  if (object === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (typeof entry !== "string") return undefined;
    result[key] = entry;
  }
  return result;
};

const user = {
  id: "12345",
  login: "streamer",
  display_name: "Streamer",
  type: "",
  broadcaster_type: "",
  description: "",
  profile_image_url: "",
  offline_image_url: "",
  view_count: 0,
  created_at: "2020-01-01T00:00:00.000Z",
};

const tokenResponse = (grant: string) => ({
  access_token: grant === "refresh_token" ? "refreshed-access" : "e2e-access",
  ...(grant === "client_credentials" ? {} : { refresh_token: "e2e-refresh" }),
  expires_in: 3600,
  scope: [
    "user:read:email",
    "channel:read:redemptions",
    "channel:read:subscriptions",
    "bits:read",
    "user:read:chat",
    "moderator:read:followers",
  ],
  token_type: "bearer",
});

export const startFakeTwitch = async (): Promise<FakeTwitch> => {
  const subscriptions = new Map<string, FakeTwitchSubscription>();
  let nextId = 1;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readBody(request);

    if (request.method === "POST" && url.pathname === "/oauth2/token") {
      const form = new URLSearchParams(body);
      const grant = form.get("grant_type") ?? "authorization_code";
      json(response, 200, tokenResponse(grant));
      return;
    }

    if (request.method === "GET" && url.pathname === "/oauth2/validate") {
      json(response, 200, {
        client_id: "e2e-client",
        login: user.login,
        scopes: tokenResponse("authorization_code").scope,
        user_id: user.id,
        expires_in: 3600,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/helix/users") {
      json(response, 200, { data: [user] });
      return;
    }

    if (url.pathname === "/helix/eventsub/subscriptions") {
      if (request.method === "GET") {
        json(response, 200, {
          data: [...subscriptions.values()].map((subscription) => ({
            id: subscription.id,
            type: subscription.type,
            version: subscription.version,
            condition: subscription.condition,
            status: subscription.status,
            created_at: subscription.createdAt,
            transport: {
              method: "webhook",
              callback: subscription.transport.callback,
            },
          })),
          total: subscriptions.size,
        });
        return;
      }
      if (request.method === "POST") {
        const parsed: unknown = JSON.parse(body);
        const root = objectOf(parsed);
        const transport = objectOf(root?.["transport"]);
        const type = root === undefined ? undefined : stringField(root, "type");
        const version = root === undefined ? undefined : stringField(root, "version");
        const condition = conditionOf(root?.["condition"]);
        const callback = transport === undefined ? undefined : stringField(transport, "callback");
        const secret = transport === undefined ? undefined : stringField(transport, "secret");
        if (
          type === undefined ||
          version === undefined ||
          condition === undefined ||
          callback === undefined ||
          secret === undefined
        ) {
          json(response, 400, { message: "invalid subscription" });
          return;
        }
        const id = "sub_" + nextId++;
        const subscription: FakeTwitchSubscription = {
          id,
          type,
          version,
          condition,
          status: "enabled",
          transport: { method: "webhook", callback, secret },
          createdAt: new Date().toISOString(),
        };
        subscriptions.set(id, subscription);
        json(response, 202, {
          data: [
            {
              id,
              type,
              version,
              condition,
              status: "enabled",
              created_at: subscription.createdAt,
              transport: { method: "webhook", callback },
              cost: 1,
            },
          ],
          total: 1,
          total_cost: 1,
          max_total_cost: 10,
        });
        return;
      }
      if (request.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (id !== null) subscriptions.delete(id);
        response.writeHead(204);
        response.end();
        return;
      }
    }

    json(response, 404, { message: "not found", path: url.pathname });
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fake Twitch port");
  return {
    url: "http://127.0.0.1:" + address.port,
    subscriptions,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};
