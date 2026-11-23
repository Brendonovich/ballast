# Ballast authoring guide

Ballast projects are TypeScript Effect programs that the Ballast service plans,
typechecks, bundles and runs on the user's machine. The MCP tools are the
authoring loop: write files, then call `ballast_check`, fix diagnostics, and
call `ballast_apply`. The user starts a project for the first time and approves
new permissions in the Ballast app.

## Project shape

```text
my-project/
  ballast.ts        # default entry; one bundle per project
  src/
    alerts.ts
    chat.ts
  package.json      # optional; may set ballast.entry
  tsconfig.json
  .ballast/         # service state, never edit
```

`ballast.ts` must default-export an Effect. Modules under `src/` export Effects
and the entry composes them:

```ts
import { Effect } from "effect";
import { alerts } from "./src/alerts.ts";
import { chat } from "./src/chat.ts";

export default Effect.all([alerts, chat], { discard: true });
```

An optional `package.json#ballast.entry` overrides the entry:

```json
{ "ballast": { "entry": "src/main.ts" } }
```

There is exactly one entry. A project is one worker, one manifest and one
consent decision.

## Imports

A project may import only:

- `effect` and `effect/*`
- `@ballast/*` packages
- relative project files

Do not import npm packages, Node built-ins, or files outside the project. The
planner resolves workspace Ballast packages and bundles the project; it does
not install dependencies.

## Init declares, handlers act

The default export runs once in init. Init must not perform I/O. Declare
params, connections, subscriptions, request capabilities, timers and run loops
there; do all I/O inside handlers or `Ballast.run` effects.

```ts
import * as Ballast from "@ballast/core";
import * as OBS from "@ballast/module-obs";
import * as Twitch from "@ballast/module-twitch";
import { Effect } from "effect";

export const title = "Redeem to Scene";

export default Effect.gen(function* () {
  // Params are lazy: plan records them, handlers read them.
  const rewardTitle = yield* Ballast.Param.string("rewardTitle", {
    title: "Reward title",
    default: "Hydrate",
  });
  const scene = yield* Ballast.Param.enum("scene", ["Starting Soon", "Game", "BRB"], {
    title: "Scene",
    default: "Game",
  });

  // Connection slots are names, not credentials. The user binds each slot to
  // a configured service-wide connection in the Ballast app.
  const broadcaster = yield* Twitch.Account("broadcaster");
  const obs = yield* OBS.Connection("main");

  // Named subscription: the name is stable and unique per project.
  yield* Twitch.ChannelPointsRedemption.subscribe(
    "redemption",
    broadcaster,
    (event) =>
      Effect.gen(function* () {
        if (event.reward.title !== (yield* rewardTitle)) return;
        yield* obs.SetCurrentProgramScene({ sceneName: yield* scene });
      }),
  );

  // Long-running, non-durable loop. Name it explicitly.
  yield* Ballast.run(
    "startup-log",
    Effect.log("Ballast project started"),
  );
});
```

Every subscription, timer, workflow and run loop needs a non-empty name that
is unique per kind per project. Renaming is a remove plus an add.

## Params

`Ballast.Param.string | number | boolean | enum` returns an Effect of a lazy
param. Read it in a handler with `yield* param`; do not read it during init.
Use `options.default` for optional params and `title`/`options` for the settings
UI. Dynamic enum options come from an integration:

```ts
const scene = yield* Ballast.Param.string("scene", { options: OBS.scenes("main") });
```

## Connections and request capabilities

`Integration.Connection(slot)` declares a connection slot. It returns a typed
handle. Local integrations (OBS, VTube Studio, keyboard, MIDI) have no OAuth
scopes; the connection itself is the grant. Twitch uses OAuth scopes and an
account slot:

```ts
const broadcaster = yield* Twitch.Account("broadcaster");
const sendChat = yield* broadcaster.helix("sendChatMessage");
yield* sendChat({ broadcaster_id: broadcasterId, sender_id: senderId, message: "hi" });
```

`account.helix(name)` records exactly that Helix request and its OAuth scopes
in the manifest. Prefer it over a generic HTTP call: the user gets one precise
scope-consent prompt. `OBS.Connection("main")` grants the `obs/*` request
namespace. VTube Studio, keyboard and MIDI work the same way.

The user configures connections once for the whole service; projects refer to
slots. `ballast_check` reports missing connections and scopes; `ballast_apply`
never approves them. Tell the user which slot to configure in the Ballast app.

## Durable work: timers and workflows

Never use `Effect.sleep` for work that must survive a restart, a closed laptop
or the service stopping. A handler's `Effect.sleep` only lives while that
handler's worker lives.

Declare a durable timer in init and schedule it from a handler:

```ts
const CooldownEnded = Schema.Struct({ user: Schema.String });

const cooldown = yield* Ballast.Timer.subscribe(
  "cooldown",
  CooldownEnded,
  (fire) => Effect.log(`cooldown ended for ${fire.payload.user}`),
  { title: "Cooldown", onStale: "deliver", maxAgeMs: 7 * 24 * 60 * 60_000 },
);

yield* Tick.subscribe("tick", fake, (tick) =>
  cooldown.after("global", "10 minutes", { user: "viewer" }),
);
```

Timers are durable events, not resumable continuations: put the work after the
sleep in the timer handler. `onStale: "deliver"` delivers a late fire once with
`lateByMs`; `"drop"` discards it. The key is idempotent.

`@ballast/workflow` is a prototype one-call durable workflow API for longer
multi-step work. The Ballast service integration for workflows is still being
finished, so prefer `Ballast.Timer` and `Ballast.run` unless the project
already uses `@ballast/workflow`.

`Ballast.run(name, effect)` is a long-running loop that lives only while the
bundle worker lives. It is explicitly non-durable; anything that must survive a
restart belongs in a timer or workflow.

## Plan, apply and consent

- `ballast_check` typechecks, bundles and plans without applying. It returns
  diagnostics with file/line/column, the planned units and sources, a diff
  against the applied manifest, whether consent is required, and missing
  connections.
- `ballast_apply` requests a reload. It never grants scopes, approves consent
  or performs the first start. If consent or a start is needed, it returns
  `waiting_for_user` with the action the user must take in the Ballast app.
- A plan that adds a scope or connection slot requires consent. Removing
  permissions and changing payload schemas do not.
- A failed typecheck/bundle/plan keeps the previous version running. Fix the
  diagnostic and check again; `ballast_status` says whether the previous
  version is still running.

## Catalog

Call `ballast_catalog` to discover integrations, topics (with event schemas),
requests (with input/output schemas and scopes) and connection kinds. Filter by
integration and request `includeSchemas: true` only when you need a schema;
the full OBS/Twitch/VTube Studio catalogs are large.

## Common mistakes

- Doing I/O or reading a param in init. Declare in init, act in handlers.
- `Effect.sleep` for minutes/hours. Use `Ballast.Timer`.
- Unnamed or duplicate unit names. Names are required and unique per kind.
- Importing npm packages or Node built-ins. Only `effect`, `@ballast/*` and
  relative files are bundled.
- Calling `Ballast_apply` expecting it to approve consent or start a new
  project. Those are user actions in the Ballast app.
