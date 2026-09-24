import path from "node:path";
import { agentContract } from "../agents/registry.js";
import { EngError } from "../errors.js";
import { readPlan, setTaskStatus, writePlan } from "../plan/store.js";
import { assertValid } from "../schemas/index.js";
import { StateStore } from "../state/store.js";
import type { Evidence, SubTaskStatus, TaskStatus } from "../types.js";
import { atomicWrite, listFilesRecursive, readJsonFile, workstreamDir, relPath } from "../workspace.js";
import {
  classifyFailure,
  countDebugAttempts,
  GUIDANCE,
  readHarnessLogs,
  type Classification,
  type FailureCategory,
  type LogSignal,
  type Signal,
} from "./classify.js";

export interface Diagnosis {
  taskId: string;
  subTaskId?: string;
  category: FailureCategory;
  confidence: "high" | "medium" | "low";
  summary: string;
  signals: Signal[];
  evidenceRefs: string[];
  logRefs: string[];
  attempt: number;
  maxAttempts: number;
  autoRecoverable: boolean;
  needsHuman: boolean;
  targetStatus: "DEBUGGING" | "IMPLEMENTING" | "BLOCKED";
  actions: string[];
  sourceStatus: TaskStatus;
  contextRef?: string;
  expectedArtifactsMissing: string[];
  errorExcerpt: string;
  errorTruncated: boolean;
}

export interface RecoveryOutcome {
  diagnosis: Diagnosis;
  applied: boolean;
  transitions: Array<{ from: string; to: string }>;
  blocked: boolean;
  markdown: string;
  truncated: boolean;
  jsonPath?: string;
  markdownPath?: string;
  warnings: string[];
}

export interface RecoverOptions {
  subTaskId?: string;
  /** true ⇒ ghi recovery context + đổi trạng thái (mặc định chỉ chẩn đoán). */
  apply?: boolean;
  by?: string;
  maxAttempts?: number;
  root?: string;
}

export interface RecoveryContextRecord {
  schemaVersion: 1;
  taskId: string;
  subTaskId?: string;
  category: FailureCategory;
  confidence: "high" | "medium" | "low";
  summary: string;
  attempt: number;
  maxAttempts: number;
  autoRecoverable: boolean;
  needsHuman: boolean;
  targetStatus: "DEBUGGING" | "IMPLEMENTING" | "BLOCKED";
  sourceStatus: string;
  signals: Signal[];
  evidenceRefs: string[];
  logRefs: string[];
  contextRef?: string;
  expectedArtifactsMissing: string[];
  actions: string[];
  errorExcerpt: string;
  createdAt: string;
  createdBy: string;
  truncated: boolean;
}

const EXCERPT_MAX_LINES = 40;

function excerptFromLog(log: LogSignal | undefined, patterns: RegExp[]): { text: string; truncated: boolean } {
  if (!log) return { text: "(không có log harness)", truncated: false };
  const stderrLines = log.stderrTail.split(/\r?\n/).filter((line) => line.trim() !== "");
  const firstMatch = stderrLines.find((line) => patterns.some((pattern) => pattern.test(line)));
  const chosen = firstMatch ? [firstMatch, ...stderrLines.slice(-EXCERPT_MAX_LINES)] : stderrLines.slice(-EXCERPT_MAX_LINES);
  const unique = [...new Set(chosen)];
  return { text: unique.join("\n"), truncated: stderrLines.length > EXCERPT_MAX_LINES };
}

function summarize(category: FailureCategory, confidence: string, signals: Signal[]): string {
  const specific = signals.find((signal) => !/^exit code -?\d+$/.test(signal.detail));
  const chosen = specific ?? signals[0];
  return `${category} (${confidence})${chosen ? ` — ${chosen.detail}` : ""}`;
}

/**
 * RecoveryEngine (spec mục 15).
 *
 * Đầu vào: log harness + evidence + state (+ plan/context). Đầu ra: phân loại lỗi, việc phải làm,
 * và (khi `apply`) recovery context TỐI THIỂU — chỉ gồm context của task + lỗi + trích diff,
 * không nhồi lại toàn bộ log hay toàn bộ context (INV-01).
 */
export class RecoveryEngine {
  readonly #store: StateStore;
  readonly #root?: string;

  constructor(options: { root?: string; store?: StateStore } = {}) {
    this.#root = options.root;
    this.#store = options.store ?? new StateStore(options.root === undefined ? {} : { root: options.root });
  }

  #workstream(taskId: string): string {
    return workstreamDir(taskId, this.#root);
  }

  #expectedArtifacts(taskId: string, subTaskId?: string): { role: string | null; missing: string[] } {
    if (!subTaskId) return { role: null, missing: [] };
    const plan = readPlan(taskId, this.#root);
    const planTask = plan?.tasks.find((task) => task.id === subTaskId);
    if (!planTask) return { role: null, missing: [] };

    const files = Object.keys(this.#listFiles(taskId));
    const roles = ["developer", "reviewer", "researcher", "impact", "architect", "auditor"];
    for (const role of roles) {
      const logName = relPath("tasks", `${role}-${subTaskId}.log`);
      if (!files.includes(logName)) continue;
      const outputs = agentContract(role).outputs.map((output) => output.replaceAll("{subTaskId}", subTaskId));
      const missing = outputs.filter((output) => !files.includes(output));
      return { role, missing };
    }
    return { role: null, missing: [] };
  }

  #listFiles(taskId: string): Record<string, true> {
    const out: Record<string, true> = {};
    for (const file of listFilesRecursive(this.#workstream(taskId))) out[file] = true;
    return out;
  }

  diagnose(taskId: string, subTaskId?: string, options: { maxAttempts?: number } = {}): Diagnosis {
    const state = this.#store.require(taskId);
    const evidence: Evidence[] = this.#store.evidence.list(taskId);
    const logs = readHarnessLogs(taskId, subTaskId, this.#root);
    const files = this.#listFiles(taskId);
    const contextRel = subTaskId ? relPath("context", `${subTaskId}.json`) : undefined;
    const contextPresent = contextRel ? files[contextRel] === true : true;
    const artifacts = this.#expectedArtifacts(taskId, subTaskId);
    const roleRequiresContext = artifacts.role ? agentContract(artifacts.role).requiresContext === true : undefined;

    const classification: Classification = classifyFailure({
      logs,
      blockedReason: state.blockReason ?? null,
      evidence,
      contextPresent,
      ...(roleRequiresContext !== undefined ? { roleRequiresContext } : {}),
      expectedArtifactsMissing: artifacts.missing,
    });

    const maxAttempts = options.maxAttempts ?? 2;
    const attempt = countDebugAttempts(state.history) + (state.status === "DEBUGGING" ? 1 : 0);
    const guidance = GUIDANCE[classification.category];
    const overLimit = attempt >= maxAttempts;
    const needsHuman = guidance.needsHuman || overLimit;
    const autoRecoverable = guidance.autoRecoverable && !needsHuman;

    const patterns = [/error/i, /fail/i, /exception/i];
    const newestLog = logs[0];
    const excerpt = excerptFromLog(newestLog, patterns);

    const actions = [...guidance.actions];
    if (overLimit && !guidance.needsHuman) {
      actions.push(
        `Đã thử ${attempt}/${maxAttempts} lần — DỪNG sửa tự động, escalate cho người kèm danh sách giả thuyết đã loại trừ.`,
      );
    }

    const contextFiles = contextRel
      ? (readJsonFile<{ files?: string[] }>(path.join(this.#workstream(taskId), contextRel))?.files ?? [])
      : [];

    const diagnosis: Diagnosis = {
      taskId,
      ...(subTaskId ? { subTaskId } : {}),
      category: classification.category,
      confidence: classification.confidence,
      summary: summarize(classification.category, classification.confidence, classification.signals),
      signals: classification.signals,
      evidenceRefs: classification.evidenceRefs,
      logRefs: logs.map((log) => log.path),
      attempt,
      maxAttempts,
      autoRecoverable,
      needsHuman,
      targetStatus: needsHuman ? "BLOCKED" : guidance.status,
      actions,
      sourceStatus: state.status,
      ...(contextRel ? { contextRef: `context/${subTaskId}.md` } : {}),
      expectedArtifactsMissing: artifacts.missing,
      errorTruncated: excerpt.truncated,
      errorExcerpt: [
        `# Phạm vi thay đổi liên quan (chỉ đường dẫn — không nhúng nội dung, INV-01)`,
        ...contextFiles.map((file) => `- ${file}`),
        contextFiles.length > 0 ? `# Xem diff: git diff -- ${contextFiles.join(" ")}` : "# Không có context files để đối chiếu",
        "",
        `# Lỗi (trích ${EXCERPT_MAX_LINES} dòng cuối, không phải toàn bộ log)`,
        excerpt.text,
      ].join("\n"),
    };
    return diagnosis;
  }

  recover(taskId: string, options: RecoverOptions = {}): RecoveryOutcome {
    const diagnosis = this.diagnose(taskId, options.subTaskId, {
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    });
    const warnings: string[] = [];
    const transitions: Array<{ from: string; to: string }> = [];
    const markdown = renderRecoveryMarkdown(diagnosis);
    const truncated = diagnosis.errorTruncated;

    if (options.apply !== true) {
      return { diagnosis, applied: false, transitions, blocked: false, markdown, truncated, warnings };
    }

    const store = this.#store;
    const by = options.by ?? "runtime:eng";
    let blocked = false;

    if (diagnosis.targetStatus === "BLOCKED") {
      // block là CỜ (không phải status) — áp dụng cho cả trường hợp chờ người và trường hợp
      // agent tự xử lý được nhưng phải dừng lại (ví dụ MISSING_CONTEXT ⇒ phải compile lại).
      store.block(taskId, `${diagnosis.category}: ${diagnosis.summary}`, by);
      blocked = true;
      if (diagnosis.attempt >= diagnosis.maxAttempts) {
        warnings.push(
          `Đã ${diagnosis.attempt} lần thử — hệ thống dừng tự động phục hồi và chuyển cho người (không restart mù quáng).`,
        );
      }
    } else {
      const chain = recoveryChain(diagnosis.sourceStatus, diagnosis.targetStatus);
      let cursor: TaskStatus = diagnosis.sourceStatus;
      for (const step of chain) {
        store.transition(taskId, step, { by, reason: `recovery: ${diagnosis.category}` });
        transitions.push({ from: cursor, to: step });
        cursor = step;
      }
      if (chain.length === 0) {
        if (diagnosis.sourceStatus === "DEBUGGING") {
          warnings.push("Task đã ở DEBUGGING — không cần chuyển trạng thái.");
        } else {
          // Lỗi xảy ra ngoài nhánh implementation (translate/analyze/design/review...):
          // state machine không có đường sang DEBUGGING từ đây ⇒ BLOCK để xử lý rồi chạy lại phase,
          // không im lặng bỏ qua (retry mù quáng trên cùng context là điều spec cấm).
          store.block(
            taskId,
            `${diagnosis.category}: ${diagnosis.summary} — không có đường sang DEBUGGING từ ${diagnosis.sourceStatus}; xử lý rồi chạy lại phase`,
            by,
          );
          blocked = true;
          warnings.push(`Đã BLOCK task: xử lý nguyên nhân rồi chạy lại phase (status giữ ${diagnosis.sourceStatus}).`);
        }
      }
    }

    if (options.subTaskId) {
      const plan = readPlan(taskId, this.#root);
      if (plan) {
        const target: SubTaskStatus = diagnosis.needsHuman ? "BLOCKED" : "FAILED";
        setTaskStatus(plan, options.subTaskId, target);
        writePlan(plan, this.#root);
      }
    }

    const record: RecoveryContextRecord = {
      schemaVersion: 1,
      taskId,
      ...(diagnosis.subTaskId ? { subTaskId: diagnosis.subTaskId } : {}),
      category: diagnosis.category,
      confidence: diagnosis.confidence,
      summary: diagnosis.summary,
      attempt: diagnosis.attempt,
      maxAttempts: diagnosis.maxAttempts,
      autoRecoverable: diagnosis.autoRecoverable,
      needsHuman: diagnosis.needsHuman,
      targetStatus: diagnosis.targetStatus,
      sourceStatus: diagnosis.sourceStatus,
      signals: diagnosis.signals,
      evidenceRefs: diagnosis.evidenceRefs,
      logRefs: diagnosis.logRefs,
      ...(diagnosis.contextRef ? { contextRef: diagnosis.contextRef } : {}),
      expectedArtifactsMissing: diagnosis.expectedArtifactsMissing,
      actions: diagnosis.actions,
      errorExcerpt: diagnosis.errorExcerpt,
      createdAt: new Date().toISOString(),
      createdBy: by,
      truncated,
    };
    assertValid("recovery", record, `recovery context của ${taskId}`);

    const suffix = options.subTaskId ?? taskId;
    const jsonRel = relPath("tasks", `recovery-${suffix}.json`);
    const markdownRel = relPath("tasks", `recovery-${suffix}.md`);
    atomicWrite(path.join(this.#workstream(taskId), jsonRel), `${JSON.stringify(record, null, 2)}\n`);
    atomicWrite(path.join(this.#workstream(taskId), markdownRel), markdown);

    return {
      diagnosis,
      applied: true,
      transitions,
      blocked,
      markdown,
      truncated,
      jsonPath: jsonRel,
      markdownPath: markdownRel,
      warnings,
    };
  }

  /** Đọc recovery context đã ghi (nếu có) — dùng cho worker/debug. */
  read(taskId: string, subTaskId?: string): RecoveryContextRecord | null {
    const suffix = subTaskId ?? taskId;
    return readJsonFile<RecoveryContextRecord>(path.join(this.#workstream(taskId), "tasks", `recovery-${suffix}.json`));
  }
}

/** Chuỗi transition hợp lệ để vào nhánh phục hồi (spec mục 8.1). */
export function recoveryChain(from: TaskStatus, target: Diagnosis["targetStatus"]): TaskStatus[] {
  if (target === "BLOCKED") return [];
  if (from === "DEBUGGING") return [];
  if (target === "IMPLEMENTING") {
    if (from === "REWORK_REQUIRED") return ["IMPLEMENTING"];
    if (from === "FAILED") return ["DEBUGGING", "IMPLEMENTING"];
    return [];
  }
  // target DEBUGGING
  if (from === "IMPLEMENTING") return ["FAILED", "DEBUGGING"];
  if (from === "FAILED") return ["DEBUGGING"];
  if (from === "REWORK_REQUIRED") return ["IMPLEMENTING"];
  return [];
}

export function renderRecoveryMarkdown(diagnosis: Diagnosis): string {
  const lines: string[] = [];
  lines.push(`# Recovery — ${diagnosis.taskId}${diagnosis.subTaskId ? ` / ${diagnosis.subTaskId}` : ""}`);
  lines.push("");
  lines.push("## Phân loại");
  lines.push(`- category: **${diagnosis.category}** (confidence ${diagnosis.confidence})`);
  lines.push(`- status nguồn: ${diagnosis.sourceStatus} → đích: ${diagnosis.targetStatus}`);
  lines.push(`- lần thử: ${diagnosis.attempt}/${diagnosis.maxAttempts}${diagnosis.needsHuman ? " — CẦN NGƯỜI XỬ LÝ" : ""}`);
  lines.push(`- tự phục hồi được: ${diagnosis.autoRecoverable ? "có" : "không"}`);
  lines.push(`- tóm tắt: ${diagnosis.summary}`);
  lines.push("");
  lines.push("## Dấu hiệu (signals)");
  for (const signal of diagnosis.signals) lines.push(`- [${signal.source}] ${signal.detail}`);
  if (diagnosis.evidenceRefs.length > 0) lines.push(`- evidence: ${diagnosis.evidenceRefs.join(", ")}`);
  if (diagnosis.logRefs.length > 0) lines.push(`- log: ${diagnosis.logRefs.join(", ")}`);
  lines.push("");
  lines.push("## Việc phải làm");
  diagnosis.actions.forEach((action, index) => lines.push(`${index + 1}. ${action}`));
  lines.push("");
  lines.push("## Ngữ cảnh tối thiểu");
  lines.push(`- context của task: ${diagnosis.contextRef ?? "(không có)"} — đọc lại file này, KHÔNG nhúng vào đây (INV-01)`);
  if (diagnosis.expectedArtifactsMissing.length > 0) {
    lines.push(`- artifact còn thiếu: ${diagnosis.expectedArtifactsMissing.join(", ")}`);
  }
  lines.push("");
  lines.push("## Trích lỗi");
  lines.push("```");
  lines.push(diagnosis.errorExcerpt);
  lines.push("```");
  lines.push("");
  lines.push("## Giới hạn");
  lines.push("- Không restart worker với cùng context cũ.");
  lines.push("- Không sửa test/nới gate để thoát trạng thái lỗi.");
  lines.push("- Nếu là MISSING_CONTEXT/MCP_FAILURE: giữ BLOCKED, không suy diễn (INV-06).");
  lines.push("");
  return lines.join("\n");
}
