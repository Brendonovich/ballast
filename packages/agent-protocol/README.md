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

## Project bundles (0008)

The primary surface is project-oriented. A project is one entry
(`ballast.ts` or `package.json#ballast.entry`) and one worker.

- `ProjectSummary` — `id`, `name`, `root`, optional `entry`, `enabled`,
  `status: "stopped" | "running" | "needs-consent" | "error"`, `unitCount`,
  `createdAt`, `updatedAt`, optional `lastError`.
- `ProjectDetail` — `{ summary, manifest, units, appliedAt?, pendingConsent?,
  lastErrorSource?, scripts }`. `scripts` remains only for the script-oriented
  cutover UI.
- `ProjectManifest` — `{ project: { id, entry }, params, connections, topics,
  requests, timers, workflows, runs, unresolved }`; topic/timer/workflow/run
  entries carry `name` and optional `source: { file, line, column }`.
- `UnitSummary` — `{ kind: "topic" | "timer" | "workflow" | "param" | "run",
  name, title?, source?, status: "active" | "waiting" | "error",
  lastActivityAt? }`.
- Lifecycle RPCs — `CreateProject`, `CheckProject`, `PlanProject`,
  `StartProject`, `StopProject`, `RestartProject`, `SetProjectParam`,
  `SetProjectEnabled`. `CreateProject({ name, directory? })` scaffolds a
  stopped project (default `<BALLAST_PROJECTS_DIR>/<slug>`); `CheckProject`
  typechecks/bundles/plans/diffs without applying and returns structured
  diagnostics, units, changes, consent need, missing scopes/connections and the
  applied manifest.
- Files — `ListProjectFiles`, `ReadProjectFile`, `GetProjectSource`;
  read-only, project-relative paths.
- Consents — `ListProjectConsents`, `ApproveProjectConsent`,
  `RejectProjectConsent` with `ProjectConsentRequest`.
- Logs/events — `StreamLogs` and `StreamEvents` accept `unitKind` and
  `unitName`; entries carry the same fields plus `projectId`.
- Timers — `ListTimers({ projectId?, includeFinished? })` and
  `CancelTimer({ projectId, timer, key })`. `scriptId` is no longer part of
  `TimerSummary`.
- Service events — `project-changed`, `reload-failed` (`message`, optional
  `source`, `at`), `project-file-changed`, `project-consent`,
  `project-consent-resolved`.

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
