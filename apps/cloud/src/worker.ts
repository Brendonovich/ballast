import type { CloudEnv } from "../alchemy.run.ts";
import { Effect, Result } from "effect";

import { makeCloudApp, type CloudAppService } from "./app.ts";
import { makeCloudConfig } from "./config.ts";
import { makeD1CloudStore } from "./d1-store.ts";
import type { HttpRequest, HttpResponse } from "./http.ts";
import type { RelayGatewayService } from "./relay/gateway.ts";
import { makeTokenVault } from "./secrets.ts";
import { makeTwitchApi } from "./twitch-api.ts";

export { Relay } from "./relay/relay-do.ts";

const normalize = async (request: Request): Promise<HttpRequest> => ({
  method: request.method,
  url: request.url,
  headers: Object.fromEntries(request.headers.entries()),
  body: new Uint8Array(await request.arrayBuffer()),
});

const toResponse = (response: HttpResponse): Response =>
  new Response(response.body ?? null, {
    status: response.status,
    ...(response.headers === undefined ? {} : { headers: response.headers }),
  });

let appPromise: Promise<CloudAppService> | undefined;

const appFor = (env: CloudEnv): Promise<CloudAppService> => {
  if (appPromise !== undefined) return appPromise;
  appPromise = Effect.runPromise(
    Effect.gen(function* () {
      const config = makeCloudConfig({
        publicOrigin: env.BALLAST_PUBLIC_ORIGIN,
        twitchClientId: env.TWITCH_CLIENT_ID,
        twitchClientSecret: env.TWITCH_CLIENT_SECRET,
        tokenKey: env.BALLAST_TOKEN_KEY,
        tokenPepper: env.BALLAST_TOKEN_PEPPER,
        maxSubscriptionCost: Number(env.BALLAST_TWITCH_MAX_SUBSCRIPTION_COST || "10"),
        twitchIdBaseUrl: env.TWITCH_ID_BASE_URL,
        twitchApiBaseUrl: env.TWITCH_API_BASE_URL,
      });
      const vault = yield* makeTokenVault(config);
      const relay: RelayGatewayService = {
        enqueueEvent: (machineId, envelope) =>
          Effect.promise(() => env.RELAY.getByName(machineId).enqueue(envelope)),
        notify: (machineId, message) =>
          Effect.promise(() => env.RELAY.getByName(machineId).notify(machineId, message)),
      };
      return yield* makeCloudApp({
        config,
        store: makeD1CloudStore(env.DB),
        vault,
        twitch: makeTwitchApi(config),
        relay,
      });
    }),
  );
  return appPromise;
};

export default {
  async fetch(request: Request, env: CloudEnv): Promise<Response> {
    const url = new URL(request.url);
    const normalized = await normalize(request);
    const app = await appFor(env);

    if (url.pathname.startsWith("/relay/")) {
      const machineId = decodeURIComponent(url.pathname.slice("/relay/".length));
      if (machineId.length === 0) return new Response("Missing machine id", { status: 400 });
      const machine = await Effect.runPromise(
        app.authenticateMachine(normalized).pipe(Effect.result),
      );
      if (Result.isFailure(machine))
        return new Response(machine.failure.message, { status: machine.failure.status });
      if (machine.success.id !== machineId)
        return new Response("Machine token does not match this relay", { status: 403 });
      return env.RELAY.getByName(machineId).fetch(request);
    }

    const response = await Effect.runPromise(app.fetch(normalized));
    return toResponse(response);
  },
} satisfies ExportedHandler<CloudEnv>;
