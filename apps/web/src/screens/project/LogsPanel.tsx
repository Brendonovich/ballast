import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { LogEntry, LogLevel, UnitSummary } from "@ballast/agent-protocol";

import { useAgent } from "../../state/context.tsx";
import { formatTime, unitKindLabel } from "../../lib/format.ts";
import {
  ArrowDownIcon,
  MaximizeIcon,
  MinimizeIcon,
} from "../../ui/icons.tsx";
import {
  Button,
  IconButton,
  SelectInput,
  StatusDot,
  cx,
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
  readonly collapsed: boolean;
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
      class="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-edge bg-canvas"
      data-testid="log-panel"
    >
      <div class="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-2.5 text-[11px] text-faint">
        <span class="shrink-0 font-medium text-body">Logs</span>
        <StatusDot tone={store.logStatus() === "live" ? "success" : "warning"} />
        <span class="hidden sm:inline">
          {store.logStatus() === "live" ? "Live" : "Reconnecting"}
        </span>
        <div class="ml-1 w-40 shrink-0">
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
