import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as McpServer from "effect/ai/McpServer";
import * as McpProtocol from "effect/ai/McpProtocol";
import { NodeStdio } from "@effect/platform-node";

import { makeProjectAdapter } from "./adapter.ts";
import { makeAgentGateway } from "./client.ts";
import type { McpConfig } from "./config.ts";
import { registerTools } from "./tools.ts";

export interface McpServerOptions {
  readonly config: McpConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly home: string;
}

const protocols = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
] as const;

const VERSION = "0.1.0";

/**
 * The server layer registers tools and then serves MCP over stdio. Tools are
 * registered in a layer that depends on McpServer, so they exist before the
 * first client request is normally read.
 */
export const makeMcpLayer = (options: McpServerOptions) => {
  const gateway = makeAgentGateway({
    config: options.config,
    env: options.env,
    platform: options.platform,
    home: options.home,
  });
  const adapter = makeProjectAdapter(gateway);

  const tools = Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      yield* registerTools(server, { adapter });
    }),
  );

  return tools.pipe(
    Layer.provide(
      McpServer.layerStdio({
        name: "ballast",
        version: VERSION,
        instructions:
          "Ballast authoring and runtime tools. Call ballast_guide before writing a project, ballast_catalog to find integrations/topics/requests, then ballast_project_init, ballast_check, ballast_apply and ballast_status. Consent and the first start are always user actions in the Ballast app.",
        protocols,
      }),
    ),
    Layer.provide(NodeStdio.layer),
  );
};

export const runServer = (options: McpServerOptions): Promise<never> =>
  Effect.runPromise(Layer.launch(makeMcpLayer(options)));
