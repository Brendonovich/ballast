import { Layer } from "effect";
import { ConnectionError } from "./errors.ts";
import { OBSSocket } from "./OBSSocket.ts";
/**
 * Configuration for OBS WebSocket connection
 */
export interface OBSSocketConfig {
    readonly url: string;
    readonly password?: string;
}
/**
 * Create an OBSSocket layer that connects to OBS directly with obs-websocket-js
 */
export declare const layer: (config: OBSSocketConfig) => Layer.Layer<OBSSocket, ConnectionError, never>;
//# sourceMappingURL=OBSWebSocket.d.ts.map