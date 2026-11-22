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

Copy `.env.example` to `.env` and fill in a Twitch app, a 32-byte `BALLAST_TOKEN_KEY`
(`openssl rand -base64 32`) and a token pepper. Never commit `.env`.

## Commands

```sh
pnpm typecheck
pnpm test
pnpm db:local   # apply migrations to the local D1 (first run)
pnpm dev:local  # wrangler dev --local, Worker + D1 + Relay DO on :8787
pnpm demo:local # fake Twitch + signed EventSub + relay WebSocket, in another terminal
pnpm dev        # alchemy dev (needs a Cloudflare profile/state store)
pnpm deploy     # alchemy deploy
```

`pnpm dev:local` runs the actual Worker and Relay Durable Object under workerd with local
D1 and a local WebSocket. `apps/cloud/wrangler.toml` is for that loop only; production
bindings come from `alchemy.run.ts`. Local secrets live in `apps/cloud/.dev.vars`
(gitignored).

`alchemy dev` uses `Cloudflare.state()`, which bootstraps a state-store Worker in a
Cloudflare account. It is not usable without a configured Cloudflare profile; the unit and
local-harness tests in `test/` exercise the same app with an in-memory store and a Node
WebSocket relay, and do not touch Cloudflare. Alchemy also currently requires Node 22.22.3+
or 24.11.1+; a shell on an older patch (for example 24.8.0) needs `fnm`/nvm to run the CLI.

## Layout

- `alchemy.run.ts` — stack, D1 database, Relay DO binding, Worker env.
- `src/worker.ts` — async Worker entry and request/WebSocket routing.
- `src/app.ts` — Effect HTTP app (OAuth, pairing, tokens, Helix, EventSub, reconcile).
- `src/d1-store.ts` — D1 implementation of `CloudStore`.
- `src/secrets.ts` — AES-GCM token vault, machine-token hashing, random codes.
- `src/relay/` — relay buffer state, buffer service, DO, and the gateway used by the app.
- `migrations/0001_init.sql` — users, accounts, machines, pairing, OAuth states,
  subscriptions and webhook dedupe.
