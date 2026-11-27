import { Rpc } from "effect/rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

export const DashboardEvent = Schema.Struct({
  cursor: Schema.String,
  at: Schema.Number,
  kind: Schema.Literals(["message", "legacy"]),
  text: Schema.String,
});
export type DashboardEvent = Schema.Schema.Type<typeof DashboardEvent>;

export const DashboardSnapshot = Schema.Struct({
  sceneSwitches: Schema.Number,
  messages: Schema.Number,
  events: Schema.Array(DashboardEvent),
});
export type DashboardSnapshot = Schema.Schema.Type<typeof DashboardSnapshot>;

export const DashboardApi = RpcGroup.make(
  Rpc.make("Snapshot", { success: DashboardSnapshot }),
  Rpc.make("ResetCounters", { success: Schema.Number }),
  Rpc.make("Chat", { stream: true, success: DashboardEvent }),
);
