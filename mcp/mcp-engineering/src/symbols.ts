import path from "node:path";

/**
 * Trích xuất khai báo symbol từ nội dung file.
 *
 * LƯU Ý PHẠM VI (đọc kỹ trước khi tin kết quả):
 * Đây là trích xuất bằng **pattern trên dòng**, KHÔNG phải parser có type resolution.
 * Nó đủ tốt để: (a) lập index tra cứu nhanh, (b) xếp hạng caller theo package/import.
 * Nó KHÔNG đủ để kết luận chắc chắn về call graph — vì vậy mọi kết quả dựa trên index
 * đều mang `confidence` và được ghi rõ là heuristic trong output.
 *
 * Interface này là điểm cắm thay thế: khi có parser thật (JavaParser/SCIP/LSP), chỉ cần
 * thay `extractSymbols()` + `parseImports()` mà không đổi phần index/ranking ở trên.
 */
export interface ExtractedSymbol {
  name: string;
  kind: string;
  line: number;
  signature: string;
}

export interface DeclPattern {
  kind: string;
  build: (name: string) => RegExp;
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isProbablyBinary(text: string): boolean {
  return text.slice(0, 8192).includes("\u0000");
}

export function declarationPatterns(ext: string): DeclPattern[] {
  const q = escapeRegex;
  if (ext === ".java") {
    return [
      { kind: "type", build: (n) => new RegExp(`\\b(class|interface|enum|record|@interface)\\s+${q(n)}\\b`) },
      {
        kind: "method",
        build: (n) =>
          new RegExp(
            `^\\s*(?:@\\w+\\s+)*(?:public|private|protected|static|final|synchronized|abstract|default|native|strictfp|\\s)*` +
              `[\\w<>\\[\\],.\\s?]+\\s+${q(n)}\\s*\\(`,
          ),
      },
      {
        kind: "field",
        build: (n) => new RegExp(`^\\s*(?:public|private|protected|static|final|\\s)+[\\w<>\\[\\],.\\s?]+\\s+${q(n)}\\s*[;=]`),
      },
    ];
  }
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return [
      { kind: "type", build: (n) => new RegExp(`\\b(class|interface|type|enum)\\s+${q(n)}\\b`) },
      { kind: "function", build: (n) => new RegExp(`\\b(?:function|async\\s+function)\\s+${q(n)}\\b`) },
      { kind: "variable", build: (n) => new RegExp(`\\b(?:const|let|var)\\s+${q(n)}\\s*[:=]`) },
      { kind: "method", build: (n) => new RegExp(`^\\s*(?:public|private|protected|static|async|\\s)*${q(n)}\\s*\\(`) },
    ];
  }
  if (ext === ".sql") {
    return [
      { kind: "table", build: (n) => new RegExp(`\\b(?:create|alter)\\s+table\\s+${q(n)}\\b`, "i") },
      {
        kind: "procedure",
        build: (n) => new RegExp(`\\b(?:create|replace)\\s+(?:or\\s+replace\\s+)?(?:procedure|function|trigger)\\s+${q(n)}\\b`, "i"),
      },
    ];
  }
  return [{ kind: "reference", build: (n) => new RegExp(`\\b${q(n)}\\b`) }];
}

export function supportsDeclarations(patterns: DeclPattern[]): boolean {
  return !(patterns.length === 1 && patterns[0]?.kind === "reference");
}

const DECL_NAME = /(?:class|interface|enum|record|function|type)\s+([A-Za-z_]\w*)/;
const METHOD_NAME = /^\s*(?:[\w<>[\],.\s?]+)\s+([A-Za-z_]\w*)\s*\(/;

/**
 * Quét một file và trả về các khai báo.
 * Không parse cả file: chỉ dò pattern khai báo trên từng dòng (đủ cho tra cứu/ranking).
 */
export function extractSymbols(lines: string[], ext: string): ExtractedSymbol[] {
  const patterns = declarationPatterns(ext);
  if (!supportsDeclarations(patterns)) return [];
  const out: ExtractedSymbol[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;

    for (const pattern of patterns) {
      if (pattern.kind === "reference") continue;
      // dùng pattern theo tên bắt được từ chính dòng đó
      const nameMatch = pattern.kind === "method" || pattern.kind === "function" ? METHOD_NAME.exec(line) : DECL_NAME.exec(line);
      const candidate = nameMatch?.[1];
      if (!candidate) continue;
      if (!pattern.build(candidate).test(line)) continue;
      out.push({
        name: candidate,
        kind: pattern.kind,
        line: i + 1,
        signature: line.trim().slice(0, 300),
      });
      break; // một dòng chỉ tính một khai báo
    }
  }

  return out;
}

/** Package của file Java (nếu có). */
export function parsePackage(lines: string[]): string | undefined {
  for (const line of lines.slice(0, 60)) {
    const match = /^\s*package\s+([\w.]+)\s*;/.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** Danh sách import (Java `import a.b.C;`, TS `import ... from "x"`). */
export function parseImports(lines: string[], ext: string): string[] {
  const out: string[] = [];
  for (const line of lines.slice(0, 200)) {
    if (ext === ".java") {
      const match = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/.exec(line);
      if (match?.[1]) out.push(match[1]);
      continue;
    }
    const match = /^\s*import\s+.*?from\s+["']([^"']+)["']/.exec(line);
    if (match?.[1]) out.push(match[1]);
  }
  return out;
}

/** Tên class/type mà file này cung cấp (suy từ tên file — dùng để xếp hạng caller). */
export function ownerTypeOf(file: string): string {
  return path.basename(file).replace(/\.[^.]+$/, "");
}
