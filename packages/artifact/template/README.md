# Solid artifact template

Copy these files into a project:

- `ballast.ts` — artifact declaration, API, store and a timer heartbeat;
- `src/api.ts` — the shared Effect RPC group;
- `artifacts/dashboard/main.tsx` — Solid artifact entry.

The template uses `Ballast.Store.counter`, `Ballast.Api.serve` and
`Ballast.Artifact`. It has no integration dependency; wire real topic history
into the API when you add one.
