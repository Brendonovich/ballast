# @ballast/e2e

Black-box tests that run the real cloud Worker under `alchemy dev` and the real
desktop service (`ballast serve`), then drive both through the agent RPC API.

```sh
fnm exec --using=24.22.2 pnpm --filter @ballast/e2e test
```

Alchemy needs Node 22.22.3+ or 24.11.1+; the suite skips with that reason when
the runner node is older. It never uses Cloudflare credentials: the cloud child
gets a throwaway HOME, `Cloudflare` credentials removed, a unique local stage
and a local port.

Scenarios:

1. Twitch cloud mode: fake Twitch provider, OAuth + pairing through the
   service, consent, signed EventSub delivery to the script, service-offline
   buffering/replay, and owner-keyed reconcile while stopping scripts.
2. Cloud webhooks: register an `Http.Webhook("kofi")` hook through the service,
   signed public delivery, rejected signature, and hook removal on stop.
3. Twitch local-app mode against the Twitch CLI: skipped because Twitch CLI
   1.1.7 `mock-api` is not a drop-in Helix/OAuth server (`/helix/users` and
   `/oauth2/token` return 404).
