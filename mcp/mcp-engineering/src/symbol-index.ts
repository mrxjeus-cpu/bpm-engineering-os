import path from "node:path";
import { type RepoContext, headSha, readTextFile, walkFiles } from "./repo.js";
import { type ExtractedSymbol, extractSymbols, isProbablyBinary, ownerTypeOf, parseImports, parsePackage } from "./symbols.js";

export interface IndexedSymbol {
  name: string;
  kind: string;
  file: string;
  line: number;
  signature: string;
  owner: string;
  package?: string;
}

export interface FileIndex {
  file: string;
  ext: string;
  owner: string;
  package?: string;
  imports: string[];
  /** Khai báo trong file (dạng thô — owner/package nằm ở chính FileIndex). */
  symbols: ExtractedSymbol[];
  /** Hash 32-bit của các định danh trong file — pre-filter rẻ để khỏi đọc mọi file khi tìm usage. */
  tokenHashes: number[];
}

export interface SymbolIndexData {
  repoRoot: string;
  gitSha: string;
  builtAt: string;
  durationMs: number;
  fileCount: number;
  symbolCount: number;
  truncated: boolean;
  byFile: Map<string, FileIndex>;
  byName: Map<string, IndexedSymbol[]>;
}

export interface IndexStats {
  repoRoot: string;
  gitSha: string;
  builtAt: string;
  ageMs: number;
  fileCount: number;
  symbolCount: number;
  buildMs: number;
  /** Lần gọi NÀY có dùng lại index đã dựng không (không phải "đã từng có cache"). */
  fromCache: boolean;
  ttlMs: number;
  truncated: boolean;
}

const MAX_FILE_HASHES = 512;
const IDENT_RE = /[A-Za-z_]\w{2,}/g;

/** FNV-1a 32-bit — đủ để pre-filter, va chạm chỉ gây đọc thừa file (không sai kết quả). */
function hashToken(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function tokenHashesOf(text: string): number[] {
  const seen = new Set<number>();
  for (const match of text.matchAll(IDENT_RE)) {
    seen.add(hashToken(match[0]));
    if (seen.size >= MAX_FILE_HASHES) break;
  }
  return [...seen];
}

function buildIndex(repo: RepoContext, maxFiles: number): SymbolIndexData {
  const started = Date.now();
  const byFile = new Map<string, FileIndex>();
  const byName = new Map<string, IndexedSymbol[]>();
  const files = walkFiles(repo);
  let truncated = false;

  for (const file of files) {
    if (byFile.size >= maxFiles) {
      truncated = true;
      break;
    }
    let text: string;
    try {
      text = readTextFile(repo, file);
    } catch {
      continue;
    }
    if (isProbablyBinary(text)) continue;

    const ext = path.extname(file).toLowerCase();
    const lines = text.split(/\r?\n/);
    const owner = ownerTypeOf(file);
    const pkg = ext === ".java" ? parsePackage(lines) : undefined;
    const imports = parseImports(lines, ext);
    const symbols = extractSymbols(lines, ext);

    if (symbols.length === 0 && imports.length === 0) continue; // file không mang thông tin symbol

    const entry: FileIndex = {
      file,
      ext,
      owner,
      imports,
      symbols,
      tokenHashes: tokenHashesOf(text),
      ...(pkg ? { package: pkg } : {}),
    };

    for (const symbol of symbols) {
      const indexed: IndexedSymbol = {
        name: symbol.name,
        kind: symbol.kind,
        file,
        line: symbol.line,
        signature: symbol.signature,
        owner,
        ...(pkg ? { package: pkg } : {}),
      };
      const list = byName.get(symbol.name);
      if (list) list.push(indexed);
      else byName.set(symbol.name, [indexed]);
    }

    byFile.set(file, entry);
  }

  return {
    repoRoot: repo.root,
    gitSha: headSha(repo),
    builtAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    fileCount: byFile.size,
    symbolCount: [...byName.values()].reduce((sum, list) => sum + list.length, 0),
    truncated,
    byFile,
    byName,
  };
}

/**
 * Symbol index của một repo.
 *
 * Phạm vi (nói rõ để không bị hiểu quá): khai báo được trích bằng pattern trên dòng
 * (xem `symbols.ts`), KHÔNG phải type resolution. Giá trị thật của index:
 *  1. tra khai báo không cần quét lại repo (nhanh hơn nhiều lần);
 *  2. pre-filter theo hash định danh trước khi đọc file ⇒ tìm usage rẻ hơn;
 *  3. biết package/import của từng file ⇒ XẾP HẠNG caller (cùng file > cùng package >
 *     có import > chỉ trùng tên) thay vì trả về mọi file chứa chuỗi đó.
 *
 * Cache: theo repo + TTL. Index được dựng lại khi quá `ttlMs` hoặc khi HEAD đổi.
 * (`ttlMs = 0` ⇒ luôn dựng lại — dùng cho test.)
 */
export class SymbolIndex {
  readonly #repo: RepoContext;
  readonly #ttlMs: number;
  readonly #maxFiles: number;
  #data?: SymbolIndexData;

  constructor(repo: RepoContext, options: { ttlMs?: number; maxFiles?: number } = {}) {
    this.#repo = repo;
    this.#ttlMs = options.ttlMs ?? Number(process.env["ENG_INDEX_TTL_MS"] ?? 30_000);
    this.#maxFiles = options.maxFiles ?? 20_000;
  }

  get repo(): RepoContext {
    return this.#repo;
  }

  #ensure(options: { force?: boolean } = {}): { data: SymbolIndexData; reused: boolean } {
    const reusable = this.#data !== undefined && options.force !== true && !this.#isStale();
    if (reusable) return { data: this.#data as SymbolIndexData, reused: true };
    this.#data = buildIndex(this.#repo, this.#maxFiles);
    return { data: this.#data, reused: false };
  }

  get(options: { force?: boolean } = {}): SymbolIndexData {
    return this.#ensure(options).data;
  }

  stats(options: { force?: boolean } = {}): IndexStats {
    const { data, reused } = this.#ensure(options);
    return {
      repoRoot: data.repoRoot,
      gitSha: data.gitSha,
      builtAt: data.builtAt,
      ageMs: reused ? Date.now() - new Date(data.builtAt).getTime() : 0,
      fileCount: data.fileCount,
      symbolCount: data.symbolCount,
      buildMs: data.durationMs,
      fromCache: reused,
      ttlMs: this.#ttlMs,
      truncated: data.truncated,
    };
  }

  invalidate(): void {
    this.#data = undefined;
  }

  #isStale(): boolean {
    if (this.#data === undefined) return true;
    if (this.#ttlMs <= 0) return true;
    if (Date.now() - new Date(this.#data.builtAt).getTime() > this.#ttlMs) return true;
    return headSha(this.#repo) !== this.#data.gitSha;
  }

  /** Khai báo theo tên (exact trước, rồi khớp không phân biệt hoa thường). */
  findByName(name: string, options: { exact?: boolean; limit?: number } = {}): IndexedSymbol[] {
    const data = this.get();
    const exact = data.byName.get(name) ?? [];
    if (exact.length > 0 || options.exact === true) return exact.slice(0, options.limit ?? 50);
    const lower = name.toLowerCase();
    const loose: IndexedSymbol[] = [];
    for (const [key, list] of data.byName) {
      if (key.toLowerCase() === lower) loose.push(...list);
      if (loose.length >= (options.limit ?? 50)) break;
    }
    return loose.slice(0, options.limit ?? 50);
  }

  fileIndex(file: string): FileIndex | undefined {
    return this.get().byFile.get(file);
  }

  /**
   * File nào CÓ THỂ chứa tên symbol (pre-filter bằng hash).
   * Có thể dương tính giả (va chạm hash) — nơi gọi vẫn phải xác nhận bằng nội dung thật.
   */
  maybeMentions(name: string): string[] {
    const hash = hashToken(name);
    const out: string[] = [];
    for (const entry of this.get().byFile.values()) {
      if (entry.tokenHashes.includes(hash)) out.push(entry.file);
    }
    return out;
  }

  /** Xếp hạng một vị trí usage so với nơi khai báo: càng nhỏ càng gần nghĩa. */
  rankUsage(usageFile: string, definitionFile?: string): { rank: number; confidence: "exact" | "likely" | "weak"; reason: string } {
    const usage = this.get().byFile.get(usageFile);
    const definition = definitionFile ? this.get().byFile.get(definitionFile) : undefined;

    if (definitionFile !== undefined && usageFile === definitionFile) {
      return { rank: 0, confidence: "exact", reason: "cùng file với khai báo" };
    }
    if (definition?.package && usage?.package && definition.package === usage.package) {
      return { rank: 1, confidence: "likely", reason: `cùng package ${usage.package}` };
    }
    if (definition) {
      const importsOwner = usage?.imports.some(
        (imp) => imp === definition.owner || imp.endsWith(`.${definition.owner}`) || (definition.package ? imp === `${definition.package}.*` : false),
      );
      if (importsOwner === true) {
        return { rank: 2, confidence: "likely", reason: `có import ${definition.owner}` };
      }
    }
    return { rank: 3, confidence: "weak", reason: "chỉ trùng tên (text search): cần xác nhận" };
  }
}

const cache = new Map<string, SymbolIndex>();

/** Một SymbolIndex dùng chung cho mỗi repo (MCP server là tiến trình dài sống). */
export function symbolIndexFor(repo: RepoContext, options: { ttlMs?: number } = {}): SymbolIndex {
  const existing = cache.get(repo.root);
  if (existing) return existing;
  const created = new SymbolIndex(repo, options);
  cache.set(repo.root, created);
  return created;
}

export function resetSymbolIndexCache(): void {
  cache.clear();
}

export function indexRelativePath(repo: RepoContext): string {
  return path.join(repo.root, ".engineering", "index");
}
