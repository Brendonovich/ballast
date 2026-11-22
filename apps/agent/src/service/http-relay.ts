import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RegisterHooksResponse } from "@ballast/cloud-protocol";
import { HttpDriverError, WebhookRelay } from "@ballast/module-http/driver";
import type {
  RegisteredWebhook,
  WebhookRegistration,
  WebhookRelayDelivery,
} from "@ballast/module-http/driver";
import { CloudLink } from "./cloud-link.ts";

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  return text.trim() === "" ? undefined : JSON.parse(text);
};

const post = (
  baseUrl: string,
  token: string,
  path: string,
  body: unknown,
): Effect.Effect<unknown, HttpDriverError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(baseUrl.replace(/\/$/, "") + path, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const json = await readJson(response);
      if (!response.ok) {
        throw new HttpDriverError({
          reason: "Ballast cloud hook request failed (" + response.status + ")",
          status: response.status,
        });
      }
      return json;
    },
    catch: (cause) =>
      cause instanceof HttpDriverError
        ? cause
        : new HttpDriverError({
            reason: "Could not reach the Ballast cloud: " +
              (cause instanceof Error ? cause.message : String(cause)),
          }),
  });

/**
 * The agent-side WebhookRelay over the service's single CloudLink relay. The
 * cloud registration API is the missing half of the integration driver's
 * WebhookRelay service; deliveries arrive on the existing per-machine socket.
 */
export const WebhookRelayAgentLive = Layer.effect(
  WebhookRelay,
  Effect.gen(function* () {
    const cloud = yield* CloudLink;
    const deliveries = yield* PubSub.unbounded<WebhookRelayDelivery>();
    let listenerScope: Scope.Closeable | undefined;

    const ensureListener = Effect.gen(function* () {
      if (listenerScope !== undefined) return;
      const relay = yield* cloud.relay;
      if (relay === undefined) return;
      const scope = yield* Scope.make();
      yield* relay
        .listen((message) =>
          message._tag === "webhook_delivery"
            ? PubSub.publish(deliveries, message.delivery).pipe(Effect.asVoid)
            : Effect.void,
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
      listenerScope = scope;
    });

    yield* Effect.addFinalizer(() =>
      listenerScope === undefined ? Effect.void : Scope.close(listenerScope, Exit.void),
    );

    const credentials = Effect.flatMap(cloud.credentials, (value) =>
      value === undefined
        ? Effect.fail(
            new HttpDriverError({
              reason: "Cloud webhooks need this machine to be paired with the Ballast cloud",
            }),
          )
        : Effect.succeed(value),
    );

    return WebhookRelay.of({
      register: (hooks: ReadonlyArray<WebhookRegistration>) =>
        Effect.gen(function* () {
          yield* ensureListener;
          const value = yield* credentials;
          const decoded = yield* post(value.baseUrl, value.machineToken, "/api/hooks/register", {
            hooks: hooks.map((hook) => ({
              hookId: hook.hookId,
              ...(hook.label === undefined ? {} : { label: hook.label }),
              ...(hook.maxAgeMs === undefined ? {} : { maxAgeMs: hook.maxAgeMs }),
              ...(hook.onStale === undefined ? {} : { onStale: hook.onStale }),
              ...(hook.verification === undefined
                ? {}
                : { verification: hook.verification }),
              ...(hook.response === undefined ? {} : { response: hook.response }),
            })),
          });
          return yield* Effect.try({
            try: (): ReadonlyArray<RegisteredWebhook> =>
              Schema.decodeUnknownSync(RegisterHooksResponse)(decoded).hooks,
            catch: (cause) =>
              new HttpDriverError({
                reason:
                  "Invalid hook registration response: " +
                  (cause instanceof Error ? cause.message : String(cause)),
              }),
          });
        }),
      unregister: (hookIds: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          if (hookIds.length === 0) return;
          const value = yield* credentials;
          yield* post(value.baseUrl, value.machineToken, "/api/hooks/unregister", {
            hookIds,
          });
        }),
      deliveries: Stream.fromPubSub(deliveries),
    });
  }),
);
