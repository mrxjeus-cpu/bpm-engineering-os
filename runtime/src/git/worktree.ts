import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { loadConfig, projectConfig } from "../config/index.js";
import { EngError } from "../errors.js";
import { OS_ROOT } from "../paths.js";
import { currentBranch, git, gitOrThrow, isGitRepo } from "./exec.js";

export interface WorktreeConfig {
  enabled: boolean;
  branchPrefix: string;
  root: string;
  baseRef: string;
}

export interface WorktreeInfo {
  taskId: string;
  subTaskId: string;
  branch: string;
  path: string;
  repoRoot: string;
  baseRef: string;
}

export function worktreeConfig(project?: string): WorktreeConfig {
  const { config } = projectConfig(project);
  const raw = (config as { worktrees?: Partial<WorktreeConfig> }).worktrees ?? {};
  return {
    enabled: raw.enabled === true,
    branchPrefix: raw.branchPrefix ?? "eng/",
    root: raw.root ?? ".engineering/worktrees",
    baseRef: raw.baseRef ?? "HEAD",
  };
}

function branchName(config: WorktreeConfig, taskId: string, subTaskId: string): string {
  return `${config.branchPrefix}${taskId}-${subTaskId}`.replace(/[^A-Za-z0-9._/-]/g, "-");
}

/**
 * WorktreeManager — cô lập mỗi task song song trong một git worktree riêng.
 *
 * Vì sao cần: hai agent chạy song song trong CÙNG working tree sẽ tranh nhau `target/`,
 * file tạm, cổng test... Conflict check (INV-11) chỉ bảo đảm không trùng FILE của task,
 * không bảo đảm build/test chạy song song an toàn.
 *
 * An toàn: manager này KHÔNG tự merge. Merge là lệnh riêng (`eng merge`) và từ chối merge
 * vào branch được bảo vệ (config/projects.yaml → protectedBranches).
 */
export class WorktreeManager {
  readonly #osRoot: string;
  readonly #config: WorktreeConfig;

  constructor(options: { osRoot?: string; config?: WorktreeConfig; project?: string } = {}) {
    this.#osRoot = options.osRoot ?? OS_ROOT;
    this.#config = options.config ?? worktreeConfig(options.project);
  }

  get config(): WorktreeConfig {
    return this.#config;
  }

  dirFor(taskId: string, subTaskId: string): string {
    return path.join(this.#osRoot, this.#config.root, taskId, subTaskId);
  }

  assertEnabled(): void {
    if (!this.#config.enabled) {
      throw new EngError("WORKTREES_DISABLED", "Chạy song song cần cô lập worktree nhưng chưa bật trong config.", {
        hint:
          "Bật trong config/projects.yaml → projects.<name>.worktrees.enabled = true " +
          "(và chắc chắn repoRoot là git repository). Không chạy song song trong cùng working tree: " +
          "hai agent sẽ tranh target/, file tạm và cổng test.",
      });
    }
  }

  async create(repoRoot: string, taskId: string, subTaskId: string): Promise<WorktreeInfo> {
    this.assertEnabled();
    if (!(await isGitRepo(repoRoot))) {
      throw new EngError("NOT_A_GIT_REPO", `repoRoot không phải git repository: ${repoRoot}`, {
        hint: "Không cô lập được thay đổi song song nếu không có git — tắt --parallel hoặc cấu hình repo git.",
      });
    }

    const branch = branchName(this.#config, taskId, subTaskId);
    const dir = this.dirFor(taskId, subTaskId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

    // Chốt baseRef thành SHA cụ thể: nếu giữ "HEAD", sau khi worktree commit thì
    // `git diff HEAD...HEAD` sẽ rỗng và ta mất khả năng biết task đã đổi file nào.
    const baseSha = await gitOrThrow(repoRoot, ["rev-parse", "--verify", `${this.#config.baseRef}^{commit}`], "resolve baseRef");

    const exists = await git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    const args = exists.ok
      ? ["worktree", "add", "--force", dir, branch]
      : ["worktree", "add", "-b", branch, dir, baseSha];
    await gitOrThrow(repoRoot, args, `tạo worktree cho ${subTaskId}`);

    return { taskId, subTaskId, branch, path: dir, repoRoot, baseRef: baseSha };
  }

  /** Commit thay đổi của agent trong worktree (agent có thể không tự commit). */
  async commit(info: WorktreeInfo, message: string): Promise<{ committed: boolean; sha?: string; files: number }> {
    const status = await git(info.path, ["status", "--porcelain"]);
    const files = status.stdout.split("\n").filter((line) => line.trim() !== "").length;
    if (files === 0) return { committed: false, files: 0 };

    await git(info.path, ["add", "-A"]);
    const commit = await git(info.path, ["-c", "user.name=engineering-os", "-c", "user.email=eng-os@local", "commit", "-m", message]);
    if (!commit.ok) {
      throw new EngError("WORKTREE_COMMIT_FAILED", `Không commit được thay đổi của ${info.subTaskId}.`, {
        hint: commit.stderr.trim().slice(0, 500) || undefined,
      });
    }
    const sha = await gitOrThrow(info.path, ["rev-parse", "--short", "HEAD"], "đọc sha worktree");
    return { committed: true, sha, files };
  }

  async diffStat(info: WorktreeInfo): Promise<string> {
    const result = await git(info.path, ["diff", "--stat", `${info.baseRef}...HEAD`]);
    return result.ok ? result.stdout.trim() : "";
  }

  async changedFiles(info: WorktreeInfo): Promise<string[]> {
    const result = await git(info.path, ["diff", "--name-only", `${info.baseRef}...HEAD`]);
    return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  }

  async remove(info: WorktreeInfo, options: { deleteBranch?: boolean } = {}): Promise<void> {
    await git(info.repoRoot, ["worktree", "remove", "--force", info.path]);
    if (options.deleteBranch === true) await git(info.repoRoot, ["branch", "-D", info.branch]);
    if (existsSync(info.path)) rmSync(info.path, { recursive: true, force: true });
    await git(info.repoRoot, ["worktree", "prune"]);
  }

  async list(repoRoot: string): Promise<Array<{ path: string; branch: string }>> {
    const result = await git(repoRoot, ["worktree", "list", "--porcelain"]);
    if (!result.ok) return [];
    const entries: Array<{ path: string; branch: string }> = [];
    let current: { path?: string; branch?: string } = {};
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) entries.push({ path: current.path, branch: current.branch ?? "" });
        current = { path: line.slice("worktree ".length).trim() };
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length).trim().replace("refs/heads/", "");
      }
    }
    if (current.path) entries.push({ path: current.path, branch: current.branch ?? "" });
    return entries;
  }

  /**
   * Merge một branch vào branch hiện tại của repoRoot.
   * Từ chối branch được bảo vệ và TỰ ABORT khi có conflict (không để repo ở trạng thái merge dở).
   */
  async merge(
    repoRoot: string,
    info: WorktreeInfo,
    options: { message?: string; allowProtected?: boolean } = {},
  ): Promise<{ ok: boolean; output: string; conflicts: string[]; branch: string }> {
    const target = await currentBranch(repoRoot);
    const { protectedBranches } = loadConfig().projects;
    const isProtected = protectedBranches.some((pattern) =>
      pattern.endsWith("/*") ? target.startsWith(pattern.slice(0, -1)) : target === pattern,
    );
    if (isProtected && options.allowProtected !== true) {
      throw new EngError("PROTECTED_BRANCH", `Từ chối merge vào branch được bảo vệ: ${target}.`, {
        hint:
          "Chuyển sang feature branch rồi merge lại, hoặc dùng --allow-protected nếu thật sự có chủ đích " +
          "(CLAUDE.md mục 2).",
      });
    }

    const message = options.message ?? `merge ${info.branch} (${info.subTaskId}) vào ${target}`;
    const result = await git(repoRoot, ["merge", "--no-ff", "-m", message, info.branch]);
    if (result.ok) return { ok: true, output: result.stdout.trim(), conflicts: [], branch: target };

    const conflictsResult = await git(repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
    const conflicts = conflictsResult.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    await git(repoRoot, ["merge", "--abort"]);
    return { ok: false, output: result.stderr.trim(), conflicts, branch: target };
  }

  async hasBranch(repoRoot: string, branch: string): Promise<boolean> {
    const result = await git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return result.ok;
  }
}
