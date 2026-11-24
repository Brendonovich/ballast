import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

import { useAgent } from "../state/context.tsx";
import { insetTitleBar } from "../lib/titlebar.ts";
import { projectDisplayStatus } from "../lib/project-status.ts";
import { ChevronDownIcon, ExternalLinkIcon, PlusIcon, ProjectsIcon } from "../ui/icons.tsx";
import { IconButton, StatusDot, cx } from "../ui/primitives.tsx";

/**
 * The project window's top-left control: the current project and a menu to
 * switch the window to another one, see all projects or create one.
 */
export const ProjectSwitcher = (props: {
  readonly projectId: string;
  /** Desktop only: rows get an "Open in new window" button and Cmd/Ctrl-click. */
  readonly canOpenWindows: boolean;
  readonly onSelect: (projectId: string, options: { readonly newWindow: boolean }) => void;
  readonly onAllProjects: () => void;
  readonly onNewProject: () => void;
}): JSX.Element => {
  const store = useAgent();
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

  const statusOf = (projectId: string) => {
    const project = store.project(projectId);
    return project === undefined
      ? undefined
      : projectDisplayStatus(project, store.projectDetail(projectId), store.projectConsent(projectId));
  };

  const current = () => store.project(props.projectId);

  onMount(() => {
    const onPointer = (event: PointerEvent): void => {
      if (!open() || root === undefined) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && open()) {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    });
  });

  const choose = (projectId: string, newWindow: boolean): void => {
    setOpen(false);
    props.onSelect(projectId, { newWindow });
  };

  return (
    <div ref={root} class="relative min-w-0">
      <button
        type="button"
        data-testid="project-switcher"
        aria-haspopup="true"
        aria-expanded={open()}
        class={cx(
          "flex h-7 max-w-[280px] items-center gap-2 rounded-md px-2 text-left transition-colors",
          open() ? "bg-hover" : "hover:bg-hover",
        )}
        onClick={() => {
          const next = !open();
          setOpen(next);
          // Rows show the same status as the projects list, which needs details.
          if (next) {
            for (const project of store.projects()) void store.fetchProject(project.id);
          }
        }}
      >
        <StatusDot tone={statusOf(props.projectId)?.tone ?? "neutral"} />
        <span class="min-w-0 truncate text-[13px] font-medium text-strong">
          {current()?.name ?? "Project"}
        </span>
        <ChevronDownIcon size={12} class="shrink-0 text-faint" />
      </button>

      <Show when={open()}>
        <div
          data-testid="project-switcher-menu"
          data-no-drag
          class="absolute left-0 top-8 z-40 w-[300px] rounded-md border border-edge-strong bg-layer py-1 shadow-[var(--v2-elevation-overlay)]"
        >
          <p class="px-3 pb-1 pt-1.5 text-[10px] text-faint">Projects</p>
          <div class="max-h-[50vh] overflow-y-auto">
            <For each={store.projects()}>
              {(project) => {
                const isCurrent = (): boolean => project.id === props.projectId;
                return (
                  <div
                    data-testid="project-switcher-row"
                    data-project-id={project.id}
                    data-current={isCurrent() ? "true" : undefined}
                    class={cx(
                      "group mx-1 flex items-center gap-1 rounded",
                      isCurrent() ? "bg-layer-2" : "hover:bg-hover",
                    )}
                  >
                    <button
                      type="button"
                      aria-current={isCurrent() ? "page" : undefined}
                      class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                      onClick={(event) =>
                        choose(project.id, props.canOpenWindows && (event.metaKey || event.ctrlKey))
                      }
                    >
                      <StatusDot tone={statusOf(project.id)?.tone ?? "neutral"} />
                      <span class="min-w-0 flex-1">
                        <span
                          class={cx(
                            "block truncate text-[12px]",
                            isCurrent() ? "font-medium text-strong" : "text-body",
                          )}
                        >
                          {project.name}
                        </span>
                        <span class="block truncate text-[10px] text-faint">
                          {statusOf(project.id)?.label}
                        </span>
                      </span>
                    </button>
                    <Show when={props.canOpenWindows && !isCurrent()}>
                      <IconButton
                        label={`Open ${project.name} in a new window`}
                        size="small"
                        testId="project-switcher-new-window"
                        class="mr-1 opacity-60 group-hover:opacity-100"
                        onClick={() => choose(project.id, true)}
                      >
                        <ExternalLinkIcon size={12} />
                      </IconButton>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
          <div class="mt-1 border-t border-edge px-1 pt-1">
            <button
              type="button"
              data-testid="project-switcher-all"
              class="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[12px] text-body hover:bg-hover"
              onClick={() => {
                setOpen(false);
                props.onAllProjects();
              }}
            >
              <ProjectsIcon size={13} class="text-faint" />
              All projects
            </button>
            <button
              type="button"
              data-testid="project-switcher-new"
              class="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[12px] text-body hover:bg-hover"
              onClick={() => {
                setOpen(false);
                props.onNewProject();
              }}
            >
              <PlusIcon size={13} class="text-faint" />
              New project…
            </button>
          </div>
          <Show when={props.canOpenWindows}>
            <p class="px-3 pb-1 pt-1.5 text-[10px] text-faint">
              {insetTitleBar() ? "⌘" : "Ctrl"}-click or use the window icon to open in a new window.
            </p>
          </Show>
        </div>
      </Show>
    </div>
  );
};
