import path from "node:path";
import { limits } from "./config.js";
import { ToolError } from "./errors.js";
import { overlapScore, tokenize } from "./glob.js";
import { type RepoContext, readLines, readTextFile, walkFiles } from "./repo.js";
import { symbolIndexFor, type IndexedSymbol } from "./symbol-index.js";
import { declarationPatterns, escapeRegex, isProbablyBinary, supportsDeclarations } from "./symbols.js";

export interface CodeMatch {
  file: string;
  line: number;
  snippet: string;
  /** Độ tin cậy khi biết nơi khai báo (ranking theo package/import). */
  confidence?: "exact" | "likely" | "weak";
  reason?: string;
}

export interface SymbolHit {
  name: string;
  kind: string;
  file: string;
  line: number;
  signature: string;
  confidence: "exact" | "heuristic";
}

const RANK_ORDER: Record<string, number> = { exact: 0, likely: 1, weak: 2 };

function sortByRank<T extends { confidence?: string; file: string; line: number }>(items: T[]): T[] {
  return items.sort((a, b) => {
    const rank = (RANK_ORDER[a.confidence ?? "weak"] ?? 2) - (RANK_ORDER[b.confidence ?? "weak"] ?? 2);
    if (rank !== 0) return rank;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });
}

export interface SearchResult {
  matches: CodeMatch[];
  totalMatches: number;
  filesScanned: number;
  page: number;
  pageSize: number;
  truncated: boolean;
  source: string;
}

export function searchCode(
  repo: RepoContext,
  options: {
    query: string;
    isRegex?: boolean;
    include?: string[];
    page?: number;
    pageSize?: number;
    maxResults?: number;
  },
): SearchResult {
  const cfg = limits();
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(options.pageSize ?? cfg.pagination.defaultPageSize, cfg.pagination.maxPageSize);
  const maxResults = options.maxResults ?? cfg.maxResults;

  let re: RegExp;
  try {
    re = new RegExp(options.isRegex ? options.query : escapeRegex(options.query), "i");
  } catch {
    throw new ToolError("INVALID_REGEX", `Regex không hợp lệ: ${options.query}`);
  }

  const files = walkFiles(repo, options.include ? { include: options.include } : {});
  const all: CodeMatch[] = [];
  let total = 0;

  for (const file of files) {
    let text: string;
    try {
      text = readTextFile(repo, file);
    } catch {
      continue;
    }
    if (isProbablyBinary(text)) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!re.test(line)) continue;
      total += 1;
      if (all.length < page * pageSize) {
        all.push({ file, line: i + 1, snippet: line.trim().slice(0, 400) });
      }
    }
  }

  const start = (page - 1) * pageSize;
  const matches = all.slice(start, start + pageSize);
  return {
    matches,
    totalMatches: total,
    filesScanned: files.length,
    page,
    pageSize,
    truncated: total > start + matches.length,
    source: `repo:${repo.project}`,
  };
}

/** Tra khai báo qua index — không quét lại repo mỗi lần gọi. */
export function findSymbol(
  repo: RepoContext,
  options: { name: string; kind?: string; page?: number; pageSize?: number; maxResults?: number },
): { symbols: SymbolHit[]; totalMatches: number; truncated: boolean; source: string; index: { files: number; symbols: number; fromCache: boolean } } {
  const cfg = limits();
  const maxResults = options.maxResults ?? cfg.maxResults;
  const index = symbolIndexFor(repo);

  const matches: IndexedSymbol[] = index
    .findByName(options.name, { limit: maxResults * 2 })
    .filter((symbol) => options.kind === undefined || symbol.kind === options.kind)
    .slice(0, maxResults);

  const stats = index.stats();
  return {
    symbols: matches.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      file: symbol.file,
      line: symbol.line,
      signature: symbol.signature,
      confidence: "exact",
    })),
    totalMatches: matches.length,
    truncated: matches.length >= maxResults,
    source: `repo:${repo.project} (symbol index)`,
    index: { files: stats.fileCount, symbols: stats.symbolCount, fromCache: stats.fromCache },
  };
}

/** Vị trí khai báo của symbol (dùng cho ranking usage). */
function primaryDefinition(repo: RepoContext, symbol: string, file?: string): IndexedSymbol | undefined {
  const index = symbolIndexFor(repo);
  const found = index.findByName(symbol, { limit: 20 });
  if (found.length === 0) return undefined;
  if (file !== undefined) return found.find((item) => item.file === file) ?? found[0];
  return found.find((item) => item.kind === "type") ?? found[0];
}

export function findReferences(
  repo: RepoContext,
  options: { symbol: string; include?: string[]; maxResults?: number; definitionFile?: string },
): {
  references: CodeMatch[];
  filesWithHits: number;
  truncated: boolean;
  source: string;
  definition?: { file: string; line: number };
  confidence: "heuristic";
  note: string;
} {
  const cfg = limits();
  const maxResults = options.maxResults ?? cfg.maxResults;
  const index = symbolIndexFor(repo);
  const definition = primaryDefinition(repo, options.symbol, options.definitionFile);
  const re = new RegExp(`\\b${escapeRegex(options.symbol)}\\b`);

  // pre-filter bằng hash định danh: bỏ qua file chắc chắn không chứa tên này
  const candidates = index.maybeMentions(options.symbol);
  const files = options.include ? candidates.filter((file) => matchesInclude(file, options.include as string[])) : candidates;

  const references: CodeMatch[] = [];
  let filesWithHits = 0;

  for (const file of files) {
    const lines = readLines(repo, file);
    let fileHits = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!re.test(line)) continue;
      fileHits += 1;
      if (references.length < maxResults) {
        const ranked = index.rankUsage(file, definition?.file);
        references.push({ file, line: i + 1, snippet: line.trim().slice(0, 400), confidence: ranked.confidence, reason: ranked.reason });
      }
    }
    if (fileHits > 0) filesWithHits += 1;
    if (references.length >= maxResults) break;
  }

  return {
    references: sortByRank(references),
    filesWithHits,
    truncated: references.length >= maxResults,
    source: `repo:${repo.project} (symbol index + pre-filter)`,
    ...(definition ? { definition: { file: definition.file, line: definition.line } } : {}),
    confidence: "heuristic",
    note:
      "Vị trí được xếp hạng theo khoảng cách ngữ nghĩa với khai báo (cùng file > cùng package > có import > " +
      "chỉ trùng tên). 'weak' nghĩa là chỉ trùng chuỗi — phải xác nhận trước khi kết luận impact.",
  };
}

function matchesInclude(file: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "@@").replace(/\*/g, "[^/]*").replace(/@@/g, ".*")}$`);
    if (re.test(file)) return true;
  }
  return false;
}

export function findCallers(
  repo: RepoContext,
  options: { symbol: string; maxResults?: number; definitionFile?: string },
): { callers: CodeMatch[]; confidence: "heuristic"; source: string; note: string; definition?: { file: string; line: number } } {
  const cfg = limits();
  const maxResults = options.maxResults ?? cfg.maxResults;
  const index = symbolIndexFor(repo);
  const definition = primaryDefinition(repo, options.symbol, options.definitionFile);

  // Cho phép `obj.method(` (không loại trừ dấu chấm), chỉ loại trừ khi symbol nằm trong một từ dài hơn.
  const call = new RegExp(`(?<![\\w])${escapeRegex(options.symbol)}\\s*\\(`);
  const declPatterns = declarationPatterns(".java").concat(declarationPatterns(".ts"));
  const callers: CodeMatch[] = [];

  for (const file of index.maybeMentions(options.symbol)) {
    const ext = path.extname(file).toLowerCase();
    const patterns = declarationPatterns(ext);
    const lines = readLines(repo, file);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!call.test(line)) continue;
      const isDeclaration = patterns.some((p) => p.kind !== "reference" && p.build(options.symbol).test(line));
      if (isDeclaration) continue;
      const ranked = index.rankUsage(file, definition?.file);
      callers.push({ file, line: i + 1, snippet: line.trim().slice(0, 400), confidence: ranked.confidence, reason: ranked.reason });
    }
    if (callers.length >= maxResults * 4) break;
  }
  void declPatterns;

  const ranked = sortByRank(callers).slice(0, maxResults);
  return {
    callers: ranked,
    confidence: "heuristic",
    source: `repo:${repo.project} (symbol index + ranking theo package/import)`,
    ...(definition ? { definition: { file: definition.file, line: definition.line } } : {}),
    note:
      "Call graph suy từ text search + ranking theo package/import (chưa có type resolution). " +
      "Mục 'weak' là ứng viên xa — không dùng để kết luận impact mà chưa xác nhận.",
  };
}

export function findImplementations(
  repo: RepoContext,
  options: { symbol: string; maxResults?: number },
): { implementations: CodeMatch[]; confidence: "heuristic"; source: string } {
  const cfg = limits();
  const maxResults = options.maxResults ?? cfg.maxResults;
  const re = new RegExp(`\\b(?:implements|extends)\\b[^{;]*\\b${escapeRegex(options.symbol)}\\b`);
  const index = symbolIndexFor(repo);
  const implementations: CodeMatch[] = [];

  for (const file of index.maybeMentions(options.symbol)) {
    const lines = readLines(repo, file);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!re.test(line)) continue;
      implementations.push({ file, line: i + 1, snippet: line.trim().slice(0, 400) });
      if (implementations.length >= maxResults) break;
    }
    if (implementations.length >= maxResults) break;
  }

  return { implementations, confidence: "heuristic", source: `repo:${repo.project} (symbol index)` };
}

function extractBlock(lines: string[], startIndex: number, maxLines: number): { body: string; endLine: number } {
  const out: string[] = [];
  let depth = 0;
  let opened = false;
  for (let i = startIndex; i < lines.length && out.length < maxLines; i += 1) {
    const line = lines[i] ?? "";
    out.push(line);
    for (const ch of line) {
      if (ch === "{") {
        depth += 1;
        opened = true;
      } else if (ch === "}") {
        depth -= 1;
      }
    }
    if (opened && depth <= 0) break;
    if (!opened && /;\s*$/.test(line)) break;
  }
  return { body: out.join("\n"), endLine: startIndex + out.length };
}

export function readSymbol(
  repo: RepoContext,
  options: { symbol: string; file?: string; kind?: string },
): {
  symbol: string;
  file: string;
  kind: string;
  startLine: number;
  endLine: number;
  body: string;
  truncated: boolean;
  source: string;
} {
  const cfg = limits();
  const index = symbolIndexFor(repo);
  const candidates = index
    .findByName(options.symbol, { exact: true, limit: 20 })
    .filter((item) => (options.kind === undefined ? true : item.kind === options.kind))
    .filter((item) => (options.file === undefined ? true : item.file === options.file));

  const found = candidates[0];
  if (!found) {
    throw new ToolError(
      "SYMBOL_NOT_FOUND",
      `Không tìm thấy khai báo của symbol "${options.symbol}"${options.file ? ` trong ${options.file}` : ""}.`,
      "Kiểm tra lại tên symbol qua find_symbol, hoặc dùng search_code. Không tự suy diễn nội dung symbol (INV-06).",
    );
  }

  const lines = readLines(repo, found.file);
  const { body, endLine } = extractBlock(lines, found.line - 1, cfg.maxSymbolBodyLines);
  return {
    symbol: options.symbol,
    file: found.file,
    kind: found.kind,
    startLine: found.line,
    endLine,
    body,
    truncated: endLine - found.line + 1 >= cfg.maxSymbolBodyLines,
    source: `${found.file}:${found.line}-${endLine} (symbol index)`,
  };
}

export function findSimilarCode(
  repo: RepoContext,
  options: { query: string; maxResults?: number; include?: string[] },
): {
  results: Array<{ file: string; score: number; matchedSymbols: string[]; reason: string }>;
  confidence: "heuristic";
  source: string;
} {
  const cfg = limits();
  const maxResults = options.maxResults ?? cfg.maxResults;
  const queryTokens = tokenize(options.query);
  const files = walkFiles(repo, options.include ? { include: options.include } : {});
  const scored: Array<{ file: string; score: number; matchedSymbols: string[]; reason: string }> = [];

  for (const file of files) {
    const pathScore = overlapScore(queryTokens, file);
    let text: string;
    try {
      text = readTextFile(repo, file);
    } catch {
      continue;
    }
    if (isProbablyBinary(text)) continue;
    const head = text.split(/\r?\n/).slice(0, 250).join("\n");
    const contentScore = overlapScore(queryTokens, head);
    const score = Math.round((pathScore * 0.4 + contentScore * 0.6) * 100) / 100;
    if (score <= 0) continue;
    const ext = path.extname(file).toLowerCase();
    if (!supportsDeclarations(declarationPatterns(ext))) continue;
    const matchedSymbols: string[] = [];
    for (const line of head.split(/\r?\n/)) {
      const m = /(?:class|interface|enum|record|function|type)\s+([A-Za-z_]\w*)/.exec(line);
      if (m?.[1] && !matchedSymbols.includes(m[1])) matchedSymbols.push(m[1]);
      if (matchedSymbols.length >= 5) break;
    }
    scored.push({ file, score, matchedSymbols, reason: "so khớp token giữa truy vấn và đường dẫn + 250 dòng đầu của file" });
  }

  scored.sort((a, b) => b.score - a.score);
  return { results: scored.slice(0, maxResults), confidence: "heuristic", source: `repo:${repo.project}` };
}

export function getChangeContext(
  repo: RepoContext,
  options: { file: string; symbol: string; maxResults?: number },
): Record<string, unknown> {
  const cfg = limits();
  const maxResults = options.maxResults ?? cfg.maxResults;
  const definition = readSymbol(repo, { symbol: options.symbol, file: options.file });
  const callers = findCallers(repo, { symbol: options.symbol, maxResults, definitionFile: definition.file });
  const implementations = findImplementations(repo, { symbol: options.symbol, maxResults });
  const tests = findReferences(repo, {
    symbol: options.symbol,
    include: ["**/*Test*.java", "**/*IT.java", "**/*.test.ts", "**/*.spec.ts", "**/*_test.*"],
    maxResults,
    definitionFile: definition.file,
  });

  const calleeNames = new Set<string>();
  const dbDependencies = new Set<string>();
  const policyDependencies = new Set<string>();

  const bodyLines = definition.body.split(/\r?\n/);
  for (const line of bodyLines) {
    for (const m of line.matchAll(/([A-Za-z_]\w*)\s*\(/g)) {
      const name = m[1];
      if (name && name !== options.symbol && !["if", "for", "while", "switch", "catch", "return", "new"].includes(name)) {
        calleeNames.add(name);
      }
    }
    for (const m of line.matchAll(/\b(?:from|join|into|update|insert\s+into|delete\s+from)\s+([A-Za-z_][\w.]*)/gi)) {
      if (m[1]) dbDependencies.add(m[1]);
    }
    for (const m of line.matchAll(/\b([A-Z]\w*(?:Repository|Dao|Mapper|Entity))\b/g)) {
      if (m[1]) dbDependencies.add(m[1]);
    }
    for (const m of line.matchAll(/\b([A-Z]\w*(?:Policy|Rule|Fact|Product)\w*)\b/g)) {
      if (m[1]) policyDependencies.add(m[1]);
    }
  }

  const stats = symbolIndexFor(repo).stats();
  const strongCallers = callers.callers.filter((caller) => caller.confidence !== "weak");

  return {
    symbol: options.symbol,
    file: options.file,
    definition: {
      kind: definition.kind,
      startLine: definition.startLine,
      endLine: definition.endLine,
      body: definition.body,
      truncated: definition.truncated,
      source: definition.source,
    },
    callers: callers.callers,
    strongCallers: strongCallers.length,
    implementations: implementations.implementations,
    tests: tests.references,
    dbDependencies: [...dbDependencies].slice(0, maxResults),
    policyDependencies: [...policyDependencies].slice(0, maxResults),
    callees: [...calleeNames].slice(0, maxResults),
    confidence: "heuristic",
    index: { files: stats.fileCount, symbols: stats.symbolCount, fromCache: stats.fromCache, buildMs: stats.buildMs },
    note:
      "callers/callees/dbDependencies/policyDependencies suy từ text analysis + xếp hạng theo package/import " +
      "(chưa có type resolution). Caller có confidence='weak' chỉ là trùng chuỗi — cần xác nhận.",
    source: `repo:${repo.project}`,
  };
}
