import path from "node:path";
import { EventBus } from "../events/bus.js";
import { EvidenceStore } from "../evidence/store.js";
import { readPlan } from "../plan/store.js";
import { reposForState } from "../repos.js";
import { StateStore } from "../state/store.js";
import type { TaskContext } from "../context/types.js";
import { listFilesRecursive, readJsonFile, workstreamDir } from "../workspace.js";
import { computeMetrics, type TaskMetrics } from "./compute.js";

/**
 * Thu thập metrics của một ticket từ chính workstream (file-based state — INV-02).
 * Không gọi MCP, không gọi LLM: chỉ đọc lại thứ đã ghi.
 */
export function collectMetrics(taskId: string, options: { root?: string } = {}): TaskMetrics {
  const store = new StateStore(options.root === undefined ? {} : { root: options.root });
  const bus = new EventBus(options.root === undefined ? {} : { root: options.root });
  const evidenceStore = new EvidenceStore({ ...(options.root === undefined ? {} : { root: options.root }), bus });

  const state = store.require(taskId);
  const dir = workstreamDir(taskId, options.root);
  const contexts = listFilesRecursive(path.join(dir, "context"))
    .filter((file) => /^TASK-[0-9]+\.json$/i.test(file))
    .map((file) => readJsonFile<TaskContext>(path.join(dir, "context", file)))
    .filter((context): context is TaskContext => context !== null);

  // Multi-repo (spec 9.4): metrics phải nhìn đúng danh sách repo của ticket khi tính gate coverage.
  const projects = reposForState(state, readPlan(taskId, options.root));

  return computeMetrics({
    state,
    evidence: evidenceStore.list(taskId),
    contexts,
    events: bus.read(taskId),
    projects,
  });
}
