import { For, Show } from "solid-js";
import type { JSX } from "solid-js";

import { tabKey } from "../../lib/project-tabs.ts";
import type { ProjectTab } from "../../lib/project-tabs.ts";
import { ArtifactIcon, CloseIcon, EventsIcon, FileIcon } from "../../ui/icons.tsx";
import { cx } from "../../ui/primitives.tsx";

const iconFor = (tab: ProjectTab, size: number): JSX.Element => {
  switch (tab.kind) {
    case "file":
      return <FileIcon size={size} />;
    case "artifact":
      return <ArtifactIcon size={size} />;
    case "topic":
      return <EventsIcon size={size} />;
  }
};

/**
 * Tabs for the project's middle area, styled after OpenCode's pane tabs
 * (packages/ui/src/navigation/tabs/tabs.css): 28px pills, muted text, the
 * selected one on layer-02, a hairline under the strip.
 */
export const TabStrip = (props: {
  readonly tabs: ReadonlyArray<ProjectTab>;
  readonly active: string | undefined;
  readonly label: (tab: ProjectTab) => string;
  readonly title: (tab: ProjectTab) => string;
  /** A dot before the label, e.g. a failed artifact build. */
  readonly danger?: (tab: ProjectTab) => boolean;
  readonly onActivate: (key: string) => void;
  readonly onClose: (key: string) => void;
  readonly end?: JSX.Element;
}): JSX.Element => (
  <div class="flex h-10 shrink-0 items-center gap-1 border-b-[0.5px] border-[var(--v2-border-border-base)] pl-1.5 pr-1.5">
    <div
      role="tablist"
      aria-label="Open tabs"
      data-testid="project-tabs"
      class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
    >
      <For each={props.tabs}>
        {(tab) => {
          const key = tabKey(tab);
          const selected = (): boolean => props.active === key;
          return (
            <div
              role="tab"
              tabIndex={selected() ? 0 : -1}
              aria-selected={selected()}
              data-testid="project-tab"
              data-tab={key}
              data-kind={tab.kind}
              data-selected={selected() ? "true" : undefined}
              title={props.title(tab)}
              class={cx(
                "group flex h-7 min-w-[72px] max-w-[220px] shrink-0 items-center gap-1.5 rounded-md pl-2.5 pr-1 text-[13px] leading-4 transition-colors",
                selected()
                  ? "bg-[var(--v2-background-bg-layer-02)] text-body"
                  : "text-muted hover:bg-hover",
              )}
              onClick={() => props.onActivate(key)}
              onMouseDown={(event) => {
                // Keep middle-click from starting autoscroll.
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                props.onClose(key);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  props.onActivate(key);
                }
              }}
            >
              <span class={cx("shrink-0", selected() ? "text-muted" : "text-faint")}>{iconFor(tab, 13)}</span>
              <Show when={props.danger?.(tab) === true}>
                <span class="size-1.5 shrink-0 rounded-full bg-danger" aria-label="failed" />
              </Show>
              <span class="min-w-0 flex-1 truncate">{props.label(tab)}</span>
              <button
                type="button"
                data-testid="project-tab-close"
                aria-label={`Close ${props.label(tab)}`}
                title="Close"
                class={cx(
                  "grid size-5 shrink-0 place-items-center rounded text-faint hover:bg-hover hover:text-body",
                  selected() ? "visible" : "invisible group-hover:visible",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onClose(key);
                }}
              >
                <CloseIcon size={11} />
              </button>
            </div>
          );
        }}
      </For>
    </div>
    <Show when={props.end}>
      <div class="flex shrink-0 items-center gap-0.5">{props.end}</div>
    </Show>
  </div>
);
