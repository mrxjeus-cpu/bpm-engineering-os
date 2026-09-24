import type { Evidence, EvidenceStatus, EvidenceType, RiskLevel, TaskStatus } from "../types.js";

export interface EvidenceRequirement {
  types: EvidenceType[];
  status: EvidenceStatus;
  description: string;
}

/**
 * RULES-001 (spec mục 8.4): điều kiện evidence để được chuyển sang một status.
 * Không có requirement ⇒ chỉ cần transition hợp lệ.
 */
export const EVIDENCE_REQUIREMENTS: Partial<Record<TaskStatus, EvidenceRequirement[]>> = {
  REVIEWING: [
    { types: ["TEST"], status: "PASS", description: "tests đã chạy và pass (có exit code)" },
    { types: ["SCOPE_VALIDATION"], status: "PASS", description: "diff đã kiểm, không có file ngoài scope (INV-04)" },
  ],
  AUDITING: [
    { types: ["SPEC_REVIEW"], status: "PASS", description: "spec review pass (đúng yêu cầu)" },
    { types: ["QUALITY_REVIEW"], status: "PASS", description: "quality review pass (đúng kỹ thuật)" },
  ],
  VERIFYING: [{ types: ["AUDIT"], status: "PASS", description: "audit pass (an toàn với hệ thống ngân hàng)" }],
  DONE: [
    { types: ["BUILD"], status: "PASS", description: "build pass" },
    { types: ["TEST"], status: "PASS", description: "test pass" },
    { types: ["SCOPE_VALIDATION"], status: "PASS", description: "scope validation pass" },
    { types: ["AUDIT"], status: "PASS", description: "audit pass" },
  ],
};

/** Risk CRITICAL cần thêm human approval cuối (config/risk.yaml → effects.CRITICAL). */
export const CRITICAL_FINAL_APPROVAL_GATE = "finalVerification";

export interface GateEvaluation {
  ok: boolean;
  target: TaskStatus;
  satisfied: string[];
  missing: string[];
}

export function evaluateEvidenceGate(
  target: TaskStatus,
  evidence: Evidence[],
  options: { risk?: RiskLevel } = {},
): GateEvaluation {
  const requirements = [...(EVIDENCE_REQUIREMENTS[target] ?? [])];

  if (target === "DONE" && options.risk === "CRITICAL") {
    requirements.push({
      types: ["HUMAN_APPROVAL"],
      status: "PASS",
      description: `human approval cuối cho task CRITICAL (gate ${CRITICAL_FINAL_APPROVAL_GATE})`,
    });
  }

  const satisfied: string[] = [];
  const missing: string[] = [];

  for (const requirement of requirements) {
    const found = evidence.find(
      (item) =>
        requirement.types.includes(item.type) &&
        item.status === requirement.status &&
        (requirement.types[0] !== "HUMAN_APPROVAL" || item.gateId === CRITICAL_FINAL_APPROVAL_GATE),
    );
    if (found) satisfied.push(`${requirement.types.join("|")}=${requirement.status}`);
    else missing.push(`${requirement.types.join("|")}=${requirement.status} — ${requirement.description}`);
  }

  return { ok: missing.length === 0, target, satisfied, missing };
}

export function evidenceByType(evidence: Evidence[], type: EvidenceType): Evidence[] {
  return evidence.filter((item) => item.type === type);
}
