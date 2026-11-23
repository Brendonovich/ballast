import * as Ref from "effect/Ref";
import {
  topicManifestKey,
  type ConnectionManifest,
  type Manifest,
  type ParamManifest,
  type RequestManifest,
  type RunManifest,
  type TimerManifest,
  type TopicManifest,
  type UnresolvedManifest,
  type WorkflowManifest,
} from "@ballast/core";
import type { ManifestRecorderService } from "@ballast/core";

const upsert = <A>(
  items: ReadonlyArray<A>,
  item: A,
  key: (value: A) => string,
): ReadonlyArray<A> => {
  const index = items.findIndex((existing) => key(existing) === key(item));
  if (index === -1) return [...items, item];
  const copy = [...items];
  copy[index] = item;
  return copy;
};

const upsertTopic = (
  topics: ReadonlyArray<TopicManifest>,
  topic: TopicManifest,
): ReadonlyArray<TopicManifest> => {
  const key = topicManifestKey(topic);
  const existing = topics.find((candidate) => topicManifestKey(candidate) === key);
  if (existing === undefined) return [...topics, topic];

  return topics.map((candidate) =>
    topicManifestKey(candidate) === key
      ? {
          ...candidate,
          scopes: [...new Set([...candidate.scopes, ...topic.scopes])],
        }
      : candidate,
  );
};

const upsertRequest = (
  requests: ReadonlyArray<RequestManifest>,
  request: RequestManifest,
): ReadonlyArray<RequestManifest> => {
  const existing = requests.find(
    (candidate) =>
      candidate.integration === request.integration &&
      candidate.slot === request.slot &&
      candidate.request === request.request,
  );
  if (existing === undefined) return [...requests, request];

  return requests.map((candidate) =>
    candidate.integration === request.integration &&
    candidate.slot === request.slot &&
    candidate.request === request.request
      ? {
          ...candidate,
          scopes: [...new Set([...candidate.scopes, ...request.scopes])],
        }
      : candidate,
  );
};

/**
 * Build the recorder the plan worker provides to the script. Writes are
 * idempotent per key so declaring the same topic twice (or the same request
 * via two capabilities) yields one manifest entry with merged scopes.
 */
export const makeManifestRecorder = (ref: Ref.Ref<Manifest>): ManifestRecorderService => ({
  project: (project) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      project,
    })),
  param: (param: ParamManifest) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      params: [...manifest.params, param],
    })),
  connection: (connection: ConnectionManifest) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      connections: upsert(
        manifest.connections,
        connection,
        (value) => `${value.integration}/${value.slot}`,
      ),
    })),
  topic: (topic: TopicManifest) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      topics:
        topic.name === undefined
          ? upsertTopic(manifest.topics, topic)
          : [...manifest.topics, topic],
    })),
  request: (request: RequestManifest) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      requests: upsertRequest(manifest.requests, request),
    })),
  unresolved: (unresolved: UnresolvedManifest) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      unresolved: upsert(manifest.unresolved, unresolved, (value) => value.path),
    })),
  timer: (timer: TimerManifest) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      timers: [...manifest.timers, timer],
    })),
  workflow: (workflow: WorkflowManifest) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      workflows: [...manifest.workflows, workflow],
    })),
  run: (run: RunManifest) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      runs: [...manifest.runs, run],
    })),
});

const byStrings = (left: string, right: string): number => left.localeCompare(right);

/** Stable ordering keeps CLI output and diffs deterministic. */
export const normalizeManifest = (manifest: Manifest): Manifest => ({
  project: manifest.project,
  params: [...manifest.params].sort((left, right) => byStrings(left.key, right.key)),
  connections: [...manifest.connections].sort(
    (left, right) =>
      byStrings(left.integration, right.integration) || byStrings(left.slot, right.slot),
  ),
  topics: [...manifest.topics].sort(
    (left, right) =>
      byStrings(left.integration, right.integration) ||
      byStrings(left.slot, right.slot) ||
      byStrings(left.topic, right.topic),
  ),
  requests: [...manifest.requests].sort(
    (left, right) =>
      byStrings(left.integration, right.integration) ||
      byStrings(left.slot, right.slot) ||
      byStrings(left.request, right.request),
  ),
  unresolved: [...manifest.unresolved].sort((left, right) => byStrings(left.path, right.path)),
  timers: [...(manifest.timers ?? [])].sort((left, right) => byStrings(left.name, right.name)),
  workflows: [...(manifest.workflows ?? [])].sort((left, right) =>
    byStrings(left.name, right.name),
  ),
  runs: [...(manifest.runs ?? [])].sort((left, right) =>
    byStrings(left.name, right.name),
  ),
});

