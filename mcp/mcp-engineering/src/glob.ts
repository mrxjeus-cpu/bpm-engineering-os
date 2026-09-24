/**
 * Glob tối giản: `*` (trong 1 segment), `**` (xuyên directory), `?`.
 * Đủ cho include/exclude trong config/mcp.yaml, không cần dependency ngoài.
 */
function escapeRegexChar(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch === "*") {
      const next = pattern.charAt(i + 1);
      if (next === "*") {
        const after = pattern.charAt(i + 2);
        if (after === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += escapeRegexChar(ch);
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

const cache = new Map<string, RegExp>();

export function matchesAny(relPath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    let re = cache.get(pattern);
    if (!re) {
      re = globToRegExp(pattern);
      cache.set(pattern, re);
    }
    if (re.test(relPath)) return true;
  }
  return false;
}

/** Tách tiếng Việt/tiếng Anh thành token để chấm điểm tương đồng (find_similar_*). */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_\u00c0-\u024f]+/u)
    .flatMap((token) => token.split("_"))
    .filter((token) => token.length > 1);
}

export function overlapScore(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) return 0;
  const haystack = new Set(tokenize(text));
  let hits = 0;
  for (const token of queryTokens) if (haystack.has(token)) hits += 1;
  return hits / queryTokens.length;
}
