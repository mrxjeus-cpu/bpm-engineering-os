import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  checkGates,
  checkHarness,
  checkModels,
  checkProjects,
  checkRisk,
  clearConfigCache,
  renderDoctor,
  resolveBinary,
  runDoctor,
} from "../runtime/dist/index.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "runtime", "dist", "cli.js");
const FIXTURE_SOURCE = path.join(REPO_ROOT, "tests", "fixtures", "sample-repo");

const tempFiles = [];
const tempDirs = [];

function tempFile(name, content) {
  const dir = mkdtempSync(path.join(tmpdir(), "domain-doctor-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  writeFileSync(file, content, "utf8");
  tempFiles.push(file);
  return file;
}

/** Repo đích "sạch" cho test: git repo thật, có commit, đang ở feature branch. */
function makeCleanRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "domain-doctor-repo-"));
  tempDirs.push(dir);
  cpSync(FIXTURE_SOURCE, dir, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "doctor@example.invalid");
  git("config", "user.name", "Doctor Test");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("checkout", "-q", "-b", "feature/doctor");
  return dir;
}

function projectsConfigFor(repoRoot) {
  return tempFile(
    "projects.yaml",
    [
      "version: 1",
      "defaultProject: doctor-fixture",
      "workspace:",
      "  workstreamRoot: .engineering/workstreams",
      "  globalRoot: .engineering/global",
      "protectedBranches: [main, dev, production]",
      "projects:",
      "  doctor-fixture:",
      '    label: "repo cho test doctor"',
      "    repoRoot:",
      "      env: DOCTOR_REPO_ROOT",
      "      default: null",
      "    language: java",
      "    buildSystem: maven",
      "    scope:",
      "      allowedRoots: [src/main/java]",
      "      allowDeletions: []",
      "    commands:",
      "      build: [[mvn, -q, -DskipTests, package]]",
      "    testSuites:",
      "      unit: { profile: unit }",
      "    worktrees:",
      "      enabled: false",
      "",
    ].join("\n"),
  );
}

function withConfigEnv(env, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  clearConfigCache();
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearConfigCache();
  }
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runCli(args, env = {}) {
  return execFileAsync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, env: { ...process.env, ...env } })
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
    .catch((error) => ({
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }));
}

describe("doctor — check đơn lẻ bắt đúng lớp lỗi cấu hình", () => {
  it("resolveBinary: có trên PATH thì trả đường dẫn, tên vô lý thì null", () => {
    assert.ok(resolveBinary("node"), "node phải resolve được");
    assert.equal(resolveBinary("khong-co-binary-nay-9f3a1"), null);
  });

  it("gate gắn vào transition không tồn tại ⇒ FAIL kèm cách sửa (lỗi đã từng xảy ra thật)", () => {
    const gates = tempFile(
      "gates.yaml",
      [
        "version: 1",
        "defaultMode: normal",
        "modes:",
        "  normal: { humanGates: [architecture], allowedRisk: [LOW, MEDIUM, HIGH, CRITICAL] }",
        "gates:",
        "  - id: architecture",
        "    type: human",
        "    transition: [DESIGNING, PLANNING]", // thật ra phải qua WAITING_DESIGN_APPROVAL
        "    required: true",
        "approvals: { evidenceType: HUMAN_APPROVAL, requiredFields: [gateId], store: x }",
        "",
      ].join("\n"),
    );
    const check = withConfigEnv({ GATES_CONFIG: gates }, () => checkGates());
    assert.equal(check.level, "fail");
    assert.match(check.detail, /DESIGNING → PLANNING/);
    assert.match(check.detail, /WAITING_DESIGN_APPROVAL/);
    assert.match(check.hint ?? "", /TRANSITIONS|state\/machine\.ts/);
  });

  it("mode tham chiếu gate không tồn tại ⇒ FAIL", () => {
    const gates = tempFile(
      "gates.yaml",
      [
        "version: 1",
        "defaultMode: normal",
        "modes:",
        "  normal: { humanGates: [khong_co_gate_nay], allowedRisk: [LOW] }",
        "gates:",
        "  - id: architecture",
        "    type: human",
        "    transition: [WAITING_DESIGN_APPROVAL, PLANNING]",
        "    required: true",
        "approvals: { evidenceType: HUMAN_APPROVAL, requiredFields: [gateId], store: x }",
        "",
      ].join("\n"),
    );
    const check = withConfigEnv({ GATES_CONFIG: gates }, () => checkGates());
    assert.equal(check.level, "fail");
    assert.match(check.detail, /khong_co_gate_nay/);
  });

  it("risk thiếu effects cho một mức ⇒ FAIL (CRITICAL sẽ mất gate cuối)", () => {
    const risk = tempFile(
      "risk.yaml",
      [
        "version: 1",
        "scale: [LOW, MEDIUM, HIGH, CRITICAL]",
        "thresholds: { MEDIUM: 3, HIGH: 6, CRITICAL: 10 }",
        "factors: []",
        "effects:",
        "  LOW: {}",
        "  MEDIUM: {}",
        "  HIGH: {}",
        "",
      ].join("\n"),
    );
    const check = withConfigEnv({ RISK_CONFIG: risk }, () => checkRisk());
    assert.equal(check.level, "fail");
    assert.match(check.detail, /CRITICAL/);
  });

  it("riskFloor thiếu mức ⇒ models-map FAIL; routing vẫn resolve được", () => {
    const models = tempFile(
      "models.yaml",
      [
        "version: 1",
        "tiers: { cheap: glm-text, small: haiku, medium: sonnet, large: opus }",
        "agents: { translator: cheap, researcher: medium, requirements: medium, impact: medium, architect: large, developer: medium, reviewer: medium, auditor: large }",
        "complexity: { simple: small, medium: medium, complex: large }",
        "riskFloor: { LOW: small, MEDIUM: medium, HIGH: medium }",
        "routing:",
        "  weights: { complexity: 0.4, risk: 0.4 }",
        "  caps: { minTier: small, maxTier: large, fallback: medium }",
        "  neverBelowRiskFloor: true",
        "",
      ].join("\n"),
    );
    const checks = withConfigEnv({ MODELS_CONFIG: models }, () => checkModels());
    const map = checks.find((check) => check.id === "models-map");
    assert.equal(map.level, "fail");
    assert.match(map.detail, /riskFloor thiếu: CRITICAL/);
    assert.equal(checks.find((check) => check.id === "models-route").level, "ok");
  });

  it("harness bật nhưng binary không tồn tại ⇒ FAIL (không để chết giữa phase)", () => {
    const models = tempFile(
      "models.yaml",
      [
        "version: 1",
        "tiers: { small: haiku, medium: sonnet, large: opus }",
        "agents: { developer: medium }",
        "complexity: { simple: small, medium: medium, complex: large }",
        "riskFloor: { LOW: small, MEDIUM: medium, HIGH: medium, CRITICAL: large }",
        "routing:",
        "  weights: { complexity: 0.4, risk: 0.4 }",
        "  caps: { minTier: small, maxTier: large, fallback: medium }",
        "  neverBelowRiskFloor: true",
        "harness:",
        "  broken:",
        "    enabled: true",
        '    command: ["khong-co-cli-llm-nay-7c2b"]',
        '    cwd: "{osRoot}"',
        "",
      ].join("\n"),
    );
    const check = withConfigEnv({ MODELS_CONFIG: models }, () => checkHarness());
    assert.equal(check.level, "fail");
    assert.match(check.detail, /khong-co-cli-llm-nay-7c2b/);
  });

  it("không harness nào bật ⇒ WARN (chỉ dry run được), không phải FAIL", () => {
    const models = tempFile(
      "models.yaml",
      [
        "version: 1",
        "tiers: { small: haiku }",
        "agents: { developer: small }",
        "complexity: { simple: small, medium: small, complex: small }",
        "riskFloor: { LOW: small, MEDIUM: small, HIGH: small, CRITICAL: small }",
        "routing:",
        "  weights: { complexity: 0.4, risk: 0.4 }",
        "  caps: { minTier: small, maxTier: small, fallback: small }",
        "  neverBelowRiskFloor: true",
        "harness:",
        "  off:",
        "    enabled: false",
        '    command: ["node", "-e", "0"]',
        "",
      ].join("\n"),
    );
    const check = withConfigEnv({ MODELS_CONFIG: models }, () => checkHarness());
    assert.equal(check.level, "warn");
    assert.match(check.detail, /KHÔNG cái nào enabled/);
  });
});

describe("doctor — project đích", () => {
  let repo;
  let projectsConfig;

  before(() => {
    repo = makeCleanRepo();
    projectsConfig = projectsConfigFor(repo);
  });

  it("repo sạch + feature branch + scope/commands đủ ⇒ OK", async () => {
    const checks = await withConfigEnv({ PROJECTS_CONFIG: projectsConfig, DOCTOR_REPO_ROOT: repo }, () =>
      checkProjects("doctor-fixture"),
    );
    // checkProjects là async: withConfigEnv trả Promise ⇒ chờ ngoài, nhưng env đã bị khôi phục.
    const resolved = await checks;
    const check = resolved[0];
    assert.equal(check.level, "ok", check.detail);
    assert.match(check.detail, /feature\/doctor/);
    assert.deepEqual(check.details.commands, ["build"]);
  });

  it("thiếu env repoRoot ⇒ FAIL khi chỉ định project, WARN khi quét tất cả", async () => {
    // không set DOCTOR_REPO_ROOT ⇒ required vì chỉ định đích danh
    const withoutEnv = await withConfigEnv({ PROJECTS_CONFIG: projectsConfig }, async () => checkProjects("doctor-fixture"));
    assert.equal(withoutEnv[0].level, "fail");
    assert.match(withoutEnv[0].detail, /DOCTOR_REPO_ROOT/);
    assert.match(withoutEnv[0].hint ?? "", /INV-06|không đoán/);

    const all = await withConfigEnv({ PROJECTS_CONFIG: projectsConfig }, async () => checkProjects());
    assert.equal(all[0].level, "warn");
  });

  it("repo đích không phải git repo ⇒ FAIL (scope/worktree không dùng được)", async () => {
    const plain = mkdtempSync(path.join(tmpdir(), "domain-doctor-plain-"));
    tempDirs.push(plain);
    const check = (
      await withConfigEnv({ PROJECTS_CONFIG: projectsConfig, DOCTOR_REPO_ROOT: plain }, async () => checkProjects("doctor-fixture"))
    )[0];
    assert.equal(check.level, "fail");
    assert.match(check.detail, /không phải git repo/);
  });

  it("đang ở branch bảo vệ ⇒ WARN kèm nhắc tạo feature branch", async () => {
    execFileSync("git", ["checkout", "-q", "main"], { cwd: repo, stdio: "pipe" });
    const check = (
      await withConfigEnv({ PROJECTS_CONFIG: projectsConfig, DOCTOR_REPO_ROOT: repo }, async () => checkProjects("doctor-fixture"))
    )[0];
    assert.equal(check.level, "warn");
    assert.match(check.detail, /branch bảo vệ "main"/);
    execFileSync("git", ["checkout", "-q", "feature/doctor"], { cwd: repo, stdio: "pipe" });
  });
});

describe("eng doctor — CLI", () => {
  it("--json trả report parse được, exit 0 khi không có FAIL", async () => {
    const result = await runCli(["doctor", "--json", "--project", "sample-fixture"]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.fail, 0);
    assert.equal(report.summary.exitCode, 0);
    assert.ok(report.checks.length >= 10);
    for (const check of report.checks) {
      assert.ok(["ok", "warn", "fail"].includes(check.level), `level lạ: ${check.level}`);
      assert.ok(check.detail.length > 0, `check ${check.id} thiếu detail`);
    }
    assert.ok(report.checks.some((check) => check.id === "gates" && check.level === "ok"));
    assert.ok(report.checks.some((check) => check.id === "mcp"));
  });

  it("config hỏng ⇒ exit 1 và nêu đúng check fail", async () => {
    const gates = tempFile(
      "gates.yaml",
      [
        "version: 1",
        "defaultMode: normal",
        "modes:",
        "  normal: { humanGates: [], allowedRisk: [LOW] }",
        "gates:",
        "  - id: architecture",
        "    type: human",
        "    transition: [DESIGNING, PLANNING]",
        "    required: true",
        "approvals: { evidenceType: HUMAN_APPROVAL, requiredFields: [gateId], store: x }",
        "",
      ].join("\n"),
    );
    const result = await runCli(["doctor", "--json"], { GATES_CONFIG: gates });
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.ok(report.summary.fail >= 1);
    const failed = report.checks.filter((check) => check.level === "fail");
    assert.ok(failed.some((check) => check.id === "gates"));
    assert.match(renderDoctor(report), /sửa hết FAIL/);
  });

  it("--ping khởi động MCP thật và đếm được tool của 2 server", async () => {
    const result = await runCli(["doctor", "--json", "--ping"]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const ping = report.checks.find((check) => check.id === "mcp-ping");
    assert.ok(ping, "phải có check mcp-ping");
    assert.equal(ping.level, "ok", ping.detail);
    assert.match(ping.detail, /mcp-engineering: 31 tool \/ 6 group/);
    assert.match(ping.detail, /mcp-domain-core: 17 tool \/ 5 group/);
  });
});
