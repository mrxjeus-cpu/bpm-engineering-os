import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { projectConfig, serverConfig } from "./config.js";
import { ToolError } from "./errors.js";
import { type RepoContext, headSha } from "./repo.js";
import { recordEvidence, workstreamDir } from "./workstream.js";

const execFileAsync = promisify(execFile);

export type RunKind = "build" | "test" | "testAll" | "verify";

interface RunOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

async function execute(argv: string[], cwd: string, timeoutMs: number): Promise<RunOutcome> {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(argv[0] as string, argv.slice(1), {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr, durationMs: Date.now() - started, timedOut: false };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; message: string };
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : e.message,
      durationMs: Date.now() - started,
      timedOut: e.killed === true,
    };
  }
}

function tail(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(-maxChars), truncated: true };
}

/**
 * Chạy command từ ALLOWLIST trong config/projects.yaml.
 * Command KHÔNG bao giờ lấy từ tool input (ADR-08).
 */
export async function runAllowlisted(
  repo: RepoContext,
  options: { kind: RunKind; suite?: string; taskId?: string; subTaskId?: string },
): Promise<Record<string, unknown>> {
  const verification = serverConfig().verification;
  const { config } = projectConfig(repo.project);

  const templates = config.commands?.[options.kind];
  if (!templates || templates.length === 0) {
    throw new ToolError(
      "COMMAND_NOT_ALLOWED",
      `Project "${repo.project}" không khai báo command "${options.kind}" trong allowlist.`,
      `Thêm vào config/projects.yaml → projects.${repo.project}.commands.${options.kind}. ` +
        "MCP không nhận command tùy ý từ input (ADR-08).",
    );
  }

  const suites = config.testSuites ?? {};
  let timeoutMs = verification.timeoutMs;
  let suite = options.suite;

  if (options.kind === "test") {
    if (!suite) {
      throw new ToolError("SUITE_REQUIRED", "run_test cần tham số suite.", `Suite hợp lệ: ${Object.keys(suites).join(", ")}`);
    }
    if (!(suite in suites)) {
      throw new ToolError(
        "SUITE_NOT_ALLOWED",
        `Suite "${suite}" không nằm trong allowlist của project "${repo.project}".`,
        `Suite hợp lệ: ${Object.keys(suites).join(", ") || "(chưa khai báo)"}`,
      );
    }
    const suiteConfig = suites[suite];
    if (suiteConfig?.timeoutMs) timeoutMs = suiteConfig.timeoutMs;
  }

  if (options.kind === "testAll" && suite) {
    if (!verification.allowPatternRuns) {
      throw new ToolError("PATTERN_RUNS_DISABLED", "Chạy test theo pattern đang bị tắt trong config/mcp.yaml.");
    }
    const whitelist = new RegExp(verification.patternWhitelist);
    if (!whitelist.test(suite)) {
      throw new ToolError(
        "PATTERN_NOT_ALLOWED",
        `Pattern "${suite}" không khớp whitelist ${verification.patternWhitelist}.`,
        "Chỉ dùng ký tự test-name hợp lệ; không truyền shell metacharacter.",
      );
    }
  }

  const template = templates[0] as string[];
  const argv = template.map((arg) => (suite ? arg.replaceAll("{suite}", suite) : arg));

  const outcome = await execute(argv, repo.root, timeoutMs);
  const status = outcome.exitCode === 0 && !outcome.timedOut ? "PASS" : "FAIL";
  const command = argv.join(" ");
  const stdout = tail(outcome.stdout, 4000);
  const stderr = tail(outcome.stderr, 2000);

  const result: Record<string, unknown> = {
    status,
    kind: options.kind,
    project: repo.project,
    suite: suite ?? null,
    command,
    cwd: repo.root,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    timedOut: outcome.timedOut,
    stdout: stdout.text,
    stdoutTruncated: stdout.truncated,
    stderr: stderr.text,
    stderrTruncated: stderr.truncated,
    gitSha: headSha(repo),
    source: `allowlist:config/projects.yaml#projects.${repo.project}.commands.${options.kind}`,
  };

  if (options.taskId && verification.recordEvidence) {
    const logsDir = path.join(workstreamDir(options.taskId), "evidence", "logs");
    mkdirSync(logsDir, { recursive: true });
    const logName = `${options.kind}-${Date.now()}.log`;
    writeFileSync(
      path.join(logsDir, logName),
      `$ ${command}\n# cwd: ${repo.root}\n# exit: ${outcome.exitCode}\n\n--- stdout ---\n${outcome.stdout}\n\n--- stderr ---\n${outcome.stderr}\n`,
      "utf8",
    );
    const evidence = recordEvidence(
      options.taskId,
      {
        type: options.kind === "build" ? "BUILD" : "TEST",
        status,
        summary: `${command} → exit ${outcome.exitCode}${outcome.timedOut ? " (timeout)" : ""}`,
        subTaskId: options.subTaskId ?? null,
        command,
        cwd: repo.root,
        exitCode: outcome.exitCode,
        gitSha: headSha(repo),
        artifact: `evidence/logs/${logName}`,
        producer: `mcp:mcp-engineering:run_${options.kind}`,
        durationMs: outcome.durationMs,
      },
      repo.project,
    );
    result["evidence"] = evidence;
  }

  return result;
}
