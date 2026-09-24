import { readFileSync } from "node:fs";
import path from "node:path";
import { defaultMode } from "../config/index.js";
import { EventBus } from "../events/bus.js";
import { EngError } from "../errors.js";
import { EvidenceStore } from "../evidence/store.js";
import { evaluateEvidenceGate } from "../evidence/rules.js";
import { readPlan } from "../plan/store.js";
import { reposForState } from "../repos.js";
import { assertValid } from "../schemas/index.js";
import type { EventType, Evidence, ExecutionMode, HistoryEntry, RiskLevel, TaskState, TaskStatus } from "../types.js";
import { assertTransition, phaseForStatus, nextStatuses } from "./machine.js";
import { acquireLock, releaseLock } from "./lock.js";
import { assertHumanGates, checkHumanGates, openGatesFor, type GateCheck } from "./gates.js";
import { atomicWrite, ensureWorkstream, listFilesRecursive, listWorkstreams, workstreamDir, relPath } from "../workspace.js";

/** Field được phép sửa trực tiếp qua patch. `status` phải đi qua transition(). */
const PATCHABLE_FIELDS = new Set([
  "title",
  "risk",
  "riskScore",
  "riskFactors",
  "mode",
  "currentWave",
  "currentTasks",
  "completedTasks",
  "blocked",
  "blockReason",
  "projects",
  "domains",
  "capabilities",
  "approvals",
  "artifacts",
  "git",
]);

const READONLY_FIELDS = new Set([
  "schemaVersion",
  "taskId",
  "status",
  "phase",
  "history",
  "evidence",
  "createdAt",
  "updatedAt",
]);

const STAGE_RANK: Record<TaskStatus, number> = {
  NEW: 0,
  TRANSLATING: 0,
  REQUIREMENT_ANALYSIS: 1,
  IMPACT_ANALYSIS: 2,
  DESIGNING: 3,
  WAITING_DESIGN_APPROVAL: 3,
  PLANNING: 4,
  WAITING_PLAN_APPROVAL: 4,
  READY_TO_IMPLEMENT: 4,
  IMPLEMENTING: 5,
  FAILED: 5,
  DEBUGGING: 5,
  REWORK_REQUIRED: 5,
  REVIEWING: 5,
  AUDITING: 6,
  VERIFYING: 7,
  DONE: 8,
};

const REQUIRED_ARTIFACTS: Array<{ atRank: number; artifact: string }> = [
  { atRank: 1, artifact: "requirements.md" },
  { atRank: 2, artifact: "impact.md" },
  { atRank: 3, artifact: "architecture.md" },
  { atRank: 4, artifact: "plan.md" },
  { atRank: 4, artifact: "plan.json" },
  { atRank: 6, artifact: "audit.md" },
];

const NEXT_ACTIONS: Record<TaskStatus, string> = {
  NEW: "chạy workflow translate (researcher) để tạo requirements.md",
  TRANSLATING: "hoàn tất requirements.md + open_questions.md + assumptions.md, rồi chuyển REQUIREMENT_ANALYSIS",
  REQUIREMENT_ANALYSIS: "chốt acceptance criteria + business rules, chuyển IMPACT_ANALYSIS",
  IMPACT_ANALYSIS: "chạy impact analysis qua mcp-engineering (mcp-domain-core nếu đang bật), tạo impact.md",
  DESIGNING: "architect tạo architecture.md (options A/B/C + decision), chuyển WAITING_DESIGN_APPROVAL",
  WAITING_DESIGN_APPROVAL: "chờ human approve kiến trúc (evidence HUMAN_APPROVAL gateId=architecture), rồi chuyển PLANNING",
  PLANNING: "tạo plan.md (task nhỏ, có AC + verification), rồi chuyển READY_TO_IMPLEMENT",
  WAITING_PLAN_APPROVAL: "chờ approve implementation plan, rồi chuyển READY_TO_IMPLEMENT",
  READY_TO_IMPLEMENT: "compile context cho từng task rồi chuyển IMPLEMENTING",
  IMPLEMENTING: "developer thực hiện theo context/task-NN.md; chạy test + validate scope trước khi chuyển REVIEWING",
  FAILED: "phân loại lỗi và chuyển DEBUGGING (recovery context chỉ gồm task context + error + diff + test fail)",
  DEBUGGING: "tìm root cause, sửa tối thiểu, chuyển lại IMPLEMENTING",
  REVIEWING: "spec review + quality review (evidence), rồi chuyển AUDITING",
  REWORK_REQUIRED: "sửa theo issue của review/audit, chuyển lại IMPLEMENTING",
  AUDITING: "audit banking: regression, security, transaction, backward compatibility → audit.md, chuyển VERIFYING",
  VERIFYING: "build + test + scope + acceptance criteria → DONE",
  DONE: "task kết thúc; có thể mở workstream mới cho ticket khác",
};

export interface CreateTaskInput {
  taskId: string;
  title?: string;
  /** Chỉ dùng khi bootstrap/import ticket đang làm dở — không đi qua gate. */
  status?: TaskStatus;
  risk?: RiskLevel;
  mode?: ExecutionMode;
  /** Repo đích của ticket (multi-repo — spec 9.4). Phần tử đầu là repo chính. */
  projects?: string[];
  domains?: string[];
  capabilities?: string[];
  git?: TaskState["git"];
  riskFactors?: string[];
  riskScore?: number;
  by?: string;
  reason?: string;
}

/**
 * Tiền tố reason của history cho block/unblock — metrics (spec mục 21) đọc lại đúng hai giá trị này
 * để ghép cặp "blocked episode". Đổi ở đây thì phải đổi cả `runtime/src/metrics/compute.ts`.
 */
export const BLOCK_REASON_PREFIX = "block:";
export const UNBLOCK_REASON = "unblock";

export interface WriteOptions {
  by?: string;
  reason?: string;
  evidenceRef?: string;
  expect?: TaskStatus;
  allowBypass?: boolean;
}

export interface ResumeReport {
  taskId: string;
  title?: string;
  status: TaskStatus;
  phase: string;
  risk: RiskLevel;
  mode: ExecutionMode;
  blocked: boolean;
  blockReason?: string | null;
  /** Repo của ticket (multi-repo — spec 9.4); repo chính đứng đầu. */
  projects: string[];
  lastTransition?: HistoryEntry;
  tasks: { current: string[]; completed: string[]; wave?: number };
  contexts: Array<{ subTaskId: string; status: string; compiled: boolean }>;
  approvals: Record<string, boolean>;
  openGates: GateCheck[];
  evidence: { count: number; byType: Record<string, number> };
  artifacts: { present: string[]; missing: string[] };
  nextActions: string[];
  events: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * StateStore — nguồn sự thật của một ticket (spec mục 8, 17).
 * Ghi atomic; mọi thay đổi ghi vào history; transition phải qua evidence gate (INV-03) và human gate (INV-05).
 */
export class StateStore {
  readonly #root?: string;
  readonly evidence: EvidenceStore;
  readonly bus: EventBus;

  constructor(options: { root?: string; evidence?: EvidenceStore; bus?: EventBus } = {}) {
    const busOptions = options.root === undefined ? {} : { root: options.root };
    this.#root = options.root;
    this.bus = options.bus ?? new EventBus(busOptions);
    this.evidence =
      options.evidence ??
      new EvidenceStore({
        ...busOptions,
        bus: this.bus,
        // task.json giữ danh sách evidence (spec 8.2); file trong evidence/ vẫn là nguồn sự thật.
        onRecord: (taskId, evidence) => this.#syncEvidenceList(taskId, evidence),
      });
  }

  /** Đồng bộ `state.evidence[]` sau khi ghi evidence — không đi qua patch() nên không có gate. */
  #syncEvidenceList(taskId: string, evidence: Evidence): void {
    const current = this.get(taskId);
    if (!current) return;
    const list = current.evidence ?? [];
    const rel = evidence.path ?? `evidence/${evidence.id}.json`;
    if (list.includes(rel)) return;
    const next: TaskState = { ...current, evidence: [...list, rel], updatedAt: new Date().toISOString() };
    assertValid("task", next, `state sau khi ghi evidence ${evidence.id}`);
    this.#write(next); // đã nằm trong lock của EvidenceStore.record (reentrant)
  }

  dir(taskId: string): string {
    return workstreamDir(taskId, this.#root);
  }

  exists(taskId: string): boolean {
    return listFilesRecursive(this.dir(taskId)).length > 0;
  }

  list(): string[] {
    return listWorkstreams(this.#root);
  }

  get(taskId: string): TaskState | null {
    const file = path.join(this.dir(taskId), "task.json");
    const raw = readJsonSafe(file);
    return raw;
  }

  require(taskId: string): TaskState {
    const state = this.get(taskId);
    if (!state) {
      throw new EngError("STATE_NOT_FOUND", `Chưa có workstream/state cho ${taskId}.`, {
        hint: `Tạo bằng: eng new ${taskId} --title "..." --risk MEDIUM`,
      });
    }
    return state;
  }

  create(input: CreateTaskInput): TaskState {
    ensureWorkstream(input.taskId, this.#root);
    acquireLock(input.taskId, { ...(this.#root !== undefined ? { root: this.#root } : {}), command: "state:create" });
    if (this.get(input.taskId)) {
      throw new EngError("WORKSTREAM_EXISTS", `Workstream ${input.taskId} đã tồn tại.`, {
        hint: `Xem trạng thái bằng: eng status ${input.taskId}`,
      });
    }
    const timestamp = nowIso();
    const status: TaskStatus = input.status ?? "NEW";
    const state: TaskState = {
      schemaVersion: 1,
      taskId: input.taskId,
      title: input.title ?? input.taskId,
      status,
      phase: phaseForStatus(status),
      risk: input.risk ?? "MEDIUM",
      riskScore: input.riskScore ?? 0,
      riskFactors: input.riskFactors ?? [],
      mode: input.mode ?? defaultMode(),
      currentWave: 0,
      currentTasks: [],
      completedTasks: [],
      blocked: false,
      blockReason: null,
      projects: input.projects ?? [],
      domains: input.domains ?? [],
      capabilities: input.capabilities ?? [],
      approvals: {},
      evidence: [],
      artifacts: {},
      history: [
        {
          at: timestamp,
          from: null,
          to: status,
          by: input.by ?? "runtime:eng",
          reason: input.reason ?? (status === "NEW" ? "tạo workstream" : "bootstrap ticket đang làm dở"),
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (input.git) state.git = input.git;

    assertValid("task", state, `state khởi tạo của ${input.taskId}`);
    this.#write(state);
    this.bus.emit({ taskId: state.taskId, type: "TaskCreated", actor: input.by ?? "runtime:eng", toStatus: status, payload: { title: state.title, risk: state.risk, mode: state.mode } });
    releaseLock(input.taskId);
    return state;
  }

  /**
   * Cập nhật metadata. Nếu workstream chưa tồn tại ⇒ tạo mới (bootstrap).
   * `status` không được sửa trực tiếp trừ khi tạo mới — dùng transition().
   */
  patch(taskId: string, patch: Record<string, unknown>, options: WriteOptions = {}): TaskState {
    const existing = this.get(taskId);
    if (!existing) {
      const { status, ...rest } = patch as { status?: TaskStatus } & Record<string, unknown>;
      return this.create({
        taskId,
        ...(rest as Omit<CreateTaskInput, "taskId">),
        ...(status ? { status } : {}),
        by: options.by ?? "runtime:eng",
        reason: options.reason ?? "bootstrap qua patch",
      });
    }

    for (const key of Object.keys(patch)) {
      if (READONLY_FIELDS.has(key)) {
        throw new EngError("PATCH_FORBIDDEN_FIELD", `Không được sửa trực tiếp field "${key}".`, {
          hint:
            key === "status"
              ? `Dùng transition: eng advance ${taskId} --to <STATUS> (đi qua evidence gate).`
              : key === "evidence"
                ? "Evidence do EvidenceStore quản lý: dùng eng evidence hoặc record_evidence."
                : "Field này do runtime quản lý.",
        });
      }
      if (!PATCHABLE_FIELDS.has(key)) {
        throw new EngError("PATCH_UNKNOWN_FIELD", `Field "${key}" không có trong task.schema.json.`, {
          hint: `Field cho phép: ${[...PATCHABLE_FIELDS].join(", ")}`,
        });
      }
    }

    const stamped = nowIso();
    const next: TaskState = { ...existing, ...patch, updatedAt: stamped } as TaskState;
    if (next.blocked && !next.blockReason) {
      throw new EngError("BLOCK_REASON_REQUIRED", "blocked = true nhưng thiếu blockReason.", {
        hint: "Ghi rõ đang thiếu gì (context nào, MCP nào) — không đoán (INV-06).",
      });
    }
    // Patch có lý do là một sự kiện audit: ghi vào history để `eng metrics`/resume đọc lại được.
    // Không có reason ⇒ patch kỹ thuật thuần (ví dụ đổi currentWave) không làm nhiễu history.
    if (options.reason !== undefined && options.reason.trim() !== "") {
      next.history = [
        ...(next.history ?? []),
        {
          at: stamped,
          from: existing.status,
          to: next.status,
          by: options.by ?? "runtime:eng",
          reason: options.reason,
        },
      ];
    }
    assertValid("task", next, `state sau patch của ${taskId}`);
    acquireLock(taskId, { ...(this.#root !== undefined ? { root: this.#root } : {}), command: "state:patch" });
    try {
      this.#write(next);
    } finally {
      releaseLock(taskId);
    }
    return next;
  }

  /** Chuyển trạng thái có kiểm soát: transition hợp lệ + evidence gate + human gate. */
  transition(taskId: string, to: TaskStatus, options: WriteOptions = {}): TaskState {
    const current = this.require(taskId);
    if (options.expect && current.status !== options.expect) {
      throw new EngError(
        "STATE_CONFLICT",
        `Status hiện tại là ${current.status}, không phải ${options.expect} như mong đợi.`,
        { hint: `Đọc lại state: eng status ${taskId}` },
      );
    }

    assertTransition(current.status, to);

    const evidence = this.evidence.list(taskId);
    // Multi-repo (spec 9.4): gate phải kiểm evidence cho TỪNG repo của ticket.
    const projects = reposForState(current, readPlan(taskId, this.#root));
    const gateResult = evaluateEvidenceGate(to, evidence, { risk: current.risk, projects });
    if (!gateResult.ok) {
      throw new EngError(
        "EVIDENCE_REQUIRED",
        `Không thể chuyển ${current.status} → ${to} khi chưa đủ evidence.`,
        {
          hint: "Chạy verification thật, ghi evidence kèm provenance, rồi chuyển lại (INV-03 / RULES-001).",
          details: { missing: gateResult.missing, satisfied: gateResult.satisfied },
        },
      );
    }

    const gateChecks = assertHumanGates(current, to, evidence, {
      ...(options.allowBypass === true ? { allowBypass: true } : {}),
    });

    const approvals = { ...(current.approvals ?? {}) };
    for (const check of gateChecks) {
      if (check.satisfied || check.bypassed) approvals[check.gateId] = true;
    }

    const timestamp = nowIso();
    const next: TaskState = {
      ...current,
      status: to,
      phase: phaseForStatus(to),
      approvals,
      updatedAt: timestamp,
      history: [
        ...(current.history ?? []),
        {
          at: timestamp,
          from: current.status,
          to,
          by: options.by ?? "runtime:eng",
          ...(options.reason ? { reason: options.reason } : {}),
          ...(options.evidenceRef ? { evidenceRef: options.evidenceRef } : {}),
        },
      ],
    };

    assertValid("task", next, `state sau transition ${current.status} → ${to}`);
    acquireLock(taskId, { ...(this.#root !== undefined ? { root: this.#root } : {}), command: "state:transition" });
    try {
      this.#write(next);
    } finally {
      releaseLock(taskId);
    }

    const eventType = eventForTransition(current.status, to);
    if (eventType) {
      this.bus.emit({
        taskId,
        type: eventType,
        actor: options.by ?? "runtime:eng",
        fromStatus: current.status,
        toStatus: to,
        evidenceRef: options.evidenceRef ?? null,
        payload: { [eventType === "HumanApprovalRequired" ? "gate" : "reason"]: options.reason ?? null },
      });
    }
    return next;
  }

  block(taskId: string, reason: string, by = "runtime:eng"): TaskState {
    if (!reason || reason.trim() === "") {
      throw new EngError("BLOCK_REASON_REQUIRED", "Cần lý do cụ thể khi block.", {
        hint: "Ghi rõ đang thiếu gì (context nào, MCP nào) — không đoán (INV-06).",
      });
    }
    const state = this.patch(taskId, { blocked: true, blockReason: reason }, { by, reason: `${BLOCK_REASON_PREFIX} ${reason}` });
    this.bus.emit({ taskId, type: "Blocked", actor: by, fromStatus: state.status, toStatus: state.status, payload: { reason } });
    return state;
  }

  unblock(taskId: string, by = "runtime:eng"): TaskState {
    return this.patch(taskId, { blocked: false, blockReason: null }, { by, reason: UNBLOCK_REASON });
  }

  resume(taskId: string): ResumeReport {
    const state = this.require(taskId);
    const evidence = this.evidence.list(taskId);
    const files = listFilesRecursive(this.dir(taskId));
    const rank = STAGE_RANK[state.status];

    const present: string[] = [];
    const missing: string[] = [];
    for (const requirement of REQUIRED_ARTIFACTS) {
      if (rank < requirement.atRank) continue;
      if (files.includes(requirement.artifact)) present.push(requirement.artifact);
      else missing.push(requirement.artifact);
    }

    const nextActions = [NEXT_ACTIONS[state.status]];
    if (state.blocked && state.blockReason) {
      nextActions.unshift(`ĐANG BLOCKED: ${state.blockReason} — xử lý rồi chạy: eng unblock ${taskId}`);
    }

    // Context của từng task con: task chưa DONE mà chưa compile context thì worker sẽ thiếu nguyên liệu.
    const plan = readPlan(taskId, this.#root);
    const contexts: Array<{ subTaskId: string; status: string; compiled: boolean }> = [];
    if (plan) {
      for (const task of plan.tasks) {
        contexts.push({
          subTaskId: task.id,
          status: task.status ?? "PENDING",
          compiled: files.includes(relPath("context", `${task.id}.md`)),
        });
      }
      const needContext = contexts.filter((entry) => !entry.compiled && entry.status !== "DONE");
      if (needContext.length > 0 && rank >= STAGE_RANK["READY_TO_IMPLEMENT"]) {
        nextActions.push(
          `Compile context cho: ${needContext.map((entry) => entry.subTaskId).join(", ")} — eng context ${taskId} --all`,
        );
      }
    }

    if (missing.length > 0) {
      nextActions.push(`Thiếu artifact: ${missing.join(", ")} — cần tạo trước khi đi tiếp.`);
    }

    const history = state.history ?? [];
    const report: ResumeReport = {
      taskId,
      title: state.title,
      status: state.status,
      phase: state.phase,
      risk: state.risk,
      mode: state.mode,
      blocked: state.blocked,
      blockReason: state.blockReason ?? null,
      projects: reposForState(state, plan),
      tasks: {
        current: state.currentTasks ?? [],
        completed: state.completedTasks ?? [],
        ...(state.currentWave !== undefined ? { wave: state.currentWave } : {}),
      },
      contexts,
      approvals: state.approvals ?? {},
      openGates: openGatesFor(state, evidence, nextStatuses(state.status)),
      evidence: { count: evidence.length, byType: this.evidence.summary(taskId) },
      artifacts: { present, missing },
      nextActions,
      events: this.bus.read(taskId).length,
    };
    const last = history.at(-1);
    if (last) report.lastTransition = last as ResumeReport["lastTransition"];
    return report;
  }

  /** Kiểm tra human gate cho một transition mà không thực hiện (dùng cho CLI/agent hỏi trước). */
  gatesFor(taskId: string, to: TaskStatus): GateCheck[] {
    const state = this.require(taskId);
    return checkHumanGates(state, to, this.evidence.list(taskId));
  }

  #write(state: TaskState): void {
    atomicWrite(path.join(this.dir(state.taskId), "task.json"), `${JSON.stringify(state, null, 2)}\n`);
  }
}

function readJsonSafe(file: string): TaskState | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as TaskState;
  } catch {
    return null;
  }
}

function eventForTransition(from: TaskStatus, to: TaskStatus): EventType | null {
  if (from === "IMPACT_ANALYSIS" && to === "DESIGNING") return "ImpactCompleted";
  if (from === "REQUIREMENT_ANALYSIS" && to === "IMPACT_ANALYSIS") return "RequirementCompleted";
  if (to === "WAITING_DESIGN_APPROVAL") return "HumanApprovalRequired";
  if (from === "WAITING_DESIGN_APPROVAL" && to === "PLANNING") return "DesignApproved";
  if (from === "PLANNING" && to === "READY_TO_IMPLEMENT") return "PlanCreated";
  if (to === "IMPLEMENTING") return "TaskStarted";
  if (to === "DONE") return "Completed";
  return null;
}
