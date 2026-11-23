import {
  connectionKey,
  requestManifestKey,
  topicManifestKey,
  type ConnectionManifest,
  type Manifest,
  type ParamManifest,
  type RequestManifest,
  type TimerManifest,
  type TopicManifest,
  type WorkflowManifest,
} from "@ballast/core";

export interface DiffSet<A> {
  readonly added: ReadonlyArray<A>;
  readonly removed: ReadonlyArray<A>;
}

export interface ManifestDiff {
  /**
   * True when the next manifest needs a permission the previous one did not:
   * a new scope, or a new connection slot. Removals never need consent.
   */
  readonly requiresConsent: boolean;
  readonly params: DiffSet<ParamManifest>;
  readonly connections: DiffSet<ConnectionManifest>;
  readonly topics: DiffSet<TopicManifest>;
  readonly requests: DiffSet<RequestManifest>;
  readonly timers: DiffSet<TimerManifest>;
  readonly workflows: DiffSet<WorkflowManifest>;
  readonly scopes: DiffSet<string>;
}

const diffBy = <A>(
  previous: ReadonlyArray<A>,
  next: ReadonlyArray<A>,
  key: (value: A) => string,
): DiffSet<A> => {
  const previousKeys = new Set(previous.map(key));
  const nextKeys = new Set(next.map(key));
  return {
    added: next.filter((value) => !previousKeys.has(key(value))),
    removed: previous.filter((value) => !nextKeys.has(key(value))),
  };
};

const diffStrings = (
  previous: ReadonlyArray<string>,
  next: ReadonlyArray<string>,
): DiffSet<string> => {
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  return {
    added: next.filter((value) => !previousSet.has(value)),
    removed: previous.filter((value) => !nextSet.has(value)),
  };
};

const scopesOf = (manifest: Manifest): ReadonlyArray<string> => [
  ...new Set([
    ...manifest.topics.flatMap((topic) => topic.scopes),
    ...manifest.requests.flatMap((request) => request.scopes),
  ]),
];

/**
 * Compare two manifests. An entry that exists on both sides is not reported as
 * added/removed even if its scopes changed: the scope diff carries that.
 */
export const diff = (previous: Manifest, next: Manifest): ManifestDiff => {
  const scopes = diffStrings(scopesOf(previous), scopesOf(next));
  const connections = diffBy(previous.connections, next.connections, connectionKey);

  return {
    requiresConsent: scopes.added.length > 0 || connections.added.length > 0,
    params: diffBy(previous.params, next.params, (param) => param.key),
    connections,
    topics: diffBy(previous.topics, next.topics, topicManifestKey),
    requests: diffBy(previous.requests, next.requests, requestManifestKey),
    timers: diffBy(previous.timers ?? [], next.timers ?? [], (timer) => timer.name),
    workflows: diffBy(previous.workflows ?? [], next.workflows ?? [], (workflow) => workflow.name),
    scopes,
  };
};
