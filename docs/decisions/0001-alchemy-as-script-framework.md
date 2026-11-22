# 0001 — Alchemy as the script framework

*Status: accepted for Phase 0 · 2026-11-22 · alchemy `2.0.0-beta.84`, effect `4.0.6`*

> **Superseded by [0004](0004-drop-alchemy-from-script-runtime.md).** The script
> runtime no longer depends on Alchemy; the host model described here was replaced
> by Ballast's own plan/runtime layers. The investigation and measurements below
> are kept as the record behind that decision.

## Context

Decision D3 in `docs/HANDOFF.md` says scripts are written with Alchemy and Effect, because running a
script's init in **plan** mode reveals the topics, credentials/scopes, connections and params before it
runs. `docs/PLAN.md` §4.3 proposes going further: use Alchemy's `Platform`, `Binding`, `Output` and the
plan/apply engine directly, and hide it behind `@ballast/core`.

Phase 0 Step 2 exists to test that assumption before any of `@ballast/core` is written. The questions are:

1. How does `Platform` build a host resource, and can a third party define `Ballast.Script` with its own
   `RuntimeContext` and `hostServices`?
2. Can the plan for **one** platform resource run without a full `Stack` deploy, with an in-memory or
   SQLite state store and only Ballast's providers?
3. What does plan need from providers, and can a `TopicSubscription` provider be a stub at first?
4. What does the runtime bundle need besides `ALCHEMY_DEFINE`? Can the agent bundle a script itself
   (rolldown/esbuild) and run its init with `ALCHEMY_PHASE=runtime`?
5. How do `Output`s that cannot be resolved at plan time (params that affect topics) appear in a plan?

## Method

Two sources, used in this order:

- **Installed beta.84**, which is what Ballast pins: `ALCHEMY` below. Line citations are against this tree.
- **The `alchemy-effect` clone** (`~/github.com/alchemy-run/alchemy-effect`): a `git pull --ff-only`
  was attempted and aborted (uncommitted local changes), so it is still at `f17fab02`, **2026-06-26**.
  It is materially older
  than beta.84: it has no `Runtime/Process.ts`, no `WebhookHost.ts`, and no
  `RuntimeContext.hostServices` at all. It is only used to confirm the direction of travel, never for
  citations.

Paths used below:

```
ALCHEMY = ~/github.com/brendonovich/cf-effect-experiment/node_modules/.pnpm/
          alchemy@2.0.0-beta.84_@effect+platform-node@4.0.6_effect@4.0.6_redis@6.3.0_
          @opentelemet_ed8288e908b515e7e2b95509be9306ff/node_modules/alchemy/src
CF      = .../@alchemy.run/cloudflare@2.0.0-beta.84_patch_hash=.../node_modules/@alchemy.run/cloudflare/src
GH      = ~/github.com/brendonovich/cf-effect-experiment/apps/cloud/node_modules/@alchemy.run/github/src
```

Claims marked **[verified]** were exercised by a throwaway program under
`/private/var/folders/…/T/opencode/ballast-exp`; commands and outputs are in the appendix. Everything else
is **[source]**.

## Summary

| Question | Answer |
|---|---|
| Custom host type | **Yes.** `Platform(type, { createRuntimeContext })` is a public factory over `Resource`; `hostServices` (present in beta.84; absent from the June clone) is exactly the hook `Ballast.Script` needs. A host runs with only `Stack`, `Stage` and `Scope` — no provider, no state, no deploy. **[verified]** |
| One-resource plan | **Yes.** `Plan.make(stackSpec)` requires only `State` in its effect type (provider services come from the built Stack context), and `Alchemy.inMemoryState()` is built in. A SQLite store is not shipped, but `StateService` is a small interface. **[verified]** for in-memory. |
| Provider needs at plan | A new resource needs **nothing** from its provider: no `diff`, no `read`, no `precreate`. An existing resource is diffed (the provider's `diff` if present, otherwise the engine's `havePropsChanged`). A creating resource with resolved props calls `read` **if defined**, which is a network landmine. A `TopicSubscription` provider can be a stub with `reconcile` + `delete` only. **[verified]** |
| Runtime bundle | Only `globalThis.__ALCHEMY_RUNTIME__` is defined by Alchemy; the agent must also set `ALCHEMY_PHASE=runtime`, provide `Stack`/`Stage`/`Scope`, and run the exported platform Effect (or `makeEntrypointLayer`). No providers or state are needed. Rolldown with `define` + `minify: "dce-only"` works. **[verified]** |
| Unresolved Outputs | They stay as **live expression objects** in `plan.resources[fqn].props`/`bindings`; `describePlan` and JSON drop them; providers see `isResolved(news) === false`; `Apply` re-evaluates the props against upstream outputs right before `reconcile`. There is **no** unresolved marker in the `Plan` type, so Ballast must record unresolved entries itself. **[verified]** |

**Decision: hybrid.** Use Alchemy's **host model** (`Platform`, `RuntimeContext`, `hostServices`,
`Output`, `Phase`), but **not** its `Stack`/`Plan`/`Apply`/`Provider` lifecycle engine in Phase 0.
The manifest is recorded by Ballast's own recorder (injected as a plan-only service), and apply is a
set diff over that manifest stored in SQLite. This keeps the script-facing API from `docs/PLAN.md`
while avoiding a 200 KB infrastructure engine whose main output (a resource plan) is not the manifest
and whose plan-time I/O has to be carefully avoided.

---

## 1. How `Platform` builds a host resource — and can Ballast define one?

**[source]** `Platform` is a thin factory over `Resource`:

```ts
// ALCHEMY/Platform.ts:247
export const Platform = <R extends ResourceLike<string, …>>(
  type: R["Type"],
  hooks: {
    createRuntimeContext: (id: string) => BaseRuntimeContext;
    onCreate?: (resource: R, props: any) => Effect.Effect<void, never, any>;
    transformProps?: (id: string, props: any) => Effect.Effect<any, any, any>;
    aliases?: string[];
  },
  methods?: { [key: string]: any },
) => { … }

// ALCHEMY/Platform.ts:295
const resource = Resource(type, {
  aliases: hooks.aliases,
  requiresImplementation: true,
});
```

It supports three call forms: a tagged class (`Script<Self>()("id")` + `.make(props, impl)`), a class
with props, and the inline `Script("id", props, impl)` used by the script examples. All three funnel into
`makeClass(id).make(props, impl)`, which builds one `Layer`:

```ts
// ALCHEMY/Platform.ts:437-479 (abridged)
static make = (props, impl) => {
  const SelfLayer = Layer.effect(Self, Effect.flatMap(Effect.all([
    /* resolved props */,
    Effect.sync(() => hooks.createRuntimeContext(id)),   // line 452
    Effect.context<never>(),
  ]), Effect.fn(function* ([props, runtimeContext, outerServices]) {
    const buildScope = yield* Effect.scope;              // line 467
    const instance = Object.assign(
      yield* resource(id, props).pipe(                      // line 469 — registers on the Stack
        Effect.flatMap((r) => hooks.onCreate?.(r, props) ?? Effect.succeed(r))),
      runtimeContext,
    );
    yield* impl.pipe(/* init */);
    instance.Props = { ...props, env: { ...props?.env, ...runtimeContext.env }, … }; // line 593
    return Object.assign(instance, { RuntimeContext: runtimeContext });
  })));
  return Layer.provideMerge(/* Self + Self<type> tags */, SelfLayer);
}
```

Inside the init region it provides (in order): a **Config interceptor**, the host's **`hostServices`**,
a fixed `Scope`, the platform instance, `RuntimeContext`, `Self`, and — in plan phase only —
`planServices`:

```ts
// ALCHEMY/Platform.ts:512-535 — Config: capture at plan, read back at runtime
const phase = yield* ALCHEMY_PHASE;
return ConfigProvider.make(Effect.fnUntraced(function* (path) {
  const key = sanitizeKey(path.map((p) => p.toString()).join("_"));
  if (phase === "plan" && node) {
    yield* ctx?.set(key, Output.literal(Redacted.make(node.value))) ?? Effect.void;
    return node;
  } else if (phase === "runtime" && ctx) {
    const value = yield* ctx.get(key);
    if (value) return ConfigProvider.makeValue(…);
  }
  return node;
}));

// ALCHEMY/Platform.ts:543-560
(runtimeContext.hostServices ?? Layer.empty).pipe(
  Layer.provideMerge(Layer.mergeAll(
    Layer.succeed(Scope, buildScope),
    Layer.succeed(Platform.Platform, runtimeContext),
    Layer.succeed(RuntimeContext, runtimeContext),
    …,
    Layer.succeed(Self, instance),
    // line 575: planServices exists only while planning
    runtimeContext.planServices
      ? Layer.unwrap(ALCHEMY_PHASE.pipe(Effect.map((p) =>
          p === "plan" ? runtimeContext.planServices! : Layer.empty)))
      : Layer.empty,
  )),
)
```

`BaseRuntimeContext` is deliberately small and leaves exactly the hooks a host needs:

```ts
// ALCHEMY/RuntimeContext.ts:10-40
export interface BaseRuntimeContext {
  Type: string;
  id: string;
  env: Record<string, any>;
  get<T>(key: string): Effect.Effect<T | undefined>;
  set(id: string, output: Output): Effect.Effect<string>;
  exports?: Effect.Effect<Record<string, any>>;
  makeCallback?: CallbackFactory;
  serve?(handler, options?): Effect.Effect<void, never, Req>;
  shape?(): Record<string, unknown>;
  /** additional services to provide to the plan  */
  planServices?: Layer.Layer<any>;
  /** Services the host provides its init in every phase … */
  hostServices?: Layer.Layer<any, never, any>;
  telemetry?: Layer.Layer<never, any, any>;
}
```

**Yes, a third party can define a new host type.** Two shipping examples do exactly this:

- Cloudflare Worker: `Platform(WorkerTypeId, { onCreate, createRuntimeContext: makeWorkerRuntimeContext })`
  (`CF/Workers/Worker.ts:2740-2746`), with `hostServices: WebhookHostLive` and plan-only services
  (`CF/Workers/WorkerRuntimeContext.ts:80-86`). That is the closest existing analogue of `EventHost`.
- `AWS.ECS.Task` uses `createHostRuntimeContext("AWS.ECS.Task")` (`ALCHEMY/Runtime/Process.ts:64`) — a
  host context with `run`, `serve`, `get` from `process.env`, `set` into a captured env map, and
  `exports.program`. The Alchemy
  docs describe this as the supported "Custom Runtime" shape.

`GitHub.RepositoryEventSourceLive` is the template for a Ballast topic subscription: plan-only
provisioning behind the runtime guard, a deploy-time binding read back at runtime, then routing:

```ts
// GH/RepositoryEventSourceLive.ts:67-92 (abridged)
if (!globalThis.__ALCHEMY_RUNTIME__) {
  yield* Namespace.push(ctx.LogicalId, Effect.asVoid(createWebhook(…)));   // plan provisions
}
const secret = yield* Output.named(Output.asOutput(webhookSecret), envName); // bind for runtime
yield* ctx.route(path, (request) => handleDelivery(request, secret, process)); // runtime routes
```

Ballast's version replaces the webhook with a `TopicSubscription` in the Ballast cloud and the HTTP
route with an `EventHost.subscribe` registration on the agent bus.

`Binding.Service` (`ALCHEMY/Binding.ts:98`) is the other half of the host model: a context tag that is
also callable (`Echo(connection)`), with the client implemented by a Layer and `Binding.Host`
(`Binding.ts:277`) resolving the host resource only at deploy time. It is the right shape for request
capabilities, but its `host.bind` wiring assumes a deploy-time host with env/IAM; Ballast's request
clients are runtime RPC, so a small local `Capability` helper with the same tag+callable shape is
enough, and `Binding.execute` (a plan-time data-source invoke) is not needed.

**[verified]** A minimal `Platform("Ballast.Script", …)` with a custom context, `hostServices` providing
`EventHost` and `Params`, and an inline init ran under only
`Layer.succeed(Stack, {name, stage, resources: {}, bindings: {}, actions: {}})` + `Layer.succeed(Stage, …)`
+ `Effect.scoped`. No provider, no state store, no `Plan`:

```
INSTANCE Ballast.Script tick-echo SEEN ["fake/tick"]
```

Two consequences matter for Ballast:

- **The provider is a typing/deploy concern, not a runtime requirement.** `Platform`'s
  `Resource["Providers"]` requirement is phantom at runtime; the bundled effect ran with no provider
  layer at all.
- **`hostServices` is built inside the init `Effect.provide`, so its scoped resources close when init
  returns.** This is the same `Effect.provide` (`scopedWith`) whose transient scope the comment at
  `Platform.ts:456-466` warns about. **[verified]**: a `Layer.effect(Service, Effect.acquireRelease(…))`
  in `hostServices` logged `acquire, init, release` *before* the `yield*` of the platform returned, in
  both plan and runtime mode. `hostServices` is therefore for **registrations and stateless clients**
  — exactly what `WebhookHostLive` does (it pushes a listener into the host context's array). Long-lived
  connections belong to the worker bootstrap or the ambient context around `Script(...)`, not to
  `hostServices`.

For the sketch, the platform's `Services` type parameter must name the host services so init can require
them without the caller providing a layer:

```ts
export const Script: Platform<
  ScriptResource,
  EventHost | Params | RequestHost,       // what hostServices provides to init
  {},
  ScriptRuntimeContext
> = Platform("Ballast.Script", { createRuntimeContext: makeScriptRuntimeContext });
```

(This exact shape type-checks against beta.84.)

---

## 2. Planning one platform resource without a full `Stack` deploy

**[source]** The minimal path is not the CLI. It is:

```ts
// ALCHEMY/Stack.ts:267-320
export const make = (options: { name, providers, state }) => (effect) =>
  // dies if options.state is missing (line 275)
  // dies if options.providers is missing (line 288)
  options.providers.pipe(
    Layer.provideMerge(options.state),
    Layer.provideMerge(stackConfigLayer(options.secrets)),
    Layer.provideMerge(Layer.effect(Stack, Stage.pipe(…))),
    Layer.buildWithScope(scope),                     // line 317
  ).pipe(Effect.flatMap((context) => effect.pipe(Effect.provideContext(context), …)));

// ALCHEMY/Plan.ts:365-376 — the only effect requirement of a plan is State
// (provider services are carried by the Stack's built context)
export function make<A>(stack: StackSpec<A>, options?): Effect.Effect<Plan<…>, never, State>;

// ALCHEMY/Apply.ts:153-172 — apply additionally needs Stack + Stage
export const apply = (plan, options?): Effect.Effect<…, …, State | Stack | Stage>;
```

`Stack.make` builds the providers/state layer into the ambient scope, so the caller runs it under
`Effect.scoped` (the test harness does). `State` is built in for tests and one-off runs:

```ts
// ALCHEMY/State/InMemoryState.ts:12-19
export const inMemoryState = (initialState = {}, initialOutputs = {}) =>
  Layer.effect(State, Effect.cached(InMemoryService(initialState, initialOutputs) …));
```

There is **no SQLite store in the box**. `localState()` is JSON files under `.alchemy/state`
(`ALCHEMY/State/LocalState.ts:35-60`), and Postgres lives in a separate package. `StateService`
(`ALCHEMY/State/State.ts:44-115`) is a small interface — `get`/`set`/`delete`/`list` per
`(stack, stage, fqn)`, plus `getOutput`/`setOutput` — so a SQLite layer is a straightforward adapter.
For Phase 0, `inMemoryState()` is enough.

**[verified]** A stack containing exactly one `Ballast.Script` platform resource — whose init declared
two child resources (`ParamStore`, `TopicSubscription`), the normal Ballast shape — with stub providers
and `Alchemy.inMemoryState()`, produced a plan and applied it without any cloud or CLI:

```
PLAN {"resources":[
  {"fqn":"tick-echo","resourceType":"Ballast.Script","action":"create"},
  {"fqn":"params","resourceType":"Ballast.ParamStore","action":"create"},
  {"fqn":"tick-sub","resourceType":"Ballast.TopicSubscription","action":"create"}]}
AFTER_PLAN {"diff":0,"reconcile":0,"read":0}
AFTER_APPLY {"diff":0,"reconcile":1}
RECONCILE_INPUTS [{"topic":"from-apply","scopes":["fake:read"]}]
```

A filtered plan/apply is also supported: `Plan.make(compiled, { include: ["tick-sub"] })` selected the
subscription *and its upstream* (`params`) and applied only those.

So the answer to "without a full Stack deploy" is **yes**, with two caveats:

- A `StackSpec` value is still required — `Stack` is the declaration container that `Resource()` writes
  into (`ALCHEMY/Resource.ts:357`), even if it has one resource. In our hybrid this is literally
  `Layer.succeed(Stack, { name, stage, resources: {}, bindings: {}, actions: {} })`; no deploy happens.
- `Stack.make` insists on both a providers layer and a state layer, even when the providers contain
  only stubs. (`Plan.make` itself only needs `State`; if you hand-build a `StackSpec` and provide the
  provider services yourself, you can skip `Stack.make`. The test harness uses the convenient path —
  `ALCHEMY/Test/Core.ts`, `scratchStack.buildPlan`: `makeStack({ name, providers, state }) → Plan.make
  → apply`.)

---

## 3. What plan needs from providers; can `TopicSubscription` be a stub?

**[source]** `ProviderService` (`ALCHEMY/Provider.ts:93-360`):

| Method | Required? | Called at plan? |
|---|---|---|
| `reconcile` (create *and* update) | yes | **no** — apply only |
| `delete` | yes | no — apply/destroy only |
| `diff` | optional | **yes**, once per resource that has persisted state |
| `read` | optional | **yes**, for adoption of a new resource with resolved props, and for an interrupted create |
| `precreate` | optional | no — apply only, inside dependency cycles |
| `list` | optional | no — drift/nuke only |

The `diff` signature is explicitly a plan-time API that receives unresolved inputs:

```ts
// ALCHEMY/Provider.ts:276-288
diff?(input: {
  …
  olds: Props<Res>;
  // Note: we do not resolve (Res["Props"]) here because diff runs during plan
  // -> we need a way for the diff handlers to work with Outputs
  news: Input<Props<Res>>;
  …
}): Effect.Effect<Diff | void, any, DiffReq>;
```

`read` is the landmine:

```ts
// ALCHEMY/Plan.ts:1391
if (oldState === undefined && provider.read && isResolved(news) && !reusesMigratedFqn) {
  const readResult = yield* provider.read({ … });   // ← real I/O during plan
```

**[verified]** With a provider that defines `read` delegating to a counter:

- `ParamStore` (props fully resolved, no state): `read` called **once** during the first plan.
- `TopicSubscription` (topic still an unresolved Output): `read` **not** called.
- A new resource (no prior state): `diff` called **zero** times; `reconcile` zero times.
- Second plan after apply: `diff` called **once** (only the resource that defines it), `reconcile`
  still zero.

A **stub `TopicSubscription` provider is therefore fine**, and is plan-silent:

```ts
const TopicSubscriptionProvider = Provider.succeed(TopicSubscription, {
  // no read, no diff
  reconcile: ({ news }) => Effect.succeed({ subscriptionId: "stub" }),
  delete: () => Effect.void,
});
```

Plan yields `create` (or `noop`/`update` from the engine's `havePropsChanged` fallback), and apply calls
`reconcile` once. Later, `reconcile` can call the Ballast cloud API and `delete` can remove the
subscription; add `diff` for drift. Keep `read` out (or behind an explicit drift/adopt mode) so
planning stays network-free.

Caveat: `diff` returning `undefined` does not mean "no action". It means "use the engine's default",
which is `havePropsChanged(oldProps, news)`; and `havePropsChanged` returns `true` whenever `news`
contains any `Output` (`ALCHEMY/Diff.ts:176-181`, `Output.hasOutputs`). An existing resource whose props
are unresolved therefore falls back to `update` (unless the provider explicitly returns
`{ action: "noop" }`).

---

## 4. What the runtime bundle needs besides `ALCHEMY_DEFINE`

**[source]** There is exactly one Alchemy define:

```ts
// ALCHEMY/Bundle/Bundle.ts:163-165
const ALCHEMY_DEFINE: Record<string, string> = {
  "globalThis.__ALCHEMY_RUNTIME__": "true",
};
```

and it is paired with a DCE default, because a define only folds the condition; it does not remove the
branch by itself:

```ts
// ALCHEMY/Bundle/Bundle.ts:206-213
/**
 * Default `minify` to "dce-only" … so the `if (false) { … }` branches … are physically removed
 */
const withDceDefault = (outputOptions) => ({
  ...outputOptions,
  minify: outputOptions?.minify ?? "dce-only",
});
```

`ALCHEMY_PHASE` is separate: it is a runtime `Config` read, defaulting to `"plan"`
(`ALCHEMY/Phase.ts:32-40`). It drives the Config interceptor in §1. **If the agent does not set
`ALCHEMY_PHASE=runtime`, init's `Config` reads take the plan-capture branch (writing into `props.env`)
instead of reading the bound env back through `ctx.get`.** Set it in the worker bootstrap.

A bundled script needs:

1. the define `globalThis.__ALCHEMY_RUNTIME__=true` + DCE (rolldown or esbuild);
2. `ALCHEMY_PHASE=runtime` in the worker environment;
3. `Stack` and `Stage` services — `stackConstant(name, stage)` or `stackFromEnv`
   (`ALCHEMY/Runtime/Bootstrap.ts:64-75`), because `Resource()` registers into `StackContext`;
4. a `Scope` — the runtime branch of `provideClassLayer` builds the platform layer on the ambient
   scope (`ALCHEMY/Platform.ts:67-85`);
5. the host services module and the runtime transport services (`EventBus`, `Settings`, …), which the
   worker bootstrap provides around the entrypoint;
6. an entrypoint: either export the `Script(...)` Effect and `yield*` it, or use
   `makeEntrypointLayer` (`ALCHEMY/Runtime.ts:29`) / `entrypointLayer`
   (`ALCHEMY/Runtime/Bootstrap.ts:48`) to turn the export into a `Layer` for `Self`.

It does **not** need providers, a state store, or `ALCHEMY_STACK_NAME`/`ALCHEMY_STAGE` if using
`stackConstant`.

**[verified]** Bundled a script with plain rolldown (`transform.define`, `minify: "dce-only"`,
`format: "esm"`), imported the bundle in a Node process with `ALCHEMY_PHASE=runtime`, provided only
`stackConstant("BallastProject", "local")`, and ran the exported Effect:

```
BUNDLED 571346 bytes
BUNDLE_HAS_PLAN_ONLY_STRING false          # the plan-only branch was DCE'd
[INFO] init phase=runtime prefix=hi-from-env runtime=true
INSTANCE Ballast.Script tick-echo
SEEN ["fake/tick"]
```

Init ran, read `Config.String("BALLAST_PREFIX")` from `process.env` (the phase-runtime path), host
services worked, and `exports.program` ran. Nothing needed a provider or a deploy.

Bundle caveats:

- `ALCHEMY_MODULE_TYPES` (`.sql`/`.txt`/`.html` as text, `Bundle.ts:177-182`) is irrelevant to Ballast;
- Alchemy's own bundler adds a "pure" tree-shaking plugin and condition names
  (`BUN_CONDITION_NAMES`/`NODE_CONDITION_NAMES`, `Bundle.ts:35-36`); a self-contained script bundle does
  not need them, but external Node builtins must be left external (or the target must provide them);
- `import.meta.url` in the entry points at the bundle, not the source — do not put source paths in
  `Script` props.

Hot reload is **not** provided by Alchemy. It is a Ballast worker-lifecycle concern: one
`worker_threads` worker per generation, terminate the old worker, start the new one. Platform's
runtime `Scope` is useful if the agent ever reloads in-process; otherwise the thread is the unit of
teardown. The `hostServices` lifetime finding in §1 means a connection held in a host service would be
closed at init end — keep connections in the host/worker, not in `hostServices`.

---

## 5. How unresolvable `Output`s appear in a plan

The short version: **as themselves.** A plan is not serializable data. It contains live `Output`
expression objects wherever a value could not be resolved; the serializable row view throws them away.

**[source]** `Plan.make` resolves props with `resolveInput` and keeps the evaluable form on the node:

```ts
// ALCHEMY/Plan.ts:1293-1301
// Apply-facing props (stored on the plan node): whole-resource
// references to updating upstreams stay evaluable `ResourceExpr`s.
// Apply runs `Output.evaluate(node.props, outputs)` right before `reconcile`…
const applyProps = yield* resolveInput(resource.Props);
// Diff-facing view of the same resolution: stable attributes
// materialized so their known values flow into `diff`…
const news = materializeStableRefs(applyProps);
```

`resolveResource` returns the persisted attributes only for a **stabilized** upstream; for a resource
that is being created/replaced/updated in the same plan it returns the `ResourceExpr` itself
(`ALCHEMY/Plan.ts:744-875`, "we must assume the resource doesn't exist if it hasn't stabilized").
Property access on that expression stays a `PropExpr`, so the value remains an `Expr`.

**[source]** The `Plan` type has no "unknown" field (`ALCHEMY/Plan.ts:237-281`), and `describePlan`
exposes only rows:

```ts
// ALCHEMY/Plan.ts:289-304
export const describeResource = (node: CRUD): PlannedResource => ({
  fqn: node.resource.FQN,
  logicalId: node.resource.LogicalId,
  resourceType: node.resource.Type,
  action: node.action,
  bindings: node.bindings.map(describeBinding),   // { sid, action } only
  providerMode: node.mode,
  …
});
```

**[verified]** In the experiment the subscription's `topic` prop was derived from a `ParamStore` resource
created by the same plan:

```
NODE tick-sub create
  props resolved? false  topic isExpr? true  topic JSON: undefined
```

The plan row printed `"action":"create"`; the live expression was only visible on the native plan node,
and `JSON.stringify` dropped it (Output proxies are functions).

What providers see and what apply does:

- `provider.diff` receives the unresolved `news`; `Diff.isResolved(news)` / `hasUnresolvedInputs`
  (`ALCHEMY/Diff.ts:40-53`) is the supported guard.
- If `diff` returns `undefined`, the engine falls back to `havePropsChanged`, which treats any
  `Output` as a change → `update` (`ALCHEMY/Plan.ts:1609-1618`, `ALCHEMY/Diff.ts:176-181`).
- `Apply` calls `Output.evaluate(node.props, outputs)` against the upstream's fresh attributes
  immediately before `reconcile` (`ALCHEMY/Apply.ts:851`). **[verified]**: the unresolved
  `topic` reached the provider as `"from-apply"`, the value `ParamStore.reconcile` had just returned.
- Persisted state cannot hold expressions: `stripUnresolved` replaces them with `undefined` at the
  commit boundary (`ALCHEMY/Diff.ts:82`).

**Consequence for Ballast.** Alchemy can *carry* an unresolved value and resolve it at apply, but it
cannot *report* it: there is no `Plan.unresolved`. The manifest's `unresolved: [{ path, reason }]` must
come from Ballast's recorder at declaration time (this is true under option A as well). That is not a
reason to avoid Alchemy — it is a reason a recorder is mandatory in every option.

---

## Decision

**Hybrid: keep Alchemy's host model, drop its plan/apply engine for Phase 0.**

### Adopt

| Alchemy piece | Use |
|---|---|
| `Platform` | Define `Ballast.Script` as a real third-party host type. Init has no `Scope` by type; handlers/registration work; the same init runs in plan and runtime. |
| `RuntimeContext` / `BaseRuntimeContext` | The script's host context: `env`, `get`/`set`, `exports`, `run`, and `hostServices`. Model `EventHost`, `Params`, `RequestHost` on `WebhookHost`. |
| `hostServices` / `planServices` | Inject host services in every phase; `planServices` (plan only) is available if the platform itself owns a plan-only service. In the sketch the runner provides the recorder around `Script(...)`, which is simpler and symmetric with runtime services. |
| `Output` + `Diff.isResolved` | Lazy param values and plan-time unresolved detection *where an expression is useful*. Literals/maps/`isResolved` work without running `Plan`. |
| `ALCHEMY_PHASE` + `__ALCHEMY_RUNTIME__` | Explicit phase switch and DCE of plan-only code, exactly as `RepositoryEventSourceLive` does. |
| `createHostRuntimeContext` / `ServerHost` shape | Basis for `Ballast.run` and `exports.program`; either import the helper or copy its ~40 lines. |
| `Config` capture | Guardrail: a script that reads `Config` in init gets plan-capture/run-read semantics rather than plan-process env leakage. |

### Do not adopt (Phase 0)

`Stack`/`Plan`/`Apply`/`Provider`/`State`/CLI. A constant `Stack` value and a `Stage` string are
still provided because `Platform`/`Resource` need them, but nothing plans, applies, deploys or persists
through Alchemy.

### Why not A (everything)

1. **The manifest is not the plan.** A's plan is a resource CRUD graph; the manifest is a list of
   params/connections/topics/requests/unresolved entries. `describePlan` drops props and binding
   payloads (§5), and there is no unresolved list. The recorder is required even under A, so A does not
   replace the main deliverable — it adds to it.
2. **Plan-time I/O is a trap, not a feature.** A `read` implementation is called during plan for any
   creating resource with resolved props (§3, verified). Every Ballast provider must then be audited to
   omit/guard `read`, or the exit criterion "plan makes no request calls" fails. With a Ballast plan
   layer, request clients are plan stubs that `die` if called — a much stronger guarantee.
3. **The engine's unique value is not used yet.** Dependency-ordered reconcile, replacement, GC,
   adoption, provider modes, namespaces and telemetry matter when Ballast manages a graph of cloud
   resources. Phase 0 manages two stub resources; Phase 2's subscriptions are a set diff per integration.
   The cost is `Stack` + providers + state + `Provider` layers + the engine's semantics, for a
   `create/update/delete` decision over rows we already have.
4. **Coupling.** The adopted surface is ~5 modules; `Plan.ts` alone is ~107 KB and `Apply.ts` ~89 KB,
   with many behaviours that are not Ballast's domain. The beta moved between the June clone and
   beta.84 (no `hostServices`, no `Runtime/Process`, no `WebhookHost` in June), so every adopted module
   is a future migration; choose the smallest set that earns its keep.

### Why not B (script shape only, no Alchemy host)

B is viable — the fallback in `docs/HANDOFF.md` §6 Step 7 — but it throws away things `Platform` gives
for free and that Ballast actively needs:

- a typed init that cannot request `Scope`, with handlers/registration separated by construction;
- `hostServices` as the single, documented place to say what a script sees in both phases;
- phase-aware `Config` capture, which prevents init from silently reading the plan process's env;
- `Output` integration for lazy values and deferred resolution;
- a supported extension point (the Alchemy docs' "Custom Runtime") rather than a bespoke runner.

We would write those ~200 lines ourselves, and the script-facing API would not change. Keeping the
fallback is cheap: `Ballast.Script` is asked to produce an Effect either way, so switching the internals
from `Platform` to a hand-written runner is a `@ballast/core` change, not a script change.

### Exit criteria under this decision

| Criterion | Under the hybrid |
|---|---|
| `ballast plan examples/tick-echo.ts` prints the manifest | **Yes.** The plan worker yields `Script(...)` under plan services; the recorder returns the manifest. |
| Planning makes no request calls / opens no connections | **Yes, by construction.** Plan `RequestHost` clients are `Effect.die`; `Settings`/`EventBus` are absent in plan; no provider `read`/`diff` exists to call. |
| `ballast run` logs ticks | **Yes.** Bundle + worker + `EventBus`; init registers handlers through `EventHost`. |
| Hot reload with no duplicate handlers | **Yes.** One worker per generation; old worker terminated, its bus registrations dropped; new worker re-runs init. |
| Adding a topic yields `requiresConsent: true` | **Yes.** Manifest set diff in `@ballast/planner`; no Alchemy diff involved. |
| `pnpm typecheck` / `pnpm test` | Yes (the sketch type-checks; tests are Phase 0 Steps 5-6). |

### Revisit triggers

- **Phase 2:** if cloud subscriptions need dependency ordering, retry/replacement, or cross-integration
  GC, add `Plan`/`Apply` **for cloud resources only** (a `TopicSubscription` resource + provider). Do
  not move the script host into a `Stack` deploy.
- If Alchemy grows a first-class unresolved/manifest concept, or `Platform` churn breaks the host,
  reassess. Until then, pin beta.84 exactly and keep `alchemy` imports inside `@ballast/core`.

---

## Implementation sketch

*Sketch only; it follows the verified shapes above but is not the final code.*

### `Ballast.Script`

```ts
// packages/core/src/Script.ts
import { Platform } from "alchemy/Platform";
import type { BaseRuntimeContext } from "alchemy/RuntimeContext";
import { Resource } from "alchemy/Resource";

export interface ScriptProps {
  readonly id: string;
  readonly entry: string;
  readonly env?: Record<string, any>;        // Platform merges captured Config here
  readonly isExternal?: boolean;
}

export interface ScriptResource
  extends Resource<"Ballast.Script", ScriptProps, { startedAt: string }> {}

export interface ScriptRuntimeContext extends BaseRuntimeContext {
  readonly phase: "plan" | "runtime";
  readonly run: (effect: Effect.Effect<void, never, any>) => Effect.Effect<void>;
}

export const Script: Platform<
  ScriptResource,
  EventHost | Params | RequestHost,
  {},
  ScriptRuntimeContext
> = Platform("Ballast.Script", {
  createRuntimeContext: (id) => makeScriptRuntimeContext(id),
});
```

```ts
// packages/core/src/Script.ts — the host context
const makeScriptRuntimeContext = (id: string): ScriptRuntimeContext => {
  const runners: Effect.Effect<void, never, any>[] = [];
  const env: Record<string, unknown> = {};
  return {
    Type: "Ballast.Script",
    id,
    phase: process.env.ALCHEMY_PHASE === "runtime" ? "runtime" : "plan",
    env,
    get: (key) => Effect.sync(() => unpackEnvValue(process.env[key])),
    set: (key, output) =>
      Effect.sync(() => {
        env[key] = output.pipe(Output.map(packEnvValue));
        return key;
      }),
    run: (effect) => Effect.sync(() => void runners.push(effect)),
    exports: Effect.succeed({ program: Effect.all(runners, { concurrency: "unbounded" }) }),
    hostServices: ScriptHostLive,   // EventHost, Params, RequestHost
  };
};
```

`phase` is host-controlled, not read through Alchemy `Config` (host services are built *outside* the
Config interceptor, §1). The bundle sets `ALCHEMY_PHASE=runtime`; everything else defaults to plan.
`globalThis.__ALCHEMY_RUNTIME__` is used only inside `if (!globalThis.__ALCHEMY_RUNTIME__)` blocks so
plan-only code is DCE'd.

### `EventHost`

```ts
// packages/core/src/EventHost.ts
export interface EventHostService {
  readonly subscribe: <A>(
    topic: TopicRef<A>,
    handler: (event: A) => Effect.Effect<void, never, never>,
  ) => Effect.Effect<void>;
}

export class EventHost extends Context.Service<EventHost, EventHostService>()("Ballast/EventHost") {}

export const EventHostLive = Layer.effect(
  EventHost,
  Effect.gen(function* () {
    const phase = yield* ScriptPhase;
    const recorder = yield* Effect.serviceOption(ManifestRecorder); // plan
    const bus = yield* Effect.serviceOption(EventBus);               // runtime

    return EventHost.of({
      subscribe: (topic, handler) =>
        phase === "plan"
          ? Option.match(recorder, {
              onNone: () => Effect.die("EventHost used outside plan/run"),
              onSome: (r) => r.topic({ integration: topic.integration, slot: topic.slot,
                                        topic: topic.name, scopes: topic.scopes }),
            })
          : Option.match(bus, {
              onNone: () => Effect.die("EventBus missing in runtime"),
              onSome: (b) => b.subscribe(topic.key, handler),   // handler gets a per-event scope
            }),
    });
  }),
);
```

This is deliberately modelled on `WebhookHost`: a host service with `route`-like registration, provided
by the host in every phase, no scoped resources of its own.

### `Param`

```ts
// packages/core/src/Param.ts
export interface Param<T> {
  readonly key: string;
  readonly get: Effect.Effect<T>;   // live read: settings may change while the script runs
  [Symbol.iterator](): Iterator<Effect.Effect<Effect.Effect<T>>, Effect.Effect<T>>;
}

export const string = (
  key: string,
  options: { title?: string; default?: string } = {},
): Effect.Effect<Param<string>, never, ScriptPhase> =>
  Effect.gen(function* () {
    const phase = yield* ScriptPhase;

    // Plan: record the declaration. The value is never read.
    if (phase === "plan") {
      const recorder = yield* Effect.serviceOption(ManifestRecorder);
      yield* Option.match(recorder, {
        onNone: () => Effect.die("ManifestRecorder missing in plan"),
        onSome: (r) => r.param({ key, type: "string", title: options.title, default: options.default }),
      });
    }

    // Settings is only required when `get` is run, so plan never needs it.
    const get = Settings.pipe(
      Effect.flatMap((s) => s.get(key)),
      Effect.map((v) => v ?? options.default ?? ""),
    );
    return {
      key,
      get,
      // `yield* param` yields `get`, exactly like an Output yields its accessor.
      [Symbol.iterator]: () => new SingleShotGen(Effect.succeed(get)),
    };
  });
```

If a param is used to build a topic (`Twitch.onMessage(param)`), the integration passes the param as
an `Input<string>` to `EventHost.subscribe`; the recorder sees that the value is not a resolved string
and adds an `unresolved` entry. No real value is needed at plan.

### Plan and runtime phases

```ts
// packages/planner/src/plan.ts — plan is just "run init with plan services"
const plan = (entry: string) =>
  Effect.gen(function* () {
    // The runner owns the recorder; hostServices sees it through the ambient
    // context (the same way runtime services are provided around the script).
    const ref = yield* Ref.make(emptyManifest());
    const recorder = ManifestRecorder.of(recordingInto(ref));

    // No provider, no State, no Plan.apply. A constant Stack is the only
    // Alchemy requirement of Resource()/Platform.
    yield* Script(scriptId(entry), { id: scriptId(entry), entry }, scriptInit).pipe(
      Effect.provideService(ManifestRecorder, recorder),
      Effect.provideService(Stack, emptyStack),
      Effect.provideService(Stage, "local"),
      Effect.provideService(ScriptPhase, "plan"),
      Effect.scoped,
    );
    return yield* Ref.get(ref);
  });
```

```ts
// apps/agent/src/runtime/bootstrap.ts — runtime is the same init, different host services
process.env.ALCHEMY_PHASE = "runtime";

const main = Effect.gen(function* () {
  const instance = yield* entry.default;                     // bundled Script(...)
  const exports = yield* instance.RuntimeContext.exports;
  yield* exports.program;                                    // EventHost handlers / Ballast.run loops
}).pipe(
  Effect.provide(stackConstant("Ballast", projectId)),
  Effect.provide(runtimeServices),                           // EventBus, Settings, ScriptPhase("runtime"), Logs…
  Effect.scoped,
);
```

The work split is:

- **plan** records declarations and never calls a request client or a socket;
- **apply** (`@ballast/planner`) diffs `prev`/`next` manifests and performs the side effects
  (cloud topic subscriptions, local connection starts) — a set diff, not a resource graph;
- **run** bundles with the define, starts a worker, provides the runtime services, and swaps workers on
  change.

Request capabilities stay on the Ballast side: define a tiny `Capability` helper with the same
tag+callable shape as `Binding.Service`, whose plan implementation records
`{ integration, slot, request, scopes }` and whose client is `Effect.die("request called during plan")`.
That is the exit criterion made structural. `Binding.Service` itself is not needed because there is no
deploy-time host binding to wire; using it would drag in `Binding.Host` and a provider for no gain.

### Hot reload

```
save → plan (new worker, plan phase) → manifest diff
     → needs consent? ask
     → start worker B (runtime) → B registers handlers with the bus
     → terminate worker A → the bus drops A's registrations
```

One worker per generation is the simplest correct design: it guarantees no duplicate handlers and no
leaked sockets, and it matches `docs/PLAN.md` §6.3. `Platform`/`hostServices` do not need to be involved
in teardown; in-process reload is possible later by closing the generation's scope.

---

## Appendix: experiments

All experiments live in `/private/var/folders/09/05vxh1_d3q3c07yj9c313c700000gn/T/opencode/ballast-exp`
(never in the repo). They import the installed beta.84 via a `node_modules` symlink and run with
`bun`; `exp*` programs exit explicitly.

### E1/E2 — custom platform, plan, apply (`exp1.ts`, `exp2.ts`)

```
$ bun exp2.ts
PLAN {"resources":[
  {"fqn":"tick-echo","logicalId":"tick-echo","resourceType":"Ballast.Script","action":"create","bindings":[]},
  {"fqn":"params","logicalId":"params","resourceType":"Ballast.ParamStore","action":"create","bindings":[]},
  {"fqn":"tick-sub","logicalId":"tick-sub","resourceType":"Ballast.TopicSubscription","action":"create","bindings":[]}]}
AFTER_PLAN {"diff":0,"reconcile":0,"reconcileInputs":[]}
AFTER_APPLY {"diff":0,"reconcile":1}
RECONCILE_INPUTS [{"topic":"from-apply","scopes":["fake:read"]}]
RECORDED {"topics":["fake/tick"],"params":["channel"]}
PLAN2 {"resources":[{"fqn":"tick-echo",…,"action":"noop"},{"fqn":"params",…,"action":"noop"},
                    {"fqn":"tick-sub",…,"action":"update"}]}   # abridged
AFTER_PLAN2 {"diff":1,"reconcile":1}
```

Proves: `hostServices` + custom `RuntimeContext` at plan; `inMemoryState`; no provider calls on create;
apply re-evaluates the unresolved `topic` before reconcile; second plan calls `diff` for the resource
that defines it.

### E3 — runtime bundle (`bundle.ts` + `host.ts` + `script.ts`)

```
$ bun bundle.ts && bun host.ts
BUNDLED 571346 bytes
BUNDLE_HAS_PLAN_ONLY_STRING false
[INFO] init phase=runtime prefix=hi-from-env runtime=true
INSTANCE Ballast.Script tick-echo
SEEN ["fake/tick"]
```

Proves: rolldown-style `define` + `dce-only` is enough; `ALCHEMY_PHASE=runtime` + `Config` reads from
the worker env; the plan-only branch is removed; no provider/state at runtime.

### E4 — `read` during plan (`exp4.ts`)

```
$ bun exp4.ts | grep AFTER_PLAN
AFTER_PLAN {"diff":0,"reconcile":0,"read":1,"readFqns":["params"],…}
```

Proves: a creating resource with resolved props calls `provider.read` if defined; an unresolved one
(`tick-sub`) does not. This is why Ballast providers should omit `read` if Alchemy's Plan is ever used.

### E5 — filtered plan (`exp5.ts`)

```
$ bun exp5.ts | head -1
PLAN {"resources":[{"fqn":"params",…,"action":"create"},{"fqn":"tick-sub",…,"action":"create"}],…}   # abridged
```

Proves `Plan.make(compiled, { include: ["tick-sub"] })` selects the resource and its upstream only.

### E6 — platform without a provider or state (`exp6.ts`)

```
$ bun exp6.ts
script yield requires a Stack service; providing a constant one next
INSTANCE Ballast.Script tick-echo SEEN ["fake/tick"]
```

Proves `Script(...)` runs init with only `Stack`, `Stage`, `Scope` — the minimal host path used by the
hybrid.

### E7 — `hostServices` lifetime (`exp7.ts`)

```
$ bun exp7.ts
PLAN_MODE    ["acquire","init host","release","after-yield tick-echo","end-body"]
RUNTIME_MODE ["acquire","init host","release","after-yield tick-echo","end-body"]
```

Proves: a scoped `hostServices` resource is released when init returns, in both phases. Host services
must be registrations/stateless clients; long-lived connections belong to the worker/agent.

### E11 — host services can read ambient services (`exp11.ts`)

```
$ bun exp11.ts
SEEN ["fake/tick"]
```

A `Recorder` service was provided around `Script(...)`, and `hostServices` resolved it inside its own
`Layer.effect`. Proves the sketch's plan-recorder injection works: the runner owns the `Ref`, provides
`ManifestRecorder` around `Script(...)`, and `EventHostLive`/`Param` see it through the ambient
context. The same mechanism provides `EventBus`/`Settings` in runtime.

### Note on the reference clone

`~/github.com/alchemy-run/alchemy-effect` is at `f17fab02` (2026-06-26); `git pull` was blocked by local
modifications. It predates `RuntimeContext.hostServices`, `Runtime/Process.ts` and `WebhookHost.ts`, so
it cannot be used to answer §1/§4 for beta.84. The installed package is authoritative. The MacroGraph
Cloudflare patch (`patches/@alchemy.run__cloudflare@2.0.0-beta.84.patch`) only touches Vite hashing and
does not affect any of the above.
