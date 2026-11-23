# `@ballast/agent-protocol`

The transport-independent contract between the Ballast agent service, the desktop UI, the CLI and
(later) MCP clients. Read `docs/decisions/0003-desktop-app-and-agent-service.md` for the design.

- `AgentRpcs` — the Effect RPC group (`effect/rpc`), served at `/rpc` over WebSocket.
- `AgentClient` — the generated client type.
- `MockAgentLayer` — a full in-memory implementation with two projects and realistic fake data,
  for building the UI before the service exists.
- Projects — scripts are addressed by `{ projectId, scriptId }`; connections and cloud pairing are
  service-wide.
- Streaming RPCs — `StreamLogs`, `StreamEvents`, `WatchService`; all begin with buffered history
  (or a snapshot) and then follow live changes.
- Shell-owned permissions — `ReportShellPermission` sends macOS Accessibility trust from the
  desktop; `GetHealth.permissions.accessibility` reflects it.
- `ConnectionSummary.approval` — a pending out-of-app approval (`vtuber-studio` Allow dialog,
  `accessibility` permission). It is separate from `reauth-required`: the connection can still be
  `connecting` and is not broken.
- Durable timers — `ScriptManifest.timers` carries declarations, `ListTimers` returns
  `TimerSummary` rows, `CancelTimer` removes one instance, and `timer-fired` is a service event.
  The worker-only `RegisterTimer`/`ScheduleTimer`/`CancelTimer` RPCs are in `RuntimeRpcs`.

## Using the mock

```ts
import * as Effect from "effect/Effect";
import { RpcTest } from "effect/rpc";
import { AgentRpcs, MockAgentLayer } from "@ballast/agent-protocol";

const program = Effect.gen(function* () {
  const client = yield* RpcTest.makeClient(AgentRpcs).pipe(
    Effect.provide(MockAgentLayer),
  );

  const projects = yield* client.ListProjects();
  const { scripts } = yield* client.ListScripts({
    projectId: projects.projects[0]!.id,
  });
  const detail = yield* client.GetScript({
    projectId: projects.projects[0]!.id,
    scriptId: scripts[0]!.id,
  });
  console.log(detail.summary.name, detail.manifest.params);
});
```

`RpcTest` is the no-serialization test transport. In the real app the same client is built over a
WebSocket with the service's bearer token; see decision 0003 §2.

## Versioning

`ServiceInfo.apiVersion` is `1`. Additive schemas, optional keys and new RPC tags are compatible;
renaming/removing fields or changing semantics requires a new API version. The shell refuses to
adopt a service with a different API version.

## Verification

```sh
pnpm --filter @ballast/agent-protocol typecheck
pnpm --filter @ballast/agent-protocol test
```
