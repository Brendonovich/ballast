export const DEFAULT_OBS_URL = "ws://127.0.0.1:4455";

export interface ConnectionOptions {
  /** `--connection integration/slot=url` values. */
  readonly connections: ReadonlyMap<string, string>;
  /** `--connection-secret integration/slot=secret` values. */
  readonly secrets: ReadonlyMap<string, string>;
}

export interface ObsConnectionConfig {
  readonly slot: string;
  readonly url: string;
  readonly password?: string;
}

export interface Assignment {
  readonly key: string;
  readonly value: string;
}

/** Parse a `key=value` CLI argument, rejecting empty keys. */
export const parseAssignment = (assignment: string, option: string): Assignment => {
  const separator = assignment.indexOf("=");
  if (separator <= 0) {
    throw new Error(`Invalid ${option} "${assignment}"; expected key=value`);
  }
  return {
    key: assignment.slice(0, separator),
    value: assignment.slice(separator + 1),
  };
};

export const obsPasswordEnvKey = (slot: string): string =>
  `BALLAST_OBS_${slot.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_PASSWORD`;

const validateObsUrl = (slot: string, raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`OBS connection obs/${slot} has an invalid url "${raw}"`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`OBS connection obs/${slot} must use a ws:// or wss:// url, got "${raw}"`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`OBS connection obs/${slot} url must not contain credentials; use --connection-secret`);
  }
  return raw;
};

/**
 * Resolve the local OBS connection for a slot. Precedence: CLI url
 * (`--connection obs/main=...`) then the default, and CLI secret
 * (`--connection-secret obs/main=...`) then env
 * (`BALLAST_OBS_MAIN_PASSWORD`).
 */
export const resolveObsConnectionConfig = (
  slot: string,
  options: ConnectionOptions,
  env: Readonly<Record<string, string | undefined>>,
): ObsConnectionConfig => {
  const key = `obs/${slot}`;
  const url = validateObsUrl(slot, options.connections.get(key) ?? DEFAULT_OBS_URL);
  const password = options.secrets.get(key) ?? env[obsPasswordEnvKey(slot)];
  return {
    slot,
    url,
    ...(password === undefined || password === "" ? {} : { password }),
  };
};
