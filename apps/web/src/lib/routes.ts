/** Service-wide screens a project window can show without leaving its project. */
export type ProjectSection = "connections";

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const projectPath = (projectId: string): string =>
  "/projects/" + encodeURIComponent(projectId);

export const projectSectionPath = (projectId: string, section: ProjectSection): string =>
  projectPath(projectId) + "/" + section;

export const projectIdFromPath = (path: string): string | undefined => {
  const match = /^\/projects\/([^/?#]+)/.exec(path);
  return match?.[1] === undefined ? undefined : safeDecode(match[1]);
};

export const artifactFromPath = (path: string): string | undefined => {
  const match = /^\/projects\/[^/?#]+\/artifacts\/([^/?#]+)/.exec(path);
  return match?.[1] === undefined ? undefined : safeDecode(match[1]);
};

export const projectSectionFromPath = (path: string): ProjectSection | undefined => {
  const match = /^\/projects\/[^/?#]+\/(connections)\/?$/.exec(path);
  return match?.[1] === "connections" ? "connections" : undefined;
};
