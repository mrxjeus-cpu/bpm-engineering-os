import path from "node:path";
import { findSimilarCode } from "./code.js";
import { type RepoContext, currentBranch, fileExists, headSha, readTextFile, walkFiles } from "./repo.js";
import { symbolIndexFor } from "./symbol-index.js";
import { emitEvent, listWorkstreamFiles, readWorkstreamText } from "./workstream.js";

function extensionCounts(files: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    const ext = path.extname(file).toLowerCase() || "(none)";
    counts[ext] = (counts[ext] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function topLevelDirs(repo: RepoContext, files: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const first = file.split("/")[0];
    if (first && first !== file) dirs.add(first);
  }
  return [...dirs].sort();
}

export function getProjectContext(repo: RepoContext): Record<string, unknown> {
  const files = walkFiles(repo);
  const conventions = ["docs/ARCHITECTURE.md", "ARCHITECTURE.md", "README.md"].filter((f) => fileExists(repo, f));
  const index = symbolIndexFor(repo).stats();
  return {
    project: repo.project,
    repoRoot: repo.root,
    language: repo.language,
    buildSystem: repo.buildSystem,
    branch: currentBranch(repo),
    headSha: headSha(repo),
    topLevelDirs: topLevelDirs(repo, files),
    indexedFiles: files.length,
    filesByExtension: extensionCounts(files),
    conventions,
    index: {
      files: index.fileCount,
      symbols: index.symbolCount,
      buildMs: index.buildMs,
      builtAt: index.builtAt,
      gitSha: index.gitSha,
      fromCache: index.fromCache,
      ttlMs: index.ttlMs,
    },
    source: `scan:${repo.root}`,
    note:
      "Đây là summary. Không load toàn bộ repo vào context (INV-01). " +
      "`index` là symbol index dùng cho find_symbol/read_symbol/find_callers (pattern-based, không phải type resolution).",
  };
}

export function getServiceContext(repo: RepoContext, options: { service: string }): Record<string, unknown> {
  const all = walkFiles(repo);
  const prefix = `${options.service}/`;
  const files = all.filter((f) => f.startsWith(prefix));
  if (files.length === 0) {
    const dirs = topLevelDirs(repo, all);
    return {
      status: "BLOCKED",
      reason: `Không tìm thấy service "${options.service}" trong repo.`,
      missing: ["service path"],
      availableTopLevelDirs: dirs.slice(0, 30),
      note: "Không suy diễn cấu trúc service (INV-06).",
    };
  }

  const entryPoints = files.filter((f) => /(Application|Bootstrap|Main)\.(java|kt|ts)$/.test(f) || /Controller\.(java|ts)$/.test(f));
  const testFiles = files.filter((f) => /(^|\/)(src\/test|test|tests)\//.test(f) || /Test.*\.(java|ts)$/.test(f));
  const packages = new Set(files.map((f) => f.split("/").slice(0, 4).join("/")));

  return {
    status: "OK",
    project: repo.project,
    service: options.service,
    files: files.length,
    testFiles: testFiles.length,
    filesByExtension: extensionCounts(files),
    topPackages: [...packages].slice(0, 30),
    entryPoints: entryPoints.slice(0, 20),
    source: `scan:${prefix}`,
  };
}

export function getModuleContext(
  repo: RepoContext,
  options: { module: string; maxResults?: number },
): Record<string, unknown> {
  const maxResults = options.maxResults ?? 100;
  const all = walkFiles(repo);
  const prefix = options.module.endsWith("/") ? options.module : `${options.module}/`;
  const files = all.filter((f) => f.startsWith(prefix));
  if (files.length === 0) {
    const dirs = new Set(all.map((f) => f.split("/").slice(0, 2).join("/")));
    return {
      status: "BLOCKED",
      reason: `Không tìm thấy module "${options.module}".`,
      missing: ["module path"],
      candidates: [...dirs].slice(0, 30),
      note: "Không suy diễn cấu trúc module (INV-06).",
    };
  }

  const publicTypes: Array<{ file: string; type: string; name: string }> = [];
  for (const file of files) {
    if (publicTypes.length >= maxResults) break;
    const ext = path.extname(file).toLowerCase();
    if (![".java", ".ts", ".tsx"].includes(ext)) continue;
    let text: string;
    try {
      text = readTextFile(repo, file);
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\b(?:public\s+)?(class|interface|enum|record)\s+([A-Za-z_]\w*)/g)) {
      if (m[1] && m[2]) publicTypes.push({ file, type: m[1], name: m[2] });
      if (publicTypes.length >= maxResults) break;
    }
  }

  return {
    status: "OK",
    project: repo.project,
    module: options.module,
    files: files.length,
    filesByExtension: extensionCounts(files),
    types: publicTypes,
    source: `scan:${prefix}`,
  };
}

/** Context slicing: lấy đúng section của một task trong plan (spec mục 7.2). */
export function slicePlanSection(
  planText: string,
  subTaskId: string,
): { section: string; startLine: number; endLine: number } | null {
  const lines = planText.split(/\r?\n/);
  const numeric = subTaskId.replace(/^TASK-?/i, "").replace(/^0+/, "");
  const headingRe = new RegExp(`^#{1,6}\\s*(?:TASK[- ]?0*${numeric}|Task\\s+0*${numeric})\\b`, "i");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = headingRe.exec(lines[i] ?? "");
    if (m) {
      start = i;
      level = (lines[i] ?? "").match(/^#+/)?.[0].length ?? 2;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length - 1;
  for (let i = start + 1; i < lines.length; i += 1) {
    const heading = /^(#{1,6})\s/.exec(lines[i] ?? "");
    if (heading?.[1] && heading[1].length <= level) {
      end = i - 1;
      break;
    }
  }
  return { section: lines.slice(start, end + 1).join("\n").trimEnd(), startLine: start + 1, endLine: end + 1 };
}

/**
 * Thu thập nguyên liệu cho Context Compiler của runtime.
 *
 * Lưu ý phạm vi: MCP này KHÔNG tự viết context cuối cùng — nó gom đúng section của task,
 * brief/context đã có, file/symbol liên quan và gợi ý code tương tự, kèm provenance.
 * Việc tổng hợp thành `context/task-NN.md` là việc của runtime ContextCompiler (spec mục 7.3).
 */
export function buildTaskContext(
  repo: RepoContext,
  options: { taskId: string; subTaskId: string; project?: string },
): Record<string, unknown> {
  const workstreamFiles = listWorkstreamFiles(options.taskId);
  if (workstreamFiles.length === 0) {
    return {
      status: "BLOCKED",
      reason: `Workstream ${options.taskId} chưa có artifact nào.`,
      missing: ["plan.md", "requirements.md", "architecture.md"],
      note: "Chạy các phase trước (translate → requirements → impact → design → plan) trước khi compile context (INV-03).",
    };
  }

  const planText = readWorkstreamText(options.taskId, "plan.md");
  const section = planText ? slicePlanSection(planText, options.subTaskId) : null;
  const brief = readWorkstreamText(options.taskId, `tasks/${options.subTaskId}-brief.md`);
  const existingContext = readWorkstreamText(options.taskId, `context/${options.subTaskId}.md`);

  const sourceText = [section?.section ?? "", brief ?? "", existingContext ?? ""].join("\n");
  const candidateFiles = [
    ...new Set(
      [...sourceText.matchAll(/[\w./-]+\.(?:java|kt|ts|tsx|js|sql|xml|yml|yaml|json|properties|md)/g)]
        .map((m) => m[0])
        .filter((f) => !f.startsWith("http")),
    ),
  ].slice(0, 40);
  const candidateSymbols = [
    ...new Set(
      [...sourceText.matchAll(/\b([A-Z][A-Za-z0-9_]*(?:\.[a-zA-Z_]\w*)?)\b/g)]
        .map((m) => m[1])
        .filter((s): s is string => typeof s === "string" && s.length > 3),
    ),
  ].slice(0, 40);

  let similarCode: unknown = [];
  let similarCodeError: string | undefined;
  try {
    similarCode = findSimilarCode(repo, {
      query: `${options.taskId} ${section?.section.split("\n").slice(0, 8).join(" ") ?? ""}`,
      maxResults: 5,
    }).results;
  } catch (error) {
    similarCodeError = error instanceof Error ? error.message : String(error);
  }

  emitEvent(options.taskId, {
    type: "TaskStarted",
    subTaskId: options.subTaskId,
    actor: "mcp:mcp-engineering",
    payload: { reason: "build_task_context" },
  });

  return {
    status: "GATHERED",
    taskId: options.taskId,
    subTaskId: options.subTaskId,
    planSection: section,
    taskBrief: brief,
    existingContext,
    candidateFiles,
    candidateSymbols,
    similarCode,
    similarCodeError,
    workstreamFiles,
    provenance: {
      generatedAt: new Date().toISOString(),
      generatedBy: "mcp:mcp-engineering build_task_context",
      gitSha: headSha(repo),
      planRef: planText ? `plan.md:${section?.startLine ?? 0}-${section?.endLine ?? 0}` : null,
      architectureRef: workstreamFiles.includes("architecture.md") ? "architecture.md" : null,
      mcpQueries: [{ server: "mcp-engineering", tool: "find_similar_code" }],
    },
    note:
      "Runtime ContextCompiler chịu trách nhiệm tổng hợp thành context/task-NN.md theo schemas/context.schema.json. " +
      "Không paste toàn bộ plan vào worker (INV-01).",
  };
}
