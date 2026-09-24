import type { PlanTask } from "../types.js";

export interface DagEdge {
  /** Task phụ thuộc */
  from: string;
  /** Task được phụ thuộc */
  to: string;
}

export interface DagError {
  code: "CYCLE" | "UNKNOWN_DEPENDENCY" | "SELF_DEPENDENCY" | "DUPLICATE_TASK";
  message: string;
  tasks: string[];
}

export interface Dag {
  ok: boolean;
  tasks: string[];
  edges: DagEdge[];
  waves: string[][];
  errors: DagError[];
  /** Task không vào được wave nào (do cycle). */
  unresolved: string[];
}

/**
 * DependencyGraph (spec mục 9.4, 10): plan → DAG → waves.
 * Wave N gồm các task mà mọi dependency đã nằm ở wave < N.
 */
export function buildDag(tasks: PlanTask[]): Dag {
  const errors: DagError[] = [];
  const byId = new Map<string, PlanTask>();

  for (const task of tasks) {
    if (byId.has(task.id)) {
      errors.push({ code: "DUPLICATE_TASK", message: `Task ${task.id} bị khai báo trùng.`, tasks: [task.id] });
      continue;
    }
    byId.set(task.id, task);
  }

  const edges: DagEdge[] = [];
  const dependenciesOf = new Map<string, string[]>();

  for (const task of byId.values()) {
    const deps: string[] = [];
    for (const dependency of task.dependencies) {
      if (dependency === task.id) {
        errors.push({
          code: "SELF_DEPENDENCY",
          message: `${task.id} tự phụ thuộc chính nó.`,
          tasks: [task.id],
        });
        continue;
      }
      if (!byId.has(dependency)) {
        errors.push({
          code: "UNKNOWN_DEPENDENCY",
          message: `${task.id} phụ thuộc ${dependency} nhưng task này không có trong plan.`,
          tasks: [task.id, dependency],
        });
        continue;
      }
      deps.push(dependency);
      edges.push({ from: task.id, to: dependency });
    }
    dependenciesOf.set(task.id, deps);
  }

  const waves: string[][] = [];
  const resolved = new Set<string>();
  const remaining = new Set(byId.keys());

  while (remaining.size > 0) {
    const wave = [...remaining]
      .filter((id) => (dependenciesOf.get(id) ?? []).every((dependency) => resolved.has(dependency)))
      .sort();
    if (wave.length === 0) break; // còn lại là cycle
    waves.push(wave);
    for (const id of wave) {
      resolved.add(id);
      remaining.delete(id);
    }
  }

  if (remaining.size > 0) {
    const cycles = findCycles([...remaining], dependenciesOf);
    errors.push({
      code: "CYCLE",
      message: `Phát hiện vòng phụ thuộc: ${cycles.map((cycle) => cycle.join(" → ")).join("; ")}`,
      tasks: [...remaining].sort(),
    });
  }

  return {
    ok: errors.length === 0,
    tasks: [...byId.keys()],
    edges,
    waves,
    errors,
    unresolved: [...remaining].sort(),
  };
}

/** Tìm chu trình thật (đường đi) để thông báo cho người đọc, không chỉ "có cycle". */
function findCycles(nodes: string[], dependenciesOf: Map<string, string[]>): string[][] {
  const nodeSet = new Set(nodes);
  const cycles: string[][] = [];
  const visited = new Set<string>();

  for (const start of nodes) {
    if (visited.has(start)) continue;
    const stack: string[] = [];
    const onStack = new Set<string>();

    const walk = (node: string): boolean => {
      if (onStack.has(node)) {
        const index = stack.indexOf(node);
        cycles.push([...stack.slice(index), node]);
        return true;
      }
      if (visited.has(node)) return false;

      visited.add(node);
      stack.push(node);
      onStack.add(node);

      for (const dependency of dependenciesOf.get(node) ?? []) {
        if (!nodeSet.has(dependency)) continue;
        if (walk(dependency)) {
          stack.pop();
          onStack.delete(node);
          return true;
        }
      }
      stack.pop();
      onStack.delete(node);
      return false;
    };

    walk(start);
    if (cycles.length > 0) break;
  }

  return cycles;
}

/** Thứ tự thực thi tuyến tính (topological) — dùng để in "task nào làm trước". */
export function topologicalOrder(dag: Dag): string[] {
  return dag.waves.flat();
}
