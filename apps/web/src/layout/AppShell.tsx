import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { A, useLocation, useNavigate } from "@solidjs/router";
import type { RouteSectionProps } from "@solidjs/router";

import { getDesktopBridge } from "../bridge.ts";
import type { HomeRoute } from "../bridge.ts";
import { useAgent } from "../state/context.tsx";
import { connectionNeedsAttention } from "../lib/format.ts";
import { issueTarget } from "../lib/project-health.ts";
import { focusConnection, requestProjectIntent } from "../lib/project-intent.ts";
import type { ProjectIssue } from "@ballast/agent-protocol";
import { ProjectStatusButton } from "./IssuesPopover.tsx";
import { TRAFFIC_LIGHT_INSET, insetTitleBar } from "../lib/titlebar.ts";
import { ConnectionsIcon, PanelLeftIcon, ProjectsIcon, SettingsIcon } from "../ui/icons.tsx";
import { isSidebarShortcut } from "../lib/sidebar-layout.ts";
import { leftSidebarHidden, toggleLeftSidebar } from "../state/left-sidebar.ts";
import { projectMode } from "../state/project-mode.ts";
import {
  artifactFromPath,
  projectIdFromPath,
  projectPath,
  projectSectionFromPath,
  projectSectionPath,
} from "../lib/routes.ts";
import type { ProjectSection } from "../lib/routes.ts";
import type { IconProps } from "../ui/icons.tsx";
import { Button, Spinner, StatusDot, cx } from "../ui/primitives.tsx";
import { NewProjectDialog } from "../screens/ProjectsScreen.tsx";
import { AgentSetupDialog } from "../screens/project/AgentSetup.tsx";
import { ONBOARDING_PATH } from "../lib/onboarding.ts";
import { ProjectSwitcher } from "./ProjectSwitcher.tsx";
import { TopBarCenterContext, TopBarEndContext, TopBarSlotContext } from "./top-bar-slot.tsx";

interface NavItem {
  readonly route: HomeRoute;
  readonly href: string;
  readonly label: string;
  readonly icon: (props: IconProps) => JSX.Element;
  readonly active: (path: string) => boolean;
}

const nav: ReadonlyArray<NavItem> = [
  {
    route: "projects",
    href: "/projects",
    label: "Projects",
    icon: ProjectsIcon,
    active: (path) => path === "/" || path.startsWith("/projects"),
  },
  {
    route: "connections",
    href: "/connections",
    label: "Connections",
    icon: ConnectionsIcon,
    active: (path) => path.startsWith("/connections"),
  },
  {
    route: "settings",
    href: "/settings",
    label: "Settings",
    icon: SettingsIcon,
    active: (path) => path.startsWith("/settings"),
  },
];

interface SectionItem {
  readonly section: ProjectSection;
  readonly label: string;
  readonly icon: (props: IconProps) => JSX.Element;
}

const sections: ReadonlyArray<SectionItem> = [
  { section: "connections", label: "Connections", icon: ConnectionsIcon },
];

const sectionTitle: Record<ProjectSection, string> = {
  connections: "Connections",
};

export const AppShell = (props: RouteSectionProps): JSX.Element => {
  const store = useAgent();
  const location = useLocation();
  const navigate = useNavigate();
  const bridge = getDesktopBridge();
  const inset = insetTitleBar();
  const [actionSlot, setActionSlot] = createSignal<HTMLElement>();
  const [centerSlot, setCenterSlot] = createSignal<HTMLElement>();
  const [endSlot, setEndSlot] = createSignal<HTMLElement>();
  const [creating, setCreating] = createSignal(false);
  const [connectingAgent, setConnectingAgent] = createSignal(false);

  onMount(() => {
    store.start();
    void store.whenReady().then(() => {
      void store.loadIntegrations();
      void store.refreshProjectConsents();
    });
  });

  const projectId = (): string | undefined => projectIdFromPath(location.pathname);
  const artifactName = (): string | undefined => artifactFromPath(location.pathname);
  const section = (): ProjectSection | undefined => projectSectionFromPath(location.pathname);
  const projectWindow = (): boolean => projectId() !== undefined;
  /** The project view itself, where the left sidebar lives. */
  const projectView = (): boolean =>
    projectWindow() && section() === undefined && artifactName() === undefined;
  /** View mode fixes both panes, so the sidebar toggle and shortcut are off. */
  const viewMode = (): boolean => {
    const id = projectId();
    return id !== undefined && projectMode(id) === "view";
  };
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const shortcutLabel = mac ? "⌘B" : "Ctrl+B";

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!projectView() || viewMode() || !isSidebarShortcut(event, mac)) return;
      event.preventDefault();
      toggleLeftSidebar();
    };
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  createEffect(() => {
    // Artifact windows only show the artifact; they do not need project logs.
    store.setLogProject(artifactName() === undefined ? projectId() : undefined);
  });

  createEffect(() => {
    const id = projectId();
    if (id === undefined) {
      document.title = "Ballast";
      return;
    }
    const project = store.project(id);
    const current = section();
    if (current !== undefined) {
      document.title =
        project === undefined
          ? `${sectionTitle[current]} — Ballast`
          : `${sectionTitle[current]} — ${project.name} — Ballast`;
      return;
    }
    const name = artifactName();
    if (name !== undefined) {
      const artifact = store.artifacts(id).find((entry) => entry.name === name);
      const label = artifact?.title ?? artifact?.name ?? name;
      document.title =
        project === undefined
          ? `${label} — Ballast`
          : `${label} — ${project.name} — Ballast`;
      return;
    }
    document.title = project === undefined ? "Ballast" : `${project.name} — Ballast`;
  });

  createEffect(() => {
    if (bridge === undefined) return;
    const projects = store.projects().map((project) => ({
      id: project.id,
      name: project.name,
    }));
    void bridge.projects.setMenu(projects);
  });

  const openHome = (route: HomeRoute): void => {
    if (bridge !== undefined) {
      void bridge.windows.openHome(route);
      return;
    }
    navigate(route === "projects" ? "/projects" : `/${route}`);
  };

  // Connections replaces the project view in place; the route
  // keeps the project id, so the window stays scoped to its project.
  const openSection = (target: ProjectSection): void => {
    const id = projectId();
    if (id !== undefined) navigate(projectSectionPath(id, target));
  };

  /**
   * Switch this window to a project. In the desktop app main re-scopes the
   * window (title, record, restore) or focuses the window already showing
   * it, so windows stay one per project.
   */
  const selectProject = async (
    target: string,
    options: { readonly newWindow: boolean },
  ): Promise<void> => {
    if (bridge !== undefined && options.newWindow) {
      await bridge.windows.openProjectWindow(target, { newWindow: true });
      return;
    }
    if (target === projectId()) {
      navigate(projectPath(target));
      return;
    }
    if (bridge !== undefined) {
      try {
        const result = await bridge.windows.rescopeProject(target);
        if (result.outcome === "focused") return;
      } catch {
        return;
      }
    }
    navigate(projectPath(target));
  };

  /**
   * An issue picked in the status popover. Connection issues open
   * Connections; everything else is shown by the project view.
   */
  const openIssue = (issue: ProjectIssue): void => {
    const id = projectId();
    if (id === undefined) return;
    const target = issueTarget(issue);
    if (target.kind === "none") return;
    if (target.kind === "connection") {
      focusConnection(target.connectionId);
      navigate(projectSectionPath(id, "connections"));
      return;
    }
    requestProjectIntent(id, { kind: "target", target });
    if (section() !== undefined) navigate(projectPath(id));
  };

  const reconnecting = (): boolean => store.watchStatus() === "reconnecting";
  const attention = (): number =>
    store.connections().filter((connection) => connectionNeedsAttention(connection)).length;
  const serviceTone = () =>
    reconnecting() ? "warning" : store.watchStatus() === "live" ? "success" : "info";

  // The project window's bar sits on the window background with no rule
  // under it; the panes below are raised surfaces (as in OpenCode's desktop app).
  const barClass = (variant: "project" | "artifact"): string =>
    cx(
      "relative flex h-[34px] shrink-0 items-center gap-2 bg-rail pt-1.5 pr-2",
      variant === "artifact" && "border-b border-edge",
      inset ? "titlebar-drag" : "pl-2",
    );
  const barStyle = (): JSX.CSSProperties | undefined =>
    inset ? { "padding-left": `${TRAFFIC_LIGHT_INSET}px` } : undefined;

  const content = (): JSX.Element => (
    <Show
      when={store.snapshot() !== undefined}
      fallback={
        <Show
          when={reconnecting()}
          fallback={
            <div class="flex items-center gap-2 p-6 text-[12px] text-muted">
              <Spinner size={12} /> Loading…
            </div>
          }
        >
          <ConnectionFailed />
        </Show>
      }
    >
      {props.children}
    </Show>
  );

  const reconnectBanner = (): JSX.Element => (
    <Show when={reconnecting() && store.snapshot() !== undefined}>
      <div class="flex items-center gap-2 border-b border-edge bg-rail px-6 py-1.5 text-[11px] text-warning">
        <Spinner size={10} />
        <span>Connection lost. Showing the last state and reconnecting…</span>
      </div>
    </Show>
  );

  return (
    <div
      class={cx("flex h-full min-h-0 text-body", projectWindow() && artifactName() === undefined ? "bg-rail" : "bg-canvas")}
      data-testid="app-shell"
    >
      <Show
        when={projectWindow()}
        fallback={
          <Show
            when={location.pathname !== ONBOARDING_PATH}
            fallback={
              // Onboarding takes the whole home window; it has its own Skip.
              <div class="flex min-w-0 flex-1 flex-col">
                <Show when={inset}>
                  <div class="titlebar-drag h-[28px] shrink-0" aria-hidden="true" />
                </Show>
                {reconnectBanner()}
                <main class="min-h-0 flex-1 overflow-y-auto">{content()}</main>
              </div>
            }
          >
            <aside class="flex w-[204px] shrink-0 flex-col border-r border-edge bg-rail">
              <div
                class={cx("flex items-baseline gap-2", inset ? "titlebar-drag h-14 items-end pb-3" : "px-4 pb-4 pt-5")}
                style={inset ? { "padding-left": `${TRAFFIC_LIGHT_INSET}px` } : undefined}
              >
                <span class="text-[15px] font-medium tracking-[-0.03em] text-strong">ballast</span>
                <span class="text-[10px] text-faint">agent</span>
              </div>

              <nav class="space-y-0.5 px-2">
                <For each={nav}>
                  {(item) => {
                    const active = (): boolean => item.active(location.pathname);
                    return (
                      <A
                        href={item.href}
                        data-testid={`nav-${item.label.toLowerCase()}`}
                        class={cx(
                          "flex h-7 items-center gap-2 rounded-md px-2 text-[13px] transition-colors",
                          active()
                            ? "bg-[var(--v2-background-bg-layer-02)] text-strong"
                            : "text-muted hover:bg-hover hover:text-body",
                        )}
                      >
                        <item.icon size={14} class={active() ? "text-body" : "text-faint"} />
                        <span class="flex-1">{item.label}</span>
                        <Show when={item.route === "connections" && attention() > 0}>
                          <span
                            class="size-1.5 rounded-full bg-warning"
                            aria-label="needs attention"
                          />
                        </Show>
                      </A>
                    );
                  }}
                </For>
              </nav>

              <div class="mt-auto px-4 py-3">
                <div class="flex items-center gap-2 text-[11px] text-faint">
                  <StatusDot tone={serviceTone()} pulse={reconnecting()} />
                  <span>{reconnecting() ? "Reconnecting" : "Connected"}</span>
                  <span class="ml-auto truncate font-mono" title={store.transport.note}>
                    {store.transport.kind === "mock" ? "mock" : store.transport.label}
                  </span>
                </div>
                <Show when={store.info()}>
                  {(info) => (
                    <p class="mt-1 truncate font-mono text-[10px] text-faint">
                      {info().version}
                    </p>
                  )}
                </Show>
              </div>
            </aside>

            <div class="flex min-w-0 flex-1 flex-col">
              <Show when={inset}>
                <div class="titlebar-drag h-[24px] shrink-0" aria-hidden="true" />
              </Show>
              {reconnectBanner()}
              <main class="min-h-0 flex-1 overflow-y-auto">
                <div class={cx("mx-auto w-full max-w-[880px] px-8", inset ? "pb-8 pt-2" : "py-8")}>
                  {content()}
                </div>
              </main>
            </div>
          </Show>
        }
      >
        <div class="flex min-w-0 flex-1 flex-col">
          <Show
            when={artifactName() === undefined}
            fallback={
              // Pop-out artifact windows only name what they show.
              <header data-testid="top-bar" data-variant="artifact" class={barClass("artifact")} style={barStyle()}>
                <span class="min-w-0 truncate text-[12px] font-medium text-strong" data-testid="top-bar-artifact">
                  {store.artifacts(projectId() ?? "").find((entry) => entry.name === artifactName())
                    ?.title ?? artifactName()}
                </span>
                <span class="shrink-0 text-faint">·</span>
                <span class="min-w-0 truncate text-[12px] text-muted" data-testid="top-bar-project">
                  {store.project(projectId() ?? "")?.name ?? ""}
                </span>
              </header>
            }
          >
            <header data-testid="top-bar" data-variant="project" class={barClass("project")} style={barStyle()}>
              <button
                type="button"
                data-testid="toggle-left-sidebar"
                aria-label={leftSidebarHidden() ? "Show sidebar" : "Hide sidebar"}
                aria-pressed={!leftSidebarHidden()}
                aria-keyshortcuts={mac ? "Meta+B" : "Control+B"}
                title={
                  viewMode()
                    ? "The sidebar is available in Develop"
                    : `${leftSidebarHidden() ? "Show sidebar" : "Hide sidebar"} (${shortcutLabel})`
                }
                disabled={viewMode()}
                class={cx(
                  "grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors enabled:hover:bg-hover enabled:hover:text-body disabled:opacity-40",
                  !projectView() && "invisible",
                )}
                tabIndex={projectView() ? 0 : -1}
                onClick={toggleLeftSidebar}
              >
                <PanelLeftIcon size={15} />
              </button>
              <div class="flex min-w-0 items-center gap-1">
                <ProjectSwitcher
                  projectId={projectId() ?? ""}
                  onAllProjects={() => openHome("projects")}
                  onNewProject={() => setCreating(true)}
                  onConnectAgent={() => setConnectingAgent(true)}
                />
                <Show when={store.project(projectId() ?? "")}>
                  {(project) => <ProjectStatusButton project={project()} onSelect={openIssue} />}
                </Show>
              </div>
              <span class="min-w-0 flex-1" />
              <div
                ref={setCenterSlot}
                data-testid="top-bar-center"
                class="absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center pt-1.5"
              />
              <div ref={setActionSlot} data-testid="top-bar-actions" class="flex shrink-0 items-center" />
              <nav class="flex shrink-0 items-center gap-0.5" aria-label="Service">
                <For each={sections}>
                  {(item) => {
                    const active = (): boolean => section() === item.section;
                    return (
                      <button
                        type="button"
                        data-testid={`project-nav-${item.section}`}
                        aria-current={active() ? "page" : undefined}
                        title={item.label}
                        class={cx(
                          "relative inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors",
                          active()
                            ? "bg-[var(--v2-background-bg-layer-02)] text-strong"
                            : "text-muted hover:bg-hover hover:text-body",
                        )}
                        onClick={() => openSection(item.section)}
                      >
                        <item.icon size={14} />
                        <span class="hidden lg:inline">{item.label}</span>
                        <Show when={item.section === "connections" && attention() > 0}>
                          <span
                            data-testid="connections-attention"
                            aria-label="Connections need attention"
                            class="absolute right-1 top-1 size-1.5 rounded-full bg-warning"
                          />
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </nav>
              <div ref={setEndSlot} data-testid="top-bar-end" class="flex shrink-0 items-center" />
            </header>
          </Show>
          {reconnectBanner()}
          <main class="min-h-0 flex-1 overflow-hidden">
            <TopBarSlotContext.Provider value={actionSlot}>
              <TopBarCenterContext.Provider value={centerSlot}>
                <TopBarEndContext.Provider value={endSlot}>
                  <div class="h-full min-h-0">{content()}</div>
                </TopBarEndContext.Provider>
              </TopBarCenterContext.Provider>
            </TopBarSlotContext.Provider>
          </main>
        </div>
      </Show>

      <Show when={connectingAgent() ? store.project(projectId() ?? "") : undefined}>
        {(project) => (
          <AgentSetupDialog
            projectId={project().id}
            projectName={project().name}
            onClose={() => setConnectingAgent(false)}
          />
        )}
      </Show>

      <Show when={creating()}>
        <NewProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(detail) => {
            setCreating(false);
            void selectProject(detail.summary.id, { newWindow: false });
          }}
        />
      </Show>
    </div>
  );
};

const ConnectionFailed = (): JSX.Element => {
  const store = useAgent();
  const mockHref = `${window.location.pathname}${window.location.hash}`;
  return (
    <div class="py-20 text-center" data-testid="agent-unavailable">
      <p class="text-[13px] font-medium text-strong">Can't reach the Ballast agent</p>
      <p class="mx-auto mt-1 max-w-sm text-[12px] text-muted">
        Trying to connect to {store.transport.label}. Start the service or open mock mode.
      </p>
      <Show when={store.transport.rpcUrl}>
        <p class="mx-auto mt-3 max-w-md break-all font-mono text-[10px] text-faint">
          {store.transport.rpcUrl}
        </p>
      </Show>
      <div class="mt-5 flex items-center justify-center gap-2">
        <Button size="normal" variant="neutral" onClick={() => void store.refresh()}>
          Retry
        </Button>
        <a
          href={mockHref}
          class="inline-flex h-7 items-center rounded-md border border-edge-strong px-2.5 text-[13px] text-body hover:bg-hover"
        >
          Open mock mode
        </a>
      </div>
    </div>
  );
};
