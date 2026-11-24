import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { TokenProviderError } from "../protocol/token.ts";
import type { HelixClientService } from "./client.ts";
import { HelixError } from "./errors.ts";
import { requests } from "./requests.ts";
import type { HelixMethod, HelixRequest, RequestName } from "./requests.ts";

/**
 * A request definition with the input/output types erased. The agent resolves
 * manifest request names (`helix/<name>`) through this table instead of
 * switching over every Helix request by hand.
 *
 * Erasing is safe because `fromRequest` closes over the typed definition: the
 * decoded value only ever goes back into that definition's own `toQuery`,
 * `toBody` and `HelixClient.request`.
 */
export interface HelixRequestExecutor<Name extends RequestName = RequestName> {
  readonly name: Name;
  readonly method: HelixMethod;
  readonly path: string;
  readonly scopes: ReadonlyArray<string>;
  /** Decode an unknown input and render it as a Helix query/body. */
  readonly encode: (
    input: unknown,
  ) => Effect.Effect<
    {
      readonly query: Readonly<Record<string, string>>;
      readonly body: unknown;
    },
    HelixError
  >;
  /** Decode a raw Helix response body with the request's output schema. */
  readonly decode: (body: unknown) => Effect.Effect<unknown, HelixError>;
  /** Execute directly through a Helix client (local-app mode). */
  readonly execute: (
    client: HelixClientService,
    input: unknown,
  ) => Effect.Effect<unknown, HelixError | TokenProviderError>;
}

const invalidInput = (name: string, cause: Schema.SchemaError): HelixError =>
  new HelixError({
    reason: "Invalid input for " + name + ": " + cause.message,
    code: "invalid-input",
  });

const invalidOutput = (name: string, cause: Schema.SchemaError): HelixError =>
  new HelixError({
    reason: "Twitch returned a response that did not match " + name + ": " + cause.message,
    code: "invalid-response",
  });

const fromRequest = <Name extends RequestName, Input, Output>(
  name: Name,
  definition: HelixRequest<Input, Output>,
): HelixRequestExecutor<Name> => ({
  name,
  method: definition.method,
  path: definition.path,
  scopes: definition.scopes,
  encode: (input) =>
    Schema.decodeUnknownEffect(definition.input)(input).pipe(
      Effect.mapError((cause) => invalidInput(definition.name, cause)),
      Effect.map((decoded) => ({
        query: definition.toQuery(decoded),
        body: definition.toBody(decoded),
      })),
    ),
  decode: (body) =>
    Schema.decodeUnknownEffect(definition.output)(body).pipe(
      Effect.mapError((cause) => invalidOutput(definition.name, cause)),
    ),
  execute: (client, input) =>
    Schema.decodeUnknownEffect(definition.input)(input).pipe(
      Effect.mapError((cause) => invalidInput(definition.name, cause)),
      Effect.flatMap((decoded) => client.request(definition, decoded)),
    ),
});

export const helixRequests: { readonly [Name in RequestName]: HelixRequestExecutor<Name> } = {
  getUsers: fromRequest("getUsers", requests.getUsers),
  getChannelInformation: fromRequest("getChannelInformation", requests.getChannelInformation),
  modifyChannelInformation: fromRequest(
    "modifyChannelInformation",
    requests.modifyChannelInformation,
  ),
  createCustomReward: fromRequest("createCustomReward", requests.createCustomReward),
  updateCustomReward: fromRequest("updateCustomReward", requests.updateCustomReward),
  deleteCustomReward: fromRequest("deleteCustomReward", requests.deleteCustomReward),
  getCustomRewards: fromRequest("getCustomRewards", requests.getCustomRewards),
  updateRedemptionStatus: fromRequest("updateRedemptionStatus", requests.updateRedemptionStatus),
  sendChatMessage: fromRequest("sendChatMessage", requests.sendChatMessage),
  createClip: fromRequest("createClip", requests.createClip),
  startCommercial: fromRequest("startCommercial", requests.startCommercial),
  createEventSubSubscription: fromRequest(
    "createEventSubSubscription",
    requests.createEventSubSubscription,
  ),
  getEventSubSubscriptions: fromRequest(
    "getEventSubSubscriptions",
    requests.getEventSubSubscriptions,
  ),
  deleteEventSubSubscription: fromRequest(
    "deleteEventSubSubscription",
    requests.deleteEventSubSubscription,
  ),
  createPoll: fromRequest("createPoll", requests.createPoll),
  getPolls: fromRequest("getPolls", requests.getPolls),
  endPoll: fromRequest("endPoll", requests.endPoll),
  createPrediction: fromRequest("createPrediction", requests.createPrediction),
  getPredictions: fromRequest("getPredictions", requests.getPredictions),
  endPrediction: fromRequest("endPrediction", requests.endPrediction),
  getBroadcasterSubscriptions: fromRequest(
    "getBroadcasterSubscriptions",
    requests.getBroadcasterSubscriptions,
  ),
  checkUserSubscription: fromRequest("checkUserSubscription", requests.checkUserSubscription),
  getStreams: fromRequest("getStreams", requests.getStreams),
  getChatters: fromRequest("getChatters", requests.getChatters),
  getChatSettings: fromRequest("getChatSettings", requests.getChatSettings),
  updateChatSettings: fromRequest("updateChatSettings", requests.updateChatSettings),
  sendAnnouncement: fromRequest("sendAnnouncement", requests.sendAnnouncement),
  banUser: fromRequest("banUser", requests.banUser),
  unbanUser: fromRequest("unbanUser", requests.unbanUser),
  getChannelVips: fromRequest("getChannelVips", requests.getChannelVips),
  addChannelVip: fromRequest("addChannelVip", requests.addChannelVip),
  removeChannelVip: fromRequest("removeChannelVip", requests.removeChannelVip),
};
