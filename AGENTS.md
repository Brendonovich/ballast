# Ballast

Ballast is a pnpm monorepo: a desktop agent that runs Effect scripts against streaming integrations, plus a Cloudflare cloud for OAuth, webhooks and relaying events. Read `docs/PLAN.md` for the design and `docs/HANDOFF.md` for current status before starting work.

## Source of truth

- Effect v4 and Alchemy v2 (beta) change quickly. Read the installed source in `node_modules/effect/src` and `node_modules/alchemy/src` instead of relying on remembered APIs.
- Alchemy reference source: `~/github.com/alchemy-run/alchemy-effect` (run `git pull` first; the clone may be older than the installed version).
- Integration protocol reference: the MacroGraph v2 rewrite at `~/github.com/brendonovich/cf-effect-experiment/packages/modules/*` (not `~/github.com/brendonovich/macrograph`). Port this code; never import from MacroGraph.

## Coding

- Never use `as any`. Use branded constructors or restructure the types.
- Define services as `Context.Service` classes. Inline private implementations in `Layer.effect`; extract a `make` function only when it is exported.
- Script authors import `@ballast/*` and `effect` only. `@ballast/core` must not depend on `alchemy`; Alchemy is only used by `apps/cloud`, which uses Alchemy's Effect Worker form for both deployment and the Worker runtime (decision 0004).
- A script's init only declares what it needs. Any I/O belongs in handlers or `Ballast.run`.
- Scripts are AI-authored. Prefer script APIs that are explicit and machine-verifiable (named, declared, schema-typed, checkable at plan time) over ones that are merely convenient.
- Do not use `Effect.sleep` for work that must survive a restart; declare a `Ballast.Timer` and put the continuation in its handler (decision 0006).
- Backwards compatibility is not required yet. Prefer clean designs over compatibility layers.

## Verification

| Situation | Command |
| --- | --- |
| Any code change | `pnpm typecheck` |
| Tests | `pnpm test` |

Don't call work done until the behavior has been exercised (for example `ballast plan` / `ballast run` on an example script). A clean compile alone doesn't prove it works.
