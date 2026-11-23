import { For, Show, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { A, useLocation } from "@solidjs/router";
import type { RouteSectionProps } from "@solidjs/router";

import { useAgent } from "../state/context.tsx";
import {
  blockingRequirements,
  connectionNeedsAttention,
  projectStatusLabel,
  projectStatusTone,
} from "../lib/format.ts";
import { ConnectionsIcon, ProjectsIcon, SettingsIcon } from "../ui/icons.tsx";
import type { IconProps } from "../ui/icons.tsx";
import { Button, Spinner, StatusDot, cx } from "../ui/primitives.tsx";

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: (props: IconProps) => JSX.Element;
  readonly active: (path: string) => boolean;
}

const nav: ReadonlyArray<NavItem> = [
  {
    href: "/projects",
    label: "Projects",
    icon: ProjectsIcon,
    active: (path) => path === "/" || path.startsWith("/projects"),
  },
  {
    href: "/connections",
    label: "Connections",
    icon: ConnectionsIcon,
    active: (path) => path.startsWith("/connections"),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: SettingsIcon,
    active: (path) => path.startsWith("/settings"),
  },
];

const projectHref = (projectId: string): string =>
  `/projects/${encodeURIComponent(projectId)}`;

export const AppShell = (props: RouteSectionProps): JSX.Element => {
  const store = useAgent();
  const location = useLocation();

  onMount(() => {
    store.start();
    void store.whenReady().then(() => store.refreshProjectConsents());
  });

  const reconnecting = (): boolean => store.watchStatus() === "reconnecting";
  const workspace = (): boolean => {
    const path = location.pathname;
    return path.startsWith("/projects/") && path !== "/projects/";
  };
  const attention = (): number =>
    store.connections().filter((connection) => connectionNeedsAttention(connection)).length;
  const needsConnections = (projectId: string): boolean => {
    const detail = store.projectDetail(projectId);
    return detail !== undefined && blockingRequirements(detail.requirements).length > 0;
  };

  return (
    <div class="flex h-full min-h-0 bg-canvas text-body" data-testid="app-shell">
      <aside class="flex w-[204px] shrink-0 flex-col border-r border-edge bg-rail">
        <div class="px-4 pb-4 pt-5">
          <div class="flex items-baseline gap-2">
            <span class="text-[15px] font-medium tracking-[-0.03em] text-strong">ballast</span>
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
                  <Show when={item.href === "/connections" && attention() > 0}>
                    <span class="size-1.5 rounded-full bg-warning" aria-label="needs attention" />
                  </Show>
                </A>
              );
            }}
          </For>
        </nav>

        <div class="mt-5 min-h-0 flex-1 overflow-y-auto px-2">
          <p class="px-2 pb-1 text-[10px] text-faint">Projects</p>
          <Show
            when={store.projects().length > 0}
            fallback={<p class="px-2 py-1 text-[11px] text-faint">No projects</p>}
          >
            <For each={store.projects()}>
              {(project) => (
                <A
                  href={projectHref(project.id)}
                  data-testid="sidebar-project"
                  data-project-id={project.id}
                  data-status={
                    needsConnections(project.id)
                      ? "needs-connections"
                      : store.projectConsent(project.id) !== undefined
                        ? "needs-consent"
                        : project.status
                  }
                  class={cx(
                    "flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors",
                    location.pathname === projectHref(project.id)
                      ? "bg-[var(--v2-background-bg-layer-02)]"
                      : "hover:bg-hover",
                  )}
                >
                  <StatusDot
                    tone={
                      store.projectConsent(project.id) !== undefined ||
                      needsConnections(project.id)
                        ? "warning"
                        : projectStatusTone(project)
                    }
                    class="mt-1.5"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-[12px] text-body">{project.name}</span>
                    <span class="block truncate text-[10px] text-faint">
                      {needsConnections(project.id)
                        ? "Needs connections"
                        : store.projectConsent(project.id) !== undefined
                          ? "Needs consent"
                          : project.status === "error" && project.enabled
                            ? "Running previous version"
                            : projectStatusLabel(project)}
                    </span>
                  </span>
                </A>
              )}
            </For>
          </Show>
        </div>

        <div class="px-4 py-3">
          <div class="flex items-center gap-2 text-[11px] text-faint">
            <StatusDot
              tone={reconnecting() ? "warning" : store.watchStatus() === "live" ? "success" : "info"}
              pulse={reconnecting()}
            />
            <span>{reconnecting() ? "Reconnecting" : "Connected"}</span>
            <span class="ml-auto truncate font-mono" title={store.transport.note}>
              {store.transport.kind === "mock" ? "mock" : store.transport.label}
            </span>
          </div>
          <Show when={store.info()}>
            {(info) => (
              <p class="mt-1 truncate font-mono text-[10px] text-faint">{info().version}</p>
            )}
          </Show>
        </div>
      </aside>

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
            workspace() ? "overflow-hidden" : "overflow-y-auto",
          )}
        >
          <div
            class={
              workspace()
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
