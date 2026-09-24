import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { listFilesRecursive, relPath, workstreamDir } from "../runtime/dist/index.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "runtime", "dist", "cli.js");

const T = "XP-1000";
const ALL = [T];
const REL_PREFIXES = ["tasks/", "context/", "evidence/", "reviews/", "templates/"];

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function walkStrings(value, visit, trail = "") {
  if (typeof value === "string") return visit(value, trail);
  if (Array.isArray(value)) value.forEach((item, index) => walkStrings(item, visit, `${trail}[${index}]`));
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) walkStrings(item, visit, trail === "" ? key : `${trail}.${key}`);
  }
}

function cleanup() {
  for (const taskId of ALL) rmSync(workstreamDir(taskId), { recursive: true, force: true });
}

describe("relPath", () => {
  it("luôn dùng '/' và không nhân đôi", () => {
    assert.equal(relPath("tasks", "TASK-01-report.md"), "tasks/TASK-01-report.md");
    assert.equal(relPath("context/TASK-01.md"), "context/TASK-01.md");
    assert.equal(relPath("", "tasks", "", "a.md"), "tasks/a.md");
  });

  it("chuẩn hoá cả backslash đầu vào", () => {
    assert.equal(relPath("tasks\\TASK-01.md"), "tasks/TASK-01.md");
  });
});

describe("đường dẫn tương đối trong workstream dùng '/' (đa nền tảng)", () => {
  before(async () => {
    cleanup();
    await runCli(["new", T, "--title", "path contract", "--risk", "HIGH"]);
    await runCli(["plan", "import", T, "--file", path.join(REPO_ROOT, "tests", "fixtures", "plans", "valid-plan.md")]);
    const compiled = await runCli(["context", T, "TASK-03", "--no-mcp"]);
    assert.equal(compiled.code, 0, compiled.stderr);
  });

  after(cleanup);

  it("JSON của agent chỉ có đường dẫn '/', không có backslash", async () => {
    const result = await runCli(["agent", "developer", T, "TASK-03", "--dry-run", "--json"]);
    const parsed = JSON.parse(result.stdout);
    for (const value of [parsed.promptPath, parsed.contextPath, ...parsed.templates, ...parsed.artifactsMissing]) {
      assert.ok(!value.includes("\\"), `đường dẫn chứa backslash: ${value}`);
    }
    assert.deepEqual(parsed.templates, ["templates/task-report.md"]);
    assert.deepEqual(parsed.artifactsMissing, ["tasks/TASK-03-report.md"]);
    assert.equal(parsed.contextPath, "context/TASK-03.md");
  });

  it("prompt contract trỏ tới context/tasks bằng '/'", () => {
    const prompt = readFileSync(path.join(workstreamDir(T), "tasks", "developer-TASK-03.prompt.md"), "utf8");
    assert.match(prompt, /context\/TASK-03\.md/);
    assert.match(prompt, /tasks\/TASK-03-report\.md/);
    assert.ok(!/context\\TASK-03/.test(prompt), "prompt không được chứa backslash");
  });

  it("resume: contexts[].compiled = true (so khớp đúng danh sách file)", async () => {
    const result = await runCli(["resume", T, "--json"]);
    const report = JSON.parse(result.stdout);
    const entry = report.contexts.find((item) => item.subTaskId === "TASK-03");
    assert.ok(entry, "phải có TASK-03 trong contexts");
    assert.equal(entry.compiled, true, "context đã compile thì phải nhận ra (lỗi path separator làm trượt so khớp)");

    // artifacts ghi bởi CLI cũng phải là đường dẫn '/'
    const state = JSON.parse(readFileSync(path.join(workstreamDir(T), "task.json"), "utf8"));
    assert.equal(state.artifacts["context:TASK-03"], "context/TASK-03.md");
    assert.ok(!JSON.stringify(state.artifacts).includes("\\"));
  });

  it("quét toàn bộ artifact JSON: mọi tham chiếu tương đối đều dùng '/'", async () => {
    const dir = workstreamDir(T);
    const jsonFiles = listFilesRecursive(dir).filter((file) => file.endsWith(".json"));
    assert.ok(jsonFiles.length > 0);

    const violations = [];
    for (const file of jsonFiles) {
      const parsed = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
      walkStrings(parsed, (value, trail) => {
        if (REL_PREFIXES.some((prefix) => value.startsWith(prefix.replace("/", "\\")))) {
          violations.push(`${file}#${trail} = ${value}`);
        }
      });
    }
    assert.deepEqual(violations, [], `có tham chiếu tương đối dùng backslash:\n${violations.join("\n")}`);
  });

  it("evidence.artifact (tham chiếu workstream) dùng '/', còn cwd là đường dẫn OS nên không kiểm", async () => {
    const recorded = await runCli([
      "record", T, "--type", "TEST", "--status", "PASS", "--command", "node -e 1",
      "--cwd", REPO_ROOT, "--exit-code", "0", "--git-sha", "abc", "--artifact", "evidence/logs/x.log", "--json",
    ]);
    assert.equal(recorded.code, 0, recorded.stderr);
    const evidence = JSON.parse(recorded.stdout);
    assert.equal(evidence.artifact, "evidence/logs/x.log");
    assert.equal(evidence.path, "evidence/EV-0001.json");

    const listed = JSON.parse((await runCli(["evidence", T, "--json"])).stdout);
    for (const item of listed) {
      assert.ok(!item.path.includes("\\"), `evidence path có backslash: ${item.path}`);
    }
  });

  it("chính các file test không dùng path.join cho giá trị tương đối", () => {
    // Guard cho guard: trên macOS việc ghép đường dẫn tương đối cho ra cùng dạng "/" nên
    // lỗi chỉ lộ trên Windows. Kỳ vọng trong test phải là chuỗi '/' cố định, không ghép động.
    const testsDir = path.join(REPO_ROOT, "tests");
    const relativeFields = ["tasks", "context", "templates", "evidence", "reviews"];
    // dựng regex từ chuỗi để pattern không tự khớp chính dòng này
    const pattern = new RegExp(`path\\.join\\(\\s*"(${relativeFields.join("|")})"`, "g");
    const offenders = [];
    for (const file of readdirSync(testsDir).filter((name) => name.endsWith(".test.mjs"))) {
      const text = readFileSync(path.join(testsDir, file), "utf8");
      for (const match of text.matchAll(pattern)) offenders.push(`${file}: ${match[0]}`);
    }
    assert.deepEqual(offenders, [], `dùng path.join cho giá trị tương đối:\n${offenders.join("\n")}`);
  });

  it("recovery context dùng '/' cho logRefs/jsonRef", async () => {
    // tạo log harness rồi chẩn đoán (không apply) để có refs
    const fsOps = await import("node:fs");
    fsOps.mkdirSync(path.join(workstreamDir(T), "tasks"), { recursive: true });
    fsOps.writeFileSync(
      path.join(workstreamDir(T), "tasks", "developer-TASK-03.log"),
      "$ node -e 1\n# exit: 1\n--- stdout ---\n--- stderr ---\nAssertionError: nope\n",
      "utf8",
    );
    const result = await runCli(["recover", T, "TASK-03", "--json"]);
    const parsed = JSON.parse(result.stdout);
    for (const ref of parsed.diagnosis.logRefs) {
      assert.ok(!ref.includes("\\"), `logRef có backslash: ${ref}`);
      assert.ok(ref.startsWith("tasks/"));
    }
  });
});
