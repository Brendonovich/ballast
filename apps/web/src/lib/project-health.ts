import type {
  ProjectIssue,
  ProjectStatus,
  ProjectSummary,
  SourceLocation,
} from "@ballast/agent-protocol";

import type { Tone } from "../ui/primitives.tsx";

const words: Record<ProjectStatus, string> = {
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  "needs-user": "Needs you",
  failed: "Failed",
};

/** One word per status, the same everywhere a project's status is shown. */
export const statusWord = (status: ProjectStatus): string => words[status];

/**
 * The dot next to a project. Failed is red, and a live project with any
 * problem is amber instead of green: the issues list says what is wrong.
 */
export const statusTone = (project: Pick<ProjectSummary, "status" | "issues">): Tone => {
  const status = project.status;
  switch (status) {
    case "failed":
      return "danger";
    case "needs-user":
      return "warning";
    case "running":
    case "starting":
      if (project.issues.length > 0) return "warning";
      return status === "running" ? "success" : "info";
    case "stopped":
      return "neutral";
  }
};

export type ProjectAction = "stop" | "start" | "set-up";

/** The primary action for a status; Restart sits next to Stop. */
export const projectAction = (status: ProjectStatus): ProjectAction => {
  switch (status) {
    case "running":
    case "starting":
      return "stop";
    case "stopped":
    case "failed":
      return "start";
    case "needs-user":
      return "set-up";
  }
};

export const canRestart = (status: ProjectStatus): boolean =>
  status === "running" || status === "starting";

export const actionLabel = (action: ProjectAction): string =>
  action === "stop" ? "Stop" : action === "start" ? "Start" : "Set up…";

/** Errors first, then the newest. */
export const sortIssues = (issues: ReadonlyArray<ProjectIssue>): ReadonlyArray<ProjectIssue> =>
  [...issues].sort((left, right) =>
    left.severity === right.severity
      ? right.at - left.at
      : left.severity === "error"
        ? -1
        : 1,
  );

export const issueSummary = (issues: ReadonlyArray<ProjectIssue>): string => {
  if (issues.length === 0) return "No issues";
  return issues.length === 1 ? "1 issue" : `${issues.length} issues`;
};

/** Where an issue takes you. */
export type IssueTarget =
  | {
      readonly kind: "binding";
      readonly integration: string | undefined;
      readonly slot: string | undefined;
    }
  | { readonly kind: "consent" }
  | { readonly kind: "unit"; readonly unit: string; readonly source?: SourceLocation }
  | { readonly kind: "source"; readonly source: SourceLocation }
  | { readonly kind: "connection"; readonly connectionId: string }
  | { readonly kind: "none" };

export const issueTarget = (issue: ProjectIssue): IssueTarget => {
  if (issue.kind === "needs-binding") {
    return { kind: "binding", integration: issue.integration, slot: issue.slot };
  }
  if (issue.kind === "needs-consent") return { kind: "consent" };
  if (issue.unit !== undefined) {
    return {
      kind: "unit",
      unit: issue.unit,
      ...(issue.source === undefined ? {} : { source: issue.source }),
    };
  }
  if (issue.source !== undefined) return { kind: "source", source: issue.source };
  if (issue.connectionId !== undefined) {
    return { kind: "connection", connectionId: issue.connectionId };
  }
  return { kind: "none" };
};

/** A diagnostic without its leading `file:line:col —`, which the marker already shows. */
export const issueMessage = (issue: ProjectIssue): string => {
  const text = issue.detail ?? issue.title;
  const source = issue.source;
  if (source === undefined) return text;
  const prefix = `${source.file}:${source.line}:${source.column}`;
  return text.startsWith(prefix) ? text.slice(prefix.length).replace(/^\s*[—-]\s*/, "") : text;
};

export interface SourceMarker {
  readonly file: string;
  readonly line: number;
  readonly title: string;
  readonly message: string;
}

/** Gutter markers: the latest change that did not apply, on its line. */
export const sourceMarkers = (issues: ReadonlyArray<ProjectIssue>): ReadonlyArray<SourceMarker> =>
  issues.flatMap((issue) =>
    issue.kind === "change-not-applied" && issue.source !== undefined
      ? [
          {
            file: issue.source.file,
            line: issue.source.line,
            title: issue.title,
            message: issueMessage(issue),
          },
        ]
      : [],
  );
