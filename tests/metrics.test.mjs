import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { computeMetrics, renderMetrics, workstreamDir } from "../runtime/dist/index.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "runtime", "dist", "cli.js");

const TASK = "MT-1000";

const t = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

/** State tối thiểu đúng shape task.json — chỉ dựng tay phần metric cần đọc. */
function makeState(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: TASK,
    title: "metrics fixture",
    status: "DONE",
    phase: "done",
    risk: "MEDIUM",
    mode: "normal",
    blocked: false,
    createdAt: t(0),
    updatedAt: t(100),
    history: [],
    ...overrides,
  };
}

function reviewEv(id, status, at, extra = {}) {
  return {
    schemaVersion: 1,
    id,
    taskId: TASK,
    type: "SPEC_REVIEW",
    status,
    producer: "agent:reviewer",
    timestamp: at,
    ...extra,
  };
}

function buildEvidence() {
  return [
    {
      schemaVersion: 1,
      id: "EV-0001",
      taskId: TASK,
      type: "TEST",
      status: "PASS",
      command: "npm test",
      cwd: ".",
      exitCode: 0,
      gitSha: "abc1234",
      artifact: "evidence/logs/test.log",
      durationMs: 4200,
      producer: "mcp:engineering",
      timestamp: t(40),
    },
    {
      schemaVersion: 1,
      id: "EV-0002",
      taskId: TASK,
      type: "SCOPE_VALIDATION",
      status: "PASS",
      unexpectedFiles: [],
      deletedFiles: [],
      producer: "mcp:engineering",
      timestamp: t(41),
    },
    // Cố tình thiếu `artifact` ⇒ phải bị đếm vào provenance chưa đủ (INV-12).
    {
      schemaVersion: 1,
      id: "EV-0003",
      taskId: TASK,
      type: "BUILD",
      status: "PASS",
      command: "npm run build",
      cwd: ".",
      exitCode: 0,
      gitSha: "abc1234",
      producer: "mcp:engineering",
      timestamp: t(42),
    },
    reviewEv("EV-0004", "FAIL", t(50)),
    reviewEv("EV-0005", "PASS", t(60)),
    {
      schemaVersion: 1,
      id: "EV-0008",
      taskId: TASK,
      type: "QUALITY_REVIEW",
      status: "PASS",
      producer: "agent:reviewer",
      timestamp: t(61),
    },
    {
      schemaVersion: 1,
      id: "EV-0009",
      taskId: TASK,
      type: "AUDIT",
      status: "PASS",
      producer: "agent:auditor",
      timestamp: t(75),
    },
    {
      schemaVersion: 1,
      id: "EV-0006",
      taskId: TASK,
      type: "HUMAN_APPROVAL",
      status: "PASS",
      gateId: "architecture",
      approver: "tech-lead",
      approvedAt: t(25),
      producer: "human:tech-lead",
      timestamp: t(25),
    },
    {
      schemaVersion: 1,
      id: "EV-0007",
      taskId: TASK,
      type: "MCP_QUERY",
      status: "BLOCKED",
      producer: "runtime:eng",
      timestamp: t(12),
    },
  ];
}

function buildHistory() {
  return [
    { at: t(10), from: "NEW", to: "TRANSLATING", by: "runtime:eng" },
    { at: t(12), from: "TRANSLATING", to: "TRANSLATING", by: "runtime:eng", reason: "block: MCP engineering không phản hồi" },
    { at: t(16), from: "TRANSLATING", to: "TRANSLATING", by: "runtime:eng", reason: "unblock" },
    { at: t(20), from: "TRANSLATING", to: "DESIGNING", by: "runtime:eng" },
    { at: t(25), from: "DESIGNING", to: "WAITING_DESIGN_APPROVAL", by: "runtime:eng" },
    { at: t(35), from: "WAITING_DESIGN_APPROVAL", to: "PLANNING", by: "human:tech-lead" },
    { at: t(45), from: "PLANNING", to: "IMPLEMENTING", by: "runtime:eng" },
    { at: t(50), from: "IMPLEMENTING", to: "REVIEWING", by: "runtime:eng" },
    { at: t(55), from: "REVIEWING", to: "REWORK_REQUIRED", by: "agent:reviewer" },
    { at: t(65), from: "REWORK_REQUIRED", to: "REVIEWING", by: "runtime:eng" },
    { at: t(70), from: "REVIEWING", to: "AUDITING", by: "runtime:eng" },
    { at: t(80), from: "AUDITING", to: "VERIFYING", by: "runtime:eng" },
    { at: t(100), from: "VERIFYING", to: "DONE", by: "runtime:eng" },
  ];
}

describe("computeMetrics — chỉ tính từ dữ liệu thật của workstream", () => {
  const metrics = computeMetrics({
    state: makeState({ history: buildHistory() }),
    evidence: buildEvidence(),
    contexts: [
      { taskId: TASK, subTaskId: "TASK-01", budget: { tokenEstimate: 900, maxTokenBudget: 6000, truncated: false } },
      { taskId: TASK, subTaskId: "TASK-02", budget: { tokenEstimate: 700, maxTokenBudget: 6000, truncated: true } },
    ],
    events: [],
  });

  it("cộng thời gian theo status từ history (NEW 10s, DESIGNING 5s, WAITING 10s)", () => {
    const byStatus = Object.fromEntries(metrics.timeInStatus.map((row) => [row.status, row.ms]));
    assert.equal(byStatus.NEW, 10_000);
    assert.equal(byStatus.TRANSLATING, 10_000, "10s → 20s, gồm cả 4s bị block");
    assert.equal(byStatus.DESIGNING, 5_000);
    assert.equal(byStatus.WAITING_DESIGN_APPROVAL, 10_000);
    assert.equal(byStatus.DONE, undefined, "status cuối không có khoảng thời gian nào sau nó nên không xuất hiện");
    const total = Object.values(byStatus).reduce((sum, ms) => sum + ms, 0);
    assert.equal(total, metrics.window.wallMs);
    assert.equal(metrics.window.wallMs, 100_000);
  });

  it("context: tổng/trung bình/trần + số context bị cắt", () => {
    assert.equal(metrics.context.subtasks, 2);
    assert.equal(metrics.context.tokenEstimateTotal, 1600);
    assert.equal(metrics.context.tokenEstimateAvg, 800);
    assert.equal(metrics.context.tokenEstimateMax, 900);
    assert.equal(metrics.context.budgetLimit, 6000);
    assert.equal(metrics.context.truncated, 1);
    assert.equal(metrics.context.estimate, true, "phải nói rõ đây là ước lượng");
  });

  it("evidence: đếm theo loại/kết quả và phát hiện provenance thiếu (BUILD thiếu artifact)", () => {
    assert.equal(metrics.evidence.total, 9);
    assert.equal(metrics.evidence.byType.TEST, 1);
    assert.equal(metrics.evidence.byType.SPEC_REVIEW, 2);
    assert.equal(metrics.evidence.byStatus.PASS, 7);
    assert.equal(metrics.evidence.byStatus.BLOCKED, 1);
    assert.equal(metrics.evidence.provenance.missingRequired, 1);
    const bad = metrics.evidence.provenance.incomplete[0];
    assert.equal(bad.id, "EV-0003");
    assert.deepEqual(bad.missing, ["artifact"]);
  });

  it("evidence gate: transition cần evidence đều hợp lệ tại thời điểm đó (100%)", () => {
    assert.ok(metrics.transitions.gated >= 4, `gated=${metrics.transitions.gated}`);
    assert.deepEqual(metrics.transitions.uncovered, []);
    assert.equal(metrics.transitions.coveragePct, 100);
  });

  it("phát hiện transition vào status gated mà lúc đó chưa có evidence", () => {
    const broken = computeMetrics({
      state: makeState({
        status: "REVIEWING",
        history: [{ at: t(10), from: "IMPLEMENTING", to: "REVIEWING", by: "runtime:eng" }],
      }),
      evidence: [],
      contexts: [],
      events: [],
    });
    assert.equal(broken.transitions.gated, 1);
    assert.equal(broken.transitions.coveredAtTheTime, 0);
    assert.equal(broken.transitions.coveragePct, 0);
    assert.equal(broken.transitions.uncovered.length, 1);
    assert.equal(broken.transitions.uncovered[0].transition, "IMPLEMENTING → REVIEWING");
    assert.ok(broken.transitions.uncovered[0].missing.some((item) => item.startsWith("TEST=PASS")));
  });

  it("chất lượng: review rejection rate là tỉ lệ review không pass (proxy, không phải catch rate)", () => {
    assert.equal(metrics.quality.reviewRuns, 3, "SPEC_REVIEW x2 + QUALITY_REVIEW x1");
    assert.equal(metrics.quality.reviewFailed, 1);
    assert.equal(metrics.quality.reviewRejectionRatePct, 33.3);
    assert.equal(metrics.quality.reworkTransitions, 1, "chỉ đếm transition thật sang REWORK_REQUIRED/FAILED/DEBUGGING");
  });

  it("human gate: thời gian chờ = thời gian ở status chờ, kèm approver thật", () => {
    assert.equal(metrics.process.humanGates.length, 1);
    const gate = metrics.process.humanGates[0];
    assert.equal(gate.gateId, "architecture");
    assert.equal(gate.waitMs, 10_000);
    assert.equal(gate.open, false);
    assert.equal(gate.satisfied, true);
    assert.equal(gate.approver, "tech-lead");
    assert.equal(metrics.process.humanWaitMaxMs, 10_000);
    assert.equal(metrics.process.humanApprovals, 1);
  });

  it("vận hành: ghép cặp block/unblock và nhận diện block do MCP", () => {
    assert.equal(metrics.ops.blocked.length, 1);
    assert.equal(metrics.ops.blocked[0].ms, 4_000);
    assert.equal(metrics.ops.blocked[0].open, false);
    assert.equal(metrics.ops.blocked[0].mcpRelated, true);
    assert.equal(metrics.ops.blockedTotalMs, 4_000);
    assert.equal(metrics.ops.mcpBlockedEpisodes, 1);
    assert.equal(metrics.ops.mcpQueryBlocked, 1);
  });

  it("block đang mở: tính riêng, không trộn vào blockedTotalMs", () => {
    const open = computeMetrics({
      state: makeState({
        status: "IMPLEMENTING",
        updatedAt: t(50),
        blocked: true,
        blockReason: "thiếu context",
        history: [
          { at: t(10), from: "NEW", to: "TRANSLATING", by: "runtime:eng" },
          { at: t(20), from: "TRANSLATING", to: "TRANSLATING", by: "runtime:eng", reason: "block: thiếu context TASK-02" },
        ],
      }),
      evidence: [],
      contexts: [],
      events: [],
    });
    assert.equal(open.ops.blocked.length, 1);
    assert.equal(open.ops.blocked[0].open, true);
    assert.equal(open.ops.blocked[0].ms, 30_000);
    assert.equal(open.ops.blockedTotalMs, 0);
    assert.equal(open.ops.blockedOpenMs, 30_000);
    assert.equal(open.ops.blocked[0].mcpRelated, false);
  });

  it("cost: khai báo không đo được thay vì bịa số", () => {
    assert.equal(metrics.cost.measurable, false);
    const names = metrics.notMeasurable.map((item) => item.metric);
    assert.ok(names.some((name) => /baseline/i.test(name)));
    assert.ok(names.some((name) => /escape rate/i.test(name)));
    for (const item of metrics.notMeasurable) {
      assert.ok(item.why.length > 20, `thiếu lý do cho ${item.metric}`);
      assert.ok(item.howToEnable.length > 10, `thiếu cách bổ sung cho ${item.metric}`);
    }
  });

  it("cost: đọc event AgentRun — gộp theo tier, tách lần có/không báo usage", () => {
    const runEvent = (tier, durationMs, usage, ok = true) => ({
      schemaVersion: 1,
      eventId: `EVT-${tier}-${durationMs}`,
      type: "AgentRun",
      taskId: TASK,
      at: t(30),
      actor: "agent:developer",
      payload: { modelTier: tier, durationMs, ok, usage },
    });
    const cost = computeMetrics({
      state: makeState({ status: "IMPLEMENTING", history: [] }),
      evidence: [],
      contexts: [],
      events: [
        runEvent("medium", 1000, { inputTokens: 100, outputTokens: 50 }),
        runEvent("medium", 2000, null),
        runEvent("large", 3000, { inputTokens: 400, outputTokens: 200 }, false),
      ],
    }).cost;

    assert.equal(cost.measurable, true);
    assert.equal(cost.runs, 3);
    assert.equal(cost.failedRuns, 1);
    assert.equal(cost.runsWithUsage, 2, "1 lần không báo usage ⇒ không được coi là có token");
    const medium = cost.byTier.find((tier) => tier.tier === "medium");
    const large = cost.byTier.find((tier) => tier.tier === "large");
    assert.equal(medium.runs, 2);
    assert.equal(medium.durationMs, 3000);
    assert.equal(medium.inputTokens, 100);
    assert.equal(large.runs, 1);
    assert.equal(large.inputTokens, 400);
    assert.equal(large.failedRuns, 1);
    assert.match(cost.reason, /2\/3 lần chạy/);
    assert.match(cost.note, /bảng giá/);
  });

  it("cost: không có event AgentRun ⇒ nói rõ chưa đo được, không ước lượng", () => {
    const cost = computeMetrics({ state: makeState({ history: [] }), evidence: [], contexts: [], events: [] }).cost;
    assert.equal(cost.measurable, false);
    assert.equal(cost.runs, 0);
    assert.deepEqual(cost.byTier, []);
    assert.match(cost.reason, /chưa có event AgentRun/);
  });

  it("usage rác (số âm/NaN) không được tính là token thật", () => {
    const cost = computeMetrics({
      state: makeState({ status: "IMPLEMENTING", history: [] }),
      evidence: [],
      contexts: [],
      events: [
        {
          schemaVersion: 1,
          eventId: "EVT-bad",
          type: "AgentRun",
          taskId: TASK,
          at: t(30),
          actor: "agent:developer",
          payload: { modelTier: "medium", durationMs: Number.NaN, ok: true, usage: { inputTokens: -5 } },
        },
      ],
    }).cost;
    assert.equal(cost.measurable, true);
    assert.equal(cost.runsWithUsage, 0);
    assert.equal(cost.byTier[0].durationMs, 0);
  });

  it("workstream rỗng: không NaN, không chia cho 0", () => {
    const empty = computeMetrics({ state: makeState({ status: "NEW", updatedAt: t(0) }), evidence: [], contexts: [], events: [] });
    assert.equal(empty.transitions.coveragePct, 0);
    assert.equal(empty.quality.reviewRejectionRatePct, null);
    assert.equal(empty.context.budgetLimit, null);
    assert.equal(empty.process.humanWaitMaxMs, 0);
    assert.equal(empty.window.wallMs, 0);
    for (const value of [empty.transitions.coveragePct, empty.ops.blockedTotalMs, empty.evidence.total]) {
      assert.ok(Number.isFinite(value));
    }
  });

  it("renderMetrics: có cảnh báo transition thiếu evidence và mục 'không đo được'", () => {
    const md = renderMetrics(metrics);
    assert.match(md, /# Metrics — MT-1000/);
    assert.match(md, /Thời gian theo status/);
    assert.match(md, /ước lượng, không phải token provider/);
    assert.match(md, /tỉ lệ phải làm lại: 33.3%/i);
    assert.match(md, /gate architecture .*chờ 10s/);
    assert.match(md, /Không đo được từ dữ liệu hiện có/);
  });
});

describe("eng metrics — CLI", () => {
  before(async () => {
    rmSync(workstreamDir(TASK), { recursive: true, force: true });
    await runCli(["new", TASK, "--title", "metrics cli", "--risk", "HIGH"]);
    await runCli(["advance", TASK, "--to", "TRANSLATING"]);
    await runCli(["block", TASK, "--reason", "MCP engineering timeout"]);
    await runCli(["unblock", TASK]);
  });

  after(() => rmSync(workstreamDir(TASK), { recursive: true, force: true }));

  it("in metrics dạng người đọc, có phần BLOCKED thật của workstream", async () => {
    const result = await runCli(["metrics", TASK]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /# Metrics — MT-1000/);
    assert.match(result.stdout, /MCP engineering timeout/);
    assert.match(result.stdout, /do MCP: 1/);
  });

  it("--json trả object đúng shape và parse được (không lẫn text khác)", async () => {
    const result = await runCli(["metrics", TASK, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.taskId, TASK);
    assert.equal(parsed.status, "TRANSLATING");
    assert.equal(parsed.risk, "HIGH");
    assert.equal(parsed.written, null);
    assert.equal(parsed.ops.blocked.length, 1);
    assert.equal(parsed.cost.measurable, false);
  });

  it("block/unblock được ghi vào history của task.json (audit trail, không chỉ event)", () => {
    const state = JSON.parse(readFileSync(path.join(workstreamDir(TASK), "task.json"), "utf8"));
    const reasons = state.history.map((entry) => entry.reason);
    assert.ok(reasons.some((reason) => reason?.startsWith("block:")), `thiếu entry block: ${reasons.join(" | ")}`);
    assert.ok(reasons.includes("unblock"), `thiếu entry unblock: ${reasons.join(" | ")}`);
    const patches = state.history.filter(
      (entry) => entry.reason?.startsWith("block:") || entry.reason === "unblock",
    );
    assert.equal(patches.length, 2, "phải có đúng 1 block + 1 unblock");
    for (const entry of patches) assert.equal(entry.from, entry.to, "patch metadata không đổi status");
  });

  it("--write ghi artifact metrics.md trong workstream (đường dẫn dùng '/')", async () => {
    const result = await runCli(["metrics", TASK, "--write", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).written, "metrics.md");
    const file = path.join(workstreamDir(TASK), "metrics.md");
    assert.ok(existsSync(file), "phải sinh metrics.md");
    assert.match(readFileSync(file, "utf8"), /# Metrics — MT-1000/);
  });

  it("task không tồn tại ⇒ lỗi rõ ràng, không bịa metrics", async () => {
    const result = await runCli(["metrics", "MT-9999"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /không tồn tại|TASK_NOT_FOUND|NOT_FOUND/i);
    assert.equal(existsSync(path.join(workstreamDir("MT-9999"), "metrics.md")), false);
  });
});

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}
