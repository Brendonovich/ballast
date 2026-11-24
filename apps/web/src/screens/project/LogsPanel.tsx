import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { LogEntry, LogLevel, UnitSummary } from "@ballast/agent-protocol";

import { useAgent } from "../../state/context.tsx";
import { formatTime, unitKindLabel } from "../../lib/format.ts";
import { newLinesSince } from "../../lib/logs-layout.ts";
import {
  ArrowDownIcon,
  ChevronDownIcon,
  CloseIcon,
  MaximizeIcon,
  MinimizeIcon,
} from "../../ui/icons.tsx";
import {
  Button,
  IconButton,
  SelectInput,
  StatusDot,
  cx,
  surface,
} from "../../ui/primitives.tsx";

const levelClass: Record<LogLevel, string> = {
  debug: "text-faint",
  info: "text-info",
  warn: "text-warning",
  error: "text-danger",
};

export const LogsPanel = (props: {
  readonly projectId: string;
  readonly units: ReadonlyArray<UnitSummary>;
  readonly selected: UnitSummary | undefined;
  readonly onSelect: (unit: UnitSummary | undefined) => void;
  /** Only the header shows: collapsed by the user, or source is maximized. */
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly maximized: boolean;
  readonly onToggleMaximize: () => void;
}): JSX.Element => {
  const store = useAgent();
  const [clearedAt, setClearedAt] = createSignal(0);
  const [follow, setFollow] = createSignal(true);
  let scroller: HTMLDivElement | undefined;

  const projectLogs = (): ReadonlyArray<LogEntry> =>
    store
      .logs()
      .filter(
        (entry) =>
          entry.projectId === props.projectId &&
          entry.seq > clearedAt() &&
          (props.selected === undefined ||
            (entry.unitKind === props.selected.kind &&
              entry.unitName === props.selected.name)),
      );

  // While collapsed, count what arrived since, so the header can say so.
  const [baseline, setBaseline] = createSignal<number>();
  createEffect(() => {
    if (!props.collapsed) {
      setBaseline(undefined);
      return;
    }
    if (baseline() !== undefined) return;
    const latest = store
      .logs()
      .filter((entry) => entry.projectId === props.projectId)
      .at(-1)?.seq;
    setBaseline(latest ?? 0);
  });
  const newLines = createMemo(() => {
    const since = baseline();
    return since === undefined ? undefined : newLinesSince(projectLogs(), since);
  });
  const newLinesTone: Record<"info" | "warn" | "error", string> = {
    info: "text-muted",
    warn: "text-warning",
    error: "text-danger",
  };

  const selectedIndex = (): string => {
    const selected = props.selected;
    if (selected === undefined) return "";
    const index = props.units.findIndex(
      (unit) => unit.kind === selected.kind && unit.name === selected.name,
    );
    return index === -1 ? "" : String(index);
  };

  const choose = (value: string): void => {
    if (value === "") {
      props.onSelect(undefined);
      return;
    }
    const index = Number(value);
    const unit = Number.isInteger(index) ? props.units[index] : undefined;
    props.onSelect(unit);
  };

  const clear = (): void => {
    const latest = store
      .logs()
      .filter((entry) => entry.projectId === props.projectId)
      .at(-1)?.seq;
    setClearedAt(latest ?? 0);
  };

  const scrollToBottom = (): void => {
    if (scroller !== undefined) scroller.scrollTop = scroller.scrollHeight;
    setFollow(true);
  };

  createEffect(() => {
    const list = projectLogs();
    if (list.length === 0 || !follow() || props.collapsed) return;
    queueMicrotask(scrollToBottom);
  });

  const onScroll = (): void => {
    if (scroller === undefined) return;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    setFollow(distance < 32);
  };

  return (
    <section
      class={cx("flex h-full min-h-0 flex-col overflow-hidden", surface)}
      data-testid="log-panel"
    >
      <div class="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-2.5 text-[11px] text-faint">
        <button
          type="button"
          data-testid="logs-collapse-toggle"
          aria-expanded={!props.collapsed}
          title={props.collapsed ? "Expand logs" : "Collapse logs"}
          class="-ml-1 flex h-6 shrink-0 items-center gap-1 rounded px-1 hover:bg-hover"
          onClick={() => props.onToggleCollapsed()}
        >
          <ChevronDownIcon
            size={12}
            class={cx("text-faint transition-transform", props.collapsed && "rotate-180")}
          />
          <span class="font-medium text-body">Logs</span>
        </button>
        <StatusDot tone={store.logStatus() === "live" ? "success" : "warning"} />
        <span class="hidden sm:inline">
          {store.logStatus() === "live" ? "Live" : "Reconnecting"}
        </span>
        <div class="ml-1 w-48 shrink-0">
          <SelectInput
            data-testid="log-unit-filter"
            aria-label="Filter logs by unit"
            value={selectedIndex()}
            onChange={(event) => choose(event.currentTarget.value)}
            class="h-6 text-[11px]"
          >
            <option value="">All units</option>
            <For each={props.units}>
              {(unit, index) => (
                <option value={String(index())}>
                  {unitKindLabel(unit.kind)} · {unit.title ?? unit.name}
                </option>
              )}
            </For>
          </SelectInput>
        </div>
        <Show when={props.selected !== undefined}>
          <IconButton
            label="Clear log filter"
            size="small"
            testId="log-filter-clear"
            onClick={() => props.onSelect(undefined)}
          >
            <CloseIcon size={11} />
          </IconButton>
        </Show>
        <Show when={newLines()}>
          {(lines) => (
            <Show when={lines().count > 0}>
              <span
                data-testid="logs-new-lines"
                data-level={lines().level}
                class={cx(
                  "tabular shrink-0 rounded bg-layer-2 px-1.5 text-[10px] font-medium",
                  newLinesTone[lines().level ?? "info"],
                )}
              >
                {lines().count} new
              </span>
            </Show>
          )}
        </Show>
        <span class="tabular ml-auto">
          {projectLogs().length === 1 ? "1 line" : `${projectLogs().length} lines`}
        </span>
        <Show when={!follow() && !props.collapsed}>
          <Button
            size="small"
            variant="outline"
            data-testid="jump-to-latest"
            icon={<ArrowDownIcon size={11} />}
            onClick={scrollToBottom}
          >
            Latest
          </Button>
        </Show>
        <button
          type="button"
          class="rounded px-1 text-muted hover:bg-hover hover:text-body"
          onClick={clear}
        >
          Clear
        </button>
        <IconButton
          label={props.maximized ? "Restore logs pane" : "Maximize logs pane"}
          size="small"
          testId="logs-maximize"
          onClick={props.onToggleMaximize}
        >
          <Show when={props.maximized} fallback={<MaximizeIcon size={12} />}>
            <MinimizeIcon size={12} />
          </Show>
        </IconButton>
      </div>

      <Show when={!props.collapsed}>
        <div
          ref={scroller}
          onScroll={onScroll}
          class="min-h-0 flex-1 overflow-y-auto font-mono text-[11px] leading-5"
        >
          <Show
            when={projectLogs().length > 0}
            fallback={
              <p class="px-3 py-10 text-center text-[12px] text-faint">
                {props.selected === undefined
                  ? "No log lines for this project yet."
                  : "No log lines for this unit yet."}
              </p>
            }
          >
            <For each={projectLogs()}>
              {(entry) => (
                <div
                  data-testid="log-line"
                  class="flex items-start gap-3 border-b border-edge/60 px-2.5 py-1 last:border-b-0 hover:bg-hover"
                >
                  <span class="tabular shrink-0 pt-px text-faint">{formatTime(entry.at)}</span>
                  <span class={cx("w-9 shrink-0 pt-px text-[9px] uppercase", levelClass[entry.level])}>
                    {entry.level}
                  </span>
                  <span class="min-w-0 flex-1 whitespace-pre-wrap break-words text-body">
                    {entry.message}
                  </span>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </section>
  );
};
