import { Rpc } from "effect/rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

export const DashboardSnapshot = Schema.Struct({
  sceneSwitches: Schema.Number,
  at: Schema.Number,
});
export type DashboardSnapshot = Schema.Schema.Type<typeof DashboardSnapshot>;

export const DashboardApi = RpcGroup.make(
  Rpc.make("Snapshot", { success: DashboardSnapshot }),
  Rpc.make("ResetCounters", { success: Schema.Number }),
  Rpc.make("Events", { stream: true, success: DashboardSnapshot }),
);
