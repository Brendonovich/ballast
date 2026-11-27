import { Context, Effect, Layer } from "effect";
import type { InvalidDeclarationError, NameConflictError, OBSError } from "./errors.ts";
import type { FilterType } from "./FilterType.ts";
import type * as InputDeclaration from "./Input.ts";
import type { InputType } from "./InputType.ts";
import { type OBSSocket as OBSSocketService } from "./OBSSocket.ts";
import type * as Scene from "./Scene.ts";
/**
 * Placeholder for Input type (will be implemented in Phase 2)
 */
export interface Input {
    readonly name: string;
}
/**
 * Sceneify service interface
 * Tracks instantiated inputs to prevent duplicate creation
 */
export interface Sceneify {
    /**
     * Get an input by name if it has been instantiated
     */
    readonly getInput: (name: string) => Effect.Effect<Input | undefined, never>;
    /**
     * Register an instantiated input
     */
    readonly registerInput: (input: Input) => Effect.Effect<void, never>;
    /**
     * Check if an input has been instantiated
     */
    readonly hasInput: (name: string) => Effect.Effect<boolean, never>;
    /**
     * Clear all registered inputs (mainly for testing)
     */
    readonly clear: () => Effect.Effect<void, never>;
    readonly sync: <TItems extends Record<string, InputDeclaration.Declaration<InputType<string, any>>>, TFilters extends Record<string, FilterType>>(declaration: Scene.SceneDeclaration<TItems, TFilters>) => Effect.Effect<Scene.Scene<TItems, TFilters>, InvalidDeclarationError | NameConflictError | OBSError>;
}
/**
 * Sceneify service tag
 */
export declare const Sceneify: Context.Service<Sceneify, Sceneify>;
/**
 * Create a Sceneify service for the OBSSocket in context
 */
export declare const make: Effect.Effect<Sceneify, never, OBSSocketService>;
/**
 * Create a Sceneify layer
 */
export declare const layer: Layer.Layer<Sceneify, never, OBSSocketService>;
//# sourceMappingURL=Sceneify.d.ts.map