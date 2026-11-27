import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { ShareServerSummary } from "@ballast/agent-protocol";

import { useAgent } from "../../state/context.tsx";
import { formatDateTime } from "../../lib/format.ts";
import { openExternal } from "../../lib/open-external.ts";
import { Button, Field, Section, Status, TextInput } from "../../ui/primitives.tsx";
import { toast } from "../../ui/toast.tsx";

const who = (server: ShareServerSummary): string | undefined => {
  const user = server.user;
  if (user === undefined) return undefined;
  return user.username === null ? (user.name ?? user.id) : "@" + user.username;
};

/** Start a browser sign-in to a share server (Sign in with Anomaly on the hosted one). */
export const useShareSignIn = () => {
  const store = useAgent();
  return async (server?: string): Promise<void> => {
    const started = await store.beginShareSignIn(server);
    if (started === undefined) {
      toast.error("Could not start sign-in", store.lastActionError() ?? "The share server is unreachable.");
      return;
    }
    openExternal(started.url);
  };
};

/**
 * Settings → Sharing (decision 0014): the default share server and this
 * machine's sign-in to each server a project uses.
 */
export const SharingSection = (): JSX.Element => {
  const store = useAgent();
  const signIn = useShareSignIn();
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");

  createEffect(() => {
    const result = store.shareSignInResult();
    if (result !== undefined && !result.ok) toast.error("Sign-in failed", result.error ?? result.server);
  });

  const servers = () => store.shareServers()?.servers ?? [];

  const saveDefault = async (value?: string): Promise<void> => {
    if (await store.setDefaultShareServer(value)) setEditing(false);
    else toast.error("Could not set the share server", store.lastActionError() ?? "");
  };

  return (
    <Section
      title="Sharing"
      description="Publishing a project needs you signed in to its share server; your Anomaly account, not this machine, owns your shares. Subscribing only needs a share link."
    >
      <div class="border-t border-edge">
        <div class="flex min-h-9 items-center justify-between gap-6 border-b border-edge py-1.5 text-[12px]">
          <span class="text-muted">Default server</span>
          <Show
            when={editing()}
            fallback={
              <span class="flex min-w-0 items-center gap-2 text-body">
                <span data-testid="share-default-server" class="truncate font-mono">
                  {store.shareServers()?.defaultServer ?? "Not configured"}
                </span>
                <button
                  type="button"
                  class="text-accent hover:underline"
                  onClick={() => {
                    setDraft(store.shareServers()?.defaultServer ?? "");
                    setEditing(true);
                  }}
                >
                  Change
                </button>
              </span>
            }
          >
            <span class="flex items-end gap-2">
              <Field label="Server URL" class="w-72">
                <TextInput
                  data-testid="share-default-server-input"
                  value={draft()}
                  autofocus
                  placeholder="https://share.example"
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveDefault(draft());
                  }}
                />
              </Field>
              <Button variant="primary" loading={store.isPending("shares:default")} onClick={() => void saveDefault(draft())}>
                Save
              </Button>
              <Button variant="ghost" title="Use the built-in server again" onClick={() => void saveDefault()}>
                Reset
              </Button>
            </span>
          </Show>
        </div>
        <For each={servers()}>
          {(server) => (
            <div
              data-testid="share-server"
              class="flex min-h-11 items-center justify-between gap-6 border-b border-edge py-2 text-[12px] last:border-b-0"
            >
              <div class="min-w-0">
                <p class="truncate font-mono text-body">{server.url}</p>
                <p class="text-[11px] text-faint">
                  {server.default ? "Default · " : ""}
                  {server.projects === 1 ? "1 project" : `${server.projects} projects`}
                  <Show when={server.signedInAt}>{(at) => <> · signed in {formatDateTime(at())}</>}</Show>
                </p>
              </div>
              <Show
                when={who(server)}
                fallback={
                  <Button
                    variant="primary"
                    size="small"
                    data-testid="share-sign-in"
                    loading={store.isPending("shares:sign-in")}
                    onClick={() => void signIn(server.url)}
                  >
                    Sign in with Anomaly
                  </Button>
                }
              >
                {(name) => (
                  <span class="flex items-center gap-3">
                    <Status tone="success">{name()}</Status>
                    <Button
                      variant="ghost"
                      size="small"
                      data-testid="share-sign-out"
                      loading={store.isPending(`shares:sign-out:${server.url}`)}
                      onClick={() => void store.signOutShareServer(server.url)}
                    >
                      Sign out
                    </Button>
                  </span>
                )}
              </Show>
            </div>
          )}
        </For>
      </div>
    </Section>
  );
};
