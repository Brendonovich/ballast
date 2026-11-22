import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (file: string, args: ReadonlyArray<string>) => Promise<CommandResult>;

const execFileAsync = promisify(execFile);

const isExecError = (value: unknown): value is Error & { code?: number | string; stdout?: string; stderr?: string } =>
  value instanceof Error;

/** Runs a command and resolves for non-zero exits instead of throwing. */
export const execRunner: CommandRunner = async (file, args) => {
  try {
    const result = await execFileAsync(file, [...args], { encoding: "utf8", timeout: 30_000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (cause) {
    if (!isExecError(cause)) throw cause;
    return {
      code: typeof cause.code === "number" ? cause.code : 1,
      stdout: typeof cause.stdout === "string" ? cause.stdout : "",
      stderr: typeof cause.stderr === "string" ? cause.stderr : cause.message,
    };
  }
};

export const commandOutput = (result: CommandResult): string =>
  (result.stderr.trim() || result.stdout.trim() || "exit " + result.code).slice(0, 2_000);
