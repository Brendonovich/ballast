# Examples

Sample Ballast scripts:

- `tick-echo.ts` — the Phase 0 fake integration (params, request, topic).
  Topics are subscribed through namespace objects:
  `Fake.Tick.subscribe(fake, (tick) => ...)`.
- `database.ts` — declares a local SQLite database with
  `Ballast.Database("main")`, creates a table in `Ballast.run`, and inserts +
  counts a row per fake tick (`yield* db.client` gives the effect/sql
  `SqlClient`; the file lands at `.ballast/db/main.sqlite`).
- `obs-scene.ts` — declares an OBS connection, sets a scene, and logs
  `CurrentProgramSceneChanged` with
  `OBS.CurrentProgramSceneChanged.subscribe(obs, ...)`. See
  `docs/integrations/obs.md`.
- `redeem-to-scene.ts` — a Twitch channel-points redemption whose reward title
  matches a param switches an OBS scene through
  `Twitch.ChannelPointsRedemption.subscribe(broadcaster, ...)`. Works in both
  local-app and cloud mode. See `docs/integrations/twitch.md`.
- `obs-sceneify.ts` — a declared OBS scene (`Sceneify.Scene.declare`) synced on first use
  and driven from an OBS event.
- `obs-alert-overlay/` — a transparent alert artifact plus a declared OBS
  scene whose browser source loads it with `overlay.url` (the artifact's
  stable overlay URL).
- `sceneify-stream/` — a multi-file stream project: a four-scene declared
  layout, Twitch alerts as temporary scene items, mod chat commands and durable
  timers. See its README.
- `stream-dashboard/` — a Solid artifact project: fake chat history queried
  and watched over Effect RPC, counters in `Ballast.Store`, and a reset
  procedure.
