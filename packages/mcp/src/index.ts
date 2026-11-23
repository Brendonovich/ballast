export { parseConfig, defaultStateDir, defaultDataDir, discoveryCandidates } from "./config.ts";
export type { McpConfig } from "./config.ts";
export { discoverService, readServiceRegistration, serviceJsonPath } from "./discovery.ts";
export type { DiscoveredService, DiscoveryOptions, ServiceRegistration } from "./discovery.ts";
export { makeAgentGateway } from "./client.ts";
export type { AgentGateway, GatewayOptions } from "./client.ts";
export {
  applyProject,
  checkText,
  makeProjectAdapter,
  normalizeSourceLocation,
} from "./adapter.ts";
export type {
  ApplyOutcome,
  ApplyReason,
  ApplyState,
  CheckResult,
  ProjectAdapter,
  ProjectState,
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
export { registerTools } from "./tools.ts";
export type { ToolContext, ToolOutput } from "./tools.ts";
export { makeMcpLayer, runServer } from "./server.ts";
export { runMcpCli, MCP_VERSION } from "./cli.ts";
export type { CliInput } from "./cli.ts";
