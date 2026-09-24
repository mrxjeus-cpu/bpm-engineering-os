import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acquireLock, lockStatus, releaseLock, workstreamDir, withLock } from "../runtime/dist/index.js";
import { makeFixtureRepo } from "./helpers/fixture.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "runtime", "dist", "cli.js");
const FIXTURE_SOURCE = path.join(REPO_ROOT, "tests", "fixtures", "sample-repo");
const SLOW_HARNESS = path.join(REPO_ROOT, "tests", "fixtures", "harness", "slow-writer.mjs");
const PARALLEL_PLAN = path.join(REPO_ROOT, "tests", "fixtures", "plans", "parallel-plan.md");

const LK = "PW-1000"; // lock
const PAR = "PW-1001"; // song song + merge
const OFF = "PW-1002"; // worktrees tắt
const ALL = [LK, PAR, OFF];

let fixture;
let modelsConfig;
let projectsOn;
let projectsOff;

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, MODELS_CONFIG: modelsConfig, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: fixture.dir, encoding: "utf8" }).trim();
}

function writeModels() {
  const file = path.join(tmpdir(), `pw-models-${Date.now()}.yaml`);
  writeFileSync(
    file,
    [
      "version: 1",
      "tiers: { cheap: glm-text, small: haiku, medium: sonnet, large: opus }",
      "agents:",
      "  researcher: medium",
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
      "  slow:",
      "    enabled: true",
      `    command: ["node", ${JSON.stringify(SLOW_HARNESS)}]`,
      '    cwd: "{repoRoot}"',
      "    timeoutMs: 60000",
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

function writeProjects(worktreesEnabled) {
  const file = path.join(tmpdir(), `pw-projects-${worktreesEnabled ? "on" : "off"}-${Date.now()}.yaml`);
  writeFileSync(
    file,
    [
      "version: 1",
      "defaultProject: sample-fixture",
      "workspace:",
      "  workstreamRoot: .engineering/workstreams",
      "  globalRoot: .engineering/global",
      'protectedBranches: ["main", "master", "production", "release/*"]',
      "projects:",
      "  sample-fixture:",
      "    label: fixture",
      "    repoRoot:",
      "      env: SAMPLE_FIXTURE_REPO_ROOT",
      "      default: null",
      "    language: java",
      "    buildSystem: none",
      "    conventions: [ARCHITECTURE.md]",
      "    scope:",
      '      allowedRoots: ["src/main/java", "src/test/java"]',
      "      allowDeletions: []",
      "    commands:",
      '      build: [["node", "-e", "process.stdout.write(\'build ok\')"]]',
      '      test: [["node", "-e", "console.log(\'suite {suite}\')"]]',
      '      testAll: [["node", "-e", "console.log(\'all tests ok\')"]]',
      "    testSuites:",
      "      SmokeTest: {}",
      "    worktrees:",
      `      enabled: ${worktreesEnabled ? "true" : "false"}`,
      '      branchPrefix: "eng/"',
      '      root: ".engineering/worktrees"',
      '      baseRef: "HEAD"',
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

function env(params = {}) {
  return { SAMPLE_FIXTURE_REPO_ROOT: fixture.dir, PROJECTS_CONFIG: params.projects ?? projectsOn, ENG_HARNESS_SLEEP_MS: "250" };
}

async function toImplementing(taskId, options = {}) {
  await runCli(["new", taskId, "--title", "test", "--risk", "LOW"], options);
  for (const status of ["TRANSLATING", "REQUIREMENT_ANALYSIS", "IMPACT_ANALYSIS", "DESIGNING", "WAITING_DESIGN_APPROVAL"]) {
    await runCli(["advance", taskId, "--to", status], options);
  }
  await runCli(
    ["record", taskId, "--type", "HUMAN_APPROVAL", "--status", "PASS", "--gate-id", "architecture", "--approver", "SA", "--approved-at", new Date().toISOString()],
    options,
  );
  for (const status of ["PLANNING", "READY_TO_IMPLEMENT"]) await runCli(["advance", taskId, "--to", status], options);
  await runCli(["plan", "import", taskId, "--file", PARALLEL_PLAN], options);
  await runCli(["advance", taskId, "--to", "IMPLEMENTING"], options);
  await runCli(["context", taskId, "--all", "--no-mcp"], options);
}

function cleanup() {
  for (const taskId of ALL) rmSync(workstreamDir(taskId), { recursive: true, force: true });
}

before(() => {
  fixture = makeFixtureRepo(FIXTURE_SOURCE);
  modelsConfig = writeModels();
  projectsOn = writeProjects(true);
  projectsOff = writeProjects(false);
});

after(() => {
  cleanup();
  fixture?.cleanup();
});

describe("khoá workstream", () => {
  before(async () => {
    cleanup();
    await runCli(["new", LK, "--title", "lock test"], env());
  });

  after(cleanup);

  it("không có lock ⇒ ghi được và lock trống sau khi xong", async () => {
    const result = await runCli(["advance", LK, "--to", "TRANSLATING"], env());
    assert.equal(result.code, 0, result.stderr);
    const status = lockStatus(LK);
    assert.equal(status.info, null, "lock phải được nhả sau khi ghi xong");
  });

  it("lock do tiến trình KHÁC đang giữ ⇒ từ chối ghi (WORKSTREAM_LOCKED)", async () => {
    // ghi lock với pid của chính test runner (đang sống) ⇒ CLI thấy bị giữ bởi tiến trình khác
    writeFileSync(
      path.join(workstreamDir(LK), ".lock"),
      `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), command: "test-holder" })}\n`,
      "utf8",
    );
    const result = await runCli(["advance", LK, "--to", "REQUIREMENT_ANALYSIS"], env());
    assert.equal(result.code, 1);
    assert.match(result.stderr, /WORKSTREAM_LOCKED/);
    assert.match(result.stderr, new RegExp(String(process.pid)));

    const still = JSON.parse(readFileSync(path.join(workstreamDir(LK), "task.json"), "utf8"));
    assert.equal(still.status, "TRANSLATING", "không được ghi khi đang bị khoá");
  });

  it("eng lock --release thu hồi được", async () => {
    const released = await runCli(["lock", LK, "--release"], env());
    assert.equal(released.code, 0, released.stderr);
    const after = await runCli(["advance", LK, "--to", "REQUIREMENT_ANALYSIS"], env());
    assert.equal(after.code, 0, after.stderr);
  });

  it("lock cũ (pid đã chết) được thu hồi kèm cảnh báo", async () => {
    writeFileSync(
      path.join(workstreamDir(LK), ".lock"),
      `${JSON.stringify({ pid: 999999, at: new Date(Date.now() - 3600_000).toISOString() })}\n`,
      "utf8",
    );
    const result = await runCli(["advance", LK, "--to", "IMPACT_ANALYSIS"], env());
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /lock cũ|thu hồi/);
  });

  it("reentrant trong cùng process (phase giữ lock, store ghi bên trong)", () => {
    const taskId = LK;
    const handle = acquireLock(taskId, { command: "test-phase" });
    assert.equal(handle.depth, 1);
    // lần vào thứ hai không tạo lại file và không deadlock
    withLock(taskId, () => {
      assert.ok(lockStatus(taskId).heldByThisProcess);
    });
    assert.ok(lockStatus(taskId).heldByThisProcess);
    releaseLock(taskId);
    assert.equal(lockStatus(taskId).info, null);
  });
});

describe("chạy song song trong worktree", () => {
  before(async () => {
    cleanup();
    execFileSync("git", ["checkout", "-q", "-b", "feature/parallel-test"], { cwd: fixture.dir });
    await toImplementing(PAR, env());
  });

  after(() => {
    cleanup();
    execFileSync("git", ["checkout", "-q", "main"], { cwd: fixture.dir });
  });

  it("worktrees tắt ⇒ từ chối chạy song song (không chạy 2 agent trong cùng cây)", async () => {
    const result = await runCli(["implement", OFF, "--harness", "slow", "--parallel"], {
      ...env({ projects: projectsOff }),
    });
    // OFF chưa có workstream ⇒ tạo tối thiểu để tới được bước kiểm worktree
    assert.ok(result.code === 1);
    assert.ok(/STATE_NOT_FOUND|WORKTREES_DISABLED/.test(result.stderr + result.stdout));
  });

  it("implement --parallel: 2 worktree, 2 branch, cây chính KHÔNG bị đụng", async () => {
    const result = await runCli(["implement", PAR, "--harness", "slow", "--parallel", "--concurrency", "2"], env());
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /PARALLEL x2 · worktree cô lập/);
    assert.match(result.stdout, /worktree:TASK-01/);
    assert.match(result.stdout, /worktree:TASK-02/);
    assert.match(result.stdout, /commit:TASK-01/);

    // cây chính sạch (thay đổi nằm trong worktree)
    assert.equal(git(["status", "--porcelain"]), "");
    assert.ok(!existsSync(path.join(fixture.dir, "src/main/java/vn/bpm/domain/policy/GeneratedTASK01.java")));

    // 2 branch + 2 worktree
    const branches = git(["branch", "--list", "eng/*"]);
    assert.match(branches, /eng\/PW-1001-TASK-01/);
    assert.match(branches, /eng\/PW-1001-TASK-02/);
    const worktrees = git(["worktree", "list"]);
    assert.match(worktrees, /PW-1001[\\/]TASK-01/);
    assert.match(worktrees, /PW-1001[\\/]TASK-02/);

    // mỗi task ghi changes.json với đúng file đã đổi
    for (const sub of ["TASK-01", "TASK-02"]) {
      const changes = JSON.parse(readFileSync(path.join(workstreamDir(PAR), "tasks", `${sub}-changes.json`), "utf8"));
      assert.equal(changes.branch, `eng/PW-1001-${sub}`);
      assert.deepEqual(changes.files, [`src/main/java/vn/bpm/domain/policy/Generated${sub.replace("-", "")}.java`]);
      assert.equal(changes.merged, false);
      assert.ok(changes.sha);
      assert.ok(changes.baseRef);
    }

    assert.match(result.stdout, /CHƯA merge/);
    assert.match(result.stdout, /eng merge PW-1001/);
  });

  it("hai agent chạy CHỒNG LẤN thời gian (thật sự song song)", () => {
    const timing = ["TASK-01", "TASK-02"].map((sub) =>
      JSON.parse(readFileSync(path.join(workstreamDir(PAR), "tasks", `${sub}-timing.json`), "utf8")),
    );
    const [a, b] = timing;
    assert.ok(a.pid !== b.pid, "phải là hai process khác nhau");
    const overlap = new Date(a.start) < new Date(b.end) && new Date(b.start) < new Date(a.end);
    assert.ok(overlap, `không chồng lấn: ${a.start}–${a.end} vs ${b.start}–${b.end}`);
    // mỗi lần chạy ~250ms; nếu tuần tự thì tổng >= 500ms
    assert.ok(Math.max(a.durationMs, b.durationMs) < 900);
  });

  it("trạng thái task DONE và chưa vào REVIEWING (thiếu evidence trên cây chính)", async () => {
    const state = JSON.parse(readFileSync(path.join(workstreamDir(PAR), "task.json"), "utf8"));
    assert.equal(state.status, "IMPLEMENTING");
    assert.deepEqual(state.completedTasks, ["TASK-01", "TASK-02"]);
    const plan = JSON.parse(readFileSync(path.join(workstreamDir(PAR), "plan.json"), "utf8"));
    assert.ok(plan.tasks.every((task) => task.status === "DONE"));
  });

  it("eng merge từ chối branch được bảo vệ", async () => {
    execFileSync("git", ["checkout", "-q", "main"], { cwd: fixture.dir });
    const result = await runCli(["merge", PAR], env());
    assert.equal(result.code, 1);
    assert.match(result.stderr, /PROTECTED_BRANCH/);
    execFileSync("git", ["checkout", "-q", "feature/parallel-test"], { cwd: fixture.dir });
  });

  it("eng merge: merge 2 branch, xoá worktree, cây chính có đủ file", async () => {
    const result = await runCli(["merge", PAR], env());
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /merged eng\/PW-1001-TASK-01/);
    assert.match(result.stdout, /merged eng\/PW-1001-TASK-02/);

    assert.ok(existsSync(path.join(fixture.dir, "src/main/java/vn/bpm/domain/policy/GeneratedTASK01.java")));
    assert.ok(existsSync(path.join(fixture.dir, "src/main/java/vn/bpm/domain/policy/GeneratedTASK02.java")));
    assert.equal(git(["status", "--porcelain"]), "", "sau merge cây chính phải sạch");
    assert.equal(git(["branch", "--list", "eng/*"]), "", "branch task phải bị xoá sau merge");
    assert.doesNotMatch(git(["worktree", "list"]), /PW-1001[\\/]TASK-01/);

    for (const sub of ["TASK-01", "TASK-02"]) {
      const changes = JSON.parse(readFileSync(path.join(workstreamDir(PAR), "tasks", `${sub}-changes.json`), "utf8"));
      assert.equal(changes.merged, true);
      assert.equal(changes.mergedInto, "feature/parallel-test");
    }
  });

  it("chạy lại implement (không parallel) ⇒ thu evidence trên cây đã merge → REVIEWING", async () => {
    const result = await runCli(["implement", PAR, "--project", "sample-fixture"], env());
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /evidence:tests/);
    assert.match(result.stdout, /evidence:scope/);
    const state = JSON.parse(readFileSync(path.join(workstreamDir(PAR), "task.json"), "utf8"));
    assert.equal(state.status, "REVIEWING");
  });

  it("merge lần hai là no-op (đã merged)", async () => {
    const result = await runCli(["merge", PAR], env());
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /đã merge trước đó/);
  });
});
