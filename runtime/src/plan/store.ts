import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { EngError } from "../errors.js";
import { assertValid } from "../schemas/index.js";
import type { Plan, PlanTask, SubTaskStatus } from "../types.js";
import { atomicWrite, readJsonFile, readTextFileIfExists, workstreamDir } from "../workspace.js";
import { parsePlanMarkdown } from "./parser.js";
import { acquireLock, releaseLock } from "../state/lock.js";
import { applyPlanRepos } from "../repos.js";
import { attachWaves } from "../executor/waves.js";

export const PLAN_FILE = "plan.json";
export const PLAN_MARKDOWN = "plan.md";

export function planPath(taskId: string, root?: string): string {
  return path.join(workstreamDir(taskId, root), PLAN_FILE);
}

export function readPlan(taskId: string, root?: string): Plan | null {
  return readJsonFile<Plan>(planPath(taskId, root));
}

export function requirePlan(taskId: string, root?: string): Plan {
  const plan = readPlan(taskId, root);
  if (!plan) {
    throw new EngError("PLAN_NOT_FOUND", `Chưa có ${PLAN_FILE} cho ${taskId}.`, {
      hint: `Import plan trước: eng plan import ${taskId} --file plan.md`,
    });
  }
  return plan;
}

export function writePlan(plan: Plan, root?: string): string {
  assertValid("plan", plan, `plan của ${plan.taskId}`);
  const file = planPath(plan.taskId, root);
  acquireLock(plan.taskId, { ...(root !== undefined ? { root } : {}), command: "plan:write" });
  try {
    atomicWrite(file, `${JSON.stringify(plan, null, 2)}\n`);
  } finally {
    releaseLock(plan.taskId);
  }
  return file;
}

export function readPlanMarkdown(taskId: string, root?: string): string | null {
  const file = path.join(workstreamDir(taskId, root), PLAN_MARKDOWN);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export function setTaskStatus(plan: Plan, subTaskId: string, status: SubTaskStatus): Plan {
  const task = plan.tasks.find((item) => item.id === subTaskId);
  if (!task) {
    throw new EngError("SUBTASK_NOT_FOUND", `Plan của ${plan.taskId} không có ${subTaskId}.`, {
      hint: `Task có trong plan: ${plan.tasks.map((item) => item.id).join(", ")}`,
    });
  }
  task.status = status;
  return plan;
}

export function tasksByStatus(plan: Plan, status: SubTaskStatus): PlanTask[] {
  return plan.tasks.filter((task) => (task.status ?? "PENDING") === status);
}

export function planProgress(plan: Plan): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of plan.tasks) {
    const status = task.status ?? "PENDING";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

export interface ImportPlanResult {
  plan: Plan;
  taskCount: number;
  waves: number;
  warnings: string[];
  source: string;
  /** Repo của ticket sau khi import (repo chính trước — spec 9.4). */
  repos: string[];
}

/**
 * Import plan từ markdown: parse → gán repo → attach waves → validate schema → ghi plan.json.
 * Dùng chung cho `eng plan import` và phase `eng plan` (một implementation duy nhất).
 */
export function importPlanFromMarkdown(
  taskId: string,
  markdown: string,
  options: { root?: string; architectureRef?: string; source?: string; ticketProjects?: string[] } = {},
): ImportPlanResult {
  const parsed = parsePlanMarkdown(markdown);
  if (parsed.errors.length > 0) {
    throw new EngError("PLAN_PARSE_ERROR", `plan.md có ${parsed.errors.length} lỗi, chưa import.`, {
      hint: "Sửa theo thông báo bên dưới rồi import lại. Mỗi task cần Objective, Acceptance Criteria (>=1) và Verification (>=1).",
      details: { errors: parsed.errors },
    });
  }

  const base: Plan = {
    schemaVersion: 1,
    taskId,
    generatedAt: new Date().toISOString(),
    tasks: parsed.tasks,
    ...(options.source ? { source: options.source } : {}),
    ...(options.architectureRef ? { architectureRef: options.architectureRef } : {}),
  };

  // Multi-repo: gán repo chính cho task không khai, và từ chối repo lạ (INV-06).
  const applied = applyPlanRepos(base, options.ticketProjects ?? []);
  if (applied.errors.length > 0) {
    throw new EngError("INVALID_REPO", `plan.md khai repo không hợp lệ (${applied.errors.length} lỗi), chưa import.`, {
      hint: "Khai project có thật trong config/projects.yaml ở mục '### Repo', hoặc bỏ trống để dùng repo chính của ticket.",
      details: { errors: applied.errors },
    });
  }

  const { plan, execution } = attachWaves(base);
  writePlan(plan, options.root);
  const dir = workstreamDir(taskId, options.root);
  atomicWrite(path.join(dir, PLAN_MARKDOWN), markdown);

  return {
    plan,
    taskCount: plan.tasks.length,
    waves: execution.waves.length,
    warnings: [...parsed.warnings, ...applied.warnings],
    source: options.source ?? PLAN_MARKDOWN,
    repos: applied.repos,
  };
}

export function planMarkdownExists(taskId: string, root?: string): boolean {
  return readTextFileIfExists(path.join(workstreamDir(taskId, root), PLAN_MARKDOWN)) !== null;
}
