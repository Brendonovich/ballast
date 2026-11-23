import type { ConnectionStatus, ConnectionSummary, ParamValue, ScriptSummary } from "@ballast/agent-protocol";

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
    default:
      return integration;
  }
};

export const paramValueLabel = (value: ParamValue | undefined): string => {
  if (value === undefined) return "";
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
};

/**
 * The agent title-cases a filename including its extension. Keep the UI clean
 * without changing the record: "Tick Echo Ts" is shown as "Tick Echo".
 */
export const scriptDisplayName = (script: ScriptSummary): string =>
  script.name.replace(/\s+ts$/i, "").replace(/\.(?:[cm]?[jt]s)$/i, "").trim() || script.name;

export const scriptStatusLabel = (script: ScriptSummary): string => {
  if (script.status === "stopped" && script.generation === 0) return "Not started";
  switch (script.status) {
    case "needs-consent":
      return "Needs consent";
    case "running":
      return "Running";
    case "error":
      return "Error";
    case "stopped":
      return "Stopped";
    case "idle":
      return "Idle";
    case "planning":
      return "Planning";
    case "starting":
      return "Starting";
    case "stopping":
      return "Stopping";
  }
};

export const scriptStatusTone = (script: ScriptSummary): Tone => {
  if (script.status === "stopped" && script.generation === 0) return "warning";
  switch (script.status) {
    case "running":
      return "success";
    case "needs-consent":
      return "warning";
    case "error":
      return "danger";
    case "planning":
    case "starting":
    case "stopping":
      return "info";
    case "idle":
    case "stopped":
      return "neutral";
  }
};

export const isScriptBusy = (status: ScriptSummary["status"]): boolean =>
  status === "planning" || status === "starting" || status === "stopping";

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
