export type ToolContent = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Lỗi có chủ đích: nói rõ thiếu gì để agent báo BLOCKED thay vì tự suy diễn (INV-06). */
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
  const isToolError = error instanceof ToolError;
  const payload = {
    status: "ERROR",
    code: isToolError ? error.code : "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error),
    hint: isToolError ? error.hint : undefined,
    note: "Domain data phải đến từ nguồn có thật. Không suy diễn policy/rule khi thiếu dữ liệu (INV-06).",
  };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

export function blocked(reason: string, missing: string[], hint?: string): ToolContent {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { status: "BLOCKED", reason, missing, hint, note: "Giữ trạng thái BLOCKED, không đoán (INV-06)." },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}
