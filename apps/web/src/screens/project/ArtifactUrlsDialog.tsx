import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type {
  ArtifactSummary,
  ArtifactUrlConfirmation,
  ArtifactUrlSummary,
} from "@ballast/agent-protocol";

import { useAgent } from "../../state/context.tsx";
import { formatRelative } from "../../lib/format.ts";
import { CopyIcon, TrashIcon } from "../../ui/icons.tsx";
import {
  Button,
  Dialog,
  Field,
  IconButton,
  SelectInput,
  Spinner,
} from "../../ui/primitives.tsx";

interface CreatedUrl {
  readonly url: ArtifactUrlSummary;
  readonly copyUrl: string;
}

export const ArtifactUrlsDialog = (props: {
  readonly projectId: string;
  readonly artifact: ArtifactSummary;
  readonly onClose: () => void;
}): JSX.Element => {
  const store = useAgent();
  const [urls, setUrls] = createSignal<ReadonlyArray<ArtifactUrlSummary>>([]);
  const [confirmations, setConfirmations] = createSignal<
    ReadonlyArray<ArtifactUrlConfirmation>
  >([]);
  const [scope, setScope] = createSignal<"read" | "action">("read");
  const [transparent, setTransparent] = createSignal(false);
  const [created, setCreated] = createSignal<CreatedUrl>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  let lastRevision = -1;

  const refresh = async (): Promise<void> => {
    const [nextUrls, nextConfirmations] = await Promise.all([
      store.listArtifactUrls(props.projectId, props.artifact.name),
      store.listArtifactUrlConfirmations(props.projectId),
    ]);
    if (nextUrls !== undefined) {
      setUrls(nextUrls.filter((url) => url.revokedAt === undefined));
    }
    if (nextConfirmations !== undefined) {
      setConfirmations(
        nextConfirmations.filter((confirmation) => confirmation.artifact === props.artifact.name),
      );
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
      scope: scope(),
      transparent: transparent(),
    });
    if (result === undefined) {
      setError(store.lastActionError() ?? "Could not create the URL.");
      return;
    }
    if (result._tag === "created") {
      setCreated(result);
      await refresh();
      return;
    }
    setConfirmations((current) =>
      current.some((entry) => entry.id === result.confirmation.id)
        ? current
        : [...current, result.confirmation],
    );
  };

  const approve = async (confirmation: ArtifactUrlConfirmation): Promise<void> => {
    const result = await store.approveArtifactUrl(confirmation.id);
    if (result === undefined) {
      setError(store.lastActionError() ?? "Could not approve the URL.");
      return;
    }
    setCreated(result);
    setConfirmations((current) => current.filter((entry) => entry.id !== confirmation.id));
    await refresh();
  };

  const reject = async (confirmation: ArtifactUrlConfirmation): Promise<void> => {
    const rejected = await store.rejectArtifactUrl(confirmation.id);
    if (!rejected) return;
    setConfirmations((current) => current.filter((entry) => entry.id !== confirmation.id));
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

        <div class="rounded-md border border-edge bg-layer-2 px-2.5 py-2">
          <div class="grid grid-cols-2 gap-2">
            <Field label="Scope">
              <SelectInput
                data-testid="artifact-url-scope"
                value={scope()}
                onChange={(event) =>
                  setScope(event.currentTarget.value === "action" ? "action" : "read")
                }
              >
                <option value="read">Read-only</option>
                <option value="action">Action</option>
              </SelectInput>
            </Field>
            <label class="flex items-end gap-2 pb-1 text-[11px] text-muted">
              <input
                type="checkbox"
                data-testid="artifact-url-transparent"
                checked={transparent()}
                class="size-3.5 accent-[var(--v2-text-text-accent)]"
                onChange={(event) => setTransparent(event.currentTarget.checked)}
              />
              Transparent
            </label>
          </div>
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

        <Show when={confirmations().length > 0}>
          <div class="space-y-2">
            <For each={confirmations()}>
              {(confirmation) => (
                <div
                  data-testid="artifact-url-confirmation"
                  class="rounded-md border border-[var(--v2-state-border-warning)] bg-[var(--v2-state-bg-warning)] px-2.5 py-2"
                >
                  <p class="text-[11px] font-medium text-warning">Action URL confirmation</p>
                  <p class="mt-0.5 text-[11px] text-body">{confirmation.summary}</p>
                  <Show when={confirmation.procedures.length > 0}>
                    <p class="mt-0.5 text-[10px] text-muted">
                      {confirmation.procedures.join(", ")}
                    </p>
                  </Show>
                  <div class="mt-2 flex items-center justify-end gap-1.5">
                    <Button
                      size="small"
                      variant="ghost"
                      loading={store.isPending(`artifacts:url:${confirmation.id}:reject`)}
                      onClick={() => void reject(confirmation)}
                    >
                      Reject
                    </Button>
                    <Button
                      size="small"
                      variant="primary"
                      loading={store.isPending(`artifacts:url:${confirmation.id}:approve`)}
                      onClick={() => void approve(confirmation)}
                    >
                      Approve
                    </Button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

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
                      {url.scope === "action" ? "Action" : "Read-only"}
                      {url.transparent ? " · transparent" : ""}
                      {url.lastUsedAt === undefined
                        ? " · never used"
                        : ` · used ${formatRelative(url.lastUsedAt)}`}
                    </p>
                  </div>
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
