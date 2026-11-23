# Twitch integration

`@ballast/module-twitch` (at `packages/integrations/twitch`) gives scripts
Twitch accounts, typed EventSub topics and typed Helix requests. The agent owns
the transport: the user's own Twitch app (local) or the Ballast cloud gateway.
The script API is identical in both modes.

```ts
import * as Ballast from "@ballast/core";
import * as OBS from "@ballast/module-obs";
import * as Twitch from "@ballast/module-twitch";
import { Effect } from "effect";

export default Effect.gen(function* () {
    const rewardTitle = yield* Ballast.Param.string("rewardTitle");
    const broadcaster = yield* Twitch.Account("broadcaster");
    const obs = yield* OBS.Connection("main");
    const scene = yield* Ballast.Param.string("scene", { options: OBS.scenes(obs) });

    yield* Twitch.ChannelPointsRedemption.subscribe(broadcaster, (event) =>
      Effect.gen(function* () {
        if (event.reward.title !== (yield* rewardTitle)) return;
        yield* obs.SetCurrentProgramScene({ sceneName: yield* scene });
});
  }),
);
```

## Script API

### `Twitch.Account(slot)`

Records a connection with `location: "either"` and returns a
`ConnectionRef<"twitch">` plus a typed Helix client factory:

```ts
const broadcaster = yield* Twitch.Account("broadcaster");
const sendChat = yield* broadcaster.helix("sendChatMessage");
yield* sendChat({
  broadcaster_id: "1337",
  sender_id: "1337",
  message: "hello",
});
```

Each `helix(name)` is a request capability. Init records
`{ integration: "twitch", slot, request: "helix/<name>", scopes }` in the
manifest, taking the scopes from the request definition. The client dies with
`RequestCalledDuringPlanError` if called during planning. Request names and
scopes are in `Twitch.Helix.requests`; `Twitch.Helix.helixRequests` is the
runtime executor table the agent uses.

### Topics

All eight topics in `Twitch.EventSub.topics` are script-facing objects built on
the core `Topic` primitive, so subscribing records the topic and its scopes:

| Export | EventSub type | Scope | Extra options |
| --- | --- | --- | --- |
| `ChannelPointsRedemption` | `channel.channel_points_custom_reward_redemption.add` | `channel:read:redemptions` | `{ rewardId?: string }` |
| `ChatMessage` | `channel.chat.message` | `user:read:chat` | `{ broadcaster?: ConnectionRef }` |
| `Follow` | `channel.follow` (v2) | `moderator:read:followers` | `{ broadcaster?: ConnectionRef }` |
| `Subscribe` | `channel.subscribe` | `channel:read:subscriptions` | |
| `Cheer` | `channel.cheer` | `bits:read` | |
| `Raid` | `channel.raid` | — | `{ direction?: "incoming" \| "outgoing" }` |
| `StreamOnline` | `stream.online` | — | |
| `StreamOffline` | `stream.offline` | — | |

`ChatMessage` subscribes on the account whose token reads chat. Pass
`{ broadcaster }` to read another channel (for example a bot reading the
streamer's chat):

```ts
const bot = yield* Twitch.Account("bot");
const broadcaster = yield* Twitch.Account("broadcaster");
yield* Twitch.ChatMessage.subscribe(bot, handler, { broadcaster });
```

`Follow` works the same way: the connection is the moderator, and
`{ broadcaster }` selects the channel. `Raid` defaults to incoming raids; pass
`{ direction: "outgoing" }` to see raids this channel starts.
`ChannelPointsRedemption`'s `rewardId` is a server-side filter; filtering by
title (as the example does) is still useful when the reward can be renamed.

### Manifest conditions

Twitch EventSub conditions need account ids, which planning does not have.
Topics therefore record a **condition template** in the manifest:

```json
{
  "topic": "twitch/channel.channel_points_custom_reward_redemption.add",
  "condition": { "broadcaster_user_id": { "slot": "broadcaster" } }
}
```

A string value is sent to Twitch as-is (for example `reward_id`). `{ slot }`
means "that connection's Twitch user id"; the agent resolves it after
`/oauth2/validate` (local) or `/api/tokens/twitch` (cloud). A slot referenced
this way must be declared with `Twitch.Account` and is included in the
connection set the agent prepares. The manifest topic key includes the
condition, so changing a filter resubscribes on the next apply.

## Local-app mode

The user registers their own Twitch application and the agent talks to Twitch
directly.

### 1. Authorize

```sh
ballast auth twitch broadcaster \
  --entry examples/redeem-to-scene.ts \
  --connection twitch/broadcaster=<client id> \
  --connection-secret twitch/broadcaster=<client secret>
```

- With a client secret, the command uses the authorization-code flow with a
  localhost callback. Register the exact redirect URI in the Twitch developer
  console. The stable default is
  `http://127.0.0.1:17345/callback`; pass `--callback-port <port>` or set
  `BALLAST_TWITCH_CALLBACK_PORT` to use another fixed port. Twitch requires an
  exact match. If the fixed port is busy, authorization fails with a clear
  "port is already in use" error instead of silently changing ports.
- Without a client secret (a public client), or with `--device`, it uses the
  device-code flow: open the printed URL and enter the code.
- `--entry` plans the script and requests the scopes of that slot's topics and
  requests. `--scopes a,b` requests scopes explicitly. With neither, it asks
  for `user:read:email`.
- `--no-open` prevents launching a browser (useful in tests).

The token file is `${BALLAST_DATA_DIR:-~/.local/share/ballast}/twitch/accounts/<slot>.json`
(`%LOCALAPPDATA%\ballast` on Windows). It holds the access token, refresh
token, expiry, granted scopes and the Twitch user id/login, written with mode
0600. **It is plain JSON for now.** Moving it to the OS keychain is planned;
until then, treat the data directory as a credential store. The client secret
is never written to this file.

### 2. Run

```sh
ballast run examples/redeem-to-scene.ts \
  --param rewardTitle=Hydrate --param scene="Scene 2" \
  --connection obs/main=ws://127.0.0.1:4455 \
  --twitch-mode local
```

The client id comes from the token file if it was stored by `ballast auth`;
otherwise pass `--connection twitch/broadcaster=<client id>` or set
`BALLAST_TWITCH_CLIENT_ID`. The client secret is needed only to refresh a
confidential app: pass it with `--connection-secret` or
`BALLAST_TWITCH_CLIENT_SECRET`.

The agent refreshes the access token when it is within 60 seconds of expiry,
opens `wss://eventsub.wss.twitch.tv/ws`, creates one EventSub subscription per
manifest topic bound to the WebSocket session, and re-creates them after a
reconnect. Helix calls go straight to `https://api.twitch.tv/helix`.

### Scope checks

Before opening a connection the agent compares the manifest's scopes for the
slot with the stored token's scopes. When scopes are missing:

- with a TTY, `ballast run` offers to re-authorize in place;
- otherwise it exits with the missing scope list and the
  `ballast auth twitch <slot>` command to run.

### Local configuration

| Setting | Flag / environment |
| --- | --- |
| Client id | `--connection twitch/<slot>=<id>`, `BALLAST_TWITCH_<SLOT>_CLIENT_ID`, `BALLAST_TWITCH_CLIENT_ID`, token file |
| Client secret | `--connection-secret twitch/<slot>=<secret>`, `BALLAST_TWITCH_<SLOT>_CLIENT_SECRET`, `BALLAST_TWITCH_CLIENT_SECRET` |
| Mode | `--twitch-mode local`, `BALLAST_TWITCH_MODE`, `BALLAST_TWITCH_<SLOT>_MODE` |
| Data dir | `BALLAST_DATA_DIR` |
| Callback port | `--callback-port`, `BALLAST_TWITCH_CALLBACK_PORT` (default 17345) |
| OAuth endpoints | `BALLAST_TWITCH_AUTHORIZATION_URL`, `BALLAST_TWITCH_TOKEN_URL`, `BALLAST_TWITCH_VALIDATE_URL`, `BALLAST_TWITCH_DEVICE_URL`, `BALLAST_TWITCH_REVOKE_URL` |
| Helix base | `BALLAST_TWITCH_HELIX_URL` |
| EventSub WebSocket | `BALLAST_TWITCH_EVENTSUB_URL` |

The endpoint overrides exist for mocks and tests; production uses Twitch's
defaults.

## Cloud mode

The cloud holds Ballast's Twitch app credentials and the refresh tokens; the
machine gets short-lived access tokens and relayed events.

```sh
ballast pair <pairing code> --cloud https://cloud.example.com
ballast run examples/redeem-to-scene.ts \
  --param rewardTitle=Hydrate --param scene="Scene 2" \
  --twitch-mode cloud
```

Pairing stores the machine id and token in `cloud.json` under the data
directory (plain JSON with mode 0600, like the local Twitch token; both move to
the keychain later). The agent then:

- lists connections with `GET /api/connections`;
- takes tokens from `POST /api/tokens/twitch`;
- reconciles the manifest's topics with
  `POST /api/twitch/subscriptions/reconcile`;
- calls Helix through `POST /api/twitch/helix` (no Twitch keys on the machine);
- connects one relay WebSocket per machine (`/relay/<machineId>`), publishes
  events to the bus, acknowledges them, and reconnects with backoff after a
  drop. Buffered events replay until acknowledged. `subscription_revoked`
  triggers a reconcile for the affected connection.

### Binding a slot

One Twitch login usually has one connection, which the agent picks
automatically. With several, bind explicitly:

```sh
ballast run ... --twitch-mode cloud \
  --connection twitch/broadcaster=streamer_login
```

The value can be a cloud connection id or a login. The binding is saved in
`cloud.json`. `BALLAST_TWITCH_<SLOT>_CONNECTION` also works.

### Mode selection

Twitch manifests use `location: "either"`. `auto` (the default) uses the cloud
when the machine is paired and local otherwise. `--twitch-mode local|cloud`
forces one mode globally; `--twitch-mode twitch/broadcaster=local` forces one
slot. Forcing cloud without a pairing is an error; forcing local never uses the
cloud.

### Missing scopes in cloud mode

`POST /api/tokens/twitch` reports the connection's scopes, and the Helix proxy
checks requested scopes itself. If either is missing a manifest scope the
agent reports `missing_scopes` and lists what to grant; reconnect the account
in Ballast with the new scopes. There is no local re-auth path in cloud mode.

### Multiple running scripts

The cloud reconcile request accepts an optional opaque `owner` id. Provider
subscriptions are shared: the cloud subscribes to the union of all owners and
only deletes one when no owner still wants it. Freshness policies merge
conservatively (`drop` if any owner wants drop, shortest `maxAgeMs`).

The agent does **not send an owner yet**, so every reconcile uses the legacy
`"default"` owner. Two scripts running at once against the same Twitch
connection therefore still overwrite each other. Follow-up: pass a stable
project/script id as `owner` from `startCloudTwitchTransport`'s reconcile.

### Cloud cross-slot conditions

The cloud now follows the same `self` / `target` condition rules as local mode.
A bot connection may read the broadcaster's chat
(`{ broadcaster_user_id: broadcaster, user_id: bot }`) and a moderator
connection may watch another channel's follows
(`{ broadcaster_user_id: streamer, moderator_user_id: moderator }`). Fields
whose token Twitch authorizes (`user_id`, `moderator_user_id`, broadcaster
fields on single-account topics) must still match the bound connection.

## Demos and tests

Local demo with a mock OBS and mock Twitch (no network):

```sh
node --experimental-strip-types apps/agent/scripts/twitch-local-mock.ts
# copy the printed run command, then:
curl "http://127.0.0.1:<port>/demo/redeem?title=Hydrate"
```

Cloud demo with a mock OBS and mock cloud (pairing, reconcile, relay):

```sh
node --experimental-strip-types apps/agent/scripts/twitch-cloud-mock.ts
# copy the printed pair and run commands, then:
curl "http://127.0.0.1:<port>/demo/redeem?title=Hydrate"
```

Automated coverage:

- `packages/integrations/twitch/test/plan.test.ts` — the redeem-to-scene
  manifest and a Helix request's scopes.
- `apps/agent/test/twitch-e2e.test.ts` — local mode with a mock Twitch
  (OAuth validate, EventSub WebSocket and Helix) and mock OBS; cloud mode with
  pairing, reconcile, relay delivery, ack, and reconnect/replay after a
  dropped socket; the device-code auth command; and missing-scopes failures in
  both modes.
- `apps/agent/test/topic-types.test.ts` — a Twitch topic only accepts a Twitch
  connection.
