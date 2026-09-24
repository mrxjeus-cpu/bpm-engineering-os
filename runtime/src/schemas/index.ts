import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { EngError } from "../errors.js";
import { OS_ROOT } from "../paths.js";

// ajv / ajv-formats chỉ phát hành bản CJS. Dùng createRequire để tránh lệch interop ESM↔CJS
// (với verbatimModuleSyntax, default import của module CJS không giữ đúng kiểu hàm/constructor).
const requireCjs = createRequire(import.meta.url);
const Ajv2020Class = requireCjs("ajv/dist/2020.js") as typeof import("ajv/dist/2020.js").default;
const addFormatsFn = requireCjs("ajv-formats") as typeof import("ajv-formats").default;

export type SchemaName = "task" | "evidence" | "plan" | "context" | "review" | "event" | "recovery";

const SCHEMA_FILES: Record<SchemaName, string> = {
  task: "task.schema.json",
  evidence: "evidence.schema.json",
  plan: "plan.schema.json",
  context: "context.schema.json",
  review: "review.schema.json",
  event: "event.schema.json",
  recovery: "recovery.schema.json",
};

const ajv = new Ajv2020Class({ allErrors: true, strict: false, allowUnionTypes: true });
addFormatsFn(ajv);

type Validator = ((data: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };

const validators = new Map<SchemaName, Validator>();

function loadValidator(name: SchemaName): Validator {
  const cached = validators.get(name);
  if (cached) return cached;

  const file = path.join(OS_ROOT, "schemas", SCHEMA_FILES[name]);
  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new EngError("SCHEMA_LOAD_FAILED", `Không đọc được schema ${file}: ${String(error)}`, {
      hint: "Kiểm tra thư mục schemas/ có bị thiếu file không.",
    });
  }
  const compiled = ajv.compile(schema as object) as Validator;
  validators.set(name, compiled);
  return compiled;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateWith(schemaName: SchemaName, value: unknown): ValidationResult {
  const validator = loadValidator(schemaName);
  const valid = validator(value);
  if (valid) return { valid: true, errors: [] };
  const errors = (validator.errors ?? []).map(
    (err) => `${err.instancePath === "" ? "/" : err.instancePath} ${err.message ?? "không hợp lệ"}`.trim(),
  );
  return { valid: false, errors };
}

/** Validate và ném lỗi SCHEMA_INVALID — dùng trước mọi lần ghi file state/evidence/event. */
export function assertValid(schemaName: SchemaName, value: unknown, context: string): void {
  const result = validateWith(schemaName, value);
  if (!result.valid) {
    throw new EngError("SCHEMA_INVALID", `${context} không khớp ${SCHEMA_FILES[schemaName]}: ${result.errors.join("; ")}`, {
      hint: `Sửa dữ liệu cho khớp schemas/${SCHEMA_FILES[schemaName]}. Không ghi dữ liệu sai schema vào workstream (INV-02).`,
      details: { errors: result.errors },
    });
  }
}
