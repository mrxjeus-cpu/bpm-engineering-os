import { EngError } from "../errors.js";
import { configPath, OS_ROOT } from "../paths.js";
import { loadYamlRaw } from "../yaml.js";
import type { ExecutionMode, RiskLevel } from "../types.js";

export interface HarnessSpec {
  enabled?: boolean;
  description?: string;
  /** Placeholder: {prompt} {repoRoot} {osRoot} {taskId} {subTaskId} */
  command: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface ModelsConfig {
  version: number;
  tiers: Record<string, string>;
  agents: Record<string, string>;
  complexity: Record<string, string>;
  riskFloor: Record<string, string>;
  routing: {
    weights: Record<string, number>;
    caps: { minTier: string; maxTier: string; fallback: string };
    neverBelowRiskFloor: boolean;
  };
  harness?: Record<string, HarnessSpec>;
}

export interface GateConfig {
  id: string;
  type: "human" | "automated";
  transition: [string, string] | string[];
  required: boolean;
  bypassInModes?: string[];
  bypassIfRiskAtMost?: RiskLevel;
  bypassRequiresConfigFlag?: boolean;
  requiredIfAny?: string[];
  rule?: string;
  tool?: string;
  requires?: string[];
  onViolation?: string;
}

export interface GatesConfig {
  version: number;
  defaultMode: ExecutionMode;
  modes: Record<ExecutionMode, { description?: string; humanGates: string[]; allowedRisk: RiskLevel[]; allowParallel?: boolean }>;
  gates: GateConfig[];
  approvals: { evidenceType: string; requiredFields: string[]; store: string };
}

export interface RiskConfig {
  version: number;
  scale: RiskLevel[];
  thresholds: Record<string, number>;
  factors: Array<{ id: string; label: string; points: number; criticalIf?: string[]; scalesWithCount?: boolean }>;
  effects: Record<RiskLevel, Record<string, unknown>>;
}

export interface McpConfig {
  version: number;
  routing: { byPhase: Record<string, string[]>; byDomain: Record<string, string[]>; default: string[] };
  limits: {
    maxResults: number;
    maxBytes: number;
    maxSnippetLines: number;
    maxSymbolBodyLines: number;
    pagination: { defaultPageSize: number; maxPageSize: number };
    context?: {
      maxTokens: number;
      maxSymbols: number;
      maxSnippetLines: number;
      maxSimilar: number;
      maxRules: number;
      maxArchitectureConstraints: number;
      maxSkills?: number;
      maxSkillTokens?: number;
    };
  };
  servers: Record<string, { transport?: string; command?: string; args?: string[]; groups?: Record<string, boolean>; [key: string]: unknown }>;
}

export interface ProjectConfig {
  label?: string;
  repoRoot?: { env?: string; default?: string | null };
  language?: string;
  buildSystem?: string;
  conventions?: string[];
  scope?: { allowedRoots: string[]; allowDeletions: string[] };
  commands?: Record<string, string[][]>;
  testSuites?: Record<string, { profile?: string; timeoutMs?: number }>;
  worktrees?: { enabled?: boolean; branchPrefix?: string; root?: string; baseRef?: string };
}

export interface ProjectsConfig {
  version: number;
  defaultProject: string;
  workspace: { workstreamRoot: string; globalRoot: string };
  protectedBranches: string[];
  projects: Record<string, ProjectConfig>;
}

export interface Config {
  models: ModelsConfig;
  gates: GatesConfig;
  risk: RiskConfig;
  mcp: McpConfig;
  projects: ProjectsConfig;
}

function loadYaml<T>(name: string): T {
  return loadYamlRaw<T>(configPath(name));
}

function requirePath(file: string, obj: unknown, keyPath: string): void {
  let cursor: unknown = obj;
  for (const segment of keyPath.split(".")) {
    if (typeof cursor !== "object" || cursor === null || !(segment in (cursor as Record<string, unknown>))) {
      throw new EngError("CONFIG_INVALID", `${file} thiếu khoá bắt buộc: ${keyPath}`, {
        hint: "Xem cấu trúc trong SPEC-bpm-engineering-os.md mục 11-13.",
      });
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
}

let cache: Config | null = null;

/** Đọc + kiểm tra 5 file config. Đây là nguồn cấu hình duy nhất của runtime. */
export function loadConfig(): Config {
  if (cache) return cache;

  const models = loadYaml<ModelsConfig>("models");
  requirePath("config/models.yaml", models, "tiers");
  requirePath("config/models.yaml", models, "agents");
  requirePath("config/models.yaml", models, "riskFloor");
  requirePath("config/models.yaml", models, "routing.caps");

  const gates = loadYaml<GatesConfig>("gates");
  requirePath("config/gates.yaml", gates, "defaultMode");
  requirePath("config/gates.yaml", gates, "modes");
  requirePath("config/gates.yaml", gates, "gates");
  if (!Array.isArray(gates.gates) || gates.gates.length === 0) {
    throw new EngError("CONFIG_INVALID", "config/gates.yaml: gates phải là mảng không rỗng.");
  }
  if (!gates.modes[gates.defaultMode]) {
    throw new EngError("CONFIG_INVALID", `config/gates.yaml: defaultMode "${gates.defaultMode}" không có trong modes.`);
  }

  const risk = loadYaml<RiskConfig>("risk");
  requirePath("config/risk.yaml", risk, "thresholds");
  requirePath("config/risk.yaml", risk, "factors");
  requirePath("config/risk.yaml", risk, "effects");

  const mcp = loadYaml<McpConfig>("mcp");
  requirePath("config/mcp.yaml", mcp, "limits");
  requirePath("config/mcp.yaml", mcp, "servers");

  const projects = loadYaml<ProjectsConfig>("projects");
  requirePath("config/projects.yaml", projects, "defaultProject");
  requirePath("config/projects.yaml", projects, "workspace.workstreamRoot");
  requirePath("config/projects.yaml", projects, "protectedBranches");
  if (!projects.projects || Object.keys(projects.projects).length === 0) {
    throw new EngError("CONFIG_INVALID", "config/projects.yaml: projects rỗng.");
  }
  if (!projects.projects[projects.defaultProject]) {
    throw new EngError(
      "CONFIG_INVALID",
      `config/projects.yaml: defaultProject "${projects.defaultProject}" không tồn tại trong projects.`,
    );
  }

  cache = { models, gates, risk, mcp, projects };
  return cache;
}

export function clearConfigCache(): void {
  cache = null;
}

/** Thư mục chứa workstream (state/artifact của mọi ticket). */
export function workstreamRoot(): string {
  const { projects } = loadConfig();
  const root = projects.workspace.workstreamRoot;
  return root.startsWith("/") ? root : `${OS_ROOT}/${root}`;
}

export function globalRoot(): string {
  const { projects } = loadConfig();
  const root = projects.workspace.globalRoot;
  return root.startsWith("/") ? root : `${OS_ROOT}/${root}`;
}

export function defaultMode(): ExecutionMode {
  return loadConfig().gates.defaultMode;
}

export function modeConfig(mode: ExecutionMode): GatesConfig["modes"][ExecutionMode] {
  const { gates } = loadConfig();
  const found = gates.modes[mode];
  if (!found) {
    throw new EngError("CONFIG_INVALID", `Mode "${mode}" không có trong config/gates.yaml`, {
      hint: `Mode hợp lệ: ${Object.keys(gates.modes).join(", ")}`,
    });
  }
  return found;
}

export function humanGatesForTransition(from: string, to: string): GateConfig[] {
  const { gates } = loadConfig();
  return gates.gates.filter((gate) => {
    if (gate.type !== "human") return false;
    const [gFrom, gTo] = gate.transition;
    return (gFrom === from && gTo === to) || (gFrom === "*" && gTo === to);
  });
}

export function modelTierFor(role: string, risk: RiskLevel): string {
  const { models } = loadConfig();
  const base = models.agents[role] ?? models.routing.caps.fallback;
  const floor = models.riskFloor[risk] ?? base;
  const order = Object.keys(models.tiers);
  const baseIndex = order.indexOf(base);
  const floorIndex = order.indexOf(floor);
  if (baseIndex < 0 || floorIndex < 0) return base;
  return baseIndex >= floorIndex ? base : floor;
}

/** Harness chạy worker agent (mục 10). Không hard-code provider — lấy từ config (INV-07). */
export function harnessSpec(name: string): HarnessSpec | null {
  const { models } = loadConfig();
  return models.harness?.[name] ?? null;
}

export function harnessNames(): string[] {
  const { models } = loadConfig();
  return Object.keys(models.harness ?? {});
}

export interface SkillRoutingLimits {
  maxSkills: number;
  maxSkillTokens: number;
}

/** Ngân sách cho skill router (progressive disclosure — chỉ nạp skill liên quan). */
export function skillRoutingLimits(): SkillRoutingLimits {
  let context: Partial<SkillRoutingLimits> = {};
  try {
    context = (loadConfig().mcp.limits as { context?: Partial<SkillRoutingLimits> }).context ?? {};
  } catch {
    context = {};
  }
  return {
    maxSkills: context.maxSkills ?? 6,
    maxSkillTokens: context.maxSkillTokens ?? 2000,
  };
}

/** Cấu hình của một project trong config/projects.yaml. */
export function projectConfig(project?: string): { name: string; config: ProjectConfig } {
  const { projects } = loadConfig();
  const name = project ?? projects.defaultProject;
  const config = projects.projects[name];
  if (!config) {
    throw new EngError("CONFIG_INVALID", `Project "${name}" không có trong config/projects.yaml.`, {
      hint: `Project có sẵn: ${Object.keys(projects.projects).join(", ")}`,
    });
  }
  return { name, config };
}

/** repoRoot của project đích, đã resolve env/default. Không có ⇒ null (không đoán — INV-06). */
export function resolveRepoRoot(project?: string): string | null {
  const { config } = projectConfig(project);
  if (!config.repoRoot) return null;
  const fromEnv = config.repoRoot.env ? process.env[config.repoRoot.env] : undefined;
  const raw = fromEnv ?? config.repoRoot.default ?? null;
  if (!raw) return null;
  return raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) ? raw : `${OS_ROOT}/${raw}`;
}

/** Tóm tắt để `eng config` in ra và để phát hiện config hỏng sớm. */
export function configSummary(): Record<string, unknown> {
  const config = loadConfig();
  return {
    osRoot: OS_ROOT,
    defaultMode: config.gates.defaultMode,
    modes: Object.keys(config.gates.modes),
    gates: config.gates.gates.map((gate) => ({
      id: gate.id,
      type: gate.type,
      transition: gate.transition.join(" → "),
      required: gate.required,
    })),
    riskScale: config.risk.scale,
    modelTiers: config.models.tiers,
    agentModels: config.models.agents,
    mcpServers: Object.keys(config.mcp.servers),
    mcpGroups: Object.fromEntries(
      Object.entries(config.mcp.servers).map(([name, server]) => [name, Object.keys(server.groups ?? {})]),
    ),
    projects: Object.keys(config.projects.projects),
    defaultProject: config.projects.defaultProject,
    workstreamRoot: workstreamRoot(),
    protectedBranches: config.projects.protectedBranches,
  };
}
