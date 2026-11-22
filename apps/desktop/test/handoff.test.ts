import { describe, expect, it } from "vitest";
import {
  initialHandoffState,
  isTerminal,
  transition,
  type HandoffStep,
  type Transition,
} from "../src/main/service/handoff.ts";
import type { StageRef } from "../src/main/service/types.ts";

const older: StageRef = { version: "1.0.0", directory: "/stages/1.0.0" };
const newer: StageRef = { version: "1.1.0", directory: "/stages/1.1.0" };

function steps(result: Transition): HandoffStep[] {
  return result.commands.map((command) => command.step);
}

describe("service handoff state machine", () => {
  it("installs in stage -> login item -> start -> verify -> clean order", () => {
    let result = transition(initialHandoffState, { type: "install.requested", target: newer });
    const seen: HandoffStep[] = [...steps(result)];
    let state = result.state;
    while (!isTerminal(state)) {
      const step = result.commands[0]?.step;
      if (step === undefined) break;
      result = transition(state, { type: "step.succeeded", step });
      state = result.state;
      seen.push(...steps(result));
    }
    expect(seen).toEqual(["stage", "write-login-item", "start", "verify", "clean"]);
    expect(state).toMatchObject({
      kind: "done",
      operation: "install",
      active: newer,
      previous: null,
      rolledBack: false,
      failure: null,
    });
  });

  it("updates in stage -> stop -> login item -> start -> verify -> clean order", () => {
    let result = transition(initialHandoffState, {
      type: "update.requested",
      target: newer,
      previous: older,
    });
    const seen: HandoffStep[] = [...steps(result)];
    let state = result.state;
    while (!isTerminal(state)) {
      const step = result.commands[0]?.step;
      if (step === undefined) break;
      result = transition(state, { type: "step.succeeded", step });
      state = result.state;
      seen.push(...steps(result));
    }
    expect(seen).toEqual(["stage", "stop", "write-login-item", "start", "verify", "clean"]);
    expect(state).toMatchObject({ kind: "done", active: newer, previous: older, rolledBack: false });
  });

  it("rolls back to the previous stage when verification fails", () => {
    let result = transition(initialHandoffState, {
      type: "update.requested",
      target: newer,
      previous: older,
    });
    for (const step of ["stage", "stop", "write-login-item", "start"] as const) {
      result = transition(result.state, { type: "step.succeeded", step });
    }
    expect(result.state).toMatchObject({ kind: "working", step: "verify" });

    result = transition(result.state, { type: "step.failed", step: "verify", failure: "new version did not answer" });
    expect(result.state).toMatchObject({ kind: "rolling-back", target: newer, previous: older });
    expect(result.commands).toEqual([{ type: "write-login-item", step: "write-login-item", target: older }]);

    result = transition(result.state, { type: "step.succeeded", step: "write-login-item" });
    result = transition(result.state, { type: "step.succeeded", step: "start" });
    result = transition(result.state, { type: "step.succeeded", step: "verify" });
    expect(result.state).toMatchObject({
      kind: "done",
      active: older,
      previous: older,
      rolledBack: true,
      failure: "new version did not answer",
    });
    expect(result.commands).toEqual([{ type: "clean-stages", step: "clean", keep: ["1.0.0"] }]);
  });

  it("reports failure when the rollback itself fails", () => {
    let result = transition(initialHandoffState, {
      type: "update.requested",
      target: newer,
      previous: older,
    });
    for (const step of ["stage", "stop", "write-login-item", "start"] as const) {
      result = transition(result.state, { type: "step.succeeded", step });
    }
    result = transition(result.state, { type: "step.failed", step: "verify", failure: "new failed" });
    result = transition(result.state, { type: "step.failed", step: "write-login-item", failure: "old stage missing" });
    expect(result.state).toMatchObject({
      kind: "failed",
      operation: "update",
      target: newer,
      previous: older,
      failure: "old stage missing",
    });
  });

  it("cleans up a failed first install", () => {
    let result = transition(initialHandoffState, { type: "install.requested", target: newer });
    result = transition(result.state, { type: "step.succeeded", step: "stage" });
    result = transition(result.state, { type: "step.succeeded", step: "write-login-item" });
    result = transition(result.state, { type: "step.failed", step: "start", failure: "launchctl bootstrap failed" });
    expect(result.state).toMatchObject({ kind: "failed", operation: "install", step: "start" });
    expect(steps(result)).toEqual(["remove-login-item", "stop"]);
  });

  it("treats a cleanup failure after a successful update as done, not rollback", () => {
    let result = transition(initialHandoffState, {
      type: "update.requested",
      target: newer,
      previous: older,
    });
    for (const step of ["stage", "stop", "write-login-item", "start", "verify"] as const) {
      result = transition(result.state, { type: "step.succeeded", step });
    }
    result = transition(result.state, { type: "step.failed", step: "clean", failure: "old stage busy" });
    expect(result.state).toMatchObject({
      kind: "done",
      active: newer,
      previous: older,
      rolledBack: false,
      failure: "old stage busy",
    });
  });

  it("uninstalls by stopping and removing the login item", () => {
    let result = transition(initialHandoffState, { type: "uninstall.requested", previous: older });
    expect(steps(result)).toEqual(["stop"]);
    result = transition(result.state, { type: "step.succeeded", step: "stop" });
    expect(steps(result)).toEqual(["remove-login-item"]);
    result = transition(result.state, { type: "step.succeeded", step: "remove-login-item" });
    expect(result.state).toMatchObject({ kind: "done", operation: "uninstall", active: null });
  });

  it("ignores stale and terminal events", () => {
    const initial = transition(initialHandoffState, { type: "install.requested", target: newer });
    const stale = transition(initial.state, { type: "step.succeeded", step: "start" });
    expect(stale.state).toEqual(initial.state);
    const done = transition(
      { kind: "done", operation: "install", active: newer, previous: null, rolledBack: false, failure: null },
      { type: "step.failed", step: "clean", failure: "late" },
    );
    expect(done.commands).toEqual([]);
  });
});
