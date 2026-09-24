import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadProjectsConfig, projectConfig } from "./config.js";
import { ToolError } from "./errors.js";
import type { RepoContext } from "./repo.js";

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function git(repo: RepoContext, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: repo.root,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number | string; message: string };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : e.message,
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

export async function gitStatus(repo: RepoContext): Promise<Record<string, unknown>> {
  const result = await git(repo, ["status", "--porcelain=v1", "--branch"]);
  return {
    project: repo.project,
    branch: result.stdout.split("\n")[0]?.replace(/^##\s*/, "") ?? "unknown",
    entries: result.stdout.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("##")),
    exitCode: result.exitCode,
    source: "git status --porcelain=v1 --branch",
  };
}

export interface DiffOptions {
  file?: string;
  base?: string;
  staged?: boolean;
  maxBytes?: number;
}

export async function gitDiff(repo: RepoContext, options: DiffOptions = {}): Promise<Record<string, unknown>> {
  const args = ["diff", "--no-color"];
  if (options.staged) args.push("--cached");
  args.push(options.base ? `${options.base}...HEAD` : "HEAD");
  if (options.file) args.push("--", options.file);
  const result = await git(repo, args);
  const maxBytes = options.maxBytes ?? 200_000;
  const truncated = Buffer.byteLength(result.stdout, "utf8") > maxBytes;
  return {
    project: repo.project,
    diff: truncated ? Buffer.from(result.stdout, "utf8").subarray(0, maxBytes).toString("utf8") : result.stdout,
    truncated,
    exitCode: result.exitCode,
    stderr: result.stderr.trim() || undefined,
    source: `git ${args.join(" ")}`,
  };
}

export async function gitDiffFile(
  repo: RepoContext,
  options: { path: string; base?: string },
): Promise<Record<string, unknown>> {
  return gitDiff(repo, { file: options.path, ...(options.base ? { base: options.base } : {}) });
}

export async function gitHistory(
  repo: RepoContext,
  options: { path?: string; limit?: number; base?: string } = {},
): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
  const args = ["log", `-n${limit}`, "--date=iso-strict", "--pretty=format:%H|%ad|%an|%s"];
  if (options.base) args.push(options.base);
  if (options.path) args.push("--", options.path);
  const result = await git(repo, args);
  const commits = result.stdout
    .split("\n")
    .filter((line) => line.includes("|"))
    .map((line) => {
      const [sha, date, author, ...rest] = line.split("|");
      return { sha, date, author, subject: rest.join("|") };
    });
  return { project: repo.project, commits, exitCode: result.exitCode, source: `git ${args.join(" ")}` };
}

export async function findRelatedCommits(
  repo: RepoContext,
  options: { query: string; limit?: number },
): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
  const result = await git(repo, [
    "log",
    `-n${limit}`,
    "--date=iso-strict",
    "--pretty=format:%H|%ad|%an|%s",
    `--grep=${options.query}`,
    "-i",
  ]);
  const commits = result.stdout
    .split("\n")
    .filter((line) => line.includes("|"))
    .map((line) => {
      const [sha, date, author, ...rest] = line.split("|");
      return { sha, date, author, subject: rest.join("|") };
    });
  return {
    project: repo.project,
    query: options.query,
    commits,
    exitCode: result.exitCode,
    source: `git log --grep=${options.query}`,
  };
}

export interface ScopeValidation {
  status: "PASS" | "FAIL";
  changedFiles: string[];
  unexpectedFiles: string[];
  deletedFiles: string[];
  allowedRoots: string[];
  allowedFiles: string[];
  baseRef: string;
  violations: string[];
  source: string;
}

function parsePorcelain(stdout: string): Array<{ status: string; file: string }> {
  const entries: Array<{ status: string; file: string }> = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "" || line.startsWith("##")) continue;
    const status = line.slice(0, 2);
    let file = line.slice(3).trim();
    const arrow = file.indexOf(" -> ");
    if (arrow >= 0) file = file.slice(arrow + 4).trim();
    if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
    entries.push({ status, file });
  }
  return entries;
}

/**
 * So diff thực tế với scope cho phép. Đây là cơ chế chống regression (INV-04):
 * file ngoài scope hoặc file bị xóa không nằm trong allowlist ⇒ FAIL.
 */
export async function validateChangeScope(
  repo: RepoContext,
  options: { allowedFiles?: string[]; allowedRoots?: string[]; base?: string } = {},
): Promise<ScopeValidation> {
  const { config } = projectConfig(repo.project);
  const workspaceConfig = loadProjectsConfig();
  const allowedRoots = options.allowedRoots ?? config.scope?.allowedRoots ?? [];
  const allowedFiles = options.allowedFiles ?? [];
  const allowedDeletions = new Set(config.scope?.allowDeletions ?? []);
  const baseRef = options.base ?? "HEAD";

  const status = await git(repo, ["status", "--porcelain=v1"]);
  if (status.exitCode !== 0) {
    throw new ToolError(
      "NOT_A_GIT_REPO",
      `Không đọc được git status trong ${repo.root}: ${status.stderr.trim() || "git trả về lỗi"}`,
      "Kiểm tra repoRoot có phải git repository. Không kết luận scope PASS khi chưa có diff thật (INV-06).",
    );
  }
  const entries = parsePorcelain(status.stdout);

  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const unexpectedFiles: string[] = [];

  for (const entry of entries) {
    changedFiles.push(entry.file);
    const isDeletion = entry.status.includes("D");
    if (isDeletion) deletedFiles.push(entry.file);
    const inRoot = allowedRoots.some((root) => entry.file === root || entry.file.startsWith(`${root}/`));
    const explicitlyAllowed = allowedFiles.includes(entry.file);
    if (!inRoot && !explicitlyAllowed) unexpectedFiles.push(entry.file);
  }

  const violations: string[] = [];
  if (unexpectedFiles.length > 0) {
    violations.push(`Thay đổi ngoài scope: ${unexpectedFiles.join(", ")}`);
  }
  const badDeletions = deletedFiles.filter((f) => !allowedDeletions.has(f));
  if (badDeletions.length > 0) {
    violations.push(`Xóa file không nằm trong allowlist: ${badDeletions.join(", ")}`);
  }

  return {
    status: violations.length === 0 ? "PASS" : "FAIL",
    changedFiles,
    unexpectedFiles,
    deletedFiles,
    allowedRoots,
    allowedFiles,
    baseRef,
    violations,
    source: `git status --porcelain=v1 (protected branches: ${workspaceConfig.protectedBranches.join(", ")})`,
  };
}

export function assertNotProtectedBranch(branch: string): void {
  const config = loadProjectsConfig();
  const blocked = config.protectedBranches.some((pattern) => {
    if (pattern.endsWith("/*")) return branch.startsWith(pattern.slice(0, -1));
    return branch === pattern;
  });
  if (blocked) {
    throw new ToolError(
      "PROTECTED_BRANCH",
      `Branch "${branch}" nằm trong danh sách bảo vệ — không thao tác ghi.`,
      "Chuyển sang feature branch trước khi thay đổi (CLAUDE.md mục 2).",
    );
  }
}
