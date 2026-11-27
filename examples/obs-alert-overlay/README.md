# OBS alert overlay

A transparent browser artifact declared directly in an OBS scene:

- `ballast.ts` declares the `alerts` artifact, a `Sceneify.BrowserSource`
  whose `url` is `overlay.url`, and an `Alerts` scene containing it. The run
  `sync-alerts-scene` syncs the scene on startup.
- `artifacts/alerts/main.ts` is the overlay page: plain DOM and CSS, no
  dependencies.

`overlay.url` is the artifact's stable page URL, with
`?background=transparent` because the artifact is declared
`transparent: true`.

Run the project through the Ballast service (or the desktop app). The service
injects the artifact gateway URL. Standalone `ballast plan` still works
without a gateway: `overlay.url` is a marked placeholder and the manifest
records an `unresolved` entry for the artifact. Standalone `ballast run`
cannot resolve the URL and reading `overlay.url` throws
`ArtifactUrlUnavailableError`.
