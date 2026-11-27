import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type {
  ArtifactSummary,
  ArtifactUrlSummary,
} from "@ballast/agent-protocol";

import { useAgent } from "../../state/context.tsx";
import { formatRelative } from "../../lib/format.ts";
import { CopyIcon, TrashIcon } from "../../ui/icons.tsx";
import { Button, Dialog, IconButton, Spinner } from "../../ui/primitives.tsx";

interface CreatedUrl {
  readonly url: ArtifactUrlSummary;
  readonly copyUrl: string;
}

/**
 * The stable URL is the same before and after a restart. OBS overlays ask for
 * a transparent page; the gateway does not need a second token for that.
 */
const withBackground = (url: string, transparent: boolean): string =>
  !transparent
    ? url
    : url.includes("?")
      ? url + "&background=transparent"
      : url + "?background=transparent";

export const ArtifactUrlsDialog = (props: {
  readonly projectId: string;
  readonly artifact: ArtifactSummary;
  readonly onClose: () => void;
}): JSX.Element => {
  const store = useAgent();
  const [urls, setUrls] = createSignal<ReadonlyArray<ArtifactUrlSummary>>([]);
  const [transparent, setTransparent] = createSignal(false);
  const [created, setCreated] = createSignal<CreatedUrl>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  let lastRevision = -1;

  const refresh = async (): Promise<void> => {
    const nextUrls = await store.listArtifactUrls(props.projectId, props.artifact.name);
    if (nextUrls !== undefined) {
      setUrls(nextUrls.filter((url) => url.revokedAt === undefined));
    }
    setLoading(false);
  };

  createEffect(() => {
    const revision = store.artifactUrlRevision();
    if (revision === lastRevision) return;
    lastRevision = revision;
    void refresh();
  });

  const copy = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // The URL stays selectable when clipboard access is denied.
    }
  };

  const create = async (): Promise<void> => {
    setError(undefined);
    const result = await store.createArtifactUrl({
      projectId: props.projectId,
      artifact: props.artifact.name,
      transparent: transparent(),
    });
    if (result === undefined) {
      setError(store.lastActionError() ?? "Could not create the URL.");
      return;
    }
    setCreated(result);
    await refresh();
  };

  const revoke = async (url: ArtifactUrlSummary): Promise<void> => {
    const revoked = await store.revokeArtifactUrl(url.id);
    if (!revoked) return;
    setUrls((current) => current.filter((entry) => entry.id !== url.id));
    if (created()?.url.id === url.id) setCreated(undefined);
  };

  return (
    <Dialog
      title="Artifact URLs"
      description={props.artifact.title ?? props.artifact.name}
      onClose={props.onClose}
      footer={
        <Button variant="neutral" onClick={props.onClose}>
          Done
        </Button>
      }
    >
      <div class="max-h-[58vh] space-y-3 overflow-y-auto pr-0.5">
        <Show when={created()}>
          {(value) => (
            <div
              data-testid="artifact-url-created"
              class="rounded-md border border-[var(--v2-state-border-success)] bg-[var(--v2-state-bg-success)] px-2.5 py-2"
            >
              <p class="text-[11px] font-medium text-success">URL created</p>
              <div class="mt-1 flex items-center gap-2">
                <p
                  data-testid="artifact-url-copy-value"
                  class="min-w-0 flex-1 break-all font-mono text-[10px] text-body"
                >
                  {value().copyUrl}
                </p>
                <IconButton
                  label="Copy URL"
                  testId="artifact-url-copy"
                  onClick={() => void copy(value().copyUrl)}
                >
                  <CopyIcon size={12} />
                </IconButton>
              </div>
            </div>
          )}
        </Show>

        <Show when={props.artifact.stableUrl}>
          {(stableUrl) => (
            <div
              data-testid="artifact-url-stable"
              class="rounded-md border border-edge bg-layer-2 px-2.5 py-2"
            >
              <p class="text-[11px] font-medium text-body">Stable URL</p>
              <p class="mt-0.5 text-[10px] text-faint">
                Always available and unchanged across service restarts. Use it
                for OBS browser sources.
              </p>
              <div class="mt-1 flex items-center gap-2">
                <p
                  data-testid="artifact-url-stable-value"
                  class="min-w-0 flex-1 break-all font-mono text-[10px] text-body"
                >
                  {withBackground(stableUrl(), transparent())}
                </p>
                <IconButton
                  label="Copy stable URL"
                  testId="artifact-url-stable-copy"
                  onClick={() => void copy(withBackground(stableUrl(), transparent()))}
                >
                  <CopyIcon size={12} />
                </IconButton>
              </div>
            </div>
          )}
        </Show>

        <div class="rounded-md border border-edge bg-layer-2 px-2.5 py-2">
          <label class="flex items-center gap-2 text-[11px] text-muted">
            <input
              type="checkbox"
              data-testid="artifact-url-transparent"
              checked={transparent()}
              class="size-3.5 accent-[var(--v2-text-text-accent)]"
              onChange={(event) => setTransparent(event.currentTarget.checked)}
            />
            Transparent
          </label>
          <Button
            size="small"
            variant="primary"
            class="mt-2"
            data-testid="artifact-url-create"
            loading={store.isPending(
              `artifacts:${props.projectId}:${props.artifact.name}:url:create`,
            )}
            onClick={() => void create()}
          >
            Create URL
          </Button>
        </div>

        <div>
          <p class="mb-1 text-[11px] font-medium text-body">Existing URLs</p>
          <Show
            when={urls().length > 0}
            fallback={<p class="py-2 text-[11px] text-faint">No persistent URLs.</p>}
          >
            <For each={urls()}>
              {(url) => (
                <div
                  data-testid="artifact-url-row"
                  data-url-id={url.id}
                  class="flex items-start gap-2 border-b border-edge py-2 last:border-b-0"
                >
                  <div class="min-w-0 flex-1">
                    <p class="truncate font-mono text-[10px] text-body">{url.urlPreview}</p>
                    <p class="mt-0.5 text-[10px] text-faint">
                      {url.transparent ? "transparent" : "opaque"}
                      {url.lastUsedAt === undefined
                        ? " · never used"
                        : ` · used ${formatRelative(url.lastUsedAt)}`}
                    </p>
                  </div>
                  <Show when={url.url}>
                    {(copyValue) => (
                      <IconButton
                        label="Copy URL"
                        testId="artifact-url-copy-existing"
                        size="small"
                        onClick={() => void copy(copyValue())}
                      >
                        <CopyIcon size={12} />
                      </IconButton>
                    )}
                  </Show>
                  <IconButton
                    label="Revoke URL"
                    testId="artifact-url-revoke"
                    size="small"
                    onClick={() => void revoke(url)}
                  >
                    <TrashIcon size={12} />
                  </IconButton>
                </div>
              )}
            </For>
          </Show>
        </div>

        <Show when={loading()}>
          <div class="flex items-center gap-2 text-[11px] text-muted">
            <Spinner size={10} /> Loading URLs…
          </div>
        </Show>
        <Show when={error()}>
          <p class="text-[11px] text-danger">{error()}</p>
        </Show>
      </div>
    </Dialog>
  );
};
