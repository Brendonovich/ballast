import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

export const SnapshotSchema = Schema.Struct({
  count: Schema.Number,
  project: Schema.String,
  generation: Schema.Number,
});
export type Snapshot = Schema.Schema.Type<typeof SnapshotSchema>;

export const EventSchema = Schema.Struct({
  count: Schema.Number,
  at: Schema.Number,
});
export type Event = Schema.Schema.Type<typeof EventSchema>;

/**
 * The shared artifact API. A real project would keep this in src/api.ts and
 * import it from both ballast.ts and the artifact UI.
 */
export const ArtifactApi = RpcGroup.make(
  Rpc.make("Snapshot", { success: SnapshotSchema }),
  Rpc.make("Increment", {
    payload: { by: Schema.Number },
    success: Schema.Number,
  }),
  Rpc.make("Events", { stream: true, success: EventSchema }),
);
