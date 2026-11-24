import { describe, expect, it } from "vitest";
import type { ProjectIssue, ProjectStatus } from "@ballast/agent-protocol";

import {
  actionLabel,
  canRestart,
  issueMessage,
  issueTarget,
  projectAction,
  sortIssues,
  sourceMarkers,
  statusTone,
  statusWord,
} from "./project-health.ts";

const issue = (overrides: Partial<ProjectIssue> & Pick<ProjectIssue, "kind">): ProjectIssue => ({
  id: overrides.kind,
  severity: "error",
  title: "Something",
  at: 1_000,
  ...overrides,
});

const statuses: ReadonlyArray<ProjectStatus> = ["stopped", "starting", "running", "needs-user", "failed"];

describe("project status", () => {
  it("has one word per status and no 'previous version' wording", () => {
    expect(statuses.map(statusWord)).toEqual(["Stopped", "Starting", "Running", "Needs you", "Failed"]);
    for (const status of statuses) {
      expect(statusWord(status).toLowerCase()).not.toContain("previous");
    }
  });

  it("tints a live project with issues amber and a failed one red", () => {
    expect(statusTone({ status: "running", issues: [] })).toBe("success");
    expect(statusTone({ status: "running", issues: [issue({ kind: "connection-offline", severity: "warning" })] })).toBe("warning");
    expect(statusTone({ status: "running", issues: [issue({ kind: "change-not-applied" })] })).toBe("warning");
    expect(statusTone({ status: "starting", issues: [] })).toBe("info");
    expect(statusTone({ status: "failed", issues: [] })).toBe("danger");
    expect(statusTone({ status: "needs-user", issues: [] })).toBe("warning");
    expect(statusTone({ status: "stopped", issues: [] })).toBe("neutral");
  });

  it("drives the action from the real status", () => {
    expect(statuses.map(projectAction)).toEqual(["start", "stop", "stop", "set-up", "start"]);
    expect(statuses.map(canRestart)).toEqual([false, true, true, false, false]);
    expect(actionLabel("set-up")).toBe("Set up…");
    expect(actionLabel("stop")).toBe("Stop");
    expect(actionLabel("start")).toBe("Start");
  });
});

describe("issues", () => {
  const source = { file: "ballast.ts", line: 42, column: 3 };

  it("sorts errors first, newest first", () => {
    const sorted = sortIssues([
      issue({ kind: "connection-offline", id: "a", severity: "warning", at: 5 }),
      issue({ kind: "unit-failed", id: "b", at: 1 }),
      issue({ kind: "start-failed", id: "c", at: 3 }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["c", "b", "a"]);
  });

  it("maps each issue to where it should take you", () => {
    expect(issueTarget(issue({ kind: "needs-binding", integration: "obs", slot: "main" }))).toEqual({
      kind: "binding",
      integration: "obs",
      slot: "main",
    });
    expect(issueTarget(issue({ kind: "needs-consent" }))).toEqual({ kind: "consent" });
    expect(issueTarget(issue({ kind: "unit-failed", unit: "hype" }))).toEqual({ kind: "unit", unit: "hype" });
    expect(issueTarget(issue({ kind: "unit-failed", unit: "hype", source }))).toEqual({
      kind: "unit",
      unit: "hype",
      source,
    });
    expect(issueTarget(issue({ kind: "change-not-applied", source }))).toEqual({ kind: "source", source });
    expect(
      issueTarget(issue({ kind: "connection-offline", slot: "main", connectionId: "obs/main" })),
    ).toEqual({ kind: "connection", connectionId: "obs/main" });
    expect(issueTarget(issue({ kind: "worker-exited" }))).toEqual({ kind: "none" });
  });

  it("marks the line of a change that did not apply", () => {
    const failed = issue({
      kind: "change-not-applied",
      title: "Latest change not applied",
      detail: "ballast.ts:42:3 — Type 'string' is not assignable to type 'number'.",
      source,
    });
    expect(issueMessage(failed)).toBe("Type 'string' is not assignable to type 'number'.");
    expect(sourceMarkers([failed, issue({ kind: "unit-failed", source })])).toEqual([
      {
        file: "ballast.ts",
        line: 42,
        title: "Latest change not applied",
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ]);
  });
});
