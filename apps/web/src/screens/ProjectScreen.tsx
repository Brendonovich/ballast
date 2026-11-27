import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type {
  ArtifactSummary,
  ProjectFile,
  ProjectRequirement,
  TimerSummary,
  UnitSummary,
} from "@ballast/agent-protocol";

import { useAgent } from "../state/context.tsx";
import { getDesktopBridge } from "../bridge.ts";
import { useAccessibilityPermission } from "../permissions.ts";
import { blockingRequirements, integrationName } from "../lib/format.ts";
import {
  canRestart,
  projectAction,
  sourceMarkers,
} from "../lib/project-health.ts";
import type { IssueTarget } from "../lib/project-health.ts";
import { flash, pendingProjectIntent, takeProjectIntent } from "../lib/project-intent.ts";
import type { ProjectIntent } from "../lib/project-intent.ts";
import {
  EMPTY_TABS,
  activateTab,
  activeTab,
  closeTab,
  defaultTabs,
  parseTabs,
  pinTab,
  previewTab,
  tabsStorageKey,
} from "../lib/project-tabs.ts";
import type { ProjectTab, TabsState } from "../lib/project-tabs.ts";
import {
  AlertIcon,
  MaximizeIcon,
  MinimizeIcon,
  PanelRightIcon,
} from "../ui/icons.tsx";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Spinner,
  cx,
  surface,
} from "../ui/primitives.tsx";
import { LogsPanel } from "./project/LogsPanel.tsx";
import { TopBarActions, TopBarCenter, TopBarEnd } from "../layout/top-bar-slot.tsx";
import { ProjectSidebar } from "./project/ProjectSidebar.tsx";
import { FileView } from "./project/FileView.tsx";
import type { SourceJump } from "./project/FileView.tsx";
import { ProjectNavigator } from "./project/ProjectNavigator.tsx";
import { TabStrip } from "./project/TabStrip.tsx";
import { TopicEventsView } from "./project/TopicEventsView.tsx";
import { ShareBar } from "./project/ShareBar.tsx";
import { RunButton } from "./project/RunButton.tsx";
import { buildOutline } from "../lib/outline.ts";
import type { OutlineItem } from "../lib/outline.ts";
import {
  DEFAULT_LOGS_LAYOUT,
  clampSplit,
  logsStorageKey,
  parseLogsLayout,
} from "../lib/logs-layout.ts";
import type { LogsLayout } from "../lib/logs-layout.ts";
import { leftSidebarHidden } from "../state/left-sidebar.ts";
import { projectMode, setProjectMode } from "../state/project-mode.ts";
import type { ProjectMode } from "../lib/project-mode.ts";
import { ConnectionDialog } from "./connections/ConnectionDialog.tsx";
import { ArtifactList } from "./project/ArtifactList.tsx";
import { ArtifactActions, ArtifactPanel } from "./project/ArtifactPanel.tsx";

const SIDEBAR_KEY = "ballast.projectSidebarCollapsed";
/** The tab strip's height, which is all the tab area keeps while logs are maximized. */
const STRIP_HEIGHT = 40;

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const readLogsLayout = (projectId: string): LogsLayout => {
  try {
    return parseLogsLayout(window.localStorage.getItem(logsStorageKey(projectId)));
  } catch {
    return DEFAULT_LOGS_LAYOUT;
  }
};

const writeLogsLayout = (projectId: string, layout: LogsLayout): void => {
  try {
    window.localStorage.setItem(logsStorageKey(projectId), JSON.stringify(layout));
  } catch {
    // Non-critical.
  }
};

const readTabs = (projectId: string): TabsState | undefined => {
  try {
    return parseTabs(window.localStorage.getItem(tabsStorageKey(projectId)));
  } catch {
    return undefined;
  }
};

const writeTabs = (projectId: string, state: TabsState): void => {
  try {
    window.localStorage.setItem(tabsStorageKey(projectId), JSON.stringify(state));
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

const fileName = (path: string): string => path.split("/").at(-1) ?? path;

export const ProjectScreen = (props: { readonly projectId: string }): JSX.Element => {
  const store = useAgent();
  const navigate = useNavigate();
  const bridge = getDesktopBridge();
  const projectId = createMemo(() => safeDecode(props.projectId));
  const summary = createMemo(() => store.project(projectId()));
  const detail = createMemo(() => store.projectDetail(projectId()));
  const units = createMemo<ReadonlyArray<UnitSummary>>(() => detail()?.units ?? []);
  const artifacts = createMemo<ReadonlyArray<ArtifactSummary>>(() => store.artifacts(projectId()));
  const loading = createMemo(() => store.isProjectLoading(projectId()));
  const pendingConsent = createMemo(
    () => detail()?.pendingConsent ?? store.projectConsent(projectId()),
  );
  const status = createMemo(() => {
    const project = summary();
    return project === undefined ? "stopped" : project.status;
  });
  const action = createMemo(() => projectAction(status()));
  const workerRunning = (): boolean => status() === "running";
  /** Gutter markers for a change that did not apply. Summary issues are canonical. */
  const markers = createMemo(() => sourceMarkers(summary()?.issues ?? []));

  // The screen remounts per project, so per-project state is read once.
  const initialProject = safeDecode(props.projectId);
  const initialLogs = readLogsLayout(initialProject);
  const [split, setSplit] = createSignal(initialLogs.split);
  const [logsCollapsed, setLogsCollapsed] = createSignal(initialLogs.collapsed);
  const saveLogsLayout = (): void =>
    writeLogsLayout(projectId(), { collapsed: logsCollapsed(), split: split() });
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(readSidebar());
  const [maximized, setMaximized] = createSignal<"tabs" | "logs">();
  const [selectedUnit, setSelectedUnit] = createSignal<UnitSummary>();
  const [jump, setJump] = createSignal<SourceJump>();
  const [timers, setTimers] = createSignal<ReadonlyArray<TimerSummary>>([]);
  const outline = createMemo(() =>
    buildOutline(detail(), (connectionId) => store.connection(connectionId)?.label),
  );
  const [reveal, setReveal] = createSignal<{ readonly key: string; readonly token: number }>();
  const [artifactFullscreen, setArtifactFullscreen] = createSignal(false);
  const [addingConnection, setAddingConnection] = createSignal<ProjectRequirement>();
  const [pendingBinding, setPendingBinding] = createSignal<PendingBinding>();
  /** View mode's artifact selection; Develop's open tabs are left untouched. */
  const [viewArtifact, setViewArtifact] = createSignal<string>();
  const permission = useAccessibilityPermission();
  let jumpToken = 0;
  let splitArea: HTMLDivElement | undefined;

  // Tabs: restored per project window; nothing stored opens the entry file.
  const storedTabs = readTabs(initialProject);
  const [tabs, setTabsState] = createSignal<TabsState>(storedTabs ?? EMPTY_TABS);
  let tabsReady = storedTabs !== undefined;
  const setTabs = (next: TabsState): void => {
    tabsReady = true;
    setTabsState(next);
    writeTabs(projectId(), next);
  };
  createEffect(() => {
    const entry = summary()?.entry;
    if (tabsReady || entry === undefined) return;
    untrack(() => setTabs(defaultTabs(entry)));
  });
  const current = createMemo(() => activeTab(tabs()));
  const activeFile = createMemo(() => {
    const tab = current();
    return tab?.kind === "file" ? tab.path : undefined;
  });
  const activeTopic = createMemo(() => {
    const tab = current();
    return tab?.kind === "topic" ? tab.name : undefined;
  });
  const artifactTabs = createMemo(
    () => tabs().tabs.flatMap((tab) => (tab.kind === "artifact" ? [tab.name] : [])),
    undefined,
    { equals: (left, right) => left.length === right.length && left.every((name, index) => name === right[index]) },
  );
  const artifactNamed = (name: string): ArtifactSummary | undefined =>
    artifacts().find((artifact) => artifact.name === name);
  /** The mode is per project and shared with the shell's top bar. */
  const mode = (): ProjectMode => projectMode(projectId());
  const viewOnly = (): boolean => mode() === "view";
  const selectMode = (next: ProjectMode): void => {
    setProjectMode(projectId(), next);
    setArtifactFullscreen(false);
    if (next === "view") setMaximized(undefined);
  };
  /**
   * The View mode's artifact: the row the user picked, else Develop's active
   * artifact tab, else the first declared artifact. Develop's tabs are never
   * rewritten by viewing.
   */
  const viewArtifactSummary = createMemo<ArtifactSummary | undefined>(() => {
    const selected = viewArtifact();
    if (selected !== undefined) {
      const artifact = artifactNamed(selected);
      if (artifact !== undefined) return artifact;
    }
    const tab = current();
    if (tab?.kind === "artifact") {
      const artifact = artifactNamed(tab.name);
      if (artifact !== undefined) return artifact;
    }
    return artifacts()[0];
  });
  /** Develop's logs, files and topics mount the first time Develop is shown. */
  const [developShown, setDevelopShown] = createSignal(!viewOnly());
  createEffect(() => {
    if (!viewOnly()) setDevelopShown(true);
  });
  /** View mode's artifacts that have been shown, kept mounted so they don't reload. */
  const [viewed, setViewed] = createSignal<ReadonlyArray<string>>([]);
  createEffect(() => {
    const name = viewArtifactSummary()?.name;
    if (!viewOnly() || name === undefined) return;
    if (!untrack(viewed).includes(name)) setViewed((current) => [...current, name]);
  });
  /**
   * Both modes share one page per artifact: anything open as a Develop tab or
   * shown in View stays mounted. The order is append-only so that a page's
   * iframe is never moved in the DOM, which would reload it.
   */
  const mountedArtifacts = createMemo<ReadonlyArray<string>>(
    (previous) => {
      const wanted = new Set([
        ...artifactTabs(),
        ...viewed().filter((name) => artifactNamed(name) !== undefined),
      ]);
      const kept = previous.filter((name) => wanted.has(name));
      const added = [...wanted].filter((name) => !previous.includes(name));
      return added.length === 0 && kept.length === previous.length ? previous : [...kept, ...added];
    },
    [],
  );
  /** The artifact the current mode shows, if any. */
  const shownArtifact = createMemo<string | undefined>(() => {
    if (viewOnly()) return viewArtifactSummary()?.name;
    const tab = current();
    return tab?.kind === "artifact" ? tab.name : undefined;
  });
  const topicTitle = (name: string): string =>
    units().find((unit) => unit.kind === "topic" && unit.name === name)?.title ?? name;

  const tabLabel = (tab: ProjectTab): string => {
    switch (tab.kind) {
      case "file":
        return fileName(tab.path);
      case "artifact": {
        const artifact = artifactNamed(tab.name);
        return artifact?.title ?? tab.name;
      }
      case "topic":
        return topicTitle(tab.name);
    }
  };

  const tabTitle = (tab: ProjectTab): string => {
    switch (tab.kind) {
      case "file":
        return tab.path;
      case "artifact":
        return `Artifact · ${tab.name}`;
      case "topic":
        return `Events · ${tab.name}`;
    }
  };

  // Files: the tree for the sidebar, reloaded when files change on disk.
  const [files, setFiles] = createSignal<ReadonlyArray<ProjectFile>>([]);
  const [filesError, setFilesError] = createSignal<string>();
  const loadTree = async (): Promise<void> => {
    const pid = projectId();
    const tree = await store.listProjectFiles(pid);
    if (pid !== projectId()) return;
    if (tree === undefined) {
      setFilesError(store.lastActionError() ?? "Could not list the project files.");
      return;
    }
    setFilesError(undefined);
    setFiles(tree.files);
  };
  createEffect(
    on(
      () => [projectId(), store.projectFileRevision(projectId()), store.info()?.startedAt] as const,
      ([pid, , started]) => {
        if (pid === "" || started === undefined) return;
        void loadTree();
      },
    ),
  );

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

  const openSidebar = (): void => {
    if (!sidebarCollapsed()) return;
    setSidebarCollapsed(false);
    writeSidebar(false);
  };

  const toggleMaximize = (pane: "tabs" | "logs"): void => {
    // Maximizing collapsed logs opens them; the split is unchanged underneath.
    if (pane === "logs" && logsCollapsed()) {
      setLogsCollapsed(false);
      saveLogsLayout();
      setMaximized("logs");
      return;
    }
    setMaximized((value) => (value === pane ? undefined : pane));
  };

  /** Logs show only their header while collapsed or while the tabs are maximized. */
  const logsHidden = (): boolean => maximized() === "tabs" || logsCollapsed();

  const toggleLogsCollapsed = (): void => {
    const hidden = logsHidden();
    setMaximized(undefined);
    setLogsCollapsed(!hidden);
    saveLogsLayout();
  };

  const openHome = (): void => {
    if (bridge !== undefined) {
      void bridge.windows.openHome("projects");
      return;
    }
    navigate("/projects");
  };

  /**
   * Show a tab, leaving full screen and maximized logs so it can be seen.
   * It opens as a preview; a double click (`keepTab`) pins it.
   */
  const showTab = (tab: ProjectTab): void => {
    setTabs(previewTab(tabs(), tab));
    if (tab.kind !== "artifact" || current()?.kind !== "artifact") setArtifactFullscreen(false);
    if (maximized() === "logs") setMaximized(undefined);
  };

  const openFile = (path: string): void => showTab({ kind: "file", path });

  /** Open a file at a line, highlighted; the code icons and issues use this. */
  const openSource = (file: string, line: number): void => {
    jumpToken += 1;
    setJump({ file, line, token: jumpToken });
    showTab({ kind: "file", path: file });
  };

  const openArtifact = (artifact: ArtifactSummary): void =>
    showTab({ kind: "artifact", name: artifact.name });

  const selectTab = (key: string): void => {
    setTabs(activateTab(tabs(), key));
    setArtifactFullscreen(false);
  };

  const keepTab = (key: string): void => setTabs(pinTab(tabs(), key));

  const dismissTab = (key: string): void => {
    setTabs(closeTab(tabs(), key));
    if (tabs().active !== key) setArtifactFullscreen(false);
  };

  /** After the DOM reflects a state change (sidebar opened, outline expanded). */
  const afterRender = (run: () => void): void => {
    requestAnimationFrame(() => requestAnimationFrame(run));
  };

  /** A param's field in the Project panel, focused. */
  const showParam = (name: string): void => {
    openSidebar();
    afterRender(() => {
      const field = document.querySelector(`[data-testid="project-param-${CSS.escape(name)}"]`);
      flash(field);
      const input =
        field instanceof HTMLInputElement || field instanceof HTMLSelectElement
          ? field
          : field?.querySelector("input, select, textarea");
      if (input instanceof HTMLElement) input.focus();
    });
  };

  /** A timer's pending fires in the Project panel, or the timers list when none are pending. */
  const showTimer = (name: string): void => {
    openSidebar();
    void refreshTimers();
    afterRender(() => {
      const row = document.querySelector(`[data-testid="timer-row"][data-timer="${CSS.escape(name)}"]`);
      flash(row ?? document.querySelector('[data-testid="project-sidebar-section"][data-section="timers"]'));
    });
  };

  const openItem = (item: OutlineItem): void => {
    const target = item.open;
    if (target === undefined) return;
    switch (target.kind) {
      case "topic":
        showTab({ kind: "topic", name: target.name });
        return;
      case "param":
        showParam(target.name);
        return;
      case "timer":
        showTimer(target.name);
        return;
    }
  };

  const filterLogs = (unit: UnitSummary | undefined): void => {
    setSelectedUnit(unit);
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
      setSplit(clampSplit(ratio));
    };
    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      saveLogsLayout();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  const resetSplit = (): void => {
    setSplit(DEFAULT_LOGS_LAYOUT.split);
    saveLogsLayout();
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

  /**
   * The requirement row for a slot, matched by integration and slot. Without
   * a slot (Set up…) the first unbound requirement is shown.
   */
  const showBinding = (requirement: {
    readonly integration: string | undefined;
    readonly slot: string | undefined;
  }): void => {
    openSidebar();
    afterRender(() => {
      const rows = [...document.querySelectorAll('[data-testid="project-requirement"]')].filter(
        (element) => element instanceof HTMLElement,
      );
      const row =
        requirement.slot === undefined
          ? rows.find((element) => element.dataset.boundInstance === undefined)
          : rows.find(
              (element) =>
                element.dataset.slot === requirement.slot &&
                (requirement.integration === undefined ||
                  element.dataset.integration === requirement.integration),
            );
      flash(row);
      const picker = row?.querySelector('[data-testid="project-connection-picker"]');
      if (picker instanceof HTMLElement) picker.focus();
    });
  };

  const showConsent = (): void => {
    afterRender(() => {
      const banner = document.querySelector('[data-testid="project-consent"]');
      flash(banner);
      const approve = banner?.querySelector('[data-testid="approve-project-consent"]');
      if (approve instanceof HTMLElement) approve.focus();
    });
  };

  /** Take the user to where an issue can be seen or fixed. */
  const showTarget = (target: IssueTarget): void => {
    switch (target.kind) {
      case "binding":
        showBinding(target);
        return;
      case "consent":
        showConsent();
        return;
      case "source":
        openSource(target.source.file, target.source.line);
        return;
      case "unit": {
        // A failed unit: point at it in the outline, show its logs and its declaration.
        const item = outline()
          .flatMap((group) => group.items)
          .find((entry) => entry.unit?.name === target.unit);
        if (item !== undefined) setReveal({ key: item.key, token: (reveal()?.token ?? 0) + 1 });
        if (item?.unit !== undefined) {
          setSelectedUnit(item.unit);
          if (maximized() === "tabs") setMaximized(undefined);
        }
        const source = target.source ?? item?.source;
        if (source !== undefined) openSource(source.file, source.line);
        return;
      }
      case "connection":
      case "none":
        return;
    }
  };

  /**
   * Set up…: bind what is missing, then approve. Approving enables and starts
   * a stopped project, so there is no separate start step.
   */
  const setUp = (): void => {
    const missing = blockingRequirements(detail()?.requirements ?? [])[0];
    if (missing !== undefined) {
      showBinding(missing);
      return;
    }
    if (pendingConsent() !== undefined) {
      showConsent();
      return;
    }
    const binding = summary()?.issues.find((issue) => issue.kind === "needs-binding");
    showBinding({ integration: binding?.integration, slot: binding?.slot });
  };

  const runIntent = (intent: ProjectIntent): void => {
    if (intent.kind === "set-up") setUp();
    else showTarget(intent.target);
  };

  // Requests from the top bar (an issue) or the Projects list (Set up…) wait
  // for the detail so the outline and requirements exist.
  createEffect(() => {
    pendingProjectIntent();
    if (detail() === undefined) return;
    const intent = untrack(() => takeProjectIntent(projectId()));
    if (intent !== undefined) untrack(() => runIntent(intent));
  });

  const runAction = (): void => {
    switch (action()) {
      case "stop":
        void stop();
        return;
      case "start":
        void start();
        return;
      case "set-up":
        setUp();
        return;
    }
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
    const result = await store.setProjectBinding(
      projectId(),
      pending.requirement.integration,
      pending.requirement.slot,
      pending.instanceId,
    );
    pending.resolve(result !== undefined);
  };

  const cancelBinding = (): void => {
    const pending = pendingBinding();
    pending?.resolve(false);
    setPendingBinding(undefined);
  };

  const tabsStyle = (): JSX.CSSProperties => {
    if (artifactFullscreen() || maximized() === "tabs" || (logsCollapsed() && maximized() !== "logs")) {
      return { flex: "1 1 0%" };
    }
    if (maximized() === "logs") return { height: `${STRIP_HEIGHT}px`, flex: `0 0 ${STRIP_HEIGHT}px` };
    return { "flex-grow": split(), "flex-basis": "0%", "min-height": "96px" };
  };

  const logsStyle = (): JSX.CSSProperties => {
    if (maximized() === "logs") return { flex: "1 1 0%" };
    if (logsHidden()) return { height: "32px", flex: "0 0 32px" };
    return { "flex-grow": 1 - split(), "flex-basis": "0%", "min-height": "96px" };
  };

  const jumpFor = (path: string): SourceJump | undefined => {
    const value = jump();
    return value?.file === path ? value : undefined;
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
        <div class="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2" data-testid="project-workspace">
          {/* The top bar's switcher shows the name; keep a heading for assistive tech. */}
          <h1 class="sr-only">{project().name}</h1>
          <TopBarCenter>
            <ProjectModeToggle mode={mode()} onChange={selectMode} />
          </TopBarCenter>
          <TopBarActions>
            <RunButton
              action={action()}
              canRestart={canRestart(status())}
              loading={
                store.isPending(`project:${projectId()}:start`) ||
                store.isPending(`project:${projectId()}:stop`)
              }
              restarting={store.isPending(`project:${projectId()}:restart`)}
              onAction={runAction}
              onRestart={() => void restart()}
            />
          </TopBarActions>
          <TopBarEnd>
            <button
              type="button"
              data-testid="toggle-project-sidebar"
              aria-label={sidebarCollapsed() ? "Show project sidebar" : "Hide project sidebar"}
              aria-expanded={!sidebarCollapsed()}
              title={sidebarCollapsed() ? "Show project sidebar" : "Hide project sidebar"}
              class="grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-body"
              onClick={toggleSidebar}
            >
              <PanelRightIcon size={15} />
            </button>
          </TopBarEnd>

          <ShareBar project={project()} />

          <Show when={pendingConsent()}>
            {(consent) => (
              <div
                data-testid="project-consent"
                class="shrink-0 rounded-[10px] border border-[var(--v2-state-border-warning)] bg-[var(--v2-state-bg-warning)] px-3 py-2"
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

          <div class="flex min-h-0 flex-1 gap-2">
            <Show when={!artifactFullscreen() && !viewOnly()}>
              <Show when={!leftSidebarHidden()}>
                <ProjectNavigator
                  projectId={projectId()}
                  files={files()}
                  filesError={filesError()}
                  activeTab={tabs().active}
                  onOpenFile={openFile}
                  onPinTab={keepTab}
                  artifacts={artifacts()}
                  onOpenArtifact={openArtifact}
                  outline={outline()}
                  onOpenItem={openItem}
                  onOpenSource={openSource}
                  reveal={reveal()}
                />
              </Show>
            </Show>

            <div ref={splitArea} class="flex min-h-0 min-w-0 flex-1 flex-col">
              <section
                data-testid="tab-area"
                data-mode={mode()}
                class={cx("flex min-h-0 flex-col overflow-hidden", surface)}
                style={viewOnly() ? { flex: "1 1 0%" } : tabsStyle()}
              >
                <Show
                  when={viewOnly()}
                  fallback={
                    <Show when={!artifactFullscreen()}>
                      <TabStrip
                        tabs={tabs().tabs}
                        active={tabs().active}
                        preview={tabs().preview}
                        label={tabLabel}
                        title={tabTitle}
                        danger={(tab) => tab.kind === "artifact" && artifactNamed(tab.name)?.status === "error"}
                        onActivate={selectTab}
                        onPin={keepTab}
                        onClose={dismissTab}
                        end={
                          <IconButton
                            label={maximized() === "tabs" ? "Restore tabs" : "Maximize tabs"}
                            size="small"
                            testId="tabs-maximize"
                            onClick={() => toggleMaximize("tabs")}
                          >
                            <Show when={maximized() === "tabs"} fallback={<MaximizeIcon size={12} />}>
                              <MinimizeIcon size={12} />
                            </Show>
                          </IconButton>
                        }
                      />
                    </Show>
                  }
                >
                  <Show when={viewArtifactSummary()}>
                    {(artifact) => (
                      <div
                        data-testid="view-mode-bar"
                        class="flex h-8 shrink-0 items-center gap-2 border-b border-edge pl-1 pr-3"
                      >
                        <ArtifactList
                          artifacts={artifacts()}
                          active={artifact().name}
                          onSelect={(next) => setViewArtifact(next.name)}
                        />
                        <ArtifactActions
                          projectId={projectId()}
                          artifact={artifact()}
                          fullscreen={artifactFullscreen()}
                          onToggleFullscreen={() => setArtifactFullscreen((value) => !value)}
                          onPopOut={() => popOutArtifact(artifact())}
                        />
                      </div>
                    )}
                  </Show>
                </Show>
                <div class="relative min-h-0 flex-1">
                  <For each={mountedArtifacts()}>
                    {(name) => (
                      <div
                        data-testid="artifact-pane"
                        data-artifact={name}
                        class="absolute inset-0"
                        classList={{ hidden: shownArtifact() !== name }}
                      >
                        <Show
                          when={artifactNamed(name)}
                          fallback={
                            <div class="grid h-full place-items-center text-[12px] text-faint">
                              {store.isPending(`project:${projectId()}:artifacts`) ? "Loading…" : `No artifact named ${name}.`}
                            </div>
                          }
                        >
                          {(artifact) => (
                            <ArtifactPanel
                              projectId={projectId()}
                              artifact={artifact()}
                              fullscreen={artifactFullscreen()}
                              bare={viewOnly()}
                              onToggleFullscreen={() => setArtifactFullscreen((value) => !value)}
                              onPopOut={() => popOutArtifact(artifact())}
                              onOpenSource={viewOnly() ? undefined : openSource}
                            />
                          )}
                        </Show>
                      </div>
                    )}
                  </For>
                  <Show when={developShown() ? activeFile() : undefined} keyed>
                    {(path) => (
                      <div class="absolute inset-0" classList={{ hidden: viewOnly() }}>
                        <FileView
                          projectId={projectId()}
                          path={path}
                          jump={jumpFor(path)}
                          markers={markers()}
                          onRefreshTree={() => void loadTree()}
                        />
                      </div>
                    )}
                  </Show>
                  <Show when={developShown() ? activeTopic() : undefined} keyed>
                    {(name) => (
                      <div class="absolute inset-0" classList={{ hidden: viewOnly() }}>
                        <TopicEventsView projectId={projectId()} name={name} title={topicTitle(name)} />
                      </div>
                    )}
                  </Show>
                  <Show when={!viewOnly() && tabsReady && current() === undefined}>
                    <div data-testid="tabs-empty" class="grid h-full place-items-center px-6 text-center">
                      <div>
                        <p class="text-[12px] font-medium text-body">No open tabs</p>
                        <p class="mt-1 text-[11px] text-faint">
                          Open a file from Files, or an artifact or topic from the Outline.
                        </p>
                      </div>
                    </div>
                  </Show>
                  <Show when={viewOnly() && viewArtifactSummary() === undefined}>
                    <div class="grid h-full place-items-center px-6 text-center">
                      <div>
                        <p class="text-[12px] font-medium text-body">No artifacts</p>
                        <p class="mt-1 text-[11px] text-faint">
                          Nothing to view yet. Switch to Develop to work on this project.
                        </p>
                      </div>
                    </div>
                  </Show>
                </div>
              </section>
              <Show when={developShown() && !artifactFullscreen()}>
                <Show when={!viewOnly()}>
                  <Show
                    when={maximized() === undefined && !logsCollapsed()}
                    fallback={<div class="h-2 shrink-0" />}
                  >
                    <div
                      role="separator"
                      aria-orientation="horizontal"
                      aria-label="Resize tabs and logs"
                      data-testid="project-splitter"
                      class="group flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center"
                      onPointerDown={beginResize}
                      onDblClick={resetSplit}
                    >
                      <span class="h-px w-10 rounded bg-transparent transition-colors group-hover:bg-[var(--v2-border-border-strong)]" />
                    </div>
                  </Show>
                </Show>
                <div class="min-h-0" classList={{ hidden: viewOnly() }} style={logsStyle()}>
                  <LogsPanel
                    projectId={projectId()}
                    units={units()}
                    selected={selectedUnit()}
                    onSelect={filterLogs}
                    collapsed={logsHidden()}
                    onToggleCollapsed={toggleLogsCollapsed}
                    maximized={maximized() === "logs"}
                    onToggleMaximize={() => toggleMaximize("logs")}
                  />
                </div>
              </Show>
            </div>

            <Show when={!artifactFullscreen() && !sidebarCollapsed() && detail()}>
              {(value) => (
                <ProjectSidebar
                  detail={value()}
                  timers={timers()}
                  viewOnly={viewOnly()}
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

const modeOptions: ReadonlyArray<{ readonly mode: ProjectMode; readonly label: string }> = [
  { mode: "view", label: "View" },
  { mode: "develop", label: "Develop" },
];

/** The top bar's View / Develop switch, styled as a small segmented control. */
const ProjectModeToggle = (props: {
  readonly mode: ProjectMode;
  readonly onChange: (mode: ProjectMode) => void;
}): JSX.Element => (
  <div
    role="group"
    aria-label="Project mode"
    data-testid="project-mode"
    class="flex h-7 items-center gap-0.5 rounded-md bg-[var(--v2-background-bg-layer-02)] p-0.5"
  >
    <For each={modeOptions}>
      {(option) => {
        const selected = (): boolean => props.mode === option.mode;
        return (
          <button
            type="button"
            data-testid={`project-mode-${option.mode}`}
            aria-pressed={selected()}
            class={cx(
              "h-6 rounded px-2 text-[12px] transition-colors",
              selected()
                ? "bg-canvas text-strong shadow-[var(--v2-elevation-button-neutral)]"
                : "text-muted hover:text-body",
            )}
            onClick={() => props.onChange(option.mode)}
          >
            {option.label}
          </button>
        );
      }}
    </For>
  </div>
);

interface PendingBinding {
  readonly requirement: ProjectRequirement;
  readonly instanceId: string | null;
  readonly resolve: (bound: boolean) => void;
}
