import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Result } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { FetchHttpClient } from "effect/http";

import { makeCloudApp, type CloudAppService } from "./app.ts";
import { BallastCloudWorker } from "./cloud-worker.ts";
import { loadCloudConfig } from "./config.ts";
import { makeD1CloudStore } from "./d1-store.ts";
import { HOOK_MAX_BODY_BYTES } from "./hooks.ts";
import type { HttpRequest, HttpResponse } from "./http.ts";
import { Relay, RelayLive } from "./relay/relay-do.ts";
import type { RelayGatewayService } from "./relay/gateway.ts";
import { BallastDatabase } from "./resources.ts";
import { makeTokenVault } from "./secrets.ts";
import { makeTwitchApi } from "./twitch-api.ts";

const normalize = (
  request: Request,
  body: Uint8Array,
): HttpRequest => ({
  method: request.method,
  url: request.url,
  headers: Object.fromEntries(request.headers.entries()),
  body,
});

const toResponse = (response: HttpResponse): Response =>
  new Response(response.body ?? null, {
    status: response.status,
    ...(response.headers === undefined ? {} : { headers: response.headers }),
  });

const textResponse = (status: number, body: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.raw(new Response(body, { status }), { status });

class BodyTooLarge extends Error {}

const readCappedBody = (
  request: Request,
  limit: number,
): Effect.Effect<Uint8Array, BodyTooLarge> =>
  Effect.tryPromise({
    try: async () => {
      if (request.body === null) return new Uint8Array();
      const reader = request.body.getReader();
      const chunks: Array<Uint8Array> = [];
      let total = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > limit) {
          await reader.cancel();
          throw new BodyTooLarge();
        }
        chunks.push(chunk.value);
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return body;
    },
    catch: () => new BodyTooLarge(),
  });

export default BallastCloudWorker.make(
  {
    main: import.meta.url,
    dev: { port: Number(process.env.BALLAST_DEV_PORT ?? "1338"), strictPort: true },
  },
  Effect.gen(function* () {
    const config = yield* loadCloudConfig;
    const vault = yield* makeTokenVault(config).pipe(Effect.orDie);
    const database = yield* Cloudflare.D1.QueryDatabase(BallastDatabase);
    const store = makeD1CloudStore(yield* database.raw);
    const twitch = yield* makeTwitchApi(config).pipe(Effect.provide(FetchHttpClient.layer));
    const relay = yield* Relay;
    const runtime = yield* RuntimeContext;
    const relayGateway: RelayGatewayService = {
      enqueueEvent: (machineId, envelope) =>
        relay
          .getByName(machineId)
          .enqueue(envelope)
          .pipe(Effect.provideService(RuntimeContext, runtime)),
      notify: (machineId, message) =>
        relay
          .getByName(machineId)
          .notify(machineId, message)
          .pipe(Effect.provideService(RuntimeContext, runtime)),
      enqueueWebhook: (machineId, delivery, policy) =>
        relay
          .getByName(machineId)
          .enqueueWebhook(delivery, policy)
          .pipe(Effect.provideService(RuntimeContext, runtime)),
    };
    const app: CloudAppService = yield* makeCloudApp({
      config,
      store,
      vault,
      twitch,
      relay: relayGateway,
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const source = request.source;
        if (!(source instanceof Request))
          return textResponse(500, "Unsupported request source");

        const url = new URL(source.url, "http://worker");
        if (url.pathname.startsWith("/relay/")) {
          const machineId = decodeURIComponent(url.pathname.slice("/relay/".length));
          if (machineId.length === 0) return textResponse(400, "Missing machine id");
          const machine = yield* Effect.result(
            app.authenticateMachine(normalize(source, new Uint8Array())),
          );
          if (Result.isFailure(machine))
            return textResponse(machine.failure.status, machine.failure.message);
          if (machine.success.id !== machineId)
            return textResponse(403, "Machine token does not match this relay");
          return yield* relay.getByName(machineId).fetch(request);
        }

        const body =
          source.method === "GET" || source.method === "HEAD"
            ? new Uint8Array()
            : url.pathname.startsWith("/hooks/")
              ? yield* Effect.result(readCappedBody(source, HOOK_MAX_BODY_BYTES)).pipe(
                  Effect.flatMap((result) =>
                    Result.isFailure(result)
                      ? Effect.succeed(undefined)
                      : Effect.succeed(result.success),
                  ),
                )
              : new Uint8Array(yield* Effect.promise(() => source.arrayBuffer()));
        if (body === undefined)
          return textResponse(413, "Payload Too Large");
        const response = yield* app.fetch(normalize(source, body));
        return HttpServerResponse.raw(toResponse(response), {
          status: response.status,
        });
      }),
    };
  }).pipe(
    Effect.provide(RelayLive),
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
    // Erase the RuntimeContext service from init's requirements; the Worker
    // platform supplies the real runtime context at both plan and runtime.
    Effect.provide(Alchemy.RuntimeContext.phantom),
  ),
);
