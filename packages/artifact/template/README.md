# Solid artifact template

Copy these files into a project:

- `ballast.ts` — artifact declaration, API, store and a timer heartbeat;
- `src/api.ts` — the shared Effect RPC group;
- `artifacts/dashboard/main.tsx` — Solid 2 artifact entry.

The template uses `Ballast.Store.counter`, `Ballast.Api.serve` and
`Ballast.Artifact`. It has no integration dependency; wire real topic history
into the API when you add one.

The browser entry imports its renderer from `@solidjs/web` and uses the
`@ballast/artifact/solid` helpers: `query` returns a Promise for async
computations, `stream`/`collect` return AsyncIterables, and `mutation` is
yielded from a Solid `action`. Wrap async reads in `<Loading>`.
