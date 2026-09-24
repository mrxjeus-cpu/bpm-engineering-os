/**
 * Adapter mỏng: MCP tool ↔ runtime core.
 *
 * State/evidence/event là của runtime (spec mục 17) — MCP chỉ phơi ra thành tool.
 * Nhờ vậy chỉ có MỘT nguồn sự thật cho state machine, evidence gate và event log.
 */
import {
  EvidenceStore,
  EventBus,
  StateStore,
  ensureWorkstream as runtimeEnsureWorkstream,
  listFilesRecursive,
  readTextFileIfExists,
  workstreamDir as runtimeWorkstreamDir,
} from "@bpm/engineering-os-runtime";
import type { Evidence, NewEvidence, TaskStatus } from "@bpm/engineering-os-runtime";
import path from "node:path";
import { headSha, resolveRepo } from "./repo.js";

export const stateStore = new StateStore();
export const evidenceStore: EvidenceStore = stateStore.evidence;
export const bus: EventBus = stateStore.bus;

export function workstreamDir(taskId: string): string {
  return runtimeWorkstreamDir(taskId);
}

export function ensureWorkstream(taskId: string): string {
  return runtimeEnsureWorkstream(taskId);
}

export function listWorkstreamFiles(taskId: string): string[] {
  return listFilesRecursive(runtimeWorkstreamDir(taskId));
}

export function readWorkstreamText(taskId: string, relPath: string): string | null {
  return readTextFileIfExists(path.join(runtimeWorkstreamDir(taskId), relPath));
}

export function getTaskState(taskId: string): Record<string, unknown> | null {
  return stateStore.get(taskId) as unknown as Record<string, unknown> | null;
}

export interface UpdateStateOptions {
  expectedStatus?: string;
  evidenceRef?: string;
  by?: string;
  reason?: string;
}

/**
 * `update_task_state`:
 * - task chưa tồn tại ⇒ tạo mới (bootstrap) — dùng khi import ticket đang làm dở;
 * - patch có `status` trên task đã tồn tại ⇒ đi qua transition() (evidence gate + human gate);
 * - còn lại ⇒ patch metadata (không được sửa status/phase/history/evidence trực tiếp).
 */
export function updateTaskState(
  taskId: string,
  patch: Record<string, unknown>,
  options: UpdateStateOptions = {},
): Record<string, unknown> {
  const existing = stateStore.get(taskId);
  const status = patch["status"];

  if (typeof status === "string") {
    const { status: _status, ...rest } = patch;
    if (!existing) {
      return stateStore.create({
        taskId,
        ...(rest as { title?: string }),
        status: status as TaskStatus,
        by: options.by ?? "mcp:mcp-engineering",
        reason: options.reason ?? "bootstrap qua MCP tool",
      }) as unknown as Record<string, unknown>;
    }
    return stateStore.transition(taskId, status as TaskStatus, {
      ...(options.expectedStatus ? { expect: options.expectedStatus as TaskStatus } : {}),
      ...(options.evidenceRef ? { evidenceRef: options.evidenceRef } : {}),
      ...(options.by ? { by: options.by } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    }) as unknown as Record<string, unknown>;
  }

  if (!existing) {
    return stateStore.create({
      taskId,
      ...(patch as { title?: string }),
      by: options.by ?? "mcp:mcp-engineering",
      reason: options.reason ?? "bootstrap qua MCP tool",
    }) as unknown as Record<string, unknown>;
  }

  return stateStore.patch(taskId, patch, {
    ...(options.by ? { by: options.by } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
  }) as unknown as Record<string, unknown>;
}

/** Giữ API cũ cho tool: tự bổ sung gitSha từ repo khi caller không truyền (INV-12). */
export function recordEvidence(
  taskId: string,
  evidence: Omit<NewEvidence, "schemaVersion" | "id" | "timestamp">,
  project?: string,
): Evidence {
  let gitSha = (evidence as { gitSha?: string }).gitSha;
  if (!gitSha) {
    try {
      gitSha = headSha(resolveRepo(project));
    } catch {
      gitSha = undefined;
    }
  }
  const payload: NewEvidence = {
    ...evidence,
    ...(gitSha ? { gitSha } : {}),
    producer: evidence.producer ?? "mcp:mcp-engineering",
  } as NewEvidence;
  return evidenceStore.record(taskId, payload);
}

export function emitEvent(
  taskId: string,
  event: {
    type: string;
    subTaskId?: string | null;
    fromStatus?: string | null;
    toStatus?: string | null;
    wave?: number | null;
    evidenceRef?: string | null;
    payload?: Record<string, unknown>;
    actor?: string;
  },
): Record<string, unknown> {
  return bus.emit({
    taskId,
    type: event.type as never,
    ...(event.subTaskId !== undefined ? { subTaskId: event.subTaskId } : {}),
    ...(event.fromStatus !== undefined ? { fromStatus: event.fromStatus } : {}),
    ...(event.toStatus !== undefined ? { toStatus: event.toStatus } : {}),
    ...(event.wave !== undefined ? { wave: event.wave } : {}),
    ...(event.evidenceRef !== undefined ? { evidenceRef: event.evidenceRef } : {}),
    ...(event.payload !== undefined ? { payload: event.payload } : {}),
    ...(event.actor !== undefined ? { actor: event.actor } : {}),
  }) as unknown as Record<string, unknown>;
}
