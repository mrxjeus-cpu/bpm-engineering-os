/** Tách token để chấm điểm tương đồng cho find_similar_* (không cần embedding ở Phase 1). */
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
