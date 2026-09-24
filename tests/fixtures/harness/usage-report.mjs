import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Harness kiểm thử có báo usage token — dùng để test đường "harness báo usage" của AgentRunner
 * (`ENG_USAGE_FILE`) và metric cost/ticket.
 *
 * Khác `write-report.mjs`: harness này CHỈ ghi artifact của developer + file usage.
 */
const workstream = process.env.ENG_WORKSTREAM ?? "";
const subTaskId = process.env.ENG_SUBTASK_ID || "TASK";
const usageFile = process.env.ENG_USAGE_FILE ?? "";

if (workstream === "") {
  process.stderr.write("ENG_WORKSTREAM chưa được set\n");
  process.exit(2);
}

const report = path.join(workstream, "tasks", `${subTaskId}-report.md`);
mkdirSync(path.dirname(report), { recursive: true });
writeFileSync(
  report,
  `# Report — ${subTaskId}\n\n- role: ${process.env.ENG_ROLE}\n- tier: ${process.env.ENG_MODEL_TIER}\n\n## Đã thay đổi\n- (harness usage) không đổi file nào\n`,
  "utf8",
);

if (usageFile !== "") {
  mkdirSync(path.dirname(usageFile), { recursive: true });
  writeFileSync(
    usageFile,
    `${JSON.stringify({ inputTokens: 1200, outputTokens: 340, totalTokens: 1540, source: "test-harness" }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`harness wrote usage: ${usageFile}\n`);
}

process.stdout.write("harness usage-report done\n");
