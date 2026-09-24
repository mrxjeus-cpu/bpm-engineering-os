import type { Diagnosis } from "../recovery/engine.js";
import type { TaskStatus } from "../types.js";

export type PhaseName = "translate" | "analyze" | "design" | "plan" | "implement" | "review" | "audit" | "verify";

export interface PhaseStep {
  name: string;
  status: "ok" | "failed" | "skipped" | "blocked";
  detail?: string;
}

export interface PhaseResult {
  taskId: string;
  phase: PhaseName;
  title: string;
  from: TaskStatus;
  to: TaskStatus;
  ok: boolean;
  blocked: boolean;
  dryRun: boolean;
  steps: PhaseStep[];
  recovery?: Diagnosis;
  warnings: string[];
  nextActions: string[];
}

export interface PhaseSpec {
  name: PhaseName;
  title: string;
  /** Status được phép bắt đầu phase này. */
  allowedFrom: TaskStatus[];
  /** Mô tả các bước — dùng cho `--dry-run`. */
  steps: string[];
  /** Status đích khi phase thành công. */
  endsAt: TaskStatus;
}

export const PHASES: Record<PhaseName, PhaseSpec> = {
  translate: {
    name: "translate",
    title: "Dịch ticket → requirements",
    allowedFrom: ["NEW", "TRANSLATING"],
    steps: [
      "advance → TRANSLATING",
      "chạy agent researcher (harness) → requirements.md",
      "kiểm artifact requirements.md tồn tại thật",
      "advance → REQUIREMENT_ANALYSIS",
    ],
    endsAt: "REQUIREMENT_ANALYSIS",
  },
  analyze: {
    name: "analyze",
    title: "Phân tích yêu cầu + ảnh hưởng",
    allowedFrom: ["REQUIREMENT_ANALYSIS", "IMPACT_ANALYSIS"],
    steps: [
      "advance → IMPACT_ANALYSIS",
      "chạy agent impact (dùng mcp-engineering + mcp-domain-core) → impact.md",
      "kiểm artifact impact.md",
      "advance → DESIGNING",
    ],
    endsAt: "DESIGNING",
  },
  design: {
    name: "design",
    title: "Thiết kế + dừng ở human gate",
    allowedFrom: ["DESIGNING", "WAITING_DESIGN_APPROVAL"],
    steps: [
      "chạy agent architect → architecture.md (>=2 phương án)",
      "kiểm artifact architecture.md",
      "advance → WAITING_DESIGN_APPROVAL (chờ người approve — INV-05)",
    ],
    endsAt: "WAITING_DESIGN_APPROVAL",
  },
  plan: {
    name: "plan",
    title: "Lập kế hoạch + chia wave",
    allowedFrom: ["WAITING_DESIGN_APPROVAL", "PLANNING", "WAITING_PLAN_APPROVAL"],
    steps: [
      "kiểm HUMAN_APPROVAL gateId=architecture; advance → PLANNING",
      "nếu chưa có plan.md: chạy agent architect với skill writing-plan → plan.md",
      "eng plan import (parse + validate) + chia wave + conflict check (INV-11)",
      "advance → READY_TO_IMPLEMENT",
    ],
    endsAt: "READY_TO_IMPLEMENT",
  },
  implement: {
    name: "implement",
    title: "Thực thi theo wave",
    allowedFrom: ["READY_TO_IMPLEMENT", "IMPLEMENTING", "REWORK_REQUIRED", "DEBUGGING", "FAILED"],
    steps: [
      "advance → IMPLEMENTING",
      "compile context cho mọi task chưa DONE (context slicing)",
      "với từng wave: đánh dấu IN_PROGRESS → chạy developer agent cho từng task",
      "lỗi ⇒ recovery tự động (phân loại + recovery context + chuyển DEBUGGING/BLOCKED)",
      "thu evidence cơ học: run_tests + validate_scope (không tin lời agent)",
      "advance → REVIEWING nếu đủ evidence, ngược lại báo rõ còn thiếu gì",
    ],
    endsAt: "REVIEWING",
  },
  review: {
    name: "review",
    title: "Review 2 tầng theo task",
    allowedFrom: ["REVIEWING"],
    steps: [
      "với từng task đã DONE: chạy agent reviewer → reviews/TASK-NN-spec.md + quality.md",
      "kiểm artifact review tồn tại thật",
      "advance → AUDITING nếu có evidence SPEC_REVIEW + QUALITY_REVIEW",
    ],
    endsAt: "AUDITING",
  },
  audit: {
    name: "audit",
    title: "Audit ngân hàng",
    allowedFrom: ["AUDITING"],
    steps: [
      "chạy agent auditor → audit.md",
      "kiểm artifact audit.md",
      "advance → VERIFYING nếu có evidence AUDIT",
    ],
    endsAt: "VERIFYING",
  },
  verify: {
    name: "verify",
    title: "Verification cuối",
    allowedFrom: ["VERIFYING"],
    steps: [
      "thu evidence cơ học: run_build + run_tests + validate_scope",
      "đối chiếu acceptance criteria với evidence",
      "advance → DONE (risk CRITICAL cần thêm HUMAN_APPROVAL gateway finalVerification)",
    ],
    endsAt: "DONE",
  },
};

export const PHASE_NAMES = Object.keys(PHASES) as PhaseName[];

export function phaseSpec(name: string): PhaseSpec {
  const spec = PHASES[name as PhaseName];
  if (!spec) {
    // ném lỗi ở tầng CLI để thông báo có danh sách hợp lệ
    throw new Error(`unknown phase: ${name}`);
  }
  return spec;
}
