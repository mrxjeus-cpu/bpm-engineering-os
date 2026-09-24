import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PHASE_NAMES, PHASES, workstreamDir } from "../runtime/dist/index.js";
import { makeFixtureRepo } from "./helpers/fixture.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "runtime", "dist", "cli.js");
const HARNESS = path.join(REPO_ROOT, "tests", "fixtures", "harness", "write-report.mjs");
const FIXTURE_SOURCE = path.join(REPO_ROOT, "tests", "fixtures", "sample-repo");

const FULL = "PH-1000"; // chuỗi đầy đủ NEW → DONE
const FAILCASE = "PH-1001"; // worker fail ⇒ recovery
const NOEVID = "PH-1002"; // implement thiếu evidence
const ALL = [FULL, FAILCASE, NOEVID];

let modelsConfig;
let fixture;

// Hook cấp cao nhất: fixture + config dùng chung cho MỌI suite (after của suite con sẽ chạy trước suite sau).
before(() => {
  modelsConfig = writeModelsConfig();
  fixture = makeFixtureRepo(FIXTURE_SOURCE);
});

after(() => {
  cleanup();
  fixture?.cleanup();
});

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, MODELS_CONFIG: modelsConfig, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function state(taskId) {
  return JSON.parse(readFileSync(path.join(workstreamDir(taskId), "task.json"), "utf8"));
}

function writeModelsConfig() {
  const file = path.join(tmpdir(), `domain-phase-models-${Date.now()}.yaml`);
  writeFileSync(
    file,
    [
      "version: 1",
      "tiers: { cheap: glm-text, small: haiku, medium: sonnet, large: opus }",
      "agents:",
      "  translator: cheap",
      "  researcher: medium",
      "  requirements: medium",
      "  impact: medium",
      "  architect: large",
      "  developer: medium",
      "  reviewer: medium",
      "  auditor: large",
      "complexity: { simple: small, medium: medium, complex: large }",
      "riskFloor: { LOW: small, MEDIUM: medium, HIGH: medium, CRITICAL: large }",
      "routing:",
      "  weights: { complexity: 0.4, risk: 0.4 }",
      "  caps: { minTier: small, maxTier: large, fallback: medium }",
      "  neverBelowRiskFloor: true",
      "harness:",
      "  writer:",
      "    enabled: true",
      `    command: ["node", ${JSON.stringify(HARNESS)}]`,
      '    cwd: "{osRoot}"',
      "    timeoutMs: 60000",
      "  failing:",
      "    enabled: true",
      '    command: ["node", "-e", "process.exit(3)"]',
      '    cwd: "{osRoot}"',
      "    timeoutMs: 60000",
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

const FIX_ENV = () => ({ SAMPLE_FIXTURE_REPO_ROOT: fixture.dir });

function cleanup() {
  for (const taskId of ALL) rmSync(workstreamDir(taskId), { recursive: true, force: true });
}

describe("phase commands — metadata + dry run", () => {
  it("có đủ 8 phase với precondition và status đích", () => {
    assert.deepEqual(PHASE_NAMES.sort(), ["analyze", "audit", "design", "implement", "plan", "review", "translate", "verify"]);
    assert.deepEqual(PHASES.translate.allowedFrom, ["NEW", "TRANSLATING"]);
    assert.equal(PHASES.translate.endsAt, "REQUIREMENT_ANALYSIS");
    assert.equal(PHASES.verify.endsAt, "DONE");
    assert.ok(PHASES.design.steps.some((step) => /human gate|approve/i.test(step)));
  });

  it("--dry-run liệt kê bước và KHÔNG đổi trạng thái", async () => {
    await runCli(["new", FULL, "--title", "phase dry run", "--risk", "HIGH"]);
    const result = await runCli(["translate", FULL, "--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /dry run/);
    assert.match(result.stdout, /advance → TRANSLATING/);
    assert.equal(state(FULL).status, "NEW");
    assert.equal(state(FULL).history.length, 1, "dry run không được ghi history");
  });

  it("sai precondition ⇒ PHASE_PRECONDITION kèm danh sách status hợp lệ", async () => {
    const result = await runCli(["verify", FULL]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /PHASE_PRECONDITION/);
    assert.match(result.stderr, /VERIFYING/);
  });

  it("plan import/show vẫn là lệnh dữ liệu (không bị phase chiếm)", async () => {
    const result = await runCli(["plan", "show", FULL]);
    assert.equal(result.code, 1, "chưa có plan.json nên phải lỗi PLAN_NOT_FOUND");
    assert.match(result.stderr, /PLAN_NOT_FOUND/);
  });
});

describe("chuỗi phase NEW → DONE", () => {
  before(async () => {
    cleanup();
    await runCli(["new", FULL, "--title", "Thêm Purpose of Loan vào policy input", "--risk", "HIGH"]);
  });

  it("translate → REQUIREMENT_ANALYSIS (researcher ghi artifact thật)", async () => {
    const result = await runCli(["translate", FULL, "--harness", "writer"], FIX_ENV());
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /NEW → REQUIREMENT_ANALYSIS/);
    assert.equal(state(FULL).status, "REQUIREMENT_ANALYSIS");
    assert.match(result.stdout, /agent:researcher/);
  });

  it("analyze → DESIGNING", async () => {
    const result = await runCli(["analyze", FULL, "--harness", "writer"], FIX_ENV());
    assert.equal(result.code, 0, result.stderr);
    assert.equal(state(FULL).status, "DESIGNING");
  });

  it("design dừng ở human gate và nhắc lệnh approve", async () => {
    const result = await runCli(["design", FULL, "--harness", "writer"], FIX_ENV());
    assert.equal(result.code, 0, result.stderr);
    assert.equal(state(FULL).status, "WAITING_DESIGN_APPROVAL");
    assert.match(result.stdout, /INV-05|human gate/);
    assert.match(result.stdout, /HUMAN_APPROVAL/);
  });

  it("plan bị chặn khi chưa approve kiến trúc", async () => {
    const result = await runCli(["plan", FULL, "--harness", "writer"], FIX_ENV());
    assert.equal(result.code, 1);
    assert.match(result.stdout, /HUMAN_APPROVAL_REQUIRED/);
    assert.equal(state(FULL).status, "WAITING_DESIGN_APPROVAL");
  });

  it("plan chạy được sau khi approve: import plan + chia wave", async () => {
    await runCli(
      ["record", FULL, "--type", "HUMAN_APPROVAL", "--status", "PASS", "--gate-id", "architecture", "--approver", "SA", "--approved-at", new Date().toISOString()],
      FIX_ENV(),
    );
    const result = await runCli(["plan", FULL, "--harness", "writer"], FIX_ENV());
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /plan:import — 1 task · 1 wave/);
    assert.equal(state(FULL).status, "READY_TO_IMPLEMENT");
  });

  it("implement: compile context + chạy wave + thu evidence cơ học + → REVIEWING", async () => {
    const result = await runCli(["implement", FULL, "--harness", "writer", "--project", "sample-fixture"], FIX_ENV());
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /context:TASK-01/);
    assert.match(result.stdout, /wave:1/);
    assert.match(result.stdout, /agent:developer:TASK-01/);
    assert.match(result.stdout, /evidence:tests/);
    assert.match(result.stdout, /evidence:scope/);
    assert.equal(state(FULL).status, "REVIEWING");
    assert.deepEqual(state(FULL).completedTasks, ["TASK-01"]);
  });

  it("review: reviewer ghi evidence SPEC+QUALITY → AUDITING", async () => {
    const result = await runCli(["review", FULL, "--harness", "writer"], FIX_ENV());
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /agent:reviewer:TASK-01/);
    assert.equal(state(FULL).status, "AUDITING");
  });

  it("audit → VERIFYING", async () => {
    const result = await runCli(["audit", FULL, "--harness", "writer"], FIX_ENV());
    assert.equal(result.code, 0, result.stderr);
    assert.equal(state(FULL).status, "VERIFYING");
  });

  it("verify: build + test + scope tươi rồi → DONE", async () => {
    const result = await runCli(["verify", FULL, "--project", "sample-fixture"], FIX_ENV());
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /evidence:build/);
    assert.match(result.stdout, /evidence:tests/);
    assert.equal(state(FULL).status, "DONE");
  });

  it("evidence cuối đủ cho gate DONE (BUILD + TEST + SCOPE + AUDIT)", async () => {
    const listed = await runCli(["evidence", FULL, "--json"], FIX_ENV());
    const items = JSON.parse(listed.stdout);
    const types = items.map((item) => item.type);
    for (const required of ["BUILD", "TEST", "SCOPE_VALIDATION", "AUDIT", "SPEC_REVIEW", "QUALITY_REVIEW", "HUMAN_APPROVAL"]) {
      assert.ok(types.includes(required), `thiếu evidence ${required}: ${types.join(",")}`);
    }
    assert.ok(items.every((item) => item.status === "PASS"));
  });
});

describe("phase commands — nhánh lỗi", () => {
  before(async () => {
    await runCli(["new", FAILCASE, "--title", "worker fail", "--risk", "LOW"]);
    await runCli(["new", NOEVID, "--title", "thiếu evidence", "--risk", "LOW"]);
  });

  it("worker fail ⇒ recovery tự động áp dụng (không đứng im ở trạng thái lỗi)", async () => {
    const result = await runCli(["translate", FAILCASE, "--harness", "failing"], FIX_ENV());
    assert.equal(result.code, 1);
    assert.match(result.stdout, /agent:researcher/);
    assert.match(result.stdout, /recovery:/);
    assert.match(result.stdout, /recovery|DEBUGGING|BLOCKED/);

    const after = state(FAILCASE);
    // Lỗi ở phase ngoài nhánh implementation: state machine không có đường sang DEBUGGING
    // ⇒ phải BLOCK (kèm lý do) và giữ status để chạy lại phase, KHÔNG im lặng bỏ qua.
    assert.equal(after.blocked, true, "phải block khi không có đường sang DEBUGGING");
    assert.equal(after.status, "TRANSLATING", "giữ status của phase để chạy lại sau khi xử lý");
    assert.ok(after.blockReason.length > 0);
    assert.match(result.stdout, /eng unblock/);
  });

  it("implement thiếu evidence cơ học ⇒ báo rõ còn thiếu gì, không nới gate", async () => {
    // chạy đủ tới IMPLEMENTING nhưng KHÔNG cấu hình project ⇒ không thu được TEST/SCOPE
    await runCli(["advance", NOEVID, "--to", "TRANSLATING"], FIX_ENV());
    for (const status of ["REQUIREMENT_ANALYSIS", "IMPACT_ANALYSIS", "DESIGNING", "WAITING_DESIGN_APPROVAL"]) {
      await runCli(["advance", NOEVID, "--to", status], FIX_ENV());
    }
    await runCli(
      ["record", NOEVID, "--type", "HUMAN_APPROVAL", "--status", "PASS", "--gate-id", "architecture", "--approver", "SA", "--approved-at", new Date().toISOString()],
      FIX_ENV(),
    );
    for (const status of ["PLANNING", "READY_TO_IMPLEMENT"]) {
      await runCli(["advance", NOEVID, "--to", status], FIX_ENV());
    }
    await runCli(["plan", "import", NOEVID, "--file", path.join(REPO_ROOT, "tests", "fixtures", "plans", "valid-plan.md")], FIX_ENV());

    const result = await runCli(["implement", NOEVID, "--harness", "writer", "--no-recover"], FIX_ENV());
    assert.equal(result.code, 1);
    assert.match(result.stdout, /EVIDENCE_REQUIRED|evidence:(tests|scope)/);
    assert.equal(state(NOEVID).blocked, false, "không tự block khi chỉ thiếu evidence");
    assert.notEqual(state(NOEVID).status, "DONE");
  });
});
