import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `BALLAST_TEST_ONBOARDING=1` boots Ballast as a fresh install in a
 * temporary directory, so first-run onboarding can be tried without touching
 * real projects, connections or the running service. The desktop app, the
 * CLI and `ballast serve` share one root through
 * `BALLAST_TEST_ONBOARDING_ROOT`: a process that finds it set (a service the
 * app or CLI spawned) reuses it instead of making another.
 */
export interface TestOnboarding {
  readonly root: string;
  /** This process made the root, so it removes it when it is done. */
  readonly created: boolean;
}

const enabled = (value: string | undefined): boolean => value === "1" || value === "true";

/** Point every Ballast directory at the test root; undefined when the flag is off. */
export const applyTestOnboarding = (
  env: Record<string, string | undefined> = process.env,
): TestOnboarding | undefined => {
  if (!enabled(env["BALLAST_TEST_ONBOARDING"])) return undefined;
  const existing = env["BALLAST_TEST_ONBOARDING_ROOT"];
  const created = existing === undefined || existing === "";
  const root = created ? mkdtempSync(path.join(tmpdir(), "ballast-onboarding-")) : existing;
  env["BALLAST_TEST_ONBOARDING_ROOT"] = root;
  env["BALLAST_STATE_DIR"] = path.join(root, "state");
  env["BALLAST_DATA_DIR"] = path.join(root, "data");
  env["BALLAST_PROJECTS_DIR"] = path.join(root, "projects");
  env["BALLAST_LOG_DIR"] = path.join(root, "logs");
  // A separate Electron profile: its own single-instance lock and an empty localStorage.
  env["BALLAST_USER_DATA_DIR"] = path.join(root, "app");
  // The real service keeps the fixed artifact port; take any free one.
  env["BALLAST_ARTIFACT_PORT"] = "0";
  return { root, created };
};
