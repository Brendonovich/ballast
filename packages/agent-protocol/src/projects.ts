import { Schema } from "effect";

import { ProjectDetail, ProjectSummary } from "./project.ts";

/**
 * One folder the service watches. A project is one bundle with one entry and
 * one worker; connections and cloud pairing remain service-wide.
 */
export { ProjectDetail, ProjectSummary };

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
