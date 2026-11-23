import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type {
  ConnectionAuth,
  ConnectionField,
  ConnectionMode,
  ConnectionSummary,
  PermissionStatus,
} from "@ballast/agent-protocol";
import { valueOf } from "@ballast/agent-protocol";

import { useAgent } from "../../state/context.tsx";
import {
  connectionStatusLabel,
  connectionStatusTone,
  integrationName,
} from "../../lib/format.ts";
import { CopyIcon, ExternalLinkIcon } from "../../ui/icons.tsx";
import {
  Button,
  Dialog,
  Field,
  IconButton,
  SelectInput,
  Status,
  TextInput,
} from "../../ui/primitives.tsx";

type BrowserAuth = Extract<ConnectionAuth, { readonly _tag: "browser" }>;
type DeviceAuth = Extract<ConnectionAuth, { readonly _tag: "device-code" }>;
type NoneAuth = Extract<ConnectionAuth, { readonly _tag: "none" }>;

const asBrowser = (auth: ConnectionAuth | undefined): BrowserAuth | undefined =>
  auth !== undefined && auth._tag === "browser" ? auth : undefined;
const asDevice = (auth: ConnectionAuth | undefined): DeviceAuth | undefined =>
  auth !== undefined && auth._tag === "device-code" ? auth : undefined;
const asNone = (auth: ConnectionAuth | undefined): NoneAuth | undefined =>
  auth !== undefined && auth._tag === "none" ? auth : undefined;

const modeLabels: Record<ConnectionMode, string> = {
  auto: "Auto",
  cloud: "Cloud",
  "local-app": "Own app",
};

const parseMode = (value: string): ConnectionMode =>
  value === "cloud" || value === "local-app" ? value : "auto";

const fieldValue = (connection: ConnectionSummary, field: ConnectionField): string =>
  valueOf(connection.values, field.key)?.value ?? "";

const fieldIsSet = (connection: ConnectionSummary, field: ConnectionField): boolean =>
  valueOf(connection.values, field.key)?.isSet === true;

const titleFor = (connection: ConnectionSummary): string => {
  const integration = integrationName(connection.integration);
  return connection.label === integration ? integration : `${integration} · ${connection.label}`;
};

export const ConnectionDialog = (props: {
  readonly connection: ConnectionSummary | undefined;
  readonly initialIntegration?: string;
  readonly permission: PermissionStatus | undefined;
  readonly requestingPermission: boolean;
  readonly hasBridge: boolean;
  readonly onRequestAccessibility: () => void;
  readonly onClose: () => void;
  readonly onCreated?: (connection: ConnectionSummary) => void;
}): JSX.Element => {
  const store = useAgent();
  const [createdId, setCreatedId] = createSignal<string>();
  const [integration, setIntegration] = createSignal(
    props.connection?.integration ?? props.initialIntegration ?? "",
  );
  const [label, setLabel] = createSignal(props.connection?.label ?? "");
  const [mode, setMode] = createSignal<ConnectionMode>(props.connection?.mode ?? "auto");
  const [drafts, setDrafts] = createSignal<Readonly<Record<string, string>>>({});
  const [auth, setAuth] = createSignal<ConnectionAuth>();
  const [error, setError] = createSignal<string>();

  const active = (): ConnectionSummary | undefined => {
    if (props.connection !== undefined) {
      return store.connection(props.connection.id) ?? props.connection;
    }
    const id = createdId();
    return id === undefined ? undefined : store.connection(id);
  };
  const isNew = (): boolean => active() === undefined;
  const activeIntegration = (): string => active()?.integration ?? integration();
  const definition = () =>
    store.integrations().find((entry) => entry.integration === activeIntegration());
  const allowedModes = (): ReadonlyArray<ConnectionMode> => {
    const modes = definition()?.modes ?? [];
    if (modes.length > 0) return modes;
    const current = active();
    return current === undefined ? ["auto"] : [current.mode];
  };

  const visibleFields = (): ReadonlyArray<ConnectionField> => {
    const current = active();
    const fields = current?.fields ?? definition()?.fields ?? [];
    return fields.filter((field) => {
      if (activeIntegration() === "keyboard" && field.key === "permission") return false;
      if (activeIntegration() !== "twitch") return true;
      if (mode() === "cloud") return field.key === "connection";
      return field.key !== "connection";
    });
  };

  const fillDrafts = (current: ConnectionSummary | undefined): void => {
    const next: Record<string, string> = {};
    for (const field of current?.fields ?? definition()?.fields ?? []) {
      next[field.key] = current === undefined ? "" : fieldValue(current, field);
    }
    setDrafts(next);
  };

  let initializedId: string | undefined;
  createEffect(() => {
    const current = props.connection;
    if (current !== undefined && initializedId === current.id) return;
    initializedId = current?.id;
    setLabel(current?.label ?? "");
    setMode(current?.mode ?? "auto");
    fillDrafts(current);
    setAuth(undefined);
    setError(undefined);
  });

  onMount(() => {
    if (store.integrations().length === 0) void store.loadIntegrations();
  });

  createEffect(() => {
    if (active() !== undefined) return;
    const loaded = store.integrations();
    if (loaded.length === 0) return;
    const current = definition();
    if (current === undefined) {
      setIntegration(loaded[0]?.integration ?? "");
      return;
    }
    fillDrafts(undefined);
    setAuth(undefined);
    const first = current.modes[0];
    if (first !== undefined) setMode(first);
  });

  const saving = (): boolean => {
    const current = active();
    return current === undefined
      ? store.isPending("connection:create")
      : store.isPending(`connection:${current.id}:update`) ||
          store.isPending(`connection:${current.id}:connect`) ||
          store.isPending(`connection:${current.id}`) ||
          store.isPending(`connection:${current.id}:auth`);
  };

  const isFieldStored = (field: ConnectionField): boolean => {
    const current = active();
    return current !== undefined && fieldIsSet(current, field);
  };

  const activeTitle = (): string => {
    const current = active();
    return current === undefined ? "Connection" : titleFor(current);
  };

  const requiredSatisfied = (): boolean =>
    visibleFields()
      .filter((field) => field.required)
      .every((field) => {
        const current = active();
        const draft = drafts()[field.key] ?? "";
        return draft !== "" || (current !== undefined && fieldIsSet(current, field));
      });

  const dirtyValues = (): ReadonlyArray<{ readonly key: string; readonly value: string }> =>
    visibleFields().flatMap((field) => {
      const current = active();
      const draft = drafts()[field.key] ?? "";
      if (current === undefined) {
        return draft === "" ? [] : [{ key: field.key, value: draft }];
      }
      if (field.kind === "secret") {
        return draft === "" ? [] : [{ key: field.key, value: draft }];
      }
      return draft === fieldValue(current, field) ? [] : [{ key: field.key, value: draft }];
    });

  const dirty = (): boolean => {
    const current = active();
    if (current === undefined) return true;
    return (
      dirtyValues().length > 0 ||
      label().trim() !== current.label ||
      mode() !== current.mode
    );
  };

  const create = async (): Promise<void> => {
    if (label().trim() === "") {
      setError("Enter a connection label.");
      return;
    }
    if (!requiredSatisfied()) {
      setError("Fill the required fields first.");
      return;
    }
    const config: Record<string, string> = {};
    for (const field of visibleFields()) {
      const value = drafts()[field.key] ?? "";
      if (value !== "") config[field.key] = value;
    }
    setError(undefined);
    const created = await store.createConnection({
      integration: integration(),
      label: label().trim(),
      config,
      ...(mode() === "auto" ? {} : { mode: mode() }),
    });
    if (created === undefined) {
      setError(store.lastActionError() ?? "Could not create the connection.");
      return;
    }
    setCreatedId(created.id);
    fillDrafts(created);
    props.onCreated?.(created);
    await connect(created);
  };

  const save = async (): Promise<boolean> => {
    const current = active();
    if (current === undefined) return false;
    const values = dirtyValues();
    if (values.length === 0 && label().trim() === current.label && mode() === current.mode) {
      return true;
    }
    const updated = await store.updateConnection({
      id: current.id,
      label: label().trim(),
      config: values.reduce<Record<string, string>>((all, value) => {
        all[value.key] = value.value;
        return all;
      }, {}),
      mode: mode(),
    });
    if (updated === undefined) {
      setError(store.lastActionError() ?? "Could not save the connection.");
      return false;
    }
    setError(undefined);
    fillDrafts(updated);
    return true;
  };

  const startAuth = async (connection: ConnectionSummary): Promise<void> => {
    const missing = connection.scopes.missing;
    const result = await store.startConnectionAuth(
      connection.id,
      mode(),
      missing.length > 0 ? missing : undefined,
    );
    if (result !== undefined) setAuth(result);
  };

  const connect = async (connection: ConnectionSummary): Promise<void> => {
    const next = await store.connectConnection(connection.id);
    if (next === undefined) return;
    if (next.integration === "twitch" && mode() !== "cloud") await startAuth(next);
  };

  const connectActive = async (): Promise<void> => {
    const current = active();
    if (current === undefined) return;
    if (!requiredSatisfied()) {
      setError("Fill the required fields first.");
      return;
    }
    const saved = await save();
    if (!saved) return;
    setError(undefined);
    await connect(current);
  };

  const disconnect = async (): Promise<void> => {
    const current = active();
    if (current === undefined) return;
    await store.disconnectConnection(current.id);
  };

  const reauthorize = async (): Promise<void> => {
    const current = active();
    if (current === undefined) return;
    const saved = await save();
    if (!saved) return;
    await startAuth(current);
  };

  const approval = createMemo(() => {
    const current = active();
    if (current?.approval === undefined) return undefined;
    if (current.approval.kind === "accessibility" && !props.hasBridge) return undefined;
    if (current.approval.kind === "accessibility") {
      const status = props.permission ?? current.approval.status ?? "unknown";
      if (status === "granted") return undefined;
      return {
        ...current.approval,
        status,
      };
    }
    return current.approval;
  });

  const accessibilityBlocked = (): boolean =>
    approval()?.kind === "accessibility" && approval()?.status !== "granted";

  const runApproval = async (): Promise<void> => {
    const current = active();
    if (current === undefined || approval() === undefined) return;
    if (approval()?.kind === "accessibility") {
      if (accessibilityBlocked()) {
        props.onRequestAccessibility();
        return;
      }
    }
    await connect(current);
  };

  const statusLabel = (): string => {
    const current = active();
    if (current === undefined) return "";
    if (accessibilityBlocked()) return "Needs permission";
    if (current.approval?.kind === "vtuber-studio") return "Waiting for approval";
    return connectionStatusLabel(current.status);
  };

  const statusTone = (): ReturnType<typeof connectionStatusTone> => {
    const current = active();
    if (current === undefined) return "neutral";
    if (accessibilityBlocked()) return "warning";
    if (current.approval?.kind === "vtuber-studio") return "warning";
    return connectionStatusTone(current.status);
  };

  const isConnected = (): boolean => active()?.status === "connected";

  return (
    <Dialog
      title={isNew() ? "Add connection" : activeTitle()}
      description={
        isNew()
          ? "Choose an integration, then label and configure the instance."
          : undefined
      }
      onClose={props.onClose}
      footer={
        <Show
          when={!isNew()}
          fallback={
            <>
              <Button variant="ghost" onClick={props.onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                data-testid="create-connection-submit"
                loading={saving()}
                disabled={label().trim() === ""}
                onClick={() => void create()}
              >
                Add connection
              </Button>
            </>
          }
        >
          <Show when={approval() === undefined}>
            <Show when={isConnected()}>
              <Button
                size="normal"
                variant="ghost"
                loading={store.isPending(`connection:${active()?.id}:disconnect`)}
                onClick={() => void disconnect()}
              >
                Disconnect
              </Button>
            </Show>
            <Show when={active()?.integration === "twitch"}>
              <Button
                size="normal"
                variant="outline"
                data-testid="connection-auth"
                loading={store.isPending(`connection:${active()?.id}:auth`)}
                onClick={() => void reauthorize()}
              >
                {(active()?.scopes.missing.length ?? 0) > 0 ? "Re-authorize" : "Sign in"}
              </Button>
            </Show>
            <Show when={dirty() && isConnected()}>
              <Button
                size="normal"
                variant="outline"
                loading={store.isPending(`connection:${active()?.id}:update`)}
                onClick={() => void save()}
              >
                Save
              </Button>
            </Show>
            <Show
              when={isConnected()}
              fallback={
                <Button
                  size="normal"
                  variant="primary"
                  data-testid="connection-connect"
                  disabled={!requiredSatisfied()}
                  loading={store.isPending(`connection:${active()?.id}:connect`)}
                  onClick={() => void connectActive()}
                >
                  Connect
                </Button>
              }
            >
              <Button size="normal" variant="neutral" onClick={props.onClose}>
                Done
              </Button>
            </Show>
          </Show>
          <Show when={approval() !== undefined}>
            <Button size="normal" variant="neutral" onClick={props.onClose}>
              Done
            </Button>
          </Show>
        </Show>
      }
    >
      <div class="max-h-[56vh] space-y-3 overflow-y-auto pr-0.5">
        <Show when={!isNew()}>
          <div class="flex items-center gap-2 text-[12px] text-muted">
            <Status tone={statusTone()}>{statusLabel()}</Status>
            <Show when={active()?.requiresAuth}>
              <span class="text-warning">authorization required</span>
            </Show>
          </div>
        </Show>

        <Show when={isNew()}>
          <Field
            label="Integration"
            hint={definition()?.description}
          >
            <SelectInput
              data-testid="connection-integration"
              value={integration()}
              disabled={store.integrations().length === 0}
              onChange={(event) => setIntegration(event.currentTarget.value)}
            >
              <Show when={store.integrations().length === 0}>
                <option value="">Loading integrations…</option>
              </Show>
              <For each={store.integrations()}>
                {(entry) => (
                  <option value={entry.integration} selected={entry.integration === integration()}>
                    {entry.title}
                  </option>
                )}
              </For>
            </SelectInput>
          </Field>
        </Show>

        <Field label="Label">
          <TextInput
            data-testid="connection-label"
            value={label()}
            placeholder={definition()?.title ?? "Studio OBS"}
            onInput={(event) => setLabel(event.currentTarget.value)}
          />
        </Field>

        <Show when={allowedModes().length > 1}>
          <Field label="Mode">
            <SelectInput
              data-testid="connection-mode"
              value={mode()}
              onChange={(event) => setMode(parseMode(event.currentTarget.value))}
            >
              <For each={allowedModes()}>
                {(option) => (
                  <option value={option} selected={option === mode()}>
                    {modeLabels[option]}
                  </option>
                )}
              </For>
            </SelectInput>
          </Field>
        </Show>

        <Show when={activeIntegration() === "twitch" && mode() !== "cloud"}>
          <Show
            when={definition()?.redirectUrl}
            fallback={
              <div class="rounded-md border border-edge bg-layer-2 px-2.5 py-2 text-[11px] text-muted">
                No callback port is configured, so there is no stable redirect URL to register.
                The service uses a temporary localhost callback on a random port, or Twitch's
                device flow when no client secret is set. Set{" "}
                <span class="font-mono text-body">BALLAST_TWITCH_CALLBACK_PORT</span> for own-app
                sign-in with a fixed redirect URL.
              </div>
            }
          >
            {(url) => (
              <div class="rounded-md border border-edge bg-layer-2 px-2.5 py-2">
                <div class="flex items-center gap-2">
                  <div class="min-w-0 flex-1">
                    <p class="text-[10px] text-faint">Redirect URL</p>
                    <p class="break-all font-mono text-[11px] text-body">{url()}</p>
                  </div>
                  <IconButton
                    label="Copy redirect URL"
                    testId="connection-redirect-copy"
                    onClick={() => {
                      void navigator.clipboard.writeText(url()).catch(() => undefined);
                    }}
                  >
                    <CopyIcon size={12} />
                  </IconButton>
                </div>
              </div>
            )}
          </Show>
        </Show>

        <For each={visibleFields()}>
          {(field) => (
            <Field
              label={field.required ? `${field.label} *` : field.label}
              hint={
                field.kind === "secret" && isFieldStored(field)
                  ? "stored · leave blank to keep"
                  : field.description
              }
            >
              <Show
                when={field.kind === "select" && field.options !== undefined}
                fallback={
                  <TextInput
                    data-testid={`connection-field-${field.key}`}
                    type={field.kind === "secret" ? "password" : "text"}
                    value={drafts()[field.key] ?? ""}
                    placeholder={
                      field.kind === "secret" && isFieldStored(field)
                        ? "••••••••"
                        : (field.placeholder ?? "")
                    }
                    autocomplete="off"
                    onInput={(event) => {
                      const value = event.currentTarget.value;
                      setDrafts((current) => ({ ...current, [field.key]: value }));
                    }}
                  />
                }
              >
                <SelectInput
                  data-testid={`connection-field-${field.key}`}
                  value={drafts()[field.key] ?? ""}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDrafts((current) => ({ ...current, [field.key]: value }));
                  }}
                >
                  <option value="">Default</option>
                  <For each={field.options ?? []}>
                    {(option) => (
                      <option value={option} selected={option === drafts()[field.key]}>
                        {option}
                      </option>
                    )}
                  </For>
                </SelectInput>
              </Show>
            </Field>
          )}
        </For>

        <Show when={approval()}>
          {(current) => (
            <div class="rounded-md border border-edge bg-layer-2 px-2.5 py-2">
              <p class="text-[12px] text-body">
                {current().message ??
                  (current().kind === "accessibility"
                    ? "macOS requires Accessibility permission for the process running the Ballast service."
                    : 'Allow "Ballast" in VTube Studio (the plugin request is waiting for you).')}
              </p>
              <Show when={current().kind === "accessibility"}>
                <p class="mt-0.5 text-[11px] text-muted">
                  Accessibility permission: {current().status ?? "unknown"}
                </p>
              </Show>
              <Button
                size="small"
                variant="primary"
                class="mt-2"
                data-testid="connection-approval-action"
                loading={props.requestingPermission || store.isPending(`connection:${active()?.id}:connect`)}
                onClick={() => void runApproval()}
              >
                {current().kind === "accessibility" && accessibilityBlocked()
                  ? "Open System Settings"
                  : "Check again"}
              </Button>
            </div>
          )}
        </Show>

        <Show when={active()?.lastError && approval() === undefined}>
          <p class="rounded bg-[var(--v2-state-bg-danger)] px-2 py-1.5 text-[11px] text-danger">
            {active()?.lastError}
          </p>
        </Show>

        <Show when={auth()}>
          {(result) => (
            <div class="space-y-1.5 rounded-md border border-edge bg-canvas px-2.5 py-2 text-[12px]">
              <Show when={asBrowser(result())}>
                {(browser) => (
                  <>
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-muted">Finish in your browser.</span>
                      <a
                        href={browser().url}
                        target="_blank"
                        rel="noreferrer"
                        class="inline-flex items-center gap-1 text-accent hover:underline"
                      >
                        Open page <ExternalLinkIcon size={11} />
                      </a>
                    </div>
                  </>
                )}
              </Show>
              <Show when={asDevice(result())}>
                {(device) => (
                  <div class="flex items-center justify-between gap-3">
                    <span class="font-mono text-[14px] tracking-wider text-strong">
                      {device().userCode}
                    </span>
                    <a
                      href={device().verificationUrl}
                      target="_blank"
                      rel="noreferrer"
                      class="text-accent hover:underline"
                    >
                      Open page
                    </a>
                  </div>
                )}
              </Show>
              <Show when={asNone(result())}>
                {(none) => <p class="text-muted">{none().message}</p>}
              </Show>
            </div>
          )}
        </Show>

        <Show when={error()}>
          <p class="text-[11px] text-danger">{error()}</p>
        </Show>
      </div>
    </Dialog>
  );
};
