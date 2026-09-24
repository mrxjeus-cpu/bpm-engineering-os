/**
 * Lỗi có mã của runtime. `code` là phần hợp đồng với CLI và MCP:
 * agent phải đọc được lý do để chuyển trạng thái sang BLOCKED thay vì đoán (INV-06).
 */
export class EngError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, options: { hint?: string; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "EngError";
    this.code = code;
    if (options.hint !== undefined) this.hint = options.hint;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function isEngError(value: unknown): value is EngError {
  return value instanceof EngError || (typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string" && value instanceof Error);
}
