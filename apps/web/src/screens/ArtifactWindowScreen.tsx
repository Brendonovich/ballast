import { Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useParams } from "@solidjs/router";

import { useAgent } from "../state/context.tsx";
import { EmptyState, Spinner } from "../ui/primitives.tsx";
import { ArtifactPanel } from "./project/ArtifactPanel.tsx";

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const ArtifactWindowScreen = (): JSX.Element => {
  const store = useAgent();
  const params = useParams<{ projectId?: string; artifact?: string }>();
  const projectId = createMemo(() => safeDecode(params.projectId ?? ""));
  const artifactName = createMemo(() => safeDecode(params.artifact ?? ""));
  const artifact = createMemo(() =>
    store.artifacts(projectId()).find((entry) => entry.name === artifactName()),
  );
  const [loadedKey, setLoadedKey] = createSignal<string>();
  const loadKey = createMemo(
    () => projectId() + "\u0000" + String(store.info()?.startedAt ?? ""),
  );
  const loading = createMemo(
    () => store.isProjectLoading(projectId()) || loadedKey() !== loadKey(),
  );

  createEffect(() => {
    const pid = projectId();
    const started = store.info()?.startedAt;
    const revision = store.artifactListRevision(pid);
    if (pid === "" || started === undefined) return;
    const key = loadKey();
    void revision;
    void store.fetchProject(pid);
    void store.fetchArtifacts(pid, true).then(
      () => setLoadedKey(key),
      () => setLoadedKey(key),
    );
  });

  return (
    <div class="h-full min-h-0 p-2">
      <Show
        when={artifact()}
        fallback={
          <Show
            when={loading()}
            fallback={
              <EmptyState
                title="Artifact not found"
                description="It may not be built yet, or the project is no longer registered."
              />
            }
          >
            <div class="flex h-full items-center justify-center gap-2 text-[12px] text-muted">
              <Spinner size={12} /> Loading artifact…
            </div>
          </Show>
        }
      >
        {(current) => (
          <ArtifactPanel
            projectId={projectId()}
            artifact={current()}
            fullscreen
          />
        )}
      </Show>
    </div>
  );
};
