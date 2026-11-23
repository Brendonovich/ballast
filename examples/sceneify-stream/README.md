# sceneify-stream

A full stream setup driven by declared OBS scenes, using
`@ballast/module-obs` for the connection and `@ballast/module-sceneify` for the layout. `src/obs/layout.ts` is the
layout as data; on start the project makes OBS match it, and Twitch events and
chat commands drive it from there.

| File | What it does |
| --- | --- |
| `ballast.ts` | Params, the OBS and Twitch connections, and a startup run that syncs the layout |
| `src/obs/types.ts` | Typed source and filter kinds (`Sceneify.InputType`, `Sceneify.FilterType`) |
| `src/obs/layout.ts` | Four scenes (Starting Soon, Gameplay, Just Chatting, Be Right Back) sharing a camera, chat, title and alert banner |
| `src/stage.ts` | Everything done to OBS: sync, scene switches, the title, hype mode and the alert queue |
| `src/twitch.ts` | Follows, subs, cheers and raids become alerts; mod chat commands; durable timers |

What it shows:

- **Declared layout.** The first sync creates every scene, input, filter and
  item, with transforms, z-order and locks. Inputs placed in several scenes
  are created once. Later syncs reapply declared settings and leave anything
  undeclared alone, so the camera device is chosen once in OBS.
- **Typed runtime handles.** `scene.item("camera").input.filter("hype")` and
  `input.setSettings({ text })` are checked against the declarations.
- **Temporary items.** Each alert is a `scene.createItem` media source on the
  live scene, removed when OBS reports `MediaInputPlaybackEnded` (or after 30
  seconds). Alerts queue so only one plays at a time.
- **Raw requests alongside.** `obs.GetCurrentProgramScene()` picks the scene
  alerts play on, on the same connection.
- **Durable timers.** Hype mode (a big cheer turns on the camera's colour
  filter) and the Starting Soon countdown end on `Ballast.Timer`, so a restart
  in between still finishes them.

Chat commands, for the broadcaster and moderators:

| Command | Effect |
| --- | --- |
| `!scene starting\|gameplay\|chatting\|brb` | Switch the program scene |
| `!title <text>` | Set the title shown in Gameplay and Just Chatting |
| `!hype` | Start hype mode |
| `!alert <text>` | Play a test alert |

The source kinds are the Windows ones (`text_gdiplus_v3`, `dshow_input`,
`game_capture`). On macOS use `text_ft2_source_v2`, `av_capture_input_v2` and
`screen_capture`.

`apps/agent/test/sceneify-stream-e2e.test.ts` runs this project through
`ballast run` against mock OBS and Twitch servers.
