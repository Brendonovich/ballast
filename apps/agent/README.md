# @ballast/agent

The `ballast` CLI and the long-running local service (`ballast serve`).

## Development

```bash
pnpm --filter @ballast/agent typecheck
pnpm --filter @ballast/agent test
pnpm --filter @ballast/agent serve        # long-running service
pnpm --filter @ballast/agent serve --port 0 --dev
```

`plan` and `run` remain in-process development commands; everything else (`status`, `projects`, `scripts`,
`connections`, `cloud`, `consent`, `service`) is a client of a running `serve` discovered through
`service.json`.

## Service build for the desktop shell

```bash
pnpm --filter @ballast/agent build:service
```

Writes `apps/agent/dist-service/`:

```
main.mjs           bundled `ballast` CLI (serve --standalone works)
plan-worker.mjs    bundled planner worker (main.mjs points at it)
web/               copy of apps/web/dist, or a placeholder page
version.json       { "version": "..." }
node_modules/      effect, ws, rolldown + native binding, uiohook-napi and
                   @julusian/midi (with prebuilds), and @ballast/* source used
                   by runtime script bundling and the plan worker
```

The native `rolldown` package is deliberately external to the bundle and copied with its
`@rolldown/*` binding, because script bundles are produced at runtime. Run the stage with
`ELECTRON_RUN_AS_NODE=1 <electron> <stage>/main.mjs serve --standalone` (the desktop launcher does this).
`BALLAST_STATE_DIR`, `BALLAST_DATA_DIR`, `BALLAST_LOG_DIR`, `BALLAST_SERVICE_PORT` and
`BALLAST_SERVICE_VERSION` are honoured.
