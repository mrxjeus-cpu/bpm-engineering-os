import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  EventBus,
  StateStore,
  configSummary,
  loadConfig,
  validateWith,
  workstreamDir,
} from "../runtime/dist/index.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "runtime", "dist", "cli.js");

const TASK_IDS = ["RT-0100", "RT-0101", "RT-0102", "RT-0103", "RT-9001", "RT-9002", "RT-9003", "RT-9004"];
const A = "RT-0100"; // acceptance A: state qua restart
const F = "RT-0101"; // acceptance F: evidence persist
const G = "RT-0102"; // human gate
const B = "RT-0103"; // block/unblock

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

function cleanup() {
  for (const taskId of TASK_IDS) rmSync(workstreamDir(taskId), { recursive: true, force: true });
}

function readEvidence(taskId, evidenceId) {
  return JSON.parse(readFileSync(path.join(workstreamDir(taskId), "evidence", `${evidenceId}.json`), "utf8"));
}

describe("runtime — config & schema validation", () => {
  it("đọc và kiểm tra hợp lệ 5 file config", () => {
    const config = loadConfig();
    assert.ok(config.projects.defaultProject.length > 0);
    assert.equal(config.gates.gates.length, 6);
    assert.ok(config.gates.modes.normal);
    assert.ok(config.risk.effects.CRITICAL);
  });

  it("config summary phơi gate + mode + server cho CLI", () => {
    const summary = configSummary();
    assert.deepEqual(summary.modes, ["safe", "normal", "autonomous"]);
    assert.equal(summary.defaultMode, "normal");
    assert.ok(
      summary.gates.some(
        (gate) => gate.id === "architecture" && gate.transition === "WAITING_DESIGN_APPROVAL → PLANNING",
      ),
    );
    assert.deepEqual(summary.mcpServers, ["mcp-engineering", "mcp-domain-core"]);
  });

  it("schema chặn state có field lạ (task.schema.json)", () => {
    const result = validateWith("task", {
      schemaVersion: 1,
      taskId: "RT-9999",
      status: "NEW",
      phase: "translate",
      risk: "MEDIUM",
      mode: "normal",
      blocked: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      truongLa: true,
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it("schema bắt blockReason khi blocked=true", () => {
    const result = validateWith("task", {
      schemaVersion: 1,
      taskId: "RT-9999",
      status: "IMPLEMENTING",
      phase: "implementation",
      risk: "LOW",
      mode: "normal",
      blocked: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assert.equal(result.valid, false);
  });
});

describe("runtime — state machine & evidence gate", () => {
  let store;

  before(() => {
    cleanup();
    store = new StateStore();
  });

  after(cleanup);

  it("transition bất hợp lệ bị chặn kèm danh sách hợp lệ", () => {
    store.create({ taskId: "RT-9001", title: "illegal transition" });
    assert.throws(
      () => store.transition("RT-9001", "DONE"),
      (error) => {
        assert.equal(error.code, "ILLEGAL_TRANSITION");
        assert.deepEqual(error.details.allowed, ["TRANSLATING"]);
        return true;
      },
    );
  });

  it("patch từ chối field do runtime quản lý", () => {
    store.create({ taskId: "RT-9002", title: "patch guard" });
    assert.throws(
      () => store.patch("RT-9002", { status: "DONE" }),
      (error) => error.code === "PATCH_FORBIDDEN_FIELD",
    );
    assert.throws(
      () => store.patch("RT-9002", { truongLa: 1 }),
      (error) => error.code === "PATCH_UNKNOWN_FIELD",
    );
    assert.throws(
      () => store.patch("RT-9002", { blocked: true }),
      (error) => error.code === "BLOCK_REASON_REQUIRED",
    );
  });

  it("REVIEWING cần TEST + SCOPE_VALIDATION (RULES-001)", () => {
    store.create({ taskId: "RT-9003", title: "evidence gate", status: "IMPLEMENTING" });
    assert.throws(
      () => store.transition("RT-9003", "REVIEWING"),
      (error) => {
        assert.equal(error.code, "EVIDENCE_REQUIRED");
        assert.equal(error.details.missing.length, 2);
        return true;
      },
    );
  });

  it("evidence thiếu provenance bị từ chối (INV-12)", () => {
    assert.throws(
      () =>
        store.evidence.record("RT-9003", {
          type: "TEST",
          status: "PASS",
          command: "node -e 1",
          cwd: REPO_ROOT,
          exitCode: 0,
          producer: "test",
        }),
      (error) => {
        assert.equal(error.code, "EVIDENCE_INCOMPLETE");
        assert.ok(error.details.missing.includes("gitSha"));
        assert.ok(error.details.missing.includes("artifact"));
        return true;
      },
    );
  });

  it("có đủ evidence thì REVIEWING đi qua được", () => {
    store.evidence.record("RT-9003", {
      type: "TEST",
      status: "PASS",
      summary: "unit test pass",
      command: "node -e 1",
      cwd: REPO_ROOT,
      exitCode: 0,
      gitSha: "test-sha",
      artifact: "evidence/logs/x.log",
      producer: "test",
    });
    store.evidence.record("RT-9003", {
      type: "SCOPE_VALIDATION",
      status: "PASS",
      unexpectedFiles: [],
      deletedFiles: [],
      producer: "test",
    });
    const state = store.transition("RT-9003", "REVIEWING");
    assert.equal(state.status, "REVIEWING");
    assert.equal(state.phase, "review");
  });

  it("architecture gate bắt buộc human approval (INV-05)", () => {
    store.create({ taskId: G, title: "human gate", risk: "HIGH" });
    for (const to of ["TRANSLATING", "REQUIREMENT_ANALYSIS", "IMPACT_ANALYSIS", "DESIGNING", "WAITING_DESIGN_APPROVAL"]) {
      store.transition(G, to);
    }
    assert.throws(
      () => store.transition(G, "PLANNING"),
      (error) => {
        assert.equal(error.code, "HUMAN_APPROVAL_REQUIRED");
        assert.equal(error.details.gates[0].gateId, "architecture");
        return true;
      },
    );

    store.evidence.record(G, {
      type: "HUMAN_APPROVAL",
      status: "PASS",
      gateId: "architecture",
      approver: "SA Test",
      approvedAt: new Date().toISOString(),
      producer: "human:SA Test",
    });
    const state = store.transition(G, "PLANNING");
    assert.equal(state.status, "PLANNING");
    assert.equal(state.approvals.architecture, true);
  });

  it("gate bỏ qua được khi risk thấp + cờ allow-bypass", () => {
    store.create({ taskId: "RT-9004", title: "bypass", risk: "LOW" });
    for (const to of ["TRANSLATING", "REQUIREMENT_ANALYSIS", "IMPACT_ANALYSIS", "DESIGNING", "WAITING_DESIGN_APPROVAL"]) {
      store.transition("RT-9004", to);
    }
    const state = store.transition("RT-9004", "PLANNING", { allowBypass: true });
    assert.equal(state.status, "PLANNING");
    assert.equal(state.approvals.architecture, true);
  });

  it("block cần lý do; resume chỉ ra việc phải xử lý", () => {
    store.create({ taskId: B, title: "blocked task" });
    assert.throws(
      () => store.block(B, "   "),
      (error) => error.code === "BLOCK_REASON_REQUIRED",
    );
    const blocked = store.block(B, "mcp-domain-core unavailable");
    assert.equal(blocked.blocked, true);
    const report = store.resume(B);
    assert.match(report.nextActions[0], /BLOCKED: mcp-domain-core unavailable/);
    assert.equal(store.unblock(B).blocked, false);
  });
});

describe("runtime — acceptance criteria (qua CLI, process riêng)", () => {
  before(cleanup);
  after(cleanup);

  it("A. state sống qua process restart", async () => {
    const created = await runCli(["new", A, "--title", "restart test", "--risk", "MEDIUM", "--json"]);
    assert.equal(created.code, 0, created.stderr);
    const advanced = await runCli(["advance", A, "--to", "TRANSLATING", "--reason", "bắt đầu dịch ticket"]);
    assert.equal(advanced.code, 0, advanced.stderr);

    // process hoàn toàn mới, chỉ đọc state từ đĩa
    const status = await runCli(["status", A, "--json"]);
    assert.equal(status.code, 0, status.stderr);
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.status, "TRANSLATING");
    assert.equal(parsed.phase, "translate");

    const onDisk = JSON.parse(readFileSync(path.join(workstreamDir(A), "task.json"), "utf8"));
    assert.equal(validateWith("task", onDisk).valid, true);
    assert.equal(onDisk.history.length, 2);
  });

  it("F. evidence persist, có provenance, đúng schema", async () => {
    const recorded = await runCli([
      "record",
      A,
      "--type",
      "TEST",
      "--status",
      "PASS",
      "--summary",
      "20 test pass",
      "--command",
      "npm test",
      "--cwd",
      REPO_ROOT,
      "--exit-code",
      "0",
      "--git-sha",
      "abc123",
      "--artifact",
      "evidence/logs/npm-test.log",
      "--sub-task",
      "TASK-01",
    ]);
    assert.equal(recorded.code, 0, recorded.stderr);
    assert.match(recorded.stdout, /EV-0001 TEST=PASS/);

    const stored = readEvidence(A, "EV-0001");
    for (const field of ["command", "cwd", "exitCode", "gitSha", "artifact", "timestamp", "producer", "subTaskId"]) {
      assert.ok(stored[field] !== undefined && stored[field] !== null, `evidence thiếu ${field}`);
    }
    assert.equal(validateWith("evidence", stored).valid, true);

    const listed = await runCli(["evidence", A, "--json"]);
    const items = JSON.parse(listed.stdout);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, "TEST");

    const evidenceDir = path.join(workstreamDir(A), "evidence");
    assert.deepEqual(
      readdirSync(evidenceDir).filter((file) => file.endsWith(".tmp")),
      [],
      "atomic write không được để lại file .tmp",
    );
  });

  it("resume chỉ ra artifact còn thiếu và gate đang mở", async () => {
    const result = await runCli(["resume", A, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.artifacts.missing, []);
    assert.ok(Array.isArray(report.openGates));
  });

  it("advance in lỗi có mã rõ ràng ra stderr và exit code 1", async () => {
    const result = await runCli(["advance", A, "--to", "DONE"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /ILLEGAL_TRANSITION/);
    assert.match(result.stderr, /TRANSLATING/);
  });

  it("events.jsonl ghi lifecycle event theo transition", async () => {
    await runCli(["advance", A, "--to", "REQUIREMENT_ANALYSIS"]);
    const advanced = await runCli(["advance", A, "--to", "IMPACT_ANALYSIS", "--reason", "requirements đã chốt"]);
    assert.equal(advanced.code, 0, advanced.stderr);

    const bus = new EventBus();
    const events = bus.read(A);
    const types = events.map((event) => event.type);
    assert.ok(types.includes("TaskCreated"), `types=${types.join(",")}`);
    assert.ok(types.includes("RequirementCompleted"), `types=${types.join(",")}`);
    assert.equal(validateWith("event", events[0]).valid, true);
    assert.ok(existsSync(path.join(workstreamDir(A), "events.jsonl")));

    const cliEvents = await runCli(["events", A, "--json"]);
    assert.equal(JSON.parse(cliEvents.stdout).length, events.length);
  });

  it("eng list hiển thị workstream đã tạo", async () => {
    const result = await runCli(["list", "--json"]);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.workstreams.includes(A));
  });

  it("eng config chạy được và trả exit code 0", async () => {
    const result = await runCli(["config", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.defaultMode, "normal");
  });

  it("F (bổ sung). evidence của task khác không lẫn sang nhau", async () => {
    await runCli(["new", F, "--title", "evidence isolation", "--risk", "LOW"]);
    const listed = await runCli(["evidence", F, "--json"]);
    assert.deepEqual(JSON.parse(listed.stdout), []);
  });
});
