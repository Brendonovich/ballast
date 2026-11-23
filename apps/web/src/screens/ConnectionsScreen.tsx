import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type {
  ConnectionAuth,
  ConnectionField,
  ConnectionMode,
  ConnectionSummary,
  PermissionStatus,
} from "@ballast/agent-protocol";
import { valueOf } from "@ballast/agent-protocol";

import { useAgent } from "../state/context.tsx";
import { getDesktopBridge } from "../bridge.ts";
import {
  connectionNeedsAttention,
  connectionStatusLabel,
  connectionStatusTone,
  integrationName,
  plural,
} from "../lib/format.ts";
import { ExternalLinkIcon } from "../ui/icons.tsx";
import {
  Button,
  Dialog,
  Field,
  PageHeader,
  SelectInput,
  Status,
  StatusDot,
  TextInput,
} from "../ui/primitives.tsx";
import { toast } from "../ui/toast.tsx";

const subtitle = (connection: ConnectionSummary): string => {
  const integration = integrationName(connection.integration);
  const parts: Array<string> = [];
  if (connection.label !== connection.slot && connection.label !== integration) {
    parts.push(connection.label);
  }
  if (connection.account !== undefined) parts.push(`@${connection.account.login}`);
  if (
    connection.detail !== undefined &&
    connection.detail !== integration &&
    connection.detail !== connection.label
  ) {
    parts.push(connection.detail);
  }
  return parts.join(" · ");
};

interface ApprovalView {
  readonly kind: "vtuber-studio" | "accessibility";
  readonly message: string;
  readonly status?: PermissionStatus;
  readonly label: string;
}

const approvalFor = (
  connection: ConnectionSummary,
  hasBridge: boolean,
  permission: PermissionStatus | undefined,
): ApprovalView | undefined => {
  const approval = connection.approval;
  if (approval === undefined) return undefined;
  if (approval.kind === "accessibility") {
    // A plain browser cannot grant a shell permission; keep the row normal.
    if (!hasBridge) return undefined;
    const status = permission ?? approval.status ?? "unknown";
    return {
      kind: "accessibility",
      message:
        approval.message ??
        "macOS requires Accessibility permission for the process running the Ballast service.",
      status,
      label: status === "granted" ? "Check again" : "Open System Settings",
    };
  }
  return {
    kind: "vtuber-studio",
    message:
      approval.message ??
      'Allow "Ballast" in VTube Studio (the plugin request is waiting for you).',
    label: "Check again",
  };
};

const connectionNeedsAction = (connection: ConnectionSummary): boolean =>
  connection.requiresAuth ||
  connection.status === "reauth-required" ||
  connection.scopes.missing.length > 0;

const actionLabel = (connection: ConnectionSummary): string => {
  if (connectionNeedsAction(connection)) return "Sign in";
  if (connection.status === "unconfigured") return "Configure";
  if (connection.status === "connected") return "Manage";
  return "Connect";
};

const fieldValue = (connection: ConnectionSummary, field: ConnectionField): string =>
  valueOf(connection.values, field.key)?.value ?? "";

const parseMode = (value: string): ConnectionMode => {
  if (value === "cloud" || value === "local-app") return value;
  return "auto";
};

type BrowserAuth = Extract<ConnectionAuth, { readonly _tag: "browser" }>;
type DeviceAuth = Extract<ConnectionAuth, { readonly _tag: "device-code" }>;
type NoneAuth = Extract<ConnectionAuth, { readonly _tag: "none" }>;

const asBrowser = (auth: ConnectionAuth | undefined): BrowserAuth | undefined =>
  auth !== undefined && auth._tag === "browser" ? auth : undefined;
const asDevice = (auth: ConnectionAuth | undefined): DeviceAuth | undefined =>
  auth !== undefined && auth._tag === "device-code" ? auth : undefined;
const asNone = (auth: ConnectionAuth | undefined): NoneAuth | undefined =>
  auth !== undefined && auth._tag === "none" ? auth : undefined;

const modeOptions: ReadonlyArray<{ readonly value: ConnectionMode; readonly label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "cloud", label: "Cloud" },
  { value: "local-app", label: "Local app" },
];

export const ConnectionsScreen = (): JSX.Element => {
  const store = useAgent();
  const bridge = getDesktopBridge();
  const [permission, setPermission] = createSignal<PermissionStatus>();
  const [requestingPermission, setRequestingPermission] = createSignal(false);
  const [activeId, setActiveId] = createSignal<string>();

  onMount(() => {
    if (bridge === undefined) return;
    let active = true;
    void bridge.permissions
      .status()
      .then(async (status) => {
        if (!active) return;
        setPermission(status.accessibility);
        // apps/desktop reports the result of an actual request itself. Only
        // sync an initial non-granted state when no keyboard connection exists
        // to reconcile; otherwise the shell owns that update.
        const hasKeyboard = store
          .connections()
          .some((connection) => connection.integration === "keyboard");
        if (status.accessibility !== "granted" && !hasKeyboard) {
          await store.reportShellPermission("accessibility", status.accessibility);
        }
      })
      .catch(() => {
        // Permission status is optional; the connection row still works.
      });
    onCleanup(() => {
      active = false;
    });
  });

  const requestAccessibility = async (): Promise<void> => {
    if (bridge === undefined) return;
    setRequestingPermission(true);
    try {
      const status = await bridge.permissions.requestAccessibility();
      setPermission(status.accessibility);
      // apps/desktop's requestAccessibility already reports the result through
      // ReportShellPermission; do not duplicate that reconcile here.
    } catch (error) {
      toast.error(
        "Accessibility request failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setRequestingPermission(false);
    }
  };
  const active = createMemo(() => {
    const id = activeId();
    return id === undefined ? undefined : store.connection(id);
  });

  return (
    <div>
      <PageHeader
        title="Connections"
        description="OBS, Twitch and other integrations are shared by every project."
      />

      <Show
        when={store.connections().length > 0}
        fallback={
          <p class="mt-10 text-[13px] text-muted">No connections have been registered yet.</p>
        }
      >
        <div class="mt-6 border-t border-edge">
          <For each={store.connections()}>
            {(connection) => {
              const approval = (): ApprovalView | undefined =>
                approvalFor(connection, bridge !== undefined, permission());
              const detail = (): string => {
                if (approval() !== undefined) return approval()?.message ?? "";
                if (
                  connection.integration === "keyboard" &&
                  connection.approval?.kind === "accessibility" &&
                  bridge === undefined
                ) {
                  // A plain browser cannot grant shell permissions; do not
                  // leave a dead-end accessibility warning in the row.
                  return connection.label !== connection.slot ? connection.label : "";
                }
                return subtitle(connection);
              };
              return (
                <div
                  data-testid="connection-row"
                  data-connection-id={connection.id}
                  data-approval={approval()?.kind}
                  class="flex min-h-14 items-center gap-3 border-b border-edge py-2"
                >
                  <StatusDot
                    tone={connectionStatusTone(connection.status)}
                    pulse={connection.status === "connecting"}
                    class="ml-1"
                  />
                  <div class="min-w-0 flex-1">
                    <p class="flex items-baseline gap-2 text-[13px] font-medium text-strong">
                      <span class="truncate">{integrationName(connection.integration)}</span>
                      <span class="text-[11px] font-normal text-faint">·</span>
                      <span class="font-mono text-[11px] font-normal text-faint">
                        {connection.slot}
                      </span>
                    </p>
                    <p class="truncate text-[11px] text-muted">
                      {detail()}
                      <Show when={connection.lastError && approval() === undefined && detail() !== ""}>
                        <span class="ml-2 text-danger">{connection.lastError}</span>
                      </Show>
                    </p>
                  </div>
                  <Status tone={connectionStatusTone(connection.status)}>
                    {connectionStatusLabel(connection.status)}
                  </Status>
                  <Button
                    size="small"
                    variant={connectionNeedsAttention(connection) ? "neutral" : "outline"}
                    onClick={() => setActiveId(connection.id)}
                  >
                    {approval() === undefined ? actionLabel(connection) : "Review"}
                  </Button>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      <Show when={active()}>
        {(connection) => (
          <ConnectionDialog
            connection={connection()}
            approval={approvalFor(connection(), bridge !== undefined, permission())}
            keyboardPermission={
              bridge !== undefined && connection().integration === "keyboard"
                ? permission()
                : undefined
            }
            requestingPermission={requestingPermission()}
            onRequestAccessibility={() => void requestAccessibility()}
            onClose={() => setActiveId(undefined)}
          />
        )}
      </Show>
    </div>
  );
};

const ConnectionDialog = (props: {
  readonly connection: ConnectionSummary;
  readonly approval: ApprovalView | undefined;
  readonly keyboardPermission: PermissionStatus | undefined;
  readonly requestingPermission: boolean;
  readonly onRequestAccessibility: () => void;
  readonly onClose: () => void;
}): JSX.Element => {
  const store = useAgent();
  const [drafts, setDrafts] = createSignal<Readonly<Record<string, string>>>({});
  const [mode, setMode] = createSignal<ConnectionMode>("auto");
  const [auth, setAuth] = createSignal<ConnectionAuth>();
  const [formError, setFormError] = createSignal<string>();

  createEffect(() => {
    const connection = props.connection;
    const next: Record<string, string> = {};
    for (const field of connection.fields) next[field.key] = fieldValue(connection, field);
    setDrafts(next);
    setMode(connection.mode);
    setAuth(undefined);
    setFormError(undefined);
  });

  const dirtyValues = (): ReadonlyArray<{ readonly key: string; readonly value: string }> =>
    props.connection.fields.flatMap((field) => {
      const draft = drafts()[field.key] ?? "";
      const initial = fieldValue(props.connection, field);
      if (field.kind === "secret") return draft === "" ? [] : [{ key: field.key, value: draft }];
      return draft === initial ? [] : [{ key: field.key, value: draft }];
    });

  const dirty = (): boolean => dirtyValues().length > 0 || mode() !== props.connection.mode;

  const requiredSatisfied = (): boolean => {
    if (props.connection.integration === "twitch" && mode() !== "local-app") return true;
    return props.connection.fields
      .filter((field) => field.required)
      .every((field) => {
        const draft = drafts()[field.key] ?? "";
        const isSet = valueOf(props.connection.values, field.key)?.isSet === true;
        return draft !== "" || isSet;
      });
  };

  const save = async (): Promise<boolean> => {
    if (!dirty()) return true;
    const result = await store.configureConnection(
      props.connection.id,
      dirtyValues(),
      mode() === props.connection.mode ? undefined : mode(),
    );
    return result !== undefined;
  };

  const connect = async (): Promise<void> => {
    if (!requiredSatisfied()) {
      setFormError("Fill the required fields first.");
      return;
    }
    setFormError(undefined);
    const saved = await save();
    if (!saved) return;
    await store.connectConnection(props.connection.id);
  };

  const disconnect = async (): Promise<void> => {
    await store.disconnectConnection(props.connection.id);
  };

  const startAuth = async (): Promise<void> => {
    const scopes =
      props.connection.scopes.missing.length > 0 ? props.connection.scopes.missing : undefined;
    const result = await store.startConnectionAuth(props.connection.id, mode(), scopes);
    if (result !== undefined) setAuth(result);
  };

  const isConnected = (): boolean => props.connection.status === "connected";
  const hasApproval = (): boolean => props.approval !== undefined;

  const runApproval = async (): Promise<void> => {
    const approval = props.approval;
    if (approval === undefined) return;
    if (approval.kind === "accessibility") {
      props.onRequestAccessibility();
      return;
    }
    await store.connectConnection(props.connection.id);
  };

  return (
    <Dialog
      title={`${integrationName(props.connection.integration)} · ${props.connection.slot}`}
      description={
        props.connection.label === props.connection.slot ? undefined : props.connection.label
      }
      onClose={props.onClose}
      footer={
        <>
          <Show when={isConnected()}>
            <Button
              size="normal"
              variant="ghost"
              loading={store.isPending(`connection:${props.connection.id}:disconnect`)}
              onClick={() => void disconnect()}
            >
              Disconnect
            </Button>
          </Show>
          <Show when={!hasApproval()}>
            <Show when={dirty() && !isConnected()}>
              <Button
                size="normal"
                variant="outline"
                loading={store.isPending(`connection:${props.connection.id}:configure`)}
                onClick={() => void save()}
              >
                Save
              </Button>
            </Show>
            <Show when={props.connection.integration === "twitch"}>
              <Button
                size="normal"
                variant={isConnected() ? "ghost" : "outline"}
                data-testid="connection-auth"
                loading={store.isPending(`connection:${props.connection.id}:auth`)}
                onClick={() => void startAuth()}
              >
                {props.connection.scopes.missing.length > 0 ? "Re-authorize" : "Sign in"}
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
                  loading={store.isPending(`connection:${props.connection.id}:connect`)}
                  onClick={() => void connect()}
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
          <Show when={hasApproval()}>
            <Button size="normal" variant="neutral" onClick={props.onClose}>
              Done
            </Button>
          </Show>
        </>
      }
    >
      <div class="space-y-3">
        <div class="flex items-center gap-2 text-[12px] text-muted">
          <Status tone={connectionStatusTone(props.connection.status)}>
            {connectionStatusLabel(props.connection.status)}
          </Status>
          <Show when={props.connection.requiresAuth}>
            <span class="text-warning">authorization required</span>
          </Show>
        </div>

        <Show when={props.connection.lastError && props.approval === undefined}>
          <p class="rounded bg-[var(--v2-state-bg-danger)] px-2 py-1.5 text-[11px] text-danger">
            {props.connection.lastError}
          </p>
        </Show>

        <Show when={props.approval}>
          {(approval) => (
            <div class="rounded-md border border-edge bg-layer-2 px-2.5 py-2">
              <p class="text-[12px] text-body">{approval().message}</p>
              <Show when={approval().kind === "accessibility"}>
                <p class="mt-0.5 text-[11px] text-muted">
                  Accessibility permission: {approval().status ?? "unknown"}
                </p>
              </Show>
              <Button
                size="small"
                variant="primary"
                class="mt-2"
                data-testid="connection-approval-action"
                loading={
                  props.requestingPermission ||
                  store.isPending(`connection:${props.connection.id}:connect`)
                }
                onClick={() => void runApproval()}
              >
                {approval().label}
              </Button>
            </div>
          )}
        </Show>

        <Show when={props.approval === undefined && props.keyboardPermission !== undefined}>
          <div class="rounded-md border border-edge bg-layer-2 px-2.5 py-2">
            <p class="text-[11px] text-muted">
              Accessibility permission: {props.keyboardPermission}
            </p>
            <Show when={props.keyboardPermission !== "granted"}>
              <Button
                size="small"
                variant="primary"
                class="mt-2"
                data-testid="connection-permission-action"
                loading={props.requestingPermission}
                onClick={props.onRequestAccessibility}
              >
                Open System Settings
              </Button>
            </Show>
          </div>
        </Show>

        <Show when={props.connection.integration === "twitch"}>
          <Field label="Mode">
            <SelectInput
              value={mode()}
              onChange={(event) => setMode(parseMode(event.currentTarget.value))}
            >
              <For each={modeOptions}>
                {(option) => (
                  <option value={option.value} selected={option.value === mode()}>
                    {option.label}
                  </option>
                )}
              </For>
            </SelectInput>
          </Field>
        </Show>

        <Show when={props.connection.integration !== "twitch" || mode() !== "cloud"}>
        <Show when={props.connection.fields.length > 0}>
          <div class="space-y-2.5">
            <For each={props.connection.fields}>
              {(field) => (
                <Field
                  label={field.required ? `${field.label} *` : field.label}
                  hint={
                    field.kind === "secret" &&
                    valueOf(props.connection.values, field.key)?.isSet === true
                      ? "stored · leave blank to keep"
                      : field.description
                  }
                >
                  <TextInput
                    data-testid={`connection-field-${field.key}`}
                    type={field.kind === "secret" ? "password" : "text"}
                    value={drafts()[field.key] ?? ""}
                    placeholder={
                      field.kind === "secret" &&
                      valueOf(props.connection.values, field.key)?.isSet === true
                        ? "••••••••"
                        : (field.placeholder ?? "")
                    }
                    autocomplete="off"
                    onInput={(event) => {
                      const value = event.currentTarget.value;
                      setDrafts((current) => ({ ...current, [field.key]: value }));
                    }}
                  />
                </Field>
              )}
            </For>
          </div>
        </Show>
        </Show>

        <Show when={props.connection.scopes.missing.length > 0}>
          <p class="text-[11px] text-warning">
            Missing {plural(props.connection.scopes.missing.length, "scope")}:{" "}
            <span class="font-mono">{props.connection.scopes.missing.join(", ")}</span>
          </p>
        </Show>

        <Show when={formError()}>
          <p class="text-[11px] text-danger">{formError()}</p>
        </Show>

        <Show when={auth()}>
          {(result) => (
            <div class="rounded-md border border-edge bg-canvas px-2.5 py-2 text-[12px]">
              <Show when={asBrowser(result())}>
                {(browser) => (
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
      </div>
    </Dialog>
  );
};
