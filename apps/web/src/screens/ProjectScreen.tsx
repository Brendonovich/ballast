import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import type {
  ArtifactSummary,
  ProjectRequirement,
  TimerSummary,
  UnitSummary,
} from "@ballast/agent-protocol";

import { useAgent } from "../state/context.tsx";
import { getDesktopBridge } from "../bridge.ts";
import { useAccessibilityPermission } from "../permissions.ts";
import {
  blockingRequirements,
  integrationName,
  plural,
  projectStatusLabel,
  projectStatusTone,
  projectWorkerRunning,
} from "../lib/format.ts";
import {
  AlertIcon,
  ArrowLeftIcon,
  PanelRightIcon,
  PlayIcon,
  StopIcon,
} from "../ui/icons.tsx";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Spinner,
  Status,
} from "../ui/primitives.tsx";
import { LogsPanel } from "./project/LogsPanel.tsx";
import { ProjectSidebar } from "./project/ProjectSidebar.tsx";
import { SourcePanel } from "./project/SourcePanel.tsx";
import type { SourceJump } from "./project/SourcePanel.tsx";
import { ProjectNavigator } from "./project/ProjectNavigator.tsx";
import { buildOutline, unitKey } from "../lib/outline.ts";
import type { OutlineItem } from "../lib/outline.ts";
import { ConnectionDialog } from "./connections/ConnectionDialog.tsx";
import { ArtifactPanel } from "./project/ArtifactPanel.tsx";

const SPLIT_KEY = "ballast.projectSplit";
const SIDEBAR_KEY = "ballast.projectSidebarCollapsed";
const DEFAULT_SPLIT = 0.58;

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const readSplit = (): number => {
  if (typeof window === "undefined") return DEFAULT_SPLIT;
  try {
    const value = Number(window.localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(value) && value >= 0.22 && value <= 0.82 ? value : DEFAULT_SPLIT;
  } catch {
    return DEFAULT_SPLIT;
  }
};

const writeSplit = (value: number): void => {
  try {
    window.localStorage.setItem(SPLIT_KEY, String(value));
  } catch {
    // Non-critical.
  }
};

const readSidebar = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "true";
  } catch {
    return false;
  }
};

const writeSidebar = (collapsed: boolean): void => {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, String(collapsed));
  } catch {
    // Non-critical.
  }
};

export const ProjectScreen = (): JSX.Element => {
  const store = useAgent();
  const navigate = useNavigate();
  const bridge = getDesktopBridge();
  const params = useParams<{ projectId?: string }>();

  const projectId = createMemo(() => safeDecode(params.projectId ?? ""));
  const summary = createMemo(() => store.project(projectId()));
  const detail = createMemo(() => store.projectDetail(projectId()));
  const units = createMemo<ReadonlyArray<UnitSummary>>(() => detail()?.units ?? []);
  const artifacts = createMemo<ReadonlyArray<ArtifactSummary>>(() => store.artifacts(projectId()));
  const loading = createMemo(() => store.isProjectLoading(projectId()));
  const pendingConsent = createMemo(
    () => detail()?.pendingConsent ?? store.projectConsent(projectId()),
  );
  const requirements = createMemo<ReadonlyArray<ProjectRequirement>>(
    () => detail()?.requirements ?? [],
  );
  const blocking = createMemo(() => blockingRequirements(requirements()));
  const statusLabel = (): string => {
    const project = summary();
    if (project === undefined) return "";
    if (blocking().length > 0) return "Needs connections";
    if (pendingConsent() !== undefined) return "Needs consent";
    if (project.status === "error") return projectStatusLabel(project);
    return projectStatusLabel(project);
  };
  const statusTone = (): "warning" | "success" | "danger" | "neutral" | "info" => {
    const project = summary();
    if (project === undefined) return "neutral";
    if (blocking().length > 0) return "warning";
    if (pendingConsent() !== undefined) return "warning";
    if (project.status === "error") return projectStatusTone(project);
    return projectStatusTone(project);
  };
  const workerRunning = (): boolean => {
    const project = summary();
    return project !== undefined && projectWorkerRunning(project);
  };
  const errorMessage = (): string => {
    const project = summary();
    const source = detail()?.lastErrorSource;
    if (project?.lastError === undefined) return "";
    if (source === undefined) return project.lastError;
    const prefix = `${source.file}:${source.line}:${source.column}`;
    if (!project.lastError.startsWith(prefix)) return project.lastError;
    return project.lastError
      .slice(prefix.length)
      .replace(/^\s*[—-]\s*/, "");
  };

  const [split, setSplit] = createSignal(readSplit());
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(readSidebar());
  const [maximized, setMaximized] = createSignal<"source" | "logs">();
  const [selectedUnit, setSelectedUnit] = createSignal<UnitSummary>();
  const [jump, setJump] = createSignal<SourceJump>();
  const [timers, setTimers] = createSignal<ReadonlyArray<TimerSummary>>([]);
  const [selectedArtifactName, setSelectedArtifactName] = createSignal<string>();
  const [selectedOutlineKey, setSelectedOutlineKey] = createSignal<string>();
  const outline = createMemo(() => buildOutline(detail()));
  const [artifactFullscreen, setArtifactFullscreen] = createSignal(false);
  const selectedArtifact = createMemo(() => {
    const name = selectedArtifactName();
    return name === undefined
      ? undefined
      : artifacts().find((artifact) => artifact.name === name);
  });
  const [addingConnection, setAddingConnection] = createSignal<ProjectRequirement>();
  const [pendingBinding, setPendingBinding] = createSignal<PendingBinding>();
  const permission = useAccessibilityPermission();
  let jumpToken = 0;
  let splitArea: HTMLDivElement | undefined;

  const refreshTimers = async (): Promise<void> => {
    const pid = projectId();
    if (pid === "") return;
    const rows = await store.listTimers(pid);
    if (rows !== undefined) setTimers(rows);
  };

  createEffect(() => {
    const pid = projectId();
    const started = store.info()?.startedAt;
    const revision = store.projectRevision(pid);
    const artifactRevision = store.artifactListRevision(pid);
    if (pid === "" || started === undefined) return;
    void revision;
    void artifactRevision;
    void store.fetchProject(pid, true);
    void store.fetchArtifacts(pid, true);
  });

  createEffect(() => {
    const pid = projectId();
    const revision = store.projectRevision(pid);
    const logCount = store.logs().filter((entry) => entry.projectId === pid).length;
    if (pid === "") return;
    void revision;
    void logCount;
    const handle = window.setTimeout(() => void refreshTimers(), 250);
    onCleanup(() => window.clearTimeout(handle));
  });

  createEffect(() => {
    const pid = projectId();
    setSelectedUnit(undefined);
    setSelectedOutlineKey(undefined);
    setSelectedArtifactName(undefined);
    setArtifactFullscreen(false);
    setJump(undefined);
    setTimers([]);
    void pid;
  });

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (artifactFullscreen()) {
        event.preventDefault();
        setArtifactFullscreen(false);
        return;
      }
      if (maximized() !== undefined) {
        event.preventDefault();
        setMaximized(undefined);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const media = window.matchMedia("(max-width: 1200px)");
    const collapse = (): void => {
      if (media.matches && !sidebarCollapsed()) {
        setSidebarCollapsed(true);
        writeSidebar(true);
      }
    };
    collapse();
    media.addEventListener("change", collapse);
    onCleanup(() => {
      document.removeEventListener("keydown", onKeyDown);
      media.removeEventListener("change", collapse);
    });
  });

  const toggleSidebar = (): void => {
    const next = !sidebarCollapsed();
    setSidebarCollapsed(next);
    writeSidebar(next);
  };

  const toggleMaximize = (pane: "source" | "logs"): void => {
    setMaximized((current) => (current === pane ? undefined : pane));
  };

  const openHome = (): void => {
    if (bridge !== undefined) {
      void bridge.windows.openHome("projects");
      return;
    }
    navigate("/projects");
  };

  const openSource = (file: string, line: number): void => {
    setSelectedArtifactName(undefined);
    setArtifactFullscreen(false);
    jumpToken += 1;
    setJump({ file, line, token: jumpToken });
    if (maximized() === "logs") setMaximized(undefined);
  };

  const openArtifact = (artifact: ArtifactSummary): void => {
    setSelectedArtifactName(artifact.name);
    setArtifactFullscreen(false);
    if (maximized() === "logs") setMaximized(undefined);
  };

  const closeArtifact = (): void => {
    setSelectedArtifactName(undefined);
    setArtifactFullscreen(false);
  };

  // Opening an outline item shows its declaration and, for units, its logs.
  const selectOutlineItem = (item: OutlineItem): void => {
    setSelectedOutlineKey(item.key);
    setSelectedUnit(item.unit);
    if (item.source !== undefined) {
      openSource(item.source.file, item.source.line);
    } else {
      closeArtifact();
    }
    if (item.unit !== undefined && maximized() === "source") setMaximized(undefined);
  };

  const filterLogs = (unit: UnitSummary | undefined): void => {
    setSelectedUnit(unit);
    setSelectedOutlineKey(unit === undefined ? undefined : unitKey(unit));
  };

  const popOutArtifact = (artifact: ArtifactSummary): void => {
    if (bridge !== undefined) {
      void bridge.windows.openArtifactWindow(projectId(), artifact.name);
      return;
    }
    const url = new URL(window.location.href);
    url.hash =
      "/projects/" +
      encodeURIComponent(projectId()) +
      "/artifacts/" +
      encodeURIComponent(artifact.name);
    window.open(url.toString(), "_blank", "noopener");
  };

  const beginResize = (event: PointerEvent): void => {
    if (splitArea === undefined) return;
    event.preventDefault();
    const rect = splitArea.getBoundingClientRect();
    const move = (moveEvent: PointerEvent): void => {
      const ratio = (moveEvent.clientY - rect.top) / rect.height;
      setSplit(Math.min(0.82, Math.max(0.22, ratio)));
    };
    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      writeSplit(split());
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  const resetSplit = (): void => {
    setSplit(DEFAULT_SPLIT);
    writeSplit(DEFAULT_SPLIT);
  };

  const start = async (): Promise<void> => {
    await store.startProject(projectId());
    void refreshTimers();
  };

  const stop = async (): Promise<void> => {
    await store.stopProject(projectId());
  };

  const restart = async (): Promise<void> => {
    await store.restartProject(projectId());
  };

  const bindRequirement = async (
    requirement: ProjectRequirement,
    instanceId: string | null,
  ): Promise<boolean> => {
    if (!workerRunning()) {
      return (
        (await store.setProjectBinding(
          projectId(),
          requirement.integration,
          requirement.slot,
          instanceId,
        )) !== undefined
      );
    }
    return new Promise<boolean>((resolve) => {
      setPendingBinding({ requirement, instanceId, resolve });
    });
  };

  const confirmBinding = async (): Promise<void> => {
    const pending = pendingBinding();
    if (pending === undefined) return;
    setPendingBinding(undefined);
    const detail = await store.setProjectBinding(
      projectId(),
      pending.requirement.integration,
      pending.requirement.slot,
      pending.instanceId,
    );
    pending.resolve(detail !== undefined);
  };

  const cancelBinding = (): void => {
    const pending = pendingBinding();
    pending?.resolve(false);
    setPendingBinding(undefined);
  };

  const sourceStyle = (): JSX.CSSProperties => {
    if (maximized() === "source") return { flex: "1 1 0%" };
    if (maximized() === "logs") return { height: "32px", flex: "0 0 32px" };
    return { "flex-grow": split(), "flex-basis": "0%", "min-height": "96px" };
  };

  const logsStyle = (): JSX.CSSProperties => {
    if (maximized() === "logs") return { flex: "1 1 0%" };
    if (maximized() === "source") return { height: "32px", flex: "0 0 32px" };
    return { "flex-grow": 1 - split(), "flex-basis": "0%", "min-height": "96px" };
  };

  return (
    <>
      <Show
        when={summary()}
      fallback={
        <Show
          when={loading()}
          fallback={
            <EmptyState
              title="Project not found"
              description="It may have been removed, or the folder is no longer registered."
              action={
                <button
                  type="button"
                  class="text-[13px] text-accent hover:underline"
                  onClick={openHome}
                >
                  Back to Projects
                </button>
              }
            />
          }
        >
          <div class="flex h-full items-center justify-center gap-2 text-[12px] text-muted">
            <Spinner size={12} /> Loading project…
          </div>
        </Show>
      }
    >
      {(project) => (
        <div class="flex h-full min-h-0 flex-col gap-2 overflow-hidden px-5 pb-4 pt-3">
          <div class="flex shrink-0 items-center gap-3">
            <button
              type="button"
              aria-label="Back to Projects"
              class="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-body"
              onClick={openHome}
            >
              <ArrowLeftIcon size={14} />
            </button>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h1 class="truncate text-[16px] font-medium leading-6 tracking-[-0.02em] text-strong">
                  {project().name}
                </h1>
                <Status tone={statusTone()}>{statusLabel()}</Status>
              </div>
              <p class="truncate font-mono text-[10px] text-faint">
                {project().root}
                <Show when={detail()}>{(current) => <> · {plural(current().units.length, "unit")}</>}</Show>
              </p>
            </div>
            <Button
              size="small"
              variant="ghost"
              data-testid="toggle-project-sidebar"
              aria-expanded={!sidebarCollapsed()}
              icon={<PanelRightIcon size={13} />}
              onClick={toggleSidebar}
            >
              <span class="hidden sm:inline">Project</span>
            </Button>
            <Show when={pendingConsent() === undefined && workerRunning()}>
              <Button
                size="normal"
                variant="ghost"
                data-testid="restart-project"
                loading={store.isPending(`project:${projectId()}:restart`)}
                onClick={() => void restart()}
              >
                Restart
              </Button>
            </Show>
            <Show when={pendingConsent() === undefined || !workerRunning()}>
              <Button
                size="normal"
                variant={workerRunning() ? "outline" : "primary"}
                data-testid="toggle-project"
                loading={
                  store.isPending(`project:${projectId()}:start`) ||
                  store.isPending(`project:${projectId()}:stop`)
                }
                icon={workerRunning() ? <StopIcon size={12} /> : <PlayIcon size={12} />}
                onClick={() => void (workerRunning() ? stop() : start())}
              >
                {workerRunning() ? "Stop" : "Start"}
              </Button>
            </Show>
          </div>

          <Show when={pendingConsent()}>
            {(consent) => (
              <div
                data-testid="project-consent"
                class="shrink-0 rounded-md border border-[var(--v2-state-border-warning)] bg-[var(--v2-state-bg-warning)] px-3 py-2"
              >
                <div class="flex items-center gap-2.5">
                  <AlertIcon size={13} class="shrink-0 text-warning" />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-[12px] font-medium text-warning">Approval required</p>
                    <p class="truncate text-[11px] text-body">{consent().summary}</p>
                    <Show when={consent().bindings.length > 0}>
                      <div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted">
                        <For each={consent().bindings}>
                          {(binding) => (
                            <span data-testid="consent-binding">
                              {integrationName(binding.integration)} · {binding.slot} →{" "}
                              {store.connection(binding.instanceId)?.label ?? binding.instanceId}
                            </span>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                  <div class="flex shrink-0 items-center gap-1.5">
                    <Button
                      size="small"
                      variant="ghost"
                      data-testid="reject-project-consent"
                      loading={store.isPending(`project-consent:${consent().id}:reject`)}
                      onClick={() => void store.rejectProjectConsent(consent().id)}
                    >
                      Reject
                    </Button>
                    <Button
                      size="small"
                      variant="primary"
                      data-testid="approve-project-consent"
                      loading={store.isPending(`project-consent:${consent().id}:approve`)}
                      onClick={() => void store.approveProjectConsent(consent().id)}
                    >
                      Approve
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Show>

          <Show when={project().status === "error" && project().lastError}>
            <div
              data-testid="project-error"
              class="shrink-0 rounded-md border border-[var(--v2-state-border-danger)] bg-[var(--v2-state-bg-danger)] px-2.5 py-1.5 text-[11px] text-danger"
            >
              <div class="flex items-start gap-2">
                <AlertIcon size={13} class="mt-px shrink-0" />
                <div class="min-w-0 flex-1">
                  <p class="font-medium">
                    {project().enabled
                      ? "Running previous version, latest change failed"
                      : "Latest change failed"}
                  </p>
                  <p class="mt-0.5 break-all">{errorMessage()}</p>
                  <Show when={detail()?.lastErrorSource}>
                    {(source) => (
                      <button
                        type="button"
                        data-testid="project-error-source"
                        class="mt-1 font-mono text-[10px] text-danger underline-offset-2 hover:underline"
                        title={`${source().file}:${source().line}:${source().column}`}
                        onClick={() => openSource(source().file, source().line)}
                      >
                        {source().file}:{source().line}
                      </button>
                    )}
                  </Show>
                </div>
              </div>
            </div>
          </Show>

          <div class="flex min-h-0 flex-1 gap-3">
            <Show when={!artifactFullscreen()}>
              <ProjectNavigator
                projectId={projectId()}
                artifacts={artifacts()}
                selectedArtifact={selectedArtifact()?.name}
                onOpenArtifact={openArtifact}
                onViewSource={closeArtifact}
                outline={outline()}
                selectedItem={selectedOutlineKey()}
                onSelectItem={selectOutlineItem}
                onOpenSource={openSource}
              />
            </Show>

            <div ref={splitArea} class="flex min-h-0 min-w-0 flex-1 flex-col">
              <Show
                when={selectedArtifact()}
                fallback={
                  <>
                    <div class="min-h-0" style={sourceStyle()}>
                      <SourcePanel
                        projectId={projectId()}
                        jump={jump()}
                        collapsed={maximized() === "logs"}
                        maximized={maximized() === "source"}
                        onToggleMaximize={() => toggleMaximize("source")}
                      />
                    </div>
                    <Show when={maximized() === undefined}>
                      <div
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label="Resize source and logs"
                        data-testid="project-splitter"
                        class="group flex h-1.5 shrink-0 cursor-row-resize touch-none items-center justify-center"
                        onPointerDown={beginResize}
                        onDblClick={resetSplit}
                      >
                        <span class="h-px w-10 rounded bg-[var(--v2-border-border-base)] transition-colors group-hover:bg-[var(--v2-border-border-strong)]" />
                      </div>
                    </Show>
                    <div class="min-h-0" style={logsStyle()}>
                      <LogsPanel
                        projectId={projectId()}
                        units={units()}
                        selected={selectedUnit()}
                        onSelect={filterLogs}
                        collapsed={maximized() === "source"}
                        maximized={maximized() === "logs"}
                        onToggleMaximize={() => toggleMaximize("logs")}
                      />
                    </div>
                  </>
                }
              >
                {(artifact) => (
                  <div class="min-h-0 flex-1">
                    <ArtifactPanel
                      projectId={projectId()}
                      artifact={artifact()}
                      fullscreen={artifactFullscreen()}
                      onToggleFullscreen={() =>
                        setArtifactFullscreen((current) => !current)
                      }
                      onClose={closeArtifact}
                      onPopOut={() => popOutArtifact(artifact())}
                      onOpenSource={openSource}
                    />
                  </div>
                )}
              </Show>
            </div>

            <Show when={!artifactFullscreen() && !sidebarCollapsed() && detail()}>
              {(current) => (
                <ProjectSidebar
                  detail={current()}
                  timers={timers()}
                  onRefreshTimers={() => void refreshTimers()}
                  onCollapse={toggleSidebar}
                  onBind={bindRequirement}
                  onAddConnection={setAddingConnection}
                />
              )}
            </Show>
          </div>
        </div>
        )}
      </Show>
      <Show when={addingConnection()}>
      {(requirement) => (
        <ConnectionDialog
          connection={undefined}
          initialIntegration={requirement().integration}
          permission={permission.status()}
          requestingPermission={permission.requesting()}
          hasBridge={permission.hasBridge}
          onRequestAccessibility={() => void permission.request()}
          onClose={() => setAddingConnection(undefined)}
          onCreated={(connection) => {
            void bindRequirement(requirement(), connection.id);
          }}
        />
      )}
    </Show>
    <Show when={pendingBinding()}>
      {(pending) => (
        <ConfirmDialog
          title={pending().instanceId === null ? "Unbind connection?" : "Rebind connection?"}
          description={
            pending().instanceId === null
              ? "The running project will stop because a connection requirement becomes unbound."
              : "The running project will restart with the new connection."
          }
          confirmLabel={pending().instanceId === null ? "Unbind" : "Rebind"}
          pending={store.isPending(
            `project:${projectId()}:binding:${pending().requirement.integration}:${pending().requirement.slot}`,
          )}
          onCancel={cancelBinding}
          onConfirm={() => void confirmBinding()}
        />
      )}
      </Show>
    </>
  );
};

interface PendingBinding {
  readonly requirement: ProjectRequirement;
  readonly instanceId: string | null;
  readonly resolve: (bound: boolean) => void;
}
