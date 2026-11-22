# Ballast: plan

*Ballast is a working name. A standalone app, separate from MacroGraph. This plan covers the integrations and the scripting engine. Graphs are out of scope; artifacts, distribution and the desktop shell are later phases.*

## 1. What it is

A desktop agent that runs **Effect scripts** on a streamer's machine, plus a **cloud** that handles everything a desktop can't: OAuth, webhooks, EventSub and relaying events. Integrations give scripts one typed way to work with every service: **events in, requests out**.

Scripts are written with **Alchemy and Effect**. A script's *init* only declares what it needs, so the agent can **evaluate the script in plan mode** without running it. That produces a manifest of:

- the event topics it subscribes to
- the requests it may make
- the credentials and OAuth scopes it needs
- the local connections it uses (OBS, VTube Studio…)
- the parameters a user can set

The agent uses that manifest to set up cloud subscriptions, ask for missing scopes, connect local services, and only then run the script.

## 2. Scope

| Now | Later | Not doing |
|---|---|---|
| Desktop agent (Node + Effect, background service + browser UI) | Rune + CEF desktop shell | Graphs |
| Script SDK, plan/apply, script host | HTML artifacts and dashboards | Marketplace |
| Integration SDK + first integrations | Publish/pull distribution | Offline edit reconciliation |
| Cloud: accounts, token vault, event ingress, relay | Remote collaborative editing via cloud | |
| Collaborative local editor, event inspector | Multiple machines per user | |
| MCP so agents can write, plan and run scripts | | |

## 3. Concepts

| Concept | Meaning |
|---|---|
| **Project** | A folder of scripts plus settings on one machine. That machine has the only live copy. |
| **Script** | A TS file exporting `Ballast.Script(...)`. Init declares; handlers act. |
| **Integration** | A package (`@ballast/twitch`, `@ballast/obs`) defining topics, requests, credential type, location, plan-time providers and runtime clients. |
| **Connection** | A configured instance of an integration, such as a linked Twitch account or an OBS at `localhost:4455`. Scripts refer to **connection slots** by name (`"broadcaster"`, `"bot"`, `"main"`), and the user binds each slot to a connection. |
| **Topic** | A typed event stream (`twitch/channel.cheer`, `obs/CurrentProgramSceneChanged`). |
| **Request** | A typed call (`twitch/chat.sendMessage`, `obs/SetCurrentProgramScene`). |
| **Param** | A user-editable value a script declares (string, number, enum, a list of OBS scenes…). |
| **State** | A small typed key-value store per project, persisted locally. Artifacts will use it later. |
| **Manifest** | The output of planning a script: everything listed above that the script needs. |
| **Location** | Where an integration runs: `local` (agent), `cloud` (ingress plus relay), or `either`. |

## 4. Scripts

### 4.1 Shape

```ts
import * as Ballast from "@ballast/core";
import * as Twitch from "@ballast/twitch";
import * as OBS from "@ballast/obs";
import { Effect } from "effect";

export default Ballast.Script(
  "redeem-to-scene",
  Effect.gen(function* () {
    // Params: captured into the manifest at plan time, read from settings at runtime
    const rewardTitle = yield* Ballast.Param.string("rewardTitle", { title: "Reward title" });
    const scene = yield* Ballast.Param.string("scene", { title: "Scene", options: OBS.scenes("main") });

    // Connection slots: credential and location requirements
    const broadcaster = yield* Twitch.Account("broadcaster");
    const obs = yield* OBS.Connection("main");

    // Request capability: recorded in the manifest, returns a typed client
    const setScene = yield* OBS.SetCurrentProgramScene(obs);

    // Topic subscription: adds topic + scope (channel:read:redemptions) to the manifest
    yield* Twitch.onChannelPointsRedemption(broadcaster, (event) =>
      Effect.gen(function* () {
        if (event.reward.title !== (yield* rewardTitle)) return;
        yield* setScene({ sceneName: yield* scene });
      }),
    );
  }),
);
```

Rules:

- **Init declares, handlers act.** Init has no `Scope` and no I/O; Alchemy already types it that way. Anything with side effects belongs in a handler or `Ballast.run(...)` (a long-running loop, like Alchemy's `ServerHost.run`).
- Param values are **lazy** (`Effect`s or Alchemy `Output`s), so plan mode never needs real values. A topic can depend on a param (for example "subscribe to the channel named in this param"); planning records it as unresolved and apply resolves it.
- Imports are limited to `effect`, `@ballast/*` and relative files at first. npm dependencies come later through bundling.

### 4.2 Plan, apply, run

```
 save ─► plan (isolated eval, phase=plan) ─► manifest ─► diff against applied state
                                                           │
            ┌──────────────────────────────────────────────┤
            ▼                                              ▼
   no new permissions                         new scopes / new connection slots
   → apply automatically                      → ask the user (connect account, bind slot)
            │                                              │
            └───────────────► apply ◄──────────────────────┘
                               │  · cloud: create/remove topic subscriptions for this machine
                               │  · agent: open/close local connections
                               │  · settings UI: add/remove params
                               ▼
                 run (worker, phase=runtime) ─► hot-swap: old script scope closes, new one starts
```

- **Plan** runs the script's init with Alchemy's plan phase in a throwaway worker. Integration bindings write requirements into the plan context instead of acting (the same approach as `GitHub.RepositoryEventSourceLive`, which provisions a webhook at plan time and only routes requests at runtime).
- **Apply** turns the manifest diff into actions. Applied state is stored per project in local SQLite, which is Alchemy's state store implemented for the agent.
- **Run** bundles the script with `__ALCHEMY_RUNTIME__ = true` so plan-only code is removed, then starts it in a worker. The host provides the runtime services: event delivery, request clients, params, state and logs.

### 4.3 How Ballast maps onto Alchemy

| Alchemy | Ballast |
|---|---|
| `Stack` | Project |
| `Platform` (e.g. `Cloudflare.Worker`) | `Ballast.Script`: a custom platform whose host is a worker in the agent |
| `WebhookHost` (host-provided service) | `EventHost`: routes topic deliveries from the agent bus to handlers |
| Binding `Service` (`R2.ReadWrite(bucket)`) | Request capabilities (`OBS.SetCurrentProgramScene(obs)`) |
| Event source (`consumeRepositoryEvents`) | Topic subscriptions (`Twitch.onChannelPointsRedemption`) |
| Provider/Resource (e.g. GitHub `Webhook`) | `TopicSubscription` resource, created through the Ballast cloud API |
| `Config` captured into env (`RuntimeContext.set`) | `Ballast.Param`, captured into the manifest |
| State store | Agent SQLite |

**Deciding how deep to go:** use Alchemy's `Platform`, `Binding`, `Output` and the plan/apply engine directly; don't reimplement them. Wrap them behind `@ballast/core` so script authors never import `alchemy` directly. That limits the impact of churn while Alchemy is in alpha (MacroGraph pins `2.0.0-beta.84`). Phase 0 checks this works; see §9.

## 5. Integrations

### 5.1 What an integration package contains

```
@ballast/twitch
├── catalog.ts     topics + requests as Effect Schemas (exported as JSON Schema for UI, MCP and agents)
├── credential.ts  OAuth provider, scopes per topic/request, account slot types
├── plan.ts        bindings: record requirements, define TopicSubscription resources (Alchemy providers)
├── runtime.ts     clients: request implementations, event decoding
├── cloud.ts       ingress: webhook/EventSub/polling handlers that run in the Ballast cloud
└── local.ts       (local integrations) connection driver run by the agent
```

The catalog is the single source of truth. It produces:

- the typed script SDK
- the settings UI for params with dynamic options (`OBS.scenes("main")` asks the live connection for its scenes)
- the MCP tool descriptions agents read
- the event inspector's decoders

### 5.2 Integration kinds

| Kind | Examples | Events | Requests |
|---|---|---|---|
| **Local socket** | OBS, VTube Studio, Streamer.bot, Voicemod, GoXLR, MIDI | Agent holds the connection | Agent calls directly |
| **Cloud push** | Twitch EventSub, YouTube (polling), Kick webhooks | Cloud ingress → relay → agent | Agent calls the API directly with a short-lived token from the vault |
| **Cloud webhook (manual setup)** | Ko-fi, Streamlabs, StreamElements | User pastes a per-connection URL that Ballast generates | As above |
| **Request-only** | OpenAI, ElevenLabs, Discord REST, HTTP | — | Agent calls directly |

Twitch's EventSub over WebSocket can also run on the agent with no cloud involved. It's useful as a fallback or for testing, but cloud webhooks (or a conduit) are the default for reliability and to receive events while the PC restarts.

### 5.3 Port from MacroGraph, don't depend on it

`macrograph/packages/modules/*` (twitch, obs, vtube-studio, kofi, streamlabs, goxlr, voicemod, speakerbot, streamdeck, elevenlabs, openai, discord…) is the reference for protocol details and edge cases. Port each one into the new integration package format; don't import from MacroGraph.

First set, in order: **OBS → Twitch → VTube Studio → Ko-fi → Streamlabs → Discord → OpenAI/ElevenLabs**.

## 6. Architecture

```
┌──────────────────────────── Desktop agent (Node, Effect) ─────────────────────────────┐
│ Project store   files on disk + SQLite (settings, state, applied manifests, logs)     │
│ Planner         Alchemy plan in an isolated worker → manifest → diff → apply          │
│ Script host     one worker per script; Effect runtime; scoped hot reload             │
│ Event bus       topics from local drivers + cloud relay → script handlers             │
│ Connections     local drivers (OBS ws, VTS ws, MIDI…), health, reconnect             │
│ Token cache     short-lived access tokens from the cloud vault                       │
│ Cloud link      single outbound WebSocket (RPC): events in, subscriptions, tokens    │
│ Local API       HTTP + WS: editor, inspector, settings; MCP for agents               │
│ Editor server   collaborative text editing (server-ordered), TS diagnostics          │
└───────────────────────────────────────┬───────────────────────────────────────────────┘
                                        │ outbound wss
┌───────────────────────────────────────▼──── Cloud (Cloudflare, deployed with Alchemy) ┐
│ Accounts + machine pairing (device code)                                              │
│ OAuth broker + token vault (refresh tokens never leave the cloud)                     │
│ Ingress Worker: webhooks/EventSub/polling, verify signatures, normalize to envelopes │
│ Subscription manager: creates/removes provider subscriptions based on manifests      │
│ Relay: one Durable Object per machine; buffer, ack, replay                           │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.1 Event envelope and delivery

```ts
{ id, integration, topic, connectionId, occurredAt, receivedAt, payload }
```

- At-least-once from cloud to agent: the relay keeps events until the agent acknowledges them, and the agent drops duplicates by `id`.
- **Freshness:** streaming events go stale quickly. Each topic subscription sets `onStale: "drop" | "deliver"` and `maxAge` (default: drop after 60 s). The relay keeps events at most 24 h for the inspector and replay.
- Order is kept per `(connection, topic)`.
- Any event in the inspector can be **replayed** into a script, which is the main way to test.

### 6.2 Credentials

- The OAuth flow runs in the cloud, and refresh tokens stay in the vault. The agent gets short-lived access tokens on demand and caches them in memory.
- The manifest's scopes are compared with what each connection has been granted. Missing scopes trigger a reconnect prompt that lists what's needed and which script needs it.
- Local connections (OBS password and so on) are stored in the agent's OS keychain.

### 6.3 Script isolation

- v1: one `worker_threads` worker per script, with resource limits; it talks to the host only through the Effect RPC the host provides. Scripts can technically reach Node APIs; that's acceptable for user-written scripts on the user's own machine.
- Before distributing scripts written by others, harden: disable Node built-ins in the bundle, consider `workerd` or isolates, and require permission prompts based on the manifest.

## 7. Editor and agents

- Browser UI served by the agent: file tree, CodeMirror editor, params form, connection status, event inspector, logs, and the plan diff.
- **Collaboration:** the agent orders all edits (`@codemirror/collab`-style operational transforms with presence). Nothing is edited offline, so there's nothing to merge. Remote collaborators come later through the cloud relay.
- **Types:** the agent runs a TS language service against the project plus generated `@ballast/*` types and streams diagnostics. Plan runs on save, so manifest changes show up as you type.
- **MCP:** tools to list the integration catalog, read/write scripts, plan (returns manifest + diff), apply, run, tail logs, and replay events. With these, an agent can write and test a script end to end.

## 8. Repository layout

```
ballast/
├── apps/
│   ├── agent/          desktop agent (Node, Effect); `ballast` CLI + background service
│   ├── cloud/          Cloudflare Workers + Durable Objects (alchemy.run.ts)
│   ├── web/            editor/inspector UI (served by agent)
│   └── desktop/        Rune + CEF shell (later)
├── packages/
│   ├── core/           @ballast/core: Script platform, Param, State, EventHost, envelope
│   ├── planner/        plan/apply over Alchemy; manifest + diff
│   ├── protocol/       agent ↔ cloud RPC schemas, MCP schemas
│   ├── integration/    integration SDK (catalog helpers, TopicSubscription, drivers)
│   └── integrations/   twitch, obs, vtube-studio, kofi, streamlabs, discord, openai, …
└── examples/           sample scripts used as tests
```

## 9. Phases

### Phase 0: Alchemy spike (1–2 weeks)
Prove scripts work as Alchemy programs outside a cloud deploy.
- `Ballast.Script` as a custom Alchemy `Platform` hosted in a Node worker.
- Plan one script in isolation (no Stack-wide deploy) with an in-memory state store; extract the manifest.
- A fake integration with one topic and one request; runtime bundle with `__ALCHEMY_RUNTIME__`.
- **Exit:** `ballast plan examples/fake.ts` prints a manifest; `ballast run` delivers fake events to the handler, and hot reload replaces it cleanly.
- **Fallback if Alchemy doesn't fit:** keep the same script shape and write a small declaration recorder in `@ballast/core` (a plan-mode layer that records bindings). Scripts barely change.

### Phase 1: Local agent and OBS (2–3 weeks)
- Agent service, project store, script host, logs, params from a settings file.
- `@ballast/obs` and `@ballast/vtube-studio` local drivers; integration SDK v1; catalog → types.
- **Exit:** a script that switches OBS scenes when a VTube Studio hotkey fires runs, reloads on save and logs to the CLI.

### Phase 2: Cloud and Twitch (3–4 weeks)
- Accounts, machine pairing, OAuth vault, cloud link, relay Durable Object with ack and freshness rules.
- Twitch EventSub ingress + subscription manager driven by applied manifests; scope diff → reconnect prompt.
- **Exit:** a channel point redemption on a real channel changes the OBS scene. It survives an agent restart, and stale events are dropped as configured.

### Phase 3: Editor and inspector (3 weeks)
- Web UI: collaborative editor, diagnostics, params form, plan diff, connections, event inspector + replay.
- **Exit:** two browser tabs edit the same script live; the plan diff shows a new scope before apply.

### Phase 4: More integrations + MCP (ongoing)
- Ko-fi, Streamlabs, Discord, OpenAI, ElevenLabs, Streamer.bot.
- MCP server.
- **Exit:** an agent writes a working script from a description, using only MCP.

### Later
Publish/pull distribution → remote collaborative editing through the relay → HTML artifacts bound to state/actions → Rune + CEF desktop shell (check `browser-pane` on Windows first) → multiple machines → sandbox hardening.

## 10. Risks and open questions

1. **Alchemy coupling.** Alpha, frequent changes, and built for deploying cloud infrastructure, not for running scripts on a desktop. Mitigation: hide it behind `@ballast/core`, pin the version, and keep the fallback from Phase 0.
2. **Keeping init pure.** Scripts that do I/O in init break planning. Types help (init has no `Scope`); also add a lint rule and fail planning on any real I/O (plan-mode layers die if a request client is called).
3. **Params that affect topics.** These need `Output` resolution at apply. Keep this rare and documented.
4. **Twitch EventSub limits.** Check subscription cost limits for user-authorized webhooks versus conduits before choosing the cloud design.
5. **Windows.** Most streamers use Windows; CI and manual testing need to cover it from Phase 1.
6. **Name.** "Ballast" is a working name.
