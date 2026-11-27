import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { ArtifactSummary } from "@ballast/agent-protocol";

import { artifactStatusLabel, artifactStatusTone } from "../../lib/format.ts";
import { StatusDot, cx } from "../../ui/primitives.tsx";

/**
 * The View mode's only navigator: the project's artifacts as tabs across the
 * top of the artifact, styled like the Develop tab strip. Each tab shows the
 * same status dot as the Outline's artifact group.
 */
export const ArtifactList = (props: {
  readonly artifacts: ReadonlyArray<ArtifactSummary>;
  readonly active: string | undefined;
  readonly onSelect: (artifact: ArtifactSummary) => void;
}): JSX.Element => {
  const selected = (artifact: ArtifactSummary): boolean => props.active === artifact.name;

  return (
    <div
      role="tablist"
      aria-label="Artifacts"
      data-testid="artifact-list"
      class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
    >
      <For each={props.artifacts}>
        {(artifact) => (
          <button
            type="button"
            role="tab"
            tabIndex={selected(artifact) ? 0 : -1}
            aria-selected={selected(artifact)}
            data-testid="artifact-list-row"
            data-artifact={artifact.name}
            data-status={artifact.status}
            data-selected={selected(artifact) ? "true" : undefined}
            title={[artifact.title ?? artifact.name, artifact.name, artifact.error]
              .filter((part) => part !== undefined)
              .join("\n")}
            class={cx(
              "flex h-6 max-w-[220px] shrink-0 items-center gap-1.5 rounded px-2 text-[12px] leading-4 transition-colors",
              selected(artifact)
                ? "bg-[var(--v2-background-bg-layer-02)] text-body"
                : "text-muted hover:bg-hover",
            )}
            onClick={() => props.onSelect(artifact)}
          >
            <StatusDot tone={artifactStatusTone(artifact.status)} />
            <span class="min-w-0 truncate">{artifact.title ?? artifact.name}</span>
            <Show when={artifact.status !== "ready"}>
              <span
                class={cx(
                  "shrink-0 text-[10px]",
                  artifact.status === "error" ? "text-danger" : "text-faint",
                )}
              >
                {artifactStatusLabel(artifact.status)}
              </span>
            </Show>
          </button>
        )}
      </For>
    </div>
  );
};
