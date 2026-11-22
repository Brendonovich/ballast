# OBS integration

`@ballast/module-obs` (at `packages/integrations/obs`) exposes the full
obs-websocket v5 protocol to scripts. The agent owns the local WebSocket
connection; scripts get a typed request client and typed event subscriptions.

## Script API

```ts
import * as Ballast from "@ballast/core";
import * as OBS from "@ballast/module-obs";
import { Effect } from "effect";

export default Effect.gen(function* () {
    const scene = yield* Ballast.Param.string("scene", { options: OBS.scenes("main") });
    const obs = yield* OBS.Connection("main");

    yield* OBS.CurrentProgramSceneChanged.subscribe(obs, (event) =>
      Effect.log(`scene now ${event.sceneName}`),
    );

    yield* Ballast.run(
      Effect.gen(function* () {
        yield* obs.SetCurrentProgramScene({ sceneName: yield* scene });
});
  }),
);
```

- `OBS.Connection(slot)` records a local connection and the whole `obs/*`
  request namespace in the manifest. OBS has no scopes, so the connection is
  the grant. The returned client has one method per obs-websocket request
  (147 in the v5 protocol) and is itself a `ConnectionRef<"obs">`.
- Every event is a topic object, e.g. `OBS.CurrentProgramSceneChanged`, with
  `subscribe(connection, handler)`. Subscribing records `obs/<EventName>` as a
  topic and infers the handler payload from the generated schema. The core
  `Topic` type keeps the integration literal, so passing a Fake connection to
  an OBS topic (or vice versa) is a type error.
- Generated event payload types are named `<EventName>Payload` (schema
  `<EventName>PayloadSchema`) so the topic object can use the event name
  itself without collisions.
- `OBS.scenes(slot)` records `options: { integration: "obs", slot, source:
  "scenes" }` on a param. The agent resolves it with `GetSceneList` before
  starting a run and validates `--param` values against it.

Init only declares. Request clients acquired through `OBS.Connection` die with
`RequestCalledDuringPlanError` if called during planning.

## Protocol generation

The source of truth is obs-websocket's
[`protocol.json`](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.json).

```
packages/integrations/obs/
├── vendor/protocol.json          fetched official definition, committed
├── scripts/generate.ts           generator, committed
└── src/generated/protocol.ts     generated output, committed
```

Regenerate with:

```sh
pnpm --filter @ballast/module-obs generate
```

The generator emits Effect Schemas and types for every request input/output and
event payload, the event topic objects, lookup tables (`RequestSchemas`,
`EventSchemas`, `EventSubscriptions`) and the `makeClient` factory. The
generated file is about 160 KB / 2,900 lines, so full Effect Schemas were
affordable. Validation is "light" where the protocol is vague:

- `Object` and `Array<Object>` become `Record<string, unknown>` and
  `ReadonlyArray<Record<string, unknown>>`; known structured values such as
  OBS scenes are narrowed by their consumers.
- 16 response fields that the docs describe as nullable are marked
  `Schema.NullOr`; the list lives in `scripts/generate.ts`. Everything else is
  required.
- Request fields use `valueOptional` from the protocol.

Request input is decoded by the agent driver before sending, so bad payloads
fail with `Invalid <Request> input: ...` instead of reaching OBS. The runtime
worker decodes each response with its generated schema.

## Agent driver

`apps/agent/src/obs-protocol.ts` implements the wire protocol:

- Hello (op 0), Identify (op 1) with the SHA-256 challenge/salt auth, Identified
  (op 2);
- Request (op 6) / RequestResponse (op 7) correlation by request id, with a 10s
  timeout and failed pending requests on disconnect;
- Event (op 5) delivery on a queue, with the subscription bitmask computed from
  the manifest's OBS topics. All non-high-volume categories are requested;
  high-volume bits (`InputVolumeMeters`, etc.) are only requested when a topic
  subscribes to them.

`apps/agent/src/obs-driver.ts` keeps the connection alive and reconnects with
exponential backoff (1s, 2s, 4s, ... capped at 30s), logging
`[obs:<slot>] connecting/connected/reconnecting`. Requests fail while
disconnected rather than being queued, so stale scene changes are not replayed.

### Connection configuration

| Setting | How |
| --- | --- |
| Url | `--connection obs/main=ws://host:port` (default `ws://127.0.0.1:4455`) |
| Password | `--connection-secret obs/main=...` or `BALLAST_OBS_MAIN_PASSWORD` |

The env var is `BALLAST_OBS_<SLOT>_PASSWORD` with non-alphanumerics replaced by
`_` (for example slot `stream-pc` becomes `BALLAST_OBS_STREAM_PC_PASSWORD`).
Urls must be `ws://` or `wss://` and must not embed credentials.

```sh
# Real OBS with websocket enabled (Tools → WebSocket Server Settings)
ballast run examples/obs-scene.ts --param scene="Gameplay"

# Password-protected
ballast run examples/obs-scene.ts --param scene="Gameplay" \
  --connection-secret obs/main=hunter2

# Mock server for a machine without OBS
node --experimental-strip-types apps/agent/scripts/obs-mock.ts
ballast run examples/obs-scene.ts --param scene="Scene 2" \
  --connection obs/main=ws://127.0.0.1:<printed port>
```

`ballast run` refuses to start when a param without a default has no value, and
prints the available OBS scenes when `--param scene=...` is not in
`GetSceneList`.

## Tests

- `apps/agent/test/obs.test.ts`: mock obs-websocket server; Hello/Identify
  (including SHA-256 auth and a wrong password), a request round-trip, an event
  push, request-input validation, and driver topic publishing.
- `apps/agent/test/obs-e2e.test.ts`: spawns the real `ballast run` CLI against
  the mock, checking the connection log, `set scene`, the
  `CurrentProgramSceneChanged` handler log, and the missing/invalid param
  errors.
- `packages/integrations/obs/test/plan.test.ts`: the `examples/obs-scene.ts`
  manifest (connection `obs/main`, request `obs/*`, topic
  `obs/CurrentProgramSceneChanged`, dynamic scene options) and plan-client
  death.
- `apps/agent/test/topic-types.test.ts`: asserts that an OBS topic only accepts
  an OBS connection (the Fake connection case is a `@ts-expect-error`).

Real OBS was not running on 127.0.0.1:4455 during development, so verification
against a physical OBS instance is still pending; the mock server exercises the
same protocol path through the CLI.
