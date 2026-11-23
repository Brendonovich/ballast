import { Schema } from "effect";

import {
  ConnectionApproval,
  ConnectionLocation,
  ConnectionMode,
  ConnectionStatus,
} from "./common.ts";
import { ScriptRef } from "./scripts.ts";

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
  slot: Schema.String,
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
  /** Scripts in any project that currently declare a slot bound to this connection. */
  usedBy: Schema.Array(ScriptRef),
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
    description: "Stored in the OS keychain on release builds.",
  },
];

export const twitchFields: ReadonlyArray<ConnectionField> = [
  {
    key: "clientId",
    label: "Client ID",
    kind: "text",
    required: true,
    description: "From your Twitch application; only used in local-app mode.",
  },
  {
    key: "clientSecret",
    label: "Client secret",
    kind: "secret",
    required: true,
    description: "Only used in local-app mode. Never leaves this machine.",
  },
];

export const fakeFields: ReadonlyArray<ConnectionField> = [
  {
    key: "prefix",
    label: "Prefix",
    kind: "text",
    required: false,
    placeholder: ">",
  },
];

/** A helper for UI code that wants to display a field value consistently. */
export const valueOf = (
  values: ReadonlyArray<ConnectionValue>,
  key: string,
): ConnectionValue | undefined => values.find((value) => value.key === key);
