# @ballast/module-http

Outgoing HTTP clients and incoming webhooks for Ballast scripts. The script entry
has no Node-only imports; runtime code lives in `@ballast/module-http/driver`.

## Script API

```ts
import * as Ballast from "@ballast/core";
import * as Http from "@ballast/module-http";
import { Effect, Schema } from "effect";

const Donation = Schema.Struct({ from: Schema.String, amount: Schema.Number });
const Summary = Schema.Struct({ total: Schema.Number });

export default Effect.gen(function* () {
  const hook = yield* Http.Webhook("kofi");
  const api = yield* Http.Client("kofi-api", { hosts: ["api.example.com"] });

  yield* Http.Webhook.json(Donation).subscribe(hook, (donation) =>
    Effect.gen(function* () {
      const summary = yield* api.get("/v1/summary", { schema: Summary });
      yield* Effect.log(donation.from, summary.body.total);
    }),
  );
});
```

`Http.Client(slot, { hosts })` returns `request`, `get`, `post`, `put`,
`patch`, and `delete`. Methods accept `{ query, headers, schema }`; with a
schema the JSON response body is decoded into `response.body`. Auth and default
headers are never script values: they come from connection config.

`Http.Webhook("kofi")` declares an `either` connection.
`Http.Webhook.subscribe(hook, handler)` (or `Http.Webhook.json(schema)`) records
the `http/webhook` topic. The driver answers the provider with the static
response from connection config; handlers cannot return a response (see decision
0005).

## Manifest capabilities

- `Http.Client` records `http/request` scopes such as
  `http:host:api.example.com`, or `http:host:*` when no hosts are named.
- `Http.Webhook` records topic `http/webhook` with scope
  `http:webhook:<slot>` and condition `{ hook: "<slot>" }`.

## Driver

```ts
import { layerNode, webhookLayer } from "@ballast/module-http/driver";

const http = yield* HttpClientDriver;
const response = yield* http.request({
  config: {
    slot: "kofi-api",
    baseUrl: "https://api.example.com/",
    headers: { "x-api-version": "2" },
    auth: { type: "bearer", token: "…" },
    allowedHosts: ["api.example.com"],
  },
  request: { method: "GET", path: "v1/summary" },
  allowedHosts: ["api.example.com"], // manifest scopes
});

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

`HttpClientDriver` enforces the connection's `allowedHosts` and the script's
manifest hosts, follows redirects itself, rejects script-controlled
`authorization`/`cookie`/`host` headers, and limits response size/time.
`WebhookRelay` and `webhookRelayLayerNode` implement the proposed cloud protocol
in `docs/decisions/0005-generic-webhooks.md`.
