export { parseConfig, defaultStateDir, defaultDataDir, discoveryCandidates } from "./config.ts";
export type { McpConfig } from "./config.ts";
export { discoverService, readServiceRegistration, serviceJsonPath } from "./discovery.ts";
export type { DiscoveredService, DiscoveryOptions, ServiceRegistration } from "./discovery.ts";
export { makeAgentGateway } from "./client.ts";
export type { AgentGateway, GatewayOptions } from "./client.ts";
export { applyProject, checkText, makeProjectAdapter } from "./adapter.ts";
export type {
  ApplyOutcome,
  ApplyReason,
  ApplyState,
  CheckResult,
  CheckUnit,
  Diagnostic,
  MissingConnection,
  MissingScopes,
  ProjectAdapter,
  UnitChange,
} from "./adapter.ts";
export { catalog, formatCatalog, selectCatalog } from "./catalog.ts";
export type {
  Catalog,
  CatalogConnection,
  CatalogFilter,
  CatalogIntegration,
  CatalogRequest,
  CatalogTopic,
  ConnectionKind,
} from "./catalog.ts";
export { GUIDE } from "./guide.ts";
export { initProject } from "./scaffold.ts";
export type { ScaffoldResult } from "./scaffold.ts";
export { registerTools } from "./tools.ts";
export type { ToolContext, ToolOutput } from "./tools.ts";
export { makeMcpLayer, runServer } from "./server.ts";
export { runMcpCli, MCP_VERSION } from "./cli.ts";
export type { CliInput } from "./cli.ts";
