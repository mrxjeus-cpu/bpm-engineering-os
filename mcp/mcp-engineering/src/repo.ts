import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { projectConfig, serverConfig, OS_ROOT } from "./config.js";
import { ToolError } from "./errors.js";
import { matchesAny } from "./glob.js";

export interface RepoContext {
  project: string;
  root: string;
  language: string;
  buildSystem: string;
}

function defaultRepoRoot(): string | undefined {
  const configured = serverConfig().repo.rootDefault;
  return configured ?? undefined;
}

/**
 * Resolve repoRoot của project. Nếu chưa cấu hình ⇒ lỗi rõ ràng, KHÔNG đoán (INV-06).
 */
export function resolveRepo(project?: string): RepoContext {
  const { name, config } = projectConfig(project);
  const envName = config.repoRoot?.env;
  const fromEnv = envName ? process.env[envName] : undefined;
  const root = fromEnv ?? config.repoRoot?.default ?? defaultRepoRoot();
  if (!root) {
    throw new ToolError(
      "REPO_ROOT_NOT_CONFIGURED",
      `Chưa cấu hình repoRoot cho project "${name}"${envName ? ` (env ${envName})` : ""}.`,
      `Set env ${envName ?? "DOMAIN_REPO_ROOT"}=/duong/dan/toi/repo, hoặc điền repoRoot.default trong config/projects.yaml. ` +
        "Tool cần repo sẽ không hoạt động cho tới khi có repoRoot — không suy diễn nội dung repo.",
    );
  }
  const abs = path.isAbsolute(root) ? path.resolve(root) : path.resolve(OS_ROOT, root);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new ToolError(
      "REPO_ROOT_NOT_FOUND",
      `repoRoot không tồn tại hoặc không phải thư mục: ${abs}`,
      "Kiểm tra lại env repo root / cấu hình project.",
    );
  }
  return { project: name, root: abs, language: config.language, buildSystem: config.buildSystem };
}

export interface WalkOptions {
  include?: string[];
  excludeDirs?: string[];
  maxFileBytes?: number;
  limit?: number;
}

export function walkFiles(repo: RepoContext, options: WalkOptions = {}): string[] {
  const scan = serverConfig().scan;
  const include = options.include && options.include.length > 0 ? options.include : scan.include;
  const excludeDirs = new Set(options.excludeDirs ?? scan.excludeDirs);
  const maxFileBytes = options.maxFileBytes ?? scan.maxFileBytes;
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;

  const out: string[] = [];
  const stack: string[] = [""];

  while (stack.length > 0) {
    const rel = stack.pop() as string;
    const abs = rel === "" ? repo.root : path.join(repo.root, rel);
    const entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }> = [];
    try {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        entries.push({ name: String(entry.name), isDirectory: entry.isDirectory(), isFile: entry.isFile() });
      }
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory) {
        if (!excludeDirs.has(entry.name)) stack.push(childRel);
        continue;
      }
      if (!entry.isFile) continue;
      if (!matchesAny(childRel, include)) continue;
      try {
        if (statSync(path.join(repo.root, childRel)).size > maxFileBytes) continue;
      } catch {
        continue;
      }
      out.push(childRel);
      if (out.length >= limit) return out.sort();
    }
  }
  return out.sort();
}

export function absolutePath(repo: RepoContext, relPath: string): string {
  const abs = path.resolve(repo.root, relPath);
  const rootWithSep = repo.root.endsWith(path.sep) ? repo.root : repo.root + path.sep;
  if (abs !== repo.root && !abs.startsWith(rootWithSep)) {
    throw new ToolError("PATH_OUTSIDE_REPO", `Đường dẫn nằm ngoài repoRoot: ${relPath}`);
  }
  return abs;
}

export function readTextFile(repo: RepoContext, relPath: string): string {
  const abs = absolutePath(repo, relPath);
  try {
    return readFileSync(abs, "utf8");
  } catch {
    throw new ToolError("FILE_NOT_FOUND", `Không đọc được file: ${relPath}`);
  }
}

export function readLines(repo: RepoContext, relPath: string): string[] {
  return readTextFile(repo, relPath).split(/\r?\n/);
}

export function fileExists(repo: RepoContext, relPath: string): boolean {
  try {
    return existsSync(absolutePath(repo, relPath));
  } catch {
    return false;
  }
}

export function headSha(repo: RepoContext): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function currentBranch(repo: RepoContext): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repo.root,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}
