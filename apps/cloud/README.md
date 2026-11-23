# @ballast/cloud

Cloudflare Worker + D1 + one per-machine Relay Durable Object for Ballast's Twitch gateway.
See `docs/decisions/0002-twitch-auth-and-cloud-gateway.md` for the design.

## Routes

| Method + path | Purpose |
| --- | --- |
| `GET /health` | Liveness |
| `GET /oauth/twitch/start` | Start Twitch OAuth (optional `scopes=a,b`) |
| `GET /oauth/twitch/callback` | Exchange the code and show a pairing code |
| `POST /webhooks/twitch/eventsub/:connectionId` | Twitch EventSub ingress |
| `POST /api/pairing/claim` | Pair a machine with a pairing code |
| `GET /api/connections` | Connections for the machine's user |
| `POST /api/tokens/twitch` | Short-lived Twitch access token |
| `POST /api/twitch/helix` | Scope-checked Helix proxy |
| `POST /api/twitch/subscriptions/reconcile` | Apply EventSub subscriptions |
| `POST /api/hooks/register` | Replace a machine's generic cloud hooks |
| `POST /api/hooks/unregister` | Remove generic cloud hooks |
| `GET /api/hooks` | List a machine's hooks without secrets |
| `/hooks/:machineId/:hookId` | Public generic webhook ingress, any method |
| `GET /relay/:machineId` | Authenticated agent WebSocket |

All `/api/*` routes except pairing use `Authorization: Bearer blst_m_…`.

When `scopes` is omitted, `/oauth/twitch/start` requests the cloud's default scopes. The cloud
has no project-consent-driven incremental authorization yet, so that default is currently a
dev stopgap covering chat-scenes: `user:read:chat`, `user:write:chat`, the bot grants and
redemptions. See `defaultScopes` in `src/config.ts`.

## Configuration

Copy `.env.example` to `.env` (or `.dev.vars`) and fill in a Twitch app, a 32-byte
`BALLAST_TOKEN_KEY` (`openssl rand -base64 32`) and a random `BALLAST_TOKEN_PEPPER`.
Never commit `.env` or `.dev.vars`. `BALLAST_TOKEN_PEPPER` has **no default**: the Worker
fails to start without it, so a deployment cannot silently use a public development pepper.

`pnpm dev` loads `.dev.vars` first and then `.env`, so either file works locally.

## Commands

```sh
pnpm typecheck
pnpm test
pnpm dev        # alchemy dev, remote: stage dev-brendonovich, real D1 + DO + Worker
pnpm dev:local  # alchemy dev, fully local: local state + workerd, no Cloudflare account
pnpm demo       # fake Twitch + signed EventSub + relay WebSocket, against dev:local
pnpm deploy     # alchemy deploy (the only command that contacts Cloudflare)
```

Alchemy requires Node 22.22.3+ or 24.11.1+. Use `fnm`/nvm if the system Node is older.

## Remote dev (default)

`pnpm dev` runs `scripts/dev-remote.mjs`, which starts `alchemy dev` with stage
`dev-brendonovich` and sets `BALLAST_CLOUD_REMOTE_DEV=1`, `BALLAST_WORKER_NAME`,
`BALLAST_PUBLIC_ORIGIN`, `BALLAST_D1_NAME` and `CLOUDFLARE_WORKERS_SUBDOMAIN`. Override the
stage/subdomain with `BALLAST_CLOUD_STAGE` / `CLOUDFLARE_WORKERS_SUBDOMAIN`. The stack uses
`Cloudflare.state()` and every resource is registered inside `Alchemy.remote()`, so
`alchemy dev` creates/adopts real Cloudflare resources while still watching files and
reapplying on change:

- Worker `ballast-cloud-dev-brendonovich` at
  `https://ballast-cloud-dev-brendonovich.brendonovich.workers.dev`
- D1 `ballast-cloud-dev-brendonovich-db`, with `migrations/` applied
- the Relay Durable Object namespace (class `Relay`) hosted by that Worker

No custom route or domain is attached. `BALLAST_PUBLIC_ORIGIN` is computed from the stage and
`CLOUDFLARE_WORKERS_SUBDOMAIN`, so OAuth `redirect_uri`, EventSub callbacks and `/hooks/...`
all use the public HTTPS origin. Secrets still come from the gitignored `.dev.vars`/`.env`.
The `dev-brendonovich` name and `dev-*` stage guard keep remote dev away from production.

## Local development without Cloudflare

`pnpm dev:local` (and the e2e harness, which invokes `alchemy dev --stage e2e_…` directly)
keeps the original local mode: `Alchemy.localState()` (files under `.alchemy/state`), the
Cloudflare providers' local variants, the Worker and Relay Durable Object under `workerd`,
and D1 migrations applied to a local SQLite simulator. No credentials, account or network
access to Cloudflare is involved. The e2e suite uses this mode and must keep working without
`CLOUDFLARE_*` credentials.

`wrangler dev` is no longer used; `wrangler.toml` was removed so bindings cannot drift from
`alchemy.run.ts`. The local demo exercises the real Worker + D1 + DO code path:

```sh
# terminal 1
pnpm dev:local
# terminal 2
pnpm demo
```

The demo starts a fake Twitch provider on `:4010`, runs OAuth → pairing → reconcile, sends a
signed EventSub notification while the agent is offline (buffered by the relay), then connects
a WebSocket and sends a live notification. Override the cloud URL with `BALLAST_CLOUD_URL` when
the dev server is on another port, and `BALLAST_DEV_PORT`/`BALLAST_PUBLIC_ORIGIN` to move it.

## Abuse and auth hardening

| Control | Limit | Scope |
| --- | --- | --- |
| Pairing-code claims | 10 / 15 min | client IP (`CF-Connecting-IP`, else first `X-Forwarded-For`) |
| Pairing-code creation | 5 / 15 min | Twitch user (one code per successful OAuth callback) |

Counters live in D1 (`rate_limits`) as fixed windows, so they survive Worker restarts and are
shared by isolates. A rejected attempt returns HTTP 429 with the shared `rate_limited` error tag
and `details: { limit, windowMs }`.

Token refreshes take a per-account lease in D1 (`refresh_lock` + `refresh_lock_until`, 30 s).
A request that loses the race waits up to 2 s for the winner, then returns a retryable
`upstream_error` instead of refreshing the same rotating refresh token twice. A stale lease
holder can never commit: `updateAccountSecrets` only applies while it still owns the lock.

Reconcile accepts an optional opaque `owner` id (project/script). Provider subscriptions are
shared: the cloud subscribes to the union of all owners and deletes one only when no owner still
wants it. Freshness merges conservatively: `drop` if any owner asks for drop, shortest
`maxAgeMs`. Existing clients that omit `owner` reconcile as `"default"`.

Twitch condition fields are validated against the module registry. `self` fields (`user_id`,
`moderator_user_id`, broadcaster fields on single-account topics) must be the connection's own
Twitch user; `target` fields (`broadcaster_user_id` for chat/follows) may be another linked
account or any channel where Twitch allows the token to read/moderate.

Generic webhooks (`/hooks/:machineId/:hookId`) are bearer-capability URLs owned by one
machine. Registration replaces the complete set; the secret is sealed in D1 and never returned.
Edge verification supports a shared secret or HMAC-SHA256 (hex/base64, optional prefix,
optional timestamp header and tolerance). Accepted requests are written to the Relay DO's
shared seq/ack buffer as `webhook_delivery` frames and get the hook's stored static response
immediately. Limits: 64 KiB body, 32 hooks/machine, 32 response headers, 4 KiB response body,
60/min per hook, 600/min per machine, 120/min per IP, 30 registrations/min per machine.

EventSub revocations with `status: "notification_failures_exceeded"` are recoverable: the
gateway deletes the dead provider subscription and creates it again with the stored condition
and webhook secret. `authorization_revoked` / `user_removed` set `twitch_accounts.needs_reauth`
(also surfaced on `GET /api/connections`), mark the subscription revoked with its reason, and
send the relay's `subscription_revoked` frame. Every other reason marks the subscription revoked
and notifies the machine; the next reconcile decides whether to retry.

## Twitch protocol code

Webhook HMAC verification and message schemas, the subscription registry (types, conditions,
scopes), Helix request definitions/executor and OAuth exchange/refresh/validate come from
`@ballast/module-twitch` (`packages/integrations/twitch`). `apps/cloud` keeps only the gateway
glue: the raw Helix passthrough the agent proxy needs, the `client_credentials` app token (not
yet in the module), D1 storage, rate limits and relay routing.

## Layout

- `alchemy.run.ts` — stack and resources; local state in dev. No Worker `main` path: the
  Worker is an Effect program built by `src/worker.ts`.
- `src/cloud-worker.ts` — the Worker class (declares the Relay Durable Object).
- `src/worker.ts` — Effect Worker init (yields D1, Relay and Config bindings) and fetch handler.
- `src/resources.ts` — the shared D1 database resource.
- `src/relay/relay-do.ts` — Effect Durable Object class and `RelayLive` implementation.
- `src/app.ts` — Effect HTTP app (OAuth, pairing, tokens, Helix, EventSub, reconcile).
- `src/d1-store.ts` — D1 implementation of `CloudStore`.
- `src/secrets.ts` — AES-GCM token vault, machine-token hashing, random codes.
- `src/relay/` — relay buffer state, buffer service, DO, and the gateway used by the app.
- `migrations/` — users, accounts, machines, pairing, OAuth states, subscriptions, webhook
  dedupe, rate limits and the token-refresh lease.
