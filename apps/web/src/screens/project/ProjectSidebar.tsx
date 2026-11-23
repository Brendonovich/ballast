import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type {
  ParamValue,
  ParamView,
  ProjectDetail,
  ProjectRequirement,
  TimerSummary,
} from "@ballast/agent-protocol";

import { useAgent } from "../../state/context.tsx";
import {
  formatRelative,
  integrationName,
} from "../../lib/format.ts";
import { PanelRightIcon, RefreshIcon, TrashIcon } from "../../ui/icons.tsx";
import {
  Button,
  IconButton,
  SelectInput,
  Spinner,
  Switch,
  TextInput,
  cx,
} from "../../ui/primitives.tsx";

const textOf = (value: ParamValue | undefined): string =>
  value === undefined ? "" : String(value);

const stringValues = (value: ParamValue | undefined): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const ParamRow = (props: {
  readonly projectId: string;
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

  const saving = (): boolean =>
    store.isPending(`project:${props.projectId}:param:${props.param.key}`);
  const dirty = (): boolean =>
    props.param.type === "boolean" || props.param.type === "strings"
      ? false
      : draft() !== textOf(current());

  const save = async (value: ParamValue): Promise<void> => {
    if (typeof value === "string" && value.trim() === "" && current() === undefined) {
      setError("Required");
      return;
    }
    setError(undefined);
    await store.setProjectParam(props.projectId, props.param.key, value);
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

  const enumOptions = (): ReadonlyArray<string> => {
    const declared = props.param.options ?? [];
    const value = current();
    if (typeof value === "string" && !declared.includes(value)) return [value, ...declared];
    return declared;
  };

  const selectedStrings = (): ReadonlyArray<string> => stringValues(current());

  const stringOptions = (): ReadonlyArray<string> => {
    const declared = props.param.options ?? [];
    const selected = selectedStrings();
    const missing = selected.filter((value) => !declared.includes(value));
    return [...declared, ...missing];
  };

  const toggleString = (option: string, checked: boolean): void => {
    const selected = selectedStrings();
    const next = stringOptions().filter((value) =>
      value === option ? checked : selected.includes(value),
    );
    void save(next);
  };

  const label = (): string => props.param.title ?? props.param.key;

  const renderInput = (): JSX.Element => {
    if (props.param.type === "boolean") {
      return (
        <Switch
          label={label()}
          checked={current() === true}
          disabled={saving()}
          onChange={(checked) => void save(checked)}
        />
      );
    }
    if (props.param.type === "strings") {
      return (
        <div data-testid={`project-param-${props.param.key}`} class="space-y-1">
          <For each={stringOptions()}>
            {(option) => (
              <label class="flex items-center gap-2 text-[12px] text-body">
                <input
                  type="checkbox"
                  data-testid={`project-param-option-${props.param.key}`}
                  data-option={option}
                  aria-label={option}
                  class="size-3.5 shrink-0 accent-[var(--v2-text-text-accent)]"
                  checked={selectedStrings().includes(option)}
                  disabled={saving()}
                  onChange={(event) => toggleString(option, event.currentTarget.checked)}
                />
                <span class="truncate">{option}</span>
              </label>
            )}
          </For>
          <Show when={stringOptions().length === 0}>
            <p class="py-1 text-[11px] text-faint">No options available.</p>
          </Show>
        </div>
      );
    }
    if (props.param.type === "enum" && props.param.options !== undefined) {
      return (
        <SelectInput
          value={textOf(current())}
          disabled={saving()}
          aria-label={label()}
          data-testid={`project-param-${props.param.key}`}
          onChange={(event) => void save(event.currentTarget.value)}
        >
          <For each={enumOptions()}>
            {(option) => (
              <option value={option} selected={option === textOf(current())}>
                {option}
              </option>
            )}
          </For>
        </SelectInput>
      );
    }
    return (
      <TextInput
        value={draft()}
        disabled={saving()}
        aria-label={label()}
        data-testid={`project-param-${props.param.key}`}
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
    );
  };

  return (
    <div class="border-b border-edge py-2.5 last:border-b-0">
      <div class="min-w-0">
        <p class="truncate text-[12px] text-body">
          {label()}
          <Show when={props.param.required}>
            <span class="ml-0.5 text-faint">*</span>
          </Show>
        </p>
        <Show when={props.param.description}>
          <p class="mt-0.5 text-[11px] text-faint">{props.param.description}</p>
        </Show>
      </div>
      <div class="mt-1.5">{renderInput()}</div>
      <div class="mt-1 flex min-h-4 items-center gap-2">
        <Show when={saving()}>
          <Spinner size={10} class="text-faint" />
        </Show>
        <Show when={error()}>
          <span class="text-[10px] text-danger">{error()}</span>
        </Show>
        <Show when={props.param.type !== "boolean" && props.param.type !== "enum" && props.param.type !== "strings" && dirty()}>
          <button
            type="button"
            class="text-[10px] text-accent hover:underline"
            onClick={() => apply()}
          >
            Save
          </button>
        </Show>
        <Show when={props.param.optionsSource}>
          {(source) => (
            <span class="truncate text-[10px] text-faint">
              Options from {integrationName(source().integration)} · {source().slot}
            </span>
          )}
        </Show>
      </div>
    </div>
  );
};

const Section = (props: {
  readonly title: string;
  readonly action?: JSX.Element;
  readonly children: JSX.Element;
}): JSX.Element => (
  <section class="border-b border-edge px-3 py-3 last:border-b-0">
    <div class="flex h-5 items-center gap-2">
      <h2 class="text-[11px] font-medium text-body">{props.title}</h2>
      <Show when={props.action}>
        <span class="ml-auto">{props.action}</span>
      </Show>
    </div>
    <div class="mt-1">{props.children}</div>
  </section>
);

export const ProjectSidebar = (props: {
  readonly detail: ProjectDetail;
  readonly timers: ReadonlyArray<TimerSummary>;
  readonly onRefreshTimers: () => void;
  readonly onCollapse: () => void;
  readonly onBind: (
    requirement: ProjectRequirement,
    instanceId: string | null,
  ) => Promise<boolean>;
  readonly onAddConnection: (requirement: ProjectRequirement) => void;
}): JSX.Element => {
  const store = useAgent();
  const [drafts, setDrafts] = createSignal<Readonly<Record<string, string>>>({});
  const projectId = (): string => props.detail.summary.id;

  const requirements = (): ReadonlyArray<ProjectRequirement> => {
    const seen = new Set<string>();
    const rows: Array<ProjectRequirement> = [];
    for (const requirement of props.detail.requirements) {
      const key = requirementKey(requirement);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(requirement);
    }
    return rows;
  };

  const instances = (requirement: ProjectRequirement) =>
    store
      .connections()
      .filter((connection) => connection.integration === requirement.integration)
      .slice()
      .sort((left, right) => left.label.localeCompare(right.label));

  const currentValue = (requirement: ProjectRequirement): string =>
    drafts()[requirementKey(requirement)] ??
    requirement.boundInstanceId ??
    requirement.proposedInstanceId ??
    "";

  const missingInstance = (requirement: ProjectRequirement): string | undefined => {
    const value = currentValue(requirement);
    if (value === "") return undefined;
    return instances(requirement).some((instance) => instance.id === value) ? undefined : value;
  };

  const hint = (requirement: ProjectRequirement): { readonly text: string; readonly error: boolean } | undefined => {
    if (requirement.boundInstanceId !== undefined) {
      return missingInstance(requirement) === undefined
        ? undefined
        : { text: "Bound instance is missing", error: true };
    }
    if (requirement.proposedInstanceId !== undefined) {
      return { text: "Proposed · confirmed on Start", error: false };
    }
    return { text: "Unbound · blocks Start", error: true };
  };

  const choose = async (requirement: ProjectRequirement, value: string): Promise<void> => {
    const key = requirementKey(requirement);
    setDrafts((current) => ({ ...current, [key]: value }));
    const bound = await props.onBind(requirement, value === "" ? null : value);
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    if (!bound) return;
  };

  const cancel = async (timer: TimerSummary): Promise<void> => {
    const cancelled = await store.cancelTimer(projectId(), timer.timer, timer.key);
    if (cancelled) props.onRefreshTimers();
  };

  return (
    <aside
      data-testid="project-sidebar"
      class="flex w-[300px] shrink-0 flex-col overflow-hidden rounded-md border border-edge bg-canvas"
    >
      <div class="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-2.5">
        <span class="text-[11px] font-medium text-body">Project</span>
        <IconButton
          label="Collapse project sidebar"
          size="small"
          class="ml-auto"
          onClick={props.onCollapse}
        >
          <PanelRightIcon size={12} />
        </IconButton>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <Section title="Parameters">
          <Show
            when={props.detail.manifest.params.length > 0}
            fallback={<p class="py-2 text-[11px] text-faint">No parameters.</p>}
          >
            <For each={props.detail.manifest.params}>
              {(param) => <ParamRow projectId={projectId()} param={param} />}
            </For>
          </Show>
        </Section>

        <Section title="Connections">
          <Show
            when={requirements().length > 0}
            fallback={<p class="py-2 text-[11px] text-faint">No connection requirements.</p>}
          >
            <For each={requirements()}>
              {(requirement) => (
                <div
                  data-testid="project-requirement"
                  data-integration={requirement.integration}
                  data-slot={requirement.slot}
                  data-bound-instance={
                    requirement.boundInstanceId ?? requirement.proposedInstanceId ?? ""
                  }
                  class="border-b border-edge py-2 last:border-b-0"
                >
                  <div class="flex items-baseline justify-between gap-2 text-[12px]">
                    <span class="min-w-0 truncate text-body">
                      {integrationName(requirement.integration)}
                    </span>
                    <span class="font-mono text-[10px] text-faint">{requirement.slot}</span>
                  </div>
                  <div class="mt-1 flex items-center gap-1">
                    <SelectInput
                      data-testid="project-connection-picker"
                      aria-label={`Connection for ${requirement.integration} ${requirement.slot}`}
                      value={currentValue(requirement)}
                      class="h-6 text-[11px]"
                      onChange={(event) => void choose(requirement, event.currentTarget.value)}
                    >
                      <option value="">Choose connection…</option>
                      <For each={instances(requirement)}>
                        {(instance) => (
                          <option value={instance.id} selected={instance.id === currentValue(requirement)}>
                            {instance.label}
                          </option>
                        )}
                      </For>
                      <Show when={missingInstance(requirement)}>
                        {(id) => <option value={id()}>Missing instance</option>}
                      </Show>
                    </SelectInput>
                    <Button
                      size="small"
                      variant="ghost"
                      class="shrink-0"
                      data-testid="project-connection-add"
                      onClick={() => props.onAddConnection(requirement)}
                    >
                      Add connection…
                    </Button>
                  </div>
                  <Show when={hint(requirement)}>
                    {(value) => (
                      <p
                        class={value().error ? "mt-0.5 text-[10px] text-warning" : "mt-0.5 text-[10px] text-faint"}
                      >
                        {value().text}
                      </p>
                    )}
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </Section>

        <Section
          title="Timers"
          action={
            <IconButton
              label="Refresh timers"
              size="small"
              testId="refresh-timers"
              onClick={props.onRefreshTimers}
            >
              <RefreshIcon size={11} />
            </IconButton>
          }
        >
          <Show
            when={props.timers.length > 0}
            fallback={<p class="py-2 text-[11px] text-faint">No pending timers.</p>}
          >
            <For each={props.timers}>
              {(timer) => (
                <div
                  data-testid="timer-row"
                  data-timer={timer.timer}
                  class="flex items-center gap-2 border-b border-edge py-1.5 last:border-b-0"
                >
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-[12px] text-body">{timer.title ?? timer.timer}</p>
                    <p class="truncate font-mono text-[10px] text-faint">
                      {timer.key} · {formatRelative(timer.dueAt)}
                    </p>
                  </div>
                  <Button
                    size="small"
                    variant="ghost"
                    data-testid="timer-cancel"
                    loading={store.isPending(
                      `project:${projectId()}:timer:${timer.timer}:${timer.key}:cancel`,
                    )}
                    icon={<TrashIcon size={11} />}
                    onClick={() => void cancel(timer)}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </For>
          </Show>
        </Section>
      </div>
    </aside>
  );
};

const requirementKey = (requirement: ProjectRequirement): string =>
  `${requirement.integration}\u0000${requirement.slot}`;
