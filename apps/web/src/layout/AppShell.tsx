import { For, Show, createEffect, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { A, useLocation, useNavigate } from "@solidjs/router";
import type { RouteSectionProps } from "@solidjs/router";

import { getDesktopBridge } from "../bridge.ts";
import type { HomeRoute } from "../bridge.ts";
import { useAgent } from "../state/context.tsx";
import { connectionNeedsAttention } from "../lib/format.ts";
import { ConnectionsIcon, ProjectsIcon, SettingsIcon } from "../ui/icons.tsx";
import type { IconProps } from "../ui/icons.tsx";
import { Button, Spinner, StatusDot, cx } from "../ui/primitives.tsx";

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

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const projectIdFromPath = (path: string): string | undefined => {
  const match = /^\/projects\/([^/?#]+)/.exec(path);
  return match?.[1] === undefined ? undefined : safeDecode(match[1]);
};

const artifactFromPath = (path: string): string | undefined => {
  const match = /^\/projects\/[^/?#]+\/artifacts\/([^/?#]+)/.exec(path);
  return match?.[1] === undefined ? undefined : safeDecode(match[1]);
};

export const AppShell = (props: RouteSectionProps): JSX.Element => {
  const store = useAgent();
  const location = useLocation();
  const navigate = useNavigate();
  const bridge = getDesktopBridge();

  onMount(() => {
    store.start();
    void store.whenReady().then(() => {
      void store.loadIntegrations();
      void store.refreshProjectConsents();
    });
  });

  const projectId = (): string | undefined => projectIdFromPath(location.pathname);
  const artifactName = (): string | undefined => artifactFromPath(location.pathname);
  const projectWindow = (): boolean => projectId() !== undefined;

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

  const reconnecting = (): boolean => store.watchStatus() === "reconnecting";
  const attention = (): number =>
    store.connections().filter((connection) => connectionNeedsAttention(connection)).length;
  return (
    <div class="flex h-full min-h-0 bg-canvas text-body" data-testid="app-shell">
      <Show
        when={projectWindow()}
        fallback={
          <aside class="flex w-[204px] shrink-0 flex-col border-r border-edge bg-rail">
            <div class="px-4 pb-4 pt-5">
              <div class="flex items-baseline gap-2">
                <span class="text-[15px] font-medium tracking-[-0.03em] text-strong">
                  ballast
                </span>
                <span class="text-[10px] text-faint">agent</span>
              </div>
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
                <StatusDot
                  tone={
                    reconnecting()
                      ? "warning"
                      : store.watchStatus() === "live"
                        ? "success"
                        : "info"
                  }
                  pulse={reconnecting()}
                />
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
        }
      >
        <aside class="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-edge bg-rail py-3">
          <For each={nav}>
            {(item) => (
              <button
                type="button"
                data-testid={`project-nav-${item.label.toLowerCase()}`}
                aria-label={item.label}
                title={item.label}
                class="relative grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-body"
                onClick={() => openHome(item.route)}
              >
                <item.icon size={15} />
                <Show when={item.route === "connections" && attention() > 0}>
                  <span class="absolute right-1 top-1 size-1.5 rounded-full bg-warning" />
                </Show>
              </button>
            )}
          </For>
          <div class="mt-auto pb-1">
            <StatusDot
              tone={
                reconnecting() ? "warning" : store.watchStatus() === "live" ? "success" : "info"
              }
              pulse={reconnecting()}
            />
          </div>
        </aside>
      </Show>

      <div class="flex min-w-0 flex-1 flex-col">
        <Show when={reconnecting() && store.snapshot() !== undefined}>
          <div class="flex items-center gap-2 border-b border-edge bg-rail px-6 py-1.5 text-[11px] text-warning">
            <Spinner size={10} />
            <span>Connection lost. Showing the last state and reconnecting…</span>
          </div>
        </Show>

        <main
          class={cx(
            "min-h-0 flex-1",
            projectWindow() ? "overflow-hidden" : "overflow-y-auto",
          )}
        >
          <div
            class={
              projectWindow()
                ? "h-full min-h-0"
                : "mx-auto w-full max-w-[880px] px-8 py-8"
            }
          >
            <Show
              when={store.snapshot() !== undefined}
              fallback={
                <Show
                  when={reconnecting()}
                  fallback={
                    <div class="flex items-center gap-2 text-[12px] text-muted">
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
          </div>
        </main>
      </div>
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
