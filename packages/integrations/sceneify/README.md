# @ballast/module-sceneify

Declarative OBS scenes for Ballast, built on `@ballast/module-obs` and
[Sceneify](https://github.com/Brendonovich/sceneify). Declare scenes, inputs
and filters as data; Sceneify makes OBS match them over an existing OBS
connection and hands back typed runtime objects.

```ts
const obs = yield* OBS.Connection("main");
const sceneify = yield* Sceneify.make(obs);
const overlay = sceneify.scene(Layout.overlay);

// in a handler
const banner = (yield* overlay.get).item("banner");
yield* banner.input.setSettings({ text: "hi" });
```

See `docs/integrations/sceneify.md`, `examples/obs-sceneify.ts` and
`examples/sceneify-stream`.
