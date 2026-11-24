export const CLIENT_INTEGRATION = "websocket-client";
export const SERVER_INTEGRATION = "websocket-server";

export type ClientIntegration = typeof CLIENT_INTEGRATION;
export type ServerIntegration = typeof SERVER_INTEGRATION;
export type Integration = ClientIntegration | ServerIntegration;
