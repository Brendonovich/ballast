import { Schema } from "effect";

import { ScriptSummary } from "./scripts.ts";

/**
 * One folder the service watches. Projects are independent: each has its own
 * scripts, params, applied manifests and consent. Connections and cloud
 * pairing are service-wide (see decision 0003 §2), so two projects can share
 * `obs/main` or `twitch/broadcaster` without configuring them twice.
 */
export const ProjectSummary = Schema.Struct({
  id: Schema.String,
  /** A user-facing name, defaulting to the folder name when added. */
  name: Schema.String,
  /** Absolute path of the project folder on this machine. */
  root: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  scriptCount: Schema.Number,
});
export type ProjectSummary = typeof ProjectSummary.Type;

export const ProjectDetail = Schema.Struct({
  summary: ProjectSummary,
  scripts: Schema.Array(ScriptSummary),
});
export type ProjectDetail = typeof ProjectDetail.Type;

export const AddProjectRequest = Schema.Struct({
  /** Absolute path of an existing folder to watch. */
  path: Schema.String,
  /** Defaults to the folder's basename. */
  name: Schema.optionalKey(Schema.String),
});
export type AddProjectRequest = typeof AddProjectRequest.Type;

export const ProjectIdRequest = Schema.Struct({
  projectId: Schema.String,
});
export type ProjectIdRequest = typeof ProjectIdRequest.Type;

export const RemoveProjectRequest = Schema.Struct({
  projectId: Schema.String,
});
export type RemoveProjectRequest = typeof RemoveProjectRequest.Type;

export const ListProjectsResponse = Schema.Struct({
  projects: Schema.Array(ProjectSummary),
});
export type ListProjectsResponse = typeof ListProjectsResponse.Type;
