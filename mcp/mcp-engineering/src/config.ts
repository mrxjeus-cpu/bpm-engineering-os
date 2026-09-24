import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Gốc của Engineering OS (repo này). Override bằng env ENGINEERING_OS_ROOT. */
export const OS_ROOT = process.env["ENGINEERING_OS_ROOT"]
  ? path.resolve(process.env["ENGINEERING_OS_ROOT"])
  : path.resolve(here, "..", "..", "..");

export const SERVER_NAME = "mcp-engineering";

export interface Limits {
  maxResults: number;
  maxBytes: number;
  maxSnippetLines: number;
  maxSymbolBodyLines: number;
  pagination: { defaultPageSize: number; maxPageSize: number };
}

export interface EngineeringServerConfig {
  groups: Record<string, boolean>;
  repo: { rootEnv: string; rootDefault: string | null };
  scan: { include: string[]; excludeDirs: string[]; maxFileBytes: number };
  verification: {
    allowPatternRuns: boolean;
    patternWhitelist: string;
    timeoutMs: number;
    recordEvidence: boolean;
  };
}

export interface ProjectConfig {
  label?: string;
  repoRoot: { env: string; default: string | null };
  language: string;
  buildSystem: string;
  conventions: string[];
  scope: { allowedRoots: string[]; allowDeletions: string[] };
  commands: Record<string, string[][]>;
  testSuites: Record<string, { profile?: string; timeoutMs?: number }>;
}

export interface ProjectsConfig {
  defaultProject: string;
  workspace: { workstreamRoot: string; globalRoot: string };
  protectedBranches: string[];
  projects: Record<string, ProjectConfig>;
}

interface McpFile {
  limits: Limits;
  servers: Record<string, unknown>;
}

let mcpCache: McpFile | null = null;
let projectsCache: ProjectsConfig | null = null;

function readYamlFile(file: string): unknown {
  const text = readFileSync(file, "utf8");
  return parseYaml(text);
}

function mcpConfigPath(): string {
  return process.env["MCP_CONFIG"]
    ? path.resolve(process.env["MCP_CONFIG"])
    : path.join(OS_ROOT, "config", "mcp.yaml");
}

function projectsConfigPath(): string {
  return process.env["PROJECTS_CONFIG"]
    ? path.resolve(process.env["PROJECTS_CONFIG"])
    : path.join(OS_ROOT, "config", "projects.yaml");
}

export function loadMcpConfig(): McpFile {
  if (!mcpCache) mcpCache = readYamlFile(mcpConfigPath()) as McpFile;
  return mcpCache;
}

export function loadProjectsConfig(): ProjectsConfig {
  if (!projectsCache) projectsCache = readYamlFile(projectsConfigPath()) as ProjectsConfig;
  return projectsCache;
}

export function limits(): Limits {
  return loadMcpConfig().limits;
}

export function serverConfig(): EngineeringServerConfig {
  const cfg = loadMcpConfig().servers[SERVER_NAME];
  if (!cfg) throw new Error(`Không tìm thấy servers.${SERVER_NAME} trong ${mcpConfigPath()}`);
  return cfg as EngineeringServerConfig;
}

export function projectConfig(project?: string): { name: string; config: ProjectConfig } {
  const cfg = loadProjectsConfig();
  const name = project ?? cfg.defaultProject;
  const found = cfg.projects[name];
  if (!found) {
    throw new Error(
      `Project "${name}" không có trong ${projectsConfigPath()}. ` +
        `Có sẵn: ${Object.keys(cfg.projects).join(", ")}`,
    );
  }
  return { name, config: found };
}

export function enabledGroups(): Record<string, boolean> {
  return serverConfig().groups;
}
