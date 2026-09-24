import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { EngError } from "../errors.js";
import { workstreamDir } from "../workspace.js";

export interface LockInfo {
  pid: number;
  at: string;
  command?: string;
  host?: string;
  /**
   * Token của "cây tiến trình" đang giữ lock. Tiến trình con (harness, MCP server) được
   * kế thừa qua env ENG_WORKSTREAM_LOCK_TOKEN nên ghi được vào cùng workstream mà không
   * tự khoá lẫn nhau — chúng là một phần của CÙNG một thao tác logic.
   */
  token?: string;
}

export interface LockHandle {
  taskId: string;
  path: string;
  /** Số lần vào lock trong cùng process (reentrant). */
  depth: number;
  /** Lock thuộc về tiến trình khác nhưng cùng token ⇒ không được unlink khi nhả. */
  borrowed?: boolean;
}

const DEFAULT_STALE_MS = 30 * 60 * 1000; // 30 phút

/** Lock đang giữ trong process này (reentrant) — tránh tự deadlock khi phase gọi store. */
const held = new Map<string, { handle: LockHandle; info: LockInfo }>();

function lockPath(taskId: string, root?: string): string {
  return path.join(workstreamDir(taskId, root), ".lock");
}

function readLock(file: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

/** Process còn sống? `kill(pid, 0)` chỉ kiểm tra sự tồn tại, không gửi signal. */
function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // tồn tại nhưng không có quyền
  }
}

export function isStale(info: LockInfo, staleMs = DEFAULT_STALE_MS): boolean {
  if (!isAlive(info.pid)) return true;
  const age = Date.now() - new Date(info.at).getTime();
  return Number.isFinite(age) && age > staleMs;
}

export function lockStatus(taskId: string, options: { root?: string } = {}): { path: string; info: LockInfo | null; heldByThisProcess: boolean; stale: boolean } {
  const file = lockPath(taskId, options.root);
  const info = existsSync(file) ? readLock(file) : null;
  return {
    path: file,
    info,
    heldByThisProcess: held.has(taskId),
    stale: info !== null && isStale(info),
  };
}

/**
 * Khoá workstream để tránh hai tiến trình ghi state/plan/evidence cùng lúc.
 *
 * - Atomic: tạo file bằng cờ `wx` (chỉ một tiến trình thắng).
 * - Reentrant trong cùng process: phase giữ lock dài, store bên trong lấy lại lock ngắn.
 * - Lock cũ (process chết hoặc quá `staleMs`) được thu hồi kèm cảnh báo.
 */
export function acquireLock(
  taskId: string,
  options: { root?: string; command?: string; staleMs?: number; token?: string } = {},
): LockHandle {
  const existing = held.get(taskId);
  if (existing) {
    existing.handle.depth += 1;
    return existing.handle;
  }

  const file = lockPath(taskId, options.root);
  const token = options.token ?? process.env["ENG_WORKSTREAM_LOCK_TOKEN"];
  const info: LockInfo = {
    pid: process.pid,
    at: new Date().toISOString(),
    host: process.env["HOSTNAME"] ?? "",
    ...(options.command ? { command: options.command } : {}),
    ...(token ? { token } : {}),
  };

  // Tiến trình con trong cùng cây thao tác: lock đang giữ bởi chính token của mình ⇒
  // đi tiếp mà KHÔNG tạo/unlink file lock (không phải chủ sở hữu).
  if (token !== undefined && existsSync(file)) {
    const current = readLock(file);
    if (current?.token === token) {
      const borrowed: LockHandle = { taskId, path: file, depth: 1, borrowed: true };
      held.set(taskId, { handle: borrowed, info: current });
      return borrowed;
    }
  }

  const attempt = (): boolean => {
    try {
      const fd = openSync(file, "wx");
      try {
        writeSync(fd, `${JSON.stringify(info, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new EngError("LOCK_FAILED", `Không tạo được lock cho ${taskId}: ${String(error)}`);
      }
      return false;
    }
  };

  if (!attempt()) {
    const current = readLock(file);
    const currentInfo: LockInfo = current ?? { pid: -1, at: new Date(0).toISOString() };
    if (isStale(currentInfo, options.staleMs ?? DEFAULT_STALE_MS)) {
      process.stderr.write(
        `⚠ lock cũ của ${taskId} (pid ${currentInfo.pid}, lúc ${currentInfo.at}) — thu hồi và tiếp tục\n`,
      );
      try {
        unlinkSync(file);
      } catch {
        // người khác vừa thu hồi
      }
      if (!attempt()) {
        throw new EngError("WORKSTREAM_LOCKED", `Workstream ${taskId} đang bị khoá bởi tiến trình khác.`, {
          hint: `Xem: eng lock ${taskId} · thu hồi: eng lock ${taskId} --release`,
        });
      }
    } else {
      throw new EngError("WORKSTREAM_LOCKED", `Workstream ${taskId} đang được dùng bởi pid ${currentInfo.pid}.`, {
        hint:
          `Chờ tiến trình kia xong, hoặc nếu chắc chắn nó đã chết: eng lock ${taskId} --release. ` +
          `Không chạy hai lệnh ghi trên cùng ticket cùng lúc.`,
        details: { holder: currentInfo },
      });
    }
  }

  const handle: LockHandle = { taskId, path: file, depth: 1 };
  held.set(taskId, { handle, info });
  return handle;
}

export function releaseLock(taskId: string): boolean {
  const entry = held.get(taskId);
  if (!entry) return false;
  entry.handle.depth -= 1;
  if (entry.handle.depth > 0) return false;
  held.delete(taskId);
  if (entry.handle.borrowed === true) return true; // của tiến trình cha — không xoá
  try {
    unlinkSync(entry.handle.path);
  } catch {
    // đã bị thu hồi
  }
  return true;
}

/** Thu hồi lock không quan tâm ai giữ (dùng cho `eng lock <TASK_ID> --release`). */
export function forceReleaseLock(taskId: string, options: { root?: string } = {}): boolean {
  const file = lockPath(taskId, options.root);
  held.delete(taskId);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

/** Chạy `fn` dưới lock; tự nhả khi xong (kể cả khi ném lỗi). */
export function withLock<T>(taskId: string, fn: () => T, options: { root?: string; command?: string } = {}): T {
  acquireLock(taskId, options);
  try {
    return fn();
  } finally {
    releaseLock(taskId);
  }
}

/** Thông tin lock để báo lỗi/hiển thị. */
export function describeLock(taskId: string, options: { root?: string } = {}): string {
  const status = lockStatus(taskId, options);
  if (status.info === null) return `${taskId}: không có lock`;
  return `${taskId}: pid ${status.info.pid} lúc ${status.info.at}${status.info.command ? ` (${status.info.command})` : ""}${status.stale ? " [STALE]" : ""}`;
}

export function lockAgeMs(taskId: string, options: { root?: string } = {}): number | null {
  const status = lockStatus(taskId, options);
  if (status.info === null) return null;
  try {
    return Date.now() - statSync(status.path).mtimeMs;
  } catch {
    return null;
  }
}
