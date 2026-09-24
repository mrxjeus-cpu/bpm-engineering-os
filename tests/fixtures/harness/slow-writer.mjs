import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Harness kiểm thử cho chạy SONG SONG:
 * - ghi file vào `$ENG_REPO_ROOT` (khi chạy trong worktree thì file nằm ở worktree đó),
 * - ghi report + timing (start/end/pid) để test chứng minh hai task chạy chồng lấn thời gian,
 * - sleep `ENG_HARNESS_SLEEP_MS` (mặc định 700ms) để cửa sổ chạy đủ dài.
 *
 * Env: ENG_WORKSTREAM, ENG_SUBTASK_ID, ENG_REPO_ROOT, ENG_HARNESS_SLEEP_MS, ENG_HARNESS_FAIL
 */
const workstream = process.env.ENG_WORKSTREAM ?? "";
const repoRoot = process.env.ENG_REPO_ROOT ?? "";
const subTaskId = process.env.ENG_SUBTASK_ID || "TASK";
const sleepMs = Number.parseInt(process.env.ENG_HARNESS_SLEEP_MS ?? "700", 10);

if (workstream === "" || repoRoot === "") {
  process.stderr.write("ENG_WORKSTREAM / ENG_REPO_ROOT chưa được set\n");
  process.exit(2);
}

const start = new Date().toISOString();
const started = Date.now();

// file nằm trong scope của repo đích (để validate_scope sau merge vẫn PASS)
const target = path.join(repoRoot, "src/main/java/vn/bpm/domain/policy", `Generated${subTaskId.replace(/[^A-Za-z0-9]/g, "")}.java`);
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, `package vn.bpm.domain.policy;\n\n/** Sinh bởi harness test cho ${subTaskId}. */\npublic class Generated${subTaskId.replace(/[^A-Za-z0-9]/g, "")} {\n}\n`, "utf8");

await new Promise((resolve) => setTimeout(resolve, sleepMs));

const end = new Date().toISOString();
const finished = Date.now();

mkdirSync(path.join(workstream, "tasks"), { recursive: true });
writeFileSync(
  path.join(workstream, "tasks", `${subTaskId}-timing.json`),
  `${JSON.stringify({ subTaskId, start, end, durationMs: finished - started, pid: process.pid, repoRoot }, null, 2)}\n`,
  "utf8",
);
writeFileSync(
  path.join(workstream, "tasks", `${subTaskId}-report.md`),
  `# Report — ${subTaskId}\n\n- repoRoot: ${repoRoot}\n- bắt đầu: ${start}\n- kết thúc: ${end}\n- file: ${path.relative(repoRoot, target)}\n\n## Test đã chạy\n| Command | Exit code |\n|---|---|\n| node -e 1 | 0 |\n`,
  "utf8",
);

process.stdout.write(`slow harness xong ${subTaskId} tại ${repoRoot}\n`);

if (process.env.ENG_HARNESS_FAIL === "1") process.exit(3);
