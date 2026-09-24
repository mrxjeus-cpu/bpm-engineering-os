import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  RecoveryEngine,
  classifyFailure,
  readHarnessLogs,
  recoveryChain,
  validateWith,
  workstreamDir,
} from "../runtime/dist/index.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "runtime", "dist", "cli.js");

const D = "RC-1000"; // diagnose + loop guard
const A = "RC-1001"; // apply: TEST_FAILURE → DEBUGGING
const B = "RC-1002"; // apply: MCP_FAILURE → BLOCKED
const M = "RC-1003"; // minimality với log khổng lồ
const ALL = [D, A, B, M];

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function writeLog(taskId, name, body) {
  const dir = path.join(workstreamDir(taskId), "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), body, "utf8");
}

function harnessLog(body) {
  return `$ mvn test\n# exit: 1\n# duration: 100ms\n\n--- stdout ---\n${body.stdout ?? ""}\n--- stderr ---\n${body.stderr ?? ""}\n`;
}

async function toImplementing(taskId) {
  await runCli(["new", taskId, "--title", "recovery test", "--risk", "MEDIUM"]);
  for (const status of ["TRANSLATING", "REQUIREMENT_ANALYSIS", "IMPACT_ANALYSIS", "DESIGNING", "WAITING_DESIGN_APPROVAL"]) {
    await runCli(["advance", taskId, "--to", status]);
  }
  await runCli([
    "record", taskId, "--type", "HUMAN_APPROVAL", "--status", "PASS",
    "--gate-id", "architecture", "--approver", "SA", "--approved-at", new Date().toISOString(),
  ]);
  for (const status of ["PLANNING", "READY_TO_IMPLEMENT", "IMPLEMENTING"]) {
    await runCli(["advance", taskId, "--to", status]);
  }
}

function cleanup() {
  for (const taskId of ALL) rmSync(workstreamDir(taskId), { recursive: true, force: true });
}

describe("classifyFailure — rule tất định", () => {
  const base = { evidence: [], contextPresent: true, expectedArtifactsMissing: [] };

  it("phân loại TEST_FAILURE từ AssertionError (KHÔNG phải COMPILE_ERROR)", () => {
    const result = classifyFailure({
      ...base,
      logs: [{ path: "l", role: "developer", exitCode: 1, stderrTail: "Tests run: 12, Failures: 2\nAssertionError: expected ELIGIBLE but was REFER", stdoutTail: "" }],
    });
    assert.equal(result.category, "TEST_FAILURE");
  });

  it("phân loại COMPILE_ERROR từ lỗi javac/tsc", () => {
    for (const stderr of [
      "[ERROR] /repo/A.java:[42,18] cannot find symbol",
      "src/a.ts(3,5): error TS2322: Type 'string' is not assignable",
      "COMPILATION ERROR : ",
      "error: expected ';'",
    ]) {
      const result = classifyFailure({
        ...base,
        logs: [{ path: "l", role: "developer", exitCode: 1, stderrTail: stderr, stdoutTail: "" }],
      });
      assert.equal(result.category, "COMPILE_ERROR", `stderr=${stderr}`);
    }
  });

  it("phân loại MCP_FAILURE từ lỗi server", () => {
    const result = classifyFailure({
      ...base,
      logs: [{ path: "l", role: "impact", exitCode: 1, stderrTail: "Error: MCP_SERVER_UNREACHABLE", stdoutTail: "" }],
    });
    assert.equal(result.category, "MCP_FAILURE");
    assert.equal(result.confidence, "high");
  });

  it("phân loại FILE_CONFLICT từ evidence SCOPE_VALIDATION FAIL", () => {
    const result = classifyFailure({
      ...base,
      logs: [],
      evidence: [
        {
          schemaVersion: 1,
          id: "EV-0002",
          taskId: "RC-9999",
          type: "SCOPE_VALIDATION",
          status: "FAIL",
          producer: "test",
          timestamp: new Date().toISOString(),
          unexpectedFiles: ["README.md"],
          deletedFiles: [],
        },
      ],
    });
    assert.equal(result.category, "FILE_CONFLICT");
    assert.deepEqual(result.evidenceRefs, ["EV-0002"]);
  });

  it("evidence TEST=FAIL mạnh hơn log có [ERROR]", () => {
    const result = classifyFailure({
      ...base,
      logs: [{ path: "l", role: "developer", exitCode: 1, stderrTail: "[ERROR] build failed", stdoutTail: "" }],
      evidence: [
        {
          schemaVersion: 1,
          id: "EV-0003",
          taskId: "RC-9999",
          type: "TEST",
          status: "FAIL",
          producer: "test",
          timestamp: new Date().toISOString(),
          summary: "5 test fail",
        },
      ],
    });
    assert.equal(result.category, "TEST_FAILURE");
    assert.ok(result.evidenceRefs.includes("EV-0003"));
  });

  it("MISSING_CONTEXT chỉ khi có tín hiệu rõ — không suy từ việc thiếu file context", () => {
    // thiếu file context nhưng role không cần context và log có lỗi môi trường
    const result = classifyFailure({
      ...base,
      contextPresent: false,
      roleRequiresContext: false,
      logs: [{ path: "l", role: "researcher", exitCode: 127, stderrTail: "sh: jq: command not found", stdoutTail: "" }],
    });
    assert.equal(result.category, "ENVIRONMENT_FAILURE");

    // role CẦN context + không có tín hiệu nào khác ⇒ mới gán MISSING_CONTEXT (confidence thấp)
    const weak = classifyFailure({ ...base, contextPresent: false, roleRequiresContext: true, logs: [] });
    assert.equal(weak.category, "MISSING_CONTEXT");
    assert.equal(weak.confidence, "low");

    // tín hiệu rõ ràng
    const strong = classifyFailure({ ...base, blockedReason: "CONTEXT_REQUIRED: chưa compile context", logs: [] });
    assert.equal(strong.category, "MISSING_CONTEXT");
    assert.equal(strong.confidence, "high");
  });

  it("không có dấu hiệu nào ⇒ UNKNOWN confidence thấp", () => {
    const result = classifyFailure({ ...base, logs: [] });
    assert.equal(result.category, "UNKNOWN");
    assert.equal(result.confidence, "low");
  });

  it("readHarnessLogs đọc đúng exit code + stderr", () => {
    cleanup();
    mkdirSync(path.join(workstreamDir(D), "tasks"), { recursive: true });
    writeLog(D, "developer-TASK-01.log", harnessLog({ stderr: "boom" }));
    const logs = readHarnessLogs(D, "TASK-01");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].exitCode, 1);
    assert.equal(logs[0].role, "developer");
    assert.match(logs[0].stderrTail, /boom/);
  });
});

describe("recoveryChain — chỉ sinh transition hợp lệ", () => {
  it("IMPLEMENTING → DEBUGGING đi qua FAILED", () => {
    assert.deepEqual(recoveryChain("IMPLEMENTING", "DEBUGGING"), ["FAILED", "DEBUGGING"]);
  });
  it("REWORK_REQUIRED → IMPLEMENTING", () => {
    assert.deepEqual(recoveryChain("REWORK_REQUIRED", "IMPLEMENTING"), ["IMPLEMENTING"]);
  });
  it("DEBUGGING không lặp lại chính nó", () => {
    assert.deepEqual(recoveryChain("DEBUGGING", "DEBUGGING"), []);
  });
  it("BLOCKED không đổi status (dùng cờ blocked)", () => {
    assert.deepEqual(recoveryChain("IMPLEMENTING", "BLOCKED"), []);
  });
});

describe("RecoveryEngine — diagnose + apply", () => {
  before(async () => {
    cleanup();
    await toImplementing(D);
    await toImplementing(A);
    await toImplementing(B);
  });

  after(cleanup);

  it("diagnose: TEST_FAILURE, tự phục hồi được, không cần người", async () => {
    writeLog(A, "developer-TASK-01.log", harnessLog({ stderr: "Tests run: 3, Failures: 1\nAssertionError: nope" }));
    const engine = new RecoveryEngine();
    const diagnosis = engine.diagnose(A, "TASK-01");
    assert.equal(diagnosis.category, "TEST_FAILURE");
    assert.equal(diagnosis.autoRecoverable, true);
    assert.equal(diagnosis.needsHuman, false);
    assert.equal(diagnosis.targetStatus, "DEBUGGING");
    assert.equal(diagnosis.sourceStatus, "IMPLEMENTING");
    assert.ok(diagnosis.actions.length >= 3);
  });

  it("apply: ghi recovery context + chuyển IMPLEMENTING → FAILED → DEBUGGING", async () => {
    const engine = new RecoveryEngine();
    const outcome = engine.recover(A, { subTaskId: "TASK-01", apply: true, by: "test" });
    assert.equal(outcome.applied, true);
    assert.deepEqual(
      outcome.transitions.map((step) => `${step.from}→${step.to}`),
      ["IMPLEMENTING→FAILED", "FAILED→DEBUGGING"],
    );

    const state = JSON.parse(readFileSync(path.join(workstreamDir(A), "task.json"), "utf8"));
    assert.equal(state.status, "DEBUGGING");
    assert.equal(state.blocked, false);

    // artifact + schema
    assert.ok(existsSync(path.join(workstreamDir(A), "tasks", "recovery-TASK-01.md")));
    const record = JSON.parse(readFileSync(path.join(workstreamDir(A), "tasks", "recovery-TASK-01.json"), "utf8"));
    assert.equal(validateWith("recovery", record).valid, true);
    assert.equal(record.category, "TEST_FAILURE");
    assert.equal(record.sourceStatus, "IMPLEMENTING");
    assert.equal(record.createdBy, "test");
  });

  it("MCP_FAILURE ⇒ block kèm lý do, status không đổi, task.json.blocked=true", async () => {
    writeLog(B, "developer-TASK-01.log", harnessLog({ stderr: "Error: MCP_SERVER_EXITED" }));
    const engine = new RecoveryEngine();
    const outcome = engine.recover(B, { subTaskId: "TASK-01", apply: true });
    assert.equal(outcome.blocked, true);
    assert.deepEqual(outcome.transitions, []);
    assert.equal(outcome.diagnosis.needsHuman, true);

    const state = JSON.parse(readFileSync(path.join(workstreamDir(B), "task.json"), "utf8"));
    assert.equal(state.blocked, true);
    assert.equal(state.status, "IMPLEMENTING");
    assert.match(state.blockReason, /MCP_FAILURE/);
  });

  it("loop guard: vượt maxAttempts ⇒ escalate cho người, không tự sửa tiếp", async () => {
    const engine = new RecoveryEngine();
    // đẩy task A qua một vòng DEBUGGING nữa
    await runCli(["advance", A, "--to", "IMPLEMENTING"]);
    const diagnosis = engine.diagnose(A, "TASK-01", { maxAttempts: 1 });
    assert.ok(diagnosis.attempt >= 1);
    assert.equal(diagnosis.needsHuman, true);
    assert.equal(diagnosis.autoRecoverable, false);
    assert.ok(diagnosis.actions.some((action) => /escalate|DỪNG sửa tự động/.test(action)));
  });

  it("không áp dụng khi thiếu --apply (chỉ chẩn đoán, không ghi file)", async () => {
    const engine = new RecoveryEngine();
    rmSync(path.join(workstreamDir(D), "tasks", "recovery-TASK-01.json"), { force: true });
    const outcome = engine.recover(D, { subTaskId: "TASK-01" });
    assert.equal(outcome.applied, false);
    assert.equal(existsSync(path.join(workstreamDir(D), "tasks", "recovery-TASK-01.json")), false);
  });
});

describe("recovery context — tối thiểu (INV-01)", () => {
  before(async () => {
    cleanup();
    await toImplementing(M);
    // log khổng lồ: 3000 dòng rác
    const noise = Array.from({ length: 3000 }, (_, index) => `noise line ${index}`).join("\n");
    writeLog(M, "developer-TASK-01.log", harnessLog({ stderr: `${noise}\nAssertionError: thật sự ở cuối` }));
    // context có marker để kiểm tra KHÔNG bị nhúng lại
    mkdirSync(path.join(workstreamDir(M), "context"), { recursive: true });
    writeFileSync(
      path.join(workstreamDir(M), "context", "TASK-01.json"),
      JSON.stringify({
        schemaVersion: 1,
        taskId: M,
        subTaskId: "TASK-01",
        objective: "MARKER_NOI_DUNG_CONTEXT_KHONG_DUOC_NHUNG",
        files: ["src/main/java/A.java"],
        constraints: ["c"],
        acceptanceCriteria: ["a"],
        verificationCriteria: ["v"],
        provenance: { generatedAt: new Date().toISOString(), generatedBy: "test" },
      }),
      "utf8",
    );
  });

  after(cleanup);

  it("trích lỗi bị giới hạn số dòng và báo truncated", async () => {
    const engine = new RecoveryEngine();
    const outcome = engine.recover(M, { subTaskId: "TASK-01", apply: true });
    const excerptLines = outcome.diagnosis.errorExcerpt.split("\n").length;
    assert.ok(excerptLines <= 50, `excerpt ${excerptLines} dòng — quá dài`);
    assert.equal(outcome.truncated, true);

    const markdown = readFileSync(path.join(workstreamDir(M), "tasks", "recovery-TASK-01.md"), "utf8");
    assert.ok(markdown.length < 6000, `recovery md ${markdown.length} bytes — phải tối thiểu`);
    assert.ok(!markdown.includes("MARKER_NOI_DUNG_CONTEXT_KHONG_DUOC_NHUNG"), "không được nhúng nội dung context");
    assert.match(markdown, /context\/TASK-01\.md/);
    assert.match(markdown, /Không restart worker với cùng context cũ/);
    assert.ok(!/noise line 1500/.test(markdown), "không được nhúng toàn bộ log");
  });
});

describe("eng recover — CLI", () => {
  let taskId = "RC-1004";

  before(async () => {
    rmSync(workstreamDir(taskId), { recursive: true, force: true });
    await toImplementing(taskId);
    writeLog(taskId, "developer-TASK-01.log", harnessLog({ stderr: "AssertionError: nope" }));
  });

  after(() => {
    rmSync(workstreamDir(taskId), { recursive: true, force: true });
  });

  it("chẩn đoán không đổi trạng thái và in việc phải làm", async () => {
    const result = await runCli(["recover", taskId, "TASK-01"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /TEST_FAILURE/);
    assert.match(result.stdout, /việc phải làm/);
    assert.match(result.stdout, /--apply/);

    const state = JSON.parse(readFileSync(path.join(workstreamDir(taskId), "task.json"), "utf8"));
    assert.equal(state.status, "IMPLEMENTING");
  });

  it("--apply đổi trạng thái + ghi artifact, --json trả record đầy đủ", async () => {
    const result = await runCli(["recover", taskId, "TASK-01", "--apply", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.applied, true);
    assert.equal(parsed.diagnosis.category, "TEST_FAILURE");
    assert.ok(parsed.markdownPath);

    const state = JSON.parse(readFileSync(path.join(workstreamDir(taskId), "task.json"), "utf8"));
    assert.equal(state.status, "DEBUGGING");
  });

  it("cần người xử lý ⇒ exit code 1", async () => {
    await runCli(["advance", taskId, "--to", "IMPLEMENTING"]);
    writeLog(taskId, "developer-TASK-01.log", harnessLog({ stderr: "ENOENT: no such file or directory" }));
    const result = await runCli(["recover", taskId, "TASK-01", "--apply"]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /cần người: CÓ/);
    const state = JSON.parse(readFileSync(path.join(workstreamDir(taskId), "task.json"), "utf8"));
    assert.equal(state.blocked, true);
  });
});
