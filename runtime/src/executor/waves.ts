import { buildDag, type Dag } from "../graph/dag.js";
import { checkWave, detectConflicts, formatConflict, type Conflict } from "../graph/conflicts.js";
import type { Plan, PlanTask, PlanWave } from "../types.js";

export interface WavePlanEntry {
  index: number;
  tasks: string[];
  conflictCheck: "PASS" | "FAIL";
  conflicts: Conflict[];
  /** FAIL ⇒ các task trong wave phải chạy tuần tự, không parallel (INV-11). */
  mode: "PARALLEL" | "SEQUENTIAL";
}

export interface ExecutionPlan {
  dag: Dag;
  waves: WavePlanEntry[];
  /** Có lỗi cấu trúc plan (cycle, dependency lạ) ⇒ không được thực thi. */
  blocked: boolean;
  errors: string[];
}

/**
 * Wave Executor (phần lập kế hoạch): plan → DAG → waves + conflict check.
 * Việc chạy worker thật thuộc bước AgentRunner/WaveExecutor.execute (chưa implement).
 */
export function buildExecutionPlan(plan: Plan): ExecutionPlan {
  const dag = buildDag(plan.tasks);
  const byId = new Map<string, PlanTask>(plan.tasks.map((task) => [task.id, task]));

  const waves: WavePlanEntry[] = dag.waves.map((taskIds, index) => {
    const waveTasks = taskIds.map((id) => byId.get(id)).filter((task): task is PlanTask => task !== undefined);
    const check = checkWave(waveTasks);
    return {
      index: index + 1,
      tasks: taskIds,
      conflictCheck: check.status,
      conflicts: check.conflicts,
      mode: check.safeToParallel ? "PARALLEL" : "SEQUENTIAL",
    };
  });

  const errors = dag.errors.map((error) => error.message);
  if (dag.unresolved.length > 0) {
    errors.push(`Task không xác định được wave (do vòng phụ thuộc): ${dag.unresolved.join(", ")}`);
  }

  return { dag, waves, blocked: errors.length > 0, errors };
}

/** Chuyển ExecutionPlan thành plan.waves để lưu vào plan.json (schema: conflicts là string[]). */
export function toPlanWaves(execution: ExecutionPlan): PlanWave[] {
  return execution.waves.map((wave) => ({
    index: wave.index,
    tasks: wave.tasks,
    conflictCheck: wave.conflictCheck,
    conflicts: wave.conflicts.map(formatConflict),
  }));
}

export function attachWaves(plan: Plan): { plan: Plan; execution: ExecutionPlan } {
  const execution = buildExecutionPlan(plan);
  return { plan: { ...plan, waves: toPlanWaves(execution) }, execution };
}

export interface WaveProgress {
  index: number;
  tasks: string[];
  done: string[];
  pending: string[];
  mode: WavePlanEntry["mode"];
  conflictCheck: WavePlanEntry["conflictCheck"];
  conflicts: Conflict[];
  /** Wave này có thể chạy ngay: còn task và mọi wave trước đã xong. */
  ready: boolean;
  /** Còn task nhưng wave trước chưa xong. */
  blockedByPrevious: boolean;
}

export function waveProgress(plan: Plan, execution: ExecutionPlan): WaveProgress[] {
  const statusById = new Map(plan.tasks.map((task) => [task.id, task.status ?? "PENDING"]));
  const out: WaveProgress[] = [];
  let previousComplete = true;

  for (const wave of execution.waves) {
    const done = wave.tasks.filter((id) => statusById.get(id) === "DONE");
    const pending = wave.tasks.filter((id) => statusById.get(id) !== "DONE");
    out.push({
      index: wave.index,
      tasks: wave.tasks,
      done,
      pending,
      mode: wave.mode,
      conflictCheck: wave.conflictCheck,
      conflicts: wave.conflicts,
      ready: previousComplete && pending.length > 0,
      blockedByPrevious: !previousComplete && pending.length > 0,
    });
    previousComplete = previousComplete && pending.length === 0;
  }

  return out;
}

/** Wave kế tiếp cần chạy: wave thấp nhất còn task chưa DONE và mọi wave trước đã xong. */
export function nextWave(plan: Plan, execution: ExecutionPlan): WaveProgress | null {
  const progress = waveProgress(plan, execution);
  for (const wave of progress) {
    if (wave.pending.length === 0) continue;
    return wave;
  }
  return null;
}

export { detectConflicts };
