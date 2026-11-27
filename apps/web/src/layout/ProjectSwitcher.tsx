import { Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

import { useAgent } from "../state/context.tsx";
import { useShareSignIn } from "../screens/settings/SharingSection.tsx";
import { statusTone } from "../lib/project-health.ts";
import { ChevronDownIcon, CodeIcon, PlusIcon, ProjectsIcon, UploadIcon } from "../ui/icons.tsx";
import { Spinner, StatusDot, cx } from "../ui/primitives.tsx";

/**
 * The project window's top-left control: the current project and a menu to
 * share or deploy it, configure a coding agent, see all projects or create one.
 */
export const ProjectSwitcher = (props: {
  readonly projectId: string;
  readonly onAllProjects: () => void;
  readonly onNewProject: () => void;
  readonly onConnectAgent: () => void;
}): JSX.Element => {
  const store = useAgent();
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

  const current = () => store.project(props.projectId);
  const tone = () => {
    const project = current();
    return project === undefined ? "neutral" : statusTone(project);
  };
  const canShare = (): boolean => {
    const project = current();
    return project !== undefined && project.share?._tag !== "subscribed";
  };
  const sharing = (): boolean => store.isPending(`project:${props.projectId}:share`);
  const signIn = useShareSignIn();
  // Shared projects deploy to their own server; a new share goes to the default.
  const shareServer = (): string | undefined => current()?.share?.server;
  const signedIn = (): boolean => store.signedInToShareServer(shareServer());

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

  const itemClass =
    "flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[12px] text-body hover:bg-hover disabled:pointer-events-none disabled:opacity-45";

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
        onClick={() => setOpen((value) => !value)}
      >
        <StatusDot tone={tone()} />
        <span class="min-w-0 truncate text-[13px] font-medium text-strong">
          {current()?.name ?? "Project"}
        </span>
        <Show when={sharing()}>
          <Spinner size={11} />
        </Show>
        <ChevronDownIcon size={12} class="shrink-0 text-faint" />
      </button>

      <Show when={open()}>
        <div
          data-testid="project-switcher-menu"
          data-no-drag
          class="absolute left-0 top-8 z-40 w-[240px] rounded-md border border-edge-strong bg-layer p-1 shadow-[var(--v2-elevation-overlay)]"
        >
          <Show when={canShare()}>
            <button
              type="button"
              data-testid="share-project"
              title={
                !signedIn()
                  ? "Sign in with Anomaly to share projects"
                  : current()?.share === undefined
                    ? "Share through your share server and get a share code"
                    : "Deploy the current files to subscribers"
              }
              disabled={sharing()}
              class={itemClass}
              onClick={() => {
                setOpen(false);
                if (!signedIn()) void signIn(shareServer());
                else void store.shareProject(props.projectId);
              }}
            >
              <UploadIcon size={13} class="text-faint" />
              {!signedIn() ? "Sign in to share" : current()?.share === undefined ? "Share" : "Deploy"}
            </button>
            <button
              type="button"
              data-testid="connect-agent"
              title="Write MCP configs so a coding agent can build this project"
              class={itemClass}
              onClick={() => {
                setOpen(false);
                props.onConnectAgent();
              }}
            >
              <CodeIcon size={13} class="text-faint" />
              Configure coding agent…
            </button>
            <div class="-mx-1 my-1 border-t border-edge" />
          </Show>
          <button
            type="button"
            data-testid="project-switcher-all"
            class={itemClass}
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
            class={itemClass}
            onClick={() => {
              setOpen(false);
              props.onNewProject();
            }}
          >
            <PlusIcon size={13} class="text-faint" />
            New project…
          </button>
        </div>
      </Show>
    </div>
  );
};
