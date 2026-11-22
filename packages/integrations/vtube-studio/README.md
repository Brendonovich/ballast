# @ballast/module-vtube-studio

The VTube Studio Public API for Ballast: a local WebSocket integration with a
typed request client, typed events, dynamic param options and a standalone
connection driver.

```ts
import * as Ballast from "@ballast/core";
import * as VTS from "@ballast/module-vtube-studio";
import { Effect } from "effect";

export default Effect.gen(function* () {
    const hotkey = yield* Ballast.Param.string("hotkey", {
      options: VTS.hotkeys("main"),
    });
    const vts = yield* VTS.Connection("main");

    yield* VTS.HotkeyTriggered.subscribe(
      vts,
      (event) => Effect.log("hotkey " + event.hotkeyName),
      { ignoreHotkeysTriggeredByAPI: true },
    );

    yield* Ballast.run(
      Effect.gen(function* () {
        yield* vts.HotkeyTrigger({ hotkeyID: yield* hotkey });
});
  }),
);
```

## Script API

- `VTS.Connection(slot)` records a local `vts/<slot>` connection and the whole
  `vts/*` request namespace in the manifest. VTube Studio has no scopes; the
  plugin approval is a driver concern, not a script capability.
- The returned client is a `ConnectionRef<"vts">` with one method per public
  request. **Method names are the protocol request names minus `Request`**:
  `VTS.hotkeyTrigger`-style camel case would be friendlier at a glance, but the
  mechanical rule keeps every method greppable against the official docs and
  matches the OBS integration's request-name methods. `vts.ModelLoad(...)`,
  `vts.HotkeyTrigger(...)`, `vts.InjectParameterData(...)`, etc.
- `Authentication`, `AuthenticationToken` and `EventSubscription` are not on
  the client. The driver owns session authentication and keeps subscriptions
  in sync with the manifest topics; letting scripts send them would desync the
  driver.
- Every event is a topic object. Protocol names end in `Event`; topic names
  drop the suffix (`VTS.ModelLoaded`, `vts/ModelLoaded`). The complete set is
  `Test`, `ModelLoaded`, `TrackingStatusChanged`, `BackgroundChanged`,
  `ModelConfigChanged`, `ModelMoved`, `ModelOutline`, `HotkeyTriggered`,
  `ExpressionToggled`, `ModelAnimation`, `Item`, `ModelClicked`,
  `PostProcessing`, `Live2DCubismEditorConnected`, `ArtMeshTracking` and
  `ArtMeshOutline`.
- Topic options become VTube Studio's event `config`:
  `VTS.ModelLoaded.subscribe(vts, handler, { modelIDs })`,
  `VTS.ModelOutline.subscribe(vts, handler, { draw: true })`,
  `VTS.ArtMeshTracking.subscribe(vts, handler, { trackingPoints, frequency })`,
  and so on.
- Param option sources:
  - `VTS.models(slot)` -> `AvailableModels`, values are `modelID` (what
    `ModelLoad` needs).
  - `VTS.hotkeys(slot)` -> `HotkeysInCurrentModel`, values are hotkey names
    (or the ID for a name-less hotkey); `HotkeyTrigger` accepts either.
  - `VTS.expressions(slot)` -> `ExpressionState`, values are `.exp3.json`
    files as `ExpressionActivation` needs.

Init only declares; a request client called during planning dies with
`RequestCalledDuringPlanError`.

## Protocol definition

VTube Studio has **no machine-readable protocol definition**. The official
[DenchiSoft/VTubeStudio](https://github.com/DenchiSoft/VTubeStudio) repository
(read 2026-11-23) contains prose docs and JSON examples in `README.md`,
`Events/README.md` and `Permissions/README.md`; there is no `protocol.json`.
Unlike OBS, there is nothing to generate from, so `src/protocol.ts` is written
by hand and kept faithful to the documented request/response names, fields and
events. 39 requests and 16 events are covered. Regenerating from a future
machine-readable spec would replace that file without changing the client.

## Driver: `@ballast/module-vtube-studio/driver`

`VTubeStudioDriver.layer(options)` is a standalone Effect service
(`Layer<VTubeStudioDriver, VTubeStudioConfigError, Socket.WebSocketConstructor>`).
It does not import `apps/agent`; the agent's ConnectionManager will provide it
one layer per connection slot.

```ts
import { VTubeStudioDriver } from "@ballast/module-vtube-studio/driver";

const driverLayer = VTubeStudioDriver.layer({
  slot: "main",
  url: "ws://127.0.0.1:8001",
  pluginName: "Ballast",
  pluginDeveloper: "Ballast",
  dataDir: "<agent data dir>",
  subscriptions: manifest.topics
    .filter((topic) => topic.integration === "vts" && topic.slot === "main")
    .map((topic) => ({ topic: topic.topic, condition: topic.condition })),
  publish: (topicKey, payload) => bus.publish(topicKey, payload),
});
```

Service members:

| Member | What it does |
| --- | --- |
| `status` | Current snapshot: `disconnected`, `connecting`, `waiting-for-approval`, `authenticating`, `connected`, `reconnecting` or `error`, plus message, attempts, version and last connected time. |
| `statusChanges` | The current status then every change, as a `Stream`. |
| `ready` | Completes after the first successful authentication. |
| `request(name, input)` | Protocol-name request for the agent RPC. Validates input/output with the protocol schemas. |
| `invoke(name, input)` | Typed helper for tests and adapter code. |
| `setTopics(subscriptions)` | Replaces the desired manifest topics and reconciles subscriptions on the live session. |
| `resolveOptions(source)` | Resolves `vts/<slot>/{models,hotkeys,expressions}`. |

Connection lifecycle:

- Connects immediately and reconnects with exponential backoff (1s, 2s, 4s …
  capped at 30s) after any close or failure. Waiting for approval is a
  first-class state, and the approval request itself waits up to
  `approvalTimeout` (5 minutes).
- Requests correlate by `requestID` and fail while disconnected rather than
  queueing. API errors become `VTubeStudioRequestError` with `errorID`.
- Events are published as `vts/<slot>/vts/<topic>` (for example
  `vts/main/vts/HotkeyTriggered`), the same key shape as OBS.
- Subscription reconciliation runs after every authentication and on
  `setTopics`: removed topics are unsubscribed, new or changed configs are
  subscribed. VTube Studio forgets subscriptions on disconnect, so the driver
  re-subscribes on reconnect.
- Auth-revoked errors (IDs 1, 8 and 50) fail `authInvalid`, drop the stored
  token, and reconnect to request a new one.

### Authentication and token storage

The first connection sends `AuthenticationTokenRequest` with the configured
plugin name, developer and optional 128x128 base64 icon. While that request is
pending the status is `waiting-for-approval` — the user has to click **Allow**
in VTube Studio. The token is written to
`<dataDir>/ballast/vtube-studio/tokens/<slot>.json` with mode `0600` (the same
file convention as Twitch accounts), and reused for every reconnect. A rejected
token is deleted and re-requested. Pass `dataDir` from the agent; the default
uses `BALLAST_DATA_DIR`, then XDG data or `~/.local/share/ballast`.

### Event config and a core change request

`@ballast/core`'s `TopicCondition` values are strings or `{ slot }`
placeholders. VTube Studio's event configs contain booleans, numbers, arrays
and nested objects, so each topic records one JSON string:
`condition: { config: '{"ignoreHotkeysTriggeredByAPI":true}' }`. The driver
parses and validates it as a string-keyed object before subscribing.

The cleaner long-term shape is for core to allow arbitrary JSON
`TopicConditionValue`s (or a separate `options` field on `TopicManifest`),
so VTube Studio's config and Twitch's provider conditions can both be
structured. That is a `packages/core` change and was intentionally not made
here.

## Tests

```sh
pnpm --filter @ballast/module-vtube-studio typecheck
pnpm --filter @ballast/module-vtube-studio test
node apps/agent/src/bin.ts plan examples/vts-hotkey.ts
```

The driver tests use a mock VTube Studio WebSocket server: token request and
approval, request round-trip, stored-token rejection and re-request, event
subscription/push/unsubscribe, reconnect with re-authentication and
re-subscription, option resolution, APIError mapping, and the `0600` token
file. The plan test asserts the example manifest, including the event config.
