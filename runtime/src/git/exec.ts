import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EngError } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface GitResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/** Chạy git trong một thư mục; KHÔNG ném lỗi khi exit code khác 0 (caller tự quyết định). */
export async function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string; message: string };
    return {
      ok: false,
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : failure.message,
    };
  }
}

export async function gitOrThrow(cwd: string, args: string[], context: string): Promise<string> {
  const result = await git(cwd, args);
  if (!result.ok) {
    throw new EngError("GIT_FAILED", `${context}: git ${args.join(" ")} thất bại.`, {
      hint: result.stderr.trim().slice(0, 500) || undefined,
    });
  }
  return result.stdout.trim();
}

export async function currentBranch(repoRoot: string): Promise<string> {
  return gitOrThrow(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], "đọc branch hiện tại");
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const result = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}
