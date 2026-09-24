#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configSummary, loadConfig } from "./config/index.js";
import { EngError } from "./errors.js";
import { EvidenceStore } from "./evidence/store.js";
import { EventBus } from "./events/bus.js";
import {
  attachWaves,
  buildExecutionPlan,
  nextWave,
  waveProgress,
  type ExecutionPlan,
  type WaveProgress,
} from "./executor/waves.js";
import { compileTaskContext } from "./context/compiler.js";
import { createProviders } from "./context/providers.js";
import { AGENTS, AGENT_ROLES } from "./agents/registry.js";
import { AgentRunner, type AgentRunResult } from "./agents/runner.js";
import { harnessNames, resolveRepoRoot, skillRoutingLimits } from "./config/index.js";
import { isKnownProject, primaryProject, projectNames, reposForState } from "./repos.js";
import { WorktreeManager } from "./git/worktree.js";
import { describeLock, forceReleaseLock, lockStatus } from "./state/lock.js";
import { atomicWrite, readJsonFile, relPath } from "./workspace.js";
import { runDoctor } from "./doctor/index.js";
import { renderDoctor } from "./doctor/types.js";
import { collectMetrics } from "./metrics/collect.js";
import { renderMetrics } from "./metrics/compute.js";
import { RecoveryEngine } from "./recovery/engine.js";
import { PhaseOrchestrator } from "./orchestrator/phases.js";
import { continueTicket } from "./orchestrator/continue.js";
import { PHASE_NAMES, type PhaseName } from "./orchestrator/types.js";
import { loadSkills } from "./skills/loader.js";
import { routeSkills, skillCatalogSummary } from "./skills/router.js";
import { OS_ROOT } from "./paths.js";
import { parsePlanMarkdown } from "./plan/parser.js";
import { importPlanFromMarkdown, planProgress, readPlan, requirePlan, setTaskStatus, writePlan } from "./plan/store.js";
import { assertTransition, nextStatuses, TRANSITIONS } from "./state/machine.js";
import { StateStore, type ResumeReport } from "./state/store.js";
import type {
  EvidenceStatus,
  EvidenceType,
  ExecutionMode,
  NewEvidence,
  Plan,
  RiskLevel,
  SubTaskStatus,
  TaskStatus,
} from "./types.js";
import { ensureWorkstream, workstreamDir } from "./workspace.js";

const USAGE = `eng — BPM Engineering OS CLI

  eng new <TASK_ID> [--title TEXT] [--risk LOW|MEDIUM|HIGH|CRITICAL] [--mode safe|normal|autonomous]
                    [--project P]... [--projects a,b] [--domain a,b] [--capability a,b] [--status STATUS]
  eng list [--json]
  eng status <TASK_ID> [--json]
  eng resume <TASK_ID> [--json]
  eng next <TASK_ID>
  eng advance <TASK_ID> --to <STATUS> [--expect STATUS] [--reason TEXT] [--by WHO] [--allow-bypass]
  eng patch <TASK_ID> --set key=value [--set key2=value2]
  eng block <TASK_ID> --reason TEXT
  eng unblock <TASK_ID>
  eng gates <TASK_ID> --to <STATUS>
  eng evidence <TASK_ID> [--type TYPE] [--json]
  eng record <TASK_ID> --type TYPE --status PASS|FAIL|BLOCKED|INFO [--summary TEXT]
              [--project P] [--command C] [--cwd D] [--exit-code N] [--git-sha S] [--artifact A]
              [--gate-id G] [--approver U] [--approved-at ISO] [--comment TEXT] [--unexpected a,b] [--deleted a,b]
              [--sub-task TASK-NN] [--producer WHO]
  eng events <TASK_ID> [--limit N] [--json]
  eng metrics <TASK_ID> [--json] [--write]   # metrics thật từ state/evidence/context (spec mục 21)
  eng doctor [--project P] [--json] [--ping] # preflight trước khi chạy ticket thật (env/config/harness/MCP)
  eng config [--json]

Plan → DAG → waves:
  eng plan import <TASK_ID> --file <plan.md> [--architecture-ref architecture.md]
  eng plan show <TASK_ID> [--json]
  eng graph <TASK_ID> [--json]                 # DAG + waves + conflict check (INV-11)
  eng wave <TASK_ID> [--start N] [--json]      # xem wave kế tiếp, hoặc bắt đầu wave
  eng subtask <TASK_ID> <TASK-NN> --status PENDING|IN_PROGRESS|DONE|FAILED|REWORK_REQUIRED
  eng context <TASK_ID> <TASK-NN> [--project P] [--max-tokens N] [--no-mcp] [--json]
  eng context <TASK_ID> --all [--project P] [--no-mcp]   # compile mọi task chưa DONE

Agent (spec mục 10):
  eng agents                                             # danh sách agent + input/output contract
  eng agent <ROLE> <TASK_ID> [<TASK-NN>] [--harness NAME] [--dry-run] [--no-skills] [--project P] [--json]
  eng skills [--json]                                     # kiểm tra + liệt kê skill catalog
  eng skills show <NAME> | eng skills route <ROLE> [--phase P] [--objective TEXT]
  eng wave <TASK_ID> --start N --run [--harness NAME]     # chạy developer agent cho từng task trong wave

Recovery (spec mục 15):
  eng recover <TASK_ID> [<TASK-NN>] [--apply] [--max-attempts N] [--by WHO] [--json]

Song song + khoá:
  eng implement <TASK_ID> --parallel [--concurrency N]   # wave song song trong git worktree riêng
  eng merge <TASK_ID> [<TASK-NN>] [--allow-protected]   # merge branch của task vào branch hiện tại
  eng lock <TASK_ID> [--release] [--json]                # xem/thu hồi lock workstream

Phase (spec mục 9.1 — gói sẵn chuỗi bước của một pha):
  eng translate|analyze|design|plan|implement|review|audit|verify <TASK_ID>
      [--harness NAME] [--project P] [--dry-run] [--no-recover] [--allow-bypass] [--json]

Chạy liên tiếp (khuyến nghị cho việc hằng ngày):
  eng continue <TASK_ID> [--harness NAME] [--project P] [--max-steps N] [--dry-run] [--no-recover] [--allow-bypass]
      # đọc state → chạy các pha kế tiếp cho tới khi: DONE | human gate | evidence gate | phải merge | lỗi

Ghi chú: đổi status bắt buộc qua "advance" (đi qua evidence gate INV-03 và human gate INV-05).
Multi-repo (spec mục 9.4): ticket khai nhiều repo bằng "--project a --project b"; mỗi task khai
"### Repo" trong plan.md. Khi ticket có >= 2 repo, gate REVIEWING/DONE đòi evidence cho TỪNG repo
(evidence phải có "project" — dùng --project khi record).`;

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
  repeated: Map<string, string[]>;
}

/**
 * Mọi flag CLI hợp lệ. Cờ lạ ⇒ LỖI rõ ràng thay vì im lặng bỏ qua — gõ nhầm `--allow-bypas`
 * mà không có tín hiệu nào là lỗi an toàn (tưởng đã bypass / tưởng đã truyền tham số).
 */
const KNOWN_FLAGS = new Set([
  "all", "allow-bypass", "allow-protected", "apply", "approved-at", "approver", "architecture-ref",
  "artifact", "by", "capability", "command", "comment", "concurrency", "cwd", "deleted", "domain",
  "dry-run", "exit-code", "expect", "file", "gate-id", "git-sha", "harness", "json", "limit",
  "max-attempts", "max-steps", "max-tokens", "mode", "no-mcp", "no-recover", "no-skills", "objective",
  "parallel", "phase", "ping", "producer", "project", "projects", "reason", "release", "risk", "run",
  "set", "start", "status", "sub-task", "summary", "title", "to", "type", "unexpected", "write",
]);

/** Khoảng cách sửa đổi đơn giản — chỉ để gợi ý khi người dùng gõ nhầm flag. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i += 1) {
    const current = [i, ...Array.from({ length: cols - 1 }, () => 0)];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((prev[j] as number) + 1, (current[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
    }
    prev = current;
  }
  return prev[cols - 1] as number;
}

function assertKnownFlags(args: ParsedArgs): void {
  const unknown = [...args.flags.keys()].filter((name) => !KNOWN_FLAGS.has(name));
  if (unknown.length === 0) return;
  const suggestions = unknown.map((name) => {
    const best = [...KNOWN_FLAGS]
      .map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
      .sort((a, b) => a.distance - b.distance)[0];
    return best !== undefined && best.distance <= 3 ? `--${name} (ý bạn là --${best.candidate}?)` : `--${name}`;
  });
  throw new EngError("UNKNOWN_FLAG", `Flag không tồn tại: ${suggestions.join(", ")}`, {
    hint: 'Xem `eng help` để biết flag hợp lệ. Cờ lạ bị từ chối thay vì bỏ qua âm thầm.',
  });
}

const REPEATABLE_FLAGS = new Set(["set", "project"]);

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const repeated = new Map<string, string[]>();

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      i += 1;
    } else {
      flags.set(body, true);
    }
    if (REPEATABLE_FLAGS.has(body)) {
      const value = flags.get(body);
      if (typeof value === "string") {
        const list = repeated.get(body) ?? [];
        list.push(value);
        repeated.set(body, list);
      }
    }
  }
  return { command, positional, flags, repeated };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagList(args: ParsedArgs, name: string): string[] {
  const raw = args.repeated.get(name) ?? [];
  const single = flag(args, name);
  if (single !== undefined && raw.length === 0) raw.push(single);
  return raw;
}

/**
 * Repo của ticket từ CLI (multi-repo — spec 9.4):
 * `--project a --project b` (lặp được) và/hoặc `--projects a,b`. Thứ tự = thứ tự khai.
 */
function projectList(args: ParsedArgs): string[] {
  const out: string[] = [];
  for (const name of [...flagList(args, "project"), ...flagList(args, "projects")]) {
    for (const part of name.split(",")) {
      const trimmed = part.trim();
      if (trimmed !== "" && !out.includes(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

/** Fail fast khi khai repo không có trong config — không tự suy ra đường dẫn (INV-06). */
function assertKnownProjects(names: string[]): void {
  for (const name of names) {
    if (!isKnownProject(name)) {
      throw new EngError("INVALID_REPO", `Project "${name}" không có trong config/projects.yaml.`, {
        hint: `Project có sẵn: ${projectNames().join(", ")} — repoRoot lấy từ env nên repo có thể nằm ở thư mục cha bất kỳ.`,
      });
    }
  }
}

function required(args: ParsedArgs, name: string, context: string): string {
  const value = flag(args, name);
  if (value === undefined) {
    throw new EngError("MISSING_FLAG", `Thiếu --${name} cho lệnh ${context}.`, { hint: USAGE.split("\n").slice(0, 3).join("\n") });
  }
  return value;
}

function taskIdArg(args: ParsedArgs, context: string): string {
  const id = args.positional[0];
  if (!id) {
    throw new EngError("MISSING_TASK_ID", `Thiếu TASK_ID cho lệnh ${context}.`, { hint: `Ví dụ: eng ${context} TASK-49043` });
  }
  return id;
}

function print(value: unknown, json: boolean, human: () => void): void {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else human();
}

function formatReport(report: ResumeReport, detailed: boolean): string {
  const lines: string[] = [];
  lines.push(`${report.taskId}  ${report.status}  risk=${report.risk} mode=${report.mode} phase=${report.phase}`);
  if (report.title) lines.push(`  title      : ${report.title}`);
  if (report.projects.length > 1) {
    lines.push(`  repo       : ${report.projects.map((name, index) => `${name}${index === 0 ? " (chính)" : ""}`).join(", ")}`);
  }
  lines.push(`  blocked    : ${report.blocked ? `CÓ — ${report.blockReason ?? ""}` : "không"}`);
  if (report.tasks.current.length > 0 || report.tasks.completed.length > 0) {
    lines.push(
      `  tasks      : xong ${report.tasks.completed.length} [${report.tasks.completed.join(", ")}]` +
        ` · đang làm [${report.tasks.current.join(", ")}]${report.tasks.wave !== undefined ? ` · wave ${report.tasks.wave}` : ""}`,
    );
  }
  const approvals = Object.entries(report.approvals);
  lines.push(`  approvals  : ${approvals.length === 0 ? "(chưa có)" : approvals.map(([k, v]) => `${k}=${v ? "yes" : "no"}`).join(" ")}`);
  if (report.contexts.length > 0) {
    const missing = report.contexts.filter((entry) => !entry.compiled && entry.status !== "DONE");
    lines.push(
      `  context    : ${report.contexts.length - missing.length}/${report.contexts.length} task đã compile` +
        `${missing.length > 0 ? ` · thiếu: ${missing.map((entry) => entry.subTaskId).join(", ")}` : ""}`,
    );
  }
  lines.push(
    `  evidence   : ${report.evidence.count} (${Object.entries(report.evidence.byType).map(([k, v]) => `${k}:${v}`).join(" ") || "trống"})`,
  );
  lines.push(`  artifacts  : có [${report.artifacts.present.join(", ") || "—"}] · thiếu [${report.artifacts.missing.join(", ") || "—"}]`);
  if (report.openGates.length > 0) {
    lines.push(
      `  gate mở    : ${report.openGates.map((gate) => `${gate.gateId} (${gate.transition})`).join(", ")}`,
    );
  }
  if (detailed && report.lastTransition) {
    const last = report.lastTransition;
    lines.push(`  chuyển cuối: ${last.from ?? "∅"} → ${last.to} @ ${last.at} bởi ${last.by ?? "?"}${last.reason ? ` — ${last.reason}` : ""}`);
    lines.push(`  events     : ${report.events}`);
  }
  lines.push("  việc tiếp  :");
  for (const action of report.nextActions) lines.push(`    - ${action}`);
  return lines.join("\n");
}

function formatStatusLine(report: ResumeReport): string {
  return `${report.taskId}  ${report.status}  risk=${report.risk}  mode=${report.mode}  evidence=${report.evidence.count}  blocked=${report.blocked ? "yes" : "no"}`;
}

function formatWaves(progress: WaveProgress[]): string {
  const lines: string[] = ["  waves:"];
  for (const wave of progress) {
    const marker = wave.ready ? "▶" : wave.pending.length === 0 ? "✓" : "·";
    lines.push(
      `    ${marker} wave ${wave.index} [${wave.mode}, conflict=${wave.conflictCheck}]` +
        ` tasks=[${wave.tasks.join(", ")}] done=${wave.done.length}/${wave.tasks.length}`,
    );
    for (const conflict of wave.conflicts) {
      lines.push(`        ${conflict.severity} ${conflict.type} [${conflict.tasks.join(", ")}]: ${conflict.detail}`);
    }
  }
  return lines.join("\n");
}

function formatPlan(plan: Plan, execution: ExecutionPlan): string {
  const lines: string[] = [];
  const repos = [...new Set(plan.tasks.map((task) => task.repo ?? ""))].filter((name) => name !== "");
  const multiRepo = repos.length > 1;
  lines.push(
    `plan ${plan.taskId} — ${plan.tasks.length} task · ${execution.waves.length} wave` +
      `${plan.source ? ` · nguồn ${plan.source}` : ""}${plan.architectureRef ? ` · architecture ${plan.architectureRef}` : ""}`,
  );
  if (multiRepo) {
    lines.push(`  repo: ${repos.join(", ")} (multi-repo — mỗi task chỉ sửa repo của nó)`);
  }
  for (const task of plan.tasks) {
    const deps = task.dependencies.length === 0 ? "—" : task.dependencies.join(",");
    const repo = multiRepo ? `[${task.repo ?? "?"}] ` : "";
    lines.push(
      `  ${task.id}  ${repo}${(task.status ?? "PENDING").padEnd(15)} ${task.title.slice(0, 40).padEnd(42)}` +
        ` deps=${deps.padEnd(14)} files=${task.files?.length ?? 0}${task.risk ? ` risk=${task.risk}` : ""}`,
    );
  }
  lines.push(formatWaves(waveProgress(plan, execution)));
  return lines.join("\n");
}

function evidenceFromFlags(args: ParsedArgs): NewEvidence {
  const type = required(args, "type", "record") as EvidenceType;
  const status = required(args, "status", "record") as EvidenceStatus;
  const evidence: Record<string, unknown> = { type, status };

  const summary = flag(args, "summary");
  if (summary) evidence["summary"] = summary;
  // Multi-repo (spec 9.4): evidence phải nêu repo nào thì gate DONE mới kiểm được từng repo.
  const project = flag(args, "project");
  if (project) evidence["project"] = project;
  const command = flag(args, "command");
  if (command) evidence["command"] = command;
  const cwd = flag(args, "cwd");
  if (cwd) evidence["cwd"] = cwd;
  const exitCode = flag(args, "exit-code");
  if (exitCode !== undefined) evidence["exitCode"] = Number.parseInt(exitCode, 10);
  const gitSha = flag(args, "git-sha");
  if (gitSha) evidence["gitSha"] = gitSha;
  const artifact = flag(args, "artifact");
  if (artifact) evidence["artifact"] = artifact;
  const gateId = flag(args, "gate-id");
  if (gateId) evidence["gateId"] = gateId;
  const approver = flag(args, "approver");
  if (approver) evidence["approver"] = approver;
  const approvedAt = flag(args, "approved-at");
  if (approvedAt) evidence["approvedAt"] = approvedAt;
  const subTask = flag(args, "sub-task");
  if (subTask) evidence["subTaskId"] = subTask;
  const unexpected = flag(args, "unexpected");
  if (unexpected !== undefined) evidence["unexpectedFiles"] = unexpected === "" ? [] : unexpected.split(",");
  const deleted = flag(args, "deleted");
  if (deleted !== undefined) evidence["deletedFiles"] = deleted === "" ? [] : deleted.split(",");
  const producer = flag(args, "producer");
  if (producer) evidence["producer"] = producer;
  const comment = flag(args, "comment");
  if (comment) evidence["comment"] = comment;

  return evidence as NewEvidence;
}

function parseSetValues(pairs: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) {
      throw new EngError("INVALID_SET", `--set cần dạng key=value, nhận được: ${pair}`);
    }
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    if (raw === "true" || raw === "false") patch[key] = raw === "true";
    else if (raw !== "" && !Number.isNaN(Number(raw)) && /^-?\d+$/.test(raw)) patch[key] = Number.parseInt(raw, 10);
    else patch[key] = raw;
  }
  return patch;
}

async function runPhaseCli(args: ParsedArgs, phase: PhaseName, taskId: string): Promise<number> {
  const project = flag(args, "project");
  const harness = flag(args, "harness");
  const json = args.flags.has("json");
  const orchestrator = new PhaseOrchestrator({
    ...(project ? { project } : {}),
    ...(harness ? { harness } : {}),
    ...(args.flags.has("dry-run") ? { dryRun: true } : {}),
    ...(args.flags.has("no-recover") ? { noRecover: true } : {}),
    ...(args.flags.has("parallel") ? { parallel: true } : {}),
    ...(args.flags.has("allow-bypass") ? { allowBypass: true } : {}),
    ...(flag(args, "concurrency") ? { concurrency: Number.parseInt(flag(args, "concurrency") as string, 10) } : {}),
    ...(json ? {} : { onProgress: (message: string) => process.stdout.write(`  … ${message}\n`) }),
  });

  const result = await orchestrator.run(taskId, phase);
  print(result, json, () => {
    process.stdout.write(
      `${result.ok ? "✓" : result.blocked ? "⛔" : "✖"} ${phase} ${taskId} — ${result.from} → ${result.to}` +
        `${result.dryRun ? " (dry run)" : ""}\n`,
    );
    process.stdout.write(`  ${result.title}\n`);
    for (const step of result.steps) {
      const mark = step.status === "ok" ? "✔" : step.status === "skipped" ? "○" : step.status === "blocked" ? "⛔" : "✖";
      process.stdout.write(`  ${mark} ${step.name}${step.detail ? ` — ${step.detail}` : ""}\n`);
    }
    if (result.recovery) {
      process.stdout.write(`  recovery : ${result.recovery.category} (${result.recovery.confidence}) · cần người: ${result.recovery.needsHuman ? "CÓ" : "không"}\n`);
    }
    for (const warning of result.warnings) process.stdout.write(`  ⚠ ${warning}\n`);
    if (result.nextActions.length > 0) {
      process.stdout.write("  việc tiếp:\n");
      result.nextActions.forEach((action, index) => process.stdout.write(`    ${index + 1}. ${action}\n`));
    }
  });

  return result.ok ? 0 : 1;
}

export async function runCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  assertKnownFlags(args);
  const store = new StateStore();
  const bus = new EventBus();
  const evidenceStore = new EvidenceStore({ bus });

  switch (args.command) {
    case "help":
    case "--help":
    case "-h": {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }

    case "config": {
      loadConfig(); // ném lỗi nếu config hỏng
      const summary = configSummary();
      print(summary, args.flags.has("json"), () => {
        const lines = Object.entries(summary).map(([key, value]) => `  ${key.padEnd(18)}: ${JSON.stringify(value)}`);
        process.stdout.write(`config hợp lệ — osRoot=${OS_ROOT}\n${lines.join("\n")}\n`);
      });
      return 0;
    }

    case "new": {
      const taskId = taskIdArg(args, "new");
      const domains = flag(args, "domain");
      const capabilities = flag(args, "capability");
      const risk = flag(args, "risk") as RiskLevel | undefined;
      const mode = flag(args, "mode") as ExecutionMode | undefined;
      const status = flag(args, "status") as TaskStatus | undefined;
      // Multi-repo (spec 9.4): ticket có thể khai nhiều repo; phần tử đầu là repo chính.
      const projects = projectList(args);
      assertKnownProjects(projects);
      const state = store.create({
        taskId,
        ...(flag(args, "title") ? { title: flag(args, "title") as string } : {}),
        ...(risk ? { risk } : {}),
        ...(mode ? { mode } : {}),
        ...(status ? { status } : {}),
        ...(projects.length > 0 ? { projects } : {}),
        ...(domains ? { domains: domains.split(",") } : {}),
        ...(capabilities ? { capabilities: capabilities.split(",") } : {}),
      });
      print(state, args.flags.has("json"), () => {
        process.stdout.write(`Đã tạo workstream ${state.taskId} tại ${store.dir(state.taskId)}\n`);
        if (projects.length > 0) {
          process.stdout.write(`  repo       : ${projects.map((name, index) => `${name}${index === 0 ? " (chính)" : ""}`).join(", ")}\n`);
        }
        process.stdout.write(formatReport(store.resume(state.taskId), false) + "\n");
      });
      return 0;
    }

    case "list": {
      const ids = store.list();
      print({ workstreams: ids }, args.flags.has("json"), () => {
        if (ids.length === 0) {
          process.stdout.write("Chưa có workstream nào. Tạo bằng: eng new <TASK_ID>\n");
          return;
        }
        for (const id of ids) {
          const state = store.get(id);
          if (!state) continue;
          process.stdout.write(
            `  ${id.padEnd(16)} ${state.status.padEnd(24)} risk=${state.risk.padEnd(8)} blocked=${state.blocked ? "yes" : "no"}\n`,
          );
        }
      });
      return 0;
    }

    case "status": {
      const taskId = taskIdArg(args, "status");
      const report = store.resume(taskId);
      print(report, args.flags.has("json"), () => {
        process.stdout.write(formatStatusLine(report) + "\n");
        process.stdout.write(`  việc tiếp: ${report.nextActions[0] ?? "—"}\n`);
      });
      return 0;
    }

    case "resume": {
      const taskId = taskIdArg(args, "resume");
      const report = store.resume(taskId);
      print(report, args.flags.has("json"), () => process.stdout.write(formatReport(report, true) + "\n"));
      return 0;
    }

    case "next": {
      const taskId = taskIdArg(args, "next");
      const state = store.require(taskId);
      const report = store.resume(taskId);
      const candidates = nextStatuses(state.status);
      print(
        { taskId, status: state.status, nextStatuses: candidates, nextActions: report.nextActions },
        args.flags.has("json"),
        () => {
          process.stdout.write(`${state.status} → có thể chuyển sang: ${candidates.join(", ") || "(kết thúc)"}\n`);
          for (const action of report.nextActions) process.stdout.write(`  - ${action}\n`);
        },
      );
      return 0;
    }

    case "advance": {
      const taskId = taskIdArg(args, "advance");
      const to = required(args, "to", "advance") as TaskStatus;
      if (!(to in TRANSITIONS)) {
        throw new EngError("UNKNOWN_STATUS", `Status không tồn tại: ${to}`, {
          hint: `Status hợp lệ: ${Object.keys(TRANSITIONS).join(", ")}`,
        });
      }
      const expect = flag(args, "expect") as TaskStatus | undefined;
      const state = store.transition(taskId, to, {
        ...(expect ? { expect } : {}),
        ...(flag(args, "reason") ? { reason: flag(args, "reason") as string } : {}),
        ...(flag(args, "by") ? { by: flag(args, "by") as string } : {}),
        ...(args.flags.has("allow-bypass") ? { allowBypass: true } : {}),
      });
      print(state, args.flags.has("json"), () => {
        process.stdout.write(`✓ ${taskId}: ${state.status} (phase=${state.phase})\n`);
        process.stdout.write(formatReport(store.resume(taskId), false) + "\n");
      });
      return 0;
    }

    case "patch": {
      const taskId = taskIdArg(args, "patch");
      const sets = flagList(args, "set");
      if (sets.length === 0) {
        throw new EngError("MISSING_FLAG", "Cần ít nhất một --set key=value.", {
          hint: `Ví dụ: eng patch ${taskId} --set currentWave=2 --set currentTasks=TASK-03,TASK-04`,
        });
      }
      const patch = parseSetValues(sets);
      for (const key of ["currentTasks", "completedTasks", "domains", "capabilities"]) {
        const value = patch[key];
        if (typeof value === "string") patch[key] = value === "" ? [] : value.split(",");
      }
      const state = store.patch(taskId, patch, { ...(flag(args, "by") ? { by: flag(args, "by") as string } : {}) });
      print(state, args.flags.has("json"), () => process.stdout.write(`✓ đã cập nhật ${taskId}: ${JSON.stringify(patch)}\n`));
      return 0;
    }

    case "block": {
      const taskId = taskIdArg(args, "block");
      const reason = required(args, "reason", "block");
      const state = store.block(taskId, reason, flag(args, "by") ?? "human");
      print(state, args.flags.has("json"), () => process.stdout.write(`⛔ ${taskId} đang BLOCKED: ${reason}\n`));
      return 0;
    }

    case "unblock": {
      const taskId = taskIdArg(args, "unblock");
      const state = store.unblock(taskId, flag(args, "by") ?? "human");
      print(state, args.flags.has("json"), () => process.stdout.write(`✓ ${taskId} đã bỏ block (status=${state.status})\n`));
      return 0;
    }

    case "gates": {
      const taskId = taskIdArg(args, "gates");
      const to = required(args, "to", "gates") as TaskStatus;
      const state = store.require(taskId);
      assertTransition(state.status, to);
      const checks = store.gatesFor(taskId, to);
      print(checks, args.flags.has("json"), () => {
        if (checks.length === 0) {
          process.stdout.write(`${state.status} → ${to}: không có human gate nào.\n`);
          return;
        }
        for (const check of checks) {
          const stateLabel = check.satisfied ? "đã approve" : check.bypassed ? `bỏ qua (${check.bypassReason ?? ""})` : "CHƯA approve";
          process.stdout.write(`  ${check.gateId}: required=${check.required} → ${stateLabel}\n`);
        }
      });
      return 0;
    }

    case "evidence": {
      const taskId = taskIdArg(args, "evidence");
      const type = flag(args, "type") as EvidenceType | undefined;
      const items = evidenceStore.list(taskId, type ? { type } : {});
      print(items, args.flags.has("json"), () => {
        if (items.length === 0) {
          process.stdout.write(`${taskId}: chưa có evidence nào.\n`);
          return;
        }
        for (const item of items) {
          process.stdout.write(
            `  ${item.id}  ${item.type.padEnd(18)} ${item.status.padEnd(8)} ${item.timestamp}  ${item.summary ?? ""}\n`,
          );
          if (item.command) process.stdout.write(`        command: ${item.command} (exit ${item.exitCode ?? "?"})\n`);
        }
      });
      return 0;
    }

    case "record": {
      const taskId = taskIdArg(args, "record");
      const record = evidenceStore.record(taskId, evidenceFromFlags(args));
      print(record, args.flags.has("json"), () => {
        process.stdout.write(`✓ ${record.id} ${record.type}=${record.status} → ${record.path}\n`);
      });
      return 0;
    }

    case "doctor": {
      const report = await runDoctor({
        ...(flag(args, "project") ? { project: flag(args, "project") as string } : {}),
        ...(args.flags.has("ping") ? { ping: true } : {}),
      });
      print(report, args.flags.has("json"), () => process.stdout.write(renderDoctor(report)));
      return report.summary.exitCode;
    }

    case "metrics": {
      const taskId = taskIdArg(args, "metrics");
      const metrics = collectMetrics(taskId);
      let wrote: string | null = null;
      if (args.flags.has("write")) {
        const target = path.join(workstreamDir(taskId), relPath("metrics.md"));
        atomicWrite(target, renderMetrics(metrics));
        wrote = relPath("metrics.md");
      }
      print({ ...metrics, written: wrote }, args.flags.has("json"), () => {
        if (wrote !== null) process.stdout.write(`✓ ghi ${wrote}\n\n`);
        process.stdout.write(renderMetrics(metrics));
      });
      return 0;
    }

    case "events": {
      const taskId = taskIdArg(args, "events");
      const limitFlag = flag(args, "limit");
      const events = bus.read(taskId, limitFlag ? { limit: Number.parseInt(limitFlag, 10) } : {});
      print(events, args.flags.has("json"), () => {
        if (events.length === 0) {
          process.stdout.write(`${taskId}: chưa có event nào.\n`);
          return;
        }
        for (const event of events) {
          process.stdout.write(`  ${event.at}  ${event.type.padEnd(24)} ${event.fromStatus ?? "∅"} → ${event.toStatus ?? "∅"}  ${event.actor}\n`);
        }
      });
      return 0;
    }

    case "continue": {
      const taskId = taskIdArg(args, "continue");
      const project = flag(args, "project");
      const harness = flag(args, "harness");
      const json = args.flags.has("json");
      const maxStepsRaw = flag(args, "max-steps");
      const maxSteps = maxStepsRaw === undefined ? undefined : Number.parseInt(maxStepsRaw, 10);
      const result = await continueTicket(taskId, {
        ...(project ? { project } : {}),
        ...(harness ? { harness } : {}),
        ...(maxSteps !== undefined && !Number.isNaN(maxSteps) ? { maxSteps } : {}),
        ...(args.flags.has("dry-run") ? { dryRun: true } : {}),
        ...(args.flags.has("no-recover") ? { noRecover: true } : {}),
        ...(args.flags.has("allow-bypass") ? { allowBypass: true } : {}),
        ...(json ? {} : { onProgress: (message: string) => process.stdout.write(`  … ${message}\n`) }),
      });

      print(result, json, () => {
        const mark = result.dryRun ? "○" : result.ok ? "✓" : result.stoppedBecause === "HUMAN_GATE" ? "⏸" : "⛔";
        process.stdout.write(`${mark} continue ${taskId} — ${result.from} → ${result.to}${result.dryRun ? " (dry run)" : ""}\n`);
        for (const step of result.steps) {
          const stepMark = step.ok ? "✔" : step.blocked ? "⏸" : "✖";
          process.stdout.write(
            `  ${stepMark} ${step.phase.padEnd(10)} ${step.from} → ${step.to}${step.progressed ? "" : " (không đổi)"}\n`,
          );
        }
        process.stdout.write(`  dừng vì : ${result.stoppedBecause} — ${result.stoppedDetail}\n`);
        for (const gate of result.openGates) {
          process.stdout.write(`  gate mở : ${gate.gateId} (${gate.transition}) — required=${gate.required}\n`);
        }
        for (const warning of result.warnings.slice(0, 8)) process.stdout.write(`  ⚠ ${warning}\n`);
        if (result.nextActions.length > 0) {
          process.stdout.write("  việc tiếp:\n");
          result.nextActions.slice(0, 6).forEach((action, index) => process.stdout.write(`    ${index + 1}. ${action}\n`));
        }
      });

      // exit 0 CHỈ khi ticket đã DONE — mọi điểm dừng khác đều là "chưa xong".
      return result.ok ? 0 : 1;
    }

    case "translate":
    case "analyze":
    case "design":
    case "implement":
    case "review":
    case "audit":
    case "verify": {
      const taskId = taskIdArg(args, args.command);
      return await runPhaseCli(args, args.command as PhaseName, taskId);
    }

    case "merge": {
      const taskId = taskIdArg(args, "merge");
      const only = args.positional[1];
      const project = flag(args, "project");
      const plan = requirePlan(taskId);
      const order = plan.waves && plan.waves.length > 0 ? plan.waves.flatMap((wave) => wave.tasks) : plan.tasks.map((task) => task.id);
      const targets = only ? [only] : order;
      const manager = new WorktreeManager(project ? { project } : {});
      const results: Array<Record<string, unknown>> = [];
      const allowProtected = args.flags.has("allow-protected");

      for (const subTaskId of targets) {
        const rel = relPath("tasks", `${subTaskId}-changes.json`);
        const changes = readJsonFile<{
          branch: string;
          worktree: string;
          baseRef: string;
          project?: string;
          repoRoot?: string;
          merged?: boolean;
          files?: string[];
        }>(path.join(workstreamDir(taskId), rel));

        if (!changes) {
          results.push({ subTaskId, status: "skipped", detail: "không có changes.json (task chạy tuần tự trong cây chính)" });
          continue;
        }
        if (changes.merged === true) {
          results.push({ subTaskId, status: "skipped", detail: `đã merge trước đó (${changes.branch})` });
          continue;
        }

        // Multi-repo (spec 9.4): merge trong REPO của chính task, không phải repo chính của ticket.
        const repoRoot = changes.repoRoot ?? resolveRepoRoot(changes.project ?? project);
        if (repoRoot === null) {
          results.push({
            subTaskId,
            status: "failed",
            detail: `chưa cấu hình repoRoot cho repo "${changes.project ?? project ?? "(mặc định)"}" — không merge được (INV-06)`,
          });
          break;
        }

        const info = {
          taskId,
          subTaskId,
          branch: changes.branch,
          path: changes.worktree,
          repoRoot,
          baseRef: changes.baseRef ?? "HEAD",
        };
        const outcome = await manager.merge(repoRoot, info, allowProtected ? { allowProtected: true } : {});
        if (!outcome.ok) {
          results.push({
            subTaskId,
            status: "failed",
            detail: `merge conflict: ${outcome.conflicts.join(", ") || outcome.output.slice(0, 200)} (đã abort, repo sạch)`,
            conflicts: outcome.conflicts,
          });
          break;
        }

        atomicWrite(
          path.join(workstreamDir(taskId), rel),
          `${JSON.stringify({ ...changes, merged: true, mergedAt: new Date().toISOString(), mergedInto: outcome.branch }, null, 2)}\n`,
        );
        await manager.remove(info, { deleteBranch: true });
        results.push({ subTaskId, status: "ok", detail: `merged ${changes.branch} → ${outcome.branch}, đã xoá worktree` });
      }

      const failed = results.some((item) => item.status === "failed");
      print({ taskId, results }, args.flags.has("json"), () => {
        for (const item of results) {
          const mark = item.status === "ok" ? "✔" : item.status === "skipped" ? "○" : "✖";
          process.stdout.write(`  ${mark} ${String(item.subTaskId)} — ${String(item.detail)}\n`);
        }
        if (!failed) {
          process.stdout.write(`  việc tiếp: eng implement ${taskId}   (thu evidence trên cây đã merge → vào REVIEWING)\n`);
        } else {
          process.stdout.write("  ⚠ merge conflict: repo đã được abort về trạng thái sạch. Xử lý thủ công rồi chạy lại.\n");
        }
      });
      return failed ? 1 : 0;
    }

    case "lock": {
      const taskId = taskIdArg(args, "lock");
      if (args.flags.has("release")) {
        const released = forceReleaseLock(taskId);
        print({ taskId, released }, args.flags.has("json"), () => {
          process.stdout.write(released ? `✓ đã thu hồi lock của ${taskId}\n` : `${taskId}: không có lock để thu hồi\n`);
        });
        return 0;
      }
      const status = lockStatus(taskId);
      print(status, args.flags.has("json"), () => {
        process.stdout.write(`${describeLock(taskId)}\n`);
      });
      return status.info === null ? 0 : 1;
    }

    case "plan": {
      const action = args.positional[0];
      const taskId = args.positional[1];

      // `eng plan <TASK_ID>` = chạy phase lập kế hoạch; `eng plan import|show` = lệnh dữ liệu
      if (action !== "import" && action !== "show") {
        if (!action) {
          throw new EngError("MISSING_ARGUMENT", "Cần: eng plan <TASK_ID> hoặc eng plan <import|show> <TASK_ID>", {
            hint: `Phase: eng plan TASK-49043 · dữ liệu: eng plan import TASK-49043 --file plan.md · phase hợp lệ: ${PHASE_NAMES.join("|")}`,
          });
        }
        return await runPhaseCli(args, "plan", action);
      }
      if (!action || !taskId) {
        throw new EngError("MISSING_ARGUMENT", "Cần: eng plan <import|show> <TASK_ID>", { hint: USAGE.split("\n").slice(-8).join("\n") });
      }
      if (action === "show") {
        const plan = requirePlan(taskId);
        const execution = buildExecutionPlan(plan);
        print({ plan, waves: execution.waves.map((wave) => ({ ...wave, conflicts: wave.conflicts })) }, args.flags.has("json"), () => {
          process.stdout.write(`${formatPlan(plan, execution)}\n`);
        });
        return 0;
      }
      if (action !== "import") {
        throw new EngError("UNKNOWN_ACTION", `eng plan ${action} không tồn tại.`, { hint: "Chỉ có: import, show" });
      }

      const file = flag(args, "file");
      if (!file) {
        throw new EngError("MISSING_FLAG", "Cần --file <plan.md>", { hint: `eng plan import ${taskId} --file plan.md` });
      }
      const absolute = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
      let markdown: string;
      try {
        markdown = readFileSync(absolute, "utf8");
      } catch {
        throw new EngError("PLAN_FILE_NOT_FOUND", `Không đọc được file plan: ${absolute}`);
      }

      ensureWorkstream(taskId);
      const architectureRef = flag(args, "architecture-ref");
      const existing = store.get(taskId);
      const imported = importPlanFromMarkdown(taskId, markdown, {
        ...(architectureRef ? { architectureRef } : {}),
        source: path.basename(absolute),
        ticketProjects: existing?.projects ?? [],
      });

      // Multi-repo (spec 9.4): repo trong plan trở thành repo của ticket (repo chính đứng đầu).
      const merged = [...new Set([...(existing?.projects ?? []), ...imported.repos])];
      if (existing && merged.length > 0) {
        store.patch(taskId, { projects: merged }, { reason: `plan import: repo = ${merged.join(", ")}` });
      }

      const execution = buildExecutionPlan(imported.plan);
      print(
        { plan: imported.plan, execution, repos: imported.repos, warnings: imported.warnings },
        args.flags.has("json"),
        () => {
          process.stdout.write(
            `✓ import ${imported.taskCount} task từ ${path.basename(absolute)} → ${path.join(workstreamDir(taskId), "plan.json")}\n`,
          );
          for (const warning of imported.warnings) process.stdout.write(`  ⚠ ${warning}\n`);
          process.stdout.write(`${formatPlan(imported.plan, execution)}\n`);
        },
      );
      return 0;
    }

    case "graph": {
      const taskId = taskIdArg(args, "graph");
      const plan = requirePlan(taskId);
      const execution = buildExecutionPlan(plan);
      const progress = waveProgress(plan, execution);
      print({ dag: execution.dag, waves: execution.waves, progress, blocked: execution.blocked, errors: execution.errors }, args.flags.has("json"), () => {
        process.stdout.write(`${formatPlan(plan, execution)}\n`);
        process.stdout.write(`  DAG: ${execution.dag.tasks.length} task, ${execution.dag.edges.length} cạnh phụ thuộc\n`);
        if (execution.blocked) process.stdout.write(`  ✖ plan không thực thi được: ${execution.errors.join("; ")}\n`);
        const upcoming = nextWave(plan, execution);
        process.stdout.write(upcoming ? `  wave kế tiếp: ${upcoming.index} [${upcoming.tasks.join(", ")}] mode=${upcoming.mode}\n` : "  tất cả wave đã xong\n");
      });
      return 0;
    }

    case "wave": {
      const taskId = taskIdArg(args, "wave");
      const plan = requirePlan(taskId);
      const execution = buildExecutionPlan(plan);
      if (execution.blocked) {
        throw new EngError("PLAN_NOT_EXECUTABLE", `Plan không thực thi được: ${execution.errors.join("; ")}`, {
          hint: "Sửa plan (vòng phụ thuộc / dependency lạ) rồi import lại.",
        });
      }
      const progress = waveProgress(plan, execution);
      const startFlag = flag(args, "start");

      if (startFlag === undefined) {
        const upcoming = nextWave(plan, execution);
        print({ progress, next: upcoming }, args.flags.has("json"), () => {
          process.stdout.write(`${formatWaves(progress)}\n`);
          process.stdout.write(upcoming ? `  → chạy: eng wave ${taskId} --start ${upcoming.index}\n` : "  → tất cả task đã DONE\n");
        });
        return 0;
      }

      const index = Number.parseInt(startFlag, 10);
      const target = progress.find((wave) => wave.index === index);
      if (!target) {
        throw new EngError("WAVE_NOT_FOUND", `Plan không có wave ${index}.`, {
          hint: `Wave hiện có: ${progress.map((wave) => wave.index).join(", ")}`,
        });
      }
      if (target.blockedByPrevious) {
        throw new EngError("WAVE_BLOCKED", `Wave ${index} còn chờ wave trước hoàn tất.`, {
          hint: `Còn task chưa DONE ở wave trước: ${progress.filter((wave) => wave.pending.length > 0 && wave.index < index).map((wave) => wave.index).join(", ")}`,
        });
      }

      const state = store.require(taskId);
      if (state.status !== "IMPLEMENTING") {
        throw new EngError("WAVE_NOT_ALLOWED", `Chỉ chạy wave khi status = IMPLEMENTING (đang là ${state.status}).`, {
          hint: `Chạy: eng advance ${taskId} --to IMPLEMENTING`,
        });
      }

      for (const subTaskId of target.tasks) setTaskStatus(plan, subTaskId, "IN_PROGRESS");
      writePlan(plan);
      const nextState = store.patch(taskId, { currentWave: index, currentTasks: target.tasks }, { reason: `bắt đầu wave ${index}` });

      // --run: chạy developer agent cho từng task trong wave (tuần tự; parallel thật chưa implement)
      const runResults: AgentRunResult[] = [];
      if (args.flags.has("run")) {
        const harness = flag(args, "harness");
        const project = flag(args, "project");
        const runner = new AgentRunner(project ? { project } : {});
        for (const subTaskId of target.tasks) {
          const result = await runner.run({
            taskId,
            role: "developer",
            subTaskId,
            ...(harness ? { harness } : {}),
            ...(project ? { project } : {}),
          });
          runResults.push(result);
          if (!result.ok) break; // worker fail ⇒ dừng, không chạy tiếp trên nền hỏng
        }
      }

      print({ wave: target, status: nextState.status, runs: runResults }, args.flags.has("json"), () => {
        process.stdout.write(`✓ wave ${index} (${target.mode}, conflict=${target.conflictCheck}): ${target.tasks.join(", ")}\n`);
        if (target.mode === "SEQUENTIAL") {
          process.stdout.write("  ⚠ có conflict ⇒ chạy TUẦN TỰ, không parallel (INV-11)\n");
        }
        if (runResults.length > 0) {
          process.stdout.write("  (WaveExecutor chỉ chạy TUẦN TỰ ở Phase 1 — parallel thật chưa implement)\n");
          for (const result of runResults) {
            process.stdout.write(
              `  ${result.ok ? "✓" : "✖"} ${result.subTaskId} tier=${result.tier} exit=${result.exitCode ?? "?"} ` +
                `${result.durationMs}ms · artifact thiếu [${result.artifactsMissing.join(", ") || "—"}]\n`,
            );
            for (const warning of result.warnings) process.stdout.write(`      ⚠ ${warning}\n`);
          }
          const doneTasks = target.tasks.slice(0, runResults.filter((result) => result.ok).length);
          if (doneTasks.length > 0) {
            process.stdout.write(`  đánh dấu xong: eng subtask ${taskId} ${doneTasks.join(" --status DONE && eng subtask " + taskId)} --status DONE\n`);
          }
        } else {
          process.stdout.write(`  mỗi task: eng subtask ${taskId} ${target.tasks[0]} --status DONE\n`);
        }
      });
      return 0;
    }

    case "subtask": {
      const taskId = args.positional[0];
      const subTaskId = args.positional[1];
      if (!taskId || !subTaskId) {
        throw new EngError("MISSING_ARGUMENT", "Cần: eng subtask <TASK_ID> <TASK-NN> --status STATUS", {
          hint: `Ví dụ: eng subtask TASK-49043 TASK-01 --status DONE`,
        });
      }
      const status = required(args, "status", "subtask") as SubTaskStatus;
      const allowed: SubTaskStatus[] = [
        "PENDING",
        "IN_PROGRESS",
        "TESTING",
        "SPEC_REVIEW",
        "QUALITY_REVIEW",
        "DONE",
        "FAILED",
        "REWORK_REQUIRED",
        "BLOCKED",
      ];
      if (!allowed.includes(status)) {
        throw new EngError("UNKNOWN_STATUS", `Status không hợp lệ: ${status}`, { hint: `Cho phép: ${allowed.join(", ")}` });
      }

      const plan = requirePlan(taskId);
      setTaskStatus(plan, subTaskId, status);
      writePlan(plan);

      const state = store.require(taskId);
      const completed = new Set(state.completedTasks ?? []);
      const current = new Set(state.currentTasks ?? []);
      if (status === "DONE") {
        completed.add(subTaskId);
        current.delete(subTaskId);
      } else {
        completed.delete(subTaskId);
        current.add(subTaskId);
      }
      const nextState = store.patch(
        taskId,
        { completedTasks: [...completed].sort(), currentTasks: [...current].sort() },
        { reason: `${subTaskId} → ${status}` },
      );

      bus.emit({
        taskId,
        type: status === "DONE" ? "TaskCompleted" : "TaskStarted",
        subTaskId,
        actor: flag(args, "by") ?? "runtime:eng",
        wave: nextState.currentWave ?? null,
        payload: { subTaskId, status },
      });

      const execution = buildExecutionPlan(plan);
      const upcoming = nextWave(plan, execution);
      print({ subTaskId, status, plan: planProgress(plan), nextWave: upcoming }, args.flags.has("json"), () => {
        process.stdout.write(`✓ ${subTaskId} → ${status}  (plan: ${Object.entries(planProgress(plan)).map(([k, v]) => `${k}=${v}`).join(" ")})\n`);
        if (upcoming) process.stdout.write(`  wave kế tiếp: ${upcoming.index} [${upcoming.tasks.join(", ")}]\n`);
        else if (Object.values(planProgress(plan)).some((count) => count === plan.tasks.length)) {
          process.stdout.write(`  → tất cả task DONE. Chạy verification rồi: eng advance ${taskId} --to REVIEWING\n`);
        }
      });
      return 0;
    }

    case "context": {
      const taskId = taskIdArg(args, "context");
      const plan = requirePlan(taskId);
      const noMcp = args.flags.has("no-mcp");
      const project = flag(args, "project");
      const maxTokensRaw = flag(args, "max-tokens");
      const limits = maxTokensRaw !== undefined ? { maxTokens: Number.parseInt(maxTokensRaw, 10) } : undefined;

      const wantsAll = args.flags.has("all");
      const targets = wantsAll
        ? plan.tasks.filter((task) => (task.status ?? "PENDING") !== "DONE").map((task) => task.id)
        : [args.positional[1] ?? ""];

      if (!wantsAll && targets[0] === "") {
        throw new EngError("MISSING_ARGUMENT", "Cần TASK-NN (hoặc --all).", {
          hint: `Ví dụ: eng context ${taskId} TASK-01   |   eng context ${taskId} --all`,
        });
      }

      if (wantsAll && targets.length === 0) {
        print([], args.flags.has("json"), () => {
          process.stdout.write(`${taskId}: không còn task nào cần compile (mọi task đã DONE).\n`);
        });
        return 0;
      }

      const providers = createProviders({
        noMcp,
        ...(project ? { project } : {}),
        ...(limits ? { limits } : {}),
      });

      const results: Array<Record<string, unknown>> = [];
      try {
        for (const subTaskId of targets) {
          const compiled = await compileTaskContext({
            taskId,
            subTaskId,
            providers,
            ...(project ? { project } : {}),
            ...(limits ? { limits } : {}),
          });
          const merged = { ...(store.get(taskId)?.artifacts ?? {}) };
          merged[`context:${subTaskId}`] = compiled.markdownPath;
          merged[`context-json:${subTaskId}`] = compiled.jsonPath;
          store.patch(taskId, { artifacts: merged }, { reason: `compile context ${subTaskId}` });

          results.push({
            subTaskId,
            repo: compiled.context.repo ?? null,
            tokenEstimate: compiled.tokenEstimate,
            maxTokenBudget: compiled.context.budget?.maxTokenBudget,
            truncated: compiled.truncated,
            symbols: compiled.context.symbols?.length ?? 0,
            files: compiled.context.files?.length ?? 0,
            businessRules: compiled.context.businessRules?.length ?? 0,
            unknowns: compiled.context.unknowns?.length ?? 0,
            mcpQueries: compiled.context.provenance.mcpQueries?.length ?? 0,
            warnings: compiled.warnings,
            markdownPath: compiled.markdownPath,
            jsonPath: compiled.jsonPath,
          });
        }
      } finally {
        providers.close();
      }

      print(results, args.flags.has("json"), () => {
        for (const result of results) {
          process.stdout.write(
            `✓ context ${result.subTaskId}: ~${result.tokenEstimate} token` +
              `${result.truncated ? " (ĐÃ CẮT)" : ""} · ${result.symbols} symbol · ${result.files} file · ` +
              `${result.businessRules} business rule · ${result.mcpQueries} MCP call · ${result.unknowns} unknown` +
              `${result.repo ? ` · repo ${result.repo}` : ""}\n`,
          );
          process.stdout.write(`    → ${path.join(workstreamDir(taskId), "context", `${result.subTaskId}.md`)}\n`);
          for (const warning of result.warnings as string[]) process.stdout.write(`    ⚠ ${warning}\n`);
          if (Number(result.unknowns) > 0) {
            process.stdout.write(`    ⚠ có unknown ⇒ worker phải báo BLOCKED, không được đoán (INV-06)\n`);
          }
        }
      });
      return 0;
    }

    case "agents": {
      const contracts = AGENT_ROLES.map((role) => {
        const contract = AGENTS[role];
        return {
          role,
          title: contract.title,
          inputs: contract.inputs.map((input) => `${input.path}${input.optional === true ? " (tuỳ chọn)" : ""}`),
          outputs: contract.outputs,
          requiresContext: contract.requiresContext === true,
        };
      });
      print({ agents: contracts, harnesses: harnessNames() }, args.flags.has("json"), () => {
        for (const contract of contracts) {
          process.stdout.write(`${contract.role.padEnd(11)} ${contract.title}\n`);
          process.stdout.write(`  inputs : ${contract.inputs.join(", ")}\n`);
          process.stdout.write(`  outputs: ${contract.outputs.join(", ")}${contract.requiresContext ? "  (cần context/TASK-NN.md)" : ""}\n`);
        }
        process.stdout.write(`harness: ${harnessNames().join(", ") || "(chưa khai báo)"} · built-in: dry\n`);
      });
      return 0;
    }

    case "agent": {
      const role = args.positional[0] ?? "";
      const taskId = args.positional[1] ?? "";
      const subTaskId = args.positional[2];
      if (role === "" || taskId === "") {
        throw new EngError("MISSING_ARGUMENT", "Cần: eng agent <ROLE> <TASK_ID> [<TASK-NN>]", {
          hint: `ROLE thuộc: ${AGENT_ROLES.join(", ")}`,
        });
      }

      const project = flag(args, "project");
      const harness = flag(args, "harness");
      const runner = new AgentRunner(project ? { project } : {});
      const result = await runner.run({
        taskId,
        role,
        ...(subTaskId ? { subTaskId } : {}),
        ...(harness ? { harness } : {}),
        ...(project ? { project } : {}),
        ...(args.flags.has("dry-run") ? { dryRun: true } : {}),
        ...(args.flags.has("no-skills") ? { noSkills: true } : {}),
      });

      print(result, args.flags.has("json"), () => {
        const mark = result.dryRun ? "○" : result.ok ? "✓" : "✖";
        process.stdout.write(
          `${mark} ${result.role}${result.subTaskId ? ` / ${result.subTaskId}` : ""} — tier=${result.tier}` +
            ` (${result.model}) · complexity=${result.complexity} · harness=${result.harness}` +
            `${result.exitCode !== undefined ? ` · exit=${result.exitCode}` : ""} · ${result.durationMs}ms\n`,
        );
        process.stdout.write(`  tier     : ${result.tierReason}\n`);
        process.stdout.write(`  prompt   : ${result.promptPath} (~${result.promptTokens} token)\n`);
        if (result.contextPath) process.stdout.write(`  context  : ${result.contextPath}\n`);
        if (result.logPath) process.stdout.write(`  log      : ${result.logPath}\n`);
        process.stdout.write(
          `  skills   : ${result.skills.map((skill) => skill.name).join(", ") || "—"} (~${result.skillTokens} token)\n`,
        );
        if (result.templates.length > 0) process.stdout.write(`  template : ${result.templates.join(", ")}\n`);
        process.stdout.write(
          `  usage    : ${
            result.dryRun
              ? "dry run — không gọi LLM, không có token"
              : result.usage === null
                ? "harness không báo (chưa ghi ENG_USAGE_FILE) — cost chỉ đo được theo tier + thời gian"
                : `in ${result.usage.inputTokens ?? "?"} / out ${result.usage.outputTokens ?? "?"} token (${result.usage.source ?? "harness"})`
          }\n`,
        );
        process.stdout.write(
          `  artifact : có [${result.artifactsPresent.join(", ") || "—"}] · thiếu [${result.artifactsMissing.join(", ") || "—"}]\n`,
        );
        for (const warning of result.warnings) process.stdout.write(`  ⚠ ${warning}\n`);
      });

      return result.ok && result.artifactsMissing.length === 0 ? 0 : 1;
    }

    case "recover": {
      const taskId = taskIdArg(args, "recover");
      const subTaskId = args.positional[1];
      const apply = args.flags.has("apply");
      const maxAttemptsRaw = flag(args, "max-attempts");
      const engine = new RecoveryEngine();
      const outcome = engine.recover(taskId, {
        ...(subTaskId ? { subTaskId } : {}),
        ...(apply ? { apply: true } : {}),
        ...(flag(args, "by") ? { by: flag(args, "by") as string } : {}),
        ...(maxAttemptsRaw !== undefined ? { maxAttempts: Number.parseInt(maxAttemptsRaw, 10) } : {}),
      });
      const diagnosis = outcome.diagnosis;

      print(outcome, args.flags.has("json"), () => {
        process.stdout.write(
          `${diagnosis.needsHuman ? "⛔" : "⚠"} ${diagnosis.taskId}${diagnosis.subTaskId ? `/${diagnosis.subTaskId}` : ""} — ` +
            `${diagnosis.category} (confidence ${diagnosis.confidence})\n`,
        );
        process.stdout.write(`  ${diagnosis.summary}\n`);
        process.stdout.write(
          `  status   : ${diagnosis.sourceStatus} → ${diagnosis.targetStatus}` +
            `${outcome.transitions.length > 0 ? ` (${outcome.transitions.map((t) => `${t.from}→${t.to}`).join(", ")})` : ""}\n`,
        );
        process.stdout.write(
          `  lần thử  : ${diagnosis.attempt}/${diagnosis.maxAttempts} · tự phục hồi: ${diagnosis.autoRecoverable ? "có" : "không"} · cần người: ${diagnosis.needsHuman ? "CÓ" : "không"}\n`,
        );
        process.stdout.write("  dấu hiệu :\n");
        for (const signal of diagnosis.signals) process.stdout.write(`    - [${signal.source}] ${signal.detail}\n`);
        process.stdout.write("  việc phải làm:\n");
        diagnosis.actions.forEach((action, index) => process.stdout.write(`    ${index + 1}. ${action}\n`));
        if (outcome.markdownPath) process.stdout.write(`  recovery : ${outcome.markdownPath}\n`);
        for (const warning of outcome.warnings) process.stdout.write(`  ⚠ ${warning}\n`);
        if (!outcome.applied) {
          process.stdout.write(`  (chưa áp dụng — thêm --apply để ghi recovery context và đổi trạng thái)\n`);
        }
      });

      return outcome.blocked || diagnosis.needsHuman ? 1 : 0;
    }

    case "skills": {
      const action = args.positional[0] ?? "list";
      const catalog = loadSkills();

      if (action === "show") {
        const name = args.positional[1] ?? "";
        const skill = catalog.skills.find((item) => item.name === name);
        if (!skill) {
          throw new EngError("SKILL_NOT_FOUND", `Không có skill "${name}".`, {
            hint: `Skill có sẵn: ${catalog.skills.map((item) => item.name).join(", ")}`,
          });
        }
        print(skill, args.flags.has("json"), () => {
          process.stdout.write(`# ${skill.name} (${skill.file})\n`);
          process.stdout.write(`description: ${skill.description}\n`);
          process.stdout.write(`phase: ${(skill.phase ?? []).join(", ") || "—"} · roles: ${(skill.roles ?? []).join(", ") || "—"}\n\n`);
          process.stdout.write(`${skill.body}\n`);
        });
        return 0;
      }

      if (action === "route") {
        const role = args.positional[1] ?? "";
        if (role === "") {
          throw new EngError("MISSING_ARGUMENT", "Cần: eng skills route <ROLE> [--phase P] [--objective TEXT]", {
            hint: `ROLE thuộc: ${AGENT_ROLES.join(", ")}`,
          });
        }
        const phase = flag(args, "phase");
        const objective = flag(args, "objective") ?? "";
        const limits = skillRoutingLimits();
        const route = routeSkills(
          {
            role,
            ...(phase ? { phase } : {}),
            objective,
            maxSkills: limits.maxSkills,
            maxTokens: limits.maxSkillTokens,
          },
          catalog,
        );
        print(
          {
            role,
            phase: phase ?? null,
            selected: route.selected.map((entry) => ({ name: entry.skill.name, score: entry.score, reasons: entry.reasons, tokens: Math.ceil(entry.skill.body.length / 4) })),
            skillTokens: route.tokens,
            truncated: route.truncated,
            skippedCount: route.skipped.length,
          },
          args.flags.has("json"),
          () => {
            process.stdout.write(`${role}${phase ? ` / phase=${phase}` : ""} → ${route.selected.length} skill (~${route.tokens} token)\n`);
            for (const entry of route.selected) {
              process.stdout.write(`  + ${entry.skill.name} (score ${entry.score}) — ${entry.reasons.join(" · ")}\n`);
            }
            process.stdout.write(`  bỏ qua: ${route.skipped.length} skill không khớp role/phase/trigger\n`);
          },
        );
        return 0;
      }

      const summary = skillCatalogSummary(catalog);
      print(summary, args.flags.has("json"), () => {
        process.stdout.write(`skills: ${summary.total} — root ${catalog.root}\n`);
        for (const [group, names] of Object.entries(summary.byGroup as Record<string, string[]>)) {
          process.stdout.write(`  ${group.padEnd(12)} ${names.length}: ${names.join(", ")}\n`);
        }
        if (catalog.issues.length === 0) {
          process.stdout.write("  ✔ không có lỗi cấu trúc (front-matter, section, description chỉ nêu WHEN, độ dài)\n");
        } else {
          process.stdout.write(`  ✖ ${catalog.issues.length} lỗi:\n`);
          for (const issue of catalog.issues) process.stdout.write(`    - [${issue.code}] ${issue.file}: ${issue.message}\n`);
        }
      });
      return catalog.issues.length === 0 ? 0 : 1;
    }

    default:
      throw new EngError("UNKNOWN_COMMAND", `Lệnh không tồn tại: ${args.command}`, { hint: USAGE });
  }
}

async function main(): Promise<void> {
  // Output bị pipe cắt (ví dụ `eng graph | head`) không nên in stack trace.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}

main().catch((error: unknown) => {
  if (error instanceof EngError) {
    process.stderr.write(`✖ [${error.code}] ${error.message}\n`);
    if (error.hint) process.stderr.write(`  → ${error.hint}\n`);
    printDetails(error.details);
  } else {
    process.stderr.write(`✖ ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  }
  process.exitCode = 1;
});

/** In chi tiết lỗi (missing/errors/gates) để người dùng biết phải sửa gì. */
function printDetails(details: Record<string, unknown> | undefined): void {
  if (!details) return;

  const missing = details["missing"];
  if (Array.isArray(missing)) {
    process.stderr.write("  thiếu:\n");
    for (const item of missing) process.stderr.write(`    - ${String(item)}\n`);
  }

  const errors = details["errors"];
  if (Array.isArray(errors)) {
    for (const item of errors) {
      if (typeof item === "string") {
        process.stderr.write(`    - ${item}\n`);
        continue;
      }
      if (item === null || typeof item !== "object") continue;
      const entry = item as { code?: string; message?: string; taskId?: string; line?: number };
      const where = [entry.taskId, entry.line === undefined ? undefined : `dòng ${entry.line}`]
        .filter((part): part is string => typeof part === "string" && part !== "")
        .join(" · ");
      process.stderr.write(
        `    - [${entry.code ?? "?"}] ${entry.message ?? JSON.stringify(item)}${where === "" ? "" : ` (${where})`}\n`,
      );
    }
  }

  const gates = details["gates"];
  if (Array.isArray(gates)) {
    for (const item of gates) {
      if (item === null || typeof item !== "object") continue;
      const gate = item as { gateId?: string; transition?: string };
      process.stderr.write(`    - gate ${gate.gateId ?? "?"} (${gate.transition ?? ""})\n`);
    }
  }
}
