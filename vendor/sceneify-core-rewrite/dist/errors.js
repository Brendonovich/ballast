import { Data } from "effect";
/**
 * Base error for all OBS WebSocket errors
 */
export class OBSError extends Data.TaggedError("OBSError") {
}
/**
 * Error when attempting to create an input with a name that already exists in OBS
 */
export class InputAlreadyExistsError extends Data.TaggedError("InputAlreadyExistsError") {
    get message() {
        return `An input already exists with the name "${this.inputName}"`;
    }
}
/**
 * Error when attempting to create an input with a name that already exists
 * but was not created by Sceneify (or has a different kind)
 */
export class NameConflictError extends Data.TaggedError("NameConflictError") {
    get message() {
        if (this.expectedKind && this.actualKind) {
            return `Name conflict: "${this.name}" exists with kind "${this.actualKind}" but expected "${this.expectedKind}"`;
        }
        return `Name conflict: "${this.name}" already exists and was not created by Sceneify`;
    }
}
export class DeclaredSceneItemRemovalError extends Data.TaggedError("DeclaredSceneItemRemovalError") {
    get message() {
        return `Cannot remove declared scene item (id: ${this.sceneItemId}) from scene "${this.sceneName}". Only dynamically created items can be removed.`;
    }
}
/**
 * Error when OBS WebSocket connection fails
 */
export class ConnectionError extends Data.TaggedError("ConnectionError") {
    get message() {
        return `Failed to connect to OBS at ${this.url}`;
    }
}
export class InvalidDeclarationError extends Data.TaggedError("InvalidDeclarationError") {
}
//# sourceMappingURL=errors.js.map