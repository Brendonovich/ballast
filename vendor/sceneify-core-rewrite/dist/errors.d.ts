declare const OBSError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "OBSError";
} & Readonly<A>;
/**
 * Base error for all OBS WebSocket errors
 */
export declare class OBSError extends OBSError_base<{
    readonly message: string;
    readonly cause?: unknown;
}> {
}
declare const InputAlreadyExistsError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "InputAlreadyExistsError";
} & Readonly<A>;
/**
 * Error when attempting to create an input with a name that already exists in OBS
 */
export declare class InputAlreadyExistsError extends InputAlreadyExistsError_base<{
    readonly inputName: string;
}> {
    get message(): string;
}
declare const NameConflictError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "NameConflictError";
} & Readonly<A>;
/**
 * Error when attempting to create an input with a name that already exists
 * but was not created by Sceneify (or has a different kind)
 */
export declare class NameConflictError extends NameConflictError_base<{
    readonly name: string;
    readonly expectedKind?: string;
    readonly actualKind?: string;
}> {
    get message(): string;
}
declare const DeclaredSceneItemRemovalError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "DeclaredSceneItemRemovalError";
} & Readonly<A>;
export declare class DeclaredSceneItemRemovalError extends DeclaredSceneItemRemovalError_base<{
    readonly sceneName: string;
    readonly sceneItemId: number;
}> {
    get message(): string;
}
declare const ConnectionError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ConnectionError";
} & Readonly<A>;
/**
 * Error when OBS WebSocket connection fails
 */
export declare class ConnectionError extends ConnectionError_base<{
    readonly url: string;
    readonly cause?: unknown;
}> {
    get message(): string;
}
declare const InvalidDeclarationError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "InvalidDeclarationError";
} & Readonly<A>;
export declare class InvalidDeclarationError extends InvalidDeclarationError_base<{
    readonly message: string;
}> {
}
export {};
//# sourceMappingURL=errors.d.ts.map