import { nextStatuses } from "../state/machine.js";
import type { GateCheck } from "../state/gates.js";
import { humanGatesForTransition } from "../config/index.js";
import { StateStore } from "../state/store.js";
import type { TaskStatus } from "../types.js";
import { PhaseOrchestrator, type RunPhaseOptions } from "./phases.js";
import { PHASES, type PhaseName, type PhaseResult } from "./types.js";

/**
 * `eng continue` — chạy liên tiếp các pha cho tới khi gặp việc phải do NGƯỜI quyết.
 *
 * Vì sao cần: chuỗi 8 phase là thứ dễ quên nhất khi dùng hằng ngày, mà runtime đã biết
 * chính xác pha kế tiếp từ `task.json.status` (INV-02). Lệnh này KHÔNG nới gate nào:
 * nó dừng đúng ở human gate, evidence gate, khi pha lỗi, hoặc khi phải merge worktree.
 */

/** Status → pha kế tiếp. `null` = không còn pha nào chạy tiếp được. */
const NEXT_PHASE: Record<TaskStatus, PhaseName | null> = {
  NEW: "translate",
  TRANSLATING: "translate",
  REQUIREMENT_ANALYSIS: "analyze",
  IMPACT_ANALYSIS: "analyze",
  DESIGNING: "design",
  WAITING_DESIGN_APPROVAL: "plan",
  PLANNING: "plan",
  WAITING_PLAN_APPROVAL: "plan",
  READY_TO_IMPLEMENT: "implement",
  IMPLEMENTING: "implement",
  FAILED: "implement",
  DEBUGGING: "implement",
  REWORK_REQUIRED: "implement",
  REVIEWING: "review",
  AUDITING: "audit",
  VERIFYING: "verify",
  DONE: null,
};

export function nextPhaseFor(status: TaskStatus): PhaseName | null {
  return NEXT_PHASE[status] ?? null;
}

export interface ContinueRunOptions extends RunPhaseOptions {
  /** Trần số pha chạy trong một lần `eng continue` (mặc định 8 = toàn bộ vòng đời). */
  maxSteps?: number;
}

export interface ContinueStep {
  phase: PhaseName;
  from: TaskStatus;
  to: TaskStatus;
  ok: boolean;
  blocked: boolean;
  /** Đã đổi trạng thái thật hay không (không đổi ⇒ dừng). */
  progressed: boolean;
}

/** Vì sao `eng continue` dừng lại — luôn kèm việc phải làm tiếp. */
export type ContinueStop =
  | "DONE"
  | "BLOCKED"
  | "HUMAN_GATE"
  | "EVIDENCE_OR_ERROR"
  | "NO_PROGRESS"
  | "NO_PHASE"
  | "MAX_STEPS";

export interface ContinueResult {
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  /** true chỉ khi ticket đã tới DONE. */
  ok: boolean;
  blocked: boolean;
  stoppedBecause: ContinueStop;
  stoppedDetail: string;
  steps: ContinueStep[];
  openGates: GateCheck[];
  warnings: string[];
  nextActions: string[];
  dryRun: boolean;
}

interface BlockingGate {
  to: TaskStatus;
  checks: GateCheck[];
}

/** Human gate BẮT BUỘC chưa approve cho transition hợp lệ kế tiếp (INV-05). */
function blockingHumanGate(store: StateStore, taskId: string, status: TaskStatus): BlockingGate | null {
  for (const to of nextStatuses(status)) {
    const checks = store
      .gatesFor(taskId, to)
      .filter((check) => check.required && !check.satisfied && !check.bypassed);
    if (checks.length > 0) return { to, checks };
  }
  return null;
}

/**
 * Gate cho `--dry-run`: state thật KHÔNG đổi trong lúc chiếu, nên phải đọc từ config
 * (`config/gates.yaml`) theo transition đang chiếu, không hỏi state store.
 */
function projectedGate(status: TaskStatus): { to: TaskStatus; gateIds: string[] } | null {
  for (const to of nextStatuses(status)) {
    const required = humanGatesForTransition(status, to).filter((gate) => gate.required);
    if (required.length > 0) return { to, gateIds: required.map((gate) => gate.id) };
  }
  return null;
}

function humanGateActions(taskId: string, gate: BlockingGate): string[] {
  const recordCommands = gate.checks.map(
    (check) =>
      `eng record ${taskId} --type HUMAN_APPROVAL --status PASS --gate-id ${check.gateId} ` +
      `--approver "<tên người duyệt>" --approved-at <ISO-8601>`,
  );
  return [...recordCommands, `eng continue ${taskId}   # chạy tiếp sau khi đã approve`];
}

function describeGate(gate: BlockingGate): string {
  return gate.checks.map((check) => `${check.gateId} (${check.transition})`).join(", ");
}

/**
 * Chạy các pha kế tiếp cho tới khi phải chờ người, gặp lỗi, hoặc đã DONE.
 * Trả về `ok: true` chỉ khi ticket đạt DONE — mọi điểm dừng khác đều là "chưa xong".
 */
export async function continueTicket(taskId: string, options: ContinueRunOptions = {}): Promise<ContinueResult> {
  const store = new StateStore(options.root === undefined ? {} : { root: options.root });
  const start = store.require(taskId);
  const maxSteps = Math.max(1, options.maxSteps ?? 8);
  const steps: ContinueStep[] = [];
  const warnings: string[] = [];
  const nextActions: string[] = [];

  const base = {
    taskId,
    from: start.status,
    steps,
    warnings,
    nextActions,
    dryRun: options.dryRun === true,
  };

  const currentGate = (status: TaskStatus): BlockingGate | null => blockingHumanGate(store, taskId, status);

  // ---------------------------------------------------------------- dry run
  if (options.dryRun === true) {
    let cursor = start.status;
    let stoppedBecause: ContinueStop = "MAX_STEPS";
    let stoppedDetail = `chiếu ${maxSteps} pha`;
    for (let i = 0; i < maxSteps; i += 1) {
      const gate = projectedGate(cursor);
      if (gate) {
        stoppedBecause = "HUMAN_GATE";
        stoppedDetail = `sẽ dừng ở human gate: ${gate.gateIds.join(", ")} (${cursor} → ${gate.to})`;
        nextActions.push(
          `eng record ${taskId} --type HUMAN_APPROVAL --status PASS --gate-id ${gate.gateIds[0]} ` +
            `--approver "<tên người duyệt>" --approved-at <ISO-8601>`,
          `eng continue ${taskId}   # chạy tiếp sau khi đã approve`,
        );
        break;
      }
      const phase = nextPhaseFor(cursor);
      if (phase === null) {
        stoppedBecause = cursor === "DONE" ? "DONE" : "NO_PHASE";
        stoppedDetail = cursor === "DONE" ? "ticket đã DONE" : `không có pha nào chạy tiếp từ ${cursor}`;
        break;
      }
      const endedAt = PHASES[phase].endsAt;
      steps.push({ phase, from: cursor, to: endedAt, ok: true, blocked: false, progressed: true });
      cursor = endedAt;
      if (cursor === "DONE") {
        stoppedBecause = "DONE";
        stoppedDetail = "ticket sẽ DONE";
        break;
      }
    }
    return {
      ...base,
      to: start.status,
      ok: false,
      blocked: false,
      stoppedBecause,
      stoppedDetail: `(dry run) ${stoppedDetail}`,
      openGates: [],
    };
  }

  if (start.blocked) {
    return {
      ...base,
      to: start.status,
      ok: false,
      blocked: true,
      stoppedBecause: "BLOCKED",
      stoppedDetail: `ticket đang BLOCKED: ${start.blockReason ?? "(không có lý do)"}`,
      openGates: [],
      nextActions: [`eng resume ${taskId}`, `eng recover ${taskId}`, `eng unblock ${taskId} khi đã xử lý`],
    };
  }

  if (start.status === "DONE") {
    return {
      ...base,
      to: "DONE",
      ok: true,
      blocked: false,
      stoppedBecause: "DONE",
      stoppedDetail: "ticket đã DONE",
      openGates: [],
      nextActions: [`eng metrics ${taskId} --write`],
    };
  }

  // ------------------------------------------------------------- chạy thật
  // Progress được gắn nhãn pha đang chạy để đọc log dài vẫn biết đang ở đâu.
  const userProgress = options.onProgress;
  let phaseLabel = String(start.status).toLowerCase();
  const orchestrator = new PhaseOrchestrator({
    ...options,
    ...(userProgress ? { onProgress: (message: string) => userProgress(`[${phaseLabel}] ${message}`) } : {}),
  });
  let cursor: TaskStatus = start.status;
  let stoppedBecause: ContinueStop = "MAX_STEPS";
  let stoppedDetail = `đã chạy ${maxSteps} pha trong một lần — chạy lại để tiếp tục`;
  let blocked = false;
  let ok = false;
  let lastResult: PhaseResult | null = null;
  /** Việc tiếp theo CHỈ của điểm dừng cuối — không gom lời nhắc cũ của các pha đã xong. */
  let stopActions: string[] = [];

  for (let i = 0; i < maxSteps; i += 1) {
    const gate = currentGate(cursor);
    if (gate) {
      stoppedBecause = "HUMAN_GATE";
      stoppedDetail = `cần người approve: ${describeGate(gate)}`;
      stopActions = humanGateActions(taskId, gate);
      blocked = true;
      break;
    }

    const phase = nextPhaseFor(cursor);
    if (phase === null) {
      stoppedBecause = "NO_PHASE";
      stoppedDetail = `không có pha nào chạy tiếp từ ${cursor}`;
      stopActions = [`eng resume ${taskId}`, `eng next ${taskId}`];
      blocked = true;
      break;
    }

    phaseLabel = phase;
    const result = await orchestrator.run(taskId, phase);
    lastResult = result;
    steps.push({
      phase,
      from: result.from,
      to: result.to,
      ok: result.ok,
      blocked: result.blocked,
      progressed: result.to !== result.from,
    });
    warnings.push(...result.warnings);

    if (!result.ok) {
      stoppedBecause = "EVIDENCE_OR_ERROR";
      stoppedDetail = result.blocked ? `${phase} bị chặn — xem gate/evidence bên dưới` : `${phase} thất bại`;
      stopActions = result.nextActions;
      blocked = result.blocked;
      break;
    }

    if (result.to === result.from) {
      stoppedBecause = "NO_PROGRESS";
      stoppedDetail = `${phase} không đổi trạng thái (${result.to}) — cần bước thủ công`;
      stopActions = result.nextActions;
      blocked = true;
      break;
    }

    cursor = result.to;
    if (cursor === "DONE") {
      stoppedBecause = "DONE";
      stoppedDetail = "ticket DONE";
      stopActions = [`eng metrics ${taskId} --write`, `eng resume ${taskId}`];
      ok = true;
      break;
    }
  }

  if (stoppedBecause === "MAX_STEPS") stopActions = [`eng continue ${taskId}   # chạy tiếp`, `eng resume ${taskId}`];

  const openGates = lastResult === null ? [] : store.gatesFor(taskId, lastResult.to);
  return {
    ...base,
    to: cursor,
    ok,
    blocked,
    stoppedBecause,
    stoppedDetail,
    openGates: openGates.filter((check) => !check.satisfied),
    warnings: [...new Set(warnings)],
    nextActions: stopActions.length > 0 ? [...new Set(stopActions)] : [`eng resume ${taskId}`],
  };
}
