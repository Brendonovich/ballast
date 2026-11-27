import { Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { ApplyProjectUpdateResult, DeployProjectResult, ProjectSummary } from "@ballast/agent-protocol";
import { shareLink } from "@ballast/agent-protocol";

import { formatDateTime, formatRelative } from "../../lib/format.ts";
import { useAgent } from "../../state/context.tsx";
import { useShareSignIn } from "../settings/SharingSection.tsx";
import { AlertIcon, ArrowDownIcon, CheckIcon, CopyIcon, RefreshIcon, UploadIcon } from "../../ui/icons.tsx";
import { Button, Spinner, TextInput, cx } from "../../ui/primitives.tsx";

const short = (sha: string): string => sha.slice(0, 8);

type ShareState = "none" | "shared" | "subscribed" | "update";

/**
 * Top-bar Share (decisions 0013, 0014). Its label is the sharing state and
 * its popover holds everything about it: share and deploy a project from
 * this machine, or check for and apply updates to a subscribed copy.
 */
export const ShareButton = (props: { readonly project: ProjectSummary }): JSX.Element => {
  const store = useAgent();
  const signIn = useShareSignIn();
  const [open, setOpen] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [deployed, setDeployed] = createSignal<DeployProjectResult>();
  const [checked, setChecked] = createSignal(false);
  const [applied, setApplied] = createSignal<ApplyProjectUpdateResult>();
  let root: HTMLDivElement | undefined;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copiedTimer));

  const id = (): string => props.project.id;
  const share = () => props.project.share;
  const shared = () => {
    const value = share();
    return value?._tag === "shared" ? value : undefined;
  };
  const subscribed = () => {
    const value = share();
    return value?._tag === "subscribed" ? value : undefined;
  };
  const state = (): ShareState => {
    const value = share();
    if (value === undefined) return "none";
    if (value._tag === "shared") return "shared";
    return value.available === undefined ? "subscribed" : "update";
  };

  // Shared projects deploy to their own server; a new share goes to the default.
  const signedIn = (): boolean => store.signedInToShareServer(share()?.server);
  const sharing = (): boolean => store.isPending(`project:${id()}:share`);
  const checking = (): boolean => store.isPending(`project:${id()}:check-update`);
  const applying = (): boolean => store.isPending(`project:${id()}:update`);

  const toggle = (): void => {
    const next = !open();
    setOpen(next);
    if (!next) return;
    setDeployed(undefined);
    setChecked(false);
    setApplied(undefined);
  };

  onMount(() => {
    const onPointer = (event: PointerEvent): void => {
      if (!open() || root === undefined) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && open()) {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    });
  });

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard access can be denied; the code stays visible to copy by hand.
    }
  };

  const deploy = async (): Promise<void> => {
    if (!signedIn()) {
      void signIn(share()?.server);
      return;
    }
    setDeployed(undefined);
    const result = await store.shareProject(id(), message().trim() || undefined);
    if (result === undefined) return;
    setDeployed(result);
    if (result.deployed) setMessage("");
  };

  const check = async (): Promise<void> => {
    setChecked(false);
    const result = await store.checkProjectUpdate(id());
    if (result !== undefined) setChecked(true);
  };

  const apply = async (): Promise<void> => {
    const result = await store.applyProjectUpdate(id());
    if (result !== undefined) setApplied(result);
  };

  const label = (): string => {
    switch (state()) {
      case "none":
        return "Share";
      case "shared":
        return "Shared";
      case "subscribed":
        return "Updates";
      case "update":
        return "Update";
    }
  };

  const Section = (sectionProps: { readonly children: JSX.Element; readonly class?: string }): JSX.Element => (
    <div class={cx("border-t border-edge px-3 py-2.5 first:border-t-0", sectionProps.class)}>
      {sectionProps.children}
    </div>
  );

  return (
    <div ref={root} class="relative flex items-center">
      <Button
        size="small"
        variant="outline"
        class="h-7"
        data-testid="share-button"
        data-share-state={state()}
        aria-haspopup="dialog"
        aria-expanded={open()}
        title={
          state() === "update" ? "An update to this shared project is available" : "Sharing"
        }
        loading={sharing() || checking() || applying()}
        icon={
          state() === "update" ? (
            <ArrowDownIcon size={12} class="text-warning" />
          ) : (
            <UploadIcon size={12} class="text-faint" />
          )
        }
        onClick={toggle}
      >
        {label()}
        <Show when={state() === "update"}>
          <span class="size-1.5 rounded-full bg-[var(--v2-state-border-warning)]" aria-hidden="true" />
        </Show>
      </Button>

      <Show when={open()}>
        <div
          role="dialog"
          aria-label="Sharing"
          data-testid="share-popover"
          data-no-drag
          class="absolute right-0 top-8 z-40 w-[320px] rounded-md border border-edge-strong bg-layer shadow-[var(--v2-elevation-overlay)]"
        >
          <Switch>
            <Match when={state() === "none"}>
              <Section>
                <p class="text-[12px] font-medium text-strong">Share this project</p>
                <p class="mt-1 text-[11px] text-muted">
                  Anyone with the link gets a read-only copy and is told when you deploy a new
                  version.
                </p>
                <Button
                  size="small"
                  variant="primary"
                  class="mt-2.5 w-full"
                  data-testid="share-project"
                  loading={sharing()}
                  onClick={() => void deploy()}
                >
                  {signedIn() ? "Share" : "Sign in to share"}
                </Button>
              </Section>
            </Match>

            <Match when={shared()}>
              {(value) => (
                <>
                  <Section>
                    <p class="text-[10px] font-medium uppercase tracking-wide text-faint">Share link</p>
                    <div class="mt-1.5 flex items-center gap-2">
                      <code
                        data-testid="share-code"
                        class="min-w-0 flex-1 select-all truncate rounded bg-canvas px-2 py-1 font-mono text-[12px] text-strong"
                        title={shareLink(value().server, value().shareCode)}
                      >
                        {value().shareCode}
                      </code>
                      <Button
                        size="small"
                        variant="outline"
                        data-testid="copy-share-link"
                        icon={copied() ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
                        onClick={() => void copy(shareLink(value().server, value().shareCode))}
                      >
                        {copied() ? "Copied" : "Copy link"}
                      </Button>
                    </div>
                  </Section>
                  <Section>
                    <p class="text-[11px] text-muted" data-testid="share-deployed">
                      <Show
                        when={value().deployedAt}
                        fallback="Not deployed yet"
                      >
                        {(at) => (
                          <>
                            Deployed <span title={formatDateTime(at())}>{formatRelative(at())}</span>
                            <Show when={value().sha}>
                              {(sha) => <span class="font-mono text-faint"> · {short(sha())}</span>}
                            </Show>
                          </>
                        )}
                      </Show>
                    </p>
                    <TextInput
                      type="text"
                      data-testid="deploy-message"
                      placeholder="What changed? (shown to subscribers)"
                      value={message()}
                      onInput={(event) => setMessage(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void deploy();
                      }}
                      class="mt-2 text-[12px]"
                    />
                    <Button
                      size="small"
                      variant="primary"
                      class="mt-2 w-full"
                      data-testid="share-project"
                      loading={sharing()}
                      icon={<UploadIcon size={12} />}
                      onClick={() => void deploy()}
                    >
                      {signedIn() ? "Deploy" : "Sign in to deploy"}
                    </Button>
                    <Show when={deployed()}>
                      {(result) => (
                        <p data-testid="deploy-result" class="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
                          <CheckIcon size={11} class="text-success" />
                          {result().deployed
                            ? `Deployed ${result().files} ${result().files === 1 ? "file" : "files"} to subscribers`
                            : "No changes since the last deploy"}
                        </p>
                      )}
                    </Show>
                  </Section>
                </>
              )}
            </Match>

            <Match when={subscribed()}>
              {(value) => (
                <>
                  <Section>
                    <p data-testid="share-subscribed" class="text-[12px] font-medium text-strong">
                      Read-only copy of a shared project
                    </p>
                    <p class="mt-1 text-[11px] text-muted">
                      Installed <span title={formatDateTime(value().installedAt)}>{formatRelative(value().installedAt)}</span>
                      <span class="font-mono text-faint"> · {short(value().installedSha)}</span>
                    </p>
                    <p class="mt-0.5 truncate text-[11px] text-faint" title={value().server}>
                      From {value().server}
                    </p>
                    <Show when={applied()}>
                      {(result) => (
                        <p data-testid="update-result" class="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
                          <CheckIcon size={11} class="text-success" />
                          Updated: {result().changed.length} changed, {result().deleted.length} deleted
                          {result().restarted ? ", restarted" : ""}
                        </p>
                      )}
                    </Show>
                  </Section>
                  <Show
                    when={value().available}
                    fallback={
                      <Section>
                        <Button
                          size="small"
                          variant="outline"
                          class="w-full"
                          data-testid="check-project-update"
                          disabled={checking()}
                          icon={
                            checking() ? (
                              <Spinner size={11} />
                            ) : checked() ? (
                              <CheckIcon size={12} />
                            ) : (
                              <RefreshIcon size={12} />
                            )
                          }
                          onClick={() => void check()}
                        >
                          {checking() ? "Checking…" : checked() ? "Up to date" : "Check for updates"}
                        </Button>
                      </Section>
                    }
                  >
                    {(update) => (
                      <Section class="bg-[var(--v2-state-bg-warning)]">
                        <div data-testid="share-update-available">
                          <p class="flex items-center gap-1.5 text-[12px] font-medium text-warning">
                            <AlertIcon size={12} class="shrink-0" />
                            Update available
                            <span class="font-mono text-[11px] font-normal">{short(update().sha)}</span>
                          </p>
                          <Show when={update().message}>
                            {(text) => <p class="mt-1 text-[12px] text-body">{text()}</p>}
                          </Show>
                          <p class="mt-1 text-[11px] text-muted">
                            Deployed {formatRelative(update().deployedAt)}. Applying overwrites local
                            edits and restarts the project if it's running. New permissions still need
                            approval.
                          </p>
                          <Button
                            size="small"
                            variant="primary"
                            class="mt-2.5 w-full"
                            data-testid="apply-project-update"
                            loading={applying()}
                            onClick={() => void apply()}
                          >
                            Apply update
                          </Button>
                        </div>
                      </Section>
                    )}
                  </Show>
                </>
              )}
            </Match>
          </Switch>
        </div>
      </Show>
    </div>
  );
};
