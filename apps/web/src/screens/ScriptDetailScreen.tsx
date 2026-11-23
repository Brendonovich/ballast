import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { JSX } from "solid-js";
import { A, useParams } from "@solidjs/router";
import type {
  ConnectionStatus,
  ParamValue,
  ParamView,
  ScriptDetail,
} from "@ballast/agent-protocol";

import { useAgent } from "../state/context.tsx";
import { scriptKey } from "../state/store.ts";
import {
  connectionStatusLabel,
  connectionStatusTone,
  integrationName,
  isScriptBusy,
  scriptDisplayName,
  scriptStatusLabel,
  scriptStatusTone,
} from "../lib/format.ts";
import {
  AlertIcon,
  ArrowLeftIcon,
  PanelRightIcon,
  PlayIcon,
  StopIcon,
} from "../ui/icons.tsx";
import {
  Button,
  EmptyState,
  IconButton,
  SelectInput,
  Spinner,
  Status,
  StatusDot,
  Switch,
  TextInput,
  cx,
} from "../ui/primitives.tsx";
import { LogsPanel } from "./script/LogsPanel.tsx";
import { SourcePanel } from "./script/SourcePanel.tsx";

const SPLIT_KEY = "ballast.scriptSplit";
const SIDEBAR_KEY = "ballast.scriptSidebarCollapsed";
const DEFAULT_SPLIT = 0.58;

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const readSplit = (): number => {
  if (typeof window === "undefined") return DEFAULT_SPLIT;
  try {
    const value = Number(window.localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(value) && value >= 0.22 && value <= 0.82 ? value : DEFAULT_SPLIT;
  } catch {
    return DEFAULT_SPLIT;
  }
};

const writeSplit = (value: number): void => {
  try {
    window.localStorage.setItem(SPLIT_KEY, String(value));
  } catch {
    // Non-critical.
  }
};

const readSidebar = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "true";
  } catch {
    return false;
  }
};

const writeSidebar = (collapsed: boolean): void => {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, String(collapsed));
  } catch {
    // Non-critical.
  }
};

const textOf = (value: ParamValue | undefined): string =>
  value === undefined ? "" : String(value);

const ParamRow = (props: {
  readonly projectId: string;
  readonly scriptId: string;
  readonly param: ParamView;
}): JSX.Element => {
  const store = useAgent();
  const current = (): ParamValue | undefined => props.param.value ?? props.param.default;
  const [draft, setDraft] = createSignal(textOf(current()));
  const [error, setError] = createSignal<string>();

  createEffect(() => {
    setDraft(textOf(current()));
    setError(undefined);
  });

  const pendingKey = (): string =>
    `script:${scriptKey(props.projectId, props.scriptId)}:param:${props.param.key}`;
  const saving = (): boolean => store.isPending(pendingKey());
  const dirty = (): boolean =>
    props.param.type === "boolean" ? false : draft() !== textOf(current());

  const save = async (value: ParamValue): Promise<void> => {
    if (typeof value === "string" && value.trim() === "" && current() === undefined) {
      setError("Required");
      return;
    }
    setError(undefined);
    await store.setScriptParam(props.projectId, props.scriptId, props.param.key, value);
  };

  const apply = (): void => {
    if (props.param.type === "number") {
      const number = Number(draft());
      if (draft().trim() === "" || !Number.isFinite(number)) {
        setError("Enter a number");
        return;
      }
      void save(number);
      return;
    }
    void save(draft());
  };

  const options = (): ReadonlyArray<string> => {
    const declared = props.param.options ?? [];
    const value = current();
    if (typeof value === "string" && !declared.includes(value)) return [value, ...declared];
    return declared;
  };

  return (
    <div class="border-b border-edge py-2.5 last:border-b-0">
      <div class="flex items-baseline justify-between gap-3">
        <p class="min-w-0 truncate text-[12px] text-body">
          {props.param.title ?? props.param.key}
          <Show when={props.param.required}>
            <span class="ml-0.5 text-faint">*</span>
          </Show>
        </p>
        <span class="shrink-0 truncate font-mono text-[10px] text-faint">{props.param.key}</span>
      </div>
      <div class="mt-1.5">
        <Show
          when={props.param.type === "boolean"}
          fallback={
            <Show
              when={props.param.type === "enum" && props.param.options !== undefined}
              fallback={
                <TextInput
                  value={draft()}
                  disabled={saving()}
                  aria-label={props.param.title ?? props.param.key}
                  placeholder={props.param.optionsSource === undefined ? "" : "From connection"}
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  onBlur={() => {
                    if (dirty()) apply();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      apply();
                      event.currentTarget.blur();
                    }
                  }}
                  class={cx(props.param.type === "number" && "tabular")}
                />
              }
            >
              <SelectInput
                value={textOf(current())}
                disabled={saving()}
                aria-label={props.param.title ?? props.param.key}
                onChange={(event) => void save(event.currentTarget.value)}
              >
                <For each={options()}>
                  {(option) => (
                    <option value={option} selected={option === textOf(current())}>
                      {option}
                    </option>
                  )}
                </For>
              </SelectInput>
            </Show>
          }
        >
          <Switch
            label={props.param.title ?? props.param.key}
            checked={current() === true}
            disabled={saving()}
            onChange={(checked) => void save(checked)}
          />
        </Show>
      </div>
      <div class="mt-1 flex min-h-4 items-center gap-2">
        <Show when={saving()}>
          <Spinner size={10} class="text-faint" />
        </Show>
        <Show when={error()}>
          <span class="text-[10px] text-danger">{error()}</span>
        </Show>
        <Show when={props.param.type !== "boolean" && props.param.type !== "enum" && dirty()}>
          <button
            type="button"
            class="text-[10px] text-accent hover:underline"
            onClick={() => apply()}
          >
            Save
          </button>
        </Show>
        <Show when={props.param.optionsSource}>
          <span class="truncate text-[10px] text-faint">options from connection</span>
        </Show>
      </div>
    </div>
  );
};

const ManifestDetails = (props: { readonly detail: ScriptDetail }): JSX.Element => {
  const store = useAgent();
  const manifest = (): ScriptDetail["manifest"] => props.detail.manifest;
  const total = (): number =>
    manifest().connections.length + manifest().topics.length + manifest().requests.length;

  return (
    <details class="group mt-5 border-t border-edge pt-3">
      <summary class="list-none text-[11px] text-muted hover:text-body">
        <span class="mr-1 inline-block text-faint transition-transform group-open:rotate-90">›</span>
        Manifest · {total()} entries
      </summary>
      <div class="mt-2.5 space-y-3 text-[11px]">
        <Show when={manifest().connections.length > 0}>
          <div>
            <p class="mb-1 text-[10px] text-faint">Connections</p>
            <div class="space-y-1">
              <For each={manifest().connections}>
                {(connection) => {
                  const status = (): ConnectionStatus =>
                    (connection.connectionId === undefined
                      ? undefined
                      : store.connection(connection.connectionId)?.status) ??
                    connection.connectionStatus ??
                    "unconfigured";
                  return (
                    <div class="flex items-center gap-2">
                      <StatusDot tone={connectionStatusTone(status())} />
                      <span class="min-w-0 flex-1 truncate text-body">
                        {integrationName(connection.integration)} · {connection.slot}
                      </span>
                      <span class="shrink-0 text-[10px] text-faint">
                        {connectionStatusLabel(status())}
                      </span>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>
        <Show when={manifest().topics.length > 0}>
          <div>
            <p class="mb-1 text-[10px] text-faint">Topics</p>
            <div class="space-y-1">
              <For each={manifest().topics}>
                {(topic) => (
                  <div>
                    <p class="break-all font-mono text-[10px] text-body">{topic.topic}</p>
                    <p class="text-[10px] text-faint">
                      {topic.scopes.length === 0 ? "no scopes" : topic.scopes.join(", ")}
                    </p>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={manifest().requests.length > 0}>
          <div>
            <p class="mb-1 text-[10px] text-faint">Requests</p>
            <div class="space-y-1">
              <For each={manifest().requests}>
                {(request) => (
                  <div>
                    <p class="break-all font-mono text-[10px] text-body">{request.request}</p>
                    <p class="text-[10px] text-faint">
                      {request.scopes.length === 0 ? "no scopes" : request.scopes.join(", ")}
                    </p>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={manifest().unresolved.length > 0}>
          <div>
            <p class="mb-1 text-[10px] text-faint">Unresolved</p>
            <For each={manifest().unresolved}>
              {(entry) => (
                <p class="text-[10px] text-warning">
                  {entry.path} — {entry.reason}
                </p>
              )}
            </For>
          </div>
        </Show>
      </div>
    </details>
  );
};

export const ScriptDetailScreen = (): JSX.Element => {
  const store = useAgent();
  const params = useParams<{ projectId?: string; scriptId?: string }>();

  const projectId = createMemo(() => safeDecode(params.projectId ?? ""));
  const scriptId = createMemo(() => safeDecode(params.scriptId ?? ""));
  const key = createMemo(() => scriptKey(projectId(), scriptId()));
  const detail = createMemo(() => store.detail(projectId(), scriptId()));
  const summary = createMemo(() => store.script(projectId(), scriptId()) ?? detail()?.summary);
  const loading = createMemo(() => store.isDetailLoading(key()));

  const [split, setSplit] = createSignal(readSplit());
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(readSidebar());
  const [maximized, setMaximized] = createSignal<"source" | "logs">();
  let splitArea: HTMLDivElement | undefined;

  createEffect(() => {
    const pid = projectId();
    const sid = scriptId();
    const ready = store.info()?.startedAt;
    if (pid === "" || sid === "" || ready === undefined) return;
    void store.fetchScript(pid, sid, true);
  });

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && maximized() !== undefined) {
        event.preventDefault();
        setMaximized(undefined);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const media = window.matchMedia("(max-width: 1100px)");
    const collapse = (): void => {
      if (media.matches && !sidebarCollapsed()) {
        setSidebarCollapsed(true);
        writeSidebar(true);
      }
    };
    collapse();
    media.addEventListener("change", collapse);
    onCleanup(() => {
      document.removeEventListener("keydown", onKeyDown);
      media.removeEventListener("change", collapse);
    });
  });

  const toggleSidebar = (): void => {
    const next = !sidebarCollapsed();
    setSidebarCollapsed(next);
    writeSidebar(next);
  };

  const toggleMaximize = (pane: "source" | "logs"): void => {
    setMaximized((current) => (current === pane ? undefined : pane));
  };

  const beginResize = (event: PointerEvent): void => {
    if (splitArea === undefined) return;
    event.preventDefault();
    const rect = splitArea.getBoundingClientRect();
    const move = (moveEvent: PointerEvent): void => {
      const ratio = (moveEvent.clientY - rect.top) / rect.height;
      setSplit(Math.min(0.82, Math.max(0.22, ratio)));
    };
    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      writeSplit(split());
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  const resetSplit = (): void => {
    setSplit(DEFAULT_SPLIT);
    writeSplit(DEFAULT_SPLIT);
  };

  const toggle = async (): Promise<void> => {
    const script = summary();
    if (script === undefined) return;
    if (script.status === "running" || isScriptBusy(script.status)) {
      await store.stopScript(script.projectId, script.id);
    } else if (script.status !== "needs-consent") {
      await store.startScript(script.projectId, script.id);
    }
  };

  const sourceStyle = (): JSX.CSSProperties => {
    if (maximized() === "source") return { flex: "1 1 0%" };
    if (maximized() === "logs") return { height: "32px", flex: "0 0 32px" };
    return { "flex-grow": split(), "flex-basis": "0%", "min-height": "96px" };
  };

  const logsStyle = (): JSX.CSSProperties => {
    if (maximized() === "logs") return { flex: "1 1 0%" };
    if (maximized() === "source") return { height: "32px", flex: "0 0 32px" };
    return { "flex-grow": 1 - split(), "flex-basis": "0%", "min-height": "96px" };
  };

  return (
    <Show
      when={summary()}
      fallback={
        <Show
          when={loading()}
          fallback={
            <EmptyState
              title="Script not found"
              description="It may have been removed, or the project is no longer registered."
              action={
                <A href="/scripts" class="text-[13px] text-accent hover:underline">
                  Back to Scripts
                </A>
              }
            />
          }
        >
          <div class="flex h-full items-center justify-center gap-2 text-[12px] text-muted">
            <Spinner size={12} /> Loading script…
          </div>
        </Show>
      }
    >
      {(script) => (
        <div class="flex h-full min-h-0 flex-col gap-2 overflow-hidden px-5 pb-4 pt-3">
          <div class="flex shrink-0 items-center gap-3">
            <A
              href="/scripts"
              aria-label="Back to Scripts"
              class="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-body"
            >
              <ArrowLeftIcon size={14} />
            </A>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h1 class="truncate text-[16px] font-medium leading-6 tracking-[-0.02em] text-strong">
                  {scriptDisplayName(script())}
                </h1>
                <Status tone={scriptStatusTone(script())}>
                  {scriptStatusLabel(script())}
                </Status>
              </div>
              <p class="truncate font-mono text-[10px] text-faint">{script().entry}</p>
            </div>
            <Button
              size="small"
              variant="ghost"
              data-testid="toggle-sidebar"
              aria-expanded={!sidebarCollapsed()}
              icon={<PanelRightIcon size={13} />}
              onClick={toggleSidebar}
            >
              <span class="hidden sm:inline">Parameters</span>
            </Button>
            <Show when={script().status !== "needs-consent"}>
              <Button
                size="normal"
                variant={
                  script().status === "running" || isScriptBusy(script().status)
                    ? "outline"
                    : "primary"
                }
                loading={
                  store.isPending(`script:${key()}:start`) ||
                  store.isPending(`script:${key()}:stop`)
                }
                icon={
                  script().status === "running" ? <StopIcon size={12} /> : <PlayIcon size={12} />
                }
                onClick={() => void toggle()}
              >
                {script().status === "running" || isScriptBusy(script().status) ? "Stop" : "Start"}
              </Button>
            </Show>
          </div>

          <Show when={script().lastError}>
            <div class="shrink-0 rounded-md border border-[var(--v2-state-border-danger)] bg-[var(--v2-state-bg-danger)] px-2.5 py-1.5 text-[11px] text-danger">
              {script().lastError}
            </div>
          </Show>

          <Show when={detail()?.pendingConsent}>
            {(consent) => (
              <div class="shrink-0 rounded-md border border-[var(--v2-state-border-warning)] bg-[var(--v2-state-bg-warning)] px-3 py-2">
                <div class="flex items-center gap-2.5">
                  <AlertIcon size={13} class="shrink-0 text-warning" />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-[12px] font-medium text-warning">Approval required</p>
                    <p class="truncate text-[11px] text-body">{consent().summary}</p>
                  </div>
                  <div class="flex shrink-0 items-center gap-1.5">
                    <Button
                      size="small"
                      variant="ghost"
                      loading={store.isPending(`consent:${consent().id}:reject`)}
                      onClick={() => void store.rejectConsent(consent().id)}
                    >
                      Reject
                    </Button>
                    <Button
                      size="small"
                      variant="primary"
                      data-testid="approve-consent"
                      loading={store.isPending(`consent:${consent().id}:approve`)}
                      onClick={() => void store.approveConsent(consent().id)}
                    >
                      Approve
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Show>

          <div class="flex min-h-0 flex-1 gap-3">
            <div ref={splitArea} class="flex min-h-0 min-w-0 flex-1 flex-col">
              <div class="min-h-0" style={sourceStyle()}>
                <SourcePanel
                  projectId={projectId()}
                  scriptId={scriptId()}
                  collapsed={maximized() === "logs"}
                  maximized={maximized() === "source"}
                  onToggleMaximize={() => toggleMaximize("source")}
                />
              </div>
              <Show when={maximized() === undefined}>
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize source and logs"
                  data-testid="script-splitter"
                  class="group flex h-1.5 shrink-0 cursor-row-resize touch-none items-center justify-center"
                  onPointerDown={beginResize}
                  onDblClick={resetSplit}
                >
                  <span class="h-px w-10 rounded bg-[var(--v2-border-border-base)] transition-colors group-hover:bg-[var(--v2-border-border-strong)]" />
                </div>
              </Show>
              <div class="min-h-0" style={logsStyle()}>
                <LogsPanel
                  projectId={projectId()}
                  scriptId={scriptId()}
                  collapsed={maximized() === "source"}
                  maximized={maximized() === "logs"}
                  onToggleMaximize={() => toggleMaximize("logs")}
                />
              </div>
            </div>

            <Show when={!sidebarCollapsed()}>
              <aside
                data-testid="script-sidebar"
                class="flex w-[300px] shrink-0 flex-col overflow-hidden rounded-md border border-edge bg-canvas"
              >
                <div class="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-2.5">
                  <span class="text-[11px] font-medium text-body">Parameters</span>
                  <IconButton
                    label="Collapse parameters"
                    size="small"
                    class="ml-auto"
                    onClick={toggleSidebar}
                  >
                    <PanelRightIcon size={12} />
                  </IconButton>
                </div>
                <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
                  <Show when={detail()}>
                    {(current) => (
                      <>
                        <Show
                          when={current().manifest.params.length > 0}
                          fallback={
                            <p class="py-6 text-center text-[11px] text-faint">
                              No parameters for this script.
                            </p>
                          }
                        >
                          <For each={current().manifest.params}>
                            {(param) => (
                              <ParamRow
                                projectId={projectId()}
                                scriptId={scriptId()}
                                param={param}
                              />
                            )}
                          </For>
                        </Show>
                        <ManifestDetails detail={current()} />
                      </>
                    )}
                  </Show>
                </div>
              </aside>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
};
