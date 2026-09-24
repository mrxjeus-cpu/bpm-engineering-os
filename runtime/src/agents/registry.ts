import { EngError } from "../errors.js";

export type AgentRole = "researcher" | "impact" | "architect" | "developer" | "reviewer" | "auditor";

export interface AgentInput {
  /** Đường dẫn tương đối trong workstream; hỗ trợ {subTaskId}. */
  path: string;
  description: string;
  optional?: boolean;
}

export interface AgentContract {
  role: AgentRole;
  title: string;
  /** Đưa vào phần ROLE của prompt contract. */
  rolePrompt: string;
  inputs: AgentInput[];
  /** Artifact PHẢI có sau khi chạy (kiểm tra thật, không tin lời agent). */
  outputs: string[];
  /** Bắt buộc đọc context/<TASK-NN>.json trước khi làm. */
  requiresContext?: boolean;
  /** Template output trong templates/ giúp artifact của worker đúng cấu trúc. */
  templates?: string[];
  expectedOutput: string[];
  doNot: string[];
}

/**
 * Hợp đồng 6 agent (spec mục 10). Đây là dữ liệu, không phải prompt —
 * prompt được render theo prompt contract 9 phần ở `prompt.ts`.
 */
export const AGENTS: Record<AgentRole, AgentContract> = {
  researcher: {
    role: "researcher",
    title: "Researcher / Translator",
    rolePrompt:
      "Bạn là Researcher/Translator: chuyển ticket thô thành yêu cầu kỹ thuật rõ ràng, có thể kiểm chứng. Bạn KHÔNG viết code.",
    inputs: [
      { path: "ticket.md", description: "nội dung ticket thô", optional: true },
      { path: "requirements.md", description: "requirements hiện có (nếu đã có)", optional: true },
    ],
    outputs: ["requirements.md"],
    templates: ["requirement.md"],
    expectedOutput: [
      "requirements.md: WHAT thay đổi · WHY · WHO bị ảnh hưởng · WHAT giữ nguyên · business rules",
      "open_questions.md: câu hỏi còn mở (nếu có)",
      "assumptions.md: giả định đã dùng (nếu có)",
    ],
    doNot: [
      "Không viết hoặc sửa code.",
      "Không tự chốt business rule khi ticket không nói rõ — đưa vào open_questions.",
    ],
  },
  impact: {
    role: "impact",
    title: "Impact agent",
    rolePrompt:
      "Bạn là Impact agent: xác định phạm vi ảnh hưởng của thay đổi trên code/DB/API/policy. Bạn KHÔNG viết code.",
    inputs: [
      { path: "requirements.md", description: "yêu cầu đã phân tích" },
      { path: "architecture.md", description: "kiến trúc hiện có (nếu có)", optional: true },
    ],
    outputs: ["impact.md"],
    templates: ["impact.md"],
    expectedOutput: [
      "impact.md: affected service / module / class / DB / downstream / API / policy / fact / external / test",
      "khu vực có nguy cơ regression",
      "điểm chưa xác định được (unknowns)",
    ],
    doNot: [
      "Không sửa source code.",
      "Không kết luận impact từ suy đoán — nêu rõ phần chưa kiểm chứng được.",
    ],
  },
  architect: {
    role: "architect",
    title: "Solution Architect",
    rolePrompt:
      "Bạn là Solution Architect: đề xuất và so sánh phương án thiết kế, chốt một quyết định kèm trade-off. Bạn KHÔNG viết code.",
    inputs: [
      { path: "requirements.md", description: "yêu cầu" },
      { path: "impact.md", description: "phân tích ảnh hưởng" },
    ],
    outputs: ["architecture.md"],
    templates: ["design.md"],
    expectedOutput: [
      "architecture.md: Problem · Current · Proposed · Alternatives (A/B/C) · Decision · Trade-offs",
      "Affected Components · Migration · Testing · Risks · Rollback",
    ],
    doNot: [
      "Không viết code.",
      "Không đưa ra chỉ một phương án duy nhất mà không so sánh.",
    ],
  },
  developer: {
    role: "developer",
    title: "Developer (fresh context)",
    rolePrompt:
      "Bạn là Developer: thực hiện ĐÚNG một task con theo context được cấp, theo TDD (viết/đổi test trước, thấy test fail, rồi implement tối thiểu).",
    inputs: [
      { path: "context/{subTaskId}.md", description: "context tối thiểu của task (BẮT BUỘC đọc)" },
      { path: "architecture.md", description: "quyết định kiến trúc đã approve", optional: true },
      { path: "plan.md", description: "chỉ đọc phần task của mình", optional: true },
    ],
    outputs: ["tasks/{subTaskId}-report.md"],
    templates: ["task-report.md"],
    requiresContext: true,
    expectedOutput: [
      "code changes đúng phạm vi Files trong context",
      "test đã chạy + kết quả thật (command + exit code)",
      "tasks/{subTaskId}-report.md: đã đổi gì · test nào · evidence · vấn đề còn lại",
    ],
    doNot: [
      "Không xóa hoặc đổi business logic ngoài scope (INV-04).",
      "Không sửa file ngoài danh sách Files của task.",
      "Không tự thay đổi architecture decision đã approve.",
      "Không tạo abstraction mới khi đã có pattern tương tự trong context.",
      "Không tuyên bố hoàn thành khi chưa chạy test và đọc output thật.",
    ],
  },
  reviewer: {
    role: "reviewer",
    title: "Reviewer (spec + quality)",
    rolePrompt:
      "Bạn là Reviewer độc lập: review 2 tầng — spec compliance (đúng yêu cầu?) và code quality (đúng kỹ thuật?). Bạn KHÔNG sửa code.",
    inputs: [
      { path: "context/{subTaskId}.md", description: "context của task" },
      { path: "tasks/{subTaskId}-report.md", description: "báo cáo của developer", optional: true },
      { path: "requirements.md", description: "yêu cầu gốc", optional: true },
      { path: "architecture.md", description: "thiết kế đã approve", optional: true },
    ],
    outputs: ["reviews/{subTaskId}-spec.md"],
    templates: ["review.md"],
    requiresContext: true,
    expectedOutput: [
      "reviews/{subTaskId}-spec.md: đối chiếu acceptance criteria + business rule, PASS/FAIL",
      "reviews/{subTaskId}-quality.md: pattern, naming, test, transaction boundary, duplicate",
      "mỗi issue: severity (BLOCKER/MAJOR/MINOR/NIT) + file + lý do",
    ],
    doNot: [
      "Không sửa code (chỉ báo cáo).",
      "Không claim đã chạy test — chỉ đọc evidence do producer tạo; thiếu evidence thì báo BLOCKED.",
    ],
  },
  auditor: {
    role: "auditor",
    title: "Auditor (banking)",
    rolePrompt:
      "Bạn là Auditor: đánh giá thay đổi có AN TOÀN với hệ thống ngân hàng không (khác với review 'code có đúng không'). Bạn KHÔNG sửa code.",
    inputs: [
      { path: "requirements.md", description: "yêu cầu" },
      { path: "architecture.md", description: "thiết kế", optional: true },
      { path: "reviews", description: "kết quả review theo task", optional: true },
    ],
    outputs: ["audit.md"],
    templates: ["audit.md"],
    expectedOutput: [
      "audit.md: requirement coverage · architecture compliance · unexpected behavior change",
      "security · data integrity · backward compatibility · logging · exception handling",
      "transaction boundaries · concurrency · performance",
    ],
    doNot: [
      "Không sửa code.",
      "Không kết luận 'an toàn' khi chưa kiểm tra tương thích ngược và dữ liệu cũ.",
    ],
  },
};

export const AGENT_ROLES = Object.keys(AGENTS) as AgentRole[];

export function agentContract(role: string): AgentContract {
  const contract = AGENTS[role as AgentRole];
  if (!contract) {
    throw new EngError("UNKNOWN_AGENT", `Không có agent "${role}".`, {
      hint: `Agent hợp lệ: ${AGENT_ROLES.join(", ")}`,
    });
  }
  return contract;
}

export function fillPath(template: string, vars: { taskId: string; subTaskId?: string }): string {
  return template
    .replaceAll("{taskId}", vars.taskId)
    .replaceAll("{subTaskId}", vars.subTaskId ?? "TASK");
}
