# @ballast/module-http

Incoming webhooks for Ballast scripts. Outgoing HTTP needs no Ballast
connection: import Effect's `HttpClient` and provide `FetchHttpClient.layer`
where the request runs. The script entry has no Node-only imports; runtime code
lives in `@ballast/module-http/driver`.

## Script API

```ts
import * as Ballast from "@ballast/core";
import * as Http from "@ballast/module-http";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

const Donation = Schema.Struct({ from: Schema.String, amount: Schema.Number });
const Summary = Schema.Struct({ total: Schema.Number });

export default Effect.gen(function* () {
  const hook = yield* Http.Webhook("kofi");
  yield* Http.Webhook.json(Donation).subscribe("donation", hook, (donation) =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient.pipe(
        Effect.provide(FetchHttpClient.layer),
      );
      const response = yield* http.get("https://api.example.com/v1/summary", {
        headers: { authorization: "Bearer <token>" },
      });
      const summary = yield* Schema.decodeUnknownEffect(Summary)(
        yield* response.json,
      );
      yield* Effect.log(donation.from, summary.total);
    }),
  );
});
```

`Http.Webhook("kofi")` declares an `either` connection.
`Http.Webhook.subscribe(name, hook, handler)` (or
`Http.Webhook.json(schema).subscribe(name, hook, handler)`) records the
`http/webhook` topic. The driver answers the provider with the static
response from connection config; handlers cannot return a response (see decision
0005).

## Manifest capabilities

- `Http.Webhook` records topic `http/webhook` with scope
  `http:webhook:<slot>` and condition `{ hook: "<slot>" }`.
- Outgoing HTTP records nothing. Requests run through Effect's `HttpClient` and
  the script supplies headers and auth itself.

## Driver

```ts
import { WebhookDriver } from "@ballast/module-http/driver";

const webhooks = yield* WebhookDriver;
const runtime = yield* webhooks.start([
  {
    slot: "kofi",
    transport: "local",
    local: { host: "127.0.0.1", port: 8787 },
    verification: { type: "shared-secret", header: "x-kofi-token", secret: "…" },
    response: { status: 200, body: "ok" },
  },
]);
yield* runtime.deliveries.pipe(Stream.runForEach(console.log));
```

`WebhookRelay` and `webhookRelayLayerNode` implement the proposed cloud protocol
in `docs/decisions/0005-generic-webhooks.md`.
