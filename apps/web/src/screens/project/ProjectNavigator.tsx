import { For, Show, createEffect, createSignal, on } from "solid-js";
import type { JSX } from "solid-js";
import type { ArtifactSummary } from "@ballast/agent-protocol";

import {
  artifactErrorSource,
  artifactStatusLabel,
  artifactStatusTone,
  unitStatusTone,
} from "../../lib/format.ts";
import {
  DEFAULT_OUTLINE,
  clampOutlineHeight,
  outlineStorageKey,
  parseOutlineLayout,
} from "../../lib/outline.ts";
import type { OutlineGroup, OutlineItem, OutlineLayout } from "../../lib/outline.ts";
import { ChevronDownIcon, CodeIcon } from "../../ui/icons.tsx";
import { StatusDot, cx } from "../../ui/primitives.tsx";

const readLayout = (projectId: string): OutlineLayout => {
  try {
    return parseOutlineLayout(window.localStorage.getItem(outlineStorageKey(projectId)));
  } catch {
    return DEFAULT_OUTLINE;
  }
};

const writeLayout = (projectId: string, layout: OutlineLayout): void => {
  try {
    window.localStorage.setItem(outlineStorageKey(projectId), JSON.stringify(layout));
  } catch {
    // Non-critical.
  }
};

const sourceLabel = (file: string, line: number): string =>
  `${file.split("/").at(-1) ?? file}:${line}`;

/**
 * The project's left column: views on top (artifacts, then the source view),
 * and the outline of everything else underneath, collapsed by default.
 */
export const ProjectNavigator = (props: {
  readonly projectId: string;
  readonly artifacts: ReadonlyArray<ArtifactSummary>;
  readonly selectedArtifact: string | undefined;
  readonly onOpenArtifact: (artifact: ArtifactSummary) => void;
  readonly onViewSource: () => void;
  readonly outline: ReadonlyArray<OutlineGroup>;
  readonly selectedItem: string | undefined;
  readonly onSelectItem: (item: OutlineItem) => void;
  readonly onOpenSource: (file: string, line: number) => void;
  /** Open the outline and scroll this item into view (from an issue). */
  readonly reveal?: { readonly key: string; readonly token: number } | undefined;
}): JSX.Element => {
  const [layout, setLayout] = createSignal<OutlineLayout>(DEFAULT_OUTLINE);
  let column: HTMLDivElement | undefined;

  createEffect(
    on(
      () => props.projectId,
      (projectId) => setLayout(readLayout(projectId)),
    ),
  );

  const update = (next: OutlineLayout): void => {
    setLayout(next);
    writeLayout(props.projectId, next);
  };

  const toggleOutline = (): void => update({ ...layout(), open: !layout().open });

  createEffect(
    on(
      () => props.reveal?.token,
      () => {
        const target = props.reveal;
        if (target === undefined) return;
        if (!layout().open) update({ ...layout(), open: true });
        requestAnimationFrame(() => {
          const row = column?.querySelector(
            `[data-testid="outline-row"][data-key="${CSS.escape(target.key)}"]`,
          );
          if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
        });
      },
      { defer: true },
    ),
  );

  const failedCount = (): number =>
    props.outline.reduce(
      (total, group) => total + group.items.filter((item) => item.status === "failed").length,
      0,
    );

  const beginResize = (event: PointerEvent): void => {
    if (column === undefined) return;
    event.preventDefault();
    const rect = column.getBoundingClientRect();
    const limit = Math.max(120, rect.height - 140);
    const move = (moveEvent: PointerEvent): void => {
      const height = Math.min(limit, rect.bottom - moveEvent.clientY);
      setLayout((current) => ({ ...current, height: clampOutlineHeight(height) }));
    };
    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      writeLayout(props.projectId, layout());
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  const itemCount = (): number =>
    props.outline.reduce((total, group) => total + group.items.length, 0);

  return (
    <div
      ref={column}
      data-testid="project-navigator"
      class="flex w-[220px] shrink-0 flex-col"
    >
      <aside
        data-testid="project-views"
        class="flex min-h-[120px] flex-1 flex-col overflow-hidden rounded-md border border-edge bg-canvas"
      >
        <div class="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-2.5">
          <span class="text-[11px] font-medium text-body">Artifacts</span>
          <Show when={props.artifacts.length > 0}>
            <span class="tabular text-[10px] text-faint">{props.artifacts.length}</span>
          </Show>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
          <Show
            when={props.artifacts.length > 0}
            fallback={
              <p class="px-1.5 py-2 text-[11px] text-faint">
                No artifacts. Declare one with <span class="font-mono">Ballast.Artifact</span>.
              </p>
            }
          >
            <div class="space-y-0.5">
              <For each={props.artifacts}>
                {(artifact) => {
                  const selected = (): boolean => props.selectedArtifact === artifact.name;
                  const errorSource = () => artifactErrorSource(artifact.error);
                  return (
                    <div
                      data-testid="artifact-row"
                      data-artifact={artifact.name}
                      data-status={artifact.status}
                      data-selected={selected() ? "true" : undefined}
                      class={cx(
                        "group flex items-start gap-2 rounded-md px-2 py-1.5",
                        selected() ? "bg-layer-2" : "hover:bg-hover",
                      )}
                    >
                      <StatusDot tone={artifactStatusTone(artifact.status)} class="mt-1.5" />
                      <div class="min-w-0 flex-1">
                        <button
                          type="button"
                          aria-current={selected() ? "page" : undefined}
                          class={cx(
                            "block w-full truncate text-left text-[13px]",
                            selected() ? "font-medium text-strong" : "text-body",
                          )}
                          onClick={() => props.onOpenArtifact(artifact)}
                        >
                          {artifact.title ?? artifact.name}
                        </button>
                        <div class="flex min-w-0 items-center gap-2 text-[10px]">
                          <button
                            type="button"
                            tabIndex={-1}
                            class="min-w-0 truncate text-left text-faint"
                            onClick={() => props.onOpenArtifact(artifact)}
                          >
                            {artifactStatusLabel(artifact.status)} · {artifact.name}
                          </button>
                          <Show
                            when={errorSource()}
                            fallback={
                              <Show when={artifact.source}>
                                {(source) => (
                                  <button
                                    type="button"
                                    data-testid="artifact-source"
                                    class="ml-auto shrink-0 font-mono text-[9px] text-faint hover:text-body hover:underline"
                                    title={`${source().file}:${source().line}`}
                                    onClick={() => props.onOpenSource(source().file, source().line)}
                                  >
                                    {sourceLabel(source().file, source().line)}
                                  </button>
                                )}
                              </Show>
                            }
                          >
                            {(source) => (
                              <button
                                type="button"
                                data-testid="artifact-error-source"
                                class="ml-auto shrink-0 font-mono text-[9px] text-danger hover:underline"
                                title={artifact.error}
                                onClick={() => props.onOpenSource(source().file, source().line)}
                              >
                                {sourceLabel(source().file, source().line)}
                              </button>
                            )}
                          </Show>
                        </div>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
        <div class="shrink-0 border-t border-edge p-1.5">
          <button
            type="button"
            data-testid="view-source"
            data-selected={props.selectedArtifact === undefined ? "true" : undefined}
            aria-current={props.selectedArtifact === undefined ? "page" : undefined}
            class={cx(
              "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]",
              props.selectedArtifact === undefined
                ? "bg-layer-2 font-medium text-strong"
                : "text-muted hover:bg-hover hover:text-body",
            )}
            onClick={() => props.onViewSource()}
          >
            <CodeIcon size={14} class="shrink-0 text-faint" />
            <span class="truncate">View source</span>
          </button>
        </div>
      </aside>

      <Show when={layout().open} fallback={<div class="h-3 shrink-0" />}>
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize outline"
          data-testid="outline-splitter"
          class="group flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center"
          onPointerDown={beginResize}
        >
          <span class="h-px w-10 rounded bg-[var(--v2-border-border-base)] transition-colors group-hover:bg-[var(--v2-border-border-strong)]" />
        </div>
      </Show>

      <aside
        data-testid="outline-panel"
        data-open={layout().open ? "true" : "false"}
        class="flex shrink-0 flex-col overflow-hidden rounded-md border border-edge bg-canvas"
        style={layout().open ? { height: `${layout().height}px` } : undefined}
      >
        <button
          type="button"
          data-testid="outline-toggle"
          aria-expanded={layout().open}
          class={cx(
            "flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-left hover:bg-hover",
            layout().open && "border-b border-edge",
          )}
          onClick={toggleOutline}
        >
          <ChevronDownIcon
            size={12}
            class={cx("shrink-0 text-faint transition-transform", !layout().open && "-rotate-90")}
          />
          <span class="text-[11px] font-medium text-body">Outline</span>
          <Show when={failedCount() > 0}>
            <span
              data-testid="outline-failed"
              class="tabular text-[10px] text-danger"
              title={failedCount() === 1 ? "1 unit failed" : `${failedCount()} units failed`}
            >
              {failedCount()} failed
            </span>
          </Show>
          <span class="tabular ml-auto text-[10px] text-faint">{itemCount()}</span>
        </button>
        <Show when={layout().open}>
          <div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
            <Show
              when={props.outline.length > 0}
              fallback={<p class="px-1.5 py-3 text-[11px] text-faint">Nothing declared yet.</p>}
            >
              <For each={props.outline}>
                {(group) => (
                  <div class="mb-1.5" data-testid="outline-group" data-group={group.id}>
                    <p class="px-1.5 py-1 text-[10px] text-faint">{group.title}</p>
                    <For each={group.items}>
                      {(item) => {
                        const selected = (): boolean => props.selectedItem === item.key;
                        return (
                          <button
                            type="button"
                            data-testid="outline-row"
                            data-key={item.key}
                            data-unit-kind={item.unit?.kind}
                            data-unit-name={item.unit?.name}
                            data-selected={selected() ? "true" : undefined}
                            data-status={item.status}
                            title={[
                              item.source === undefined
                                ? item.label
                                : `${item.label} · ${item.source.file}:${item.source.line}`,
                              item.note,
                            ]
                              .filter((part) => part !== undefined)
                              .join("\n")}
                            class={cx(
                              "flex h-6 w-full items-center gap-2 rounded px-1.5 text-left",
                              selected() ? "bg-layer-2" : "hover:bg-hover",
                            )}
                            onClick={() => props.onSelectItem(item)}
                          >
                            <StatusDot tone={unitStatusTone(item.status)} />
                            <span
                              class={cx(
                                "min-w-0 flex-1 truncate text-[12px]",
                                item.status === "failed"
                                  ? "text-danger"
                                  : selected()
                                    ? "text-strong"
                                    : "text-body",
                              )}
                            >
                              {item.label}
                            </span>
                            <Show when={item.source}>
                              {(source) => (
                                <span class="shrink-0 font-mono text-[9px] text-faint">
                                  {source().line}
                                </span>
                              )}
                            </Show>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </aside>
    </div>
  );
};
