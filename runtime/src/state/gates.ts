import { type GateConfig, humanGatesForTransition, modeConfig } from "../config/index.js";
import { EngError } from "../errors.js";
import type { Evidence, ExecutionMode, RiskLevel, TaskState } from "../types.js";

const RISK_RANK: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export interface GateCheck {
  gateId: string;
  transition: string;
  required: boolean;
  bypassed: boolean;
  bypassReason?: string;
  satisfied: boolean;
  approver?: string | null;
}

/** `requiredIfAny` được đối chiếu với riskFactors của task (spec mục 11.1). */
export function effectiveRequired(gate: GateConfig, state: Pick<TaskState, "riskFactors">): boolean {
  if (gate.required) return true;
  const flags = gate.requiredIfAny ?? [];
  if (flags.length === 0) return false;
  const factors = state.riskFactors ?? [];
  return flags.some((flag) => factors.includes(flag));
}

export function bypassDecision(
  gate: GateConfig,
  options: { mode: ExecutionMode; risk: RiskLevel; allowBypass: boolean },
): { bypassed: boolean; reason?: string } {
  if ((gate.bypassInModes ?? []).includes(options.mode)) {
    return { bypassed: true, reason: `mode "${options.mode}" được phép bỏ qua gate này` };
  }
  if (gate.bypassIfRiskAtMost && RISK_RANK[options.risk] <= RISK_RANK[gate.bypassIfRiskAtMost]) {
    if (gate.bypassRequiresConfigFlag && !options.allowBypass) {
      return { bypassed: false };
    }
    return {
      bypassed: true,
      reason: `risk ${options.risk} ≤ ${gate.bypassIfRiskAtMost}${options.allowBypass ? " + cờ allow-bypass" : ""}`,
    };
  }
  return { bypassed: false };
}

export function checkHumanGates(
  state: Pick<TaskState, "status" | "risk" | "mode" | "riskFactors">,
  to: string,
  evidence: Evidence[],
  options: { allowBypass?: boolean } = {},
): GateCheck[] {
  const gates = humanGatesForTransition(state.status, to);
  return gates.map((gate) => {
    const required = effectiveRequired(gate, state);
    const bypass = bypassDecision(gate, {
      mode: state.mode,
      risk: state.risk,
      allowBypass: options.allowBypass === true,
    });
    const approval = evidence.find(
      (item) => item.type === "HUMAN_APPROVAL" && item.gateId === gate.id && item.status === "PASS",
    );
    const check: GateCheck = {
      gateId: gate.id,
      transition: `${state.status} → ${to}`,
      required,
      bypassed: bypass.bypassed,
      satisfied: approval !== undefined,
    };
    if (bypass.reason !== undefined) check.bypassReason = bypass.reason;
    if (approval) check.approver = approval.approver ?? null;
    return check;
  });
}

/** Ném lỗi nếu còn human gate bắt buộc chưa được approve (INV-05). */
export function assertHumanGates(
  state: Pick<TaskState, "taskId" | "status" | "risk" | "mode" | "riskFactors">,
  to: string,
  evidence: Evidence[],
  options: { allowBypass?: boolean } = {},
): GateCheck[] {
  const checks = checkHumanGates(state, to, evidence, options);
  const blocked = checks.filter((check) => check.required && !check.bypassed && !check.satisfied);
  if (blocked.length > 0) {
    throw new EngError(
      "HUMAN_APPROVAL_REQUIRED",
      `Chuyển ${state.status} → ${to} cần human approval cho gate: ${blocked.map((c) => c.gateId).join(", ")}.`,
      {
        hint:
          `Ghi approval bằng evidence HUMAN_APPROVAL (gateId, approver, approvedAt), ` +
          `hoặc dùng --allow-bypass nếu gate cho phép (INV-05).`,
        details: { gates: blocked },
      },
    );
  }
  return checks;
}

/** Gate đang mở (chưa approve) cho các transition kế tiếp — dùng cho `eng resume`. */
export function openGatesFor(state: TaskState, evidence: Evidence[], nextStatuses: string[]): GateCheck[] {
  const open: GateCheck[] = [];
  for (const next of nextStatuses) {
    for (const check of checkHumanGates(state, next, evidence)) {
      if (check.required && !check.bypassed && !check.satisfied) open.push(check);
    }
  }
  return open;
}

export function modeSummary(mode: ExecutionMode): { humanGates: string[]; allowedRisk: RiskLevel[] } {
  const config = modeConfig(mode);
  return { humanGates: config.humanGates, allowedRisk: config.allowedRisk };
}
