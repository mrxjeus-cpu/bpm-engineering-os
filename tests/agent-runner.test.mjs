import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AGENTS,
  AgentRunner,
  inferComplexity,
  renderAgentPrompt,
  resolveModelDecision,
  workstreamDir,
} from "../runtime/dist/index.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "runtime", "dist", "cli.js");
const HARNESS_SCRIPT = path.join(REPO_ROOT, "tests", "fixtures", "harness", "write-report.mjs");
const USAGE_HARNESS_SCRIPT = path.join(REPO_ROOT, "tests", "fixtures", "harness", "usage-report.mjs");

const SNIPPET_MARKER = "SECRET_SNIPPET_MARKER_KHONG_DUOC_NHUNG_VAO_PROMPT";

const P = "AR-0100"; // prompt contract + dry run
const H = "AR-0101"; // harness thật (writer) + wave --run
const F = "AR-0102"; // harness fail
const ALL = [P, H, F];

const PLAN_MARKDOWN = `# Plan — agent runner

## TASK-01 — Task một

### Objective
Sửa policy theo TD1 cho POLICY-NHADAT.

### Files
- src/main/java/vn/bpm/domain/policy/PolicyService.java

### Symbols
- PolicyService.checkPolicy

### Dependencies
none

### Existing Pattern
Nhánh if hiện có.

### Business Rules
- TD1: mua sắm nội thất ⇒ ELIGIBLE

### Acceptance Criteria
- TD1 trả ELIGIBLE cho nhánh nội thất

### Verification
- PolicyServiceTest

## TASK-02 — Task hai

### Objective
Thêm test cho nhánh TD2.

### Files
- src/test/java/vn/bpm/domain/policy/PolicyServiceTest.java

### Dependencies
- TASK-01

### Existing Pattern
PolicyInputMapperTest hiện có.

### Acceptance Criteria
- Có test cho TD2

### Verification
- PolicyServiceTest
`;

function writeTempModels({ includeWriter = true } = {}) {
  const file = path.join(tmpdir(), `domain-models-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.yaml`);
  const harness = [
    "harness:",
    "  dry:",
    "    enabled: true",
    "    command: [\"node\", \"-e\", \"console.log('dry', process.env.ENG_PROMPT_FILE)\"]",
    "    cwd: \"{osRoot}\"",
    "    timeoutMs: 60000",
    ...(includeWriter
      ? [
          "  writer:",
          "    enabled: true",
          `    command: ["node", ${JSON.stringify(HARNESS_SCRIPT)}]`,
          '    cwd: "{osRoot}"',
          "    timeoutMs: 60000",
          "  usage:",
          "    enabled: true",
          `    command: ["node", ${JSON.stringify(USAGE_HARNESS_SCRIPT)}]`,
          '    cwd: "{osRoot}"',
          "    timeoutMs: 60000",
          "  failing:",
          "    enabled: true",
          '    command: ["node", "-e", "process.exit(3)"]',
          '    cwd: "{osRoot}"',
          "    timeoutMs: 60000",
        ]
      : []),
  ].join("\n");

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
      harness,
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

function writeTempPlan() {
  const file = path.join(tmpdir(), `domain-agent-plan-${Date.now()}.md`);
  writeFileSync(file, PLAN_MARKDOWN, "utf8");
  return file;
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

function cleanup() {
  for (const taskId of ALL) rmSync(workstreamDir(taskId), { recursive: true, force: true });
}

describe("prompt contract (spec mục 10)", () => {
  it("có đủ 9 phần theo đúng thứ tự", () => {
    const prompt = renderAgentPrompt({
      contract: AGENTS.developer,
      taskId: "AR-9999",
      subTaskId: "TASK-01",
      objective: "Mục tiêu thử",
      constraints: ["Không xóa logic cũ"],
      verification: ["Chạy PolicyServiceTest"],
      acceptanceCriteriaCount: 2,
      contextPath: "context/TASK-01.md",
      inputs: [{ path: "context/TASK-01.md", description: "context", present: true }],
      tier: "medium",
      tierReason: "test",
    });

    const sections = ["ROLE", "OBJECTIVE", "TASK", "CONTEXT", "INPUTS", "CONSTRAINTS", "EXPECTED OUTPUT", "VERIFICATION", "DO NOT"];
    let cursor = -1;
    for (const section of sections) {
      const index = prompt.indexOf(`\n${section}\n`);
      assert.ok(index > cursor, `thiếu hoặc sai thứ tự phần ${section}`);
      cursor = index;
    }
    assert.ok(prompt.startsWith("# Prompt contract"), "phải bắt đầu bằng tiêu đề prompt contract");
  });

  it("thay hết placeholder {subTaskId}/{taskId}, không để sót", () => {
    const prompt = renderAgentPrompt({
      contract: AGENTS.developer,
      taskId: "AR-9999",
      subTaskId: "TASK-07",
      objective: "x",
      constraints: ["c"],
      verification: ["v"],
      acceptanceCriteriaCount: 1,
      contextPath: "context/TASK-07.md",
      inputs: [],
      tier: "medium",
      tierReason: "test",
    });
    assert.ok(!prompt.includes("{subTaskId}"), "còn sót {subTaskId}");
    assert.ok(!prompt.includes("{taskId}"), "còn sót {taskId}");
    assert.match(prompt, /tasks\/TASK-07-report\.md/);
  });

  it("không lặp dòng DO NOT", () => {
    const prompt = renderAgentPrompt({
      contract: AGENTS.developer,
      taskId: "AR-9999",
      subTaskId: "TASK-01",
      objective: "x",
      constraints: ["c"],
      verification: ["v"],
      acceptanceCriteriaCount: 1,
      inputs: [],
      tier: "medium",
      tierReason: "test",
    });
    const doNotBlock = prompt.split("DO NOT")[1] ?? "";
    const lines = doNotBlock.split("\n").filter((line) => line.startsWith("- "));
    assert.equal(new Set(lines).size, lines.length, "DO NOT có dòng trùng");
    assert.ok(lines.length >= 4);
    assert.ok(lines.some((line) => /BLOCKED/.test(line)), "phải nhắc BLOCKED khi thiếu dữ liệu");
  });

  it("CONTEXT chỉ là đường dẫn, không nhúng nội dung (INV-01)", () => {
    const prompt = renderAgentPrompt({
      contract: AGENTS.developer,
      taskId: "AR-9999",
      subTaskId: "TASK-01",
      objective: "x",
      constraints: ["c"],
      verification: ["v"],
      acceptanceCriteriaCount: 1,
      contextPath: "context/TASK-01.md",
      inputs: [{ path: "context/TASK-01.md", description: "context", present: true }],
      tier: "medium",
      tierReason: "test",
    });
    assert.match(prompt, /context\/TASK-01\.md/);
    assert.match(prompt, /KHÔNG nhúng ở đây/);
    assert.ok(!prompt.includes(SNIPPET_MARKER));
  });

  it("mỗi agent có input/output/DO NOT riêng", () => {
    assert.ok(AGENTS.developer.requiresContext);
    assert.ok(AGENTS.reviewer.requiresContext);
    assert.ok(!AGENTS.researcher.requiresContext);
    assert.deepEqual(AGENTS.researcher.outputs, ["requirements.md"]);
    assert.ok(AGENTS.auditor.doNot.some((item) => /tương thích ngược/.test(item)));
  });
});

describe("ModelRouter (spec mục 12)", () => {
  it("lấy tier theo vai trò", () => {
    assert.equal(resolveModelDecision({ role: "architect", risk: "LOW" }).tier, "large");
    assert.equal(resolveModelDecision({ role: "developer", risk: "LOW" }).tier, "medium");
  });

  it("sàn theo risk nâng tier khi cần", () => {
    const decision = resolveModelDecision({ role: "researcher", risk: "CRITICAL" });
    assert.equal(decision.tier, "large");
    assert.match(decision.reason, /sàn risk CRITICAL/);
  });

  it("complexity cao nâng tier", () => {
    assert.equal(resolveModelDecision({ role: "researcher", risk: "LOW", complexity: "complex" }).tier, "large");
  });

  it("áp sàn minTier của config", () => {
    const decision = resolveModelDecision({ role: "translator", risk: "LOW", complexity: "simple" });
    assert.equal(decision.tier, "small", "cheap phải bị kéo lên sàn minTier=small");
    assert.match(decision.reason, /small/);
  });

  it("không bao giờ xuống dưới riskFloor", () => {
    for (const risk of ["LOW", "MEDIUM", "HIGH", "CRITICAL"]) {
      const decision = resolveModelDecision({ role: "developer", risk, complexity: "simple" });
      const order = ["small", "medium", "large"];
      assert.ok(order.indexOf(decision.tier) >= order.indexOf("medium") - 1, `${risk} → ${decision.tier}`);
    }
  });

  it("inferComplexity theo dấu hiệu khách quan", () => {
    assert.equal(inferComplexity({ files: 1 }), "simple");
    assert.equal(inferComplexity({ files: 3, dependencies: 1 }), "medium");
    assert.equal(inferComplexity({ files: 6, dependencies: 3, contextTokens: 5000 }), "complex");
  });
});

describe("AgentRunner — prompt + dry run", () => {
  before(async () => {
    cleanup();
    await runCli(["new", P, "--title", "agent dry run", "--risk", "HIGH"]);
    await runCli(["plan", "import", P, "--file", writeTempPlan()]);
    const compiled = await runCli(["context", P, "TASK-01", "--no-mcp"]);
    assert.equal(compiled.code, 0, compiled.stderr);

    // nhét marker vào context để kiểm tra INV-01: prompt KHÔNG được chứa nội dung này
    const contextJson = path.join(workstreamDir(P), "context", "TASK-01.json");
    const context = JSON.parse(readFileSync(contextJson, "utf8"));
    context.symbols = [{ name: "PolicyService.checkPolicy", file: "x.java", snippet: SNIPPET_MARKER }];
    writeFileSync(contextJson, JSON.stringify(context, null, 2), "utf8");
  });

  after(cleanup);

  it("developer cần context ⇒ thiếu context thì báo CONTEXT_REQUIRED", async () => {
    const result = await runCli(["agent", "developer", P, "TASK-02", "--dry-run"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /CONTEXT_REQUIRED/);
    assert.match(result.stderr, /eng context/);
  });

  it("dry run ghi prompt contract nhưng không gọi worker", async () => {
    const result = await runCli(["agent", "developer", P, "TASK-01", "--dry-run", "--json"]);
    assert.equal(result.code, 1, "còn thiếu artifact nên exit 1");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.role, "developer");
    assert.equal(parsed.exitCode, undefined);
    assert.equal(parsed.tier, "medium", "developer=medium, riskFloor HIGH=medium, complexity medium ⇒ medium");
    assert.match(parsed.tierReason, /sàn risk HIGH=medium/);
    assert.deepEqual(parsed.artifactsMissing, ["tasks/TASK-01-report.md"]);

    const promptFile = path.join(workstreamDir(P), parsed.promptPath);
    assert.ok(existsSync(promptFile), "phải ghi file prompt");
    const prompt = readFileSync(promptFile, "utf8");
    assert.ok(prompt.includes("context/TASK-01.md"));
    assert.ok(!prompt.includes(SNIPPET_MARKER), "prompt KHÔNG được nhúng nội dung context (INV-01)");
  });

  it("không cấu hình harness ⇒ từ chối chạy, không đoán provider (INV-07)", async () => {
    const result = await runCli(["agent", "developer", P, "TASK-01"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /HARNESS_NOT_CONFIGURED/);
    assert.match(result.stderr, /--harness dry/);
  });

  it("role không tồn tại ⇒ UNKNOWN_AGENT kèm danh sách", async () => {
    const result = await runCli(["agent", "khong-co-role", P, "--dry-run"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /UNKNOWN_AGENT/);
    assert.match(result.stderr, /developer/);
  });
});

describe("AgentRunner — harness thật + wave --run", () => {
  let modelsConfig;

  before(async () => {
    modelsConfig = writeTempModels();
    await runCli(["new", H, "--title", "agent harness", "--risk", "HIGH"], { MODELS_CONFIG: modelsConfig });
    await runCli(["plan", "import", H, "--file", writeTempPlan()], { MODELS_CONFIG: modelsConfig });
    const compiled = await runCli(["context", H, "--all", "--no-mcp"], { MODELS_CONFIG: modelsConfig });
    assert.equal(compiled.code, 0, compiled.stderr);
  });

  after(cleanup);

  it("chạy worker qua harness và kiểm tra artifact THẬT được tạo", async () => {
    const result = await runCli(["agent", "developer", H, "TASK-01", "--harness", "writer", "--json"], {
      MODELS_CONFIG: modelsConfig,
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.exitCode, 0);
    assert.deepEqual(parsed.artifactsPresent, ["tasks/TASK-01-report.md"]);
    assert.deepEqual(parsed.artifactsMissing, []);
    assert.ok(parsed.logPath);
    assert.equal(parsed.usage, null, "harness không ghi ENG_USAGE_FILE ⇒ không bịa token");

    const report = readFileSync(path.join(workstreamDir(H), "tasks", "TASK-01-report.md"), "utf8");
    assert.match(report, /role: developer/);
    assert.match(report, /tier: /);

    const log = readFileSync(path.join(workstreamDir(H), parsed.logPath), "utf8");
    assert.match(log, /harness wrote/);
    assert.match(log, /# exit: 0/);
  });

  it("harness báo usage ⇒ ghi vào event AgentRun (tier thật + token có nguồn)", async () => {
    const result = await runCli(["agent", "developer", H, "TASK-01", "--harness", "usage", "--json"], {
      MODELS_CONFIG: modelsConfig,
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.usage, { inputTokens: 1200, outputTokens: 340, totalTokens: 1540, source: "test-harness" });

    const events = readFileSync(path.join(workstreamDir(H), "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const runs = events.filter((event) => event.type === "AgentRun");
    assert.ok(runs.length >= 1, "phải có event AgentRun");
    const last = runs[runs.length - 1];
    assert.equal(last.actor, "agent:developer");
    assert.equal(last.subTaskId, "TASK-01");
    assert.equal(last.payload.role, "developer");
    assert.equal(last.payload.modelTier, "medium", "risk HIGH + developer ⇒ tier medium (riskFloor)");
    assert.equal(last.payload.harness, "usage");
    assert.equal(last.payload.ok, true);
    assert.equal(last.payload.usage.inputTokens, 1200);
    assert.equal(typeof last.payload.durationMs, "number");
    assert.equal(last.payload.logRef, "tasks/developer-TASK-01.log");

    const metrics = JSON.parse((await runCli(["metrics", H, "--json"], { MODELS_CONFIG: modelsConfig })).stdout);
    assert.equal(metrics.cost.measurable, true);
    assert.ok(metrics.cost.runs >= 1);
    assert.ok(metrics.cost.runsWithUsage >= 1, "ít nhất 1 lần chạy có usage");
    const medium = metrics.cost.byTier.find((tier) => tier.tier === "medium");
    assert.ok(medium, `thiếu tier medium trong ${JSON.stringify(metrics.cost.byTier)}`);
    assert.ok(medium.runs >= 1);
    assert.ok(medium.inputTokens >= 1200);
  });

  it("harness fail ⇒ ok=false + cảnh báo, artifact vẫn thiếu", async () => {
    const result = await runCli(["agent", "developer", H, "TASK-02", "--harness", "failing", "--json"], {
      MODELS_CONFIG: modelsConfig,
      ENG_HARNESS_FAIL: "1",
    });
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exitCode, 3);
    assert.deepEqual(parsed.artifactsMissing, ["tasks/TASK-02-report.md"]);
    assert.ok(parsed.warnings.some((warning) => /exit code 3/.test(warning)));
  });

  it("wave --run chạy developer agent cho từng task trong wave", async () => {
    // đưa state tới IMPLEMENTING
    for (const status of ["TRANSLATING", "REQUIREMENT_ANALYSIS", "IMPACT_ANALYSIS", "DESIGNING", "WAITING_DESIGN_APPROVAL"]) {
      const step = await runCli(["advance", H, "--to", status], { MODELS_CONFIG: modelsConfig });
      assert.equal(step.code, 0, step.stderr);
    }
    await runCli(
      [
        "record", H, "--type", "HUMAN_APPROVAL", "--status", "PASS",
        "--gate-id", "architecture", "--approver", "SA", "--approved-at", new Date().toISOString(),
      ],
      { MODELS_CONFIG: modelsConfig },
    );
    for (const status of ["PLANNING", "READY_TO_IMPLEMENT", "IMPLEMENTING"]) {
      await runCli(["advance", H, "--to", status], { MODELS_CONFIG: modelsConfig });
    }

    const result = await runCli(
      ["wave", H, "--start", "1", "--run", "--harness", "writer", "--json"],
      { MODELS_CONFIG: modelsConfig },
    );
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.wave.mode, "PARALLEL");
    assert.deepEqual(parsed.wave.tasks, ["TASK-01"], "TASK-02 phụ thuộc TASK-01 nên thuộc wave 2");
    assert.equal(parsed.runs.length, 1, "wave 1 chỉ có TASK-01");
    assert.equal(parsed.runs[0].ok, true);
    assert.ok(parsed.runs[0].artifactsPresent.includes("tasks/TASK-01-report.md"));

    // task vẫn IN_PROGRESS: hệ thống không tự đánh dấu DONE thay người (RULES-001)
    const plan = JSON.parse(readFileSync(path.join(workstreamDir(H), "plan.json"), "utf8"));
    assert.equal(plan.tasks.find((task) => task.id === "TASK-01").status, "IN_PROGRESS");
  });

  it("eng agents liệt kê contract + harness", async () => {
    const result = await runCli(["agents", "--json"], { MODELS_CONFIG: modelsConfig });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.agents.length, 6);
    assert.ok(parsed.harnesses.includes("writer"));
    assert.ok(parsed.harnesses.includes("dry"));
  });
});

describe("AgentRunner — fail case không cần harness", () => {
  before(async () => {
    await runCli(["new", F, "--title", "agent fail", "--risk", "LOW"]);
    await runCli(["plan", "import", F, "--file", writeTempPlan()]);
    await runCli(["context", F, "TASK-01", "--no-mcp"]);
  });

  after(cleanup);

  it("task chưa có trong plan ⇒ SUBTASK_NOT_FOUND (không chạy worker)", async () => {
    const result = await runCli(["agent", "developer", F, "TASK-99", "--dry-run"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /CONTEXT_REQUIRED|SUBTASK_NOT_FOUND/);
  });
});
