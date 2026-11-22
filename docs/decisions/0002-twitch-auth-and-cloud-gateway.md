# 0002 — Twitch auth modes and the cloud gateway

*Status: accepted for Phase 2 · 2026-11-22 · effect `4.0.6`, alchemy `2.0.0-beta.84`,
`@alchemy.run/cloudflare` `2.0.0-beta.84`*

## Context

`docs/PLAN.md` §5.2 says Twitch events can arrive either through the cloud (EventSub
webhooks, relayed to the agent) or locally (EventSub over WebSocket, no cloud). The product
direction adds a second axis: the user may run their **own Twitch application** instead of
using Ballast's.

That gives two supported account modes plus one deprioritised one:

| Mode | Twitch app | Tokens | Events | Helix calls |
|---|---|---|---|---|
| **Own app (local)** | The user registers a Twitch app and pastes (or the agent captures) its client id/secret | Refresh token stored locally (OS keychain later) | EventSub over WebSocket from the agent | Agent calls Helix directly |
| **Cloud (gateway)** | Ballast's Twitch app; users never see its keys | Refresh token in the cloud vault; agent gets short-lived access tokens | EventSub webhooks to the cloud, relayed over the machine's WebSocket | Cloud proxies Helix with scope checks |
| *Paste an existing token* | — | Bearer token pasted by the user | Same as local | Same as local | *Deprioritised; no design work here.* |

The script-facing API must not change between modes. A script declares
`Twitch.Account("broadcaster")`, topics and request capabilities; the agent chooses the
transport for that connection.

The cloud follows MacroGraph's **gateway** shape: it holds app credentials and user tokens,
normalises provider events into envelopes, and lets each machine subscribe to a stream. Unlike
MacroGraph, the first Ballast cloud is deliberately smaller: one Worker, one D1 database, one
relay Durable Object per machine.

## Decision

### 1. Two auth modes, one script API

The integration package exposes the same script bindings in both modes:

```ts
const broadcaster = yield* Twitch.Account("broadcaster");
yield* Twitch.onChannelPointsRedemption(broadcaster, handler);
const send = yield* Twitch.SendChatMessage(broadcaster);
```

The agent resolves the **connection slot** (`"broadcaster"`) to a connection and a
**transport** per account:

```ts
// packages/integrations/twitch/src/transport.ts (agent-side contract; sketch)
interface TwitchTransport {
  readonly mode: "local-app" | "cloud";

  /** A short-lived Helix token. Local mode refreshes from the keychain; cloud mode asks the vault. */
  getToken(): Effect.Effect<{ accessToken: string; expiresAt: number; scopes: string[] }, TwitchError>;

  /** One typed event stream per subscription the manifest declared. */
  subscribe(spec: TwitchSubscriptionSpec): Stream.Stream<EventEnvelope, TwitchError>;

  /** A typed Helix request. Local mode calls Twitch directly; cloud mode proxies. */
  request(call: HelixRequest): Effect.Effect<HelixResponse, TwitchError>;
}
```

Two implementations:

- **Local-app transport.** OAuth 2.0 authorization-code flow with a `http://localhost:<port>`
  redirect (or device-code flow for public clients). The refresh token stays on the machine
  (OS keychain later, an encrypted local file in the first cut). The agent refreshes access
  tokens in memory, opens EventSub over `wss://eventsub.wss.twitch.tv/ws`, and calls Helix
  directly. No Ballast cloud is involved. This is the fallback and the development path.
- **Cloud transport.** The agent calls the cloud for short-lived tokens, connects to the
  machine relay for events, and posts typed Helix calls to the proxy. Twitch app credentials
  exist only in the cloud. This is the default for production because the cloud receives
  events while the PC is off or restarting.

Both transports emit the same `EventEnvelope` (`id`, `integration`, `topic`,
`connectionId`, `occurredAt`, `receivedAt`, `payload`, `onStale`, `maxAgeMs`), so the
event host does not know where an event came from. In local mode a *transport-local* adapter
assigns event ids from the EventSub message id and fills `receivedAt` itself; it does not
buffer, because there is no relay. The `onStale`/`maxAgeMs` values still ride along so the
agent's event bus applies the same freshness policy.

**Mode selection is per connection, not global.** The agent picks cloud if the account is
paired to the cloud and the user has not forced local; otherwise it uses the local app. A
connection stores its chosen mode so a script restart does not flip transports. Local mode
must work with the cloud unreachable (that is its point).

### 2. What `location` means for Twitch

Twitch is **`either`** in the manifest:

```ts
{ integration: "twitch", slot: "broadcaster", location: "either" }
```

The integration declares `either` because both implementations are valid and the choice is a
user/agent policy, not a script requirement. The agent still records the topics and scopes the
script needs; apply checks them against whichever connection is bound. If the bound connection
is cloud, the cloud subscription manager reconciles the topics. If it is local, the agent
opens the WebSocket and creates subscriptions itself. A script that requires cloud-only
reliability can add a future `location: "cloud"` integration option, but Twitch does not.

The manifest diff only prompts for a new connection when the slot has no account yet, or when
the chosen transport cannot satisfy the requested scopes. Switching an already-bound
connection between modes is an explicit user action, not a silent apply step.

### 3. Cloud architecture

One Worker (`apps/cloud/src/worker.ts`) is both the OAuth/webhook front door and the agent
API. It is deployed by Alchemy from `apps/cloud/alchemy.run.ts` as an **Effect-native
Worker** — there is no `main` path in the stack:

```ts
class BallastCloudWorker extends Cloudflare.Worker<BallastCloudWorker, {}, Relay>()(...)

BallastCloudWorker.make(props, Effect.gen(function* () {
  const config = yield* loadCloudConfig;                 // Config values become env bindings
  const db = yield* Cloudflare.D1.QueryDatabase(BallastDatabase);
  const relay = yield* Relay;                            // namespace for the per-machine DO
  return { fetch: Effect.gen(function* () { ... }) };
}).pipe(Effect.provide(RelayLive), Effect.provide(Cloudflare.D1.QueryDatabaseBinding)))
```

Init acquires D1, the Relay namespace and the Config secrets; handlers are Effects. The Relay
DO is a `Cloudflare.DurableObject` class whose `RelayLive` implementation uses
`DurableObjectState.storage`, `Cloudflare.upgrade` and hibernatable WebSocket handlers.
`makeCloudApp` still takes its D1/DO clients as injected services, so the whole vertical
slice is exercised in Node tests without workerd, while the same code runs in the Worker.

#### Routes

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness |
| `GET /oauth/twitch/start?scopes=…` | none | Create a D1 OAuth state, redirect to Twitch |
| `GET /oauth/twitch/callback?code&state` | state | Exchange code, upsert user + account, show a pairing code (HTML or JSON) |
| `POST /webhooks/twitch/eventsub/:connectionId` | Twitch HMAC + timestamp | Challenge, notifications, revocation |
| `POST /api/pairing/claim` | pairing code | Machine id + machine token |
| `GET /api/connections` | machine token | Connections for the machine's user |
| `POST /api/tokens/twitch` | machine token | Short-lived Helix access token (refreshes if needed) |
| `POST /api/twitch/helix` | machine token | Scope-checked Helix proxy |
| `POST /api/twitch/subscriptions/reconcile` | machine token | Applied manifest → Twitch EventSub subscriptions |
| `GET /relay/:machineId` (WebSocket) | machine token | Relay stream |

Machine auth is `Authorization: Bearer blst_m_…`. Tokens are random 32-byte values; D1 stores
only `sha256(pepper + token)`, so a database leak does not yield usable machine tokens.

#### OAuth and token vault

`/oauth/twitch/start` stores `{ state, scopes, redirectUri, expiresAt (10 min) }` in D1 and
redirects to Twitch's authorize URL with `force_verify=true`. `/oauth/twitch/callback`
atomically consumes the state, exchanges the code at `id.twitch.tv/oauth2/token`, reads the
user from Helix, upserts a `users` row (id = Twitch user id) and a `twitch_accounts` row,
then issues an 8-character pairing code (15 min, single use).

The callback page shows the pairing code. The agent has no user session and no browser
integration in this slice; the code is how the agent gets a machine identity. Pairing-code
login is still a stub in UX terms, but attempts and code creation are now rate-limited:
10 claims per client IP and 5 codes per Twitch user per 15 minutes, stored as fixed-window
counters in D1 (`rate_limits`). A production flow should still replace the retyped code with
a device-code-like flow or a signed `ballast://` redirect.

**Token storage: D1 with application-level AES-256-GCM encryption.** The vault stores the
refresh token, the cached access token and its expiry, and the EventSub webhook secret as
`{ ciphertext, iv }` values (base64url), encrypted with `BALLAST_TOKEN_KEY` (32 bytes, Worker
secret). Plaintext never reaches D1, logs or the agent. Access tokens are handed to the agent
only when the agent asks for each connection; refresh tokens never leave the cloud.

Why D1 rather than KV or a DO:

- **KV is eventually consistent.** A webhook can arrive immediately after an account links;
  the ingress must see the account and webhook secret now. Global replication also makes
  “delete the token” race with reads.
- **A DO per account is a fine design** (it serialises refreshes and gives a natural place
  for token state), but OAuth callbacks, pairing, subscription reconciliation and webhook
  lookup all need cross-account queries. Starting with one relational store avoids N DOs and
  a routing layer before there is load.
- **D1 gives relational constraints** (unique `(user, twitch_user)`, `provider_subscription_id`,
  message-id dedupe) and cheap list queries for the connection UI. At this scale the write
  volume is tiny; the relay DO handles the hot path.
- The trade-off is D1's single-writer latency for token refresh and reconcile. Both are rare.
  If refresh contention appears, move just the account token state into a per-account DO while
  keeping the relational rows in D1.

Encryption at the application layer is deliberate: Cloudflare encrypts D1 at rest, but not
against a leaked Worker token, a mis-scoped D1 binding, or an exported backup. Key rotation is
an open question (see §8).

#### EventSub ingress

There is **one webhook URL per Twitch connection**:
`https://<cloud>/webhooks/twitch/eventsub/<connectionId>`, with a random webhook secret stored
(sealed) on the account. All subscriptions for that account share the URL and secret, as
MacroGraph does; this keeps the callback stable across reconciles and gives one secret to
rotate. The response routing key is the provider `subscription.id`, not the URL.

For every POST:

1. Require `Twitch-Eventsub-Message-Id`, `…-Timestamp`, `…-Signature`, `…-Type`.
2. Reject a timestamp more than 10 minutes from now.
3. Verify `HMAC-SHA256(secret, message_id + timestamp + raw_body)` using WebCrypto and the raw
   bytes exactly as received. (Do not re-serialise JSON.)
4. Decode the delivery and validate the condition against the subscription registry's
   `self`/`target` fields (see “Cross-account conditions” below).
5. `webhook_callback_verification`: return the challenge as `text/plain` 200.
6. `notification`: dedupe by message id, find the subscription row by provider id, build the
   envelope, and enqueue it on the machine's relay. Return 204.
7. `revocation`: read the reason from `subscription.status`. For
   `notification_failures_exceeded` the gateway deletes the dead provider subscription and
   creates it again with the stored condition and webhook secret (no agent round trip). For
   `authorization_revoked` / `user_removed` it marks the account `needs_reauth`, marks the row
   `revoked` with the reason, and notifies the relay; every other reason marks the row and
   notifies, leaving recovery to the next reconcile. Return 204.
8. Anything else: 400.

Dedupe is two-layered:

- **D1 `webhook_deliveries(message_id PRIMARY KEY)`** suppresses Twitch retries before they
  reach the relay. It is written only after a successful enqueue, so a failed enqueue can be
  retried.
- **Relay event id** (`twitch:<message_id>`) suppresses duplicates that slip through concurrent
  requests or a replay.

The relay is the source of truth for machine delivery; D1 stores only the dedupe marker and
the retention/pruning metadata.

#### Subscription management: per-user webhooks for now

The cloud maintains EventSub subscriptions with an **app access token**
(`client_credentials`) from Ballast's Twitch app. The agent posts the applied manifest's
desired subscriptions and an opaque **owner id** (project/script id; older clients omit it and
reconcile as `"default"`). The cloud:

1. Validates conditions against the module registry and computes cost from the same registry
   metadata (unknown types fall back to Twitch's published table: cost 1 unless documented
   otherwise, e.g. `channel.update`/moderation/hype-train cost 2).
2. Compares the **union** of this owner's desired subscriptions and every other owner's
   existing subscriptions against the per-connection budget, default **10** (Twitch's
   user-authorization EventSub cost limit), configurable with
   `BALLAST_TWITCH_MAX_SUBSCRIPTION_COST`.
3. Lists the app's webhook subscriptions and deletes one only when no owner still wants its
   `(type, version, condition)` key. Creates missing subscriptions with the connection callback
   and secret, and shares one provider subscription between owners.
4. Stores one `event_subscription_owners(subscription_id, owner, on_stale, max_age_ms)` row per
   owner. When freshness policies differ, the shared row uses the conservative merge:
   `onStale: "drop"` if any owner asks for drop, and the shortest `maxAgeMs`.
5. Returns the union rows (with their `owners`) plus `totalCost`/`maxCost` so the settings UI
   can explain a refusal.

#### Cross-account conditions

Twitch authorizes EventSub from the connection's own user token, but some subscription types
read another channel. The module registry tags each condition field:

- **self** — must equal the connection's Twitch user id, because that user's token is the one
  Twitch authorizes (`channel.chat.message.user_id`, `channel.follow.moderator_user_id`, the
  broadcaster fields for redemptions/cheers/subscriptions/stream status, both raid directions).
- **target** — may be another channel or a linked Twitch account
  (`channel.chat.message.broadcaster_user_id`, `channel.follow.broadcaster_user_id`). Twitch
  itself enforces read/moderator permission; the cloud only requires the target to be linked to
  the same Ballast user where the type is not documented as readable for any channel.
- **any** — an opaque filter such as `reward_id`.

This lets a bot connection read the streamer's chat
(`{ broadcaster_user_id: streamer, user_id: bot }`) or a moderator connection watch another
channel's follows, while keeping the token-bound `user_id`/`moderator_user_id` honest. Webhook
ingress applies the same rule before relaying, using the linked accounts of the connection's
Ballast user.

**Decision: per-user webhooks, not conduits, for now.** A single streamer's scripts use a
handful of topics; the 10-cost budget is enough for the common set (chat, redemptions,
follows, subs), and per-user webhooks match MacroGraph's proven ingress design. Conduits
would add a Twitch-side shard lifecycle, shard allocation, a second subscription namespace and
webhook-to-conduit migration, with no benefit until one app serves enough concurrent users to
hit per-user limits or needs Twitch-managed horizontal scale. Revisit when: a typical
connection approaches the cost budget, per-user subscription count becomes an operational
problem, or we need shards for throughput. The ingress is already routing by provider
subscription id, so adding a conduit transport later is a subscription-manager change, not an
envelope/relay change.

The exact published cost budget and count limits must be rechecked against Twitch's current
docs before launch; they are the main external assumption in this section.

#### Relay Durable Object

One `Relay` DO per machine (`getByName(machineId)`). It is the only place events are buffered.

- The agent connects to `/relay/:machineId` with its machine token. The Worker authenticates
  the token, checks that the machine id matches, and forwards the upgrade to the DO. The DO
  namespace is not publicly routable, so the DO trusts the Worker's check.
- The relay assigns a monotonically increasing `seq` per machine. The agent acks `seq` values.
- On connect the DO sends `hello` with the pending count, then every unacked, non-dropped
  event in seq order. A reconnect replaces the previous socket but keeps the buffer.
- Ordering is per machine (therefore per `(connection, topic)`), guaranteed by the single DO
  and seq assignment.
- The buffer keeps at most 24 h and 1,000 events. When full, the oldest events are evicted;
  the inspector retention limit is the same 24 h.
- **Freshness:** each event carries `onStale` and `maxAgeMs` from the manifest (defaults
  `drop`, 60 s). On delivery, when `now - receivedAt > maxAgeMs`:
  - `drop`: mark the event dropped and do not send it; it stays visible to the inspector until
    retention.
  - `deliver`: send it once with `stale: true`, then leave it unacked until the agent acks.
  Fresh events are sent with `stale: false`.
- Acked events stay until retention so the inspector can read them; they are never replayed.
- Revocations are sent as a control message (`subscription_revoked`), not buffered. If no
  agent is connected the notification is dropped; the next reconcile fixes the state. A future
  version can buffer control messages too.

#### Helix proxy

`POST /api/twitch/helix` accepts `{ connectionId, method, path, query?, body?, scopes }`.

- Machine auth, then the account must belong to the machine's user.
- `path` must start with `/helix/`.
- `scopes` must be a subset of the scopes stored for the connection. Twitch also enforces
  scopes at the API, but this check turns a confusing 401/403 into a typed `missing_scopes`
  error the agent can map to a reconnect prompt. It also prevents a caller from using a token
  for a capability the manifest never declared.
- The cloud decrypts the cached access token; if it expires within 60 s it refreshes and
  re-seals first. A 401 from Twitch triggers one forced refresh and retry.
- Refreshes take a per-account lease in D1 (`refresh_lock` + `refresh_lock_until`, 30 s).
  A competing request waits up to 2 s for the holder and then returns a retryable
  `upstream_error`, so Twitch's rotating refresh token is not spent twice. Secrets are only
  committed by the current lease holder; a stale holder cannot overwrite a newer token.
- The response is `{ status, body, refreshed }`; status is passed through, so callers see
  Twitch's error body and can decide whether to retry.
- There is no general-purpose URL proxy: only `/helix/` paths reach Twitch.

### 4. Identity and pairing (minimal viable)

- **User:** Twitch login. Our user id is the Twitch user id; the row stores login, display
  name and email. No password, no Ballast-specific session yet.
- **Machine:** `POST /api/pairing/claim { code, machineName }` consumes the pairing code and
  returns `{ machineId, machineToken, user }`. The token is a bearer secret for the API and
  relay; only its hash is stored. The agent should put it in the OS keychain later; the current
  slice keeps it in the project/agent store.
- **Ownership:** every account belongs to a user; every machine belongs to a user. API calls
  may only use connections owned by the machine's user.
- **Account → machine:** `reconcile` sets `twitch_accounts.machine_id` to the calling machine.
  Provider subscriptions are shared across owners; each owner link keeps its own freshness
  policy and only disappears when that owner stops asking for the subscription.
  With one machine per user this is unambiguous; multiple machines per user is deliberately
  not solved here. The relay target is stored on each subscription, so events still route even
  if the account field is later reassigned.

Stubbed for now: expiring machine tokens, token revocation, multiple machines per user, and a
browser session/cookie for account management. Pairing claims and code creation are
rate-limited in D1 (see the pairing section).

### 5. Wire protocol

`packages/cloud-protocol` (`@ballast/cloud-protocol`) is the shared contract. It contains:

- `EventEnvelope`, `RelayServerMessage`, `RelayClientMessage` (typed JSON WS frames).
- Twitch connection/token/Helix/subscription schemas and the standard error body.
- `CloudRpcs` (`ClaimPairing`, `GetToken`, `CallHelix`, `ReconcileSubscriptions`,
  `ListConnections`) and `RelayRpcs` (`SubscribeToRelay` as a streaming RPC, `AckRelayEvents`)
  as Effect `RpcGroup`s.

The MVP serves the request/response operations as **JSON over HTTP** and the relay as a
**framed JSON WebSocket**. The RPC groups are the transport-independent definitions the agent
will generate a typed client from. When the cloud link becomes one long-lived connection, the
same handlers can be exposed with `RpcServer.layerProtocolWebsocket`/`layerProtocolHttp` and
consumed with `RpcClient`; `SubscribeToRelay`'s `stream: true` success schema matches the
current server-push behaviour. We did not force Effect RPC through the Worker/DO boundary in
this slice because OAuth redirects and Twitch webhooks are inherently plain HTTP, and the DO
WebSocket needs a Cloudflare-specific upgrade adapter; the shared schemas keep both transports
compatible.

### 6. Security notes

- No Twitch keys on the machine in cloud mode; no refresh tokens outside the cloud.
- Local mode stores the local app's refresh token on the machine; this is the user's own
  credential and must move to the OS keychain before release.
- Machine tokens are random, hashed at rest, and compared by hash lookup. The pepper is a
  required Worker secret with no dev default, so a deployment cannot silently share one.
- Pairing claims and code creation are rate-limited in D1 per client IP and per user.
- Webhook HMAC uses the raw body, timestamp tolerance, and a per-connection secret.
- D1 rows hold only AES-GCM ciphertext for tokens and webhook secrets; the key is a Worker
  secret.
- The Helix proxy enforces connection ownership and declared scopes; it cannot be used as an
  open proxy.
- No secrets are committed; `apps/cloud/.env.example` contains placeholders only.

### 7. What the agent-side Twitch module plugs into

The agent module (`@ballast/twitch` or `packages/integrations/twitch`) owns both transports
and needs only the following from the cloud:

| Need | Contract |
|---|---|
| Pair a machine | `POST /api/pairing/claim { code, machineName }` → `{ machineId, machineToken, user }`; store the token (keychain later) |
| List connections | `GET /api/connections` (machine bearer) |
| Short-lived Helix token | `POST /api/tokens/twitch { connectionId }` → `{ accessToken, expiresAt, scopes, twitchUserId, login }`; cache until `expiresAt - 60s` |
| Helix request | `POST /api/twitch/helix` with `{ connectionId, method, path, query?, body?, scopes }`; surface `missing_scopes` as a reconnect prompt |
| Apply subscriptions | `POST /api/twitch/subscriptions/reconcile { connectionId, owner?, subscriptions }`; call on apply/manifest diff and after a `subscription_revoked` message. `owner` defaults to `"default"` for older clients. |
| Events | `wss://<cloud>/relay/<machineId>` with `Authorization: Bearer <machineToken>`; read `hello`, `event`, `subscription_revoked`; ack `{ _tag: "ack", seqs }` |

The transport wrapper is then thin:

```ts
cloudTransport.subscribe(spec) =
  relayEvents.filter((event) => event.envelope.topic === twitchTopic(spec.type));
cloudTransport.request(call) = cloud.helix({ connectionId, ...call, scopes: call.scopes });
cloudTransport.getToken() = cloud.token({ connectionId }); // local mode: refresh from keychain
```

For local mode the same wrapper talks to `id.twitch.tv` and `api.twitch.tv` directly and opens
`wss://eventsub.wss.twitch.tv/ws`; it does not call the cloud. The script-facing
`Twitch.Account` / `on…` / request bindings must be identical.

The agent should also handle the cloud's typed errors: `unauthorized` (re-pair),
`missing_scopes` (reconnect with scopes), `cost_limit_exceeded` (reduce topics / explain),
`upstream_error` (retry/backoff), and relay disconnect (reconnect and replay unacked events).

### 8. Open questions

1. **Exact EventSub limits.** Confirm the current per-user webhook cost budget (assumed 10),
   subscription count limit (assumed 300) and the cost-2 table. If the budget differs, the
   default and UI copy must change.
2. **Key management.** `BALLAST_TOKEN_KEY` is a static Worker secret. Rotation needs a key id
   or a re-encryption migration; a KMS/Secrets Store-backed key may be preferable before
   production.
3. **Pairing UX and abuse.** Pairing codes are bearer-ish secrets shown in a browser. Fixed-
   window limits and a required pepper are in place; the remaining work is UX (signed deep
   link or device-code flow so the code never has to be retyped) and distributed-attack
   controls (for example a Cloudflare rate-limiting rule in front of the Worker).
4. **Multiple machines per user.** Decide whether a connection can fan out to several relays,
   or whether each machine needs its own Twitch authorization. The current schema stores one
   `machine_id` on the account.
5. **Conduits.** Revisit if per-user webhooks hit cost/count limits or a single app needs
   sharded throughput. The relay and envelope do not need to change.
6. **Revocation recovery.** Resolved for the known recoverable reason: only
   `notification_failures_exceeded` triggers an automatic resubscribe, so a permanent
   revocation (missing scope, user removed) cannot loop. Other reasons notify and wait for the
   next reconcile or the user.
7. **Token refresh concurrency.** Resolved with a D1 lease plus a conditional secrets write;
   see the Helix proxy section. If refresh volume ever justifies it, moving the lease into a
   per-account DO is a mechanical change.
8. **Local mode details.** Localhost redirect registration rules for user apps, device-code
   support for public clients, keychain storage, EventSub reconnect/resubscribe on the agent.
9. **Inspector/replay API.** The relay keeps 24 h of events but no endpoint exposes them yet.
   Add a machine-authenticated history query when the inspector lands.
10. **Effect RPC transport.** When the cloud link is unified, decide whether the relay uses a
    streaming RPC over the same connection or stays a separate WebSocket.

## Implementation in this slice

| Piece | State |
|---|---|
| OAuth start/callback, state, token exchange | **Real**, via `@ballast/module-twitch`'s OAuth client, exercised with a fake Twitch token/Helix API in tests |
| Token vault (AES-GCM in D1) | **Real**; unit tests use the in-memory store, and `alchemy dev` exercised the D1 SQL end to end |
| Webhook HMAC, timestamp, challenge, dedupe, revocation | **Real**, using the module's webhook verifier/message schemas; unit + integration tested with real WebCrypto |
| Subscription reconciliation + cost limit | **Real**, with the module's registry validating known conditions/scopes and supplying per-type cost; cross-account and multi-owner reconciliation tested against a fake Twitch API |
| Helix proxy + scope checks + refresh-on-401 | **Real**, tested with a fake Helix; refresh is serialised by a D1 lease |
| Machine pairing + token hashing | **Implemented**, with per-IP/per-user rate limits; pairing UX remains a documented stub |
| Relay DO buffer/WS/ack | **Real DO class**, exercised locally through `alchemy dev`/workerd with a real WebSocket client and local D1 |
| Effect RPC client/server | **Schemas defined**; HTTP/JSON and WS/JSON served in this slice |
| Conduits, key rotation, multi-machine | **Not implemented** |

### Verification

- `pnpm --filter @ballast/cloud test`: 27 tests, including a Node HTTP server + real
  `ws` client that receives a signed EventSub notification through the relay (webhook →
  HMAC → dedupe → buffer → WebSocket), rate limits, both revocation paths, the refresh lease,
  cross-account chat/follow conditions, and multi-owner reconcile.
- `pnpm --filter @ballast/cloud-protocol test`: 5 schema tests.
- `pnpm --filter @ballast/module-twitch test`: 39 tests, including client credentials, raw
  Helix status/body preservation, the payload-agnostic webhook decoder, and registry
  cost/condition metadata.
- **`alchemy dev` end-to-end, fully local:** the stack selects `Alchemy.localState()` in dev, so
  it never boots `Cloudflare.state()` or authenticates to Cloudflare. D1 migrations and the
  Worker + Relay DO run under workerd. With a fake Twitch HTTP server on `:4010`, the demo ran
  OAuth, pairing, reconcile, an offline signed notification and a live one:

  ```
  oauth start: 302 http://127.0.0.1:4010/oauth2/authorize
  oauth callback: 200 {"userId":"12345",...,"pairingCode":"THCNX39E",...}
  pairing claim: 200 m_9Md7i-zqW5zdpl3TieJmAOjZ
  reconcile: 200 cost 1 provider sub-local-1
  offline webhook: 204
  relay -> hello
  relay -> event redemption-offline
  relay -> event redemption-online
  online webhook: 204
  RESULT {"hello":{"_tag":"hello","pending":1},"eventIds":["redemption-offline","redemption-online"],"bufferedStale":[false,false]}
  ```

  This exercises the real D1 vault rows, HMAC ingress, subscription row lookup, DO storage and
  WebSocket ack path. It uses dummy local Twitch credentials and a fake provider only, with
  Cloudflare credentials unset and a throwaway `HOME` so no profile could be read.
- The local dev run uses `Alchemy.localState()` (`.alchemy/state`) and local workerd storage
  (`.alchemy/local`), based on the local providers in `alchemy/src/State/LocalState.ts`,
  `@alchemy.run/cloudflare/src/Workers/LocalWorkerProvider.ts` and
  `@alchemy.run/cloudflare/src/D1/Database.ts`. `wrangler dev` is no longer used, and
  `wrangler.toml` was deleted so bindings cannot drift from `alchemy.run.ts`.

## Files

- `apps/cloud/` — `alchemy.run.ts`, `src/{cloud-worker,worker,resources,app,config,secrets,store,d1-store,twitch-api,http,errors}.ts`,
  `src/relay/{state,buffer,gateway,relay-do}.ts`, `migrations/{0001_init,0002_hardening,0003_subscription_owners}.sql`,
  tests, `scripts/local-demo.mjs` for the local `alchemy dev` loop. Protocol knowledge lives in
  `@ballast/module-twitch` (`packages/integrations/twitch`), not in `apps/cloud`.
- `packages/cloud-protocol/` — `src/{events,http,rpc,index}.ts`, tests.
- Root `pnpm-workspace.yaml` catalog: `@alchemy.run/cloudflare`, `@cloudflare/workers-types`.
- Root `tsconfig.json` references: `packages/cloud-protocol`, `apps/cloud`.
