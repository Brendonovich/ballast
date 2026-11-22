# Ballast

Ballast is a pnpm monorepo: a desktop agent that runs Alchemy + Effect scripts against streaming integrations, plus a Cloudflare cloud for OAuth, webhooks and relaying events. Read `docs/PLAN.md` for the design and `docs/HANDOFF.md` for current status before starting work.

## Source of truth

- Effect v4 and Alchemy v2 (beta) change quickly. Read the installed source in `node_modules/effect/src` and `node_modules/alchemy/src` instead of relying on remembered APIs.
- Alchemy reference source: `~/github.com/alchemy-run/alchemy-effect` (run `git pull` first; the clone may be older than the installed version).
- Integration protocol reference: the MacroGraph v2 rewrite at `~/github.com/brendonovich/cf-effect-experiment/packages/modules/*` (not `~/github.com/brendonovich/macrograph`). Port this code; never import from MacroGraph.

## Coding

- Never use `as any`. Use branded constructors or restructure the types.
- Define services as `Context.Service` classes. Inline private implementations in `Layer.effect`; extract a `make` function only when it is exported.
- Script authors import `@ballast/*` and `effect` only. Keep `alchemy` behind `@ballast/core`.
- A script's init only declares what it needs. Any I/O belongs in handlers or `Ballast.run`.
- Backwards compatibility is not required yet. Prefer clean designs over compatibility layers.

## Verification

| Situation | Command |
| --- | --- |
| Any code change | `pnpm typecheck` |
| Tests | `pnpm test` |

Don't call work done until the behavior has been exercised (for example `ballast plan` / `ballast run` on an example script). A clean compile alone doesn't prove it works.
