import { Schema } from "effect";

/**
 * Project sharing (decision 0013). An author shares a project to the
 * cloud and deploys new versions; other machines subscribe with the share
 * code, are told when an update is available, and apply it on user action.
 * Named "share" because "artifact" means project UI pages (decision 0011).
 */

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
    shareId: Schema.String,
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
});
export type ShareProjectRequest = typeof ShareProjectRequest.Type;

export const DeployProjectResult = Schema.Struct({
  projectId: Schema.String,
  shareId: Schema.String,
  shareCode: Schema.String,
  sha: Schema.String,
  /** False when the files matched the last deploy and nothing was pushed. */
  deployed: Schema.Boolean,
  files: Schema.Number,
  bytes: Schema.Number,
  /** Subscribed machines notified of the new deploy. */
  notified: Schema.Number,
});
export type DeployProjectResult = typeof DeployProjectResult.Type;

export const SubscribeProjectRequest = Schema.Struct({
  shareCode: Schema.String,
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
