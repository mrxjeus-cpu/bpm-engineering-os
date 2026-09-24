import { tokenize } from "../text.js";
import { estimateSkillTokens, loadSkills, type Skill, type SkillCatalog } from "./loader.js";

export interface SkillSelection {
  skill: Skill;
  score: number;
  reasons: string[];
  /** Skill khai báo `required: true` VÀ khớp role/phase của lần chọn này. */
  requiredForMatch?: boolean;
}

export interface RouteInput {
  role: string;
  /** Phase suy từ status task (translate/requirements/impact/architecture/planning/implementation/review/audit/verification). */
  phase?: string;
  objective?: string;
  /** Từ khoá thêm (ví dụ từ failures gần đây, hoặc task metadata). */
  triggers?: string[];
  maxSkills?: number;
  maxTokens?: number;
}

export interface RouteResult {
  selected: SkillSelection[];
  skipped: string[];
  tokens: number;
  truncated: boolean;
  /** Có skill BẮT BUỘC không nhét được vào budget ⇒ prompt thiếu luật bắt buộc. */
  requiredDropped: string[];
  /** Bị cắt vì hết TOKEN (không phải vì hết slot). */
  tokenLimited: boolean;
  catalog: SkillCatalog;
}

const DEFAULT_MAX_SKILLS = 4;
const DEFAULT_MAX_TOKENS = 1200;

function overlapScore(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) return 0;
  const haystack = new Set(tokenize(text));
  let hits = 0;
  for (const token of queryTokens) if (haystack.has(token)) hits += 1;
  return hits / queryTokens.length;
}

/**
 * Skill router (spec mục 6.2 · progressive disclosure).
 *
 * Điểm số dựa trên dữ liệu khai báo trong front-matter của skill (không đoán mò):
 *   +3 role khớp · +3 phase khớp · +2 mỗi trigger khớp · +1 khi WHEN gần với objective.
 * Sau đó cắt theo `maxSkills` và `maxTokens` để không làm phình prompt.
 */
export function routeSkills(input: RouteInput, catalog?: SkillCatalog): RouteResult {
  const resolved = catalog ?? loadSkills();
  const maxSkills = input.maxSkills ?? DEFAULT_MAX_SKILLS;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;

  const text = [input.objective ?? "", ...(input.triggers ?? [])].join(" \n");
  const textTokens = tokenize(text);

  const scored: SkillSelection[] = [];
  const skipped: string[] = [];

  for (const skill of resolved.skills) {
    if (skill.group === "router") continue;
    let score = 0;
    const reasons: string[] = [];
    let roleMatched = false;
    let phaseMatched = false;

    if (skill.roles && skill.roles.includes(input.role)) {
      score += 3;
      roleMatched = true;
      reasons.push(`role=${input.role}`);
    }
    if (input.phase && skill.phase && skill.phase.includes(input.phase)) {
      score += 3;
      phaseMatched = true;
      reasons.push(`phase=${input.phase}`);
    }
    const triggerHits = (skill.triggers ?? []).filter((trigger) => text.toLowerCase().includes(trigger.toLowerCase()));
    if (triggerHits.length > 0) {
      score += Math.min(4, triggerHits.length * 2);
      reasons.push(`trigger=${triggerHits.join(",")}`);
    }

    // Tín hiệu yếu chỉ CỘNG THÊM khi skill đã khớp role/phase/trigger.
    // Nếu không, skill của role khác sẽ lọt vào prompt chỉ vì trùng vài từ với objective.
    if (score > 0 && overlapScore(textTokens, `${skill.description} ${skill.body}`) >= 0.3) {
      score += 1;
      reasons.push("when~objective");
    }

    if (score <= 0) {
      skipped.push(skill.name);
      continue;
    }

    // `required` chỉ có nghĩa với role/phase mà chính skill khai báo.
    const entry: SkillSelection = { skill, score, reasons };
    if (skill.required === true && (roleMatched || phaseMatched)) entry.requiredForMatch = true;
    scored.push(entry);
  }

  const byName = (a: SkillSelection, b: SkillSelection): number => a.skill.name.localeCompare(b.skill.name);
  const byPriority = (a: SkillSelection, b: SkillSelection): number =>
    (b.skill.priority ?? 0) - (a.skill.priority ?? 0) || b.score - a.score || byName(a, b);
  const byScore = (a: SkillSelection, b: SkillSelection): number =>
    b.score - a.score || (b.skill.priority ?? 0) - (a.skill.priority ?? 0) || byName(a, b);

  // Skill `required: true` được chọn trước (luật bắt buộc không bị skill phụ đẩy ra khỏi prompt).
  const required = scored.filter((entry) => entry.requiredForMatch === true).sort(byPriority);
  const optional = scored.filter((entry) => entry.requiredForMatch !== true).sort(byScore);

  const selected: SkillSelection[] = [];
  const requiredDropped: string[] = [];
  let tokens = 0;
  let truncated = false;
  let tokenLimited = false;

  for (const entry of [...required, ...optional]) {
    const cost = estimateSkillTokens(entry.skill.body);
    const isRequired = entry.requiredForMatch === true;
    if (selected.length >= maxSkills) {
      truncated = true;
      if (isRequired) requiredDropped.push(entry.skill.name);
      continue;
    }
    if (tokens + cost > maxTokens) {
      truncated = true;
      tokenLimited = true;
      if (isRequired) requiredDropped.push(entry.skill.name);
      continue;
    }
    selected.push(entry);
    tokens += cost;
  }

  return { selected, skipped, tokens, truncated, requiredDropped, tokenLimited, catalog: resolved };
}

/** Render phần SKILLS của prompt contract (HOW) — chỉ nội dung, không lặp phần WHEN. */
export function renderSkillsSection(selected: SkillSelection[]): string {
  if (selected.length === 0) return "";
  const lines: string[] = [];
  for (const entry of selected) {
    lines.push(`--- SKILL: ${entry.skill.name} (${entry.skill.file}) ---`);
    lines.push(`Kích hoạt vì: ${entry.reasons.join(" · ")}`);
    lines.push(entry.skill.body.trim());
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function skillCatalogSummary(catalog: SkillCatalog): Record<string, unknown> {
  const byGroup: Record<string, string[]> = {};
  for (const skill of catalog.skills) {
    byGroup[skill.group] ??= [];
    (byGroup[skill.group] as string[]).push(skill.name);
  }
  return {
    root: catalog.root,
    total: catalog.skills.length,
    byGroup,
    issues: catalog.issues,
    valid: catalog.issues.length === 0,
  };
}
