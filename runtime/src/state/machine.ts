import { EngError } from "../errors.js";
import type { TaskPhase, TaskStatus } from "../types.js";

/** State machine theo spec mục 8.1. BLOCKED là cờ (blocked=true), không phải status. */
export const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  NEW: ["TRANSLATING"],
  TRANSLATING: ["REQUIREMENT_ANALYSIS"],
  REQUIREMENT_ANALYSIS: ["IMPACT_ANALYSIS"],
  IMPACT_ANALYSIS: ["DESIGNING"],
  DESIGNING: ["WAITING_DESIGN_APPROVAL"],
  WAITING_DESIGN_APPROVAL: ["PLANNING"],
  PLANNING: ["WAITING_PLAN_APPROVAL", "READY_TO_IMPLEMENT"],
  WAITING_PLAN_APPROVAL: ["READY_TO_IMPLEMENT"],
  READY_TO_IMPLEMENT: ["IMPLEMENTING"],
  IMPLEMENTING: ["REVIEWING", "FAILED"],
  FAILED: ["DEBUGGING", "IMPLEMENTING"],
  DEBUGGING: ["IMPLEMENTING"],
  REVIEWING: ["AUDITING", "REWORK_REQUIRED"],
  REWORK_REQUIRED: ["IMPLEMENTING"],
  AUDITING: ["VERIFYING", "REWORK_REQUIRED"],
  VERIFYING: ["DONE", "REWORK_REQUIRED"],
  DONE: [],
};

/** Status yêu cầu evidence trước khi được phép chuyển tới (INV-03 / RULES-001). */
export const EVIDENCE_GATED: TaskStatus[] = ["REVIEWING", "AUDITING", "VERIFYING", "DONE"];

const PHASE_BY_STATUS: Record<TaskStatus, TaskPhase> = {
  NEW: "translate",
  TRANSLATING: "translate",
  REQUIREMENT_ANALYSIS: "requirements",
  IMPACT_ANALYSIS: "impact",
  DESIGNING: "architecture",
  WAITING_DESIGN_APPROVAL: "architecture",
  PLANNING: "planning",
  WAITING_PLAN_APPROVAL: "planning",
  READY_TO_IMPLEMENT: "planning",
  IMPLEMENTING: "implementation",
  FAILED: "implementation",
  DEBUGGING: "implementation",
  REWORK_REQUIRED: "implementation",
  REVIEWING: "review",
  AUDITING: "audit",
  VERIFYING: "verification",
  DONE: "done",
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (canTransition(from, to)) return;
  const allowed = TRANSITIONS[from] ?? [];
  throw new EngError(
    "ILLEGAL_TRANSITION",
    `Không thể chuyển ${from} → ${to}.`,
    {
      hint:
        allowed.length === 0
          ? `${from} là trạng thái kết thúc, không có transition nào.`
          : `Từ ${from} chỉ được chuyển sang: ${allowed.join(", ")} (spec mục 8.1).`,
      details: { from, to, allowed },
    },
  );
}

export function isEvidenceGated(to: TaskStatus): boolean {
  return EVIDENCE_GATED.includes(to);
}

export function nextStatuses(from: TaskStatus): TaskStatus[] {
  return TRANSITIONS[from] ?? [];
}

export function phaseForStatus(status: TaskStatus): TaskPhase {
  return PHASE_BY_STATUS[status];
}

export function isTerminal(status: TaskStatus): boolean {
  return (TRANSITIONS[status] ?? []).length === 0;
}
