export type ToolContent = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * Lỗi có chủ đích của tool. Message phải nói rõ THIẾU GÌ để agent báo BLOCKED
 * thay vì tự suy diễn (INV-06).
 */
export class ToolError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

export function ok(data: unknown): ToolContent {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(error: unknown): ToolContent {
  // Lỗi từ runtime core (EngError) cũng có `code`/`hint` — giữ nguyên mã để agent xử lý đúng.
  const carrier = error as { code?: unknown; hint?: unknown; details?: Record<string, unknown> } | null;
  const code =
    error instanceof ToolError
      ? error.code
      : typeof carrier?.code === "string"
        ? carrier.code
        : "UNEXPECTED_ERROR";
  const hint =
    error instanceof ToolError ? error.hint : typeof carrier?.hint === "string" ? carrier.hint : undefined;
  const payload = {
    status: "ERROR",
    code,
    message: error instanceof Error ? error.message : String(error),
    hint,
    details: carrier?.details,
    note: "Không suy diễn dữ liệu khi thiếu nguồn (INV-06). Hãy set state = BLOCKED kèm lý do.",
  };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

export function blocked(reason: string, missing: string[], hint?: string): ToolContent {
  const payload = {
    status: "BLOCKED",
    reason,
    missing,
    hint,
    note: "Thiếu dữ liệu/nguồn ⇒ giữ trạng thái BLOCKED, không đoán (INV-06).",
  };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

/** Cắt chuỗi theo số byte tối đa, ghi rõ đã cắt để không âm thầm mất dữ liệu. */
export function capText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true };
}
