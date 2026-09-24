import type { AgentContract } from "./registry.js";

export interface PromptInputRef {
  path: string;
  description: string;
  present: boolean;
  optional?: boolean;
}

export interface PromptSkillRef {
  name: string;
  file: string;
  reasons: string[];
  body: string;
}

export interface PromptTemplateRef {
  name: string;
  path: string;
  content: string;
}

export interface PromptRequest {
  contract: AgentContract;
  taskId: string;
  subTaskId?: string;
  objective: string;
  constraints: string[];
  verification: string[];
  acceptanceCriteriaCount: number;
  /** Đường dẫn file context — KHÔNG nhúng nội dung (INV-01). */
  contextPath?: string;
  inputs: PromptInputRef[];
  tier: string;
  tierReason: string;
  extraInstructions?: string;
  /** Skill được router chọn theo role/phase/task (HOW). */
  skills?: PromptSkillRef[];
  /** Template output để artifact của worker đúng cấu trúc. */
  templates?: PromptTemplateRef[];
}

/**
 * Prompt contract 9 phần (spec mục 10/31).
 *
 * Nguyên tắc INV-01: CONTEXT chỉ là ĐƯỜNG DẪN. Prompt chỉ nhúng phần ngắn (objective,
 * constraints, verification, số lượng AC). Phần nặng (symbol snippet, business rule dài,
 * danh sách file) nằm trong file context để worker tự đọc.
 */
export function renderAgentPrompt(request: PromptRequest): string {
  const { contract } = request;
  const lines: string[] = [];
  const fill = (text: string): string =>
    text
      .replaceAll("{taskId}", request.taskId)
      .replaceAll("{subTaskId}", request.subTaskId ?? "TASK");

  lines.push(`# Prompt contract — ${contract.title}`);
  lines.push("");
  lines.push("ROLE");
  lines.push(contract.rolePrompt);
  lines.push("");
  lines.push("OBJECTIVE");
  lines.push(request.objective.trim() === "" ? "(chưa có objective — đọc INPUTS để xác định)" : request.objective.trim());
  lines.push("");
  lines.push("TASK");
  lines.push(
    `${request.taskId}${request.subTaskId ? ` / ${request.subTaskId}` : ""} — agent: ${contract.role} (model tier: ${request.tier})`,
  );
  lines.push(`Lý do chọn tier: ${request.tierReason}`);
  lines.push("");
  lines.push("CONTEXT");
  lines.push(
    request.contextPath
      ? `Đọc file này TRƯỚC KHI LÀM, không cần mở toàn bộ repo: ${request.contextPath}`
      : "Không có file context riêng cho bước này — chỉ dùng INPUTS bên dưới.",
  );
  lines.push(
    `Acceptance criteria: ${request.acceptanceCriteriaCount} mục (nội dung nằm trong context, KHÔNG nhúng ở đây).`,
  );
  lines.push("");
  lines.push("INPUTS");
  if (request.inputs.length === 0) lines.push("- (không có)");
  for (const input of request.inputs) {
    const state = input.present ? "có" : input.optional === true ? "thiếu (tuỳ chọn)" : "THIẾU";
    lines.push(`- ${input.path} — ${input.description} [${state}]`);
  }
  lines.push("");
  lines.push("CONSTRAINTS");
  for (const constraint of request.constraints) lines.push(`- ${constraint}`);
  lines.push("");

  if (request.skills && request.skills.length > 0) {
    lines.push("SKILLS (HOW — bắt buộc tuân theo)");
    for (const skill of request.skills) {
      lines.push(`--- skill: ${skill.name} (${skill.file}) — kích hoạt vì ${skill.reasons.join(" · ")} ---`);
      lines.push(skill.body.trim());
      lines.push("");
    }
  }

  lines.push("EXPECTED OUTPUT");
  for (const output of contract.expectedOutput) lines.push(`- ${fill(output)}`);
  if (request.templates && request.templates.length > 0) {
    lines.push("");
    lines.push("OUTPUT FORMAT (theo template)");
    for (const template of request.templates) {
      lines.push(`--- template: ${template.name} (${template.path}) ---`);
      lines.push(template.content.trim());
      lines.push("");
    }
  }
  lines.push("");
  lines.push("VERIFICATION");
  if (request.verification.length === 0) lines.push("- Chưa có tiêu chí kiểm chứng trong context — nêu rõ cách bạn tự kiểm.");
  for (const item of request.verification) lines.push(`- ${fill(item)}`);
  lines.push("");
  lines.push("DO NOT");
  const doNot = [
    ...contract.doNot.map(fill),
    "Không tự tuyên bố DONE/approved thay cho cổng verification của hệ thống (INV-03).",
    "Nếu thiếu dữ liệu hoặc MCP không dùng được: DỪNG và báo BLOCKED kèm lý do cụ thể, không đoán (INV-06).",
  ];
  for (const item of [...new Set(doNot)]) lines.push(`- ${item}`);
  lines.push("");

  if (request.extraInstructions && request.extraInstructions.trim() !== "") {
    lines.push("ADDITIONAL INSTRUCTIONS (từ agents/<role>.md)");
    lines.push(request.extraInstructions.trim());
    lines.push("");
  }

  return lines.join("\n");
}

export function estimatePromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}
