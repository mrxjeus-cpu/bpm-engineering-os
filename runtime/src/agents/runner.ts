import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  type HarnessSpec,
  harnessNames,
  harnessSpec,
  resolveRepoRoot,
  skillRoutingLimits,
} from "../config/index.js";
import { GLOBAL_CONSTRAINTS } from "../context/compiler.js";
import { phaseForStatus } from "../state/machine.js";
import type { TaskStatus } from "../types.js";
import type { TaskContext } from "../context/types.js";
import { EngError } from "../errors.js";
import { EventBus } from "../events/bus.js";
import { OS_ROOT, osPath } from "../paths.js";
import { resolveModelDecision } from "../router/model.js";
import { loadSkills, type SkillCatalog } from "../skills/loader.js";
import { renderSkillsSection, routeSkills, type SkillSelection } from "../skills/router.js";
import { estimatePromptTokens, renderAgentPrompt, type PromptInputRef, type PromptTemplateRef } from "./prompt.js";
import { type AgentContract, agentContract, fillPath } from "./registry.js";
import { atomicWrite, readJsonFile, readTextFileIfExists, workstreamDir, relPath } from "../workspace.js";

const execFileAsync = promisify(execFile);

/** Harness có sẵn trong code (không cần config) — dùng để dry run/kiểm thử luồng. */
const BUILTIN_HARNESSES: Record<string, HarnessSpec> = {
  dry: {
    enabled: true,
    description: "Built-in dry run: in đường dẫn prompt, không gọi LLM",
    command: ["node", "-e", "console.log('DRY RUN — prompt:', process.env.ENG_PROMPT_FILE)"],
    cwd: "{osRoot}",
    timeoutMs: 60_000,
  },
};

export interface AgentRunOptions {
  taskId: string;
  role: string;
  subTaskId?: string;
  project?: string;
  /** Tên harness trong config/models.yaml (hoặc "dry"). Bỏ trống ⇒ dùng harness.default nếu enabled. */
  harness?: string;
  /** Chỉ render prompt, không chạy worker. */
  dryRun?: boolean;
  root?: string;
  extraInstructions?: string;
  /** Tắt chọn skill (dùng khi cần prompt tối giản). */
  noSkills?: boolean;
  /** Ghi đè repoRoot cho lần chạy này (dùng khi chạy trong git worktree cô lập). */
  repoRoot?: string;
  /** Token lock của tiến trình cha — worker ghi cùng workstream mà không tự khoá lẫn nhau. */
  lockToken?: string;
}

/**
 * Usage do harness báo lại (nếu có). Runtime KHÔNG tự đo token của provider —
 * harness ghi file mà `ENG_USAGE_FILE` trỏ tới, dạng:
 *   { "inputTokens": 1200, "outputTokens": 340, "totalTokens": 1540, "source": "cli-json" }
 * Không có file ⇒ usage = null và `eng metrics` sẽ nói rõ là chưa đo được (INV-12).
 */
export interface HarnessUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  source?: string;
}

export interface AgentRunResult {
  ok: boolean;
  role: string;
  taskId: string;
  subTaskId?: string;
  tier: string;
  model: string;
  complexity: string;
  tierReason: string;
  harness: string;
  command?: string[];
  cwd?: string;
  contextPath?: string;
  promptPath: string;
  promptTokens: number;
  exitCode?: number;
  durationMs: number;
  logPath?: string;
  stdoutTail?: string;
  stderrTail?: string;
  artifactsPresent: string[];
  artifactsMissing: string[];
  skills: Array<{ name: string; file: string; reasons: string[] }>;
  skillTokens: number;
  templates: string[];
  warnings: string[];
  dryRun: boolean;
  /** Chỉ số token harness báo lại — null nếu harness không báo. */
  usage: HarnessUsage | null;
}

function stripFrontMatter(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
}

function loadTemplate(name: string): PromptTemplateRef | null {
  const rel = relPath("templates", name);
  const text = readTextFileIfExists(osPath(rel));
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  const content = lines.length <= 80 ? text : `${lines.slice(0, 80).join("\n")}\n<!-- ... cắt bớt ... -->`;
  return { name, path: rel, content };
}

function readAgentInstructions(role: string): string | undefined {
  const file = osPath("agents", `${role}.md`);
  const text = readTextFileIfExists(file);
  if (text === null) return undefined;
  const body = stripFrontMatter(text).trim();
  return body === "" ? undefined : body;
}

function resolveHarness(name?: string): { name: string; spec: HarnessSpec } {
  if (name !== undefined) {
    const spec = harnessSpec(name) ?? BUILTIN_HARNESSES[name] ?? null;
    if (!spec) {
      throw new EngError("HARNESS_UNKNOWN", `Không có harness "${name}".`, {
        hint: `Harness có trong config/models.yaml: ${harnessNames().join(", ") || "(trống)"} · built-in: ${Object.keys(BUILTIN_HARNESSES).join(", ")}`,
      });
    }
    return { name, spec };
  }

  const fallback = harnessSpec("default");
  if (fallback?.enabled) return { name: "default", spec: fallback };

  throw new EngError("HARNESS_NOT_CONFIGURED", "Chưa cấu hình agent harness để chạy worker.", {
    hint:
      "Bật harness trong config/models.yaml (harness.default.enabled = true, sửa command cho đúng môi trường) " +
      "hoặc chạy `--harness dry` để kiểm tra prompt mà không gọi LLM (INV-07: runtime không hard-code provider).",
  });
}

function substitute(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) out = out.replaceAll(`{${key}}`, value);
  return out;
}

/** Đọc usage do harness báo; chỉ nhận số nguyên không âm, ngược lại coi như không có. */
export function readUsage(file: string): HarnessUsage | null {
  const raw = readJsonFile<Record<string, unknown>>(file);
  if (raw === null) return null;
  const pick = (key: string): number | undefined => {
    const value = raw[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
  };
  const usage: HarnessUsage = {};
  const input = pick("inputTokens");
  const output = pick("outputTokens");
  const total = pick("totalTokens");
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (total !== undefined) usage.totalTokens = total;
  if (typeof raw["source"] === "string") usage.source = raw["source"];
  return Object.keys(usage).length === 0 ? null : usage;
}

function tail(text: string, max = 2000): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

/**
 * AgentRunner (spec mục 10, 17): build prompt contract → chạy worker qua harness đã cấu hình
 * → kiểm tra artifact THẬT SỰ được tạo (không tin lời agent) → trả kết quả + log.
 */
export class AgentRunner {
  readonly #root?: string;
  readonly #project?: string;
  readonly #bus: EventBus;

  constructor(options: { root?: string; project?: string; bus?: EventBus } = {}) {
    if (options.root !== undefined) this.#root = options.root;
    if (options.project !== undefined) this.#project = options.project;
    this.#bus = options.bus ?? new EventBus(options.root === undefined ? {} : { root: options.root });
  }

  workstream(taskId: string): string {
    return workstreamDir(taskId, this.#root);
  }

  readContext(taskId: string, subTaskId?: string): TaskContext | null {
    if (!subTaskId) return null;
    return readJsonFile<TaskContext>(path.join(this.workstream(taskId), "context", `${subTaskId}.json`));
  }

  buildPrompt(options: AgentRunOptions): {
    contract: AgentContract;
    prompt: string;
    promptPath: string;
    contextPath?: string;
    decision: ReturnType<typeof resolveModelDecision>;
    artifactsMissing: string[];
    inputs: PromptInputRef[];
    selected: SkillSelection[];
    skillTokens: number;
    skillTruncated: boolean;
    skillRequiredDropped: string[];
    skillTokenLimited: boolean;
    templates: PromptTemplateRef[];
  } {
    const contract = agentContract(options.role);
    const context = this.readContext(options.taskId, options.subTaskId);

    if (contract.requiresContext && context === null) {
      throw new EngError("CONTEXT_REQUIRED", `Agent ${contract.role} cần context của ${options.subTaskId ?? "(chưa có sub-task)"} nhưng chưa compile.`, {
        hint: `Chạy trước: eng context ${options.taskId} ${options.subTaskId ?? "<TASK-NN>"} — không truyền cả plan/repo cho worker (INV-01).`,
      });
    }

    const inputs: PromptInputRef[] = contract.inputs.map((input) => {
      const rel = fillPath(input.path, { taskId: options.taskId, ...(options.subTaskId ? { subTaskId: options.subTaskId } : {}) });
      const absolute = path.join(this.workstream(options.taskId), rel);
      const present = existsSync(absolute);
      return {
        path: rel,
        description: input.description,
        present,
        ...(input.optional === true ? { optional: true } : {}),
      };
    });

    const decision = resolveModelDecision({
      role: contract.role,
      risk: this.#risk(options.taskId),
      files: context?.files?.length ?? 0,
      dependencies: context?.dependencies?.length ?? 0,
      ...(context?.budget?.tokenEstimate !== undefined ? { contextTokens: context.budget.tokenEstimate } : {}),
    });

    const objective =
      context?.objective ?? this.#planObjective(options.taskId, options.subTaskId) ?? this.#stateTitle(options.taskId) ?? "";
    const constraints = context?.constraints ?? GLOBAL_CONSTRAINTS;
    const verification = context?.verificationCriteria ?? [];
    const acceptanceCriteriaCount = context?.acceptanceCriteria?.length ?? 0;

    const instructions = options.extraInstructions ?? readAgentInstructions(contract.role);

    // Skill router: chọn skill theo role + phase (từ status task) + từ khoá trong objective.
    const status = this.#status(options.taskId);
    const routing = skillRoutingLimits();
    let selected: SkillSelection[] = [];
    let skillTokens = 0;
    let skillTruncated = false;
    let skillRequiredDropped: string[] = [];
    let skillTokenLimited = false;
    if (options.noSkills !== true) {
      const route = routeSkills({
        role: contract.role,
        ...(status ? { phase: phaseForStatus(status) } : {}),
        objective,
        maxSkills: routing.maxSkills,
        maxTokens: routing.maxSkillTokens,
      });
      selected = route.selected;
      skillTokens = route.tokens;
      skillTruncated = route.truncated;
      skillRequiredDropped = route.requiredDropped;
      skillTokenLimited = route.tokenLimited;
    }

    const templates = (contract.templates ?? [])
      .map((name) => loadTemplate(name))
      .filter((template): template is PromptTemplateRef => template !== null);

    const prompt = renderAgentPrompt({
      contract,
      taskId: options.taskId,
      ...(options.subTaskId ? { subTaskId: options.subTaskId } : {}),
      objective,
      constraints,
      verification,
      acceptanceCriteriaCount,
      ...(options.subTaskId ? { contextPath: `context/${options.subTaskId}.md` } : {}),
      inputs,
      tier: decision.tier,
      tierReason: decision.reason,
      ...(instructions ? { extraInstructions: instructions } : {}),
      ...(selected.length > 0
        ? { skills: selected.map((entry) => ({ name: entry.skill.name, file: entry.skill.file, reasons: entry.reasons, body: entry.skill.body })) }
        : {}),
      ...(templates.length > 0 ? { templates } : {}),
    });

    const promptRel = relPath("tasks", `${contract.role}-${options.subTaskId ?? options.taskId}.prompt.md`);
    atomicWrite(path.join(this.workstream(options.taskId), promptRel), prompt);

    const outputs = contract.outputs.map((output) =>
      fillPath(output, { taskId: options.taskId, ...(options.subTaskId ? { subTaskId: options.subTaskId } : {}) }),
    );
    const artifactsMissing = outputs.filter((rel) => readTextFileIfExists(path.join(this.workstream(options.taskId), rel)) === null);

    return {
      contract,
      prompt,
      promptPath: promptRel,
      ...(options.subTaskId ? { contextPath: `context/${options.subTaskId}.md` } : {}),
      decision,
      artifactsMissing,
      inputs,
      selected,
      skillTokens,
      skillTruncated,
      skillRequiredDropped,
      skillTokenLimited,
      templates,
    };
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const built = this.buildPrompt(options);
    const warnings: string[] = [];
    if (built.skillRequiredDropped.length > 0) {
      warnings.push(
        `Skill BẮT BUỘC bị cắt khỏi prompt: ${built.skillRequiredDropped.join(", ")} — tăng limits.context.maxSkillTokens hoặc maxSkills trong config/mcp.yaml.`,
      );
    } else if (built.skillTokenLimited) {
      warnings.push("Context: skill router phải bỏ vài skill phụ để vừa budget token (config/mcp.yaml → limits.context.maxSkillTokens).");
    }
    const harness = options.dryRun === true
      ? { name: "dry", spec: harnessSpec("dry") ?? (BUILTIN_HARNESSES["dry"] as HarnessSpec) }
      : resolveHarness(options.harness);

    const repoRoot = options.repoRoot ?? resolveRepoRoot(options.project ?? this.#project);
    if (repoRoot === null && (harness.spec.cwd ?? "").includes("{repoRoot}")) {
      throw new EngError("REPO_ROOT_NOT_CONFIGURED", "Harness cần repoRoot của project nhưng chưa cấu hình.", {
        hint: "Set env repoRoot (config/projects.yaml) trước khi chạy worker trên repo thật — không đoán đường dẫn (INV-06).",
      });
    }

    const vars: Record<string, string> = {
      prompt: path.join(this.workstream(options.taskId), built.promptPath),
      repoRoot: repoRoot ?? OS_ROOT,
      osRoot: OS_ROOT,
      taskId: options.taskId,
      subTaskId: options.subTaskId ?? "",
    };

    const base: AgentRunResult = {
      ok: true,
      role: built.contract.role,
      taskId: options.taskId,
      ...(options.subTaskId ? { subTaskId: options.subTaskId } : {}),
      tier: built.decision.tier,
      model: built.decision.model,
      complexity: built.decision.complexity,
      tierReason: built.decision.reason,
      harness: harness.name,
      promptPath: built.promptPath,
      promptTokens: estimatePromptTokens(built.prompt),
      ...(built.contextPath ? { contextPath: built.contextPath } : {}),
      durationMs: 0,
      artifactsPresent: [],
      artifactsMissing: built.artifactsMissing,
      skills: built.selected.map((entry) => ({ name: entry.skill.name, file: entry.skill.file, reasons: entry.reasons })),
      skillTokens: built.skillTokens,
      templates: built.templates.map((template) => template.path),
      warnings,
      dryRun: options.dryRun === true,
      usage: null,
    };

    if (options.dryRun === true) {
      warnings.push("Dry run: chưa chạy worker, chỉ render prompt contract.");
      return base;
    }

    const command = harness.spec.command.map((arg) => substitute(arg, vars));
    const cwd = substitute(harness.spec.cwd ?? "{osRoot}", vars);
    const timeoutMs = harness.spec.timeoutMs ?? 1_800_000;
    const usageFile = path.join(this.workstream(options.taskId), "tasks", `${built.contract.role}-${options.subTaskId ?? options.taskId}.usage.json`);
    const started = Date.now();

    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      const result = await execFileAsync(command[0] as string, command.slice(1), {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          ENG_PROMPT_FILE: vars["prompt"] as string,
          ENG_TASK_ID: options.taskId,
          ENG_SUBTASK_ID: options.subTaskId ?? "",
          ENG_CONTEXT_FILE: built.contextPath ? path.join(this.workstream(options.taskId), built.contextPath) : "",
          ENG_ROLE: built.contract.role,
          ENG_MODEL_TIER: built.decision.tier,
          ENG_WORKSTREAM: this.workstream(options.taskId),
          ENG_OS_ROOT: OS_ROOT,
          ENG_REPO_ROOT: repoRoot ?? "",
          ENG_USAGE_FILE: usageFile,
          ...(options.lockToken ? { ENG_WORKSTREAM_LOCK_TOKEN: options.lockToken } : {}),
        },
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const failure = error as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; message: string };
      exitCode = typeof failure.code === "number" ? failure.code : 1;
      stdout = typeof failure.stdout === "string" ? failure.stdout : "";
      stderr = typeof failure.stderr === "string" ? failure.stderr : failure.message;
      if (failure.killed === true) warnings.push(`Harness bị dừng do quá ${timeoutMs}ms.`);
    }

    const durationMs = Date.now() - started;
    const logRel = relPath("tasks", `${built.contract.role}-${options.subTaskId ?? options.taskId}.log`);
    atomicWrite(
      path.join(this.workstream(options.taskId), logRel),
      `$ ${command.join(" ")}\n# cwd: ${cwd}\n# exit: ${exitCode}\n# duration: ${durationMs}ms\n\n--- stdout ---\n${stdout}\n\n--- stderr ---\n${stderr}\n`,
    );

    const outputs = built.contract.outputs.map((output) =>
      fillPath(output, { taskId: options.taskId, ...(options.subTaskId ? { subTaskId: options.subTaskId } : {}) }),
    );
    const artifactsPresent = outputs.filter(
      (rel) => readTextFileIfExists(path.join(this.workstream(options.taskId), rel)) !== null,
    );
    const artifactsMissing = outputs.filter((rel) => !artifactsPresent.includes(rel));

    if (exitCode !== 0) {
      base.ok = false;
      warnings.push(`Harness trả exit code ${exitCode} — xem log: ${logRel}`);
    }
    if (artifactsMissing.length > 0) {
      warnings.push(
        `Worker kết thúc nhưng THIẾU artifact bắt buộc: ${artifactsMissing.join(", ")} — không coi là hoàn thành (RULES-001).`,
      );
    }

    // Không cảnh báo khi harness không báo usage: đó là mặc định của phần lớn CLI, và cảnh báo
    // lặp mỗi lần chạy sẽ làm loãng các cảnh báo thật. `eng metrics` nói rõ phần nào chưa đo được.
    const usage = readUsage(usageFile);

    // Event cho consumer ngoài (dashboard/audit) và cho `eng metrics`: model tier THẬT ĐÃ DÙNG,
    // thời gian chạy, usage nếu harness báo. Không chứa nội dung prompt/context (chỉ tham chiếu).
    this.#bus.emit({
      taskId: options.taskId,
      type: "AgentRun",
      subTaskId: options.subTaskId ?? null,
      actor: `agent:${built.contract.role}`,
      evidenceRef: null,
      payload: {
        role: built.contract.role,
        modelTier: built.decision.tier,
        model: built.decision.model,
        tierReason: built.decision.reason,
        harness: harness.name,
        ok: exitCode === 0 && artifactsMissing.length === 0,
        exitCode,
        durationMs,
        promptTokensEstimate: base.promptTokens,
        artifactsMissing,
        logRef: logRel,
        usage,
      },
    });

    return {
      ...base,
      exitCode,
      durationMs,
      logPath: logRel,
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr),
      artifactsPresent,
      artifactsMissing,
      usage,
    };
  }

  #status(taskId: string): TaskStatus | null {
    const state = readJsonFile<{ status?: string }>(path.join(this.workstream(taskId), "task.json"));
    const status = state?.status;
    return typeof status === "string" ? (status as TaskStatus) : null;
  }

  #risk(taskId: string): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
    const state = readJsonFile<{ risk?: string }>(path.join(this.workstream(taskId), "task.json"));
    const risk = state?.risk;
    return risk === "LOW" || risk === "MEDIUM" || risk === "HIGH" || risk === "CRITICAL" ? risk : "MEDIUM";
  }

  #planObjective(taskId: string, subTaskId?: string): string | null {
    if (!subTaskId) return null;
    const plan = readJsonFile<{ tasks?: Array<{ id: string; objective: string }> }>(
      path.join(this.workstream(taskId), "plan.json"),
    );
    return plan?.tasks?.find((task) => task.id === subTaskId)?.objective ?? null;
  }

  #stateTitle(taskId: string): string | null {
    const state = readJsonFile<{ title?: string }>(path.join(this.workstream(taskId), "task.json"));
    return state?.title ?? null;
  }
}
