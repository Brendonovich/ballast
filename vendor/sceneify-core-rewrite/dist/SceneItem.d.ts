import { Effect } from "effect";
import * as Input from "./Input.ts";
import { DeclaredSceneItemRemovalError, type OBSError } from "./errors.ts";
import { OBSSocket } from "./OBSSocket.ts";
import type { InputType } from "./InputType.ts";
import type { FilterType } from "./FilterType.ts";
export declare const Alignment: {
    centerLeft: number;
    center: number;
    centerRight: number;
    topLeft: number;
    top: number;
    topRight: number;
    bottomLeft: number;
    bottom: number;
    bottomRight: number;
};
export interface Transform {
    positionX?: number;
    positionY?: number;
    scaleX?: number;
    scaleY?: number;
    rotation?: number;
    cropLeft?: number;
    cropRight?: number;
    cropTop?: number;
    cropBottom?: number;
    alignment?: number;
    boundsType?: string;
    boundsAlignment?: number;
    boundsWidth?: number;
    boundsHeight?: number;
    sourceWidth?: number;
    sourceHeight?: number;
}
/**
 * A declared scene item - a source (input or scene) placed in a scene with optional
 * transform, index, enabled, and lock properties.
 */
export type SceneItemDecl<TSource extends Input.Declaration<any, any> = Input.Declaration<any, any>> = {
    readonly source: TSource;
    readonly index?: number;
    readonly enabled?: boolean;
    readonly lock?: boolean;
    readonly transform?: Transform;
};
/**
 * Runtime representation of a scene item in OBS.
 * OBSSocket is captured at creation time - methods return Effects
 * that do not require OBSSocket in context.
 */
export interface SceneItem<TSource extends Input.Declaration<any, any> = Input.Declaration<any, any>> {
    /** The OBS scene item ID */
    readonly id: number;
    /** The scene name this item belongs to */
    readonly sceneName: string;
    /** The runtime input this item references */
    readonly input: Input.Input<Input.DeclarationType<TSource>, Input.DeclarationFilters<TSource>>;
    /** Whether this item was part of a scene declaration (cannot be removed) */
    readonly declared: boolean;
    /** Get the current transform */
    readonly getTransform: () => Effect.Effect<Transform, OBSError>;
    /** Set the transform */
    readonly setTransform: (transform: Partial<Transform>) => Effect.Effect<void, OBSError>;
    /** Get enabled/visible state */
    readonly getEnabled: () => Effect.Effect<boolean, OBSError>;
    /** Set enabled/visible */
    readonly setEnabled: (enabled: boolean) => Effect.Effect<void, OBSError>;
    /** Get locked state */
    readonly getLocked: () => Effect.Effect<boolean, OBSError>;
    /** Set locked */
    readonly setLocked: (locked: boolean) => Effect.Effect<void, OBSError>;
    /** Get the index/order in the scene */
    readonly getIndex: () => Effect.Effect<number, OBSError>;
    /** Set the index/order in the scene */
    readonly setIndex: (index: number) => Effect.Effect<void, OBSError>;
    /** Get the OBS blend mode */
    readonly getBlendMode: () => Effect.Effect<string, OBSError>;
    /** Set the OBS blend mode */
    readonly setBlendMode: (blendMode: string) => Effect.Effect<void, OBSError>;
    /** Duplicate into this scene or another destination scene */
    readonly duplicate: (destinationSceneName?: string) => Effect.Effect<SceneItem<TSource>, OBSError>;
    /** Remove from scene (fails if declared) */
    readonly remove: () => Effect.Effect<void, OBSError | DeclaredSceneItemRemovalError>;
}
/**
 * Creates a SceneItem runtime from an ID, scene name, and Input.
 * The OBSSocket is captured at creation and used for all subsequent calls.
 */
export declare const make: <TType extends InputType<string, any>, TFilters extends Record<string, FilterType<string, any>>>(id: number, sceneName: string, input: Input.Input<TType, TFilters>, declared: boolean) => Effect.Effect<SceneItem<Input.Declaration<TType, TFilters>>, never, OBSSocket>;
//# sourceMappingURL=SceneItem.d.ts.map