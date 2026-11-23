import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const webRoot = fileURLToPath(new URL("..", import.meta.url));
export const realServiceInfoPath = join(webRoot, "test-results", "real-service.json");

export interface RealServiceInfo {
  readonly url: string;
  readonly token: string;
  readonly pid: number;
  readonly projectId: string;
  readonly projectPath: string;
  readonly tempRoot: string;
  readonly vtsPid: number;
  readonly approvals: {
    readonly vtuberStudio: boolean;
    readonly accessibility: boolean;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const readRealServiceInfo = (): RealServiceInfo | undefined => {
  try {
    const value: unknown = JSON.parse(readFileSync(realServiceInfoPath, "utf8"));
    if (!isRecord(value)) return undefined;
    if (
      typeof value["url"] !== "string" ||
      typeof value["token"] !== "string" ||
      typeof value["pid"] !== "number" ||
      typeof value["projectId"] !== "string" ||
      typeof value["projectPath"] !== "string" ||
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
      projectId: value["projectId"],
      projectPath: value["projectPath"],
      tempRoot: value["tempRoot"],
      vtsPid: value["vtsPid"],
      approvals: {
        vtuberStudio: approvals.vtuberStudio,
        accessibility: approvals.accessibility,
      },
    };
  } catch {
    return undefined;
  }
};
