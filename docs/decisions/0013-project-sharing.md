# 0013 — Project sharing: one-way shares over Cloudflare Artifacts

*Status: accepted and implemented (2026-11-27) · effect `4.0.6` · alchemy `2.0.0-beta.84`*

> **Amended by 0014:** sharing authenticates people with Sign in with Anomaly
> instead of paired machines, projects record their share server, and the
> `share_update` relay push is replaced by polling. Machine/relay details below
> are historical.

## Context

PLAN.md lists "publish/pull distribution" as a later phase. Users want to share a
project: an author shares it, other streamers install a copy, and the author
ships updates. This is not collaboration: changes flow one way, author → subscribers.

The words "artifact"/"artifacts" already mean project UI pages (decision 0011,
`packages/artifact`). This feature is called **share** (a shared project and
its record), **deploy** (a new version), **subscribe** and **update** in code;
an earlier draft used "publish"/"release". Cloudflare's storage product is
also named Artifacts; only the storage adapter in `packages/shares-api` uses
that name.

## Decisions (fixed by the user)

1. **Access:** an unlisted share code. Any paired Ballast machine with the code
   can subscribe. No teams or ACLs.
2. **Infrastructure** is a dedicated set of Alchemy resources
   (`packages/shares-api`) that the Ballast stack in `apps/cloud`
   includes; it can also be deployed on its own. No per-project Alchemy
   resources: repos are created at runtime.
3. **Subscribed projects are read-only.** Applying an update overwrites local
   edits; the CLI/UI warn about it but do not block.
4. **Updates are never automatic.** A subscriber is told "update available" and
   applies it on a user action. After applying, existing consent rules hold:
   new scopes or connection slots become `pendingConsent` on that machine.

## Design

### Split: front door and shares API

- **`apps/cloud` is the front door.** It owns identity and notifications:
  machine auth (`Bearer blst_m_…`), the `/api/shares/*` routes agents call,
  authorization (a share's owner is the user whose machine created it;
  readers are the owner's machines and subscribed machines; a share code
  grants subscribe), the subscribe rate limit, and the `share_update` push
  through `RelayGateway`.
- **`packages/shares-api` is the shares API**: its own D1 database
  (`SharesDatabase`, `migrations/0001_shares.sql`), the Artifacts
  namespace (`ShareRepoNamespace`), and a Worker (`SharesApi`) whose
  RPC methods (`SharesApiRpc`: create/get/find share, deploy
  token, record deploy, subscriptions, installed SHA, diff) the cloud calls
  over a service binding (`Cloudflare.Workers.bindWorker`). It has no
  credentials of its own and no public API beyond `/health`; owner and
  subscriber ids are the cloud's user and machine ids as opaque strings.
  Failures carry the HTTP status and tag the cloud answers with.
- The package has its own `alchemy.run.ts` (`BallastShares` stack) so the
  shares API can be deployed or developed independently; the Ballast stack
  yields the same `SharesDatabase` and `SharesApi` resources.
- The agent and the wire format do not know about the split.

### Storage

- One Cloudflare Artifacts namespace (`ballast-shares-<stage>`), bound to the
  Worker with `Cloudflare.Artifacts.ReadWriteNamespace`; one git repo per
  share (`ballast-<hex>`).
- The shares API's D1 (`packages/shares-api/migrations/0001_shares.sql`):
  `shares` (owner user and machine, repo, share code, current
  commit SHA, manifest hash, message, timestamps) and `share_subscriptions`
  (share × machine, installed SHA).
- The Worker cannot write files to a repo; writes are `git push` to the repo's
  smart-HTTP remote with a short-lived (15 min) write token minted by the cloud.
- Everything is addressed by **commit SHA**, never by branch. Each deploy's
  commit must have the previous deploy as a parent (checked when the deploy is
  recorded, plus a compare-and-set in D1), so every earlier deploy stays
  reachable and can be diffed.

### Share manifest

Each commit carries `ballast.share.json` at the root (`@ballast/cloud-protocol`
`ShareManifest`): `{ version: 1, name, files: { path: { sha, size, mode } } }`,
where `sha` is the git blob SHA-1 and `mode` is `100644`/`100755`. The path
check (`sharePathError`) is the subscriber's traversal guard: relative POSIX
paths only, no `.`/`..`/empty segments, never inside `.ballast`, `.git`,
`node_modules` or `dist`, never `.env`, `.env.*` or `.DS_Store`, and no
case-folding or file/directory collisions. Limits: 2,000 files, 8 MiB per
file, 24 MiB per share (under the platform's 64 MiB per push and 32 MiB per
file). Service-generated `tsconfig*.json` files (they hold this machine's
absolute type paths) are not shared; a subscriber's planner generates its
own config.

### Cloud API (machine-authenticated, `/api/shares/*`)

Create share · deploy token · record deploy (checks the commit exists,
builds on the current deploy and carries a valid manifest, then sends
`share_update` to every subscribed machine through `RelayGateway.notify`) ·
subscribe by share code (20 attempts / 15 min per machine) · unsubscribe ·
list subscriptions · report installed SHA · **diff** `from → to`: the two
manifests are read at their commit SHAs, diffed (`diffShareManifests`), and
each changed file is read at the target SHA, re-hashed and returned base64.
No `from` means a full snapshot. Artifacts has no diff API, so manifests make
the diff cheap and exact.

`share_update` is a non-buffered relay message. Agents also list their
subscriptions when the relay listener attaches and every 5 minutes, so a
machine that was offline still learns about deploys.

### Agent

- **Share/deploy** (`ShareProject`, `DeployProject`; `ballast projects
  share|deploy`; MCP `ballast_share`; Share/Deploy button): collect files,
  build the manifest, get a write token, then write blobs/trees/one commit into
  a bare cache repo (`<dataDir>/shares/<shareId>.git`) with
  **isomorphic-git** and push. Users need no git install. Unchanged trees push
  nothing. A missing cache fetches the current deploy first.
- **Subscribe** (`SubscribeProject`; `ballast projects subscribe <code>`;
  Subscribe dialog): fetch a full snapshot into an empty folder, verify, record
  `.ballast/share-manifest.json` and the registry entry's
  `share: { _tag: "subscribed", shareId, installedSha }`. The project
  starts stopped; its first start and consent are the user's.
- **Update** (`ApplyProjectUpdate`; `ballast projects update`; "Apply update"
  banner): fetch the diff from the installed SHA, check that the files sent are
  exactly the manifest diff and match their hashes, report local edits that
  will be overwritten, then with the project's background sync paused:
  stage every file under `.ballast/`, verify each staged file's git SHA, swap
  with a rollback journal (targets moved to a backup, staged files renamed in,
  deletions moved to the backup; any failure restores every completed step),
  record the new SHA, and reload once. The reload is the normal file-change
  cutover: one plan, one new generation, and the old worker keeps running if the
  new version fails to build. A download or verification failure leaves the
  old files and running worker untouched.
- Share state is part of `ProjectSummary.share` and the
  `share-update-available` service event.

### Local development

Alchemy's local workerd only offers Artifacts as a remote binding (it needs a
Cloudflare account). Wrangler ≥ 4.163 has a local Artifacts simulator (real git
repos, Git ≥ 2.32). `packages/shares-api/scripts/shares-dev` runs a
small Worker under that simulator and exposes the four calls the shares API
needs over HTTP; `BALLAST_SHARES=<bridge url>` makes the shares API use it.
The cloud's `dev:local` defaults to `BALLAST_SHARES=off` (sharing answers
503); the package's own `pnpm dev` defaults to the bridge; deploys default
to the binding.

## ⚠️ Isolation caveat

**Subscribed code written by someone else runs with the same privileges as the
user's own scripts.** Workers are `worker_threads`, not a security boundary
(PLAN.md §6.3 and open question 4): a malicious share can reach Node APIs,
the file system and the network. Manifest-based consent only covers
integrations, scopes and connections. Until scripts are sandboxed, the
Subscribe dialog tells users to subscribe only to people they trust.

## Naming notes

- The relay message is `share_update` and the service event
  `share-update-available` (renamed from `project_update` /
  `project-update-available`, so every name in the feature says "share").
- `DeployProject`, `SubscribeProject`, `UnsubscribeProject` and
  `ApplyProjectUpdate` keep their names: they act on projects.

## Consequences and limits

- Read-only is a convention: nothing stops an external editor from changing a
  subscribed copy. Local edits to files an update touches are overwritten and
  reported; untouched edited files and extra local files stay.
- Multi-file atomicity relies on the paused sync plus the rollback journal; a
  crash in the middle of the swap can leave backups under `.ballast/share-*`.
- Pinned Alchemy `beta.84`: the Effect-wrapped repo read methods arrived in
  `beta.85`, which requires effect `^4.1`. The adapter calls the runtime
  repo stub (`repo.raw.readFile/readCommit/info`) directly instead. Bump
  together with effect.
- Production Artifacts and isomorphic-git's push/fetch were exercised against
  wrangler's local simulator only; the deployed service is untested.
- Out of scope: two-way sync, version history UI, rollback, teams, deleting a
  share, sandboxing.
