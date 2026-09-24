import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildDag,
  buildExecutionPlan,
  checkWave,
  detectConflicts,
  parsePlanMarkdown,
  validateWith,
  waveProgress,
  workstreamDir,
} from "../runtime/dist/index.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "runtime", "dist", "cli.js");
const FIXTURES = path.join(REPO_ROOT, "tests", "fixtures", "plans");

const P = "PG-0100"; // import plan hợp lệ + chạy wave
const BAD = "PG-0101"; // import plan lỗi
const CYC = "PG-0102"; // plan có vòng
const ALL = [P, BAD, CYC];

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

function readFixture(name) {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

function planJson(taskId) {
  return JSON.parse(readFileSync(path.join(workstreamDir(taskId), "plan.json"), "utf8"));
}

function cleanup() {
  for (const taskId of ALL) rmSync(workstreamDir(taskId), { recursive: true, force: true });
}

describe("plan parser", () => {
  it("parse plan hợp lệ thành task có đủ field", () => {
    const result = parsePlanMarkdown(readFixture("valid-plan.md"));
    assert.deepEqual(result.errors, []);
    assert.equal(result.tasks.length, 6);

    const task1 = result.tasks.find((task) => task.id === "TASK-01");
    assert.ok(task1);
    assert.match(task1.objective, /enum PurposeOfLoan/i);
    assert.deepEqual(task1.dependencies, []);
    assert.equal(task1.files.length, 3);
    assert.ok(task1.symbols.includes("PolicyInputMapper"));
    assert.equal(task1.acceptanceCriteria.length, 3);
    assert.ok(task1.verification.length >= 1);
    assert.match(task1.existingPattern, /LoanPurpose/);

    const task3 = result.tasks.find((task) => task.id === "TASK-03");
    assert.deepEqual(task3.dependencies, ["TASK-01", "TASK-02"]);
    assert.equal(task3.businessRules.length, 2);
    assert.equal(task3.constraints.length, 2);
  });

  it("cảnh báo khi task không khai báo existing pattern", () => {
    const result = parsePlanMarkdown(readFixture("valid-plan.md"));
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.every((warning) => /Existing Pattern/.test(warning)));
  });

  it("báo lỗi thiếu field bắt buộc kèm taskId", () => {
    const result = parsePlanMarkdown(readFixture("invalid-plan.md"));
    const codes = result.errors.map((error) => error.code);
    assert.ok(codes.includes("MISSING_ACCEPTANCE_CRITERIA"));
    assert.ok(codes.includes("MISSING_VERIFICATION"));
    assert.ok(codes.includes("INVALID_DEPENDENCY"));
    assert.ok(codes.includes("INVALID_RISK"));
    assert.ok(result.errors.every((error) => error.taskId));
  });

  it("báo lỗi khi không có task nào", () => {
    const result = parsePlanMarkdown("# Plan\n\nKhông có heading task nào.\n");
    assert.equal(result.tasks.length, 0);
    assert.equal(result.errors[0].code, "NO_TASKS");
  });

  it("bỏ qua code fence, không nhặt code thành acceptance criteria", () => {
    const markdown = [
      "## TASK-01 — Test fence",
      "",
      "### Objective",
      "Kiểm tra code fence.",
      "",
      "### Acceptance Criteria",
      "- Tiêu chí thật",
      "",
      "```java",
      "- dòng này là code, không phải tiêu chí",
      "```",
      "",
      "### Verification",
      "- Test thật",
    ].join("\n");
    const result = parsePlanMarkdown(markdown);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.tasks[0].acceptanceCriteria, ["Tiêu chí thật"]);
  });
});

describe("dependency graph", () => {
  const tasks = parsePlanMarkdown(readFixture("valid-plan.md")).tasks;

  it("chia wave theo dependency", () => {
    const dag = buildDag(tasks);
    assert.equal(dag.ok, true);
    assert.deepEqual(dag.waves, [["TASK-01", "TASK-04", "TASK-06"], ["TASK-02"], ["TASK-03"], ["TASK-05"]]);
    assert.equal(dag.edges.length, 4);
    assert.deepEqual(dag.unresolved, []);
  });

  it("phát hiện vòng phụ thuộc kèm đường đi", () => {
    const cyclic = parsePlanMarkdown(readFixture("cyclic-plan.md")).tasks;
    const dag = buildDag(cyclic);
    assert.equal(dag.ok, false);
    const cycle = dag.errors.find((error) => error.code === "CYCLE");
    assert.ok(cycle);
    assert.match(cycle.message, /TASK-01/);
    assert.match(cycle.message, /→/);
    assert.deepEqual(dag.unresolved, ["TASK-01", "TASK-02"]);
    assert.deepEqual(dag.waves, []);
  });

  it("phát hiện tự phụ thuộc và dependency lạ", () => {
    const broken = buildDag([
      {
        id: "TASK-01",
        title: "self",
        objective: "x",
        dependencies: ["TASK-01"],
        acceptanceCriteria: ["a"],
        verification: ["v"],
      },
      {
        id: "TASK-02",
        title: "unknown",
        objective: "y",
        dependencies: ["TASK-99"],
        acceptanceCriteria: ["a"],
        verification: ["v"],
      },
    ]);
    const codes = broken.errors.map((error) => error.code).sort();
    assert.deepEqual(codes, ["SELF_DEPENDENCY", "UNKNOWN_DEPENDENCY"]);
  });
});

describe("conflict detection (INV-11)", () => {
  const tasks = parsePlanMarkdown(readFixture("valid-plan.md")).tasks;

  it("wave 1 bị BLOCK do trùng file và trùng symbol", () => {
    const wave1 = tasks.filter((task) => ["TASK-01", "TASK-04", "TASK-06"].includes(task.id));
    const check = checkWave(wave1);
    assert.equal(check.status, "FAIL");
    assert.equal(check.safeToParallel, false);
    const types = check.conflicts.map((conflict) => conflict.type).sort();
    assert.deepEqual(types, ["FILE_OVERLAP", "MIGRATION_ORDER", "PATTERN_FORK", "SYMBOL_OVERLAP"]);
    const blocking = check.conflicts.filter((conflict) => conflict.severity === "BLOCK");
    assert.equal(blocking.length, 2);
  });

  it("wave không trùng gì thì PASS", () => {
    const wave2 = tasks.filter((task) => task.id === "TASK-02");
    assert.equal(checkWave(wave2).status, "PASS");
    assert.equal(detectConflicts(wave2).length, 0);
  });
});

describe("execution plan (waves)", () => {
  const plan = { schemaVersion: 1, taskId: "PG-0999", tasks: parsePlanMarkdown(readFixture("valid-plan.md")).tasks };

  it("wave có conflict ⇒ SEQUENTIAL, còn lại PARALLEL", () => {
    const execution = buildExecutionPlan(plan);
    assert.equal(execution.blocked, false);
    assert.equal(execution.waves.length, 4);
    assert.equal(execution.waves[0].mode, "SEQUENTIAL");
    assert.equal(execution.waves[0].conflictCheck, "FAIL");
    assert.deepEqual(
      execution.waves.slice(1).map((wave) => wave.mode),
      ["PARALLEL", "PARALLEL", "PARALLEL"],
    );
  });

  it("wave 1 chỉ ready khi wave trước xong", () => {
    const execution = buildExecutionPlan(plan);
    const progress = waveProgress(plan, execution);
    assert.equal(progress[0].ready, true);
    assert.equal(progress[1].ready, false);
    assert.equal(progress[1].blockedByPrevious, true);
  });

  it("plan sau khi gắn wave vẫn hợp lệ theo plan.schema.json", () => {
    const execution = buildExecutionPlan(plan);
    const withWaves = {
      ...plan,
      waves: execution.waves.map((wave) => ({
        index: wave.index,
        tasks: wave.tasks,
        conflictCheck: wave.conflictCheck,
        conflicts: wave.conflicts.map((conflict) => `${conflict.severity} ${conflict.type}: ${conflict.detail}`),
      })),
    };
    const result = validateWith("plan", withWaves);
    assert.equal(result.valid, true, result.errors.join("; "));
  });

  it("plan có cycle ⇒ blocked, không thực thi được", () => {
    const cyclic = { schemaVersion: 1, taskId: "PG-0998", tasks: parsePlanMarkdown(readFixture("cyclic-plan.md")).tasks };
    const execution = buildExecutionPlan(cyclic);
    assert.equal(execution.blocked, true);
    assert.match(execution.errors.join(" "), /vòng phụ thuộc/i);
  });
});

describe("CLI plan → graph → wave → subtask", () => {
  before(cleanup);
  after(cleanup);

  it("plan import lưu plan.json + plan.md và hợp lệ schema", async () => {
    const created = await runCli(["new", P, "--title", "plan graph test", "--risk", "HIGH"]);
    assert.equal(created.code, 0, created.stderr);

    const imported = await runCli(["plan", "import", P, "--file", "tests/fixtures/plans/valid-plan.md"]);
    assert.equal(imported.code, 0, imported.stderr);
    assert.match(imported.stdout, /import 6 task/);

    const plan = planJson(P);
    assert.equal(plan.tasks.length, 6);
    assert.equal(plan.source, "valid-plan.md");
    assert.ok(plan.waves.length === 4);
    assert.equal(validateWith("plan", plan).valid, true);
    assert.ok(existsSync(path.join(workstreamDir(P), "plan.md")), "plan.md phải được copy vào workstream");
  });

  it("plan import lỗi ⇒ exit 1, KHÔNG ghi plan.json", async () => {
    await runCli(["new", BAD, "--title", "plan lỗi", "--risk", "LOW"]);
    const imported = await runCli(["plan", "import", BAD, "--file", "tests/fixtures/plans/invalid-plan.md"]);
    assert.equal(imported.code, 1);
    assert.match(imported.stderr, /PLAN_PARSE_ERROR/);
    assert.match(imported.stderr, /MISSING_ACCEPTANCE_CRITERIA/);
    assert.equal(existsSync(path.join(workstreamDir(BAD), "plan.json")), false);
  });

  it("graph --json trả wave + conflict", async () => {
    const result = await runCli(["graph", P, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.waves.length, 4);
    assert.equal(parsed.waves[0].mode, "SEQUENTIAL");
    assert.ok(parsed.waves[0].conflicts.some((conflict) => conflict.type === "FILE_OVERLAP"));
    assert.equal(parsed.progress[0].ready, true);
  });

  it("plan có cycle bị chặn khi import (dependency lạ)", async () => {
    await runCli(["new", CYC, "--title", "plan cycle", "--risk", "LOW"]);
    const imported = await runCli(["plan", "import", CYC, "--file", "tests/fixtures/plans/cyclic-plan.md"]);
    // parser cho qua (dependency tồn tại), nhưng DAG phát hiện cycle ⇒ plan.json có waves rỗng + import báo lỗi
    assert.equal(imported.code, 0, imported.stderr);
    const graph = await runCli(["graph", CYC, "--json"]);
    const parsed = JSON.parse(graph.stdout);
    assert.equal(parsed.blocked, true);

    const wave = await runCli(["wave", CYC, "--start", "1"]);
    assert.equal(wave.code, 1);
    assert.match(wave.stderr, /PLAN_NOT_EXECUTABLE/);
  });

  it("wave bị chặn khi status chưa IMPLEMENTING", async () => {
    const result = await runCli(["wave", P, "--start", "1"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /WAVE_NOT_ALLOWED/);
  });

  it("chạy wave 1 (SEQUENTIAL) rồi subtask DONE mở wave 2", async () => {
    // đưa state tới IMPLEMENTING (đi đúng state machine + architecture gate)
    for (const status of ["TRANSLATING", "REQUIREMENT_ANALYSIS", "IMPACT_ANALYSIS", "DESIGNING", "WAITING_DESIGN_APPROVAL"]) {
      const step = await runCli(["advance", P, "--to", status]);
      assert.equal(step.code, 0, step.stderr);
    }
    await runCli([
      "record", P, "--type", "HUMAN_APPROVAL", "--status", "PASS",
      "--gate-id", "architecture", "--approver", "SA Test",
      "--approved-at", new Date().toISOString(),
    ]);
    for (const status of ["PLANNING", "READY_TO_IMPLEMENT", "IMPLEMENTING"]) {
      const step = await runCli(["advance", P, "--to", status]);
      assert.equal(step.code, 0, step.stderr);
    }

    const started = await runCli(["wave", P, "--start", "1", "--json"]);
    assert.equal(started.code, 0, started.stderr);
    const wave = JSON.parse(started.stdout);
    assert.equal(wave.wave.mode, "SEQUENTIAL");
    assert.deepEqual(wave.wave.tasks, ["TASK-01", "TASK-04", "TASK-06"]);

    const state = JSON.parse((await runCli(["status", P, "--json"])).stdout);
    assert.equal(state.status, "IMPLEMENTING");

    for (const subTaskId of ["TASK-01", "TASK-04", "TASK-06"]) {
      const done = await runCli(["subtask", P, subTaskId, "--status", "DONE"]);
      assert.equal(done.code, 0, done.stderr);
      assert.match(done.stdout, new RegExp(`${subTaskId} → DONE`));
    }

    const plan = planJson(P);
    assert.equal(plan.tasks.filter((task) => task.status === "DONE").length, 3);

    const progress = await runCli(["wave", P, "--json"]);
    const parsed = JSON.parse(progress.stdout);
    assert.equal(parsed.progress[0].pending.length, 0);
    assert.equal(parsed.next.index, 2);
  });

  it("wave 3 bị chặn khi wave 2 chưa xong", async () => {
    const result = await runCli(["wave", P, "--start", "3"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /WAVE_BLOCKED/);
  });

  it("subtask không có trong plan ⇒ SUBTASK_NOT_FOUND", async () => {
    const result = await runCli(["subtask", P, "TASK-99", "--status", "DONE"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /SUBTASK_NOT_FOUND/);
  });

  it("subtask phát event TaskCompleted", async () => {
    const events = await runCli(["events", P, "--json"]);
    const parsed = JSON.parse(events.stdout);
    const completed = parsed.filter((event) => event.type === "TaskCompleted");
    assert.equal(completed.length, 3);
    assert.ok(completed.every((event) => event.subTaskId));
  });
});
