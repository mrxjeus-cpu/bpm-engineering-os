#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, dataDir, limits, serverConfig } from "./config.js";
import { registerMbsmTools } from "./tools.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  const enabled = registerMbsmTools(server, serverConfig().groups);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`[${SERVER_NAME}] v${VERSION} ready — ${enabled.length} tool(s) enabled\n`);
  process.stderr.write(
    `[${SERVER_NAME}] dataDir=${dataDir()} synthetic=${String(serverConfig().data.synthetic)} ` +
      `maxResults=${limits().maxResults}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`[${SERVER_NAME}] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
