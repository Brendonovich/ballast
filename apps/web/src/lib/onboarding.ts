import { CODING_AGENTS, type CodingAgent } from "@ballast/agent-protocol";

export const ONBOARDING_PATH = "/welcome";
const DISMISSED_KEY = "ballast.onboardingDismissed";

/** Whether the person has finished or skipped onboarding in this UI. */
export const onboardingDismissed = (): boolean => {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * `BALLAST_TEST_ONBOARDING=1` when the UI was built or served: start as a
 * first run. The desktop app and `ballast serve` also boot a temporary
 * service then, so the projects list is empty too.
 */
export const testOnboarding: boolean =
  typeof __BALLAST_TEST_ONBOARDING__ !== "undefined" && __BALLAST_TEST_ONBOARDING__ === true;

/** Forget a previous Skip, so a test run sees first-run onboarding again. */
export const resetOnboarding = (): void => {
  try {
    window.localStorage.removeItem(DISMISSED_KEY);
  } catch {
    // Nothing stored.
  }
};

export const dismissOnboarding = (): void => {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Without storage, onboarding shows again on the next empty start.
  }
};

/** First run: no projects yet and onboarding not finished or skipped. */
export const shouldAutoOpenOnboarding = (projectCount: number, dismissed: boolean): boolean =>
  projectCount === 0 && !dismissed;

export interface AgentInfo {
  readonly id: CodingAgent;
  readonly name: string;
  /** The CLI started in the project folder. */
  readonly command: string;
  /** What happens the first time the agent starts there. */
  readonly firstRun: string;
}

const AGENT_INFO_ENTRIES: Readonly<Record<CodingAgent, AgentInfo>> = {
  opencode: {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    firstRun: "OpenCode reads opencode.json in the folder and connects the ballast server on its own.",
  },
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    firstRun: "Claude Code asks once whether to use the project's MCP servers from .mcp.json. Approve ballast.",
  },
  codex: {
    id: "codex",
    name: "Codex",
    command: "codex",
    firstRun: "Codex only reads .codex/config.toml in trusted folders. Trust this folder when Codex asks.",
  },
};

export const agentInfo = (agent: CodingAgent): AgentInfo => AGENT_INFO_ENTRIES[agent];

export const AGENTS: ReadonlyArray<AgentInfo> = CODING_AGENTS.map(agentInfo);

/** A POSIX shell word for a path, quoted only when it needs to be. */
export const shellWord = (value: string): string =>
  /^[A-Za-z0-9_./~:@%+=-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";

export const startCommand = (root: string, agent: CodingAgent): string =>
  `cd ${shellWord(root)} && ${agentInfo(agent).command}`;

/** The first message to send the agent once it runs in the project. */
export const starterPrompt = (projectName: string): string =>
  [
    `This folder is the Ballast project "${projectName}".`,
    "Read the ballast_guide tool first, then ask me what the project should do.",
    "Check your work with ballast_check and ballast_status; I will start the project and approve permissions in Ballast.",
  ].join(" ");
