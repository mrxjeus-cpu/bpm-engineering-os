import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { workstreamRoot } from "./config/index.js";
import { EngError } from "./errors.js";

export const TASK_ID_RE = /^[A-Z][A-Z0-9]+-[0-9]+$/;

/**
 * Ghép đường dẫn TƯƠNG ĐỐI trong workstream — luôn dùng "/" bất kể nền tảng.
 *
 * Vì sao không dùng path.join: các giá trị này đi vào JSON/markdown (prompt, evidence.artifact,
 * changes.json, resume) và được so với `listFilesRecursive()` (vốn dùng "/"). Trên Windows,
 * path.join sinh "\\" nên mọi so sánh kiểu files.includes("context/TASK-01.md") sẽ trượt.
 * Truy cập filesystem vẫn dùng path.join(dir, relPath(...)) — Node chấp nhận "/" trên Windows.
 */
export function relPath(...segments: string[]): string {
  return segments
    .filter((segment) => segment !== "")
    .join("/")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
}

export function assertTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) {
    throw new EngError("INVALID_TASK_ID", `taskId không hợp lệ: "${taskId}"`, {
      hint: "Định dạng yêu cầu: <PREFIX>-<số>, ví dụ TASK-49043.",
    });
  }
}

export function workstreamDir(taskId: string, root?: string): string {
  assertTaskId(taskId);
  return path.join(root ?? workstreamRoot(), taskId);
}

const SUBDIRS = ["tasks", "context", "evidence", "reviews"] as const;

export function ensureWorkstream(taskId: string, root?: string): string {
  const dir = workstreamDir(taskId, root);
  mkdirSync(dir, { recursive: true });
  for (const sub of SUBDIRS) mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

export function listWorkstreams(root?: string): string[] {
  const dir = root ?? workstreamRoot();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && TASK_ID_RE.test(String(entry.name)))
    .map((entry) => String(entry.name))
    .sort();
}

/** Ghi file kiểu atomic: ghi .tmp rồi rename, để state không bị hỏng khi process chết giữa chừng. */
export function atomicWrite(absPath: string, content: string): void {
  mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, absPath);
}

export function readJsonFile<T>(absPath: string): T | null {
  if (!existsSync(absPath)) return null;
  try {
    return JSON.parse(readFileSync(absPath, "utf8")) as T;
  } catch (error) {
    throw new EngError("JSON_CORRUPT", `File ${absPath} không parse được: ${String(error)}`, {
      hint: "Sửa file hoặc tạo lại workstream.",
    });
  }
}

export function readTextFileIfExists(absPath: string): string | null {
  return existsSync(absPath) ? readFileSync(absPath, "utf8") : null;
}

/** Liệt kê file tương đối trong một thư mục (đệ quy), dùng cho báo cáo resume. */
export function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    const abs = rel === "" ? dir : path.join(dir, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === "" ? String(entry.name) : `${rel}/${String(entry.name)}`;
      if (entry.isDirectory()) stack.push(childRel);
      else out.push(childRel);
    }
  }
  return out.sort();
}
