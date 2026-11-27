import { Context, Effect } from "effect";
import type * as OBS from "obs-websocket-js";
import { OBSError } from "./errors.ts";
/**
 * Metadata stored by Sceneify in OBS private settings to track ownership.
 */
export interface SceneifyFilterData {
    readonly key: string;
    readonly name: string;
}
/**
 * Shape of the SCENEIFY key stored in source private settings.
 */
export type SceneifySourceData = {
    readonly filters?: ReadonlyArray<SceneifyFilterData>;
};
export type SceneifySceneItemData = {
    readonly key: string;
};
export interface SceneifySourcePrivateSettings {
    readonly SCENEIFY?: SceneifySourceData | null;
    readonly [key: string]: unknown;
}
export interface SceneifySceneItemPrivateSettings {
    readonly SCENEIFY?: SceneifySceneItemData | null;
    readonly [key: string]: unknown;
}
export interface RequestTypes extends OBS.OBSRequestTypes {
    GetSourcePrivateSettings: {
        sourceName?: string;
        sourceUuid?: string;
    };
    SetSourcePrivateSettings: {
        sourceName?: string;
        sourceUuid?: string;
        sourceSettings: SceneifySourcePrivateSettings;
    };
    GetSceneItemPrivateSettings: {
        sceneName: string;
        sceneItemId: number;
    };
    SetSceneItemPrivateSettings: {
        sceneName: string;
        sceneItemId: number;
        sceneItemSettings: SceneifySceneItemPrivateSettings;
    };
}
export type OBSJsonObject = NonNullable<RequestTypes["SetInputSettings"]["inputSettings"]>;
export interface ResponseTypes extends OBS.OBSResponseTypes {
    GetInputList: Omit<OBS.OBSResponseTypes["GetInputList"], "inputs"> & {
        inputs: Array<{
            inputName: string;
            inputKind: string;
        }>;
    };
    GetSceneList: Omit<OBS.OBSResponseTypes["GetSceneList"], "scenes"> & {
        scenes: Array<{
            sceneName: string;
        }>;
    };
    GetSceneItemList: Omit<OBS.OBSResponseTypes["GetSceneItemList"], "sceneItems"> & {
        sceneItems: Array<{
            sceneItemId: number;
            sceneItemIndex: number;
            sourceName: string;
        }>;
    };
    GetSourceFilterList: Omit<OBS.OBSResponseTypes["GetSourceFilterList"], "filters"> & {
        filters: Array<{
            filterEnabled: boolean;
            filterIndex: number;
            filterKind: string;
            filterName: string;
            filterSettings: OBSJsonObject;
        }>;
    };
    GetInputPropertiesListPropertyItems: Omit<OBS.OBSResponseTypes["GetInputPropertiesListPropertyItems"], "propertyItems"> & {
        propertyItems: Array<{
            itemName: string;
            itemEnabled: boolean;
            itemValue?: string | number;
        }>;
    };
    GetSourcePrivateSettings: {
        sourceSettings: SceneifySourcePrivateSettings;
    };
    SetSourcePrivateSettings: void;
    GetSceneItemPrivateSettings: {
        sceneItemSettings: SceneifySceneItemPrivateSettings;
    };
    SetSceneItemPrivateSettings: void;
}
export declare const OBSCallTypeId: unique symbol;
export interface OBSCallRequest<Type extends keyof RequestTypes = keyof RequestTypes> {
    readonly requestType: Type;
    readonly requestData?: RequestTypes[Type];
}
/**
 * An effect that performs a single OBS request, and also carries that
 * request's data so it can be sent as part of a batch with `OBSSocket.batch`.
 */
export interface OBSCall<Type extends keyof RequestTypes> extends Effect.Effect<ResponseTypes[Type], OBSError> {
    readonly [OBSCallTypeId]: OBSCallRequest<Type>;
}
export declare const makeCall: <Type extends keyof RequestTypes>(effect: Effect.Effect<ResponseTypes[Type], OBSError, never>, requestType: Type, requestData: RequestTypes[Type] | undefined) => OBSCall<Type>;
export type BatchExecutionType = "SerialRealtime" | "SerialFrame" | "Parallel";
export interface BatchOptions {
    /**
     * How OBS runs the batch. Defaults to `SerialRealtime`.
     * `SerialFrame` runs requests in sync with the graphics thread.
     */
    readonly executionType?: BatchExecutionType;
    /**
     * Stop processing the batch after the first failed request.
     */
    readonly haltOnFailure?: boolean;
}
export type BatchResults<Calls extends ReadonlyArray<OBSCall<any>>> = {
    -readonly [K in keyof Calls]: Calls[K] extends Effect.Effect<infer A, any, any> ? A : never;
};
export declare const batchExecutionTypes: Record<BatchExecutionType, number>;
export interface BatchResponse {
    readonly requestId: string;
    readonly requestStatus: {
        readonly result: true;
        readonly code: number;
    } | {
        readonly result: false;
        readonly code: number;
        readonly comment: string;
    };
    readonly responseData?: unknown;
}
/**
 * Matches batch responses to their requests by `requestId` (the request's
 * index), failing with the first failed request in batch order.
 */
export declare const collectBatchResponses: (requests: readonly OBSCallRequest<keyof RequestTypes>[], responses: readonly BatchResponse[]) => Effect.Effect<unknown[], OBSError, never>;
/**
 * OBS WebSocket service interface
 */
export interface OBSSocket {
    /**
     * Call an OBS WebSocket request
     */
    readonly call: <Type extends keyof RequestTypes>(requestType: Type, requestData?: RequestTypes[Type]) => OBSCall<Type>;
    /**
     * Send several requests created with `call` as a single OBS request batch.
     * Results are returned in the same order as `calls`. Fails with the first
     * failed request.
     */
    readonly batch: <const Calls extends ReadonlyArray<OBSCall<any>>>(calls: Calls, options?: BatchOptions) => Effect.Effect<BatchResults<Calls>, OBSError>;
}
/**
 * OBS WebSocket service tag
 */
export declare const OBSSocket: Context.Service<OBSSocket, OBSSocket>;
/**
 * Sends a single OBS request. Implemented by each transport.
 */
export type Send = <Type extends keyof RequestTypes>(requestType: Type, requestData: RequestTypes[Type] | undefined) => Effect.Effect<ResponseTypes[Type], OBSError>;
/**
 * Creates an OBSSocket from a transport that sends one request at a time.
 *
 * `batch` sends its requests one after another, so the result matches an OBS
 * `SerialRealtime` batch: every request runs unless `haltOnFailure` is set,
 * and the batch fails with the first failed request.
 */
export declare const make: (send: Send) => OBSSocket;
//# sourceMappingURL=OBSSocket.d.ts.map