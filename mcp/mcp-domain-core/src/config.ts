import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));

export const OS_ROOT = process.env["ENGINEERING_OS_ROOT"]
  ? path.resolve(process.env["ENGINEERING_OS_ROOT"])
  : path.resolve(here, "..", "..", "..");

export const SERVER_NAME = "mcp-domain-core";

export interface Limits {
  maxResults: number;
  maxBytes: number;
  pagination: { defaultPageSize: number; maxPageSize: number };
}

export interface MbsmServerConfig {
  groups: Record<string, boolean>;
  data: { dir: string; synthetic: boolean };
  behavior: { progressiveDisclosure: boolean; requireSourceRefs: boolean; failClosed: boolean };
}

interface McpFile {
  limits: Limits;
  servers: Record<string, unknown>;
}

let cache: McpFile | null = null;

function mcpConfigPath(): string {
  return process.env["MCP_CONFIG"] ? path.resolve(process.env["MCP_CONFIG"]) : path.join(OS_ROOT, "config", "mcp.yaml");
}

export function limits(): Limits {
  if (!cache) cache = parseYaml(readFileSync(mcpConfigPath(), "utf8")) as McpFile;
  return cache.limits;
}

export function serverConfig(): MbsmServerConfig {
  if (!cache) cache = parseYaml(readFileSync(mcpConfigPath(), "utf8")) as McpFile;
  const cfg = cache.servers[SERVER_NAME];
  if (!cfg) throw new Error(`Không tìm thấy servers.${SERVER_NAME} trong ${mcpConfigPath()}`);
  return cfg as MbsmServerConfig;
}

/** Thư mục dataset domain. Có thể override bằng env DOMAIN_DATA_DIR. */
export function dataDir(): string {
  const fromEnv = process.env["DOMAIN_DATA_DIR"];
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(OS_ROOT, serverConfig().data.dir);
}
