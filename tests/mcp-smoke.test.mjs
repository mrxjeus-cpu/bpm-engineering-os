import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeFixtureRepo } from "./helpers/fixture.mjs";
import { McpClient } from "./helpers/mcp-client.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINEERING_ENTRY = path.join(REPO_ROOT, "mcp", "mcp-engineering", "dist", "index.js");
const DOMAIN_ENTRY = path.join(REPO_ROOT, "mcp", "mcp-domain-core", "dist", "index.js");
const FIXTURE_SOURCE = path.join(REPO_ROOT, "tests", "fixtures", "sample-repo");
const TASK_ID = "TEST-0001";
const WORKSTREAM = path.join(REPO_ROOT, ".engineering", "workstreams", TASK_ID);

describe("mcp-domain-core — domain intelligence", () => {
  let client;

  before(async () => {
    client = new McpClient({ command: process.execPath, args: [DOMAIN_ENTRY], cwd: REPO_ROOT });
    await client.initialize();
  });

  after(() => {
    client?.close();
  });

  it("đăng ký đủ 17 tool domain", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.equal(names.length, 17);
    for (const expected of [
      "find_policy",
      "get_policy",
      "get_policy_rules",
      "trace_policy_dependency",
      "find_loan_facts",
      "get_core_input_schema",
      "find_existing_pattern",
    ]) {
      assert.ok(names.includes(expected), `thiếu tool ${expected}`);
    }
  });

  it("find_policy trả summary, không trả rules (progressive disclosure)", async () => {
    const result = await client.callTool("find_policy", { query: "nhà đất" });
    assert.equal(result.isError, false);
    const policy = result.data.policies.find((item) => item.id === "POLICY-NHADAT");
    assert.ok(policy, "phải tìm thấy POLICY-NHADAT");
    assert.equal(policy.rules, undefined, "summary không được chứa rules");
    assert.ok(policy.rulesCount > 0);
    assert.equal(result.data._synthetic, true, "phải gắn cờ dữ liệu hư cấu");
  });

  it("get_policy_rules lấy đúng rule TD1", async () => {
    const result = await client.callTool("get_policy_rules", { policyId: "POLICY-NHADAT", ruleId: "TD1" });
    assert.equal(result.isError, false);
    assert.equal(result.data.rule.id, "TD1");
    assert.match(result.data.rule.statement, /nội thất|sửa chữa/i);
    assert.ok(result.data.rule.source.includes("POLICY-NHADAT"));
  });

  it("fail-closed: policy không tồn tại ⇒ lỗi rõ ràng, không bịa (INV-06)", async () => {
    const result = await client.callTool("get_policy", { policyId: "POLICY-KHONGCOTO" });
    assert.equal(result.isError, true);
    assert.equal(result.data.code, "POLICY_NOT_FOUND");
    assert.match(result.data.hint, /POLICY-NHADAT/);
  });

  it("trace_policy_dependency duyệt được đồ thị downstream", async () => {
    const result = await client.callTool("trace_policy_dependency", {
      policyId: "POLICY-NHADAT",
      direction: "downstream",
    });
    assert.equal(result.isError, false);
    const ids = result.data.nodes.map((node) => node.id).sort();
    assert.deepEqual(ids, ["POLICY-CIC-BASIC", "POLICY-PRESCREEN-01"]);
  });

  it("find_existing_pattern trả pattern có sẵn + ví dụ ticket", async () => {
    const result = await client.callTool("find_existing_pattern", {
      description: "add Purpose of Loan to policy input",
    });
    assert.equal(result.isError, false);
    assert.ok(result.data.patterns.length > 0, "phải tìm thấy pattern");
    const top = result.data.patterns[0];
    assert.equal(top.name, "add-enum-input-field");
    assert.equal(top.example.ticket, "TASK-49043");
    assert.equal(result.data.confidence, "heuristic");
  });

  it("get_core_input_schema yêu cầu purposeOfLoan", async () => {
    const result = await client.callTool("get_core_input_schema", { policyId: "POLICY-NHADAT" });
    assert.equal(result.isError, false);
    assert.ok(result.data.inputSchema.required.includes("purposeOfLoan"));
  });
});

describe("mcp-engineering — repo/code/git/task", () => {
  let client;
  let fixture;

  before(async () => {
    // Test phải hermetic: xoá workstream của lần chạy trước để state không rò rỉ giữa các lần chạy.
    rmSync(WORKSTREAM, { recursive: true, force: true });
    fixture = makeFixtureRepo(FIXTURE_SOURCE);
    client = new McpClient({
      command: process.execPath,
      args: [ENGINEERING_ENTRY],
      cwd: REPO_ROOT,
      env: { SAMPLE_FIXTURE_REPO_ROOT: fixture.dir },
    });
    await client.initialize();
  });

  after(() => {
    client?.close();
    fixture?.cleanup();
  });

  it("đăng ký đủ 31 tool engineering", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.equal(names.length, 31);
    for (const expected of ["get_change_context", "validate_change_scope", "run_test", "record_evidence"]) {
      assert.ok(names.includes(expected), `thiếu tool ${expected}`);
    }
  });

  it("get_project_context đọc đúng repo fixture", async () => {
    const result = await client.callTool("get_project_context", { project: "sample-fixture" });
    assert.equal(result.isError, false);
    assert.equal(result.data.project, "sample-fixture");
    assert.equal(result.data.language, "java");
    assert.equal(result.data.branch, "main");
    assert.ok(result.data.indexedFiles > 0);
  });

  it("find_symbol tìm được khai báo class", async () => {
    const result = await client.callTool("find_symbol", { name: "PolicyInputMapper", project: "sample-fixture" });
    assert.equal(result.isError, false);
    assert.ok(result.data.symbols.length > 0);
    assert.match(result.data.symbols[0].file, /PolicyInputMapper\.java$/);
    assert.equal(result.data.symbols[0].line > 0, true);
  });

  it("search_code tìm purposeOfLoan ở nhiều file", async () => {
    const result = await client.callTool("search_code", {
      query: "purposeOfLoan",
      include: ["**/*.java"],
      pageSize: 50,
      project: "sample-fixture",
    });
    assert.equal(result.isError, false);
    assert.ok(result.data.totalMatches >= 3, `chỉ thấy ${result.data.totalMatches} match`);
  });

  it("get_change_context gói definition + callers + tests", async () => {
    const result = await client.callTool("get_change_context", {
      file: "src/main/java/vn/bpm/domain/policy/PolicyInputMapper.java",
      symbol: "map",
      project: "sample-fixture",
    });
    assert.equal(result.isError, false);
    assert.match(result.data.definition.body, /setPurposeOfLoan/);
    assert.ok(result.data.callers.length >= 1, "phải thấy PolicyService gọi mapper.map");
    assert.equal(result.data.confidence, "heuristic");
  });

  it("get_architecture_constraints trích được ràng buộc", async () => {
    const result = await client.callTool("get_architecture_constraints", { project: "sample-fixture" });
    assert.equal(result.isError, false);
    const text = result.data.constraints.map((c) => c.text).join("\n");
    assert.match(text, /MUST NOT/);
    assert.ok(result.data.constraints.every((c) => c.file && c.line > 0));
  });

  it("update_task_state bootstrap ticket đang làm dở (IMPLEMENTING)", async () => {
    const created = await client.callTool("update_task_state", {
      taskId: TASK_ID,
      patch: { status: "IMPLEMENTING", title: "Smoke test fixture task", risk: "LOW", mode: "normal" },
      reason: "bootstrap ticket đang làm dở",
    });
    assert.equal(created.isError, false);
    assert.equal(created.data.status, "IMPLEMENTING");
    assert.equal(created.data.phase, "implementation");
    assert.ok(created.data.history.length >= 1);
  });

  it("từ chối sửa trực tiếp field do runtime quản lý (phase)", async () => {
    const result = await client.callTool("update_task_state", {
      taskId: TASK_ID,
      patch: { phase: "review" },
    });
    assert.equal(result.isError, true);
    assert.equal(result.data.code, "PATCH_FORBIDDEN_FIELD");
  });

  it("chặn chuyển REVIEWING khi chưa có evidence (INV-03 / RULES-001)", async () => {
    const result = await client.callTool("update_task_state", {
      taskId: TASK_ID,
      patch: { status: "REVIEWING" },
      expectedStatus: "IMPLEMENTING",
    });
    assert.equal(result.isError, true);
    assert.equal(result.data.code, "EVIDENCE_REQUIRED");
  });

  it("run_test chạy command trong allowlist và ghi evidence có provenance (INV-12)", async () => {
    const result = await client.callTool("run_test", {
      project: "sample-fixture",
      suite: "SmokeTest",
      taskId: TASK_ID,
      subTaskId: "TASK-01",
    });
    assert.equal(result.isError, false);
    assert.equal(result.data.status, "PASS");
    assert.equal(result.data.exitCode, 0);
    assert.ok(result.data.evidence, "phải ghi evidence");
    assert.equal(result.data.evidence.type, "TEST");
    assert.ok(result.data.evidence.command.includes("node"));
    assert.equal(result.data.evidence.exitCode, 0);
    assert.ok(result.data.evidence.gitSha.length > 0);

    const evidenceFile = path.join(WORKSTREAM, result.data.evidence.path);
    assert.ok(existsSync(evidenceFile), `evidence phải tồn tại: ${evidenceFile}`);
    const stored = JSON.parse(readFileSync(evidenceFile, "utf8"));
    for (const field of ["command", "cwd", "exitCode", "gitSha", "artifact", "timestamp", "producer"]) {
      assert.ok(stored[field] !== undefined && stored[field] !== null, `evidence thiếu ${field}`);
    }
  });

  it("validate_scope ghi SCOPE_VALIDATION PASS (điều kiện bắt buộc để vào REVIEWING)", async () => {
    const result = await client.callTool("validate_scope", { taskId: TASK_ID, project: "sample-fixture" });
    assert.equal(result.isError, false);
    assert.equal(result.data.status, "PASS");
    assert.equal(result.data.evidence.type, "SCOPE_VALIDATION");
    assert.equal(result.data.evidence.status, "PASS");
  });

  it("sau khi có evidence mới cho chuyển REVIEWING", async () => {
    const result = await client.callTool("update_task_state", {
      taskId: TASK_ID,
      patch: { status: "REVIEWING" },
      expectedStatus: "IMPLEMENTING",
      reason: "có TEST + SCOPE_VALIDATION evidence",
    });
    assert.equal(result.isError, false);
    assert.equal(result.data.status, "REVIEWING");
    assert.equal(result.data.phase, "review");
    assert.ok(result.data.evidence.length >= 2);
    assert.ok(result.data.history.length >= 1);
  });

  it("run_test từ chối suite không nằm trong allowlist (ADR-08)", async () => {
    const result = await client.callTool("run_test", {
      project: "sample-fixture",
      suite: "SomeUnknownSuite",
    });
    assert.equal(result.isError, true);
    assert.equal(result.data.code, "SUITE_NOT_ALLOWED");
  });

  it("validate_scope FAIL khi có file ngoài scope và ghi evidence (INV-04)", async () => {
    writeFileSync(path.join(fixture.dir, "README.md"), "\nthay doi ngoai scope\n", { flag: "a" });

    const result = await client.callTool("validate_scope", { taskId: TASK_ID, project: "sample-fixture" });
    assert.equal(result.isError, false);
    assert.equal(result.data.status, "FAIL");
    assert.ok(result.data.unexpectedFiles.includes("README.md"));
    assert.equal(result.data.evidence.type, "SCOPE_VALIDATION");
    assert.equal(result.data.evidence.status, "FAIL");
  });

  it("emit_event ghi vào events.jsonl", async () => {
    const result = await client.callTool("emit_event", {
      taskId: TASK_ID,
      type: "TaskCompleted",
      subTaskId: "TASK-01",
      payload: { note: "smoke test" },
    });
    assert.equal(result.isError, false);
    const eventsFile = path.join(WORKSTREAM, "events.jsonl");
    assert.ok(existsSync(eventsFile));
    const last = readFileSync(eventsFile, "utf8").trim().split("\n").pop();
    assert.equal(JSON.parse(last).type, "TaskCompleted");
  });
});
