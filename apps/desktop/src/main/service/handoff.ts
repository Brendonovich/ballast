import type { StageRef } from "./types.ts";

/** Ordered side effects for each lifecycle operation. */
export type HandoffStep =
  | "stage"
  | "stop"
  | "write-login-item"
  | "start"
  | "verify"
  | "clean"
  | "remove-login-item";

export type HandoffOperation = "install" | "update" | "uninstall";

export type HandoffState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "working";
      readonly operation: HandoffOperation;
      readonly step: HandoffStep;
      readonly target: StageRef | null;
      readonly previous: StageRef | null;
    }
  | {
      readonly kind: "rolling-back";
      readonly target: StageRef;
      readonly previous: StageRef;
      readonly failure: string;
    }
  | {
      readonly kind: "done";
      readonly operation: HandoffOperation;
      readonly active: StageRef | null;
      readonly previous: StageRef | null;
      readonly rolledBack: boolean;
      readonly failure: string | null;
    }
  | {
      readonly kind: "failed";
      readonly operation: HandoffOperation;
      readonly target: StageRef | null;
      readonly previous: StageRef | null;
      readonly step: HandoffStep;
      readonly failure: string;
    };

export type HandoffEvent =
  | { readonly type: "install.requested"; readonly target: StageRef }
  | { readonly type: "update.requested"; readonly target: StageRef; readonly previous: StageRef }
  | { readonly type: "uninstall.requested"; readonly previous: StageRef | null }
  | { readonly type: "step.succeeded"; readonly step: HandoffStep }
  | { readonly type: "step.failed"; readonly step: HandoffStep; readonly failure: string };

export type HandoffCommand =
  | { readonly type: "stage"; readonly step: "stage"; readonly target: StageRef }
  | { readonly type: "stop"; readonly step: "stop" }
  | { readonly type: "write-login-item"; readonly step: "write-login-item"; readonly target: StageRef }
  | { readonly type: "start"; readonly step: "start"; readonly target: StageRef }
  | { readonly type: "verify"; readonly step: "verify"; readonly target: StageRef }
  | { readonly type: "clean-stages"; readonly step: "clean"; readonly keep: ReadonlyArray<string> }
  | { readonly type: "remove-login-item"; readonly step: "remove-login-item" };

export interface Transition {
  readonly state: HandoffState;
  readonly commands: ReadonlyArray<HandoffCommand>;
}

const sequences: Readonly<Record<HandoffOperation, ReadonlyArray<HandoffStep>>> = {
  install: ["stage", "write-login-item", "start", "verify", "clean"],
  update: ["stage", "stop", "write-login-item", "start", "verify", "clean"],
  uninstall: ["stop", "remove-login-item"],
};

const rollbackSequence: ReadonlyArray<HandoffStep> = ["write-login-item", "start", "verify"];

export const initialHandoffState: HandoffState = { kind: "idle" };

const unchanged = (state: HandoffState): Transition => ({ state, commands: [] });

function commandFor(
  step: HandoffStep,
  target: StageRef | null,
  keep: ReadonlyArray<string>,
): HandoffCommand {
  switch (step) {
    case "stop":
      return { type: "stop", step };
    case "clean":
      return { type: "clean-stages", step, keep };
    case "remove-login-item":
      return { type: "remove-login-item", step };
    case "stage":
    case "write-login-item":
    case "start":
    case "verify": {
      if (target === null) throw new Error("handoff step " + step + " requires a stage");
      if (step === "stage") return { type: "stage", step, target };
      if (step === "write-login-item") return { type: "write-login-item", step, target };
      if (step === "start") return { type: "start", step, target };
      return { type: "verify", step, target };
    }
  }
}

function nextIn(
  sequence: ReadonlyArray<HandoffStep>,
  step: HandoffStep,
): HandoffStep | undefined {
  const index = sequence.indexOf(step);
  if (index < 0) return undefined;
  return sequence[index + 1];
}

function startOperation(event: HandoffEvent): Transition | undefined {
  if (event.type === "install.requested") {
    const step = sequences.install[0];
    if (step === undefined) return undefined;
    return {
      state: {
        kind: "working",
        operation: "install",
        step,
        target: event.target,
        previous: null,
      },
      commands: [commandFor(step, event.target, [event.target.version])],
    };
  }
  if (event.type === "update.requested") {
    const step = sequences.update[0];
    if (step === undefined) return undefined;
    return {
      state: {
        kind: "working",
        operation: "update",
        step,
        target: event.target,
        previous: event.previous,
      },
      commands: [commandFor(step, event.target, [event.target.version])],
    };
  }
  if (event.type === "uninstall.requested") {
    const step = sequences.uninstall[0];
    if (step === undefined) return undefined;
    return {
      state: {
        kind: "working",
        operation: "uninstall",
        step,
        target: null,
        previous: event.previous,
      },
      commands: [commandFor(step, null, [])],
    };
  }
  return undefined;
}

function finish(
  operation: HandoffOperation,
  active: StageRef | null,
  previous: StageRef | null,
  failure: string | null,
): Transition {
  return {
    state: {
      kind: "done",
      operation,
      active,
      previous,
      rolledBack: false,
      failure,
    },
    commands: [],
  };
}

function succeedWorking(
  state: Extract<HandoffState, { kind: "working" }>,
  step: HandoffStep,
): Transition {
  if (state.step !== step) return unchanged(state);
  const sequence = sequences[state.operation];
  const next = nextIn(sequence, step);
  if (next === undefined) {
    return finish(state.operation, state.operation === "uninstall" ? null : state.target, state.previous, null);
  }
  return {
    state: { ...state, step: next },
    commands: [commandFor(next, state.target, state.target ? [state.target.version] : [])],
  };
}

function succeedRollback(state: Extract<HandoffState, { kind: "rolling-back" }>, step: HandoffStep): Transition {
  if (rollbackSequence.indexOf(step) < 0) return unchanged(state);
  const next = nextIn(rollbackSequence, step);
  if (next === undefined) {
    return {
      state: {
        kind: "done",
        operation: "update",
        active: state.previous,
        previous: state.previous,
        rolledBack: true,
        failure: state.failure,
      },
      commands: [commandFor("clean", state.previous, [state.previous.version])],
    };
  }
  return {
    state: { ...state },
    commands: [commandFor(next, state.previous, [state.previous.version])],
  };
}

function fail(state: HandoffState, step: HandoffStep, failure: string): Transition {
  if (state.kind === "rolling-back") {
    return {
      state: {
        kind: "failed",
        operation: "update",
        target: state.target,
        previous: state.previous,
        step,
        failure,
      },
      commands: [],
    };
  }
  if (state.kind !== "working" || state.step !== step) return unchanged(state);

  // Cleanup is best-effort: the service is already installed and answering.
  if (step === "clean") {
    return finish(state.operation, state.target, state.previous, failure);
  }

  if (state.operation === "update") {
    if (step === "stage" || state.previous === null || state.target === null) {
      return finish("update", state.previous, state.previous, failure);
    }
    const target = state.target;
    const previous = state.previous;
    return {
      state: {
        kind: "rolling-back",
        target,
        previous,
        failure,
      },
      commands: [commandFor("write-login-item", previous, [previous.version])],
    };
  }

  if (state.operation === "install") {
    return {
      state: {
        kind: "failed",
        operation: "install",
        target: state.target,
        previous: state.previous,
        step,
        failure,
      },
      commands:
        step === "stage"
          ? []
          : [commandFor("remove-login-item", null, []), commandFor("stop", null, [])],
    };
  }

  return {
    state: {
      kind: "failed",
      operation: "uninstall",
      target: null,
      previous: state.previous,
      step,
      failure,
    },
    commands: [],
  };
}

/** Pure reducer. The launcher runs commands in order and reports success/failure back. */
export function transition(state: HandoffState, event: HandoffEvent): Transition {
  if (state.kind === "idle") return startOperation(event) ?? unchanged(state);
  if (state.kind === "done" || state.kind === "failed") return unchanged(state);

  if (event.type === "step.succeeded") {
    if (state.kind === "working") return succeedWorking(state, event.step);
    return succeedRollback(state, event.step);
  }
  if (event.type === "step.failed") return fail(state, event.step, event.failure);

  return unchanged(state);
}

export function isTerminal(state: HandoffState): state is Extract<HandoffState, { kind: "done" | "failed" }> {
  return state.kind === "done" || state.kind === "failed";
}
