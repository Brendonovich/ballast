import { Effect } from "effect";
import { InputAlreadyExistsError, NameConflictError, type OBSError } from "./errors.ts";
import * as Filter from "./Filter.ts";
import type { FilterType } from "./FilterType.ts";
import * as Input from "./Input.ts";
import type { InputType, InputTypeSettings } from "./InputType.ts";
import * as SceneItem from "./SceneItem.ts";
import { Sceneify } from "./Sceneify.ts";
export interface CreateItemConfig<TType extends InputType<string, any> = InputType<string, any>> {
    readonly type: TType;
    readonly name: string;
    readonly settings?: Partial<InputTypeSettings<TType>>;
}
type FiltersDeclaration<TFilters extends Record<string, FilterType>> = {
    [K in keyof TFilters]: Filter.Config<TFilters[K]>;
};
type ItemsDeclaration<TItems extends Record<string, Input.Declaration<any>>> = {
    [K in keyof TItems]: SceneItem.SceneItemDecl<TItems[K]>;
};
export interface SceneDeclaration<TItems extends Record<string, Input.Declaration<any>>, TFilters extends Record<string, FilterType> = {}> {
    readonly name: string;
    readonly items: ItemsDeclaration<TItems>;
    readonly filters: FiltersDeclaration<TFilters>;
}
export interface TransitionOverride {
    readonly transitionName: string | null;
    readonly transitionDuration: number | null;
}
export interface SetTransitionOverrideOptions {
    readonly transitionName?: string | null;
    readonly transitionDuration?: number | null;
}
export interface Scene<TItems extends Record<string, Input.Declaration<any>>, TFilters extends Record<string, FilterType> = {}> {
    readonly name: string;
    readonly item: <K extends string & keyof TItems>(key: K) => SceneItem.SceneItem<TItems[K]>;
    readonly filter: <K extends string & keyof TFilters>(key: K) => Filter.Filter<TFilters[K]>;
    readonly createItem: <TType extends InputType<string, any>, TFilters extends Record<string, FilterType>>(config: CreateItemConfig<TType>) => Effect.Effect<SceneItem.SceneItem<Input.Declaration<TType, TFilters>>, OBSError | InputAlreadyExistsError | NameConflictError>;
    readonly getTransitionOverride: () => Effect.Effect<TransitionOverride, OBSError>;
    readonly setTransitionOverride: (options: SetTransitionOverrideOptions) => Effect.Effect<void, OBSError>;
    readonly makeProgramScene: Effect.Effect<void, OBSError>;
    readonly makePreviewScene: Effect.Effect<void, OBSError>;
}
export declare const sync: <TItems extends Record<string, Input.Declaration<InputType<string, any>, {}>>, TFilters extends Record<string, FilterType<string, any>>>(declaration: SceneDeclaration<TItems, TFilters>) => Effect.Effect<Scene<TItems, TFilters>, import("./errors.ts").InvalidDeclarationError | NameConflictError | OBSError, Sceneify>;
type DeclarationOptions<TItems extends Record<string, Input.Declaration<any>>, TFilters extends Record<string, FilterType>> = {
    name: string;
    items: ItemsDeclaration<TItems>;
    filters?: FiltersDeclaration<TFilters>;
};
export declare const declare: <TItems extends Record<string, Input.Declaration<any, {}>>, TFilters extends Record<string, FilterType<string, any>> = {}>(options: DeclarationOptions<TItems, TFilters>) => SceneDeclaration<TItems, TFilters>;
export {};
//# sourceMappingURL=Scene.d.ts.map