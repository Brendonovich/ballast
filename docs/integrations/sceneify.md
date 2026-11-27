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

## Browser sources and artifact overlays

`Sceneify.BrowserSource` is a typed OBS `browser_source` input kind. Use it
with `Input.declare` for any ordinary URL:

```ts
const chat = Sceneify.Input.declare(Sceneify.BrowserSource, {
  name: "Chat",
  settings: {
    url: "https://www.twitch.tv/embed/streamer/chat?darkpopout",
    width: 400,
    height: 900,
    css: "body { background-color: transparent; }",
  },
});
```

It lists the settings overlays normally set: `url`, `width`, `height`,
`css`, `shutdown`, `restart_when_active`, `reroute_audio`, `fps_custom`
and `fps`. OBS keeps every setting a declaration does not name.

To show a **project artifact** in OBS, do not copy the URL by hand. The
artifact handle exposes its URL as a plain `string`, so it plugs straight into
an ordinary browser source declaration:

```ts
export default Effect.gen(function* () {
  const obs = yield* OBS.Connection("main");
  const overlay = yield* Ballast.Artifact("alerts", {
    entry: "./artifacts/alerts/main.ts",
    transparent: true,
  });

  const sceneify = yield* Sceneify.make(obs);
  const scene = sceneify.scene(
    Sceneify.Scene.declare({
      name: "Alerts",
      items: {
        overlay: {
          source: Sceneify.Input.declare(Sceneify.BrowserSource, {
            name: "Alert Overlay",
            settings: {
              url: overlay.url, // stable, transparent page URL
              width: 1920,
              height: 1080,
              css: "html, body { background: transparent; }",
              shutdown: false,
              restart_when_active: true,
            },
          }),
          index: 0,
        },
      },
    }),
  );

  yield* Ballast.run(
    "sync-alerts",
    Effect.gen(function* () {
      yield* scene.get;
    }),
  );
});
```

- `Ballast.Artifact` returns a handle whose `url` is a `string` for every
  phase. Reading it is pure, so init stays I/O-free.
- With `transparent: true`, the URL ends in `?background=transparent`, which
  the artifact shell uses for a transparent page. Without `transparent: true`
  the page is not an overlay; use a normal dashboard URL or declare the
  artifact transparent.
- The URL is the artifact's stable page URL. It survives service restarts and
  can call every procedure in the project API.
- No request is made in init. The browser source is created when the declared
  scene is synced in a handler or `Ballast.run`.
- A declaration that needs the handle cannot live at module scope. Build it in
  init after `Ballast.Artifact` (the scene above is plain data and still makes
  no requests).

### Plan visibility and missing URLs

The artifact URL is injected by the planning/runtime bundle as
`globalThis.__BALLAST_ARTIFACT_HOST__`. When a stable host exists (the Ballast
service with the default `BALLAST_ARTIFACT_PORT=47831`), `overlay.url` is the
stable URL, for example:

```text
http://127.0.0.1:47831/a/a1.<project>.<hmac>/alerts/index.html?background=transparent
```

`ballast plan` alone has no artifact gateway, and `BALLAST_ARTIFACT_PORT=0`
uses an ephemeral port. `overlay.url` is still a string, but:

- in plan, it is a clearly marked placeholder
  (`http://127.0.0.1:0/unresolved/artifacts/<name>/index.html`), and the first
  read records an `unresolved` manifest entry `artifact:<name>` explaining
  that the project must run through the Ballast service;
- in runtime, reading it throws `ArtifactUrlUnavailableError` with the same
  explanation, before OBS can create a browser source with a broken page.

Start/run the project through the Ballast service (or the desktop app) to get
the real URL.

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
  and browser sources against Sceneify's in-memory OBS, through a request host
  that decodes inputs and outputs the way the driver and worker do. A browser
  source declared with an artifact URL is asserted through the created OBS
  input settings.
- `packages/integrations/sceneify/test/plan.test.ts`: planning
  `examples/obs-sceneify.ts`, `examples/sceneify-stream` and
  `examples/obs-alert-overlay` (with and without an `artifactHost`; without
  one, the example's `overlay.url` read records `artifact:alerts` as
  unresolved), and plan-client death when init syncs.
- `apps/agent/test/obs-sceneify-e2e.test.ts` and
  `apps/agent/test/sceneify-stream-e2e.test.ts`: `ballast run` of the examples
  against the mock OBS server backed by Sceneify's in-memory OBS (and the mock
  Twitch server for the stream project).
