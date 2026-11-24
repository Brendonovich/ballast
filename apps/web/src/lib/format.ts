import type {
  ArtifactStatus,
  ConnectionStatus,
  ConnectionSummary,
  ParamValue,
  ProjectRequirement,
  UnitKind,
  UnitStatus,
} from "@ballast/agent-protocol";

import type { Tone } from "../ui/primitives.tsx";

export const formatTime = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

export const formatRelative = (at: number, now: number = Date.now()): string => {
  const delta = at - now;
  const minutes = Math.round(delta / 60_000);
  if (Math.abs(minutes) < 1) return "just now";
  if (Math.abs(minutes) < 60) {
    const value = minutes;
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(value, "minute");
  }
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 36) {
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(hours, "hour");
  }
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    Math.round(hours / 24),
    "day",
  );
};

export const formatDateTime = (at: number): string =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

export const plural = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

export const integrationName = (integration: string): string => {
  switch (integration) {
    case "obs":
      return "OBS Studio";
    case "twitch":
      return "Twitch";
    case "fake":
      return "Fake";
    case "vts":
      return "VTube Studio";
    case "keyboard":
      return "Keyboard";
    case "midi":
      return "MIDI";
    case "websocket-client":
      return "WebSocket client";
    case "websocket-server":
      return "WebSocket server";
    case "http":
      return "HTTP webhooks";
    default:
      return integration;
  }
};

export const paramValueLabel = (value: ParamValue | undefined): string => {
  if (value === undefined) return "";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
};

/** Requirements that block Start: no explicit binding and no sole-instance proposal. */
export const blockingRequirements = (
  requirements: ReadonlyArray<ProjectRequirement>,
): ReadonlyArray<ProjectRequirement> =>
  requirements.filter(
    (requirement) =>
      requirement.boundInstanceId === undefined &&
      requirement.proposedInstanceId === undefined,
  );

const unitKindLabelValue: Record<UnitKind, string> = {
  topic: "Topic",
  timer: "Timer",
  workflow: "Workflow",
  param: "Param",
  run: "Run",
  database: "Database",
};

export const unitKindLabel = (kind: UnitKind): string => unitKindLabelValue[kind];

const unitKindPluralValue: Record<UnitKind, string> = {
  topic: "Topics",
  timer: "Timers",
  workflow: "Workflows",
  param: "Params",
  run: "Runs",
  database: "Databases",
};

export const unitKindPlural = (kind: UnitKind): string => unitKindPluralValue[kind];

export const unitStatusLabel = (status: UnitStatus): string => {
  switch (status) {
    case "active":
      return "Active";
    case "waiting":
      return "Waiting";
    case "failed":
      return "Failed";
  }
};

export const unitStatusTone = (status: UnitStatus): Tone => {
  switch (status) {
    case "active":
      return "success";
    case "waiting":
      return "neutral";
    case "failed":
      return "danger";
  }
};

export const artifactStatusLabel = (status: ArtifactStatus): string => {
  switch (status) {
    case "ready":
      return "Ready";
    case "building":
      return "Building";
    case "error":
      return "Error";
  }
};

export const artifactStatusTone = (status: ArtifactStatus): Tone => {
  switch (status) {
    case "ready":
      return "success";
    case "building":
      return "info";
    case "error":
      return "danger";
  }
};

export const artifactErrorSource = (
  error: string | undefined,
): { readonly file: string; readonly line: number } | undefined => {
  if (error === undefined) return undefined;
  const match = /^(.+?):(\d+):(\d+)/.exec(error);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  return { file: match[1], line: Number(match[2]) };
};

export const connectionStatusLabel = (status: ConnectionStatus): string => {
  switch (status) {
    case "reauth-required":
      return "Re-auth required";
    case "unconfigured":
      return "Unconfigured";
    case "disconnected":
      return "Disconnected";
    case "connecting":
      return "Connecting";
    case "connected":
      return "Connected";
    case "error":
      return "Error";
  }
};

export const connectionStatusTone = (status: ConnectionStatus): Tone => {
  switch (status) {
    case "connected":
      return "success";
    case "reauth-required":
      return "warning";
    case "error":
      return "danger";
    case "connecting":
      return "info";
    case "unconfigured":
    case "disconnected":
      return "neutral";
  }
};

export const connectionNeedsAttention = (connection: ConnectionSummary): boolean =>
  connection.status === "error" ||
  connection.status === "reauth-required" ||
  connection.scopes.missing.length > 0;
