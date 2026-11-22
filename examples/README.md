# Examples

Sample Ballast scripts:

- `tick-echo.ts` — the Phase 0 fake integration (params, request, topic).
  Topics are subscribed through namespace objects:
  `Fake.Tick.subscribe(fake, (tick) => ...)`.
- `obs-scene.ts` — declares an OBS connection, sets a scene, and logs
  `CurrentProgramSceneChanged` with
  `OBS.CurrentProgramSceneChanged.subscribe(obs, ...)`. See
  `docs/integrations/obs.md`.
