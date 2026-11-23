# Sceneify integration

`@ballast/module-sceneify` (at `packages/integrations/sceneify`) adds
declarative OBS scenes on top of `@ballast/module-obs`, using
[Sceneify](https://github.com/Brendonovich/sceneify) (`@sceneify/core-rewrite`).
It has no connection of its own: it wraps a client from `OBS.Connection`, so
every request it makes uses that connection's `obs/*` grant, agent driver and
generated schemas.

## Script API

```ts
import * as OBS from "@ballast/module-obs";
import * as Sceneify from "@ballast/module-sceneify";
import { Effect, Schema } from "effect";

class Text extends Sceneify.InputType("text_gdiplus_v3", { text: Schema.String }) {}

const overlay = Sceneify.Scene.declare({
  name: "Overlay",
  items: {
    banner: {
      source: Sceneify.Input.declare(Text, { name: "Banner", settings: { text: "" } }),
      enabled: false,
    },
  },
});

export default Effect.gen(function* () {
  const obs = yield* OBS.Connection("main");
  const sceneify = yield* Sceneify.make(obs); // one per connection; no requests in init
  const scene = sceneify.scene(overlay);

  yield* OBS.CurrentProgramSceneChanged.subscribe("banner", obs, () =>
    Effect.gen(function* () {
      const banner = (yield* scene.get).item("banner");
      yield* banner.input.setSettings({ text: "hi" });
      yield* banner.setEnabled(true);
    }).pipe(Effect.orDie),
  );
});
```

- The module re-exports Sceneify's declaration API: `InputType`,
  `FilterType`, `Input`, `Filter`, `Scene`, `SceneItem` and its errors.
  Declarations are plain data; keep them at module scope.
- `Sceneify.make(obs)` returns a `Sceneify` for that connection. Make one per
  connection: it serializes syncs and tracks resources being created.
- `sceneify.sync(declaration)` reconciles a declared scene: it creates missing
  scenes, inputs, filters and items, reapplies declared settings, transforms
  and indexes, and removes stale resources Sceneify created. It returns typed
  runtime objects (`scene.item(key).input.filter(key)`).
- `sceneify.scene(declaration)` returns a handle. `handle.get` syncs on first
  use and then reuses the result for the worker's lifetime; `handle.sync`
  reconciles again (for example after the scene was edited by hand).
- Both require `Ballast.Runtime` like any request, so syncing in init fails
  the type gate, and at plan time dies with `RequestCalledDuringPlanError`.
- Ballast reports request failures as defects; the adapter (`makeSocket`)
  turns them into Sceneify's typed `OBSError`.
- Sceneify records ownership in OBS private settings, through the
  undocumented private-settings requests `module-obs` generates. A same-named
  source made by hand is never claimed (`NameConflictError`) or removed.
- `OBSSocket.batch` sends batched calls one at a time; the agent driver
  doesn't implement obs-websocket request batches (op 8/9) yet.

## Depending on Sceneify

Sceneify lives in its own repository, so `@sceneify/core-rewrite` is a
`file:` dependency on `../sceneify/packages/core-rewrite` (a sibling
checkout), with `effect` as a peer resolved to Ballast's catalog version.
pnpm installs a copy of the package's built `dist`, and `pnpm install` doesn't
always refresh it. After changing Sceneify, run its build (`tsgo -p .` in
`packages/core-rewrite`), then here
`rm -rf node_modules/.pnpm/@sceneify+core-rewrite* && pnpm install`.

`apps/agent/scripts/build-service.mjs` stages `module-sceneify`, Sceneify and
`obs-websocket-js` (which Sceneify imports for types only) into the service's
`node_modules`, and the planner maps `@ballast/module-sceneify` to
`integrations/sceneify` in generated project tsconfigs.

## Tests

- `packages/integrations/sceneify/test/sceneify.test.ts`: declared scenes
  against Sceneify's in-memory OBS, through a request host that decodes inputs
  and outputs the way the driver and worker do.
- `packages/integrations/sceneify/test/plan.test.ts`: planning
  `examples/obs-sceneify.ts` and `examples/sceneify-stream`, and plan-client
  death when init syncs.
- `apps/agent/test/obs-sceneify-e2e.test.ts` and
  `apps/agent/test/sceneify-stream-e2e.test.ts`: `ballast run` of the examples
  against the mock OBS server backed by Sceneify's in-memory OBS (and the mock
  Twitch server for the stream project).
