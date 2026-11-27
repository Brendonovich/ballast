import { Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

import { actionLabel } from "../../lib/project-health.ts";
import type { ProjectAction } from "../../lib/project-health.ts";
import { ChevronDownIcon, PlayIcon, RefreshIcon, StopIcon } from "../../ui/icons.tsx";
import { Button, Spinner, cx } from "../../ui/primitives.tsx";

/** Top-bar Start/Stop. While the project runs, its dropdown offers Restart. */
export const RunButton = (props: {
  readonly action: ProjectAction;
  readonly canRestart: boolean;
  readonly loading: boolean;
  readonly restarting: boolean;
  readonly onAction: () => void;
  readonly onRestart: () => void;
}): JSX.Element => {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

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

  const split = (): boolean => props.canRestart;

  return (
    <div ref={root} class="relative flex items-center">
      <Button
        size="small"
        variant={props.action === "start" ? "primary" : "outline"}
        class={cx("h-7", split() && "rounded-r-none")}
        data-testid="toggle-project"
        data-action={props.action}
        loading={props.loading || props.restarting}
        icon={
          props.action === "stop" ? (
            <StopIcon size={12} />
          ) : props.action === "start" ? (
            <PlayIcon size={12} />
          ) : undefined
        }
        onClick={() => props.onAction()}
      >
        {actionLabel(props.action)}
      </Button>
      <Show when={split()}>
        <button
          type="button"
          data-testid="project-run-menu"
          aria-label="More run options"
          aria-haspopup="true"
          aria-expanded={open()}
          disabled={props.loading || props.restarting}
          class={cx(
            "inline-flex h-7 w-6 items-center justify-center rounded-r-md border border-l-0 border-edge-strong text-muted transition-colors hover:bg-hover hover:text-body disabled:pointer-events-none disabled:opacity-45",
            open() && "bg-hover",
          )}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDownIcon size={12} />
        </button>
      </Show>
      <Show when={open() && split()}>
        <div
          data-testid="project-run-options"
          data-no-drag
          class="absolute right-0 top-8 z-40 w-[160px] rounded-md border border-edge-strong bg-layer p-1 shadow-[var(--v2-elevation-overlay)]"
        >
          <button
            type="button"
            data-testid="restart-project"
            disabled={props.restarting}
            class="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[12px] text-body hover:bg-hover disabled:pointer-events-none disabled:opacity-45"
            onClick={() => {
              setOpen(false);
              props.onRestart();
            }}
          >
            <Show when={props.restarting} fallback={<RefreshIcon size={13} class="text-faint" />}>
              <Spinner size={12} />
            </Show>
            Restart
          </button>
        </div>
      </Show>
    </div>
  );
};
