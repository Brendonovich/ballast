import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { EventEnvelope } from "./events.ts";
import {
  HelixRequest,
  HelixResponse,
  ListConnectionsResponse,
  PairingClaimRequest,
  PairingClaimResponse,
  ReconcileSubscriptionsRequest,
  ReconcileSubscriptionsResponse,
  TwitchTokenRequest,
  TwitchTokenResponse,
} from "./http.ts";

/**
 * The error shape shared by every RPC. The HTTP endpoints encode the same
 * fields inside `{ error: ... }` (see `ApiErrorBody`).
 */
export const RpcFailure = Schema.Struct({
  tag: Schema.String,
  message: Schema.String,
  details: Schema.optionalKey(Schema.Json),
});
export type RpcFailure = typeof RpcFailure.Type;

/**
 * The agent -> cloud request/response API.
 *
 * The MVP serves these operations as JSON over HTTP so the cloud can also
 * host browser OAuth routes and Twitch webhooks with the same Worker. The
 * group is the transport-independent contract: as soon as the agent's cloud
 * link exists, the same handlers can be exposed with
 * `RpcServer.layerProtocolWebsocket` / `layerProtocolHttp` and consumed with
 * `RpcClient`, without changing payloads.
 */
export const ClaimPairing = Rpc.make("ClaimPairing", {
  payload: PairingClaimRequest,
  success: PairingClaimResponse,
  error: RpcFailure,
});

export const GetToken = Rpc.make("GetToken", {
  payload: TwitchTokenRequest,
  success: TwitchTokenResponse,
  error: RpcFailure,
});

export const CallHelix = Rpc.make("CallHelix", {
  payload: HelixRequest,
  success: HelixResponse,
  error: RpcFailure,
});

export const ReconcileSubscriptions = Rpc.make("ReconcileSubscriptions", {
  payload: ReconcileSubscriptionsRequest,
  success: ReconcileSubscriptionsResponse,
  error: RpcFailure,
});

export const ListConnections = Rpc.make("ListConnections", {
  payload: Schema.Void,
  success: ListConnectionsResponse,
  error: RpcFailure,
});

export const CloudRpcs = RpcGroup.make(
  ClaimPairing,
  GetToken,
  CallHelix,
  ReconcileSubscriptions,
  ListConnections,
);
export type CloudRpcs = typeof CloudRpcs;

/**
 * The relay's RPC shape. `SubscribeToRelay` is a streaming RPC: its stream
 * elements are the same envelope the WebSocket relay sends today. The agent
 * acks envelope ids through `AckRelayEvents`, which maps to the relay's
 * durable buffer.
 */
export const SubscribeToRelay = Rpc.make("SubscribeToRelay", {
  payload: Schema.Struct({ machineId: Schema.String }),
  success: EventEnvelope,
  error: RpcFailure,
  stream: true,
});

export const AckRelayEvents = Rpc.make("AckRelayEvents", {
  payload: Schema.Struct({ machineId: Schema.String, seqs: Schema.Array(Schema.Number) }),
  success: Schema.Struct({ acked: Schema.Number }),
  error: RpcFailure,
});

export const RelayRpcs = RpcGroup.make(SubscribeToRelay, AckRelayEvents);
export type RelayRpcs = typeof RelayRpcs;
