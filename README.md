# Ballast

A desktop agent that runs typed Effect scripts against your streaming tools (OBS, VTube Studio,
MIDI, keyboard, WebSocket, HTTP/webhooks) and cloud services (Twitch, Ko-fi-style webhooks), with
a cloud that handles OAuth, webhooks and relaying events to your machine.

Scripts are written with Effect and `@ballast/core`. Running a script in plan mode works out the
events, permissions, accounts and settings it needs before it runs.
The desktop shell owns install/update of the background service; the service owns projects,
scripts, connections and local state.

- [docs/PLAN.md](docs/PLAN.md): product and architecture plan
- [docs/HANDOFF.md](docs/HANDOFF.md): current status, decisions and next steps
- [docs/decisions](docs/decisions): decision records 0001–0005

Status: the agent service, web UI, desktop shell and integrations are implemented and tested;
real-world integration validation and Windows/release packaging are next.
