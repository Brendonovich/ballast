import type { ConnectionField } from "@ballast/agent-protocol";

/**
 * Connection integrations and their editable fields. There is no catalog RPC
 * in this protocol round, so this mirrors the field lists the service accepts
 * in apps/agent/src/service/connections.ts. Keep it in sync until the catalog
 * is exposed on the wire.
 */
export interface ConnectionIntegration {
  readonly integration: string;
  readonly title: string;
  readonly fields: ReadonlyArray<ConnectionField>;
}

const text = (key: string, label: string, description?: string): ConnectionField => ({
  key,
  label,
  kind: "text",
  required: false,
  ...(description === undefined ? {} : { description }),
});

const secret = (key: string, label: string, description?: string): ConnectionField => ({
  key,
  label,
  kind: "secret",
  required: false,
  ...(description === undefined ? {} : { description }),
});

const select = (
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

const requiredText = (
  key: string,
  label: string,
  description?: string,
): ConnectionField => ({ ...text(key, label, description), required: true });

const requiredSecret = (
  key: string,
  label: string,
  description?: string,
): ConnectionField => ({ ...secret(key, label, description), required: true });

const integrations: ReadonlyArray<ConnectionIntegration> = [
  {
    integration: "obs",
    title: "OBS Studio",
    fields: [
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
        description: "Stored in the service data directory with restricted permissions.",
      },
    ],
  },
  {
    integration: "twitch",
    title: "Twitch",
    fields: [
      requiredText(
        "clientId",
        "Client ID",
        "From your Twitch application; used in own-app mode.",
      ),
      requiredSecret(
        "clientSecret",
        "Client secret",
        "Only used in own-app mode. Never leaves this machine.",
      ),
      text(
        "connection",
        "Cloud connection",
        "Cloud Twitch connection id or login; used in cloud mode.",
      ),
    ],
  },
  {
    integration: "fake",
    title: "Fake",
    fields: [text("prefix", "Prefix", "Optional prefix for fake requests.")],
  },
  {
    integration: "vts",
    title: "VTube Studio",
    fields: [
      text("url", "WebSocket URL", "Defaults to ws://127.0.0.1:8001."),
      text("pluginName", "Plugin name", "Shown in the VTube Studio approval dialog."),
      text("pluginDeveloper", "Plugin developer"),
      text("pluginIcon", "Plugin icon (base64, 128x128)"),
    ],
  },
  {
    integration: "keyboard",
    title: "Keyboard",
    fields: [
      select("permission", "macOS permission", ["unknown", "granted", "denied"]),
    ],
  },
  {
    integration: "midi",
    title: "MIDI",
    fields: [
      text("input", "Input port", "Leave empty when the script only sends MIDI."),
      text("output", "Output port", "Default output for send requests."),
    ],
  },
  {
    integration: "websocket",
    title: "WebSocket",
    fields: [
      select("mode", "Mode", ["auto", "client", "server"]),
      text("url", "Client URL", "ws:// or wss://; required for a client slot."),
      text("headers", "Headers (JSON)", 'For example {"authorization":"Bearer ..."}'),
      secret("headersSecret", "Secret headers (JSON)", "Merged over the plain headers."),
      text("subprotocols", "Subprotocols (comma separated)"),
      text("serverHost", "Server host", "Defaults to 127.0.0.1."),
      text("serverPort", "Server port", "Required for a server slot."),
      text("serverPath", "Server path", "Defaults to every path."),
    ],
  },
  {
    integration: "http",
    title: "HTTP",
    fields: [
      text("baseUrl", "Base URL", "Required for HTTP client requests."),
      text("headers", "Default headers (JSON)"),
      secret("headersSecret", "Secret headers (JSON)", "Merged over the plain headers."),
      select("authType", "Auth", ["none", "bearer", "basic", "header"]),
      secret("authToken", "Bearer token"),
      text("authUsername", "Basic auth username"),
      secret("authPassword", "Basic auth password"),
      text("authHeaderName", "Auth header name"),
      secret("authHeaderValue", "Auth header value"),
      text("allowedHosts", "Allowed hosts (comma separated)"),
      select("webhookTransport", "Webhook transport", ["local", "cloud"]),
      text("webhookHookId", "Cloud hook id"),
      text("webhookHost", "Webhook host"),
      text("webhookPort", "Webhook port"),
      text("webhookPath", "Webhook path"),
      select("webhookVerification", "Webhook verification", [
        "none",
        "shared-secret",
        "hmac-sha256",
      ]),
      text("webhookHeader", "Verification header"),
      secret("webhookSecret", "Verification secret"),
      text("webhookTimestampHeader", "Timestamp header"),
      text("webhookTolerance", "Timestamp tolerance (seconds)"),
      text("webhookResponseStatus", "Static response status"),
      text("webhookResponseBody", "Static response body"),
      text("webhookMaxAgeMs", "Max event age (ms)"),
      select("webhookOnStale", "Stale events", ["drop", "deliver"]),
    ],
  },
];

export const connectionIntegrations = integrations;

export const connectionIntegration = (
  integration: string,
): ConnectionIntegration | undefined =>
  integrations.find((entry) => entry.integration === integration);
