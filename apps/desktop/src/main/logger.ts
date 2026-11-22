import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface Logger {
  readonly file: string;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

const secretKey = /token|authorization|cookie|secret|password/i;

const redact = (fields: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = secretKey.test(key) ? "[redacted]" : value;
  }
  return result;
};

/** JSON-lines desktop log in <userData>/logs/desktop.log. Never logs service tokens. */
export function createLogger(logDir: string): Logger {
  const file = path.join(logDir, "desktop.log");
  const write = (level: string, message: string, fields?: Readonly<Record<string, unknown>>) => {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...(fields ? redact(fields) : {}),
    });
    if (level === "error") console.error(line);
    else console.log(line);
    void mkdir(logDir, { recursive: true, mode: 0o700 })
      .then(() => appendFile(file, line + "\n", { mode: 0o600 }))
      .catch(() => {});
  };
  return {
    file,
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
