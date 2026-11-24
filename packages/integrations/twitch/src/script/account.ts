import * as Ballast from "@ballast/core";
import * as Effect from "effect/Effect";
import type { Schema } from "effect";

import { requests } from "../helix/requests.ts";
import type { HelixRequest, RequestName } from "../helix/requests.ts";
import { isRequestName } from "../helix/requests.ts";
import { INTEGRATION } from "../protocol/topic.ts";

type Integration = typeof INTEGRATION;

export type HelixInput<Name extends RequestName> = Schema.Schema.Type<
  (typeof requests)[Name]["input"]
>;

export type HelixOutput<Name extends RequestName> = Schema.Schema.Type<
  (typeof requests)[Name]["output"]
>;

export type TwitchHelixClient<Name extends RequestName> = Ballast.RequestClient<
  HelixInput<Name>,
  HelixOutput<Name>
>;

export const HELIX_REQUEST_PREFIX = "helix/";

/** Manifest request name: `helix/sendChatMessage`. */
export const helixRequestName = (name: RequestName): `helix/${RequestName}` =>
  `${HELIX_REQUEST_PREFIX}${name}`;

export const isHelixRequestName = (
  value: string,
): value is `helix/${RequestName}` =>
  value.startsWith(HELIX_REQUEST_PREFIX) &&
  isRequestName(value.slice(HELIX_REQUEST_PREFIX.length));

/** Parse a manifest request name back to its Helix request. */
export const parseHelixRequestName = (value: string): RequestName | undefined => {
  if (!value.startsWith(HELIX_REQUEST_PREFIX)) return undefined;
  const name = value.slice(HELIX_REQUEST_PREFIX.length);
  return isRequestName(name) ? name : undefined;
};

/**
 * A Twitch account slot. It is a core `ConnectionRef<"twitch">` (location
 * `either`) plus a typed Helix client factory.
 *
 * Helix requests are declared one at a time so the manifest carries the exact
 * scopes a script uses:
 *
 * ```ts
 * const broadcaster = yield* Twitch.Account("broadcaster");
 * const sendChat = yield* broadcaster.helix("sendChatMessage");
 * yield* sendChat({ broadcaster_id, sender_id, message: "hi" });
 * ```
 *
 * Like every request capability, the client dies if called during planning.
 * In cloud mode the agent proxies the call through the cloud; locally it calls
 * Helix directly.
 */
export interface TwitchAccount extends Ballast.ConnectionRef<Integration> {
  readonly helix: <Name extends RequestName>(
    request: Name,
  ) => Effect.Effect<TwitchHelixClient<Name>, never, Ballast.RequestHost>;
}

const makeHelixClient = <Name extends RequestName, Input, Output>(
  slot: string,
  name: Name,
  definition: HelixRequest<Input, Output>,
): Effect.Effect<Ballast.RequestClient<Input, Output>, never, Ballast.RequestHost> =>
  Ballast.Request<Input, Output>({
    integration: INTEGRATION,
    slot,
    request: helixRequestName(name),
    scopes: definition.scopes,
    inputSchema: definition.input,
    outputSchema: definition.output,
  });

type HelixDeclarer = {
  readonly [Name in RequestName]: (
    slot: string,
  ) => Effect.Effect<TwitchHelixClient<Name>, never, Ballast.RequestHost>;
};

/**
 * Per-request declarers. Writing them out keeps each `HelixRequest`'s input
 * and output types intact; indexing `requests` generically loses them because
 * the request object is a union of codecs.
 */
const helixDeclarers: HelixDeclarer = {
  getUsers: (slot) => makeHelixClient(slot, "getUsers", requests.getUsers),
  getChannelInformation: (slot) =>
    makeHelixClient(slot, "getChannelInformation", requests.getChannelInformation),
  modifyChannelInformation: (slot) =>
    makeHelixClient(slot, "modifyChannelInformation", requests.modifyChannelInformation),
  createCustomReward: (slot) =>
    makeHelixClient(slot, "createCustomReward", requests.createCustomReward),
  updateCustomReward: (slot) =>
    makeHelixClient(slot, "updateCustomReward", requests.updateCustomReward),
  deleteCustomReward: (slot) =>
    makeHelixClient(slot, "deleteCustomReward", requests.deleteCustomReward),
  getCustomRewards: (slot) =>
    makeHelixClient(slot, "getCustomRewards", requests.getCustomRewards),
  updateRedemptionStatus: (slot) =>
    makeHelixClient(slot, "updateRedemptionStatus", requests.updateRedemptionStatus),
  sendChatMessage: (slot) =>
    makeHelixClient(slot, "sendChatMessage", requests.sendChatMessage),
  createClip: (slot) => makeHelixClient(slot, "createClip", requests.createClip),
  startCommercial: (slot) =>
    makeHelixClient(slot, "startCommercial", requests.startCommercial),
  createEventSubSubscription: (slot) =>
    makeHelixClient(slot, "createEventSubSubscription", requests.createEventSubSubscription),
  getEventSubSubscriptions: (slot) =>
    makeHelixClient(slot, "getEventSubSubscriptions", requests.getEventSubSubscriptions),
  deleteEventSubSubscription: (slot) =>
    makeHelixClient(slot, "deleteEventSubSubscription", requests.deleteEventSubSubscription),
  createPoll: (slot) => makeHelixClient(slot, "createPoll", requests.createPoll),
  getPolls: (slot) => makeHelixClient(slot, "getPolls", requests.getPolls),
  endPoll: (slot) => makeHelixClient(slot, "endPoll", requests.endPoll),
  createPrediction: (slot) => makeHelixClient(slot, "createPrediction", requests.createPrediction),
  getPredictions: (slot) => makeHelixClient(slot, "getPredictions", requests.getPredictions),
  endPrediction: (slot) => makeHelixClient(slot, "endPrediction", requests.endPrediction),
  getBroadcasterSubscriptions: (slot) => makeHelixClient(slot, "getBroadcasterSubscriptions", requests.getBroadcasterSubscriptions),
  checkUserSubscription: (slot) => makeHelixClient(slot, "checkUserSubscription", requests.checkUserSubscription),
  getStreams: (slot) => makeHelixClient(slot, "getStreams", requests.getStreams),
  getChatters: (slot) => makeHelixClient(slot, "getChatters", requests.getChatters),
  getChatSettings: (slot) => makeHelixClient(slot, "getChatSettings", requests.getChatSettings),
  updateChatSettings: (slot) => makeHelixClient(slot, "updateChatSettings", requests.updateChatSettings),
  sendAnnouncement: (slot) => makeHelixClient(slot, "sendAnnouncement", requests.sendAnnouncement),
  banUser: (slot) => makeHelixClient(slot, "banUser", requests.banUser),
  unbanUser: (slot) => makeHelixClient(slot, "unbanUser", requests.unbanUser),
  getChannelVips: (slot) => makeHelixClient(slot, "getChannelVips", requests.getChannelVips),
  addChannelVip: (slot) => makeHelixClient(slot, "addChannelVip", requests.addChannelVip),
  removeChannelVip: (slot) => makeHelixClient(slot, "removeChannelVip", requests.removeChannelVip),
};

/**
 * Declare a Twitch account slot. Location is `either`: the agent uses the
 * cloud when the machine is paired, and the user's own Twitch app otherwise.
 */
export const Account = (slot: string): Effect.Effect<TwitchAccount> =>
  Effect.gen(function* () {
    const connection = yield* Ballast.Connection<Integration>({
      integration: INTEGRATION,
      slot,
      location: "either",
    });

    const helix = <Name extends RequestName>(
      request: Name,
    ): Effect.Effect<TwitchHelixClient<Name>, never, Ballast.RequestHost> =>
      helixDeclarers[request](slot);

    return { ...connection, helix };
  });
