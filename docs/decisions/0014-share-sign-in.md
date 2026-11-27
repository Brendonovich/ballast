# 0014 — Share servers and Sign in with Anomaly

*Status: accepted and implemented (2026-11-27) · amends 0013 · oauth4webapi `3.8.9`*

## Context

Decision 0013 tied sharing to cloud machine pairing, which is a Twitch sign-in:
a share belonged to the Twitch user whose paired machine created it, and
subscriptions belonged to machines. Publishing should not need Twitch, should
follow a person across machines, and should work against share servers other
than the hosted Ballast cloud. Subscribing should need nothing but the link.

## Decisions (fixed by the user)

1. **The share server is the OpenID Connect client**, not the agent. The agent
   knows only a server URL and a small sign-in handoff; each server holds its
   own client registration (and could use another issuer).
2. **The cloud stays the front door** for `/api/shares/*`; `packages/shares-api`
   stays behind its service binding. A custom share server is another
   deployment of the cloud stack (or anything that speaks the same paths).
3. **Polling only.** The `share_update` relay push is removed; agents poll.
4. **Per-project servers.** A default server for new shares and bare share
   codes; every shared or subscribed project records its server; sessions are
   stored per server.
5. **Sign-in is for publishers only.** Subscribers never sign in: a share link
   (`{server}/s/{code}`) or code is the read capability.

## Design

### Publishing vs. reading

| Who | Credential | Routes |
| --- | --- | --- |
| Publisher (owner) | `blst_s_…` session from Sign in with Anomaly | `POST /api/shares`, `GET /api/shares/:id`, `POST /api/shares/:id/deploy-token`, `POST /api/shares/:id/deploys` |
| Subscriber | the share code only | `GET /api/shares/code/:code`, `GET /api/shares/code/:code/diff?from=&to=` |

Share-code reads are rate-limited per client IP (300 / 15 min); a share id
alone grants nothing. Codes are 12 characters from a 32-symbol alphabet
(60 random bits). The server records no subscribers
(`packages/shares-api/migrations/0003_anonymous_subscribers.sql`), so a
publisher cannot see who installed a share, and unsubscribing is local.

### Sign-in handoff (`@ballast/cloud-protocol` `SHARE_AUTH_*`)

1. The agent opens `GET {server}/api/shares/auth/login?redirect_uri=http://127.0.0.1:<port>/share-auth/callback&state&code_challenge&code_challenge_method=S256`.
   The server only accepts plain-http loopback redirects (RFC 8252).
2. The server runs the code flow with the issuer, then redirects the browser
   to the loopback URL with a one-time code (2 minutes) or `error`.
3. The agent's service receives the callback (the only unauthenticated route
   besides `/health`; the in-memory state and PKCE verifier protect it) and
   posts `{ code, codeVerifier, deviceName }` to `/api/shares/auth/token`,
   getting a `blst_s_…` bearer token and the user.

`/api/shares/auth/me` and `/logout` complete the set. Sessions expire after
90 days unused.

### Cloud as an Anomaly client (`apps/cloud/src/shares/{oidc,auth}.ts`)

- Issuer `ANOMALY_ISSUER` (default `https://account.anoma.ly`), discovered
  from `/.well-known/openid-configuration`.
- PAR when advertised, every client request signed with an ES256
  `private_key_jwt` assertion (`ANOMALY_CLIENT_KEY`), PKCE S256, a per-sign-in
  DPoP key (`dpop_jkt` at PAR, proofs at `/par` and `/token`, one
  `use_dpop_nonce` retry), ID token signature/issuer/audience/nonce validated.
- `scope=openid profile` with `claims={"id_token":{"preferred_username":{"essential":true},"name":null}}`.
  No UserInfo call; nothing is kept from the issuer except the identity.
- The user is `(iss, sub)` in `share_users`; name and username are display
  copies. Shares are owned by that user, so a new sign-in or a second
  machine can deploy the same shares.
- Client registration: first-party `ACCOUNT_CLIENTS` entry
  (`scripts/anomaly-client.mjs` prints it), or, with `ANOMALY_CLIENT_ID`
  unset, the server's own client ID metadata document at
  `/api/shares/auth/client.json`.
- In-flight sign-ins (`share_sign_ins`) are sealed with the cloud's token key;
  codes and session tokens are stored as peppered hashes.

### Agent (`apps/agent/src/service/share-servers.ts`)

- `<dataDir>/share-servers.json` (0600): optional default server and one session
  per server. The built-in default is `BALLAST_SHARE_SERVER` /
  `--share-server`, else the cloud URL. Tokens go over https only, except to
  loopback.
- RPCs `GetShareServers`, `BeginShareSignIn`, `SignOutShareServer`,
  `SetDefaultShareServer`; the `share-servers` service event reports changes
  and how a sign-in ended. A 401 drops the session.
- `ProjectShare` and `DeployProjectResult` carry `server`; a subscribed
  project also keeps its `shareCode`. `ShareProject` and `SubscribeProject`
  take an optional `server` (a share link carries its own). Publishing calls
  use the server's session; subscriber reads send no credentials.
- Updates: every 5 minutes, each subscribed project's server is asked for the
  share's current deploy by code; `ballast projects update` checks on demand.
- CLI `ballast shares status|login|logout|default`;
  `ballast projects subscribe <link|code>`; Settings → Sharing; the Share
  menu item prompts "Sign in to share". Subscribing has no sign-in step.

## Verification

- `apps/cloud/test/share-auth.test.ts` runs the real oauth4webapi client against
  a local issuer that enforces PAR, `private_key_jwt`, DPoP (with a nonce
  challenge), PKCE and ES256 ID tokens.
- End to end on `alchemy dev` (workerd, local D1) + the Artifacts simulator
  bridge + that issuer: a signed-in publisher shares and deploys; a service
  that never signed in subscribes by link and by code and applies an update,
  and is refused when it tries to publish; owner-only deploy, sign-out; and
  the Settings → Sharing sign-in from the web UI.
- Not yet run against `account.anoma.ly` / `account.dev.anoma.ly`: that needs
  the client registered in anomalyco/account.

## Consequences

- Shares made under 0013 (Twitch-user owners, machine subscriptions) are
  dropped: `packages/shares-api/migrations/0002_share_users.sql` recreates the
  tables and `0003` drops subscriptions. No production shares existed.
- Anyone holding a share link can read every deploy of that share; there is
  no revocation short of a new share (out of scope, as in 0013).
- Without a push, subscribers learn about deploys within ~5 minutes.
- Cloud pairing remains for Twitch and webhooks; sharing no longer uses it.
