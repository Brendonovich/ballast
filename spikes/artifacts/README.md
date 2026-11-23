# Project Artifacts spike

Isolated spike for decision 0011. It is not in the pnpm workspace and nothing in
the product depends on it.

It proves:

- an Effect `RpcGroup` with a query (`Snapshot`), an action (`Increment`) and a
  streaming query (`Events`) in a worker-like process;
- a small WebSocket proxy that rejects an invalid per-project token with 401;
- a browser bundle using the typed Effect `RpcClient` over that socket, with
  live stream chunks and an action call.

## Run

```bash
# dependencies are symlinked from the workspace install
./node_modules/.bin/tsgo -p tsconfig.json

node node_modules/esbuild/bin/esbuild src/client.ts \
  --bundle --format=esm --platform=browser --outfile=public/client.js

node --experimental-strip-types --no-warnings=ExperimentalWarning src/server.ts

# another shell
node --experimental-strip-types --no-warnings=ExperimentalWarning src/browser-test.ts
```

The default token is `dashboard-action-token`; the read-only token
`dashboard-read-token` is also accepted by the proxy (method-level scoping is a
production follow-up). The URL is printed as `ARTIFACT_URL`.
