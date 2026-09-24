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

/**
 * Evidence CHỈ có nghĩa trong một repo (spec 9.4): build/test/scope chạy trong một repo cụ thể.
 * Ticket chạm nhiều repo ⇒ các loại này phải có cho TỪNG repo.
 *
 * Ngược lại, review / audit / human approval là đánh giá trên TOÀN BỘ thay đổi của ticket
 * (một người/agent review cả feature), nên vẫn là yêu cầu cấp ticket — nếu bắt theo từng repo
 * sẽ chặn oan và không phản ánh cách review thật.
 */
const REPO_SCOPED_EVIDENCE: EvidenceType[] = ["BUILD", "TEST", "SCOPE_VALIDATION"];

function isRepoScopped(requirement: EvidenceRequirement): boolean {
  return requirement.types.some((type) => REPO_SCOPED_EVIDENCE.includes(type));
}

export interface GateEvaluation {
  ok: boolean;
  target: TaskStatus;
  satisfied: string[];
  missing: string[];
}

export function evaluateEvidenceGate(
  target: TaskStatus,
  evidence: Evidence[],
  options: { risk?: RiskLevel; projects?: string[] } = {},
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

  // Cấp ticket: review / audit / human approval.
  const ticketLevel = requirements.filter((requirement) => !isRepoScopped(requirement));
  // Cấp repo: build / test / scope — phải có cho từng repo khi ticket có >= 2 repo.
  const perRepo = requirements.filter(isRepoScopped);

  const matches = (requirement: EvidenceRequirement, item: Evidence): boolean =>
    requirement.types.includes(item.type) && item.status === requirement.status;

  for (const requirement of ticketLevel) {
    const needsGate = requirement.types.includes("HUMAN_APPROVAL");
    const found = evidence.find(
      (item) => matches(requirement, item) && (!needsGate || item.gateId === CRITICAL_FINAL_APPROVAL_GATE),
    );
    if (found) satisfied.push(`${requirement.types.join("|")}=${requirement.status}`);
    else missing.push(`${requirement.types.join("|")}=${requirement.status} — ${requirement.description}`);
  }

  /**
   * Multi-repo (spec 9.4): ticket chạm >= 2 repo thì evidence cơ học phải có cho TỪNG repo,
   * và phải nêu rõ `project`. Ticket 1 repo giữ nguyên hành vi cũ (evidence không cần gắn repo).
   */
  const projects = [...new Set((options.projects ?? []).filter((name) => name !== ""))];

  if (projects.length <= 1) {
    for (const requirement of perRepo) {
      const found = evidence.find((item) => matches(requirement, item));
      if (found) satisfied.push(`${requirement.types.join("|")}=${requirement.status}`);
      else missing.push(`${requirement.types.join("|")}=${requirement.status} — ${requirement.description}`);
    }
    return { ok: missing.length === 0, target, satisfied, missing };
  }

  for (const project of projects) {
    for (const requirement of perRepo) {
      const found = evidence.find((item) => matches(requirement, item) && item.project === project);
      const label = `${requirement.types.join("|")}=${requirement.status}`;
      if (found) satisfied.push(`${project}: ${label}`);
      else missing.push(`${project}: ${label} — ${requirement.description} (evidence chưa gắn repo "${project}")`);
    }
  }

  return { ok: missing.length === 0, target, satisfied, missing };
}

export function evidenceByType(evidence: Evidence[], type: EvidenceType): Evidence[] {
  return evidence.filter((item) => item.type === type);
}
