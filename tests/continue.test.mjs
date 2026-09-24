import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PHASE_NAMES, PHASES, nextPhaseFor, workstreamDir } from "../runtime/dist/index.js";
import { makeFixtureRepo } from "./helpers/fixture.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "runtime", "dist", "cli.js");
const HARNESS = path.join(REPO_ROOT, "tests", "fixtures", "harness", "write-report.mjs");
const FIXTURE_SOURCE = path.join(REPO_ROOT, "tests", "fixtures", "sample-repo");

const CT = "CT-2000"; // NEW → human gate → DONE bằng eng continue
const DRY = "CT-2001"; // --dry-run
const ALL = [CT, DRY];

/** Toàn bộ status của state machine (spec 8.1) — dùng để kiểm bảng ánh xạ pha. */
const STATUSES = [
  "NEW",
  "TRANSLATING",
  "REQUIREMENT_ANALYSIS",
  "IMPACT_ANALYSIS",
  "DESIGNING",
  "WAITING_DESIGN_APPROVAL",
  "PLANNING",
  "WAITING_PLAN_APPROVAL",
  "READY_TO_IMPLEMENT",
  "IMPLEMENTING",
  "FAILED",
  "DEBUGGING",
  "REVIEWING",
  "REWORK_REQUIRED",
  "AUDITING",
  "VERIFYING",
  "DONE",
];

let modelsConfig;
let fixture;

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

function env() {
  return { SAMPLE_FIXTURE_REPO_ROOT: fixture.dir };
}

function cleanup() {
  for (const taskId of ALL) rmSync(workstreamDir(taskId), { recursive: true, force: true });
}

function writeModelsConfig() {
  const file = path.join(tmpdir(), `continue-models-${Date.now()}.yaml`);
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
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

describe("eng continue — bảng ánh xạ status → pha", () => {
  it("mọi status đều ánh xạ tới một pha NHẬN status đó làm allowedFrom (hoặc null)", () => {
    for (const status of STATUSES) {
      const phase = nextPhaseFor(status);
      if (phase === null) continue;
      assert.ok(PHASE_NAMES.includes(phase), `${status} → ${phase} không phải phase hợp lệ`);
      assert.ok(
        PHASES[phase].allowedFrom.includes(status),
        `${status} → ${phase} nhưng ${phase}.allowedFrom không có ${status}`,
      );
    }
  });

  it("DONE không còn pha nào; các status 'giữa pha' resume được", () => {
    assert.equal(nextPhaseFor("DONE"), null);
    assert.equal(nextPhaseFor("NEW"), "translate");
    assert.equal(nextPhaseFor("IMPACT_ANALYSIS"), "analyze");
    assert.equal(nextPhaseFor("WAITING_DESIGN_APPROVAL"), "plan");
    assert.equal(nextPhaseFor("WAITING_PLAN_APPROVAL"), "plan");
    assert.equal(nextPhaseFor("FAILED"), "implement");
    assert.equal(nextPhaseFor("VERIFYING"), "verify");
  });
});

describe("eng continue — chạy thật", () => {
  before(() => {
    cleanup();
  });

  it("--dry-run: in các pha sẽ chạy và KHÔNG đổi state", async () => {
    await runCli(["new", DRY, "--title", "continue dry", "--risk", "MEDIUM"], env());
    const result = await runCli(["continue", DRY, "--dry-run", "--harness", "writer"], env());
    assert.equal(result.code, 1, "dry run chưa DONE nên phải trả 1");
    assert.match(result.stdout, /\(dry run\)/);
    assert.match(result.stdout, /translate/);
    assert.match(result.stdout, /analyze/);
    assert.match(result.stdout, /HUMAN_GATE/);
    assert.equal(state(DRY).status, "NEW");
    assert.equal(state(DRY).history.length, 1, "dry run không được ghi history");
  });

  it("từ NEW: một lệnh chạy 3 pha rồi DỪNG ở human gate (exit 1)", async () => {
    await runCli(["new", CT, "--title", "Thêm Purpose of Loan vào policy input", "--risk", "HIGH"], env());
    const result = await runCli(["continue", CT, "--harness", "writer", "--project", "sample-fixture"], env());

    assert.equal(result.code, 1, "chưa tới DONE ⇒ exit 1 (chờ người)");
    assert.equal(state(CT).status, "WAITING_DESIGN_APPROVAL");
    assert.match(result.stdout, /translate\s+NEW → REQUIREMENT_ANALYSIS/);
    assert.match(result.stdout, /analyze\s+REQUIREMENT_ANALYSIS → DESIGNING/);
    assert.match(result.stdout, /design\s+DESIGNING → WAITING_DESIGN_APPROVAL/);
    assert.match(result.stdout, /dừng vì : HUMAN_GATE/);
    assert.match(result.stdout, /architecture \(WAITING_DESIGN_APPROVAL → PLANNING\)/);
    // phải in ra ĐÚNG lệnh cần gõ tiếp, không bắt người dùng nhớ
    assert.match(result.stdout, /eng record CT-2000 --type HUMAN_APPROVAL --status PASS --gate-id architecture/);
    assert.match(result.stdout, /eng continue CT-2000/);
  });

  it("không chạy pha sau khi bị human gate chặn (không tự approve — INV-05)", async () => {
    // plan chưa được chạy ⇒ chưa có plan.json
    const listed = await runCli(["plan", "show", CT], env());
    assert.equal(listed.code, 1);
    assert.match(listed.stderr, /PLAN_NOT_FOUND/);
  });

  it("sau khi approve: MỘT lệnh chạy plan → implement → review → audit → verify tới DONE", async () => {
    await runCli(
      [
        "record", CT, "--type", "HUMAN_APPROVAL", "--status", "PASS", "--gate-id", "architecture",
        "--approver", "SA", "--approved-at", new Date().toISOString(),
      ],
      env(),
    );

    const result = await runCli(["continue", CT, "--harness", "writer", "--project", "sample-fixture"], env());
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(state(CT).status, "DONE");
    for (const phase of ["plan", "implement", "review", "audit", "verify"]) {
      assert.match(result.stdout, new RegExp(`✔ ${phase}\\b`), `thiếu bước ${phase}`);
    }
    assert.match(result.stdout, /✓ continue CT-2000 — WAITING_DESIGN_APPROVAL → DONE/);
    assert.match(result.stdout, /dừng vì : DONE/);
  });

  it("ticket đã DONE: continue không chạy gì thêm và trả 0", async () => {
    const before = state(CT).history.length;
    const result = await runCli(["continue", CT, "--harness", "writer", "--project", "sample-fixture"], env());
    assert.equal(result.code, 0, result.stderr);
    assert.equal(state(CT).status, "DONE");
    assert.equal(state(CT).history.length, before, "không được ghi thêm transition");
    assert.match(result.stdout, /dừng vì : DONE/);
  });

  it("--json trả stoppedBecause + steps cho CI đọc", async () => {
    const result = await runCli(["continue", CT, "--json"], env());
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.stoppedBecause, "DONE");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.to, "DONE");
    assert.ok(Array.isArray(parsed.steps));
  });
});
