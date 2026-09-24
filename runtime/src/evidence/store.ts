import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EventBus } from "../events/bus.js";
import { EngError } from "../errors.js";
import { assertValid } from "../schemas/index.js";
import type { Evidence, EvidenceStatus, EvidenceType, NewEvidence } from "../types.js";
import { atomicWrite, ensureWorkstream, readJsonFile, workstreamDir } from "../workspace.js";
import { acquireLock, releaseLock } from "../state/lock.js";

/**
 * Trường provenance bắt buộc theo loại evidence (INV-12).
 * Evidence không có nguồn gốc thì không kiểm chứng được — spec mục 8.3.
 */
export const REQUIRED_PROVENANCE: Partial<Record<EvidenceType, string[]>> = {
  TEST: ["command", "cwd", "exitCode", "gitSha", "artifact"],
  BUILD: ["command", "cwd", "exitCode", "gitSha", "artifact"],
  HUMAN_APPROVAL: ["gateId", "approver", "approvedAt"],
  SCOPE_VALIDATION: ["unexpectedFiles", "deletedFiles"],
};

export class EvidenceStore {
  readonly #root?: string;
  readonly #bus: EventBus;
  readonly #onRecord?: (taskId: string, evidence: Evidence) => void;

  constructor(options: { root?: string; bus?: EventBus; onRecord?: (taskId: string, evidence: Evidence) => void } = {}) {
    this.#root = options.root;
    this.#bus = options.bus ?? new EventBus(options.root === undefined ? {} : { root: options.root });
    if (options.onRecord) this.#onRecord = options.onRecord;
  }

  dir(taskId: string): string {
    return path.join(workstreamDir(taskId, this.#root), "evidence");
  }

  nextId(taskId: string): string {
    const dir = this.dir(taskId);
    let max = 0;
    for (const file of readdirSyncSafe(dir)) {
      const match = /^EV-(\d+)\.json$/.exec(file);
      if (match?.[1]) max = Math.max(max, Number.parseInt(match[1], 10));
    }
    return `EV-${String(max + 1).padStart(4, "0")}`;
  }

  record(taskId: string, input: NewEvidence): Evidence {
    ensureWorkstream(taskId, this.#root);
    acquireLock(taskId, { ...(this.#root !== undefined ? { root: this.#root } : {}), command: `evidence:${input.type}` });

    const required = REQUIRED_PROVENANCE[input.type] ?? [];
    const missing = required.filter((field) => {
      const value = (input as unknown as Record<string, unknown>)[field];
      return value === undefined || value === null || value === "";
    });
    if (missing.length > 0) {
      throw new EngError(
        "EVIDENCE_INCOMPLETE",
        `Evidence ${input.type} thiếu trường provenance bắt buộc: ${missing.join(", ")}.`,
        {
          hint: "INV-12: evidence phải có nguồn gốc đầy đủ (command, cwd, exitCode, gitSha, artifact). Không ghi evidence không kiểm chứng được.",
          details: { missing, type: input.type },
        },
      );
    }

    const record: Evidence = {
      schemaVersion: 1,
      ...input,
      id: input.id ?? this.nextId(taskId),
      taskId,
      timestamp: input.timestamp ?? new Date().toISOString(),
      producer: input.producer ?? "runtime:eng",
    };

    assertValid("evidence", record, `evidence ${record.id} của ${taskId}`);

    try {
      const rel = `evidence/${record.id}.json`;
      atomicWrite(path.join(workstreamDir(taskId, this.#root), rel), `${JSON.stringify(record, null, 2)}\n`);
      this.#onRecord?.(taskId, { ...record, path: rel });
      this.#emitDerived(taskId, record);
      return { ...record, path: rel };
    } finally {
      releaseLock(taskId);
    }
  }

  #emitDerived(taskId: string, evidence: Evidence): void {
    const pass = evidence.status === "PASS";
    if (evidence.type === "SPEC_REVIEW" || evidence.type === "QUALITY_REVIEW") {
      this.#bus.emit({
        taskId,
        type: pass ? "ReviewPassed" : "ReviewFailed",
        subTaskId: evidence.subTaskId ?? null,
        actor: evidence.producer,
        evidenceRef: evidence.id,
        payload: { stage: evidence.type, status: evidence.status, summary: evidence.summary ?? null },
      });
      return;
    }
    if (evidence.type === "AUDIT") {
      this.#bus.emit({
        taskId,
        type: pass ? "AuditPassed" : "AuditFailed",
        actor: evidence.producer,
        evidenceRef: evidence.id,
        payload: { status: evidence.status, summary: evidence.summary ?? null },
      });
    }
  }

  list(taskId: string, filter: { type?: EvidenceType; status?: EvidenceStatus; limit?: number } = {}): Evidence[] {
    const dir = this.dir(taskId);
    const items: Evidence[] = [];
    for (const file of readdirSyncSafe(dir)) {
      if (!/^EV-\d+\.json$/.test(file)) continue;
      const parsed = readJsonFile<Evidence>(path.join(dir, file));
      if (!parsed) continue;
      if (filter.type && parsed.type !== filter.type) continue;
      if (filter.status && parsed.status !== filter.status) continue;
      items.push({ ...parsed, path: `evidence/${file}` });
    }
    items.sort((a, b) => a.id.localeCompare(b.id));
    return filter.limit ? items.slice(-filter.limit) : items;
  }

  get(taskId: string, evidenceId: string): Evidence | null {
    const parsed = readJsonFile<Evidence>(path.join(this.dir(taskId), `${evidenceId}.json`));
    return parsed ? { ...parsed, path: `evidence/${evidenceId}.json` } : null;
  }

  summary(taskId: string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of this.list(taskId)) counts[item.type] = (counts[item.type] ?? 0) + 1;
    return counts;
  }

  /** Lưu log/artifact thô của một lần chạy; trả về đường dẫn tương đối để đưa vào evidence.artifact. */
  writeLog(taskId: string, filename: string, content: string): string {
    const dir = path.join(this.dir(taskId), "logs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, filename), content, "utf8");
    return `evidence/logs/${filename}`;
  }
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
