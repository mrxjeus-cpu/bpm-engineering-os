import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Harness kiểm thử: giả lập một worker agent.
 *
 * Ghi artifact theo ĐÚNG contract của role (giống agent thật), ghi log ra stdout, và
 * (với reviewer/auditor) ghi evidence PASS — việc agent thật sẽ làm qua MCP tool `record_evidence`.
 *
 * Env:
 *   ENG_WORKSTREAM, ENG_SUBTASK_ID, ENG_ROLE, ENG_PROMPT_FILE, ENG_CONTEXT_FILE, ENG_MODEL_TIER
 *   ENG_HARNESS_FAIL=1  → exit 3 (mô phỏng worker fail)
 */
const workstream = process.env.ENG_WORKSTREAM ?? "";
const role = process.env.ENG_ROLE ?? "developer";
const subTaskId = process.env.ENG_SUBTASK_ID || "TASK";
const promptFile = process.env.ENG_PROMPT_FILE ?? "";
const contextFile = process.env.ENG_CONTEXT_FILE ?? "";

if (workstream === "") {
  process.stderr.write("ENG_WORKSTREAM chưa được set\n");
  process.exit(2);
}

function write(rel, content) {
  const abs = path.join(workstream, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  process.stdout.write(`harness wrote ${rel}\n`);
}

function nextEvidenceId() {
  const dir = path.join(workstream, "evidence");
  let max = 0;
  try {
    for (const file of readdirSync(dir)) {
      const match = /^EV-(\d+)\.json$/.exec(file);
      if (match) max = Math.max(max, Number.parseInt(match[1], 10));
    }
  } catch {
    // chưa có thư mục evidence
  }
  return `EV-${String(max + 1).padStart(4, "0")}`;
}

/** Evidence do agent ghi (thật: qua MCP record_evidence). */
function recordEvidence(taskId, partial) {
  const id = nextEvidenceId();
  const record = {
    schemaVersion: 1,
    id,
    taskId,
    timestamp: new Date().toISOString(),
    producer: `test-harness:${role}`,
    ...partial,
  };
  write(path.join("evidence", `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return id;
}

const taskId = path.basename(workstream);

const REPORT = `# Report — ${subTaskId}

- role: ${role}
- tier: ${process.env.ENG_MODEL_TIER}
- prompt: ${path.basename(promptFile)}
- context: ${path.basename(contextFile)}

## Đã thay đổi
- src/main/java/vn/bpm/domain/policy/PolicyService.java (theo context)

## Pattern đã tái sử dụng
PolicyInputMapper hiện có.

## Test đã chạy
| Command | Exit code | Kết quả |
|---|---|---|
| mvn -q -Dtest=PolicyServiceTest test | 0 | pass |

## Evidence
- log: evidence/logs/PolicyServiceTest.log
- scope: không có file ngoài Files
`;

if (role === "researcher") {
  write(
    "requirements.md",
    `# Requirements — ${taskId}\n\n## WHAT thay đổi\nThêm Purpose of Loan vào policy input.\n\n## Acceptance criteria\n1. Có enum value FURNITURE\n2. TD1 trả ELIGIBLE\n`,
  );
  write("open_questions.md", "# Open questions\n- Không có\n");
  write("assumptions.md", "# Assumptions\n- Dữ liệu cũ không có purposeOfLoan ⇒ null\n");
} else if (role === "impact") {
  write(
    "impact.md",
    `# Impact analysis — ${taskId}\n\n## Ảnh hưởng theo lớp\n| Lớp | Bị ảnh hưởng | Ghi chú |\n|---|---|---|\n| Class | PolicyService | heuristic |\n| Policy | POLICY-NHADAT | rule TD1/TD2 |\n\n## Unknowns\n- Cần xác nhận rule TD2 với product owner\n`,
  );
} else if (role === "architect") {
  write(
    "architecture.md",
    `# Architecture decision — ${taskId}\n\n## Current\nPolicyService.checkPolicy nhận LoanFact.\n\n## Proposed\nDùng PolicyInputMapper hiện có, thêm field purposeOfLoan.\n\n## Alternatives\n### A. Sửa trực tiếp PolicyService — Nhược: phá pattern mapper.\n### B. Dùng mapper hiện có — Ưu: tái sử dụng pattern.\n\n## Decision\nChọn B.\n\n## Rollback\nRevert commit, không đổi schema DB.\n`,
  );
  write(
    "plan.md",
    `# Implementation plan — ${taskId}\n\n## TASK-01 — Thêm purposeOfLoan vào policy input\n\n### Objective\nMap purposeOfLoan từ LoanFact vào PolicyInput và cập nhật nhánh TD1.\n\n### Files\n- src/main/java/vn/bpm/domain/policy/PolicyService.java\n\n### Symbols\n- PolicyService.checkPolicy\n\n### Dependencies\nnone\n\n### Existing Pattern\nPolicyInputMapper hiện có.\n\n### Business Rules\n- TD1: mua sắm nội thất ⇒ ELIGIBLE\n\n### Acceptance Criteria\n- TD1 trả ELIGIBLE cho nhánh nội thất\n\n### Verification\n- PolicyServiceTest\n`,
  );
} else if (role === "developer") {
  write(path.join("tasks", `${subTaskId}-report.md`), REPORT);
} else if (role === "reviewer") {
  write(
    path.join("reviews", `${subTaskId}-spec.md`),
    `# Review — ${subTaskId} (SPEC)\n\n## Kết luận: PASS\n\n| Acceptance criteria | Kết quả |\n|---|---|\n| TD1 trả ELIGIBLE | PASS |\n\n## Issues\n| Severity | File | Mô tả |\n|---|---|---|\n`,
  );
  write(
    path.join("reviews", `${subTaskId}-quality.md`),
    `# Review — ${subTaskId} (QUALITY)\n\n## Kết luận: PASS\n\n| Hạng mục | Kết quả |\n|---|---|\n| Pattern tái sử dụng | PASS |\n| Test coverage | PASS |\n`,
  );
  recordEvidence(taskId, { type: "SPEC_REVIEW", status: "PASS", subTaskId, summary: "spec review PASS (test harness)" });
  recordEvidence(taskId, { type: "QUALITY_REVIEW", status: "PASS", subTaskId, summary: "quality review PASS (test harness)" });
} else if (role === "auditor") {
  write(
    "audit.md",
    `# Audit — ${taskId}\n\n## Kết luận: PASS\n\n| Hạng mục | Kết quả | Bằng chứng |\n|---|---|---|\n| Backward compatibility | PASS | field nullable |\n| Data integrity | PASS | migration nullable |\n| Transaction boundary | PASS | không đổi |\n\n## Rủi ro còn lại\n- Không có\n`,
  );
  recordEvidence(taskId, { type: "AUDIT", status: "PASS", summary: "audit PASS (test harness)" });
}

// Giữ tương thích: developer report cũ nằm ở tasks/TASK-NN-report.md (đã ghi ở trên)
if (role !== "developer" && process.env.ENG_HARNESS_ALWAYS_REPORT === "1") {
  write(path.join("tasks", `${subTaskId}-report.md`), REPORT);
}

process.stdout.write(`prompt=${promptFile}\n`);

if (process.env.ENG_HARNESS_FAIL === "1") {
  process.stderr.write("harness cố tình fail\n");
  process.exit(3);
}
