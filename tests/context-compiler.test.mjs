import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compileTaskContext, validateWith, workstreamDir } from "../runtime/dist/index.js";
import { makeFixtureRepo } from "./helpers/fixture.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "runtime", "dist", "cli.js");
const FIXTURE_SOURCE = path.join(REPO_ROOT, "tests", "fixtures", "sample-repo");

const C = "CX-0100"; // provider giả (unit)
const O = "CX-0101"; // CLI --no-mcp (offline)
const M = "CX-0102"; // CLI + MCP thật
const ALL = [C, O, M];

const PLAN_MARKDOWN = `# Implementation Plan — context test

## TASK-01 — Cập nhật nhánh TD1 cho POLICY-NHADAT

### Objective
Cập nhật nhánh điều kiện TD1 cho policy POLICY-NHADAT.

### Files
- src/main/java/vn/bpm/domain/policy/PolicyService.java

### Symbols
- PolicyService.checkPolicy

### Dependencies
none

### Existing Pattern
Nhánh if theo purpose hiện có trong PolicyService.

### Business Rules
- TD1: sửa chữa không đổi kết cấu hoặc mua sắm nội thất ⇒ ELIGIBLE

### Constraints
- Không xóa nhánh cũ

### Acceptance Criteria
- TD1 trả ELIGIBLE cho cả hai nhánh (sửa chữa không kết cấu, nội thất)

### Verification
- PolicyServiceTest
`;

class FakeProvider {
  constructor() {
    this.name = "fake";
    this.closed = false;
  }

  async gather(input) {
    return {
      symbols: [
        {
          name: input.symbols[0],
          file: input.files[0],
          lines: "10-30",
          snippet: "public String checkPolicy(LoanFact fact) {\n  // thân method\n}",
          reason: "test provider",
        },
      ],
      files: [],
      tests: ["PolicyServiceTest"],
      businessRules: [
        { id: "POLICY-NHADAT/TD1", statement: "TD1 từ mcp-domain-core", source: "policies.json#TD1", confidence: 0.9 },
      ],
      existingPattern: "pattern từ MCP",
      similarCode: [{ file: "src/main/java/A.java", score: 0.42 }],
      callers: [{ file: "src/main/java/B.java", line: 7 }],
      architectureConstraints: ["Repo constraint: mọi input MUST đi qua mapper"],
      unknowns: [],
      mcpQueries: [{ server: "fake", tool: "gather" }],
      unavailable: [],
    };
  }

  close() {
    this.closed = true;
  }
}

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
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

function planFile() {
  const file = path.join(tmpdir(), `domain-plan-${Date.now()}.md`);
  writeFileSync(file, PLAN_MARKDOWN, "utf8");
  return file;
}

function readContext(taskId, subTaskId) {
  return JSON.parse(readFileSync(path.join(workstreamDir(taskId), "context", `${subTaskId}.json`), "utf8"));
}

function cleanup() {
  for (const taskId of ALL) rmSync(workstreamDir(taskId), { recursive: true, force: true });
}

describe("ContextCompiler — với provider giả", () => {
  before(async () => {
    cleanup();
    const created = await runCli(["new", C, "--title", "context unit", "--risk", "MEDIUM"]);
    assert.equal(created.code, 0, created.stderr);
    const imported = await runCli(["plan", "import", C, "--file", planFile()]);
    assert.equal(imported.code, 0, imported.stderr);
    writeFileSync(
      path.join(workstreamDir(C), "architecture.md"),
      "# Architecture (workstream)\n- Workstream constraint: MUST NOT đổi chữ ký method public.\n",
      "utf8",
    );
  });

  after(cleanup);

  it("gộp đúng 4 nguồn constraints và giữ business rule của plan", async () => {
    const provider = new FakeProvider();
    const compiled = await compileTaskContext({ taskId: C, subTaskId: "TASK-01", providers: provider });

    assert.equal(compiled.context.objective.includes("TD1"), true);
    const constraints = compiled.context.constraints.join(" | ");
    assert.match(constraints, /INV-04/); // GLOBAL
    assert.match(constraints, /Không xóa nhánh cũ/); // plan
    assert.match(constraints, /chữ ký method public/); // workstream architecture.md
    assert.match(constraints, /mọi input MUST đi qua mapper/); // repo qua MCP

    const ruleIds = (compiled.context.businessRules ?? []).map((rule) => rule.id);
    assert.ok(ruleIds.includes("PLAN-01"));
    assert.ok(ruleIds.includes("POLICY-NHADAT/TD1"));
    const fromMcp = compiled.context.businessRules.find((rule) => rule.id === "POLICY-NHADAT/TD1");
    assert.equal(fromMcp.confidence, 0.9);
    assert.equal(compiled.context.existingPattern, "Nhánh if theo purpose hiện có trong PolicyService.");

    assert.equal(compiled.context.provenance.generatedBy, "runtime:fake");
    assert.equal(compiled.context.provenance.mcpQueries.length, 1);
    assert.equal(compiled.context.symbols.length, 1);
    assert.match(compiled.context.symbols[0].snippet, /checkPolicy/);
    assert.equal(validateWith("context", compiled.context).valid, true);
  });

  it("markdown có đủ section cho worker đọc", () => {
    return compileTaskContext({ taskId: C, subTaskId: "TASK-01", providers: new FakeProvider(), write: false }).then(
      (compiled) => {
        for (const section of [
          "## Objective",
          "## Files",
          "## Symbols",
          "## Existing Pattern",
          "## Business Rules",
          "## Constraints",
          "## Tests",
          "## Acceptance Criteria",
          "## Verification Criteria",
          "## Provenance",
        ]) {
          assert.ok(compiled.markdown.includes(section), `thiếu ${section}`);
        }
      },
    );
  });

  it("cắt snippet khi vượt budget token và ghi truncated = true", async () => {
    const compiled = await compileTaskContext({
      taskId: C,
      subTaskId: "TASK-01",
      providers: new FakeProvider(),
      limits: { maxTokens: 60 },
      write: false,
    });
    assert.equal(compiled.truncated, true);
    assert.equal(compiled.context.budget.truncated, true);
    assert.ok(compiled.tokenEstimate > 60 - 1);
    assert.equal((compiled.context.symbols[0].snippet ?? "").length < 120, true);
  });

  it("không truyền toàn bộ plan: chỉ 1 task, không có nội dung task khác", async () => {
    const compiled = await compileTaskContext({ taskId: C, subTaskId: "TASK-01", providers: new FakeProvider(), write: false });
    assert.equal(compiled.context.subTaskId, "TASK-01");
    assert.equal(compiled.context.files.length, 1);
    assert.ok(!compiled.markdown.includes("TASK-02"));
  });

  it("provider không tìm thấy symbol ⇒ ghi unknown chứ không bịa", async () => {
    const emptyProvider = {
      name: "empty",
      async gather(input) {
        return {
          symbols: [],
          files: [],
          tests: [],
          businessRules: [],
          existingPattern: null,
          similarCode: [],
          callers: [],
          architectureConstraints: [],
          unknowns: [`Không tìm thấy khai báo của ${input.symbols[0]}`],
          mcpQueries: [],
          unavailable: ["engineering: exited"],
        };
      },
      close() {},
    };
    const compiled = await compileTaskContext({
      taskId: C,
      subTaskId: "TASK-01",
      providers: emptyProvider,
      write: false,
    });
    assert.ok(compiled.context.unknowns.some((item) => /Không tìm thấy khai báo/.test(item)));
    assert.match(compiled.markdown, /## Unknowns/);
    assert.ok(compiled.warnings.some((warning) => /MCP không dùng được/.test(warning)));
    assert.equal(compiled.context.symbols.length, 0);
  });

  it("task không có trong plan ⇒ SUBTASK_NOT_FOUND", async () => {
    await assert.rejects(
      () => compileTaskContext({ taskId: C, subTaskId: "TASK-99", providers: new FakeProvider(), write: false }),
      (error) => error.code === "SUBTASK_NOT_FOUND",
    );
  });
});

describe("CLI context — offline (--no-mcp)", () => {
  before(async () => {
    const created = await runCli(["new", O, "--title", "context offline", "--risk", "LOW"]);
    assert.equal(created.code, 0, created.stderr);
    const imported = await runCli(["plan", "import", O, "--file", planFile()]);
    assert.equal(imported.code, 0, imported.stderr);
  });

  after(cleanup);

  it("compile TASK-01 và ghi context/*.json + *.md hợp lệ schema", async () => {
    const result = await runCli(["context", O, "TASK-01", "--no-mcp"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /context TASK-01/);

    const context = readContext(O, "TASK-01");
    assert.equal(validateWith("context", context).valid, true);
    assert.equal(context.provenance.generatedBy, "runtime:local-artifacts");
    assert.ok(context.unknowns.length > 0, "offline phải khai báo unknown, không được im lặng");
    assert.ok(existsSync(path.join(workstreamDir(O), "context", "TASK-01.md")));
  });

  it("artifacts trong task.json ghi nhận context đã compile", async () => {
    const state = JSON.parse(readFileSync(path.join(workstreamDir(O), "task.json"), "utf8"));
    // giá trị do runtime ghi luôn dùng "/" (chuẩn workstream) — không dùng path.join ở đây
    assert.equal(state.artifacts["context:TASK-01"], "context/TASK-01.md");
  });

  it("resume báo task nào còn thiếu context", async () => {
    const result = await runCli(["resume", O, "--json"]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.contexts.length, 1);
    assert.equal(report.contexts[0].compiled, true);
  });

  it("--all bỏ qua task đã DONE", async () => {
    await runCli(["subtask", O, "TASK-01", "--status", "DONE"]);
    const result = await runCli(["context", O, "--all", "--no-mcp"]);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse((await runCli(["context", O, "--all", "--no-mcp", "--json"])).stdout);
    assert.deepEqual(parsed, []);
  });
});

describe("CLI context — MCP thật trên repo fixture", () => {
  let fixture;

  before(async () => {
    fixture = makeFixtureRepo(FIXTURE_SOURCE);
    const created = await runCli(["new", M, "--title", "context mcp", "--risk", "HIGH"]);
    assert.equal(created.code, 0, created.stderr);
    const imported = await runCli(["plan", "import", M, "--file", planFile()]);
    assert.equal(imported.code, 0, imported.stderr);
  });

  after(() => {
    cleanup();
    fixture?.cleanup();
  });

  it("lấy được snippet symbol từ repo và ghi provenance MCP", async () => {
    const result = await runCli(["context", M, "TASK-01", "--project", "sample-fixture"], {
      SAMPLE_FIXTURE_REPO_ROOT: fixture.dir,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /MCP call/);

    const context = readContext(M, "TASK-01");
    assert.equal(validateWith("context", context).valid, true);
    assert.equal(context.provenance.generatedBy, "runtime:mcp");
    assert.ok(context.provenance.mcpQueries.length >= 3, `chỉ có ${context.provenance.mcpQueries.length} MCP call`);

    const tools = context.provenance.mcpQueries.map((query) => `${query.server}.${query.tool}`);
    assert.ok(tools.includes("mcp-engineering.get_change_context"));
    assert.ok(tools.includes("mcp-engineering.get_architecture_constraints"));

    const symbol = context.symbols.find((item) => item.name === "PolicyService.checkPolicy");
    assert.ok(symbol, "phải có symbol theo plan");
    assert.match(symbol.snippet, /checkPolicy/);
    assert.match(symbol.file, /PolicyService\.java$/);
    assert.ok(symbol.lines, "phải ghi khoảng dòng thay vì cả file");
  });

  it("lấy rule nghiệp vụ từ mcp-domain-core khi task nhắc tới policy id", async () => {
    const context = readContext(M, "TASK-01");
    const fromMbsm = (context.businessRules ?? []).filter((rule) => rule.source.includes("POLICY-NHADAT"));
    assert.ok(fromMbsm.length >= 1, "phải có rule lấy từ mcp-domain-core");
    assert.equal(fromMbsm[0].confidence, 0.9);
    assert.ok(
      context.provenance.mcpQueries.some((query) => query.server === "mcp-domain-core" && query.tool === "get_policy_rules"),
    );
  });

  it("ghi cả constraint lấy từ tài liệu kiến trúc của repo", async () => {
    const context = readContext(M, "TASK-01");
    assert.ok(
      context.constraints.some((constraint) => /PolicyInputMapper|MUST NOT/.test(constraint)),
      `constraints hiện có: ${context.constraints.join(" | ")}`,
    );
  });
});
