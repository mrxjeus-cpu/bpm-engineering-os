import path from "node:path";
import { loadProjectsConfig, projectConfig } from "./config.js";
import { ToolError } from "./errors.js";
import { type RepoContext, fileExists, readTextFile, walkFiles } from "./repo.js";

const CONSTRAINT_HINT =
  /(must|must not|do not|shall|required|constraint|rule|forbidden|never|always|only|bắt buộc|không được|phải|nguyên tắc|quy tắc|hạn chế)/i;

export interface ConstraintHit {
  file: string;
  line: number;
  text: string;
}

/**
 * Trả về architecture constraints dưới dạng các dòng có tính ràng buộc.
 * Mục đích: agent không phải đọc 5.000 dòng để biết rule (spec mục 13.2).
 */
export function getArchitectureConstraints(
  repo: RepoContext,
  options: { paths?: string[]; maxResults?: number } = {},
): Record<string, unknown> {
  const { config } = projectConfig(repo.project);
  const candidates = options.paths ?? [
    ...(config.conventions ?? []),
    "docs/ARCHITECTURE.md",
    "ARCHITECTURE.md",
    "docs/architecture.md",
  ];
  const seen = new Set<string>();
  const constraints: ConstraintHit[] = [];
  const scanned: string[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!fileExists(repo, candidate)) continue;
    scanned.push(candidate);
    const lines = readTextFile(repo, candidate).split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const text = (lines[i] ?? "").trim();
      if (text === "") continue;
      if (!text.startsWith("#") && text.length < 12) continue;
      if (!CONSTRAINT_HINT.test(text)) continue;
      constraints.push({ file: candidate, line: i + 1, text: text.slice(0, 400) });
      if (constraints.length >= (options.maxResults ?? 60)) break;
    }
    if (constraints.length >= (options.maxResults ?? 60)) break;
  }

  if (scanned.length === 0 && constraints.length === 0) {
    throw new ToolError(
      "ARCHITECTURE_DOC_NOT_FOUND",
      "Không tìm thấy tài liệu kiến trúc/conventions nào để trích ràng buộc.",
      `Đã thử: ${candidates.join(", ")}. Khai báo đường dẫn trong config/projects.yaml → projects.${repo.project}.conventions. ` +
        "Không tự suy diễn ràng buộc kiến trúc (INV-06).",
    );
  }

  return {
    project: repo.project,
    scannedFiles: scanned,
    constraints,
    totalConstraints: constraints.length,
    source: scanned.map((f) => `${f}`),
  };
}

export function getProjectConventions(
  repo: RepoContext,
  options: { paths?: string[] } = {},
): Record<string, unknown> {
  const { config } = projectConfig(repo.project);
  const candidates = options.paths ?? [...(config.conventions ?? []), "docs/ARCHITECTURE.md", "README.md"];
  const documents: Array<{ file: string; headings: Array<{ level: number; text: string; line: number }> }> = [];

  for (const candidate of candidates) {
    if (!fileExists(repo, candidate)) continue;
    const lines = readTextFile(repo, candidate).split(/\r?\n/);
    const headings: Array<{ level: number; text: string; line: number }> = [];
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^(#{1,6})\s+(.*)$/.exec(lines[i] ?? "");
      if (m?.[1] && m[2]) headings.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
    }
    documents.push({ file: candidate, headings });
  }

  const workspaceConfig = loadProjectsConfig();
  return {
    project: repo.project,
    language: config.language,
    buildSystem: config.buildSystem,
    documents,
    scope: config.scope,
    protectedBranches: workspaceConfig.protectedBranches,
    source: documents.map((d) => d.file),
    note: documents.length === 0 ? "Chưa có tài liệu conventions — cần bổ sung trước khi dùng cho context." : undefined,
  };
}

function parseMavenDependencies(pomXml: string): Array<{ groupId: string; artifactId: string; version?: string; scope?: string }> {
  const deps: Array<{ groupId: string; artifactId: string; version?: string; scope?: string }> = [];
  for (const block of pomXml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const body = block[1] ?? "";
    const pick = (tag: string): string | undefined => new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(body)?.[1]?.trim();
    const groupId = pick("groupId");
    const artifactId = pick("artifactId");
    if (!groupId || !artifactId) continue;
    const dep: { groupId: string; artifactId: string; version?: string; scope?: string } = { groupId, artifactId };
    const version = pick("version");
    const scope = pick("scope");
    if (version) dep.version = version;
    if (scope) dep.scope = scope;
    deps.push(dep);
  }
  return deps;
}

export function getServiceDependencies(
  repo: RepoContext,
  options: { service?: string; maxResults?: number },
): Record<string, unknown> {
  const service = options.service;
  const pomCandidates = service
    ? [`${service}/pom.xml`, `pom.xml`]
    : ["pom.xml", "build.gradle", "build.gradle.kts"];
  const files = walkFiles(repo, { include: ["**/pom.xml", "**/build.gradle", "**/build.gradle.kts"] });

  for (const candidate of pomCandidates) {
    if (!files.includes(candidate)) continue;
    const text = readTextFile(repo, candidate);
    const dependencies = parseMavenDependencies(text).slice(0, options.maxResults ?? 60);
    return {
      project: repo.project,
      service: service ?? "(root)",
      buildFile: candidate,
      dependencies,
      totalDependencies: dependencies.length,
      source: candidate,
    };
  }

  throw new ToolError(
    "BUILD_FILE_NOT_FOUND",
    `Không tìm thấy pom.xml/build.gradle cho service "${service ?? "(root)"}".`,
    `Build file có sẵn trong repo: ${files.slice(0, 10).join(", ") || "(không có)"}. Không suy diễn dependency (INV-06).`,
  );
}

export function getModuleDependencies(
  repo: RepoContext,
  options: { module: string; maxResults?: number; include?: string[] },
): Record<string, unknown> {
  const module = options.module;
  const all = walkFiles(repo, {
    include: options.include ?? ["**/*.java", "**/*.ts", "**/*.tsx"],
  });
  const prefixCandidates = all
    .filter((f) => f.startsWith(`${module}/`))
    .slice(0, 2000);

  if (prefixCandidates.length === 0) {
    const dirs = new Set(all.map((f) => f.split("/").slice(0, 2).join("/")));
    throw new ToolError(
      "MODULE_NOT_FOUND",
      `Không tìm thấy module "${module}".`,
      `Module/thư mục tương tự: ${[...dirs].slice(0, 15).join(", ")}`,
    );
  }

  const importCounts = new Map<string, number>();
  for (const file of prefixCandidates) {
    const text = readTextFile(repo, file);
    for (const line of text.split(/\r?\n/).slice(0, 200)) {
      const m = /^\s*import\s+(?:static\s+)?([\w.]+)/.exec(line);
      if (!m?.[1]) continue;
      const pkg = m[1].split(".").slice(0, 4).join(".");
      importCounts.set(pkg, (importCounts.get(pkg) ?? 0) + 1);
    }
  }

  const dependencies = [...importCounts.entries()]
    .map(([pkg, count]) => ({ package: pkg, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, options.maxResults ?? 30);

  return {
    project: repo.project,
    module,
    filesScanned: prefixCandidates.length,
    externalPackages: dependencies,
    source: `scan:${module}/`,
    confidence: "heuristic",
  };
}

export function resolveServiceDir(repo: RepoContext, service: string): string {
  const candidates = [service, path.join("services", service), path.join("modules", service)];
  for (const candidate of candidates) {
    if (fileExists(repo, candidate)) return candidate;
  }
  throw new ToolError(
    "SERVICE_NOT_FOUND",
    `Không tìm thấy service/module "${service}" trong repo.`,
    "Kiểm tra tên thư mục (case-sensitive) hoặc dùng get_project_context để xem cấu trúc.",
  );
}
