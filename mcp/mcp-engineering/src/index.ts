#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OS_ROOT, SERVER_NAME, enabledGroups, limits } from "./config.js";
import { registerEngineeringTools } from "./tools.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  const enabled = registerEngineeringTools(server, enabledGroups());

  // stdout chỉ dành cho JSON-RPC — mọi log đi ra stderr.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`[${SERVER_NAME}] v${VERSION} ready — ${enabled.length} tool(s) enabled\n`);
  process.stderr.write(`[${SERVER_NAME}] osRoot=${OS_ROOT} maxResults=${limits().maxResults}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`[${SERVER_NAME}] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
