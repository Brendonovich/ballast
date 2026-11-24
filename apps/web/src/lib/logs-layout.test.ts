import { describe, expect, it } from "vitest";
import type { LogEntry } from "@ballast/agent-protocol";

import {
  DEFAULT_LOGS_LAYOUT,
  SPLIT_MAX,
  SPLIT_MIN,
  logsStorageKey,
  newLinesSince,
  parseLogsLayout,
} from "./logs-layout.ts";

const line = (seq: number, level: LogEntry["level"]): LogEntry => ({
  seq,
  at: seq,
  level,
  source: "worker",
  message: `line ${seq}`,
});

describe("logs layout", () => {
  it("is expanded by default and restores a stored layout per project", () => {
    expect(parseLogsLayout(null)).toEqual(DEFAULT_LOGS_LAYOUT);
    expect(DEFAULT_LOGS_LAYOUT.collapsed).toBe(false);
    expect(parseLogsLayout("{")).toEqual(DEFAULT_LOGS_LAYOUT);
    expect(parseLogsLayout(JSON.stringify({ collapsed: true, split: 0.7 }))).toEqual({
      collapsed: true,
      split: 0.7,
    });
    expect(parseLogsLayout(JSON.stringify({ collapsed: 1, split: 5 }))).toEqual({
      collapsed: false,
      split: SPLIT_MAX,
    });
    expect(parseLogsLayout(JSON.stringify({ split: -1 })).split).toBe(SPLIT_MIN);
    expect(logsStorageKey("a")).not.toBe(logsStorageKey("b"));
  });
});

describe("new lines since collapsing", () => {
  it("counts lines after the baseline and keeps the worst level", () => {
    const entries = [line(1, "error"), line(2, "info"), line(3, "info")];
    expect(newLinesSince(entries, 3)).toEqual({ count: 0, level: undefined });
    expect(newLinesSince(entries, 1)).toEqual({ count: 2, level: "info" });
    expect(newLinesSince([...entries, line(4, "warn"), line(5, "info")], 1)).toEqual({
      count: 4,
      level: "warn",
    });
    expect(newLinesSince([...entries, line(4, "error"), line(5, "warn")], 2)).toEqual({
      count: 3,
      level: "error",
    });
  });
});
