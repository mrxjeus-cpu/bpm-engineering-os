import { loadConfig, projectNames } from "./config/index.js";
import type { Plan, PlanTask, TaskState } from "./types.js";

export { projectNames };

/**
 * Multi-repo (spec mục 9.4).
 *
 * Một ticket có thể sửa nhiều repo nằm ở các thư mục cha khác nhau. Quy ước:
 *   - `task.json.projects[]`  : repo của ticket, phần tử ĐẦU là repo chính.
 *   - `plan.json.tasks[].repo`: repo của từng task (`### Repo` trong plan.md).
 *   - Mọi repo là một project trong `config/projects.yaml` (repoRoot lấy từ env ⇒ vị trí
 *     thư mục không quan trọng — không hard-code đường dẫn máy).
 *
 * Nguyên tắc tương thích: KHÔNG tự gán repo khi ticket/task không khai. Ticket một repo
 * không khai gì vẫn chạy y như trước — project lấy từ `--project` hoặc `defaultProject`.
 */

export function isKnownProject(name: string): boolean {
  return projectNames().includes(name);
}

function knownProjectsHint(): string {
  return `Project có trong config/projects.yaml: ${projectNames().join(", ")}`;
}

/** Bỏ tên rỗng và trùng, giữ thứ tự khai. */
export function declaredProjects(projects?: string[] | null): string[] {
  const out: string[] = [];
  for (const name of projects ?? []) {
    if (name !== "" && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Repo chính của ticket: projects[0], nếu không khai thì `defaultProject`. */
export function primaryProject(projects?: string[] | null): string {
  return declaredProjects(projects)[0] ?? loadConfig().projects.defaultProject;
}

/** Repo hiệu lực của một task: task.repo nếu khai, ngược lại là repo truyền vào (có thể undefined). */
export function repoForTask(task: PlanTask | undefined, fallback?: string): string | undefined {
  const declared = task?.repo;
  return declared !== undefined && declared !== "" ? declared : fallback;
}

/**
 * Repo của ticket: repo đã khai trong state trước, rồi tới repo chỉ xuất hiện trong plan.
 * Trả về [] khi không có gì được khai — caller tự quyết định fallback (thường là `--project`).
 */
export function reposForTicket(projects: string[] | undefined, plan?: Plan | null): string[] {
  const out = declaredProjects(projects);
  for (const task of plan?.tasks ?? []) {
    const repo = task.repo;
    if (repo !== undefined && repo !== "" && !out.includes(repo)) out.push(repo);
  }
  return out;
}

export function reposForState(state: Pick<TaskState, "projects"> | null | undefined, plan?: Plan | null): string[] {
  return reposForTicket(state?.projects, plan);
}

export interface ApplyPlanReposResult {
  /** Repo theo thứ tự: repo của ticket trước, rồi repo khai trong plan. */
  repos: string[];
  errors: string[];
  warnings: string[];
}

/**
 * Gán repo chính cho task khai thiếu và kiểm tên repo có thật trong config (INV-06: không đoán).
 * Thuần dữ liệu — KHÔNG ghi file, dùng chung cho `eng plan import` và phase `eng plan`.
 */
export function applyPlanRepos(plan: Plan, ticketProjects: string[] = []): ApplyPlanReposResult {
  const declared = declaredProjects(ticketProjects);
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const task of plan.tasks) {
    const repo = task.repo;
    if (repo !== undefined && repo !== "" && !isKnownProject(repo)) {
      errors.push(
        `${task.id}: repo "${repo}" không có trong config/projects.yaml — không tự suy ra đường dẫn (INV-06). ${knownProjectsHint()}`,
      );
    }
  }

  if (errors.length > 0) return { repos: reposForTicket(declared, plan), errors, warnings };

  // Repo chính: repo đầu của ticket, nếu ticket không khai thì repo hợp lệ đầu tiên trong plan.
  // Không có cả hai ⇒ để trống, mọi thứ fallback về --project/defaultProject như trước.
  const primary = declared[0] ?? plan.tasks.find((task) => task.repo !== undefined && task.repo !== "")?.repo;

  if (primary !== undefined) {
    const explicit = new Set(
      plan.tasks.filter((task) => task.repo !== undefined && task.repo !== "").map((task) => task.repo as string),
    );
    if (explicit.size > 1 && !declared.includes(primary)) {
      warnings.push(`Plan khai nhiều repo (${[...explicit].join(", ")}) nhưng ticket.chưa khai repo — đã lấy "${primary}" làm repo chính.`);
    }
    for (const task of plan.tasks) {
      if (task.repo === undefined || task.repo === "") task.repo = primary;
    }
  }

  return { repos: reposForTicket(declared, plan), errors, warnings };
}

/** Nhãn ngắn để in ra CLI. */
export function describeRepos(repos: string[]): string {
  return repos.length === 0 ? "(chưa xác định — dùng --project)" : repos.join(", ");
}
