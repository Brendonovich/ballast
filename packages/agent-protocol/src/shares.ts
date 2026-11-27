import { Schema } from "effect";

/**
 * Project sharing (decisions 0013, 0014). An author shares a project to a
 * share server and deploys new versions; other people subscribe with the
 * share code, are told when an update is available, and apply it on user
 * action. Named "share" because "artifact" means project UI pages (0011).
 *
 * A share server is any URL that speaks the share protocol: the hosted
 * Ballast cloud by default, or a custom one. People sign in to each server
 * ("Sign in with Anomaly" on the hosted one); every shared or subscribed
 * project remembers its server.
 */

/** The person signed in to a share server. */
export const ShareServerUser = Schema.Struct({
  id: Schema.String,
  issuer: Schema.String,
  name: Schema.NullOr(Schema.String),
  username: Schema.NullOr(Schema.String),
});
export type ShareServerUser = typeof ShareServerUser.Type;

export const ShareServerSummary = Schema.Struct({
  /** Base URL, normalized without a trailing slash. */
  url: Schema.String,
  /** Absent when signed out. */
  user: Schema.optionalKey(ShareServerUser),
  signedInAt: Schema.optionalKey(Schema.Number),
  /** True for the server new shares and subscriptions use. */
  default: Schema.Boolean,
  /** Projects that share to or subscribe from this server. */
  projects: Schema.Number,
});
export type ShareServerSummary = typeof ShareServerSummary.Type;

export const ShareServersStatus = Schema.Struct({
  /** Undefined when no server is configured (set one, or BALLAST_SHARE_SERVER / a cloud URL). */
  defaultServer: Schema.optionalKey(Schema.String),
  servers: Schema.Array(ShareServerSummary),
});
export type ShareServersStatus = typeof ShareServersStatus.Type;

export const ShareServerRequest = Schema.Struct({
  /** Defaults to the default share server. */
  server: Schema.optionalKey(Schema.String),
});
export type ShareServerRequest = typeof ShareServerRequest.Type;

/** A browser sign-in in progress; open `url`, then wait for `share-servers-changed`. */
export const ShareSignIn = Schema.Struct({
  server: Schema.String,
  url: Schema.String,
  expiresAt: Schema.Number,
});
export type ShareSignIn = typeof ShareSignIn.Type;

/** The deploy a subscribed project can update to. */
export const ProjectUpdateAvailable = Schema.Struct({
  sha: Schema.String,
  message: Schema.NullOr(Schema.String),
  deployedAt: Schema.Number,
});
export type ProjectUpdateAvailable = typeof ProjectUpdateAvailable.Type;

export const ProjectShare = Schema.Union([
  /** This machine shares the project. */
  Schema.TaggedStruct("shared", {
    /** The share server's base URL. */
    server: Schema.String,
    shareId: Schema.String,
    shareCode: Schema.String,
    /** The last deployed commit, once deployed. */
    sha: Schema.optionalKey(Schema.String),
    deployedAt: Schema.optionalKey(Schema.Number),
  }),
  /**
   * The project is a read-only copy of someone's share. Applying an
   * update overwrites local edits.
   */
  Schema.TaggedStruct("subscribed", {
    server: Schema.String,
    shareId: Schema.String,
    /** The read capability; subscribers do not sign in (decision 0014). */
    shareCode: Schema.String,
    installedSha: Schema.String,
    installedAt: Schema.Number,
    available: Schema.optionalKey(ProjectUpdateAvailable),
  }),
]);
export type ProjectShare = typeof ProjectShare.Type;

export const ShareProjectRequest = Schema.Struct({
  projectId: Schema.String,
  /** Shown to subscribers with the update. */
  message: Schema.optionalKey(Schema.String),
  /** Where to create the share on first use; defaults to the default share server. Ignored once shared. */
  server: Schema.optionalKey(Schema.String),
});
export type ShareProjectRequest = typeof ShareProjectRequest.Type;

export const DeployProjectResult = Schema.Struct({
  projectId: Schema.String,
  shareId: Schema.String,
  shareCode: Schema.String,
  sha: Schema.String,
  /** False when the files matched the last deploy and nothing was pushed. */
  deployed: Schema.Boolean,
  server: Schema.String,
  files: Schema.Number,
  bytes: Schema.Number,
});
export type DeployProjectResult = typeof DeployProjectResult.Type;

export const SubscribeProjectRequest = Schema.Struct({
  shareCode: Schema.String,
  /** The share server the code is from; defaults to the default share server. */
  server: Schema.optionalKey(Schema.String),
  /** Folder for the copy; defaults to <projects dir>/<share name>. Must be empty or missing. */
  directory: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});
export type SubscribeProjectRequest = typeof SubscribeProjectRequest.Type;

export const ApplyProjectUpdateResult = Schema.Struct({
  projectId: Schema.String,
  fromSha: Schema.String,
  toSha: Schema.String,
  /** Files written (added or modified). */
  changed: Schema.Array(Schema.String),
  deleted: Schema.Array(Schema.String),
  /** Bytes downloaded for the changed files. */
  bytes: Schema.Number,
  /** Local files that differed from the installed version and were overwritten. */
  overwritten: Schema.Array(Schema.String),
  /** True when the running project was restarted once onto the new files. */
  restarted: Schema.Boolean,
});
export type ApplyProjectUpdateResult = typeof ApplyProjectUpdateResult.Type;

/** Path prefix of a share link on a share server: `{server}/s/{code}`. */
export const SHARE_LINK_PREFIX = "/s/";

/** The link an author sends: `https://share.example/s/ABCD-EFGH-JKLM`. */
export const shareLink = (server: string, shareCode: string): string =>
  server.replace(/\/+$/, "") + SHARE_LINK_PREFIX + encodeURIComponent(shareCode);

export interface ParsedShareInput {
  readonly shareCode: string;
  /** The share server's base URL, when the input was a link. */
  readonly server?: string;
}

/**
 * The share code (and, for a link, its share server) in a share link or a
 * bare code; undefined when the input is neither. A link's server is
 * everything before its `/s/{code}` path.
 */
export const parseShareInput = (input: string): ParsedShareInput | undefined => {
  const value = input.trim();
  if (value === "") return undefined;
  const isCode = (code: string): boolean => /^[A-Za-z0-9]+(?:[\s-]+[A-Za-z0-9]+)*$/.test(code);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return isCode(value) ? { shareCode: value } : undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const match = /^(.*)\/s\/([^/]+)\/?$/.exec(url.pathname);
  if (match?.[2] === undefined) return undefined;
  let shareCode: string;
  try {
    shareCode = decodeURIComponent(match[2]);
  } catch {
    return undefined;
  }
  if (!isCode(shareCode)) return undefined;
  return { shareCode, server: url.origin + (match[1] ?? "") };
};
