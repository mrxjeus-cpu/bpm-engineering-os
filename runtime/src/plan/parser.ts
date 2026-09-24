import { EngError } from "../errors.js";
import type { PlanTask, RiskLevel } from "../types.js";

/**
 * Parser plan.md → tasks (spec mục 9.3).
 *
 * Định dạng nguồn:
 *   ## TASK-01 — Tiêu đề
 *   ### Objective            (text tự do)
 *   ### Files                (- bullet hoặc "A.java, B.java")
 *   ### Symbols
 *   ### Dependencies         (none | TASK-01, TASK-02)
 *   ### Existing Pattern
 *   ### Deviation
 *   ### Business Rules
 *   ### Constraints
 *   ### Tests
 *   ### Acceptance Criteria  (bắt buộc, >= 1)
 *   ### Verification         (bắt buộc, >= 1)
 *
 * Chấp nhận cả "## Task 1", "### TASK-1:", heading có/không dấu — nhưng luôn chuẩn hoá về TASK-NN.
 */

export interface ParseError {
  code: "NO_TASKS" | "DUPLICATE_TASK" | "MISSING_OBJECTIVE" | "MISSING_ACCEPTANCE_CRITERIA" | "MISSING_VERIFICATION" | "INVALID_DEPENDENCY" | "INVALID_RISK";
  message: string;
  taskId?: string;
  line?: number;
}

export interface ParseResult {
  tasks: PlanTask[];
  errors: ParseError[];
  warnings: string[];
}

type FieldName =
  | "objective"
  | "files"
  | "symbols"
  | "dependencies"
  | "existingPattern"
  | "deviation"
  | "businessRules"
  | "constraints"
  | "tests"
  | "acceptanceCriteria"
  | "verification"
  | "risk"
  | "modelTier";

const FIELD_ALIASES: Record<string, FieldName> = {
  objective: "objective",
  "muc tieu": "objective",
  "mục tiêu": "objective",
  files: "files",
  file: "files",
  symbols: "symbols",
  symbol: "symbols",
  dependencies: "dependencies",
  dependency: "dependencies",
  "phu thuoc": "dependencies",
  "phụ thuộc": "dependencies",
  "depends on": "dependencies",
  "existing pattern": "existingPattern",
  "pattern co san": "existingPattern",
  "pattern có sẵn": "existingPattern",
  deviation: "deviation",
  "business rules": "businessRules",
  "business rule": "businessRules",
  constraints: "constraints",
  constraint: "constraints",
  "rang buoc": "constraints",
  "ràng buộc": "constraints",
  tests: "tests",
  test: "tests",
  "acceptance criteria": "acceptanceCriteria",
  "acceptance criterion": "acceptanceCriteria",
  ac: "acceptanceCriteria",
  "tieu chi nghiem thu": "acceptanceCriteria",
  "tiêu chí nghiệm thu": "acceptanceCriteria",
  verification: "verification",
  verify: "verification",
  "kiem chung": "verification",
  "kiểm chứng": "verification",
  risk: "risk",
  "model tier": "modelTier",
  model: "modelTier",
};

/**
 * Chỉ những field dạng "danh sách định danh" mới được cắt theo dấu phẩy.
 * Field văn xuôi (acceptance criteria, business rules...) phải giữ nguyên câu —
 * nếu không sẽ làm vỡ câu như "(sửa chữa không kết cấu, nội thất)".
 */
const SPLIT_FIELDS: FieldName[] = ["files", "symbols", "dependencies", "tests"];

interface Accumulator {
  id: string;
  title: string;
  headingLine: number;
  fields: Record<FieldName, string[]>;
}

function emptyFields(): Record<FieldName, string[]> {
  return {
    objective: [],
    files: [],
    symbols: [],
    dependencies: [],
    existingPattern: [],
    deviation: [],
    businessRules: [],
    constraints: [],
    tests: [],
    acceptanceCriteria: [],
    verification: [],
    risk: [],
    modelTier: [],
  };
}

function normalizeHeading(text: string): string {
  return text
    .trim()
    .replace(/[*_`]/g, "")
    .replace(/\s*:\s*$/, "")
    .toLowerCase();
}

function parseTaskHeading(line: string): { id: string; title: string } | null {
  const match = /^(#{2,4})\s*(?:TASK|CÔNG VIỆC)[-_\s]*0*(\d+)\b(.*)$/i.exec(line.trim());
  if (!match) return null;
  const [, , number, rest] = match;
  const id = `TASK-${String(Number.parseInt(number as string, 10)).padStart(2, "0")}`;
  const title = (rest ?? "")
    .replace(/^\s*[—–\-:.)]\s*/, "")
    .replace(/\s*[*_`]+\s*$/, "")
    .trim();
  return { id, title };
}

function stripBullet(line: string): string | null {
  const trimmed = line.trim();
  const bullet = /^(?:[-*+]\s+|\d+[.)]\s+)(.*)$/.exec(trimmed);
  if (bullet) return (bullet[1] ?? "").trim();
  if (/^\[[ xX]\]\s*/.test(trimmed)) return trimmed.replace(/^\[[ xX]\]\s*/, "").trim();
  return null;
}

function splitInlineList(text: string): string[] {
  return text
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter((item) => item !== "" && !/^none$/i.test(item));
}

export function parsePlanMarkdown(markdown: string): ParseResult {
  const lines = markdown.split(/\r?\n/);
  const accumulators: Accumulator[] = [];
  const errors: ParseError[] = [];
  const warnings: string[] = [];

  let current: Accumulator | null = null;
  let currentField: FieldName | null = null;
  let inCodeFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNumber = i + 1;

    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const heading = parseTaskHeading(line);
    if (heading) {
      current = { id: heading.id, title: heading.title === "" ? heading.id : heading.title, headingLine: lineNumber, fields: emptyFields() };
      accumulators.push(current);
      currentField = null;
      continue;
    }

    const fieldMatch = /^(#{3,5})\s*(.+?)\s*$/.exec(line);
    if (fieldMatch) {
      const raw = fieldMatch[2] ?? "";
      const [namePart, ...inlineParts] = raw.split(":");
      const key = FIELD_ALIASES[normalizeHeading(namePart ?? "")];
      currentField = key ?? null;
      if (current && key) {
        const inline = inlineParts.join(":").trim();
        if (inline !== "") {
          if (SPLIT_FIELDS.includes(key)) current.fields[key].push(...splitInlineList(inline));
          else current.fields[key].push(inline);
        }
      }
      continue;
    }

    if (!current || !currentField) continue;
    const trimmed = line.trim();
    if (trimmed === "") continue;

    const bullet = stripBullet(line);
    if (bullet !== null) {
      if (bullet === "") continue;
      if (SPLIT_FIELDS.includes(currentField)) current.fields[currentField].push(...splitInlineList(bullet));
      else current.fields[currentField].push(bullet);
      continue;
    }

    if (SPLIT_FIELDS.includes(currentField)) {
      current.fields[currentField].push(...splitInlineList(trimmed));
    } else {
      // dòng tiếp nối của một mục văn xuôi: nối vào mục trước thay vì tách thành mục mới
      const bucket = current.fields[currentField];
      const last = bucket.at(-1);
      if (last === undefined) bucket.push(trimmed);
      else bucket[bucket.length - 1] = `${last} ${trimmed}`;
    }
  }

  if (accumulators.length === 0) {
    errors.push({ code: "NO_TASKS", message: "Không tìm thấy task nào. Cần heading dạng '## TASK-01 — Tiêu đề'." });
    return { tasks: [], errors, warnings };
  }

  const seen = new Set<string>();
  const tasks: PlanTask[] = [];

  for (const accumulator of accumulators) {
    if (seen.has(accumulator.id)) {
      errors.push({
        code: "DUPLICATE_TASK",
        message: `Task ${accumulator.id} xuất hiện nhiều lần.`,
        taskId: accumulator.id,
        line: accumulator.headingLine,
      });
      continue;
    }
    seen.add(accumulator.id);

    const objective = accumulator.fields.objective.join(" ").trim();
    if (objective === "") {
      errors.push({
        code: "MISSING_OBJECTIVE",
        message: `${accumulator.id} thiếu mục "### Objective".`,
        taskId: accumulator.id,
        line: accumulator.headingLine,
      });
    }

    const acceptanceCriteria = dedupe(accumulator.fields.acceptanceCriteria);
    if (acceptanceCriteria.length === 0) {
      errors.push({
        code: "MISSING_ACCEPTANCE_CRITERIA",
        message: `${accumulator.id} thiếu "### Acceptance Criteria" (cần >= 1 mục).`,
        taskId: accumulator.id,
        line: accumulator.headingLine,
      });
    }

    const verification = dedupe(accumulator.fields.verification);
    if (verification.length === 0) {
      errors.push({
        code: "MISSING_VERIFICATION",
        message: `${accumulator.id} thiếu "### Verification" (cần >= 1 mục).`,
        taskId: accumulator.id,
        line: accumulator.headingLine,
      });
    }

    const dependencyText = accumulator.fields.dependencies.join(" ").trim();
    const dependencies = dedupe(
      /^none$/i.test(dependencyText) || dependencyText === ""
        ? []
        : [...dependencyText.matchAll(/\bTASK[-_\s]*0*(\d+)\b/gi)].map(
            (match) => `TASK-${String(Number.parseInt(match[1] as string, 10)).padStart(2, "0")}`,
          ),
    );

    const riskRaw = accumulator.fields.risk.join(" ").trim().toUpperCase();
    let risk: RiskLevel | undefined;
    if (riskRaw !== "") {
      if (["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(riskRaw)) risk = riskRaw as RiskLevel;
      else
        errors.push({
          code: "INVALID_RISK",
          message: `${accumulator.id}: risk "${riskRaw}" không hợp lệ (LOW|MEDIUM|HIGH|CRITICAL).`,
          taskId: accumulator.id,
          line: accumulator.headingLine,
        });
    }

    const existingPatternText = accumulator.fields.existingPattern.join(" ").trim();
    const deviationText = accumulator.fields.deviation.join(" ").trim();
    if (existingPatternText === "" && deviationText === "") {
      warnings.push(`${accumulator.id}: không khai báo "Existing Pattern" — skill existing-code-first yêu cầu nêu pattern có sẵn hoặc lý do không tái sử dụng.`);
    }

    const task: PlanTask = {
      id: accumulator.id,
      title: accumulator.title,
      objective,
      dependencies,
      acceptanceCriteria,
      verification,
      status: "PENDING",
      existingPattern: existingPatternText === "" ? null : existingPatternText,
      deviation: deviationText === "" ? null : deviationText,
    };
    const files = dedupe(accumulator.fields.files);
    const symbols = dedupe(accumulator.fields.symbols);
    const businessRules = dedupe(accumulator.fields.businessRules);
    const constraints = dedupe(accumulator.fields.constraints);
    const tests = dedupe(accumulator.fields.tests);
    if (files.length > 0) task.files = files;
    if (symbols.length > 0) task.symbols = symbols;
    if (businessRules.length > 0) task.businessRules = businessRules;
    if (constraints.length > 0) task.constraints = constraints;
    if (tests.length > 0) task.tests = tests;
    if (risk) task.risk = risk;
    const modelTier = accumulator.fields.modelTier.join(" ").trim();
    if (modelTier !== "") task.modelTier = modelTier;

    tasks.push(task);
  }

  // Kiểm tra dependency trỏ tới task không tồn tại
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!seen.has(dependency)) {
        errors.push({
          code: "INVALID_DEPENDENCY",
          message: `${task.id} phụ thuộc ${dependency} nhưng task này không có trong plan.`,
          taskId: task.id,
        });
      }
    }
  }

  return { tasks, errors, warnings };
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === "" || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}
