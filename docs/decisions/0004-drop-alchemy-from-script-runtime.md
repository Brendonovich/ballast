# 0004 — Drop Alchemy from the script runtime

*Status: accepted · 2026-11-23 · supersedes the decision in
[0001](0001-alchemy-as-script-framework.md) · effect `4.0.6`*

## Context

Decision 0001 chose a hybrid: keep Alchemy's host model (`Platform`,
`RuntimeContext`, `hostServices`, `Output`, `Phase`) but not its
`Stack`/`Plan`/`Apply` engine. Phase 0 shipped on that hybrid, and it worked. The
remaining Alchemy surface in `@ballast/core` was:

- `Platform("Ballast.Script", …)` to define the script host and its init layer;
- `Resource`, `BaseRuntimeContext`, `packEnvValue`/`unpackEnvValue`;
- `Stack` and `Stage` constants (only because `Platform`'s resource registration
  reads them);
- `Output` in the host context's `get`/`set`;
- `__ALCHEMY_RUNTIME__` + `ALCHEMY_PHASE` to switch phases.

None of that is needed by the runtime. Ballast does not deploy a resource graph,
does not use Alchemy providers at runtime, and has its own manifest recorder. The
only thing the script runtime asked Alchemy for was a way to run one init with a
phase-specific set of host services — which decision 0001's fallback B (HANDOFF
§6 Step 7) describes, and which is a small amount of code to own.

The user decision: **"We can probably not rely on Alchemy at runtime; rather just
use the Alchemy ideas of the split plan and execution scripts but not actually use
it."** This record adopts fallback B.

## Decision

**`@ballast/core` does not depend on `alchemy`. Scripts are plain Effect
programs; "plan" and "runtime" are two host layers around the same init.**

### The same script, two host layers

A script is an ordinary Effect default export; `Ballast.Script` is a type only.
The planner/runtime host wraps it with `evaluateScript`, which resolves the
current phase and evaluates `init` exactly once against that phase's host layer:

| Service | Plan layer | Runtime layer |
|---|---|---|
| `EventHost` | records the topic into the manifest recorder; never registers a handler | registers the handler with the agent's `EventBus` |
| `RequestHost` | records the request; every client returned is `Effect.die(new RequestCalledDuringPlanError(...))` | returns clients that call the agent over the existing runtime RPC |
| `ScriptRunner` | collects `Ballast.run` loops (never evaluated while planning) | collects `Ballast.run` loops, run from `exports.program` |
| `ScriptPhase` | `"plan"` | `"runtime"` |

`Param` and `Connection` are free functions, not host services. They use the same
`ScriptPhase`: in plan they write into `ManifestRecorder` and return lazy values
whose reads die; at runtime params read `Settings` and connections are handles for
request clients. There is deliberately no manifest recorder at runtime.

The runtime worker still provides the runtime services around the script
(`EventBus`, `Settings`, `RequestClients`) and forks each event handler, so a
handler gets its own fiber scope. Init is typed without `Scope` and receives none;
that invariant is now enforced by the `ScriptHostServices` type and the host
layers, not by Alchemy's platform types.

### Phase switching

The authoritative switch is the `ScriptPhase` service. `providePlan` provides
`"plan"` plus the manifest recorder; `runRuntimeWorker` provides `"runtime"` plus
the RPC-backed services. This is the same split as before, with Ballast-owned
layers.

The runtime bundle still sets a define, renamed from `__ALCHEMY_RUNTIME__` to
`__BALLAST_PHASE__ = "runtime"`, and `currentPhase` falls back to it (then
`BALLAST_PHASE`) when no service is provided. It is **not** what selects the host
layer; it is a bundler-visible default and a DCE hook for code that wants to keep
plan-only branches out of the runtime bundle:

```ts
if (globalThis.__BALLAST_PHASE__ !== "runtime") {
  // provisioning/declaration-only code; folded away by define + dce-only
}
```

Keeping it costs one line in `apps/agent/src/bundle.ts`. Dropping it would not
remove the layer branch (phase is a runtime value) and would only make direct
evaluation of a bundle silently plan. The real size win is removing Alchemy, not
this define.

### What replaces each Alchemy piece

| Alchemy (0001) | Now |
|---|---|
| `Platform` / `Resource` | `evaluateScript` returns a small `ScriptRuntime` (`run`, `exports`); the planner and runtime worker use that |
| `hostServices` | `planHostServices` / `runtimeHostServices` layers built in `script.ts` |
| `BaseRuntimeContext` / `packEnvValue` | `ScriptRuntimeContext` with `phase`, `run` and `exports` only; the unused env get/set plumbing is gone |
| `Output` | lazy `Effect` params only. There are no resolved-at-apply values; a param used to build a topic is still a manifest `unresolved` candidate, as it was |
| `Config` capture | params read `Settings` at runtime; init never reads process env for script values |
| `Stack` / `Stage` | gone. Neither the planner nor the runtime worker provides infrastructure services |
| `ALCHEMY_PHASE` / `__ALCHEMY_RUNTIME__` | `ScriptPhase` service and `__BALLAST_PHASE__` |

### Why fallback B is now the right call

0001's "why not B" argued that `Platform` gives a typed init without `Scope`,
one documented host-services hook, phase-aware `Config` capture, `Output`
integration, and a supported extension point. In practice:

1. **The typed init and host-services hook are ~50 lines.** `Script` provides
   exactly the services `ScriptHostServices` names; init's type still cannot ask
   for `Scope`.
2. **`Config` capture was not used by scripts.** Params already go through the
   manifest/settings path. `Output` was only carrying env get/set values that no
   script read.
3. **The extension point cost more than it gave.** `Platform` forced `Stack` and
   `Stage` values, an `Output`-typed env context, and `__ALCHEMY_RUNTIME__`; every
   Alchemy beta change was a migration in the one package scripts cannot avoid
   depending on.
4. **The plan-time I/O guarantee is stronger here.** A plan request client is a
   plain `Effect.die`; there is no provider `read`/`diff` API that could perform
   network I/O during plan.
5. **The bundle gets much smaller.** The runtime worker bundle dropped from
   837,924 bytes to 588,053 bytes with no functional change (see below).

### What does not change

- The script-facing API in `examples/*.ts` is byte-for-byte unchanged.
- `providePlan(effect, recorder)` keeps its call shape; the planner does not
  import `alchemy` either.
- `RuntimeRpcs`, `serveRuntimeRpc`, `makeRuntimeRpcClient`, `runRuntimeWorker`,
  `EventHost`, `RequestHost`, `ScriptRunner` and `Manifest` keep their roles.
- Init still declares only; handlers and `Ballast.run` still act; event handlers
  still get a per-event scope.
- Alchemy stays in `apps/cloud` (D9), which uses Alchemy's Effect Worker form for
  both deployment and the Worker runtime (confirmed 2026-11-23). Scripts and the
  desktop agent never depend on it.

### Consequences and limits

- No `Output`-based lazy values and no apply-time expression evaluation. The
  manifest's `unresolved` entries remain recorder-owned (as they already were
  under 0001); a param used as a topic condition is still recorded as unresolved
  by the integration rather than resolved by Alchemy.
- No Alchemy provider/state/adoption/drift machinery. Ballast still uses a
  manifest set diff in `@ballast/planner`.
- The plan/runtime split must be kept honest by tests: a request call during plan
  must fail, and a runtime param read must use `Settings`. Both are covered in
  `packages/core/test/core.test.ts` and `packages/planner/test`.

## Verification (2026-11-23)

```
$ grep -rn alchemy packages/core packages/planner
(no output)

$ pnpm --filter @ballast/core typecheck && pnpm --filter @ballast/core test
6 tests passed
$ pnpm --filter @ballast/planner typecheck && pnpm --filter @ballast/planner test
10 tests passed
$ pnpm --filter @ballast/module-obs typecheck && pnpm --filter @ballast/module-obs test
2 tests passed
$ pnpm --filter @ballast/module-twitch typecheck && pnpm --filter @ballast/module-twitch test
39 tests passed
$ pnpm --filter @ballast/fake typecheck
$ pnpm --filter @ballast/examples typecheck

$ ballast plan examples/tick-echo.ts     # byte-identical to the 0001 output
$ ballast plan examples/obs-scene.ts     # byte-identical
$ ballast plan examples/redeem-to-scene.ts  # byte-identical

$ ballast run examples/tick-echo.ts
[run] bundled generation 0 (588053 bytes)   # before: 837924 bytes
> tick 1
> tick 2
```

## Files

- `packages/core/src/script.ts` — `Script`, `ScriptInstance`, host layer
  selection, `ScriptRunner`, phase recording.
- `packages/core/src/plan-host.ts` — `providePlan` (`ManifestRecorder` +
  `ScriptPhase("plan")`).
- `packages/core/src/topic.ts` — `EventHostPlan`, `EventHostRuntime`.
- `packages/core/src/request.ts` — `RequestHostPlan`, `RequestHostRuntime`.
- `packages/core/src/phase.ts` — `ScriptPhase` and the `__BALLAST_PHASE__`
  fallback.
- `packages/core/src/runtime-worker.ts` — no `Stack`/`Stage`; runtime services
  only.
- `packages/core/package.json` — `alchemy` removed from dependencies.
- `apps/agent/src/bundle.ts` — the define line only.
- `docs/decisions/0001-alchemy-as-script-framework.md` — marked superseded.
