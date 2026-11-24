import type {
  ProjectDetail,
  SourceLocation,
  UnitKind,
  UnitStatus,
  UnitSummary,
} from "@ballast/agent-protocol";

import { unitKindPlural } from "./format.ts";

/**
 * What clicking an outline row opens. Rows without one are not clickable;
 * their declaration is still one hover away through the code icon.
 *  - topic: its events tab;
 *  - param: its field in the Project panel;
 *  - timer: its pending fires in the Project panel's timers list.
 */
export type OutlineOpen =
  | { readonly kind: "topic"; readonly name: string }
  | { readonly kind: "param"; readonly name: string }
  | { readonly kind: "timer"; readonly name: string };

/** One declaration in the project outline. */
export interface OutlineItem {
  /** Stable across refreshes; used to find and reveal the row. */
  readonly key: string;
  readonly label: string;
  /** Muted secondary text after the label. */
  readonly detail?: string;
  readonly status: UnitStatus;
  readonly source?: SourceLocation;
  readonly open?: OutlineOpen;
  /** Set for units, whose logs can be filtered. Stores and API have no logs. */
  readonly unit?: UnitSummary;
  /** Why the unit is failed or waiting, or what it lists, for its tooltip. */
  readonly note?: string;
}

export interface OutlineGroup {
  readonly id: string;
  readonly title: string;
  readonly items: ReadonlyArray<OutlineItem>;
}

const unitOrder: ReadonlyArray<UnitKind> = ["topic", "timer", "workflow", "run", "param"];

export const unitKey = (unit: Pick<UnitSummary, "kind" | "name">): string =>
  `unit:${unit.kind}:${unit.name}`;

/** How the outline names a connection; the service connection label when known. */
export type ConnectionName = (connectionId: string) => string | undefined;

/**
 * A failed unit says why; a topic waiting on an offline connection names it.
 * The connection is found through the topic's slot and the project's
 * `connection-offline` issues.
 */
const unitNote = (
  unit: UnitSummary,
  detail: ProjectDetail,
  connectionName: ConnectionName,
): string | undefined => {
  if (unit.status === "failed") {
    const issue = detail.issues.find(
      (entry) => entry.kind === "unit-failed" && entry.unit === unit.name,
    );
    const reason = unit.lastError ?? issue?.detail;
    return reason === undefined ? "Failed" : `Failed: ${reason}`;
  }
  if (unit.status !== "waiting" || unit.kind !== "topic") return undefined;
  const topic = detail.manifest.topics.find((entry) => entry.name === unit.name);
  if (topic === undefined) return undefined;
  const offline = detail.issues.find(
    (entry) => entry.kind === "connection-offline" && entry.slot === topic.slot,
  );
  if (offline === undefined) return undefined;
  const name =
    offline.connectionId === undefined ? undefined : connectionName(offline.connectionId);
  return name === undefined
    ? `Waiting: ${offline.title}`
    : `Waiting for ${name} (${topic.integration} · ${topic.slot}), which is offline`;
};

const openFor = (unit: UnitSummary): OutlineOpen | undefined => {
  switch (unit.kind) {
    case "topic":
    case "param":
    case "timer":
      return { kind: unit.kind, name: unit.name };
    default:
      return undefined;
  }
};

const unitItem = (
  unit: UnitSummary,
  detail: ProjectDetail,
  connectionName: ConnectionName,
): OutlineItem => {
  const note = unitNote(unit, detail, connectionName);
  const open = openFor(unit);
  return {
    key: unitKey(unit),
    label: unit.title ?? unit.name,
    status: unit.status,
    ...(unit.source === undefined ? {} : { source: unit.source }),
    ...(open === undefined ? {} : { open }),
    unit,
    ...(note === undefined ? {} : { note }),
  };
};

const unitGroup = (
  detail: ProjectDetail,
  kind: UnitKind,
  connectionName: ConnectionName,
): OutlineGroup => ({
  id: kind,
  title: unitKindPlural(kind),
  items: detail.units
    .filter((unit) => unit.kind === kind)
    .map((unit) => unitItem(unit, detail, connectionName)),
});

/**
 * Everything a project declares except artifacts, which the outline lists
 * from the artifact summaries. Units come from the detail's unit rows; the
 * API and stores come from the manifest because they are not units. The API
 * is one row: its procedures share one declaration.
 */
export const buildOutline = (
  detail: ProjectDetail | undefined,
  connectionName: ConnectionName = () => undefined,
): ReadonlyArray<OutlineGroup> => {
  if (detail === undefined) return [];
  const api = detail.manifest.api;
  const stores = detail.manifest.stores ?? [];
  const groups: Array<OutlineGroup> = unitOrder.map((kind) =>
    unitGroup(detail, kind, connectionName),
  );
  if (api !== undefined) {
    const names = api.procedures.map((procedure) => procedure.name);
    groups.push({
      id: "api",
      title: "API",
      items: [
        {
          key: "api",
          label: names.length === 1 ? "1 procedure" : `${names.length} procedures`,
          ...(names.length === 0 ? {} : { detail: names.join(", "), note: names.join("\n") }),
          status: "active",
          ...(api.source === undefined ? {} : { source: api.source }),
        },
      ],
    });
  }
  groups.push({
    id: "store",
    title: "Stores",
    items: stores.map((store) => ({
      key: `store:${store.name}`,
      label: store.name,
      status: "active",
      ...(store.source === undefined ? {} : { source: store.source }),
    })),
  });
  groups.push(unitGroup(detail, "database", connectionName));
  return groups.filter((group) => group.items.length > 0);
};
