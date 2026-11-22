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
| `GET /relay/:machineId` | Authenticated agent WebSocket |

All `/api/*` routes except pairing use `Authorization: Bearer blst_m_…`.

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
pnpm dev    # alchemy dev: local state, local D1 migrations, Worker + Relay DO on :1338
pnpm demo   # fake Twitch + signed EventSub + relay WebSocket, in another terminal
pnpm deploy # alchemy deploy (the only command that contacts Cloudflare)
```

Alchemy requires Node 22.22.3+ or 24.11.1+. Use `fnm`/nvm if the system Node is older.

## Local development uses no Cloudflare account

`alchemy dev` is genuinely local for this stack. In `alchemy.run.ts`, dev selects
`Alchemy.localState()` (files under `.alchemy/state`) instead of `Cloudflare.state()`, so no
state-store Worker is bootstrapped. The Cloudflare providers' local variants then run the
Worker, D1 (with `migrations/` applied to a local SQLite simulator) and the Relay Durable
Object under `workerd`, storing data under `.alchemy/local/`. No credentials, account or
network access to Cloudflare is involved.

`wrangler dev` is no longer used; `wrangler.toml` was removed so bindings cannot drift from
`alchemy.run.ts`. The local demo exercises the real Worker + D1 + DO code path:

```sh
# terminal 1
pnpm dev
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
shared by isolates. A rejected attempt returns HTTP 429 with the shared `forbidden` error tag
(the protocol has no `rate_limited` tag yet) and `details: { limit, windowMs }`.

Token refreshes take a per-account lease in D1 (`refresh_lock` + `refresh_lock_until`, 30 s).
A request that loses the race waits up to 2 s for the winner, then returns a retryable
`upstream_error` instead of refreshing the same rotating refresh token twice. A stale lease
holder can never commit: `updateAccountSecrets` only applies while it still owns the lock.

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

- `alchemy.run.ts` — stack, D1 database, Relay DO binding, Worker env; local state in dev.
- `src/worker.ts` — async Worker entry and request/WebSocket routing.
- `src/app.ts` — Effect HTTP app (OAuth, pairing, tokens, Helix, EventSub, reconcile).
- `src/d1-store.ts` — D1 implementation of `CloudStore`.
- `src/secrets.ts` — AES-GCM token vault, machine-token hashing, random codes.
- `src/relay/` — relay buffer state, buffer service, DO, and the gateway used by the app.
- `migrations/` — users, accounts, machines, pairing, OAuth states, subscriptions, webhook
  dedupe, rate limits and the token-refresh lease.
