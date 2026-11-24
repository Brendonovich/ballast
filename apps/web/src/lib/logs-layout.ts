import type { LogEntry } from "@ballast/agent-protocol";

/** The project view's logs pane: collapsed to its header, and the source/logs split. */
export interface LogsLayout {
  readonly collapsed: boolean;
  /** Source share of the split, 0.22–0.82. */
  readonly split: number;
}

export const SPLIT_MIN = 0.22;
export const SPLIT_MAX = 0.82;
export const DEFAULT_LOGS_LAYOUT: LogsLayout = { collapsed: false, split: 0.58 };

export const clampSplit = (value: number): number =>
  Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));

export const logsStorageKey = (projectId: string): string => `ballast.projectLogs.${projectId}`;

/** Expanded with the default split unless a valid layout was stored. */
export const parseLogsLayout = (raw: string | null): LogsLayout => {
  if (raw === null) return DEFAULT_LOGS_LAYOUT;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_LOGS_LAYOUT;
    const collapsed: unknown = Reflect.get(value, "collapsed");
    const split: unknown = Reflect.get(value, "split");
    return {
      collapsed: collapsed === true,
      split:
        typeof split === "number" && Number.isFinite(split)
          ? clampSplit(split)
          : DEFAULT_LOGS_LAYOUT.split,
    };
  } catch {
    return DEFAULT_LOGS_LAYOUT;
  }
};

export interface NewLines {
  readonly count: number;
  /** The most severe level among them, for tinting the indicator. */
  readonly level: "info" | "warn" | "error" | undefined;
}

/** Lines that arrived after `baseline` (a log seq), with their worst level. */
export const newLinesSince = (
  entries: ReadonlyArray<LogEntry>,
  baseline: number,
): NewLines => {
  let count = 0;
  let level: NewLines["level"];
  for (const entry of entries) {
    if (entry.seq <= baseline) continue;
    count += 1;
    if (entry.level === "error") level = "error";
    else if (entry.level === "warn" && level !== "error") level = "warn";
    else if (level === undefined) level = "info";
  }
  return { count, level };
};
