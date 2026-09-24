import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  applyPlanRepos,
  checkWave,
  detectConflicts,
  evaluateEvidenceGate,
  parsePlanMarkdown,
  reposForTicket,
  workstreamDir,
} from "../runtime/dist/index.js";
import { makeFixtureRepo } from "./helpers/fixture.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "runtime", "dist", "cli.js");
const SAMPLE = path.join(REPO_ROOT, "tests", "fixtures", "sample-repo");

const A = "MR-1001"; // ticket 2 repo, gate theo từng repo
const B = "MR-1002"; // context theo repo của task
const C = "MR-1003"; // parallel: worktree trong 2 repo khác nhau
const ALL = [A, B, C];

/** Hai repo nằm ở HAI thư mục cha khác nhau — đúng tình huống thật cần hỗ trợ. */
let parentA;
let parentB;
let repoA;
let repoB;
let configFile;
let configParallel;
let modelsConfig;
let sandbox;

/** Hai task độc lập, mỗi task một repo, CÙNG đường dẫn file tương đối ⇒ phải KHÔNG phải conflict. */
const PLAN_PARALLEL = `# Implementation plan — parallel multi-repo

## TASK-01 — Sửa Shared.java ở repo A

### Objective
Sửa Shared.java trong repo A.

### Repo
repo-a

### Files
- src/main/java/vn/bpm/domain/policy/Shared.java

### Dependencies
none

### Existing Pattern
PolicyInputMapper hiện có.

### Acceptance Criteria
- Shared.java của repo A được cập nhật.

### Verification
- node -e "console.log('ok')"

## TASK-02 — Sửa Shared.java ở repo B

### Objective
Sửa Shared.java trong repo B (repo khác, file cùng đường dẫn tương đối).

### Repo
repo-b

### Files
- src/main/java/vn/bpm/domain/policy/Shared.java

### Dependencies
none

### Existing Pattern
PolicyInputMapper hiện có.

### Acceptance Criteria
- Shared.java của repo B được cập nhật.

### Verification
- node -e "console.log('ok')"
`;

async function runCli(args, extraEnv = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      // PROJECTS_CONFIG trỏ tới config tạm; MCP server con cũng thừa hưởng env này.
      env: {
        ...process.env,
        ...(modelsConfig ? { MODELS_CONFIG: modelsConfig } : {}),
        PROJECTS_CONFIG: configFile,
        MR_REPO_A: repoA,
        MR_REPO_B: repoB,
        ...extraEnv,
      },
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

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function planJson(taskId) {
  return JSON.parse(readFileSync(path.join(workstreamDir(taskId), "plan.json"), "utf8"));
}

function stateJson(taskId) {
  return JSON.parse(readFileSync(path.join(workstreamDir(taskId), "task.json"), "utf8"));
}

function contextJson(taskId, subTaskId) {
  return JSON.parse(readFileSync(path.join(workstreamDir(taskId), "context", `${subTaskId}.json`), "utf8"));
}

/** Config 2 project; `worktrees` bật/tắt để test cả đường parallel. */
function projectsYaml(worktreesEnabled) {
  const project = (name, letter) =>
    [
      `  ${name}:`,
      `    label: "Repo ${letter}"`,
      `    repoRoot: { env: MR_REPO_${letter}, default: null }`,
      "    language: java",
      "    buildSystem: maven",
      "    conventions: [ARCHITECTURE.md]",
      '    scope: { allowedRoots: ["src/main/java", "src/test/java"], allowDeletions: [] }',
      "    commands:",
      `      build: [["node", "-e", "console.log('build ${letter}')"]]`,
      `      test: [["node", "-e", "console.log('test ${letter} {suite}')"]]`,
      `      testAll: [["node", "-e", "console.log('testAll ${letter}')"]]`,
      `      verify: [["node", "-e", "console.log('verify ${letter}')"]]`,
      "    testSuites: { PolicyInputMapperTest: {} }",
      "    worktrees:",
      `      enabled: ${worktreesEnabled ? "true" : "false"}`,
      '      branchPrefix: "eng/"',
      '      root: ".engineering/worktrees"',
      '      baseRef: "HEAD"',
    ].join("\n");

  return [
    "version: 1",
    "defaultProject: repo-a",
    "workspace:",
    "  workstreamRoot: .engineering/workstreams",
    "  globalRoot: .engineering/global",
    'protectedBranches: ["main", "master", "dev", "develop", "production", "release/*"]',
    "projects:",
    project("repo-a", "A"),
    project("repo-b", "B"),
    "",
  ].join("\n");
}

function writePlanFile(taskId, body) {
  const file = path.join(sandbox, `${taskId}-plan.md`);
  writeFileSync(file, body, "utf8");
  return file;
}

const planBody = (repoA, repoB) => `# Implementation plan — multi-repo

## TASK-01 — Đổi contract phía service A

### Objective
Thêm field purposeOfLoan vào PolicyInput của repo A.

### Repo
${repoA}

### Files
- src/main/java/vn/bpm/domain/policy/PolicyInput.java

### Symbols
- PolicyInput

### Existing Pattern
PolicyInput hiện dùng field + getter/setter.

### Acceptance Criteria
- PolicyInput có field mới; test mapper PASS.

### Verification
- node -e "console.log('ok')"

## TASK-02 — Cập nhật consumer phía B

### Objective
Consumer ở repo B đọc field mới sau khi repo A xong.

### Repo
${repoB}

### Files
- src/main/java/vn/bpm/domain/fact/LoanFact.java

### Symbols
- LoanFact

### Dependencies
- TASK-01

### Existing Pattern
LoanFact là POJO map 1-1.

### Acceptance Criteria
- Consumer map được field mới; test PASS.

### Verification
- node -e "console.log('ok')"
`;

const PLAN_BODY = planBody("repo-a", "repo-b");

describe("multi-repo — parser plan.md", () => {
  it("đọc được ### Repo thành task.repo", () => {
    const parsed = parsePlanMarkdown(PLAN_BODY);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.tasks.find((task) => task.id === "TASK-01").repo, "repo-a");
    assert.equal(parsed.tasks.find((task) => task.id === "TASK-02").repo, "repo-b");
  });

  it("task không khai Repo thì không bị gán repo (giữ nguyên luồng single-repo)", () => {
    const parsed = parsePlanMarkdown(`## TASK-01 — x\n\n### Objective\ny\n\n### Acceptance Criteria\n- z\n\n### Verification\n- v\n`);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.tasks[0].repo, undefined);
  });

  it("khai nhiều Repo trong một task ⇒ lỗi MULTIPLE_REPO", () => {
    const parsed = parsePlanMarkdown(
      `## TASK-01 — x\n\n### Objective\ny\n\n### Repo\n- repo-a\n- repo-b\n\n### Acceptance Criteria\n- z\n\n### Verification\n- v\n`,
    );
    assert.ok(parsed.errors.some((error) => error.code === "MULTIPLE_REPO"));
  });
});

describe("multi-repo — repo của ticket", () => {
  it("không khai gì ⇒ reposForTicket trả về rỗng (fallback --project)", () => {
    const plan = parsePlanMarkdown(`## TASK-01 — x\n\n### Objective\ny\n\n### Acceptance Criteria\n- z\n\n### Verification\n- v\n`);
    const withRepos = applyPlanRepos({ schemaVersion: 1, taskId: "MR-2000", tasks: plan.tasks }, []);
    assert.deepEqual(withRepos.errors, []);
    assert.deepEqual(withRepos.repos, []);
    assert.equal(withRepos.repos.length, 0);
  });

  it("ticket khai 2 repo ⇒ task thiếu Repo nhận repo chính", () => {
    const plan = parsePlanMarkdown(
      `## TASK-01 — x\n\n### Objective\ny\n\n### Acceptance Criteria\n- z\n\n### Verification\n- v\n\n## TASK-02 — x2\n\n### Objective\ny2\n\n### Acceptance Criteria\n- z2\n\n### Verification\n- v2\n`,
    );
    const applied = applyPlanRepos({ schemaVersion: 1, taskId: "MR-2001", tasks: plan.tasks }, ["repo-a", "repo-b"]);
    assert.deepEqual(applied.errors, []);
    assert.deepEqual(applied.repos, ["repo-a", "repo-b"]);
    assert.equal(plan.tasks[0].repo, "repo-a");
    assert.equal(plan.tasks[1].repo, "repo-a");
  });

  it("repo khai trong plan trở thành repo chính khi ticket không khai", () => {
    const parsed = parsePlanMarkdown(planBody("individual-service", "policy-new"));
    const applied = applyPlanRepos({ schemaVersion: 1, taskId: "MR-2002", tasks: parsed.tasks }, []);
    assert.deepEqual(applied.errors, []);
    assert.deepEqual(applied.repos, ["individual-service", "policy-new"]);
  });

  it("repo không có trong config ⇒ lỗi rõ ràng, không suy diễn (INV-06)", () => {
    const parsed = parsePlanMarkdown(planBody("individual-service", "khong-ton-tai"));
    const applied = applyPlanRepos({ schemaVersion: 1, taskId: "MR-2003", tasks: parsed.tasks }, []);
    assert.equal(applied.errors.length, 1);
    assert.match(applied.errors[0], /khong-ton-tai/);
  });

  it("reposForTicket gộp repo của ticket và repo chỉ có trong plan", () => {
    const parsed = parsePlanMarkdown(PLAN_BODY);
    assert.deepEqual(reposForTicket(["repo-c"], { schemaVersion: 1, taskId: "MR-2004", tasks: parsed.tasks }), [
      "repo-c",
      "repo-a",
      "repo-b",
    ]);
  });
});

describe("multi-repo — conflict check (INV-11)", () => {
  const taskA = { id: "TASK-01", title: "a", objective: "a", repo: "repo-a", files: ["src/main/java/X.java"], symbols: ["X.run"], dependencies: [], acceptanceCriteria: ["x"], verification: ["x"], existingPattern: "p" };
  const taskB = { id: "TASK-02", title: "b", objective: "b", repo: "repo-b", files: ["src/main/java/X.java"], symbols: ["X.run"], dependencies: [], acceptanceCriteria: ["x"], verification: ["x"], existingPattern: "p" };
  const taskB2 = { ...taskB, repo: "repo-a" };

  it("cùng file/symbol ở HAI repo khác nhau ⇒ không conflict", () => {
    const conflicts = detectConflicts([taskA, taskB]);
    assert.deepEqual(
      conflicts.filter((conflict) => conflict.type === "FILE_OVERLAP" || conflict.type === "SYMBOL_OVERLAP"),
      [],
    );
    assert.equal(checkWave([taskA, taskB]).status, "PASS");
  });

  it("cùng file/symbol trong CÙNG repo ⇒ vẫn BLOCK", () => {
    const fileConflicts = detectConflicts([taskA, taskB2]).filter((conflict) => conflict.type === "FILE_OVERLAP");
    assert.equal(fileConflicts.length, 1);
    assert.match(fileConflicts[0].detail, /repo-a:src\/main\/java\/X\.java/);
    assert.equal(checkWave([taskA, taskB2]).status, "FAIL");
  });

  it("migration chỉ cạnh tranh thứ tự trong cùng repo", () => {
    const migrationA = { ...taskA, files: ["db/migration/V1__a.sql"] };
    const migrationB = { ...taskB, files: ["db/migration/V1__b.sql"] };
    const migrationB2 = { ...taskB2, files: ["db/migration/V1__b.sql"] };
    assert.equal(detectConflicts([migrationA, migrationB]).filter((c) => c.type === "MIGRATION_ORDER").length, 0);
    assert.equal(detectConflicts([migrationA, migrationB2]).filter((c) => c.type === "MIGRATION_ORDER").length, 1);
  });
});

describe("multi-repo — evidence gate theo từng repo (INV-03)", () => {
  const pass = (type, project, extra = {}) => ({ id: `EV-${type}-${project}`, taskId: "MR-1", type, status: "PASS", project, producer: "test", timestamp: new Date().toISOString(), ...extra });

  it("thiếu evidence của một repo ⇒ gate DONE không đạt và nêu rõ repo", () => {
    const evidence = [
      pass("BUILD", "repo-a"),
      pass("TEST", "repo-a"),
      pass("SCOPE_VALIDATION", "repo-a", { unexpectedFiles: [], deletedFiles: [] }),
      pass("AUDIT", null),
      pass("BUILD", "repo-b"),
    ];
    const result = evaluateEvidenceGate("DONE", evidence, { projects: ["repo-a", "repo-b"] });
    assert.equal(result.ok, false);
    assert.ok(result.missing.some((item) => item.startsWith("repo-b: TEST=PASS")));
    assert.ok(result.missing.some((item) => item.startsWith("repo-b: SCOPE_VALIDATION=PASS")));
    assert.ok(!result.missing.some((item) => item.startsWith("repo-a: BUILD")));
  });

  it("đủ evidence cho MỌI repo ⇒ gate DONE đạt", () => {
    const evidence = ["repo-a", "repo-b"].flatMap((project) => [
      pass("BUILD", project),
      pass("TEST", project),
      pass("SCOPE_VALIDATION", project, { unexpectedFiles: [], deletedFiles: [] }),
    ]);
    evidence.push(pass("AUDIT", null));
    const result = evaluateEvidenceGate("DONE", evidence, { projects: ["repo-a", "repo-b"] });
    assert.equal(result.ok, true);
    assert.ok(result.satisfied.some((item) => item.startsWith("repo-a:")));
    assert.ok(result.satisfied.some((item) => item.startsWith("repo-b:")));
  });

  it("review/audit là yêu cầu CẤP TICKET, không bắt theo từng repo", () => {
    const evidence = ["repo-a", "repo-b"].flatMap((project) => [
      pass("BUILD", project),
      pass("TEST", project),
      pass("SCOPE_VALIDATION", project, { unexpectedFiles: [], deletedFiles: [] }),
    ]);
    evidence.push(pass("AUDIT", null));
    const result = evaluateEvidenceGate("DONE", evidence, { projects: ["repo-a", "repo-b"] });
    assert.equal(result.ok, true);
    assert.ok(!result.missing.some((item) => item.includes("AUDIT")));
    assert.ok(result.satisfied.includes("AUDIT=PASS"));
  });

  it("ticket 1 repo giữ nguyên hành vi cũ: evidence không cần gắn project", () => {
    const evidence = [pass("BUILD", null), pass("TEST", null), pass("SCOPE_VALIDATION", null, { unexpectedFiles: [], deletedFiles: [] }), pass("AUDIT", null)];
    assert.equal(evaluateEvidenceGate("DONE", evidence, { projects: ["repo-a"] }).ok, true);
    assert.equal(evaluateEvidenceGate("DONE", evidence, {}).ok, true);
  });
});

describe("multi-repo — CLI end-to-end trên 2 repo ở 2 thư mục cha", () => {
  before(() => {
    sandbox = path.join(tmpdir(), `mr-sandbox-${Date.now()}`);
    parentA = path.join(sandbox, "parent-a");
    parentB = path.join(sandbox, "parent-b");
    mkdirSync(parentA, { recursive: true });
    mkdirSync(parentB, { recursive: true });

    const fixtureA = makeFixtureRepo(SAMPLE);
    const fixtureB = makeFixtureRepo(SAMPLE);
    repoA = path.join(parentA, "repo-a");
    repoB = path.join(parentB, "repo-b");
    // Di chuyển NGUYÊN git repo fixture vào 2 thư mục cha khác nhau.
    renameSync(fixtureA.dir, repoA);
    renameSync(fixtureB.dir, repoB);

    configFile = path.join(sandbox, "projects.yaml");
    writeFileSync(configFile, projectsYaml(false), "utf8");
    configParallel = path.join(sandbox, "projects-parallel.yaml");
    writeFileSync(configParallel, projectsYaml(true), "utf8");

    // Harness test: ghi file vào repoRoot + report cho developer (giống worker thật).
    modelsConfig = path.join(sandbox, "models.yaml");
    writeFileSync(
      modelsConfig,
      [
        "version: 1",
        "tiers: { cheap: glm-text, small: haiku, medium: sonnet, large: opus }",
        "agents: { researcher: medium, impact: medium, architect: large, developer: medium, reviewer: medium, auditor: large }",
        "complexity: { simple: small, medium: medium, complex: large }",
        "riskFloor: { LOW: small, MEDIUM: medium, HIGH: medium, CRITICAL: large }",
        "routing:",
        "  weights: { complexity: 0.4, risk: 0.4 }",
        "  caps: { minTier: small, maxTier: large, fallback: medium }",
        "  neverBelowRiskFloor: true",
        "harness:",
        "  slow:",
        "    enabled: true",
        `    command: ["node", ${JSON.stringify(path.join(REPO_ROOT, "tests", "fixtures", "harness", "slow-writer.mjs"))}]`,
        '    cwd: "{repoRoot}"',
        "    timeoutMs: 60000",
        "",
      ].join("\n"),
      "utf8",
    );
  });

  after(() => {
    for (const taskId of ALL) rmSync(workstreamDir(taskId), { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("tạo ticket 2 repo + import plan có ### Repo ⇒ state và plan ghi đúng repo", async () => {
    const created = await runCli(["new", B, "--title", "multi", "--risk", "MEDIUM", "--project", "repo-a", "--project", "repo-b"]);
    assert.equal(created.code, 0, created.stderr);

    const file = writePlanFile(B, PLAN_BODY);
    const imported = await runCli(["plan", "import", B, "--file", file]);
    assert.equal(imported.code, 0, imported.stderr);

    const plan = planJson(B);
    assert.equal(plan.tasks.find((task) => task.id === "TASK-01").repo, "repo-a");
    assert.equal(plan.tasks.find((task) => task.id === "TASK-02").repo, "repo-b");
    assert.deepEqual(stateJson(B).projects, ["repo-a", "repo-b"]);
  });

  it("graph hiển thị repo của từng task", async () => {
    const result = await runCli(["graph", B]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /repo: repo-a, repo-b/);
    assert.match(result.stdout, /TASK-01 {2}\[repo-a\]/);
    assert.match(result.stdout, /TASK-02 {2}\[repo-b\]/);
  });

  it("context dùng repo của TASK, không phải --project", async () => {
    const result = await runCli(["context", B, "TASK-02", "--project", "repo-a"]);
    assert.equal(result.code, 0, result.stderr);
    // TASK-02 thuộc repo-b ⇒ context phải trỏ repo-b dù CLI truyền --project repo-a
    assert.equal(contextJson(B, "TASK-02").repo, "repo-b");
    const markdown = readFileSync(path.join(workstreamDir(B), "context", "TASK-02.md"), "utf8");
    assert.match(markdown, /## Repo \(BẮT BUỘC đọc trước\)/);
    assert.match(markdown, /`repo-b`/);
  });

  it("gate REVIEWING đòi evidence cho TỪNG repo rồi mới cho qua", async () => {
    const created = await runCli(["new", A, "--title", "gate", "--risk", "MEDIUM", "--project", "repo-a", "--project", "repo-b"]);
    assert.equal(created.code, 0, created.stderr);
    const file = writePlanFile(A, PLAN_BODY);
    assert.equal((await runCli(["plan", "import", A, "--file", file])).code, 0);

    for (const status of ["TRANSLATING", "REQUIREMENT_ANALYSIS", "IMPACT_ANALYSIS", "DESIGNING", "WAITING_DESIGN_APPROVAL"]) {
      const step = await runCli(["advance", A, "--to", status]);
      assert.equal(step.code, 0, `${status}: ${step.stderr}`);
    }
    assert.equal(
      (await runCli(["record", A, "--type", "HUMAN_APPROVAL", "--status", "PASS", "--gate-id", "architecture", "--approver", "lead@test", "--approved-at", "2026-01-01T09:00:00Z"])).code,
      0,
    );
    for (const status of ["PLANNING", "READY_TO_IMPLEMENT", "IMPLEMENTING"]) {
      const step = await runCli(["advance", A, "--to", status]);
      assert.equal(step.code, 0, `${status}: ${step.stderr}`);
    }

    const recordFor = async (project) => {
      assert.equal(
        (
          await runCli([
            "record", A, "--type", "TEST", "--status", "PASS", "--project", project,
            "--command", `node -e test-${project}`, "--cwd", project === "repo-a" ? repoA : repoB,
            "--exit-code", "0", "--git-sha", "deadbeef", "--artifact", "evidence/logs/x.log", "--producer", "test",
          ])
        ).code,
        0,
      );
      assert.equal(
        (
          await runCli([
            "record", A, "--type", "SCOPE_VALIDATION", "--status", "PASS", "--project", project,
            "--unexpected", "", "--deleted", "", "--producer", "test",
          ])
        ).code,
        0,
      );
    };

    await recordFor("repo-a");
    const blocked = await runCli(["advance", A, "--to", "REVIEWING"]);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /repo-b: TEST=PASS/);
    assert.match(blocked.stderr, /repo-b: SCOPE_VALIDATION=PASS/);

    await recordFor("repo-b");
    const passed = await runCli(["advance", A, "--to", "REVIEWING"]);
    assert.equal(passed.code, 0, passed.stderr);
    assert.equal(stateJson(A).status, "REVIEWING");
  });

  it("eng doctor vẫn chạy được với config nhiều repo", async () => {
    const result = await runCli(["doctor"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /project:repo-a/);
    assert.match(result.stdout, /project:repo-b/);
  });

  it("metrics phản ánh repo của ticket", async () => {
    const result = await runCli(["metrics", B, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const metrics = JSON.parse(result.stdout);
    assert.deepEqual(metrics.projects, ["repo-a", "repo-b"]);
    assert.ok(existsSync(path.join(workstreamDir(B), "plan.json")));
  });

  it("implement --parallel: worktree nằm trong REPO CỦA TỪNG TASK, merge theo từng repo", async () => {
    // Repo đích phải ở feature branch (main bị chặn ghi).
    for (const repo of [repoA, repoB]) git(repo, ["checkout", "-q", "-b", "feature/mr"]);
    const parallelEnv = { PROJECTS_CONFIG: configParallel, ENG_HARNESS_SLEEP_MS: "150" };

    assert.equal(
      (await runCli(["new", C, "--title", "parallel multi-repo", "--risk", "LOW", "--project", "repo-a", "--project", "repo-b"], parallelEnv)).code,
      0,
    );
    const file = writePlanFile(C, PLAN_PARALLEL);
    assert.equal((await runCli(["plan", "import", C, "--file", file], parallelEnv)).code, 0);

    // Cùng đường dẫn file ở hai repo KHÁC nhau ⇒ conflict=PASS ⇒ cho chạy parallel.
    const graph = await runCli(["graph", C], parallelEnv);
    assert.match(graph.stdout, /wave 1 \[PARALLEL, conflict=PASS\] tasks=\[TASK-01, TASK-02\]/);

    for (const status of ["TRANSLATING", "REQUIREMENT_ANALYSIS", "IMPACT_ANALYSIS", "DESIGNING", "WAITING_DESIGN_APPROVAL"]) {
      assert.equal((await runCli(["advance", C, "--to", status], parallelEnv)).code, 0);
    }
    assert.equal(
      (
        await runCli(
          ["record", C, "--type", "HUMAN_APPROVAL", "--status", "PASS", "--gate-id", "architecture", "--approver", "lead@test", "--approved-at", "2026-01-01T09:00:00Z"],
          parallelEnv,
        )
      ).code,
      0,
    );
    for (const status of ["PLANNING", "READY_TO_IMPLEMENT"]) {
      assert.equal((await runCli(["advance", C, "--to", status], parallelEnv)).code, 0);
    }
    assert.equal((await runCli(["context", C, "--all", "--no-mcp"], parallelEnv)).code, 0);
    assert.equal((await runCli(["advance", C, "--to", "IMPLEMENTING"], parallelEnv)).code, 0);

    const result = await runCli(["implement", C, "--harness", "slow", "--parallel", "--concurrency", "2"], parallelEnv);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /worktree:TASK-01/);
    assert.match(result.stdout, /worktree:TASK-02/);

    // changes.json phải ghi ĐÚNG repo (và repoRoot) của từng task.
    const changesA = JSON.parse(readFileSync(path.join(workstreamDir(C), "tasks", "TASK-01-changes.json"), "utf8"));
    const changesB = JSON.parse(readFileSync(path.join(workstreamDir(C), "tasks", "TASK-02-changes.json"), "utf8"));
    assert.equal(changesA.project, "repo-a");
    assert.equal(changesB.project, "repo-b");
    assert.equal(changesA.repoRoot, repoA);
    assert.equal(changesB.repoRoot, repoB);

    // Branch/worktree nằm ở đúng repo, không lẫn sang repo kia.
    assert.match(git(repoA, ["branch", "--list", "eng/*"]), /eng\/MR-1003-TASK-01/);
    assert.doesNotMatch(git(repoA, ["branch", "--list", "eng/*"]), /TASK-02/);
    assert.match(git(repoB, ["branch", "--list", "eng/*"]), /eng\/MR-1003-TASK-02/);
    assert.doesNotMatch(git(repoB, ["branch", "--list", "eng/*"]), /TASK-01/);

    // Chưa merge ⇒ ticket dừng ở IMPLEMENTING, chờ merge (không tự thu evidence trên cây chính).
    assert.equal(stateJson(C).status, "IMPLEMENTING");

    const merge = await runCli(["merge", C], parallelEnv);
    assert.equal(merge.code, 0, merge.stderr);
    assert.match(merge.stdout, /merged eng\/MR-1003-TASK-01/);
    assert.match(merge.stdout, /merged eng\/MR-1003-TASK-02/);
    assert.ok(existsSync(path.join(repoA, "src/main/java/vn/bpm/domain/policy/GeneratedTASK01.java")));
    assert.ok(existsSync(path.join(repoB, "src/main/java/vn/bpm/domain/policy/GeneratedTASK02.java")));

    // Sau merge: thu evidence cho MỌI repo rồi vào REVIEWING.
    const again = await runCli(["implement", C, "--harness", "slow"], parallelEnv);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /evidence:tests\[repo-a\]/);
    assert.match(again.stdout, /evidence:tests\[repo-b\]/);
    assert.equal(stateJson(C).status, "REVIEWING");
  });
});
