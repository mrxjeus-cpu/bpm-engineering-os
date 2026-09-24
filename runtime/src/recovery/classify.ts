import { readFileSync } from "node:fs";
import path from "node:path";
import type { Evidence } from "../types.js";
import { listFilesRecursive, workstreamDir } from "../workspace.js";

export type FailureCategory =
  | "COMPILE_ERROR"
  | "TEST_FAILURE"
  | "MISSING_CONTEXT"
  | "MCP_FAILURE"
  | "DESIGN_CONFLICT"
  | "FILE_CONFLICT"
  | "ENVIRONMENT_FAILURE"
  | "UNKNOWN";

export interface Signal {
  source: string;
  detail: string;
}

export interface LogSignal {
  path: string;
  role: string;
  subTaskId?: string;
  exitCode?: number;
  command?: string;
  stderrTail: string;
  stdoutTail: string;
}

export interface ClassifyInput {
  logs: LogSignal[];
  blockedReason?: string | null;
  evidence: Evidence[];
  contextPresent: boolean;
  /** Role hiện tại có bắt buộc context không (developer/reviewer) — dùng cho heuristic cuối. */
  roleRequiresContext?: boolean;
  expectedArtifactsMissing: string[];
}

export interface Classification {
  category: FailureCategory;
  confidence: "high" | "medium" | "low";
  signals: Signal[];
  evidenceRefs: string[];
}

const PATTERNS: Record<Exclude<FailureCategory, "UNKNOWN">, RegExp[]> = {
  MCP_FAILURE: [
    /MCP_SERVER_UNREACHABLE/i,
    /MCP_SERVER_EXITED/i,
    /MCP_TIMEOUT/i,
    /MCP_SERVER_NOT_CONFIGURED/i,
    /MCP không dùng được|mcp-engineering unavailable|mcp-domain-core unavailable/i,
    /Cannot verify current policy definition/i,
  ],
  MISSING_CONTEXT: [
    /CONTEXT_REQUIRED/i,
    /STATE_NOT_FOUND/i,
    /PLAN_NOT_FOUND/i,
    /thiếu context|missing context|context chưa compile/i,
    /unknowns/i,
  ],
  DESIGN_CONFLICT: [
    /DESIGN_CONFLICT/i,
    /HUMAN_APPROVAL_REQUIRED/i,
    /architecture (decision|conflict)|xung đột thiết kế|đi lệch (quyết định )?kiến trúc/i,
  ],
  COMPILE_ERROR: [
    /error TS\d+/,
    /cannot find symbol/i,
    /COMPILATION ERROR/i,
    /BUILD FAILURE/i,
    /\[ERROR\]/,
    /SyntaxError/i,
    /error:\s+.*expected\s+['"`;)]/i,
  ],
  TEST_FAILURE: [
    /Tests run:.*Failures: [1-9]/i,
    /AssertionError|AssertionFailedError/,
    /expected:.*but was:/i,
    /\bFAILED\b/,
    /test failed|test fail/i,
    /exit code 3\b/,
  ],
  ENVIRONMENT_FAILURE: [
    /command not found/i,
    /EACCES|EPERM/,
    /ENOENT: no such file or directory/i,
    /permission denied/i,
    /ENOTFOUND|ETIMEDOUT|ECONNREFUSED/,
    /not recognized as an internal or external command/i,
  ],
  FILE_CONFLICT: [/FILE_OVERLAP|SYMBOL_OVERLAP/, /unexpectedFiles|deletedFiles/, /ngoài scope|out of scope/i],
};

function matchAny(text: string, patterns: RegExp[]): RegExp | null {
  for (const pattern of patterns) if (pattern.test(text)) return pattern;
  return null;
}

function firstMatchingLine(text: string, pattern: RegExp): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (pattern.test(line)) return line.trim().slice(0, 300);
  }
  return undefined;
}

/** Đọc log harness do AgentRunner ghi (định dạng: `# exit: N`, `--- stdout ---`, `--- stderr ---`). */
export function readHarnessLogs(taskId: string, subTaskId?: string, root?: string): LogSignal[] {
  const dir = workstreamDir(taskId, root);
  const files = listFilesRecursive(dir).filter((file) => file.startsWith("tasks/") && file.endsWith(".log"));
  const wanted = subTaskId ? files.filter((file) => file.includes(subTaskId)) : files;
  const logs: LogSignal[] = [];

  for (const file of wanted.sort().reverse().slice(0, 4)) {
    let text: string;
    try {
      text = readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    const base = path.basename(file, ".log");
    const [role = base, sub] = base.split("-");
    const exitMatch = /# exit:\s*(-?\d+)/.exec(text);
    const commandMatch = /^\$\s*(.+)$/m.exec(text);
    const stderrIndex = text.indexOf("--- stderr ---");
    const stdoutIndex = text.indexOf("--- stdout ---");
    const log: LogSignal = {
      path: file,
      role,
      stderrTail: stderrIndex >= 0 ? text.slice(stderrIndex + "--- stderr ---".length).trim() : "",
      stdoutTail: stdoutIndex >= 0 ? text.slice(stdoutIndex + "--- stdout ---".length, stderrIndex >= 0 ? stderrIndex : undefined).trim() : "",
    };
    if (exitMatch?.[1] !== undefined) log.exitCode = Number.parseInt(exitMatch[1], 10);
    if (commandMatch?.[1]) log.command = commandMatch[1].trim().slice(0, 200);
    if (sub && /^TASK-?\d+$/i.test(sub)) log.subTaskId = sub;
    logs.push(log);
  }
  return logs;
}

/**
 * Phân loại lỗi bằng rule tất định (spec mục 15).
 *
 * Không dùng LLM: phân loại sai sẽ dẫn tới sửa sai hướng và lặp vô hạn.
 * Thứ tự kiểm tra có chủ đích: lỗi hạ tầng/ngữ cảnh xét TRƯỚC lỗi code,
 * vì sửa code khi thiếu ngữ cảnh là vô nghĩa.
 */
export function classifyFailure(input: ClassifyInput): Classification {
  const signals: Signal[] = [];
  const evidenceRefs: string[] = [];

  const logText = input.logs
    .map((log) => `${log.stderrTail}\n${log.stdoutTail}`)
    .join("\n");
  const blocked = input.blockedReason ?? "";

  for (const log of input.logs) {
    if (log.exitCode !== undefined) signals.push({ source: log.path, detail: `exit code ${log.exitCode}` });
  }

  // 1) MCP_FAILURE — hạ tầng dữ liệu domain/repo không dùng được
  const mcpMatch = matchAny(`${logText}\n${blocked}`, PATTERNS.MCP_FAILURE);
  if (mcpMatch) {
    const line = firstMatchingLine(`${logText}\n${blocked}`, mcpMatch);
    signals.push({ source: "log/blockReason", detail: line ?? mcpMatch.source });
    return { category: "MCP_FAILURE", confidence: "high", signals, evidenceRefs };
  }

  // 2) MISSING_CONTEXT — CHỈ khi có tín hiệu nói rõ thiếu ngữ cảnh.
  // Không dùng heuristic "file context chưa tồn tại" ở đây: role không cần context
  // (researcher/impact/architect/auditor) sẽ bị gán sai, và lỗi code cụ thể trong log
  // là bằng chứng mạnh hơn. Heuristic đó được xét ở cuối như tín hiệu yếu.
  const contextMatch = matchAny(`${logText}\n${blocked}`, PATTERNS.MISSING_CONTEXT);
  if (contextMatch) {
    const line = firstMatchingLine(`${logText}\n${blocked}`, contextMatch);
    signals.push({ source: "log/blockReason", detail: line ?? contextMatch.source });
    return { category: "MISSING_CONTEXT", confidence: "high", signals, evidenceRefs };
  }

  // 3) FILE_CONFLICT — diff vượt scope (bằng chứng máy kiểm được)
  const scopeFail = input.evidence.find((item) => item.type === "SCOPE_VALIDATION" && item.status === "FAIL");
  if (scopeFail) {
    evidenceRefs.push(scopeFail.id);
    signals.push({
      source: `evidence ${scopeFail.id}`,
      detail: `unexpected=${(scopeFail.unexpectedFiles ?? []).join(",") || "—"} deleted=${(scopeFail.deletedFiles ?? []).join(",") || "—"}`,
    });
    return { category: "FILE_CONFLICT", confidence: "high", signals, evidenceRefs };
  }

  // 4) DESIGN_CONFLICT — đi lệch thiết kế đã approve / cần người quyết định
  const designMatch = matchAny(blocked, PATTERNS.DESIGN_CONFLICT);
  if (designMatch) {
    signals.push({ source: "blockReason", detail: blocked.slice(0, 300) });
    return { category: "DESIGN_CONFLICT", confidence: "medium", signals, evidenceRefs };
  }

  // 5) TEST_FAILURE — evidence do máy ghi (mạnh hơn heuristic trên log)
  const testFail = input.evidence.find(
    (item) => (item.type === "TEST" || item.type === "BUILD") && item.status === "FAIL",
  );
  if (testFail) {
    evidenceRefs.push(testFail.id);
    signals.push({ source: `evidence ${testFail.id}`, detail: testFail.summary ?? "evidence FAIL" });
    return { category: "TEST_FAILURE", confidence: "high", signals, evidenceRefs };
  }

  // 6) COMPILE_ERROR
  const compileMatch = matchAny(logText, PATTERNS.COMPILE_ERROR);
  if (compileMatch) {
    const line = firstMatchingLine(logText, compileMatch);
    signals.push({ source: "log", detail: line ?? compileMatch.source });
    return { category: "COMPILE_ERROR", confidence: "high", signals, evidenceRefs };
  }

  // 7) TEST_FAILURE từ log (evidence đã được xét ở bước 5)
  const testMatch = matchAny(logText, PATTERNS.TEST_FAILURE);
  if (testMatch) {
    const line = firstMatchingLine(logText, testMatch);
    signals.push({ source: "log", detail: line ?? testMatch.source });
    return { category: "TEST_FAILURE", confidence: "medium", signals, evidenceRefs };
  }

  // 7) ENVIRONMENT_FAILURE
  const envMatch = matchAny(logText, PATTERNS.ENVIRONMENT_FAILURE);
  if (envMatch) {
    const line = firstMatchingLine(logText, envMatch);
    signals.push({ source: "log", detail: line ?? envMatch.source });
    return { category: "ENVIRONMENT_FAILURE", confidence: "medium", signals, evidenceRefs };
  }

  // 8) Tín hiệu yếu: role cần context mà không có, và không có lỗi code cụ thể nào
  if (!input.contextPresent && input.roleRequiresContext === true) {
    signals.push({ source: "workstream", detail: "role này cần context nhưng context/<TASK-NN>.json chưa tồn tại" });
    return { category: "MISSING_CONTEXT", confidence: "low", signals, evidenceRefs };
  }

  // 9) Không có artifact bắt buộc ⇒ worker "xong" nhưng không để lại bằng chứng
  if (input.expectedArtifactsMissing.length > 0) {
    signals.push({ source: "workstream", detail: `thiếu artifact: ${input.expectedArtifactsMissing.join(", ")}` });
    return { category: "UNKNOWN", confidence: "low", signals, evidenceRefs };
  }

  const failedExit = input.logs.find((log) => log.exitCode !== undefined && log.exitCode !== 0);
  if (failedExit) {
    signals.push({ source: failedExit.path, detail: `exit code ${failedExit.exitCode} nhưng không khớp rule nào` });
    return { category: "UNKNOWN", confidence: "low", signals, evidenceRefs };
  }

  signals.push({ source: "state", detail: "không tìm thấy dấu hiệu lỗi cụ thể (task đang ở trạng thái lỗi)" });
  return { category: "UNKNOWN", confidence: "low", signals, evidenceRefs };
}

export interface CategoryGuidance {
  autoRecoverable: boolean;
  needsHuman: boolean;
  status: "DEBUGGING" | "IMPLEMENTING" | "BLOCKED";
  actions: string[];
}

/** Hệ quả của từng loại lỗi: có tự phục hồi được không, hay phải người xử lý. */
export const GUIDANCE: Record<FailureCategory, CategoryGuidance> = {
  COMPILE_ERROR: {
    autoRecoverable: true,
    needsHuman: false,
    status: "DEBUGGING",
    actions: [
      "Đọc dòng lỗi đầu tiên thuộc code của mình (không phải log của dependency).",
      "Sửa tối thiểu để compile được, không refactor ngoài scope.",
      "Chạy lại build, đọc output thật, rồi chuyển IMPLEMENTING.",
    ],
  },
  TEST_FAILURE: {
    autoRecoverable: true,
    needsHuman: false,
    status: "DEBUGGING",
    actions: [
      "Dùng skill `systematic-debugging`: tái hiện lỗi trước khi sửa.",
      "Kiểm xem test sai hay code sai — không sửa test để nó pass.",
      "Sửa tối thiểu + thêm test bảo vệ, rồi chuyển IMPLEMENTING.",
    ],
  },
  MISSING_CONTEXT: {
    autoRecoverable: false,
    needsHuman: false,
    status: "BLOCKED",
    actions: [
      "Compile lại context: eng context <TASK_ID> <TASK-NN> (thêm --project nếu có repo).",
      "Nếu context có mục Unknowns không rỗng: bổ sung dữ liệu nguồn, KHÔNG để worker đoán (INV-06).",
      "Sau khi có context đầy đủ: eng unblock <TASK_ID> rồi chạy lại worker.",
    ],
  },
  MCP_FAILURE: {
    autoRecoverable: false,
    needsHuman: true,
    status: "BLOCKED",
    actions: [
      "Kiểm MCP server: npm run mcp:engineering / npm run mcp:domain (đọc stderr).",
      "Kiểm repoRoot (env trong config/projects.yaml) và đường dẫn build dist/.",
      "Không cho worker suy diễn policy/rule khi MCP không dùng được (INV-06).",
    ],
  },
  DESIGN_CONFLICT: {
    autoRecoverable: false,
    needsHuman: true,
    status: "BLOCKED",
    actions: [
      "Quay lại architecture gate: bổ sung/đổi quyết định trong architecture.md.",
      "Xin approve mới (HUMAN_APPROVAL gateId=architecture) trước khi code tiếp (INV-05).",
      "Không để worker tự đổi thiết kế đã approve.",
    ],
  },
  FILE_CONFLICT: {
    autoRecoverable: false,
    needsHuman: true,
    status: "BLOCKED",
    actions: [
      "Xem file ngoài scope trong evidence SCOPE_VALIDATION.",
      "Revert thay đổi ngoài scope (hoặc bổ sung vào Files của plan nếu thật sự cần — kèm lý do).",
      "Chạy lại validate_scope đến khi PASS trước khi sang review (INV-04).",
    ],
  },
  ENVIRONMENT_FAILURE: {
    autoRecoverable: false,
    needsHuman: true,
    status: "BLOCKED",
    actions: [
      "Kiểm command trong harness (config/models.yaml) và PATH trên máy chạy.",
      "Kiểm quyền ghi vào workstream + repo; kiểm proxy/registry nếu là npm.",
      "Sửa môi trường rồi eng unblock <TASK_ID>.",
    ],
  },
  UNKNOWN: {
    autoRecoverable: true,
    needsHuman: false,
    status: "DEBUGGING",
    actions: [
      "Thu thập thêm bằng chứng: chạy lại worker với --dry-run để xem prompt, rồi đọc log đầy đủ.",
      "Nếu vẫn không rõ sau 2 lần: escalate cho người kèm danh sách giả thuyết đã loại trừ.",
    ],
  },
};

/** Số lần vào DEBUGGING (đếm từ history) — dùng để chặn vòng lặp sửa mù quáng. */
export function countDebugAttempts(history: Array<{ to?: string }> | undefined): number {
  return (history ?? []).filter((entry) => entry.to === "DEBUGGING").length;
}
