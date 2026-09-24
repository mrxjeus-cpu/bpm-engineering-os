import path from "node:path";
import { loadConfig } from "../config/index.js";
import { EngError } from "../errors.js";
import { requirePlan } from "../plan/store.js";
import { assertValid } from "../schemas/index.js";
import type { PlanTask } from "../types.js";
import { atomicWrite, readTextFileIfExists, workstreamDir, relPath } from "../workspace.js";
import { createProviders, type ContextProviders } from "./providers.js";
import {
  DEFAULT_CONTEXT_LIMITS,
  type ContextBusinessRule,
  type ContextLimits,
  type ContextSymbol,
  type TaskContext,
} from "./types.js";

export interface CompileOptions {
  taskId: string;
  subTaskId: string;
  project?: string;
  providers?: ContextProviders;
  limits?: Partial<ContextLimits>;
  root?: string;
  /** false ⇒ chỉ trả kết quả, không ghi file (dùng cho test). */
  write?: boolean;
}

export interface CompiledContext {
  context: TaskContext;
  markdown: string;
  warnings: string[];
  jsonPath: string | null;
  markdownPath: string | null;
  tokenEstimate: number;
  truncated: boolean;
}

const CONSTRAINT_HINT =
  /(must|must not|do not|shall|required|constraint|rule|forbidden|never|always|only|bắt buộc|không được|phải|nguyên tắc|quy tắc)/i;

/** Ràng buộc GLOBAL — luôn có mặt, nên context không bao giờ rỗng phần constraints. */
export const GLOBAL_CONSTRAINTS = [
  "Không xóa hoặc đổi business logic ngoài scope task (INV-04).",
  "Không sửa file ngoài danh sách Files của task này.",
  "Không tự thay đổi architecture decision đã được approve.",
];

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function limitsFromConfig(override?: Partial<ContextLimits>): ContextLimits {
  let configured: Partial<ContextLimits> = {};
  try {
    const config = loadConfig();
    configured = (config.mcp.limits as { context?: Partial<ContextLimits> }).context ?? {};
  } catch {
    configured = {};
  }
  return { ...DEFAULT_CONTEXT_LIMITS, ...configured, ...(override ?? {}) };
}

function capLines(text: string | undefined, maxLines: number): string | undefined {
  if (text === undefined) return undefined;
  const lines = text.split(/\r?\n/);
  return lines.length <= maxLines ? text : `${lines.slice(0, maxLines).join("\n")}\n// ... (đã cắt ${lines.length - maxLines} dòng)`;
}

function shrinkSnippet(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const lines = text.split(/\r?\n/);
  if (lines.length <= 3) return undefined;
  return `${lines.slice(0, Math.max(1, Math.floor(lines.length / 2))).join("\n")}\n// ... (cắt để vừa budget)`;
}

function constraintsFromArchitecture(taskId: string, root: string | undefined, max: number): string[] {
  const markdown = readTextFileIfExists(path.join(workstreamDir(taskId, root), "architecture.md"));
  if (!markdown) return [];
  const out: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const text = line.trim().replace(/^[-*]\s*/, "");
    if (text === "" || !CONSTRAINT_HINT.test(text)) continue;
    out.push(text.slice(0, 300));
    if (out.length >= max) break;
  }
  return out;
}

function policyIdsFrom(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/\bPOLICY-[A-Z0-9-]+\b/g)) ids.add(match[0]);
  return [...ids];
}

export function renderContextMarkdown(context: TaskContext): string {
  const lines: string[] = [];
  lines.push(`# Context — ${context.taskId} / ${context.subTaskId}`);
  lines.push("");
  lines.push("## Objective");
  lines.push(context.objective);
  lines.push("");

  if (context.files && context.files.length > 0) {
    lines.push("## Files");
    for (const file of context.files) lines.push(`- ${file}`);
    lines.push("");
  }

  if (context.symbols && context.symbols.length > 0) {
    lines.push("## Symbols (đã cắt — không dump cả file)");
    for (const symbol of context.symbols) {
      lines.push(`### ${symbol.name} — ${symbol.file}${symbol.lines ? `:${symbol.lines}` : ""}`);
      if (symbol.reason) lines.push(`_${symbol.reason}_`);
      lines.push("");
      if (symbol.snippet) {
        lines.push("```");
        lines.push(symbol.snippet);
        lines.push("```");
        lines.push("");
      }
    }
  }

  lines.push("## Existing Pattern");
  lines.push(context.existingPattern ?? "_Chưa xác định được — phải tìm pattern có sẵn trước khi tạo abstraction mới._");
  lines.push("");

  if (context.businessRules && context.businessRules.length > 0) {
    lines.push("## Business Rules");
    for (const rule of context.businessRules) {
      lines.push(`- **${rule.id}**: ${rule.statement}`);
      lines.push(`  - nguồn: ${rule.source}${rule.confidence !== undefined ? ` (confidence ${rule.confidence})` : ""}`);
    }
    lines.push("");
  }

  lines.push("## Constraints");
  for (const constraint of context.constraints) lines.push(`- ${constraint}`);
  lines.push("");

  if (context.tests && context.tests.length > 0) {
    lines.push("## Tests");
    for (const test of context.tests) lines.push(`- ${test}`);
    lines.push("");
  }

  lines.push("## Acceptance Criteria");
  context.acceptanceCriteria.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  lines.push("");

  lines.push("## Verification Criteria");
  context.verificationCriteria.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  lines.push("");

  if (context.unknowns && context.unknowns.length > 0) {
    lines.push("## Unknowns (KHÔNG được đoán — báo BLOCKED nếu cần)");
    for (const unknown of context.unknowns) lines.push(`- ${unknown}`);
    lines.push("");
  }

  const provenance = context.provenance;
  lines.push("## Provenance");
  lines.push(`- generated: ${provenance.generatedAt} bởi ${provenance.generatedBy}`);
  if (provenance.gitSha) lines.push(`- git SHA: ${provenance.gitSha}`);
  if (provenance.planRef) lines.push(`- plan: ${provenance.planRef}`);
  if (provenance.architectureRef) lines.push(`- architecture: ${provenance.architectureRef}`);
  if (provenance.mcpQueries && provenance.mcpQueries.length > 0) {
    lines.push(`- MCP: ${provenance.mcpQueries.map((query) => `${query.server}.${query.tool}`).join(", ")}`);
  }
  if (context.budget) {
    lines.push(
      `- budget: ~${context.budget.tokenEstimate ?? "?"} token (trần ${context.budget.maxTokenBudget ?? "?"})` +
        `${context.budget.truncated ? " — ĐÃ CẮT bớt để vừa budget" : ""}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * ContextCompiler (spec mục 7.3): plan + MCP + workstream → context package tối thiểu.
 *
 * Nguyên tắc: chỉ lấy symbol quanh task, cắt theo budget, và ghi lại provenance.
 * Không truyền toàn bộ plan/repo cho worker (INV-01).
 */
export async function compileTaskContext(options: CompileOptions): Promise<CompiledContext> {
  const limits = limitsFromConfig(options.limits);
  const warnings: string[] = [];

  const plan = requirePlan(options.taskId, options.root);
  const task = plan.tasks.find((item) => item.id === options.subTaskId);
  if (!task) {
    throw new EngError("SUBTASK_NOT_FOUND", `Plan của ${options.taskId} không có ${options.subTaskId}.`, {
      hint: `Task có trong plan: ${plan.tasks.map((item) => item.id).join(", ")}`,
    });
  }

  const providers = options.providers ?? createProviders({ project: options.project, limits });
  const ownsProviders = options.providers === undefined;

  try {
    const taskText = [task.objective, ...(task.businessRules ?? []), ...(task.files ?? []), task.title].join("\n");
    const gathering = await providers.gather({
      taskId: options.taskId,
      subTaskId: options.subTaskId,
      objective: task.objective,
      files: [...(task.files ?? [])],
      symbols: [...(task.symbols ?? [])],
      tests: [...(task.tests ?? [])],
      policyIds: policyIdsFrom(taskText),
      ...(options.project ? { project: options.project } : {}),
    });

    const files = [...new Set([...(task.files ?? []), ...gathering.files])];
    const tests = [...new Set([...(task.tests ?? []), ...gathering.tests])].slice(0, 20);

    const businessRules: ContextBusinessRule[] = [
      ...(task.businessRules ?? []).map((statement, index) => ({
        id: `PLAN-${String(index + 1).padStart(2, "0")}`,
        statement,
        source: `plan.md#${task.id}`,
        confidence: 1,
      })),
      ...gathering.businessRules,
    ];

    const constraints = [
      ...GLOBAL_CONSTRAINTS,
      // ràng buộc khai báo trong plan
      ...(task.constraints ?? []),
      // ràng buộc trích từ architecture.md của workstream
      ...constraintsFromArchitecture(options.taskId, options.root, limits.maxArchitectureConstraints),
      // ràng buộc trích từ tài liệu kiến trúc của repo (qua mcp-engineering)
      ...gathering.architectureConstraints,
    ];
    const uniqueConstraints = [...new Set(constraints)];

    const unknowns = [...gathering.unknowns];
    if ((task.existingPattern ?? null) === null && gathering.existingPattern === null) {
      unknowns.push(
        "Chưa xác định pattern có sẵn cho thay đổi này — skill existing-code-first yêu cầu tìm trước khi tạo abstraction mới.",
      );
    }
    if (task.files === undefined || task.files.length === 0) {
      unknowns.push("Plan không khai báo Files — không giới hạn được scope thay đổi.");
    }

    let symbols: ContextSymbol[] = gathering.symbols.map((symbol) => {
      const capped: ContextSymbol = { ...symbol };
      const snippet = capLines(symbol.snippet, limits.maxSnippetLines);
      if (snippet !== undefined) capped.snippet = snippet;
      return capped;
    });

    const base: Omit<TaskContext, "budget"> = {
      schemaVersion: 1,
      taskId: options.taskId,
      subTaskId: options.subTaskId,
      objective: task.objective,
      files,
      symbols,
      existingPattern: task.existingPattern ?? gathering.existingPattern,
      businessRules,
      constraints: uniqueConstraints,
      tests,
      acceptanceCriteria: task.acceptanceCriteria,
      verificationCriteria: task.verification,
      dependencies: task.dependencies,
      unknowns,
      provenance: {
        generatedAt: new Date().toISOString(),
        generatedBy: `runtime:${providers.name}`,
        ...(gathering.mcpQueries.length > 0 ? { mcpQueries: gathering.mcpQueries } : {}),
        planRef: `plan.json#${task.id}`,
        ...(readTextFileIfExists(path.join(workstreamDir(options.taskId, options.root), "architecture.md"))
          ? { architectureRef: "architecture.md" }
          : {}),
      },
    };

    // Vòng cắt theo budget: rút snippet dần cho tới khi vừa trần token.
    let truncated = false;
    let markdown = "";
    let tokenEstimate = 0;

    const render = (): void => {
      const context: TaskContext = {
        ...base,
        symbols,
        budget: { maxTokenBudget: limits.maxTokens, tokenEstimate, truncated },
      };
      markdown = renderContextMarkdown(context);
      tokenEstimate = estimateTokens(markdown);
    };

    render();
    let guard = 0;
    while (tokenEstimate > limits.maxTokens && guard < 12) {
      const shrunk = symbols.map((symbol) => {
        const snippet = shrinkSnippet(symbol.snippet);
        const next: ContextSymbol = { ...symbol };
        if (snippet === undefined) delete next.snippet;
        else next.snippet = snippet;
        return next;
      });
      const changed = shrunk.some((symbol, index) => symbol.snippet !== symbols[index]?.snippet);
      if (!changed) {
        if (symbols.length > 0) {
          symbols = symbols.map((symbol) => {
            const withoutSnippet: ContextSymbol = { name: symbol.name, file: symbol.file, reason: symbol.reason ?? "chỉ giữ vị trí" };
            if (symbol.lines !== undefined) withoutSnippet.lines = symbol.lines;
            return withoutSnippet;
          });
          warnings.push("Context vượt budget: đã bỏ toàn bộ snippet, chỉ giữ vị trí symbol.");
        }
        break;
      }
      symbols = shrunk;
      truncated = true;
      guard += 1;
      render();
    }

    render();
    const context: TaskContext = {
      ...base,
      symbols,
      budget: { maxTokenBudget: limits.maxTokens, tokenEstimate, truncated },
    };

    if (gathering.similarCode.length > 0) {
      warnings.push(
        `Code tương tự (tham khảo, heuristic): ${gathering.similarCode
          .slice(0, limits.maxSimilar)
          .map((item) => `${item.file} (score ${item.score})`)
          .join(", ")}`,
      );
    }
    if (gathering.callers.length > 0) {
      warnings.push(`Callers (heuristic) được dùng cho impact: ${gathering.callers.length} vị trí.`);
    }
    if (gathering.unavailable.length > 0) {
      warnings.push(`MCP không dùng được: ${gathering.unavailable.join("; ")}`);
    }

    assertValid("context", context, `context ${options.subTaskId} của ${options.taskId}`);

    let jsonPath: string | null = null;
    let markdownPath: string | null = null;
    if (options.write !== false) {
      const dir = workstreamDir(options.taskId, options.root);
      const jsonRel = relPath("context", `${options.subTaskId}.json`);
      const markdownRel = relPath("context", `${options.subTaskId}.md`);
      atomicWrite(path.join(dir, jsonRel), `${JSON.stringify(context, null, 2)}\n`);
      atomicWrite(path.join(dir, markdownRel), markdown);
      jsonPath = jsonRel;
      markdownPath = markdownRel;
    }

    return { context, markdown, warnings, jsonPath, markdownPath, tokenEstimate, truncated };
  } finally {
    if (ownsProviders) providers.close();
  }
}

export function contextPath(taskId: string, subTaskId: string, root?: string, extension: "json" | "md" = "json"): string {
  return path.join(workstreamDir(taskId, root), "context", `${subTaskId}.${extension}`);
}

export type { PlanTask };
