import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import type { ConnectionSummary, PermissionStatus } from "@ballast/agent-protocol";

import { useAgent } from "../state/context.tsx";
import { useAccessibilityPermission } from "../permissions.ts";
import { clearConnectionFocus, flash, pendingConnectionFocus } from "../lib/project-intent.ts";
import { ConnectionDialog } from "./connections/ConnectionDialog.tsx";
import {
  connectionNeedsAttention,
  connectionStatusLabel,
  connectionStatusTone,
  integrationName,
} from "../lib/format.ts";
import { TrashIcon } from "../ui/icons.tsx";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  PageHeader,
  Status,
  StatusDot,
  cx,
} from "../ui/primitives.tsx";

interface ApprovalView {
  readonly kind: "vtuber-studio" | "accessibility";
  readonly message: string;
  readonly status?: PermissionStatus;
}

const approvalFor = (
  connection: ConnectionSummary,
  hasBridge: boolean,
  permission: PermissionStatus | undefined,
): ApprovalView | undefined => {
  const approval = connection.approval;
  if (approval === undefined) {
    if (
      connection.integration === "keyboard" &&
      hasBridge &&
      permission !== undefined &&
      permission !== "granted"
    ) {
      return {
        kind: "accessibility",
        message:
          "macOS requires Accessibility permission for the process running the Ballast service.",
        status: permission,
      };
    }
    return undefined;
  }
  if (approval.kind === "accessibility") {
    if (!hasBridge) return undefined;
    const status = permission ?? approval.status ?? "unknown";
    if (status === "granted") return undefined;
    return {
      kind: "accessibility",
      message:
        approval.message ??
        "macOS requires Accessibility permission for the process running the Ballast service.",
      status,
    };
  }
  return {
    kind: "vtuber-studio",
    message:
      approval.message ??
      'Allow "Ballast" in VTube Studio (the plugin request is waiting for you).',
  };
};

const accountLabel = (connection: ConnectionSummary): string | undefined =>
  connection.account === undefined ? undefined : `@${connection.account.login}`;

const detailOf = (connection: ConnectionSummary, approval: ApprovalView | undefined): string => {
  if (approval?.kind === "accessibility") return "Needs Accessibility permission";
  if (approval !== undefined) return approval.message;
  if (connection.integration === "keyboard") return connection.lastError ?? "";
  if (connection.lastError !== undefined) return connection.lastError;
  if (connection.detail !== undefined) return connection.detail;
  return "";
};

export const ConnectionsScreen = (): JSX.Element => {
  const store = useAgent();
  const permission = useAccessibilityPermission();
  const [adding, setAdding] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string>();
  const [deletingId, setDeletingId] = createSignal<string>();

  // An issue in the top bar asked to show this instance.
  createEffect(() => {
    const id = pendingConnectionFocus();
    if (id === undefined || store.connection(id) === undefined) return;
    clearConnectionFocus();
    requestAnimationFrame(() =>
      flash(document.querySelector(`[data-testid="connection-row"][data-connection-id="${CSS.escape(id)}"]`)),
    );
  });

  const editing = createMemo(() => {
    const id = editingId();
    return id === undefined ? undefined : store.connection(id);
  });
  const deleting = createMemo(() => {
    const id = deletingId();
    return id === undefined ? undefined : store.connection(id);
  });

  const groups = createMemo(() => {
    const map = new Map<string, ConnectionSummary[]>();
    for (const connection of store.connections()) {
      const list = map.get(connection.integration) ?? [];
      list.push(connection);
      map.set(connection.integration, list);
    }
    return [...map.entries()]
      .map(([integration, connections]) => ({
        integration,
        title: connections[0]?.title ?? integrationName(integration),
        connections: connections
          .slice()
          .sort((left, right) => left.label.localeCompare(right.label)),
      }))
      .sort((left, right) => left.title.localeCompare(right.title));
  });

  const usedBy = (connection: ConnectionSummary): string =>
    connection.boundBy
      .map((ref) => {
        const project = store.project(ref.projectId);
        return `${project?.name ?? ref.projectId} · ${ref.slot}`;
      })
      .join(", ");

  const blocked = (connection: ConnectionSummary): boolean => {
    const approval = approvalFor(connection, permission.hasBridge, permission.status());
    return approval?.kind === "accessibility" && approval.status !== "granted";
  };

  const remove = async (): Promise<void> => {
    const connection = deleting();
    if (connection === undefined) return;
    const deleted = await store.deleteConnection(connection.id);
    if (deleted) setDeletingId(undefined);
  };

  return (
    <div>
      <PageHeader
        title="Connections"
        description="Service-level instances. Projects bind their requirement slots to them."
        actions={
          <Button
            variant="primary"
            data-testid="add-connection"
            onClick={() => setAdding(true)}
          >
            Add connection
          </Button>
        }
      />

      <Show
        when={groups().length > 0}
        fallback={
          <EmptyState
            title="No connections yet"
            description="Add an integration instance, then bind it to a project slot."
            action={
              <Button variant="neutral" onClick={() => setAdding(true)}>
                Add connection
              </Button>
            }
          />
        }
      >
        <div class="mt-6 space-y-5">
          <For each={groups()}>
            {(group) => (
              <section data-testid="connection-group" data-integration={group.integration}>
                <div class="flex items-baseline justify-between border-b border-edge pb-1">
                  <h2 class="text-[12px] font-medium text-body">{group.title}</h2>
                  <span class="text-[10px] text-faint">
                    {group.connections.length === 1
                      ? "1 instance"
                      : `${group.connections.length} instances`}
                  </span>
                </div>
                <For each={group.connections}>
                  {(connection) => {
                    const approval = (): ApprovalView | undefined =>
                      approvalFor(connection, permission.hasBridge, permission.status());
                    const statusLabel = (): string => {
                      if (blocked(connection)) return "Needs permission";
                      if (approval()?.kind === "vtuber-studio") return "Waiting for approval";
                      return connectionStatusLabel(connection.status);
                    };
                    const statusTone = (): ReturnType<typeof connectionStatusTone> => {
                      if (blocked(connection)) return "warning";
                      if (approval()?.kind === "vtuber-studio") return "warning";
                      return connectionStatusTone(connection.status);
                    };
                    const bound = (): boolean => connection.boundBy.length > 0;
                    return (
                      <div
                        data-testid="connection-row"
                        data-connection-id={connection.id}
                        data-approval={approval()?.kind}
                        class="flex min-h-14 items-center gap-3 border-b border-edge py-2"
                      >
                        <StatusDot
                          tone={statusTone()}
                          pulse={connection.status === "connecting"}
                          class="ml-1"
                        />
                        <div class="min-w-0 flex-1">
                          <p class="flex items-baseline gap-2 text-[13px] font-medium text-strong">
                            <span class="truncate">{connection.label}</span>
                            <Show when={accountLabel(connection)}>
                              {(account) => (
                                <span class="inline-flex min-w-0 items-center gap-1 text-[11px] font-normal text-faint">
                                  <Show when={connection.account?.avatarUrl}>
                                    {(url) => (
                                      <img
                                        src={url()}
                                        alt=""
                                        class="size-3.5 rounded-full object-cover"
                                      />
                                    )}
                                  </Show>
                                  <span class="truncate">{account()}</span>
                                </span>
                              )}
                            </Show>
                          </p>
                          <p
                            class={cx(
                              "truncate text-[11px]",
                              connection.lastError !== undefined && approval() === undefined
                                ? "text-danger"
                                : "text-muted",
                            )}
                          >
                            {detailOf(connection, approval())}
                          </p>
                          <Show when={connection.boundBy.length > 0}>
                            <p class="truncate text-[10px] text-faint">
                              Bound to {usedBy(connection)}; unbind before deleting.
                            </p>
                          </Show>
                        </div>
                        <Status tone={statusTone()}>{statusLabel()}</Status>
                        <IconButton
                          label={
                            bound()
                              ? "Unbind this connection from its projects before deleting"
                              : `Delete ${connection.label}`
                          }
                          disabled={bound()}
                          onClick={() => setDeletingId(connection.id)}
                        >
                          <TrashIcon size={13} />
                        </IconButton>
                        <Button
                          size="small"
                          variant={
                            connectionNeedsAttention(connection) ||
                            approval() !== undefined ||
                            blocked(connection)
                              ? "neutral"
                              : "outline"
                          }
                          onClick={() => setEditingId(connection.id)}
                        >
                          {approval() === undefined ? "Manage" : "Review"}
                        </Button>
                      </div>
                    );
                  }}
                </For>
              </section>
            )}
          </For>
        </div>
      </Show>

      <Show when={adding()}>
        <ConnectionDialog
          connection={undefined}
          permission={permission.status()}
          requestingPermission={permission.requesting()}
          hasBridge={permission.hasBridge}
          onRequestAccessibility={() => void permission.request()}
          onClose={() => setAdding(false)}
        />
      </Show>

      <Show when={editing()}>
        {(connection) => (
          <ConnectionDialog
            connection={connection()}
            permission={permission.status()}
            requestingPermission={permission.requesting()}
            hasBridge={permission.hasBridge}
            onRequestAccessibility={() => void permission.request()}
            onClose={() => setEditingId(undefined)}
          />
        )}
      </Show>

      <Show when={deleting()}>
        {(connection) => (
          <ConfirmDialog
            title={`Delete ${connection().label}?`}
            description="The instance and its stored settings are removed. This does not touch any project files."
            confirmLabel="Delete"
            pending={store.isPending(`connection:${connection().id}:delete`)}
            onCancel={() => setDeletingId(undefined)}
            onConfirm={() => void remove()}
          />
        )}
      </Show>
    </div>
  );
};
