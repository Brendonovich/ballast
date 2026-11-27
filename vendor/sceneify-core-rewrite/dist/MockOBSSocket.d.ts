import { Layer } from "effect";
import type OBSWebSocket from "obs-websocket-js";
import { OBSSocket, type BatchOptions, type OBSCallRequest, type SceneifySceneItemPrivateSettings, type SceneifySourcePrivateSettings } from "./OBSSocket.ts";
export type Settings = Readonly<Record<string, any>>;
export interface RecordedCall {
    readonly requestType: string;
    readonly requestData?: Readonly<Record<string, unknown>>;
    /**
     * Index into `batches` when the request was sent as part of a batch.
     */
    readonly batch?: number;
}
export interface RecordedBatch {
    readonly requests: ReadonlyArray<OBSCallRequest>;
    readonly options: BatchOptions;
}
export interface FilterSeed {
    readonly name: string;
    readonly kind: string;
    readonly settings?: Settings;
    readonly enabled?: boolean;
}
export interface InputSeed {
    readonly name: string;
    readonly kind: string;
    readonly settings?: Settings;
    readonly privateSettings?: SceneifySourcePrivateSettings;
    readonly filters?: ReadonlyArray<FilterSeed>;
    readonly muted?: boolean;
    readonly volumeMul?: number;
    readonly audioBalance?: number;
    readonly audioSyncOffset?: number;
    readonly audioMonitorType?: string;
    readonly audioTracks?: Readonly<Record<string, boolean>>;
    readonly propertyLists?: Readonly<Record<string, ReadonlyArray<{
        readonly name: string;
        readonly enabled?: boolean;
        readonly value?: string | number;
    }>>>;
}
export interface SceneItemSeed {
    readonly sourceName: string;
    readonly id?: number;
    readonly enabled?: boolean;
    readonly locked?: boolean;
    readonly transform?: Settings;
    readonly blendMode?: string;
    readonly privateSettings?: SceneifySceneItemPrivateSettings;
}
export interface SceneSeed {
    readonly name: string;
    readonly privateSettings?: SceneifySourcePrivateSettings;
    readonly filters?: ReadonlyArray<FilterSeed>;
    readonly items?: ReadonlyArray<SceneItemSeed>;
    readonly transitionName?: string | null;
    readonly transitionDuration?: number | null;
}
export interface Options {
    readonly scenes?: ReadonlyArray<SceneSeed>;
    readonly inputs?: ReadonlyArray<InputSeed>;
    readonly currentProgramSceneName?: string;
    readonly currentPreviewSceneName?: string | null;
    readonly failures?: ReadonlyArray<FailureSeed>;
    readonly requestDelayMs?: number;
}
export interface FailureSeed {
    readonly requestType: string;
    readonly occurrence?: number;
    readonly phase?: "before" | "after";
    readonly code?: number;
    readonly message: string;
}
export interface FilterSnapshot {
    readonly name: string;
    readonly kind: string;
    readonly settings: Settings;
    readonly enabled: boolean;
    readonly index: number;
}
export interface InputSnapshot {
    readonly name: string;
    readonly uuid: string;
    readonly kind: string;
    readonly settings: Settings;
    readonly privateSettings: SceneifySourcePrivateSettings;
    readonly filters: ReadonlyArray<FilterSnapshot>;
    readonly muted: boolean;
    readonly volumeMul: number;
    readonly audioBalance: number;
    readonly audioSyncOffset: number;
    readonly audioMonitorType: string;
    readonly audioTracks: Readonly<Record<string, boolean>>;
    readonly propertyLists: NonNullable<InputSeed["propertyLists"]>;
}
export interface SceneItemSnapshot {
    readonly sourceName: string;
    readonly id: number;
    readonly enabled: boolean;
    readonly locked: boolean;
    readonly transform: Settings;
    readonly blendMode: string;
    readonly privateSettings: SceneifySceneItemPrivateSettings;
    readonly index: number;
}
export interface SceneSnapshot {
    readonly name: string;
    readonly uuid: string;
    readonly privateSettings: SceneifySourcePrivateSettings;
    readonly filters: ReadonlyArray<FilterSnapshot>;
    readonly items: ReadonlyArray<SceneItemSnapshot>;
    readonly transitionName: string | null;
    readonly transitionDuration: number | null;
}
export interface Snapshot {
    readonly scenes: ReadonlyArray<SceneSnapshot>;
    readonly inputs: ReadonlyArray<InputSnapshot>;
    readonly currentProgramSceneName: string | null;
    readonly currentPreviewSceneName: string | null;
}
/**
 * Creates a stateful OBSSocket implementation without opening a WebSocket.
 * Requests reduce one immutable state value into the next state value.
 */
export declare const make: (options?: Options) => {
    service: OBSSocket;
    layer: Layer.Layer<OBSSocket, never, never>;
    /**
     * An obs-websocket-js shaped client backed by the same memory state.
     */
    ws: OBSWebSocket;
    readonly calls: readonly RecordedCall[];
    readonly batches: readonly RecordedBatch[];
    snapshot: () => Snapshot;
};
export declare const layer: (options?: Options) => Layer.Layer<OBSSocket, never, never>;
//# sourceMappingURL=MockOBSSocket.d.ts.map