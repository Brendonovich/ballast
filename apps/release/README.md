# @ballast/release

Ballast's release service: update manifests, release files and GitHub OIDC publishing, on one
Cloudflare Worker and one R2 bucket. It is the public Worker of `anomalyco/release` ported into
this repo, with the same protocol and publish API, so the desktop updater
(`apps/desktop/src/main/update/`) and the release client (`.github/release/release-client.sh`)
work against it unchanged. It leaves out anoma.ly's admin Worker (Access-gated analytics and admin
API), request logging and the lake. Change releases with the publish API's actions from GitHub
Actions instead (rollout, halt, resume, required, promote, refresh).

## Routes (under `/release`)

| Request | |
| --- | --- |
| `GET /` | Service info and registered apps |
| `GET /client.sh` | The publish client |
| `GET /<app>/<artifact>/<channel>.json` | The manifest clients poll (`no-cache`, ETag) |
| `GET /<app>/index.json` | Every artifact and channel's current version |
| `GET /<app>/files/<sha256>/<name>` | Immutable file (Range supported) |
| `GET /<app>/history/<artifact>/<channel>/<n>.json` | Every manifest written |
| `GET /<app>/<artifact>/<channel>/<target>[/info]` | 302 to the current file, or its details |
| `POST /<app>/sessions` | Trade a GitHub OIDC token for a one-hour publish session |
| `PUT /<app>/files/<name>`, `POST …?uploads`, `PUT …?upload=&part=`, `POST …?upload=` | Uploads (95 MiB per request; larger files in parts) |
| `POST /<app>/<artifact>/releases` | Publish a release |
| `POST /<app>/<artifact>/<channel>/<action>` | rollout, halt, resume, required, distribution, promote, refresh |

The anomalyco/release docs (`docs/protocol.md`, `docs/publishing.md`) describe each in full; replace
`https://anoma.ly/release` with this service's URL.

## Who may publish

`registry/<app>.json` lists publishers: repository (by name and numeric ids), workflow file, refs
and GitHub environment. Only a job in that workflow file, on an allowed ref, in that environment,
from a push, dispatch, release or schedule event may publish. `registry/ballast.json` allows
`brendonovich/ballast`'s `.github/workflows/release.yml` on `refs/heads/dev` in environment
`release`. Changing the registry takes a redeploy.

## Commands

```sh
pnpm test         # the ported Worker suite under Miniflare
pnpm typecheck
pnpm dev          # alchemy dev: local state + workerd, http://localhost:1337/release
pnpm deploy       # stage prod → https://ballast-release.<account subdomain>.workers.dev/release
pnpm sync-client  # regenerate src/worker/client.ts after editing .github/release/release-client.sh
```

`deploy` needs Cloudflare credentials, the same as `apps/cloud`. In stage `prod`, R2 lock rules make
`files/`, `history/` and `provenance/` permanent, so the bucket can never be deleted. Other
stages are disposable rehearsals (`ballast-release-<stage>`). The publish session secret is
generated once (`Alchemy.Random`) and kept in Alchemy state.

Builds stamp the service URL (`BALLAST_RELEASE_ORIGIN`, the workflow's `RELEASE`) as the place they
update from. Moving the service later strands installed builds unless the old URL keeps serving.
