import { For, Show, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import type {
  ArtifactSummary,
  UnitKind,
  UnitSummary,
} from "@ballast/agent-protocol";

import {
  artifactErrorSource,
  artifactStatusLabel,
  artifactStatusTone,
  formatRelative,
  unitKindPlural,
  unitStatusLabel,
  unitStatusTone,
} from "../../lib/format.ts";
import { StatusDot, cx } from "../../ui/primitives.tsx";

const kinds: ReadonlyArray<UnitKind> = [
  "topic",
  "timer",
  "workflow",
  "param",
  "run",
  "database",
];

export const UnitsPanel = (props: {
  readonly units: ReadonlyArray<UnitSummary>;
  readonly selected: UnitSummary | undefined;
  readonly onSelect: (unit: UnitSummary | undefined) => void;
  readonly onOpenSource: (file: string, line: number) => void;
  readonly artifacts: ReadonlyArray<ArtifactSummary>;
  readonly selectedArtifact: string | undefined;
  readonly onOpenArtifact: (artifact: ArtifactSummary) => void;
}): JSX.Element => {
  const groups = createMemo(() =>
    kinds
      .map((kind) => ({
        kind,
        units: props.units.filter((unit) => unit.kind === kind),
      }))
      .filter((group) => group.units.length > 0),
  );

  const isSelected = (unit: UnitSummary): boolean =>
    props.selected?.kind === unit.kind && props.selected.name === unit.name;

  return (
    <aside
      data-testid="units-panel"
      class="flex w-[210px] shrink-0 flex-col overflow-hidden rounded-md border border-edge bg-canvas"
    >
      <div class="flex h-8 shrink-0 items-center border-b border-edge px-2.5">
        <span class="text-[11px] font-medium text-body">Units</span>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        <Show when={props.artifacts.length > 0}>
          <div class="mb-1.5">
            <p class="px-1.5 py-1 text-[10px] text-faint">Artifacts</p>
            <For each={props.artifacts}>
              {(artifact) => (
                <div
                  data-testid="artifact-row"
                  data-artifact={artifact.name}
                  data-status={artifact.status}
                  data-selected={props.selectedArtifact === artifact.name ? "true" : undefined}
                  class={cx(
                    "group flex items-start gap-2 rounded px-1.5 py-1",
                    props.selectedArtifact === artifact.name
                      ? "bg-layer-2"
                      : "hover:bg-hover",
                  )}
                >
                  <StatusDot tone={artifactStatusTone(artifact.status)} class="mt-1" />
                  <button
                    type="button"
                    class="min-w-0 flex-1 text-left"
                    onClick={() => props.onOpenArtifact(artifact)}
                  >
                    <span class="block truncate text-[12px] text-body">
                      {artifact.title ?? artifact.name}
                    </span>
                    <span class="block truncate whitespace-nowrap text-[10px] text-faint">
                      {artifactStatusLabel(artifact.status)} · {artifact.name}
                    </span>
                  </button>
                  <Show
                    when={
                      artifactErrorSource(artifact.error) === undefined
                        ? artifact.source
                        : undefined
                    }
                  >
                    {(source) => (
                      <button
                        type="button"
                        data-testid="artifact-source"
                        class="max-w-[78px] shrink-0 truncate font-mono text-[9px] text-faint hover:text-body hover:underline"
                        title={`${source().file}:${source().line}`}
                        onClick={() => props.onOpenSource(source().file, source().line)}
                      >
                        {source().file.split("/").at(-1)}:{source().line}
                      </button>
                    )}
                  </Show>
                  <Show when={artifactErrorSource(artifact.error)}>
                    {(source) => (
                      <button
                        type="button"
                        data-testid="artifact-error-source"
                        class="max-w-[78px] shrink-0 truncate font-mono text-[9px] text-danger hover:underline"
                        title={artifact.error}
                        onClick={() => props.onOpenSource(source().file, source().line)}
                      >
                        {source().file.split("/").at(-1)}:{source().line}
                      </button>
                    )}
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show
          when={groups().length > 0}
          fallback={
            <Show when={props.artifacts.length === 0}>
              <p class="px-2 py-6 text-center text-[11px] text-faint">No units yet.</p>
            </Show>
          }
        >
          <For each={groups()}>
            {(group) => (
              <div class="mb-1.5">
                <p class="px-1.5 py-1 text-[10px] text-faint">{unitKindPlural(group.kind)}</p>
                <For each={group.units}>
                  {(unit) => (
                    <div
                      data-testid="unit-row"
                      data-unit-kind={unit.kind}
                      data-unit-name={unit.name}
                      data-selected={isSelected(unit) ? "true" : undefined}
                      class={cx(
                        "group flex items-center gap-2 rounded px-1.5 py-1",
                        isSelected(unit) ? "bg-layer-2" : "hover:bg-hover",
                      )}
                    >
                      <StatusDot tone={unitStatusTone(unit.status)} />
                      <button
                        type="button"
                        class="min-w-0 flex-1 text-left"
                        onClick={() => props.onSelect(isSelected(unit) ? undefined : unit)}
                      >
                        <span class="block truncate text-[12px] text-body">
                          {unit.title ?? unit.name}
                        </span>
                        <span class="block truncate whitespace-nowrap text-[10px] text-faint">
                          {unitStatusLabel(unit.status)}
                          <Show when={unit.lastActivityAt}>
                            {(at) => <> · {formatRelative(at())}</>}
                          </Show>
                        </span>
                      </button>
                      <Show when={unit.source}>
                        {(source) => (
                          <button
                            type="button"
                            data-testid="unit-source"
                            class="max-w-[78px] shrink-0 truncate font-mono text-[9px] text-faint hover:text-body hover:underline"
                            title={`${source().file}:${source().line}`}
                            onClick={() => props.onOpenSource(source().file, source().line)}
                          >
                            {source().file.split("/").at(-1)}:{source().line}
                          </button>
                        )}
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </div>
    </aside>
  );
};
