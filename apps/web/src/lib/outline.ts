import type {
  ProjectDetail,
  SourceLocation,
  UnitKind,
  UnitStatus,
  UnitSummary,
} from "@ballast/agent-protocol";

import { unitKindPlural } from "./format.ts";

/** One clickable declaration in the project outline. */
export interface OutlineItem {
  /** Stable across refreshes; used for selection. */
  readonly key: string;
  readonly label: string;
  readonly status: UnitStatus;
  readonly source?: SourceLocation;
  /** Set for units, whose logs can be filtered. Stores and API have no logs. */
  readonly unit?: UnitSummary;
  /** Why the unit is failed or waiting, for its tooltip. */
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

const unitItem = (
  unit: UnitSummary,
  detail: ProjectDetail,
  connectionName: ConnectionName,
): OutlineItem => {
  const note = unitNote(unit, detail, connectionName);
  return {
    key: unitKey(unit),
    label: unit.title ?? unit.name,
    status: unit.status,
    ...(unit.source === undefined ? {} : { source: unit.source }),
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
 * Everything a project declares except artifacts, which have their own list.
 * Units come from the detail's unit rows; the API and stores come from the
 * manifest because they are not units.
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
  groups.push({
    id: "api",
    title: "API",
    items: (api?.procedures ?? []).map((procedure) => ({
      key: `api:${procedure.name}`,
      label: procedure.name,
      status: "active",
      ...(api?.source === undefined ? {} : { source: api.source }),
    })),
  });
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

export interface OutlineLayout {
  readonly open: boolean;
  readonly height: number;
}

export const OUTLINE_MIN_HEIGHT = 120;
export const OUTLINE_MAX_HEIGHT = 900;
export const DEFAULT_OUTLINE: OutlineLayout = { open: false, height: 300 };

export const clampOutlineHeight = (height: number): number =>
  Math.round(Math.min(OUTLINE_MAX_HEIGHT, Math.max(OUTLINE_MIN_HEIGHT, height)));

/** Collapsed by default; a malformed value falls back to the default. */
export const parseOutlineLayout = (raw: string | null): OutlineLayout => {
  if (raw === null) return DEFAULT_OUTLINE;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_OUTLINE;
    const open: unknown = Reflect.get(value, "open");
    const height: unknown = Reflect.get(value, "height");
    return {
      open: open === true,
      height:
        typeof height === "number" && Number.isFinite(height)
          ? clampOutlineHeight(height)
          : DEFAULT_OUTLINE.height,
    };
  } catch {
    return DEFAULT_OUTLINE;
  }
};

/** Keyed by project: each window shows one project, so this is per window. */
export const outlineStorageKey = (projectId: string): string =>
  `ballast.projectOutline.${projectId}`;
