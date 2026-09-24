import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { existsSync } from "node:fs";
import { assertValid } from "../schemas/index.js";
import type { DomainEvent, EventType } from "../types.js";
import { ensureWorkstream, workstreamDir } from "../workspace.js";
import { acquireLock, releaseLock } from "../state/lock.js";

export interface EmitInput {
  taskId: string;
  type: EventType;
  subTaskId?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  wave?: number | null;
  evidenceRef?: string | null;
  payload?: Record<string, unknown>;
  actor?: string;
}

/**
 * Event bus file-based: mỗi ticket một `events.jsonl`.
 * Consumer ngoài (Jira/dashboard/audit log) đọc file này — spec mục 14.
 */
export class EventBus {
  readonly #root?: string;

  constructor(options: { root?: string } = {}) {
    this.#root = options.root;
  }

  eventsFile(taskId: string): string {
    return path.join(workstreamDir(taskId, this.#root), "events.jsonl");
  }

  emit(input: EmitInput): DomainEvent {
    ensureWorkstream(input.taskId, this.#root);
    const event: DomainEvent = {
      schemaVersion: 1,
      eventId: `EVT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: input.type,
      taskId: input.taskId,
      subTaskId: input.subTaskId ?? null,
      at: new Date().toISOString(),
      actor: input.actor ?? "runtime:eng",
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      wave: input.wave ?? null,
      evidenceRef: input.evidenceRef ?? null,
      payload: input.payload ?? {},
    };
    assertValid("event", event, `event ${event.type} của ${input.taskId}`);
    acquireLock(input.taskId, { ...(this.#root !== undefined ? { root: this.#root } : {}), command: "event:emit" });
    try {
      appendFileSync(this.eventsFile(input.taskId), `${JSON.stringify(event)}\n`, "utf8");
    } finally {
      releaseLock(input.taskId);
    }
    return event;
  }

  read(taskId: string, options: { type?: EventType; limit?: number } = {}): DomainEvent[] {
    const file = this.eventsFile(taskId);
    if (!existsSync(file)) return [];
    const events: DomainEvent[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        events.push(JSON.parse(trimmed) as DomainEvent);
      } catch {
        continue; // bỏ qua dòng hỏng, không làm fail cả báo cáo
      }
    }
    const filtered = options.type ? events.filter((event) => event.type === options.type) : events;
    return options.limit ? filtered.slice(-options.limit) : filtered;
  }
}
