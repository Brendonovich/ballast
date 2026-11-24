import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { JSX } from "solid-js";
import type { ArtifactSummary, ProjectFile } from "@ballast/agent-protocol";

import {
  artifactErrorSource,
  artifactStatusLabel,
  artifactStatusTone,
  unitStatusTone,
} from "../../lib/format.ts";
import type { OutlineGroup, OutlineItem } from "../../lib/outline.ts";
import { tabKey } from "../../lib/project-tabs.ts";
import { flash } from "../../lib/project-intent.ts";
import {
  DEFAULT_SIDEBAR,
  clampSidebarSplit,
  parseSidebarLayout,
  sidebarStorageKey,
} from "../../lib/sidebar-layout.ts";
import type { SidebarLayout } from "../../lib/sidebar-layout.ts";
import { ChevronDownIcon, CodeIcon } from "../../ui/icons.tsx";
import { StatusDot, cx, surface } from "../../ui/primitives.tsx";
import type { Tone } from "../../ui/primitives.tsx";

const readLayout = (projectId: string): SidebarLayout => {
  try {
    return parseSidebarLayout(window.localStorage.getItem(sidebarStorageKey(projectId)));
  } catch {
    return DEFAULT_SIDEBAR;
  }
};

const writeLayout = (projectId: string, layout: SidebarLayout): void => {
  try {
    window.localStorage.setItem(sidebarStorageKey(projectId), JSON.stringify(layout));
  } catch {
    // Non-critical.
  }
};

const fileName = (path: string): string => path.split("/").at(-1) ?? path;

interface Declaration {
  readonly file: string;
  readonly line: number;
}

const locationLabel = (source: Declaration): string => `${source.file}:${source.line}`;

/**
 * A collapsible section header: the whole header toggles, like the Outline
 * always has.
 */
const SectionHeader = (props: {
  readonly title: string;
  readonly open: boolean;
  readonly testId: string;
  readonly onToggle: () => void;
  readonly children?: JSX.Element;
}): JSX.Element => (
  <button
    type="button"
    data-testid={props.testId}
    aria-expanded={props.open}
    class={cx(
      "flex h-8 w-full shrink-0 items-center gap-1.5 px-2.5 text-left",
      props.open && "border-b border-edge",
    )}
    onClick={() => props.onToggle()}
  >
    <ChevronDownIcon
      size={12}
      class={cx("shrink-0 text-faint transition-transform", !props.open && "-rotate-90")}
    />
    <span class="text-[11px] font-medium text-body">{props.title}</span>
    {props.children}
  </button>
);

/**
 * One outline or artifact row. Rows that open something are buttons with a
 * hover background; the others are plain text. Every row with a declaration
 * shows a code icon on hover that opens it in a file tab.
 */
const Row = (props: {
  readonly testId: string;
  readonly data: Record<string, string | undefined>;
  readonly tone: Tone;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly danger?: boolean;
  readonly title: string;
  readonly selected: boolean;
  readonly onOpen?: (() => void) | undefined;
  readonly source?: Declaration | undefined;
  readonly sourceTestId: string;
  readonly sourceDanger?: boolean;
  readonly onOpenSource: (file: string, line: number) => void;
}): JSX.Element => {
  const content = (): JSX.Element => (
    <>
      <StatusDot tone={props.tone} />
      <span
        class={cx(
          "min-w-0 shrink truncate text-[12px]",
          props.danger === true ? "text-danger" : props.selected ? "text-strong" : "text-body",
        )}
      >
        {props.label}
      </span>
      <Show when={props.detail}>
        {(detail) => <span class="min-w-0 flex-1 truncate text-[11px] text-faint">{detail()}</span>}
      </Show>
    </>
  );
  return (
    <div
      data-testid={props.testId}
      {...props.data}
      data-clickable={props.onOpen === undefined ? "false" : "true"}
      data-selected={props.selected ? "true" : undefined}
      title={props.title}
      class={cx(
        "group relative flex h-6 items-center rounded",
        props.selected ? "bg-layer-2" : props.onOpen !== undefined && "hover:bg-hover",
      )}
    >
      <Show
        when={props.onOpen}
        fallback={<div class="flex h-full min-w-0 flex-1 items-center gap-2 px-1.5">{content()}</div>}
      >
        {(open) => (
          <button
            type="button"
            aria-current={props.selected ? "page" : undefined}
            class="flex h-full min-w-0 flex-1 items-center gap-2 px-1.5 text-left"
            onClick={() => open()()}
          >
            {content()}
          </button>
        )}
      </Show>
      <Show when={props.source}>
        {(source) => (
          <button
            type="button"
            data-testid={props.sourceTestId}
            aria-label={`Open ${locationLabel(source())}`}
            title={locationLabel(source())}
            class={cx(
              "mr-0.5 grid size-5 shrink-0 place-items-center rounded opacity-0 hover:bg-hover focus-visible:opacity-100 group-hover:opacity-100",
              props.sourceDanger === true ? "text-danger" : "text-faint hover:text-body",
            )}
            onClick={() => props.onOpenSource(source().file, source().line)}
          >
            <CodeIcon size={12} />
          </button>
        )}
      </Show>
    </div>
  );
};

/**
 * The project's left sidebar: Files, then the Outline (artifacts first, then
 * everything else the project declares). Each collapses to its header; the
 * split between them and their open state persist per project.
 */
export const ProjectNavigator = (props: {
  readonly projectId: string;
  readonly files: ReadonlyArray<ProjectFile>;
  readonly filesError: string | undefined;
  /** The active tab's key, so its row reads as selected. */
  readonly activeTab: string | undefined;
  readonly onOpenFile: (path: string) => void;
  readonly artifacts: ReadonlyArray<ArtifactSummary>;
  readonly onOpenArtifact: (artifact: ArtifactSummary) => void;
  readonly outline: ReadonlyArray<OutlineGroup>;
  readonly onOpenItem: (item: OutlineItem) => void;
  readonly onOpenSource: (file: string, line: number) => void;
  /** Open the outline and point at this row (from an issue). */
  readonly reveal?: { readonly key: string; readonly token: number } | undefined;
}): JSX.Element => {
  const [layout, setLayout] = createSignal<SidebarLayout>(DEFAULT_SIDEBAR);
  let column: HTMLDivElement | undefined;

  createEffect(
    on(
      () => props.projectId,
      (projectId) => setLayout(readLayout(projectId)),
    ),
  );

  const update = (next: SidebarLayout): void => {
    setLayout(next);
    writeLayout(props.projectId, next);
  };

  createEffect(
    on(
      () => props.reveal?.token,
      () => {
        const target = props.reveal;
        if (target === undefined) return;
        if (!layout().outlineOpen) update({ ...layout(), outlineOpen: true });
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            flash(
              column?.querySelector(`[data-testid="outline-row"][data-key="${CSS.escape(target.key)}"]`),
            );
          }),
        );
      },
      { defer: true },
    ),
  );

  const failedCount = (): number =>
    props.outline.reduce(
      (total, group) => total + group.items.filter((item) => item.status === "failed").length,
      0,
    ) + props.artifacts.filter((artifact) => artifact.status === "error").length;

  const itemCount = (): number =>
    props.outline.reduce((total, group) => total + group.items.length, 0) + props.artifacts.length;

  const fileRows = createMemo(() =>
    props.files.map((file) => ({
      ...file,
      depth: file.path.split("/").length - 1,
      label: fileName(file.path),
    })),
  );
  const fileCount = (): number => props.files.filter((file) => file.kind === "file").length;

  const beginResize = (event: PointerEvent): void => {
    if (column === undefined) return;
    event.preventDefault();
    const rect = column.getBoundingClientRect();
    const move = (moveEvent: PointerEvent): void => {
      setLayout((current) => ({
        ...current,
        split: clampSidebarSplit((moveEvent.clientY - rect.top) / rect.height),
      }));
    };
    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      writeLayout(props.projectId, layout());
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  const bothOpen = (): boolean => layout().filesOpen && layout().outlineOpen;
  const filesStyle = (): JSX.CSSProperties | undefined =>
    !layout().filesOpen
      ? undefined
      : bothOpen()
        ? { "flex-grow": layout().split, "flex-basis": "0%", "min-height": "64px" }
        : { flex: "1 1 0%" };
  const outlineStyle = (): JSX.CSSProperties | undefined =>
    !layout().outlineOpen
      ? undefined
      : bothOpen()
        ? { "flex-grow": 1 - layout().split, "flex-basis": "0%", "min-height": "64px" }
        : { flex: "1 1 0%" };

  const artifactTone = (artifact: ArtifactSummary): Tone => artifactStatusTone(artifact.status);

  return (
    <div ref={column} data-testid="project-navigator" class="flex w-[240px] shrink-0 flex-col">
      <aside
        data-testid="files-panel"
        data-open={layout().filesOpen ? "true" : "false"}
        class={cx("flex shrink-0 flex-col overflow-hidden", surface)}
        style={filesStyle()}
      >
        <SectionHeader
          title="Files"
          testId="files-toggle"
          open={layout().filesOpen}
          onToggle={() => update({ ...layout(), filesOpen: !layout().filesOpen })}
        >
          <span class="tabular ml-auto text-[10px] text-faint">{fileCount()}</span>
        </SectionHeader>
        <Show when={layout().filesOpen}>
          <div data-testid="source-tree" class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
            <Show when={props.filesError === undefined} fallback={<p class="px-1.5 py-2 text-[11px] text-danger">{props.filesError}</p>}>
              <For each={fileRows()}>
                {(row) => (
                  <Show
                    when={row.kind === "file"}
                    fallback={
                      <p
                        class="truncate py-0.5 pr-2 font-mono text-[11px] leading-5 text-faint"
                        style={{ "padding-left": `${6 + row.depth * 10}px` }}
                      >
                        {row.label}
                      </p>
                    }
                  >
                    <button
                      type="button"
                      data-testid="source-file"
                      data-path={row.path}
                      data-selected={props.activeTab === tabKey({ kind: "file", path: row.path }) ? "true" : undefined}
                      title={row.path}
                      class={cx(
                        "block h-6 w-full truncate rounded pr-2 text-left font-mono text-[11px]",
                        props.activeTab === tabKey({ kind: "file", path: row.path })
                          ? "bg-layer-2 text-strong"
                          : "text-muted hover:bg-hover hover:text-body",
                      )}
                      style={{ "padding-left": `${6 + row.depth * 10}px` }}
                      onClick={() => props.onOpenFile(row.path)}
                    >
                      {row.label}
                    </button>
                  </Show>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </aside>

      <Show when={bothOpen()} fallback={<div class="h-2 shrink-0" />}>
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize files and outline"
          data-testid="sidebar-splitter"
          class="group flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center"
          onPointerDown={beginResize}
          onDblClick={() => update({ ...layout(), split: DEFAULT_SIDEBAR.split })}
        >
          <span class="h-px w-10 rounded bg-transparent transition-colors group-hover:bg-[var(--v2-border-border-strong)]" />
        </div>
      </Show>

      <aside
        data-testid="outline-panel"
        data-open={layout().outlineOpen ? "true" : "false"}
        class={cx("flex shrink-0 flex-col overflow-hidden", surface)}
        style={outlineStyle()}
      >
        <SectionHeader
          title="Outline"
          testId="outline-toggle"
          open={layout().outlineOpen}
          onToggle={() => update({ ...layout(), outlineOpen: !layout().outlineOpen })}
        >
          <Show when={failedCount() > 0}>
            <span
              data-testid="outline-failed"
              class="tabular text-[10px] text-danger"
              title={failedCount() === 1 ? "1 failed" : `${failedCount()} failed`}
            >
              {failedCount()} failed
            </span>
          </Show>
          <span class="tabular ml-auto text-[10px] text-faint">{itemCount()}</span>
        </SectionHeader>
        <Show when={layout().outlineOpen}>
          <div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
            <Show
              when={props.outline.length > 0 || props.artifacts.length > 0}
              fallback={<p class="px-1.5 py-3 text-[11px] text-faint">Nothing declared yet.</p>}
            >
              <Show when={props.artifacts.length > 0}>
                <div class="mb-1.5" data-testid="outline-group" data-group="artifact">
                  <p class="px-1.5 py-1 text-[10px] text-faint">Artifacts</p>
                  <For each={props.artifacts}>
                    {(artifact) => {
                      const errorSource = () => artifactErrorSource(artifact.error);
                      const status = (): string | undefined =>
                        artifact.status === "ready" ? undefined : artifactStatusLabel(artifact.status);
                      return (
                        <Row
                          testId="artifact-row"
                          data={{ "data-artifact": artifact.name, "data-status": artifact.status }}
                          tone={artifactTone(artifact)}
                          label={artifact.title ?? artifact.name}
                          detail={status()}
                          danger={artifact.status === "error"}
                          title={[artifact.title ?? artifact.name, artifact.name, artifact.error]
                            .filter((part) => part !== undefined)
                            .join("\n")}
                          selected={props.activeTab === tabKey({ kind: "artifact", name: artifact.name })}
                          onOpen={() => props.onOpenArtifact(artifact)}
                          source={errorSource() ?? artifact.source}
                          sourceTestId={errorSource() === undefined ? "artifact-source" : "artifact-error-source"}
                          sourceDanger={errorSource() !== undefined}
                          onOpenSource={props.onOpenSource}
                        />
                      );
                    }}
                  </For>
                </div>
              </Show>
              <For each={props.outline}>
                {(group) => (
                  <div class="mb-1.5" data-testid="outline-group" data-group={group.id}>
                    <p class="px-1.5 py-1 text-[10px] text-faint">{group.title}</p>
                    <For each={group.items}>
                      {(item) => (
                        <Row
                          testId="outline-row"
                          data={{
                            "data-key": item.key,
                            "data-unit-kind": item.unit?.kind,
                            "data-unit-name": item.unit?.name,
                            "data-status": item.status,
                          }}
                          tone={unitStatusTone(item.status)}
                          label={item.label}
                          detail={item.detail}
                          danger={item.status === "failed"}
                          title={[item.label, item.note].filter((part) => part !== undefined).join("\n")}
                          selected={
                            item.open?.kind === "topic" &&
                            props.activeTab === tabKey({ kind: "topic", name: item.open.name })
                          }
                          onOpen={item.open === undefined ? undefined : () => props.onOpenItem(item)}
                          source={item.source}
                          sourceTestId="outline-source"
                          onOpenSource={props.onOpenSource}
                        />
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </aside>
      <Show when={!layout().filesOpen && !layout().outlineOpen}>
        <div class="min-h-0 flex-1" />
      </Show>
    </div>
  );
};
