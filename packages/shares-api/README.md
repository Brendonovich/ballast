# @ballast/shares-api

The storage and file-serving side of Ballast project sharing (decision 0013) as its own set of Alchemy
resources:

| Resource | What it is |
| --- | --- |
| `SharesDatabase` | D1 database: shares, share codes, current deploys, subscriptions (`migrations/`) |
| `ShareRepoNamespace` | Cloudflare Artifacts namespace `ballast-shares-<stage>`, one git repo per share |
| `SharesApi` | Worker exposing the operations below over a service binding (`/health` only over HTTP) |

The shares API has no credentials of its own. The Ballast cloud (`apps/cloud`) is the front door:
it authenticates machines, authorizes each call, rate-limits and pushes `share_update` over its
relay, and calls this Worker with `Cloudflare.Workers.bindWorker(SharesApi)`. Owner and
subscriber ids are the cloud's user and machine ids, stored as opaque strings.

`SharesApiRpc` (`src/api.ts`): `createShare`, `getShare`,
`findShareByCode`, `deployToken` (short-lived git write token + remote),
`recordDeploy` (checks the commit exists, builds on the current deploy and carries a valid
`ballast.share.json`; compare-and-set; returns the machines to notify), `subscribe`,
`unsubscribe`, `isSubscribed`, `listSubscriptions`, `setInstalledSha`, and `diff` (manifest
diff between two commit SHAs; changed files re-hashed against the manifest and returned base64).
Failures are `SharesApiError` with the HTTP status and error tag to answer with.

## Storage selection

`BALLAST_SHARES` (read as a Config during init, so plan and runtime agree):

- `artifacts` (default): binds the Artifacts namespace. Reads go through the runtime repo stub
  (`repo.raw.readFile/readCommit/info`) because the pinned Alchemy (beta.84) only wraps
  create/get/createToken; the wrapped readers need beta.85+, which needs effect 4.1.
- `off`: every storage operation answers 503.
- `http(s)://…`: the local Artifacts simulator bridge in `scripts/shares-dev`.

## Use from another stack

```ts
import { SharesApi, SharesDatabase, makeSharesApiLayer } from "@ballast/shares-api";

yield* SharesDatabase;
yield* SharesApi.pipe(Effect.provide(makeSharesApiLayer()));
// in a Worker's init:
const shares = yield* Cloudflare.Workers.bindWorker(SharesApi);
```

## Deploy and develop on its own

```sh
pnpm --filter @ballast/shares-api deploy   # alchemy deploy (Cloudflare state store)
pnpm --filter @ballast/shares-api bridge   # terminal 1: wrangler 4.168 Artifacts simulator on :8799 (Git >= 2.32)
pnpm --filter @ballast/shares-api dev      # terminal 2: alchemy dev (local state, workerd, local D1) on :1350
```

`dev` defaults `BALLAST_SHARES` to the bridge. Alchemy needs Node 22.22.3+ or 24.11.1+.
