import * as Ballast from "@ballast/core";
import * as Effect from "effect/Effect";
import { INTEGRATION } from "./constants.ts";
import { makeClient } from "./generated/protocol.ts";
import type { ObsClient } from "./generated/protocol.ts";

export { INTEGRATION } from "./constants.ts";
export * from "./generated/protocol.ts";

/**
 * Declare an OBS connection slot and acquire its typed client. Every
 * obs-websocket request is a method on the client; OBS has no scopes, so the
 * connection grants the whole `obs/*` request namespace in the manifest.
 */
export const Connection = (
  slot: string,
): Effect.Effect<ObsClient, never, Ballast.RequestHost> =>
  Effect.gen(function* () {
    const connection = yield* Ballast.Connection({
      integration: INTEGRATION,
      slot,
      location: "local",
      requests: ["*"],
    });
    const host = yield* Ballast.RequestHost;
    return makeClient(connection, host);
  });

/**
 * Dynamic string options backed by the live OBS scene list. The agent resolves
 * them at run time with GetSceneList before validating params.
 */
export const scenes = (slot: string): Ballast.ParamOptionSource => ({
  integration: INTEGRATION,
  slot,
  source: "scenes",
});
