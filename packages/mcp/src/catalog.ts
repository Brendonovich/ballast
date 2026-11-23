import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as Fake from "@ballast/fake";
import * as Keyboard from "@ballast/module-keyboard";
import * as Midi from "@ballast/module-midi";
import * as OBS from "@ballast/module-obs";
import * as Twitch from "@ballast/module-twitch";
import * as VTS from "@ballast/module-vtube-studio";
import * as WebSocket from "@ballast/module-websocket";

export type JsonSchemaObject = Readonly<Record<string, unknown>>;

export interface CatalogTopic {
  readonly integration: string;
  readonly name: string;
  readonly topic: string;
  readonly description: string;
  readonly scopes: ReadonlyArray<string>;
  readonly onStale: "drop" | "deliver";
  readonly maxAgeMs: number;
  readonly schema?: JsonSchemaObject | undefined;
}

export interface CatalogRequest {
  readonly integration: string;
  readonly name: string;
  readonly description: string;
  readonly scopes: ReadonlyArray<string>;
  readonly input?: JsonSchemaObject | undefined;
  readonly output?: JsonSchemaObject | undefined;
  readonly method?: string | undefined;
  readonly path?: string | undefined;
  readonly docsUrl?: string | undefined;
}

export interface ConnectionKind {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export interface CatalogConnection {
  readonly location: "local" | "cloud" | "either";
  readonly auth: "none" | "oauth" | "local-app" | "plugin-approval" | "macos-permission";
  readonly notes: string;
}

export interface CatalogIntegration {
  readonly id: string;
  readonly package: string;
  readonly title: string;
  readonly description: string;
  readonly connectionKinds: ReadonlyArray<string>;
  readonly connection: CatalogConnection;
  readonly topics: ReadonlyArray<CatalogTopic>;
  readonly requests: ReadonlyArray<CatalogRequest>;
  /** Totals before filtering; `topics`/`requests` may be empty in index mode. */
  readonly topicCount: number;
  readonly requestCount: number;
}

export interface Catalog {
  readonly version: 1;
  readonly integrations: ReadonlyArray<CatalogIntegration>;
  readonly connectionKinds: ReadonlyArray<ConnectionKind>;
}

export const connectionKinds: ReadonlyArray<ConnectionKind> = [
  {
    id: "local-socket",
    title: "Local socket",
    description:
      "The Ballast agent owns a socket to an app on this machine (OBS WebSocket, VTube Studio, MIDI, WebSocket). Events come from the agent and requests are called directly.",
  },
  {
    id: "local-native",
    title: "Local native input",
    description:
      "The agent listens through an OS hook (global keyboard) and may require a macOS permission such as Accessibility.",
  },
  {
    id: "cloud-push",
    title: "Cloud push",
    description:
      "The Ballast cloud holds the provider subscription (for example Twitch EventSub) and relays events to the agent. OAuth runs in the cloud; the agent calls the provider API with short-lived tokens.",
  },
  {
    id: "cloud-webhook",
    title: "Cloud or local webhook",
    description:
      "The user pastes a per-connection URL into a provider such as Ko-fi or Streamlabs. The agent verifies and delivers the webhook locally, or receives it through the cloud relay.",
  },
  {
    id: "request-only",
    title: "Request only",
    description:
      "No event stream: the script only calls requests, for example an outgoing HTTP client.",
  },
];

const humanize = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const toJsonSchema = (schema: Schema.Schema<unknown>): JsonSchemaObject | undefined => {
  try {
    const document = Schema.toJsonSchemaDocument(schema);
    return Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions };
  } catch {
    return undefined;
  }
};

interface TopicLike {
  readonly integration: string;
  readonly topic: string;
  readonly scopes: ReadonlyArray<string>;
  readonly onStale: "drop" | "deliver";
  readonly maxAgeMs: number;
  readonly schema?: Schema.Schema<unknown>;
}

const isTopicLike = (value: unknown): value is TopicLike =>
  Predicate.isReadonlyObject(value) &&
  typeof value["integration"] === "string" &&
  typeof value["topic"] === "string" &&
  Array.isArray(value["scopes"]) &&
  typeof value["onStale"] === "string" &&
  typeof value["maxAgeMs"] === "number" &&
  typeof value["subscribe"] === "function";

const topicFrom = (
  integration: string,
  name: string,
  topic: TopicLike,
  description?: string,
): CatalogTopic => ({
  integration,
  name,
  topic: topic.topic,
  description: description ?? integration + " " + humanize(name),
  scopes: [...topic.scopes],
  onStale: topic.onStale,
  maxAgeMs: topic.maxAgeMs,
  ...(topic.schema === undefined ? {} : { schema: toJsonSchema(topic.schema) }),
});

const topicsFromModule = (
  integration: string,
  module: object,
  descriptions: Readonly<Record<string, string>> = {},
): ReadonlyArray<CatalogTopic> =>
  Object.entries(module).flatMap(([name, value]) =>
    isTopicLike(value)
      ? [topicFrom(integration, name, value, descriptions[name])]
      : [],
  );

const topicsFromRecord = (
  integration: string,
  record: object,
  descriptions: Readonly<Record<string, string>> = {},
): ReadonlyArray<CatalogTopic> =>
  Object.entries(record).flatMap(([name, value]) =>
    isTopicLike(value)
      ? [topicFrom(integration, name, value, descriptions[name])]
      : [],
  );

interface RequestSchemasLike {
  readonly input: Schema.Schema<unknown>;
  readonly output: Schema.Schema<unknown>;
}

const isRequestSchemas = (value: unknown): value is RequestSchemasLike =>
  Predicate.isReadonlyObject(value) &&
  "input" in value &&
  "output" in value &&
  Schema.isSchema(value["input"]) &&
  Schema.isSchema(value["output"]);

interface HelixRequestLike {
  readonly method: string;
  readonly path: string;
  readonly scopes: ReadonlyArray<string>;
  readonly input: Schema.Schema<unknown>;
  readonly output: Schema.Schema<unknown>;
  readonly docsUrl: string;
}

const isHelixRequest = (value: unknown): value is HelixRequestLike =>
  Predicate.isReadonlyObject(value) &&
  typeof value["method"] === "string" &&
  typeof value["path"] === "string" &&
  Array.isArray(value["scopes"]) &&
  Schema.isSchema(value["input"]) &&
  Schema.isSchema(value["output"]);

const requestsFromSchemas = (
  integration: string,
  schemas: object,
  prefix = "",
): ReadonlyArray<CatalogRequest> =>
  Object.entries(schemas).flatMap(([name, value]) => {
    if (!isRequestSchemas(value)) return [];
    const input = toJsonSchema(value.input);
    const output = toJsonSchema(value.output);
    return [
      {
        integration,
        name: integration + "/" + prefix + name,
        description: integration + " request " + humanize(name),
        scopes: [],
        ...(input === undefined ? {} : { input }),
        ...(output === undefined ? {} : { output }),
      },
    ];
  });

const twitchTopics = topicsFromRecord("twitch", Twitch.namedTopics, {
  ChannelPointsRedemption:
    "channel.channel_points_custom_reward_redemption.add; scope channel:read:redemptions",
  ChatMessage: "channel.chat.message; scope user:read:chat",
  Follow: "channel.follow v2; scope moderator:read:followers",
  Subscribe: "channel.subscribe; scope channel:read:subscriptions",
  Cheer: "channel.cheer; scope bits:read",
  Raid: "channel.raid; no scope",
  StreamOnline: "stream.online; no scope",
  StreamOffline: "stream.offline; no scope",
});

const twitchRequests: ReadonlyArray<CatalogRequest> = Object.entries(
  Twitch.Helix.requests,
).flatMap(([name, value]) => {
  if (!isHelixRequest(value)) return [];
  const input = toJsonSchema(value.input);
  const output = toJsonSchema(value.output);
  return [
    {
      integration: "twitch",
      name: "helix/" + name,
      description: "Twitch Helix " + value.method + " " + value.path + " via account.helix",
      scopes: [...value.scopes],
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output }),
      method: value.method,
      path: value.path,
      docsUrl: value.docsUrl,
    },
  ];
});

const midiRequests: ReadonlyArray<CatalogRequest> = [
  {
    integration: "midi",
    name: "midi/noteOn",
    description: "Send a MIDI Note On message.",
    scopes: [],
    input: toJsonSchema(Midi.NoteOnInputSchema),
    output: toJsonSchema(Midi.RequestOutputSchema),
  },
  {
    integration: "midi",
    name: "midi/noteOff",
    description: "Send a MIDI Note Off message.",
    scopes: [],
    input: toJsonSchema(Midi.NoteOffInputSchema),
    output: toJsonSchema(Midi.RequestOutputSchema),
  },
  {
    integration: "midi",
    name: "midi/controlChange",
    description: "Send a MIDI Control Change message.",
    scopes: [],
    input: toJsonSchema(Midi.ControlChangeInputSchema),
    output: toJsonSchema(Midi.RequestOutputSchema),
  },
  {
    integration: "midi",
    name: "midi/programChange",
    description: "Send a MIDI Program Change message.",
    scopes: [],
    input: toJsonSchema(Midi.ProgramChangeInputSchema),
    output: toJsonSchema(Midi.RequestOutputSchema),
  },
  {
    integration: "midi",
    name: "midi/pitchBend",
    description: "Send a signed MIDI pitch bend (-8192 to 8191).",
    scopes: [],
    input: toJsonSchema(Midi.PitchBendInputSchema),
    output: toJsonSchema(Midi.RequestOutputSchema),
  },
  {
    integration: "midi",
    name: "midi/raw",
    description: "Send a complete raw MIDI message; the first byte must be a status byte.",
    scopes: [],
    input: toJsonSchema(Midi.RawInputSchema),
    output: toJsonSchema(Midi.RequestOutputSchema),
  },
];

const keyboardRequests: ReadonlyArray<CatalogRequest> = [
  {
    integration: "keyboard",
    name: "keyboard/tap",
    description: "Tap a key once, optionally holding modifiers, on the streamer's machine.",
    scopes: [],
    input: toJsonSchema(Keyboard.TapInputSchema),
    output: toJsonSchema(Keyboard.RequestOutputSchema),
  },
  {
    integration: "keyboard",
    name: "keyboard/toggle",
    description: "Press or release a key without a matching tap (push-to-talk).",
    scopes: [],
    input: toJsonSchema(Keyboard.ToggleInputSchema),
    output: toJsonSchema(Keyboard.RequestOutputSchema),
  },
];

const websocketRequests: ReadonlyArray<CatalogRequest> = [
  {
    integration: "websocket",
    name: "websocket/connect",
    description: "Declare permission for the client slot to connect to its configured URL.",
    scopes: ["ws:connect:<host>"],
    input: { type: "object", properties: {} },
  },
  {
    integration: "websocket",
    name: "websocket/listen",
    description: "Declare permission for the server slot to listen on its configured host and port.",
    scopes: ["ws:listen:<host>:<port><path>"],
    input: { type: "object", properties: {} },
  },
  {
    integration: "websocket",
    name: "websocket/send",
    description: "Send a text, binary (base64) or JSON frame on a client slot.",
    scopes: [],
    input: {
      type: "object",
      oneOf: [
        { type: "object", properties: { type: { const: "text" }, text: { type: "string" } }, required: ["type", "text"] },
        { type: "object", properties: { type: { const: "binary" }, base64: { type: "string" } }, required: ["type", "base64"] },
        { type: "object", properties: { type: { const: "json" }, value: {} }, required: ["type", "value"] },
      ],
    },
  },
  {
    integration: "websocket",
    name: "websocket/sendToClient",
    description: "Send a frame to one connected client of a server slot.",
    scopes: [],
    input: {
      type: "object",
      properties: { clientId: { type: "string" }, message: { type: "object" } },
      required: ["clientId", "message"],
    },
  },
  {
    integration: "websocket",
    name: "websocket/broadcast",
    description: "Broadcast a frame to every connected client of a server slot.",
    scopes: [],
    input: { type: "object" },
    output: {
      type: "object",
      properties: { delivered: { type: "number" }, failed: { type: "number" } },
    },
  },
];

const httpRequests: ReadonlyArray<CatalogRequest> = [
  {
    integration: "http",
    name: "http/request",
    description:
      "Send an HTTP request to a host the connection is allowed to reach. Hosts become http:host:<host> scopes.",
    scopes: ["http:host:<host>"],
    input: {
      type: "object",
      properties: {
        method: { enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string" },
        query: { type: "object", additionalProperties: true },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: {
          oneOf: [
            { type: "object", properties: { json: {} }, required: ["json"] },
            { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            { type: "object", properties: { binary: { type: "string" }, contentType: { type: "string" } }, required: ["binary"] },
          ],
        },
      },
      required: ["method", "path"],
    },
    output: {
      type: "object",
      properties: {
        status: { type: "number" },
        headers: { type: "object" },
        text: { type: "string" },
        url: { type: "string" },
      },
    },
  },
];

type CatalogIntegrationInput = Omit<CatalogIntegration, "topicCount" | "requestCount">;

const integrationCatalog: ReadonlyArray<CatalogIntegrationInput> = [
  {
    id: "fake",
    package: "@ballast/fake",
    title: "Fake",
    description:
      "Deterministic tick/chat/echo integration for examples and tests. The agent's dev driver emits a tick once a second and a chat message roughly every three seconds.",
    connectionKinds: ["local-socket"],
    connection: { location: "local", auth: "none", notes: "In-process test driver; no real service." },
    topics: topicsFromModule("fake", Fake),
    requests: [
      {
        integration: "fake",
        name: "fake/echo",
        description: "Echo text back. The plan client dies if called during init.",
        scopes: ["fake:write"],
        input: toJsonSchema(Fake.EchoInputSchema),
        output: toJsonSchema(Fake.EchoOutputSchema),
      },
    ],
  },
  {
    id: "obs",
    package: "@ballast/module-obs",
    title: "OBS Studio",
    description:
      "OBS WebSocket 5.x: scenes, sources, filters, transitions, recording/streaming state and the full request/event namespace. Local connection, no OAuth.",
    connectionKinds: ["local-socket"],
    connection: { location: "local", auth: "none", notes: "WebSocket URL and password; the connection grants obs/*." },
    topics: topicsFromModule("obs", OBS),
    requests: requestsFromSchemas("obs", OBS.RequestSchemas),
  },
  {
    id: "twitch",
    package: "@ballast/module-twitch",
    title: "Twitch",
    description:
      "Twitch EventSub topics and Helix requests. Use Twitch.Account(slot) and account.helix(name) so the exact OAuth scopes are recorded for consent.",
    connectionKinds: ["cloud-push"],
    connection: {
      location: "either",
      auth: "oauth",
      notes: "Cloud OAuth by default; local-app OAuth is available. One connection per Twitch account slot.",
    },
    topics: twitchTopics,
    requests: twitchRequests,
  },
  {
    id: "vts",
    package: "@ballast/module-vtube-studio",
    title: "VTube Studio",
    description:
      "VTube Studio plugin API: model/hotkey/expression/item events and the request namespace. Local connection with a one-time Allow prompt.",
    connectionKinds: ["local-socket"],
    connection: {
      location: "local",
      auth: "plugin-approval",
      notes: "The user approves the Ballast plugin in VTube Studio; no OAuth.",
    },
    topics: topicsFromRecord("vts", VTS.namedTopics),
    requests: requestsFromSchemas("vts", VTS.RequestSchemas),
  },
  {
    id: "keyboard",
    package: "@ballast/module-keyboard",
    title: "Keyboard",
    description:
      "Global keyboard events and synthetic key taps. macOS needs Accessibility permission, reported by the desktop shell.",
    connectionKinds: ["local-native"],
    connection: {
      location: "local",
      auth: "macos-permission",
      notes: "On macOS the user grants Accessibility to the Ballast app.",
    },
    topics: topicsFromModule("keyboard", Keyboard),
    requests: keyboardRequests,
  },
  {
    id: "midi",
    package: "@ballast/module-midi",
    title: "MIDI",
    description:
      "MIDI input events (note on/off, control change, program change, pitch bend, raw) and output messages to a configured device.",
    connectionKinds: ["local-socket"],
    connection: { location: "local", auth: "none", notes: "Choose input/output ports in connection settings." },
    topics: topicsFromModule("midi", Midi),
    requests: midiRequests,
  },
  {
    id: "websocket",
    package: "@ballast/module-websocket",
    title: "WebSocket",
    description:
      "A WebSocket client slot and a local WebSocket server slot, with text/binary/JSON frames and connection lifecycle events.",
    connectionKinds: ["local-socket"],
    connection: { location: "local", auth: "none", notes: "URL for clients; host/port/path for servers." },
    topics: topicsFromModule("websocket", WebSocket),
    requests: websocketRequests,
  },
  {
    id: "http",
    package: "@ballast/module-http",
    title: "HTTP and webhooks",
    description:
      "Outgoing HTTP requests with per-host scopes, plus local or cloud webhooks for providers such as Ko-fi and Streamlabs.",
    connectionKinds: ["request-only", "cloud-webhook"],
    connection: {
      location: "either",
      auth: "none",
      notes: "HTTP client base URL and allowed hosts; webhook slots get a generated URL.",
    },
    topics: [
      {
        integration: "http",
        name: "Webhook",
        topic: "http/webhook",
        description:
          "A verified webhook delivery. Scope http:webhook:<hook>; the hook name is the connection slot.",
        scopes: ["http:webhook:<hook>"],
        onStale: "drop",
        maxAgeMs: 60_000,
      },
    ],
    requests: httpRequests,
  },
];

export const catalog: Catalog = {
  version: 1,
  integrations: integrationCatalog.map((integration) => ({
    ...integration,
    topicCount: integration.topics.length,
    requestCount: integration.requests.length,
  })),
  connectionKinds,
};

const normalize = (value: string): string => value.toLowerCase();

export interface CatalogFilter {
  readonly integration?: string | undefined;
  readonly kind?: "topics" | "requests" | "connections" | "all" | undefined;
  readonly search?: string | undefined;
  readonly includeSchemas?: boolean | undefined;
  readonly limit?: number | undefined;
}

export interface CatalogSelection {
  readonly integrations: ReadonlyArray<CatalogIntegration>;
  readonly connectionKinds: ReadonlyArray<ConnectionKind>;
}

const matchesIntegration = (integration: CatalogIntegration, filter: string): boolean => {
  const needle = normalize(filter);
  return (
    normalize(integration.id) === needle ||
    normalize(integration.package) === needle ||
    normalize(integration.title) === needle
  );
};

const matchesText = (value: string, search: string): boolean =>
  normalize(value).includes(normalize(search));

export const selectCatalog = (filter: CatalogFilter = {}): CatalogSelection => {
  const includeSchemas = filter.includeSchemas === true;
  const kind = filter.kind ?? "all";
  const limit = Math.max(1, Math.min(filter.limit ?? 50, 200));
  const search = filter.search?.trim();
  // A bare catalog call is an index. Topics and requests (especially OBS's
  // hundreds) appear only when the caller narrows the query.
  const detailed =
    (filter.integration !== undefined && filter.integration !== "") ||
    (search !== undefined && search !== "") ||
    kind === "topics" ||
    kind === "requests";

  const selected = catalog.integrations
    .filter((integration) =>
      filter.integration === undefined || filter.integration === ""
        ? true
        : matchesIntegration(integration, filter.integration),
    )
    .map((integration) => {
      const showTopics = detailed && kind !== "requests" && kind !== "connections";
      const showRequests = detailed && kind !== "topics" && kind !== "connections";
      const topics = showTopics
        ? integration.topics
            .filter((topic) =>
              search === undefined || search === ""
                ? true
                : matchesText(topic.name, search) ||
                  matchesText(topic.topic, search) ||
                  matchesText(topic.description, search),
            )
            .slice(0, limit)
            .map((topic) =>
              includeSchemas
                ? topic
                : {
                    integration: topic.integration,
                    name: topic.name,
                    topic: topic.topic,
                    description: topic.description,
                    scopes: topic.scopes,
                    onStale: topic.onStale,
                    maxAgeMs: topic.maxAgeMs,
                  },
            )
        : [];
      const requests = showRequests
        ? integration.requests
            .filter((request) =>
              search === undefined || search === ""
                ? true
                : matchesText(request.name, search) ||
                  matchesText(request.description, search),
            )
            .slice(0, limit)
            .map((request) =>
              includeSchemas
                ? request
                : {
                    integration: request.integration,
                    name: request.name,
                    description: request.description,
                    scopes: request.scopes,
                    ...(request.method === undefined ? {} : { method: request.method }),
                    ...(request.path === undefined ? {} : { path: request.path }),
                    ...(request.docsUrl === undefined ? {} : { docsUrl: request.docsUrl }),
                  },
            )
        : [];
      return { ...integration, topics, requests };
    });

  return {
    integrations: selected,
    connectionKinds:
      kind === "connections" || (kind === "all" && !detailed)
        ? catalog.connectionKinds
        : [],
  };
};

const truncate = (value: string, length = 240): string =>
  value.length <= length ? value : value.slice(0, length - 1) + "…";

export const formatCatalog = (selection: CatalogSelection): string => {
  const lines: Array<string> = [];
  lines.push(
    "Ballast catalog: " +
      selection.integrations.length +
      " integration" +
      (selection.integrations.length === 1 ? "" : "s"),
  );
  for (const integration of selection.integrations) {
    lines.push("");
    lines.push(
      integration.id +
        " (" +
        integration.package +
        ") — " +
        integration.title +
        "; " +
        integration.connection.location +
        ", " +
        integration.connection.auth,
    );
    lines.push("  " + integration.description);
    lines.push(
      "  topics: " +
        integration.topicCount +
        " · requests: " +
        integration.requestCount,
    );
    if (integration.topics.length > 0) {
      lines.push("  topics:");
      for (const topic of integration.topics) {
        const scopes = topic.scopes.length === 0 ? "no scopes" : topic.scopes.join(", ");
        lines.push("    - " + topic.topic + " (name " + topic.name + "; " + scopes + ") — " + topic.description);
        if (topic.schema !== undefined) {
          lines.push("      schema: " + truncate(JSON.stringify(topic.schema), 600));
        }
      }
    }
    if (integration.requests.length > 0) {
      lines.push("  requests:");
      for (const request of integration.requests) {
        const scopes = request.scopes.length === 0 ? "no scopes" : request.scopes.join(", ");
        lines.push("    - " + request.name + " (" + scopes + ") — " + request.description);
        if (request.input !== undefined) {
          lines.push("      input: " + truncate(JSON.stringify(request.input), 600));
        }
        if (request.output !== undefined) {
          lines.push("      output: " + truncate(JSON.stringify(request.output), 600));
        }
      }
    }
  }
  if (selection.connectionKinds.length > 0) {
    lines.push("");
    lines.push("connection kinds:");
    for (const kind of selection.connectionKinds) {
      lines.push("  - " + kind.id + ": " + kind.title + " — " + kind.description);
    }
  }
  return lines.join("\n");
};
