import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { OS_ROOT, osPath } from "../paths.js";

export interface SkillMeta {
  name: string;
  description: string;
  phase?: string[];
  roles?: string[];
  triggers?: string[];
  /** Skill bắt buộc cho role/phase khớp — được chọn TRƯỚC khi chia slot theo điểm. */
  required?: boolean;
  /** Ưu tiên khi cùng điểm (số lớn hơn trước). */
  priority?: number;
}

export interface Skill extends SkillMeta {
  /** Đường dẫn tương đối từ skills/ (ví dụ engineering/tdd/SKILL.md). */
  file: string;
  /** Nhóm: meta | engineering | domain | router */
  group: string;
  body: string;
}

export type SkillIssueCode =
  | "MISSING_FRONT_MATTER"
  | "MISSING_FIELD"
  | "NAME_MISMATCH"
  | "DESCRIPTION_SUMMARIZES_WORKFLOW"
  | "DESCRIPTION_NOT_WHEN"
  | "MISSING_SECTIONS"
  | "TOO_LONG";

export interface SkillIssue {
  file: string;
  code: SkillIssueCode;
  message: string;
}

export interface SkillCatalog {
  skills: Skill[];
  issues: SkillIssue[];
  root: string;
}

export function skillsRoot(): string {
  return osPath("skills");
}

const REQUIRED_SECTIONS = ["## WHEN", "## DO", "## MUST OUTPUT", "## MUST NOT"];
const MAX_SKILL_LINES = 300; // INV-09

/** Tách front-matter YAML khỏi phần thân markdown. */
export function splitFrontMatter(markdown: string): { meta: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { meta: {}, body: markdown };
  const parsed = parseYaml(match[1] ?? "");
  return {
    meta: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {},
    body: markdown.slice(match[0].length),
  };
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string" && value !== "") return [value];
  return undefined;
}

function findSkillFiles(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    const abs = rel === "" ? dir : path.join(dir, rel);
    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }> = [];
    try {
      entries = readdirSync(abs, { withFileTypes: true }).map((entry) => ({
        name: String(entry.name),
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory) stack.push(childRel);
      else if (entry.isFile && entry.name === "SKILL.md") out.push(childRel);
    }
  }
  return out.sort();
}

/**
 * Đọc + kiểm tra skill catalog (spec mục 6.2).
 *
 * Luật kiểm tra có chủ đích — rút từ chính spec:
 * - `description` chỉ nêu WHEN. Nếu mô tả cả workflow, agent sẽ đi theo description
 *   thay vì đọc skill → lỗi DESCRIPTION_SUMMARIZES_WORKFLOW.
 * - phải có đủ 4 section WHEN/DO/MUST OUTPUT/MUST NOT.
 * - thân skill < 300 dòng (INV-09).
 */
export function loadSkills(root: string = skillsRoot(), options: { includeRouter?: boolean } = {}): SkillCatalog {
  const skills: Skill[] = [];
  const issues: SkillIssue[] = [];
  const seen = new Map<string, string>();

  for (const rel of findSkillFiles(root)) {
    const group = rel.split("/")[0] ?? "";
    if (group === "router" && options.includeRouter !== true) continue;

    let markdown: string;
    try {
      markdown = readFileSync(path.join(root, rel), "utf8");
    } catch {
      continue;
    }

    const { meta, body } = splitFrontMatter(markdown);
    const name = typeof meta["name"] === "string" ? meta["name"] : "";
    const description = typeof meta["description"] === "string" ? meta["description"] : "";

    if (Object.keys(meta).length === 0) {
      issues.push({ file: rel, code: "MISSING_FRONT_MATTER", message: "Thiếu YAML front-matter." });
      continue;
    }
    if (name === "" || description === "") {
      issues.push({ file: rel, code: "MISSING_FIELD", message: "Front-matter phải có `name` và `description`." });
      continue;
    }

    const dirName = rel.split("/").slice(-2)[0] ?? "";
    if (dirName !== name) {
      issues.push({
        file: rel,
        code: "NAME_MISMATCH",
        message: `name="${name}" không khớp tên thư mục "${dirName}".`,
      });
    }
    if (seen.has(name)) {
      issues.push({ file: rel, code: "NAME_MISMATCH", message: `name="${name}" trùng với ${seen.get(name)}.` });
    }
    seen.set(name, rel);

    if (!/^use when/i.test(description.trim())) {
      issues.push({
        file: rel,
        code: "DESCRIPTION_NOT_WHEN",
        message: "description phải bắt đầu bằng 'Use when ...' (chỉ nêu điều kiện kích hoạt).",
      });
    }
    if (/\b(then|first,|step \d|→|->)\b/i.test(description)) {
      issues.push({
        file: rel,
        code: "DESCRIPTION_SUMMARIZES_WORKFLOW",
        message: "description có vẻ mô tả workflow — chỉ nêu WHEN, không nêu HOW.",
      });
    }

    const missing = REQUIRED_SECTIONS.filter((section) => !body.includes(section));
    if (missing.length > 0) {
      issues.push({ file: rel, code: "MISSING_SECTIONS", message: `Thiếu section: ${missing.join(", ")}` });
    }

    const lines = body.split(/\r?\n/).length;
    if (lines > MAX_SKILL_LINES) {
      issues.push({ file: rel, code: "TOO_LONG", message: `Skill dài ${lines} dòng (> ${MAX_SKILL_LINES}, INV-09).` });
    }

    const skill: Skill = { name, description, file: rel, group, body: body.trim() };
    const phase = asStringArray(meta["phase"]);
    const roles = asStringArray(meta["roles"]);
    const triggers = asStringArray(meta["triggers"]);
    if (phase) skill.phase = phase;
    if (roles) skill.roles = roles;
    if (triggers) skill.triggers = triggers;
    if (meta["required"] === true) skill.required = true;
    const priority = Number(meta["priority"]);
    if (Number.isFinite(priority)) skill.priority = priority;
    skills.push(skill);
  }

  return { skills, issues, root };
}

export function estimateSkillTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function skillBodyPath(skill: Skill): string {
  return path.join(OS_ROOT, "skills", skill.file);
}
