import { Schema } from "effect";

export const CloudState = Schema.Literals(["unlinked", "linking", "linked", "error"]);
export type CloudState = typeof CloudState.Type;

export const CloudAccount = Schema.Struct({
  id: Schema.String,
  login: Schema.String,
  displayName: Schema.String,
  avatarUrl: Schema.optionalKey(Schema.String),
});
export type CloudAccount = typeof CloudAccount.Type;

export const CloudMachine = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  hostname: Schema.optionalKey(Schema.String),
  platform: Schema.optionalKey(Schema.String),
});
export type CloudMachine = typeof CloudMachine.Type;

export const CloudRelay = Schema.Struct({
  connected: Schema.Boolean,
  lastEventAt: Schema.optionalKey(Schema.Number),
  /** Events buffered in the cloud and not yet acknowledged by this machine. */
  pending: Schema.optionalKey(Schema.Number),
  lastError: Schema.optionalKey(Schema.String),
});
export type CloudRelay = typeof CloudRelay.Type;

export const CloudStatus = Schema.Struct({
  state: CloudState,
  cloudUrl: Schema.optionalKey(Schema.String),
  account: Schema.optionalKey(CloudAccount),
  machine: Schema.optionalKey(CloudMachine),
  relay: Schema.optionalKey(CloudRelay),
  pairedAt: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.String),
});
export type CloudStatus = typeof CloudStatus.Type;

export const BeginCloudPairingRequest = Schema.Struct({
  machineName: Schema.String,
});
export type BeginCloudPairingRequest = typeof BeginCloudPairingRequest.Type;

/**
 * The result of asking the cloud for a pairing code. The UI opens `url` in the
 * browser, where the user signs in to Twitch; the cloud then shows the same
 * code (or a deep link) back to the app.
 */
export const CloudPairingSession = Schema.Struct({
  url: Schema.String,
  code: Schema.String,
  expiresAt: Schema.Number,
  instructions: Schema.String,
});
export type CloudPairingSession = typeof CloudPairingSession.Type;

export const PairCloudRequest = Schema.Struct({
  code: Schema.String,
  machineName: Schema.String,
});
export type PairCloudRequest = typeof PairCloudRequest.Type;

export const cloudUnlinked = (): CloudStatus => ({ state: "unlinked" });
