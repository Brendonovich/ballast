import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const webRoot = fileURLToPath(new URL("..", import.meta.url));
export const realServiceInfoPath = join(webRoot, "test-results", "real-service.json");

export interface RealServiceInfo {
  readonly url: string;
  readonly token: string;
  readonly pid: number;
  readonly projectsDir: string;
  readonly tempRoot: string;
  readonly vtsPid: number;
  readonly approvals: {
    readonly vtuberStudio: boolean;
    readonly accessibility: boolean;
  };
  readonly connections: {
    readonly vts: string | undefined;
    readonly keyboard: string | undefined;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const readConnections = (
  value: unknown,
): { readonly vts: string | undefined; readonly keyboard: string | undefined } => {
  if (!isRecord(value)) return { vts: undefined, keyboard: undefined };
  return {
    vts: optionalString(value["vts"]),
    keyboard: optionalString(value["keyboard"]),
  };
};

export const readRealServiceInfo = (): RealServiceInfo | undefined => {
  try {
    const value: unknown = JSON.parse(readFileSync(realServiceInfoPath, "utf8"));
    if (!isRecord(value)) return undefined;
    if (
      typeof value["url"] !== "string" ||
      typeof value["token"] !== "string" ||
      typeof value["pid"] !== "number" ||
      typeof value["projectsDir"] !== "string" ||
      typeof value["tempRoot"] !== "string" ||
      typeof value["vtsPid"] !== "number"
    ) {
      return undefined;
    }
    const approvals = value["approvals"];
    if (
      typeof approvals !== "object" ||
      approvals === null ||
      !("vtuberStudio" in approvals) ||
      typeof approvals.vtuberStudio !== "boolean" ||
      !("accessibility" in approvals) ||
      typeof approvals.accessibility !== "boolean"
    ) {
      return undefined;
    }
    return {
      url: value["url"],
      token: value["token"],
      pid: value["pid"],
      projectsDir: value["projectsDir"],
      tempRoot: value["tempRoot"],
      vtsPid: value["vtsPid"],
      approvals: {
        vtuberStudio: approvals.vtuberStudio,
        accessibility: approvals.accessibility,
      },
      connections: readConnections(value["connections"]),
    };
  } catch {
    return undefined;
  }
};
