import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { A, useParams, useSearchParams } from "@solidjs/router";
import type { ConnectionStatus, ParamValue, ParamView, ScriptDetail } from "@ballast/agent-protocol";

import { useAgent } from "../state/context.tsx";
import { scriptKey } from "../state/store.ts";
import {
  connectionStatusLabel,
  connectionStatusTone,
  integrationName,
  isScriptBusy,
  scriptStatusLabel,
  scriptStatusTone,
} from "../lib/format.ts";
import { AlertIcon, ArrowLeftIcon, PlayIcon, StopIcon } from "../ui/icons.tsx";
import {
  Button,
  EmptyState,
  PageHeader,
  SelectInput,
  Spinner,
  Status,
  StatusDot,
  Switch,
  Tabs,
  TextInput,
  cx,
} from "../ui/primitives.tsx";
import { LogsPanel } from "./script/LogsPanel.tsx";
import { SourcePanel } from "./script/SourcePanel.tsx";

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
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
    <div class="flex items-start gap-4 border-b border-edge py-2.5 last:border-b-0">
      <div class="w-40 shrink-0 pt-0.5">
        <p class="text-[12px] text-body">
          {props.param.title ?? props.param.key}
          {props.param.required && <span class="ml-0.5 text-faint">*</span>}
        </p>
        <p class="truncate font-mono text-[10px] text-faint">{props.param.key}</p>
      </div>
      <div class="min-w-0 flex-1">
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
                  class={cx("max-w-64", props.param.type === "number" && "tabular")}
                />
              }
            >
              <div class="max-w-64">
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
              </div>
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
        <Show when={error()}>
          <p class="mt-1 text-[11px] text-danger">{error()}</p>
        </Show>
        <Show when={props.param.type !== "boolean" && props.param.type !== "enum" && dirty()}>
          <button
            type="button"
            class="mt-1 text-[11px] text-accent hover:underline"
            onClick={() => apply()}
          >
            Save
          </button>
        </Show>
      </div>
      <Show when={saving()}>
        <Spinner size={11} class="mt-2 text-faint" />
      </Show>
    </div>
  );
};

const ManifestDetails = (props: { readonly detail: ScriptDetail }): JSX.Element => {
  const store = useAgent();
  const manifest = (): ScriptDetail["manifest"] => props.detail.manifest;
  const total = (): number =>
    manifest().connections.length + manifest().topics.length + manifest().requests.length;
  return (
    <details class="group mt-6 border-t border-edge pt-3">
      <summary class="list-none text-[12px] text-muted hover:text-body">
        <span class="mr-1 inline-block text-faint transition-transform group-open:rotate-90">›</span>
        Manifest · {total()} entries
      </summary>
      <div class="mt-3 space-y-4 pl-3 text-[12px]">
        <Show when={manifest().connections.length > 0}>
          <div>
            <p class="mb-1 text-[11px] text-faint">Connections</p>
            <div class="space-y-1">
              <For each={manifest().connections}>
                {(connection) => {
                  const live = (): ConnectionStatus | undefined =>
                    connection.connectionId === undefined
                      ? undefined
                      : store.connection(connection.connectionId)?.status;
                  const status = (): ConnectionStatus =>
                    live() ?? connection.connectionStatus ?? "unconfigured";
                  return (
                    <div class="flex items-center gap-2">
                      <StatusDot tone={connectionStatusTone(status())} />
                      <span class="text-body">
                        {integrationName(connection.integration)} · {connection.slot}
                      </span>
                      <span class="text-faint">{connectionStatusLabel(status())}</span>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>
        <Show when={manifest().topics.length > 0}>
          <div>
            <p class="mb-1 text-[11px] text-faint">Topics</p>
            <div class="space-y-1">
              <For each={manifest().topics}>
                {(topic) => (
                  <div class="flex flex-wrap items-baseline gap-x-3">
                    <span class="font-mono text-[11px] text-body">{topic.topic}</span>
                    <span class="text-[11px] text-faint">
                      {topic.scopes.length === 0 ? "no scopes" : topic.scopes.join(", ")}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={manifest().requests.length > 0}>
          <div>
            <p class="mb-1 text-[11px] text-faint">Requests</p>
            <div class="space-y-1">
              <For each={manifest().requests}>
                {(request) => (
                  <div class="flex flex-wrap items-baseline gap-x-3">
                    <span class="font-mono text-[11px] text-body">{request.request}</span>
                    <span class="text-[11px] text-faint">
                      {request.scopes.length === 0 ? "no scopes" : request.scopes.join(", ")}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={manifest().unresolved.length > 0}>
          <div>
            <p class="mb-1 text-[11px] text-faint">Unresolved</p>
            <For each={manifest().unresolved}>
              {(entry) => (
                <p class="text-[11px] text-warning">
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
  const [searchParams, setSearchParams] = useSearchParams<{ tab?: string }>();

  const projectId = createMemo(() => safeDecode(params.projectId ?? ""));
  const scriptId = createMemo(() => safeDecode(params.scriptId ?? ""));
  const key = createMemo(() => scriptKey(projectId(), scriptId()));
  const detail = createMemo(() => store.detail(projectId(), scriptId()));
  const summary = createMemo(() => store.script(projectId(), scriptId()) ?? detail()?.summary);
  const loading = createMemo(() => store.isDetailLoading(key()));
  const tab = (): string => (searchParams.tab === "source" ? "source" : "logs");

  createEffect(() => {
    const pid = projectId();
    const sid = scriptId();
    const ready = store.info()?.startedAt;
    if (pid === "" || sid === "" || ready === undefined) return;
    void store.fetchScript(pid, sid, true);
  });

  const toggle = async (): Promise<void> => {
    const script = summary();
    if (script === undefined) return;
    if (script.status === "running" || isScriptBusy(script.status)) {
      await store.stopScript(script.projectId, script.id);
    } else if (script.status !== "needs-consent") {
      await store.startScript(script.projectId, script.id);
    }
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
          <div class="flex items-center gap-2 text-[12px] text-muted">
            <Spinner size={12} /> Loading script…
          </div>
        </Show>
      }
    >
      {(script) => (
        <div>
          <A
            href="/scripts"
            class="inline-flex items-center gap-1 text-[12px] text-muted hover:text-body"
          >
            <ArrowLeftIcon size={12} />
            Scripts
          </A>

          <div class="mt-4">
            <PageHeader
              title={script().name}
              description={script().entry}
              actions={
                <>
                  <Status tone={scriptStatusTone(script())}>
                    {scriptStatusLabel(script())}
                  </Status>
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
                        script().status === "running" ? (
                          <StopIcon size={12} />
                        ) : (
                          <PlayIcon size={12} />
                        )
                      }
                      onClick={() => void toggle()}
                    >
                      {script().status === "running" || isScriptBusy(script().status)
                        ? "Stop"
                        : "Start"}
                    </Button>
                  </Show>
                </>
              }
            />
          </div>

          <Show when={detail()?.pendingConsent}>
            {(consent) => (
              <div class="mt-5 rounded-md border border-[var(--v2-state-border-warning)] bg-[var(--v2-state-bg-warning)] px-3 py-2.5">
                <div class="flex items-start gap-2.5">
                  <AlertIcon size={14} class="mt-0.5 shrink-0 text-warning" />
                  <div class="min-w-0 flex-1">
                    <p class="text-[12px] font-medium text-warning">Approval required</p>
                    <p class="mt-0.5 text-[12px] text-body">{consent().summary}</p>
                    <Show when={consent().diff.added.scopes.length > 0}>
                      <p class="mt-1 font-mono text-[11px] text-muted">
                        + {consent().diff.added.scopes.join(", ")}
                      </p>
                    </Show>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
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

          <Show when={detail()}>
            {(current) => (
              <>
                <Show when={current().manifest.params.length > 0}>
                  <section class="mt-6">
                    <h2 class="text-[13px] font-medium text-strong">Parameters</h2>
                    <div class="mt-1 border-t border-edge">
                      <For each={current().manifest.params}>
                        {(param) => (
                          <ParamRow
                            projectId={current().summary.projectId}
                            scriptId={current().summary.id}
                            param={param}
                          />
                        )}
                      </For>
                    </div>
                  </section>
                </Show>

                <ManifestDetails detail={current()} />

                <div class="mt-8">
                  <Tabs
                    items={[
                      { id: "logs", label: "Logs" },
                      { id: "source", label: "Source" },
                    ]}
                    value={tab()}
                    onChange={(id) => setSearchParams({ tab: id }, { replace: true })}
                  />
                  <div class="mt-3">
                    <Show when={tab() === "logs"}>
                      <LogsPanel projectId={projectId()} scriptId={scriptId()} />
                    </Show>
                    <Show when={tab() === "source"}>
                      <SourcePanel projectId={projectId()} scriptId={scriptId()} />
                    </Show>
                  </div>
                </div>
              </>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
};
