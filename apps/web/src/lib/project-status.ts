import type {
  ProjectConsentRequest,
  ProjectDetail,
  ProjectSummary,
} from "@ballast/agent-protocol";

import { blockingRequirements, projectStatusLabel, projectStatusTone } from "./format.ts";
import type { Tone } from "../ui/primitives.tsx";

export interface DisplayStatus {
  readonly label: string;
  readonly tone: Tone;
}

/**
 * What a project row or header shows: missing connections and pending
 * approval outrank the worker status, because they block starting it.
 */
export const projectDisplayStatus = (
  project: ProjectSummary,
  detail: ProjectDetail | undefined,
  consent: ProjectConsentRequest | undefined,
): DisplayStatus => {
  if (detail !== undefined && blockingRequirements(detail.requirements).length > 0) {
    return { label: "Needs connections", tone: "warning" };
  }
  if ((detail?.pendingConsent ?? consent) !== undefined) {
    return { label: "Needs consent", tone: "warning" };
  }
  return { label: projectStatusLabel(project), tone: projectStatusTone(project) };
};
