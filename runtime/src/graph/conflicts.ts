import type { PlanTask } from "../types.js";

export interface Conflict {
  type: "FILE_OVERLAP" | "SYMBOL_OVERLAP" | "MIGRATION_ORDER" | "PATTERN_FORK";
  severity: "BLOCK" | "WARN";
  tasks: string[];
  detail: string;
}

export interface WaveCheck {
  status: "PASS" | "FAIL";
  conflicts: Conflict[];
  safeToParallel: boolean;
}

const MIGRATION_HINT = /(?:^|\/)(?:db\/migration|migrations?|flyway|liquibase|changelog)(?:\/|$)/i;

function normalizeFile(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Khoá so trùng phải gồm REPO (spec 9.4): hai task cùng sửa `src/.../A.java` nhưng ở
 * hai repo khác nhau KHÔNG phải conflict — nếu không tách, multi-repo sẽ bị chặn parallel oan.
 */
function repoTags(task: PlanTask): string[] {
  return task.repo === undefined || task.repo === "" ? [""] : [task.repo];
}

function scopedKey(task: PlanTask, value: string): string {
  return `${task.repo ?? ""}::${value}`;
}

function scopedLabel(task: PlanTask, value: string): string {
  return task.repo === undefined || task.repo === "" ? value : `${task.repo}:${value}`;
}

function isMigrationFile(file: string): boolean {
  const normalized = normalizeFile(file);
  return MIGRATION_HINT.test(normalized) || /\.sql$/i.test(normalized);
}

function pairs<T>(items: T[]): Array<[T, T]> {
  const out: Array<[T, T]> = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      out.push([items[i] as T, items[j] as T]);
    }
  }
  return out;
}

/**
 * Conflict detection trước khi cho chạy parallel (INV-11):
 * cùng file, cùng symbol, thứ tự migration, và pattern fork.
 */
export function detectConflicts(waveTasks: PlanTask[]): Conflict[] {
  const conflicts: Conflict[] = [];

  for (const [a, b] of pairs(waveTasks)) {
    const filesA = new Set((a.files ?? []).map((file) => scopedKey(a, normalizeFile(file))));
    const sharedFiles = (b.files ?? [])
      .map((file) => ({ key: scopedKey(b, normalizeFile(file)), label: scopedLabel(b, normalizeFile(file)) }))
      .filter((entry) => filesA.has(entry.key))
      .map((entry) => entry.label);
    if (sharedFiles.length > 0) {
      conflicts.push({
        type: "FILE_OVERLAP",
        severity: "BLOCK",
        tasks: [a.id, b.id],
        detail: `cùng sửa file: ${sharedFiles.join(", ")}`,
      });
    }

    const symbolsA = new Set((a.symbols ?? []).map((symbol) => scopedKey(a, symbol.trim())));
    const sharedSymbols = (b.symbols ?? [])
      .map((symbol) => ({ key: scopedKey(b, symbol.trim()), label: scopedLabel(b, symbol.trim()) }))
      .filter((entry) => symbolsA.has(entry.key))
      .map((entry) => entry.label);
    if (sharedSymbols.length > 0) {
      conflicts.push({
        type: "SYMBOL_OVERLAP",
        severity: "BLOCK",
        tasks: [a.id, b.id],
        detail: `cùng chạm symbol: ${sharedSymbols.join(", ")}`,
      });
    }
  }

  // Migration chỉ cạnh tranh thứ tự trong CÙNG một repo.
  const migrationByRepo = new Map<string, Array<{ id: string; files: string[] }>>();
  for (const task of waveTasks) {
    const files = (task.files ?? []).filter(isMigrationFile);
    if (files.length === 0) continue;
    for (const repo of repoTags(task)) {
      const bucket = migrationByRepo.get(repo) ?? [];
      bucket.push({ id: task.id, files });
      migrationByRepo.set(repo, bucket);
    }
  }
  for (const [repo, migrationTasks] of migrationByRepo) {
    if (migrationTasks.length <= 1) continue;
    conflicts.push({
      type: "MIGRATION_ORDER",
      severity: "WARN",
      tasks: migrationTasks.map((entry) => entry.id),
      detail:
        `${migrationTasks.length} task cùng thêm migration${repo === "" ? "" : ` trong repo ${repo}`} ` +
        `(${migrationTasks.map((entry) => `${entry.id}: ${entry.files.length}`).join(", ")}) — cần chốt thứ tự áp dụng`,
    });
  }

  const patternForks = waveTasks.filter((task) => (task.existingPattern ?? null) === null && (task.deviation ?? null) === null);
  if (patternForks.length > 1) {
    conflicts.push({
      type: "PATTERN_FORK",
      severity: "WARN",
      tasks: patternForks.map((task) => task.id),
      detail: `${patternForks.length} task không khai báo pattern có sẵn và cũng không nêu lý do — nguy cơ mỗi task tự tạo abstraction riêng (existing-code-first)`,
    });
  }

  return conflicts;
}

export function checkWave(waveTasks: PlanTask[]): WaveCheck {
  const conflicts = detectConflicts(waveTasks);
  const blocking = conflicts.filter((conflict) => conflict.severity === "BLOCK");
  return {
    status: blocking.length === 0 ? "PASS" : "FAIL",
    conflicts,
    safeToParallel: blocking.length === 0,
  };
}

/** Ghi conflict vào plan.waves[].conflicts (schema yêu cầu mảng string). */
export function formatConflict(conflict: Conflict): string {
  return `${conflict.severity} ${conflict.type} [${conflict.tasks.join(", ")}]: ${conflict.detail}`;
}
