import { Schema } from "effect";

import {
  ConnectionApproval,
  ConnectionLocation,
  ConnectionMode,
  ConnectionStatus,
} from "./common.ts";
export const ConnectionBindingRef = Schema.Struct({
  projectId: Schema.String,
  /** The project-local requirement name, e.g. "main" or "broadcaster". */
  slot: Schema.String,
});
export type ConnectionBindingRef = typeof ConnectionBindingRef.Type;

export const ConnectionFieldKind = Schema.Literals(["url", "text", "secret", "select"]);
export type ConnectionFieldKind = typeof ConnectionFieldKind.Type;

/**
 * A settings field a connection accepts. The agent sends these descriptors so
 * the UI does not hard-code per-integration forms; the integration catalog
 * remains the source of truth.
 */
export const ConnectionField = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  kind: ConnectionFieldKind,
  required: Schema.Boolean,
  placeholder: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  /** Allowed values when `kind` is `"select"`. */
  options: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ConnectionField = typeof ConnectionField.Type;

/**
 * A configured value. Secrets are never sent back: `value` is absent and
 * `isSet` says whether one is stored.
 */
export const ConnectionValue = Schema.Struct({
  key: Schema.String,
  value: Schema.optionalKey(Schema.String),
  isSecret: Schema.Boolean,
  isSet: Schema.Boolean,
});
export type ConnectionValue = typeof ConnectionValue.Type;

export const ConnectionScopes = Schema.Struct({
  granted: Schema.Array(Schema.String),
  /** The union of scopes the running scripts need from this connection. */
  required: Schema.Array(Schema.String),
  missing: Schema.Array(Schema.String),
});
export type ConnectionScopes = typeof ConnectionScopes.Type;

export const ConnectionAccount = Schema.Struct({
  id: Schema.String,
  login: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
  avatarUrl: Schema.optionalKey(Schema.String),
});
export type ConnectionAccount = typeof ConnectionAccount.Type;

export const ConnectionSummary = Schema.Struct({
  id: Schema.String,
  integration: Schema.String,
  /** The integration's display name, for example "OBS Studio". */
  title: Schema.String,
  /** The user-facing name of this connection, for example "Main OBS". */
  label: Schema.String,
  location: ConnectionLocation,
  mode: ConnectionMode,
  status: ConnectionStatus,
  fields: Schema.Array(ConnectionField),
  values: Schema.Array(ConnectionValue),
  scopes: ConnectionScopes,
  /** Project requirements currently bound to this instance. */
  boundBy: Schema.Array(ConnectionBindingRef),
  account: Schema.optionalKey(ConnectionAccount),
  detail: Schema.optionalKey(Schema.String),
  lastError: Schema.optionalKey(Schema.String),
  lastConnectedAt: Schema.optionalKey(Schema.Number),
  /**
   * A pending out-of-app approval, for example VTube Studio's Allow dialog or
   * macOS Accessibility. Not an auth failure; the connection may still be
   * connecting or listening.
   */
  approval: Schema.optionalKey(ConnectionApproval),
  /** True when the connection needs a browser or device-code flow before use. */
  requiresAuth: Schema.Boolean,
});
export type ConnectionSummary = typeof ConnectionSummary.Type;

export const CreateConnectionRequest = Schema.Struct({
  integration: Schema.String,
  label: Schema.String,
  /** Field values keyed by the integration catalog's field keys. */
  config: Schema.Record(Schema.String, Schema.String),
  mode: Schema.optionalKey(ConnectionMode),
});
export type CreateConnectionRequest = typeof CreateConnectionRequest.Type;

export const UpdateConnectionRequest = Schema.Struct({
  id: Schema.String,
  label: Schema.optionalKey(Schema.String),
  config: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  mode: Schema.optionalKey(ConnectionMode),
});
export type UpdateConnectionRequest = typeof UpdateConnectionRequest.Type;

export const DeleteConnectionRequest = Schema.Struct({
  id: Schema.String,
});
export type DeleteConnectionRequest = typeof DeleteConnectionRequest.Type;

export const ConfigureConnectionRequest = Schema.Struct({
  connectionId: Schema.String,
  /** Only the fields being changed; secret values are accepted here and stored. */
  values: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
  mode: Schema.optionalKey(ConnectionMode),
});
export type ConfigureConnectionRequest = typeof ConfigureConnectionRequest.Type;

export const ConnectionAuth = Schema.Union([
  Schema.TaggedStruct("none", {
    message: Schema.String,
  }),
  Schema.TaggedStruct("browser", {
    url: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.TaggedStruct("device-code", {
    verificationUrl: Schema.String,
    userCode: Schema.String,
    expiresAt: Schema.Number,
  }),
]);
export type ConnectionAuth = typeof ConnectionAuth.Type;

export const StartConnectionAuthRequest = Schema.Struct({
  connectionId: Schema.String,
  mode: Schema.optionalKey(ConnectionMode),
  /** Extra OAuth scopes to request, on top of the manifest's required scopes. */
  scopes: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type StartConnectionAuthRequest = typeof StartConnectionAuthRequest.Type;

export const ConnectionIdRequest = Schema.Struct({
  connectionId: Schema.String,
});
export type ConnectionIdRequest = typeof ConnectionIdRequest.Type;

export const ListConnectionsResponse = Schema.Struct({
  connections: Schema.Array(ConnectionSummary),
});
export type ListConnectionsResponse = typeof ListConnectionsResponse.Type;

/** Field values shared by the mock and, later, integration descriptors. */
export const obsFields: ReadonlyArray<ConnectionField> = [
  {
    key: "url",
    label: "WebSocket URL",
    kind: "url",
    required: true,
    placeholder: "ws://127.0.0.1:4455",
  },
  {
    key: "password",
    label: "Password",
    kind: "secret",
    required: false,
    description: "Stored in Ballast's data directory with 0600 file permissions.",
  },
];

const textField = (
  key: string,
  label: string,
  description?: string,
): ConnectionField => ({
  key,
  label,
  kind: "text",
  required: false,
  ...(description === undefined ? {} : { description }),
});

const secretField = (
  key: string,
  label: string,
  description?: string,
): ConnectionField => ({
  key,
  label,
  kind: "secret",
  required: false,
  ...(description === undefined ? {} : { description }),
});

const selectField = (
  key: string,
  label: string,
  options: ReadonlyArray<string>,
  description?: string,
): ConnectionField => ({
  key,
  label,
  kind: "select",
  required: false,
  options: [...options],
  ...(description === undefined ? {} : { description }),
});

export const twitchFields: ReadonlyArray<ConnectionField> = [
  {
    key: "clientId",
    label: "Client ID",
    kind: "text",
    required: false,
    description: "From your Twitch application; used in local-app mode.",
  },
  {
    key: "clientSecret",
    label: "Client secret",
    kind: "secret",
    required: false,
    description: "Only used in local-app mode. Never leaves this machine.",
  },
  textField(
    "connection",
    "Cloud connection",
    "Cloud Twitch connection id or login, for cloud mode.",
  ),
];

export const vtsFields: ReadonlyArray<ConnectionField> = [
  textField("url", "WebSocket URL", "Defaults to ws://127.0.0.1:8001."),
  textField("pluginName", "Plugin name", "Shown in the VTube Studio approval dialog."),
  textField("pluginDeveloper", "Plugin developer"),
  textField("pluginIcon", "Plugin icon (base64, 128x128)"),
];

export const keyboardFields: ReadonlyArray<ConnectionField> = [
  selectField(
    "permission",
    "macOS permission",
    ["unknown", "granted", "denied"],
    "Provided by the shell where it can query Accessibility.",
  ),
];

export const midiFields: ReadonlyArray<ConnectionField> = [
  textField("input", "Input port", "Leave empty when the script only sends MIDI."),
  textField("output", "Output port", "Default output for send requests."),
];

export const websocketFields: ReadonlyArray<ConnectionField> = [
  selectField("mode", "Mode", ["auto", "client", "server"]),
  textField("url", "Client URL", "ws:// or wss://; required for a client slot."),
  textField("headers", "Headers (JSON)", 'For example {"authorization":"Bearer ..."}'),
  secretField("headersSecret", "Secret headers (JSON)", "Merged over the plain headers."),
  textField("subprotocols", "Subprotocols (comma separated)"),
  textField("serverHost", "Server host", "Defaults to 127.0.0.1."),
  textField("serverPort", "Server port", "Required for a server slot."),
  textField("serverPath", "Server path", "Defaults to every path."),
];

export const httpFields: ReadonlyArray<ConnectionField> = [
  textField("baseUrl", "Base URL", "Required for HTTP client requests."),
  textField("headers", "Default headers (JSON)"),
  secretField("headersSecret", "Secret headers (JSON)", "Merged over the plain headers."),
  selectField("authType", "Auth", ["none", "bearer", "basic", "header"]),
  secretField("authToken", "Bearer token"),
  textField("authUsername", "Basic auth username"),
  secretField("authPassword", "Basic auth password"),
  textField("authHeaderName", "Auth header name"),
  secretField("authHeaderValue", "Auth header value"),
  textField(
    "allowedHosts",
    "Allowed hosts (comma separated)",
    "The manifest host scopes are always enforced too.",
  ),
  selectField("webhookTransport", "Webhook transport", ["local", "cloud"]),
  textField("webhookHookId", "Cloud hook id", "Optional stable id; generated from the slot otherwise."),
  textField("webhookHost", "Webhook host", "Defaults to 127.0.0.1."),
  textField("webhookPort", "Webhook port", "Defaults to 8787."),
  textField("webhookPath", "Webhook path", "Defaults to /hooks/<slot>."),
  selectField("webhookVerification", "Webhook verification", [
    "none",
    "shared-secret",
    "hmac-sha256",
  ]),
  textField("webhookHeader", "Verification header"),
  secretField("webhookSecret", "Verification secret"),
  textField("webhookTimestampHeader", "Timestamp header"),
  textField("webhookTolerance", "Timestamp tolerance (seconds)"),
  textField("webhookResponseStatus", "Static response status"),
  textField("webhookResponseBody", "Static response body"),
  textField("webhookMaxAgeMs", "Max event age (ms)"),
  selectField("webhookOnStale", "Stale events", ["drop", "deliver"]),
];

/** One integration kind available to the Add connection dialog. */
export const ConnectionIntegration = Schema.Struct({
  integration: Schema.String,
  title: Schema.String,
  location: ConnectionLocation,
  modes: Schema.Array(ConnectionMode),
  requiresAuth: Schema.Boolean,
  fields: Schema.Array(ConnectionField),
  description: Schema.optionalKey(Schema.String),
  /** Static own-app OAuth redirect the user must register, when configured. */
  redirectUrl: Schema.optionalKey(Schema.String),
});
export type ConnectionIntegration = typeof ConnectionIntegration.Type;



export const fakeFields: ReadonlyArray<ConnectionField> = [
  {
    key: "prefix",
    label: "Prefix",
    kind: "text",
    required: false,
    placeholder: ">",
  },
];

/**
 * The port Ballast tells users to register in the Twitch developer console.
 * Twitch requires an exact redirect URI match, so this must stay stable unless
 * BALLAST_TWITCH_CALLBACK_PORT overrides it.
 */
export const DEFAULT_TWITCH_CALLBACK_PORT = 17345;

/** The source of truth for connection form fields and supported modes. */
export const connectionIntegrations: ReadonlyArray<ConnectionIntegration> = [
  {
    integration: "obs",
    title: "OBS Studio",
    location: "local",
    modes: ["local-app"],
    requiresAuth: false,
    fields: obsFields,
    description:
      "OBS WebSocket 5.x: scenes, sources, filters, transitions, recording and streaming.",
  },
  {
    integration: "twitch",
    title: "Twitch",
    location: "either",
    modes: ["auto", "local-app", "cloud"],
    requiresAuth: true,
    fields: twitchFields,
    description:
      "A Twitch account through the Ballast cloud relay or your own Twitch application.",
    redirectUrl: `http://127.0.0.1:${DEFAULT_TWITCH_CALLBACK_PORT}/callback`,
  },
  {
    integration: "fake",
    title: "Fake",
    location: "local",
    modes: ["local-app"],
    requiresAuth: false,
    fields: fakeFields,
    description: "Deterministic in-process test integration.",
  },
  {
    integration: "vts",
    title: "VTube Studio",
    location: "local",
    modes: ["local-app"],
    requiresAuth: false,
    fields: vtsFields,
    description: "VTube Studio plugin approval, hotkeys and model parameters.",
  },
  {
    integration: "keyboard",
    title: "Keyboard",
    location: "local",
    modes: ["local-app"],
    requiresAuth: false,
    fields: keyboardFields,
    description: "Global macOS keyboard input through Accessibility.",
  },
  {
    integration: "midi",
    title: "MIDI",
    location: "local",
    modes: ["local-app"],
    requiresAuth: false,
    fields: midiFields,
    description: "MIDI input/output ports for note, control and program messages.",
  },
  {
    integration: "websocket",
    title: "WebSocket",
    location: "local",
    modes: ["local-app"],
    requiresAuth: false,
    fields: websocketFields,
    description: "A WebSocket client connection or a local WebSocket server.",
  },
  {
    integration: "http",
    title: "HTTP",
    location: "either",
    modes: ["auto", "local-app", "cloud"],
    requiresAuth: false,
    fields: httpFields,
    description: "HTTP requests and verified local or cloud webhooks.",
  },
];

export const ListIntegrationsResponse = Schema.Struct({
  integrations: Schema.Array(ConnectionIntegration),
});
export type ListIntegrationsResponse = typeof ListIntegrationsResponse.Type;

/** A helper for UI code that wants to display a field value consistently. */
export const valueOf = (
  values: ReadonlyArray<ConnectionValue>,
  key: string,
): ConnectionValue | undefined => values.find((value) => value.key === key);
