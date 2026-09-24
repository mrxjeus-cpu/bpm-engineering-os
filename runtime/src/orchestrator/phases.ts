import path from "node:path";
import { agentContract } from "../agents/registry.js";
import { AgentRunner } from "../agents/runner.js";
import { compileTaskContext } from "../context/compiler.js";
import { EngError } from "../errors.js";
import { resolveRepoRoot } from "../config/index.js";
import { buildExecutionPlan, nextWave, type WaveProgress } from "../executor/waves.js";
import {
  importPlanFromMarkdown,
  planMarkdownExists,
  readPlan,
  requirePlan,
  setTaskStatus,
  writePlan,
} from "../plan/store.js";
import { RecoveryEngine, type Diagnosis } from "../recovery/engine.js";
import { StateStore } from "../state/store.js";
import type { TaskState, TaskStatus } from "../types.js";
import { readTextFileIfExists, workstreamDir, relPath } from "../workspace.js";
import { existsSync, readFileSync } from "node:fs";
import { WorktreeManager, type WorktreeInfo } from "../git/worktree.js";
import { acquireLock, releaseLock } from "../state/lock.js";
import { atomicWrite, readJsonFile } from "../workspace.js";
import { collectMechanicalEvidence } from "./evidence.js";
import { PHASES, type PhaseName, type PhaseResult, type PhaseStep } from "./types.js";

export interface RunPhaseOptions {
  harness?: string;
  project?: string;
  dryRun?: boolean;
  /** Tắt tự động recovery khi worker lỗi (mặc định: bật). */
  noRecover?: boolean;
  noMcp?: boolean;
  root?: string;
  maxContextTokens?: number;
  /** Chạy song song trong wave (cần worktrees.enabled trong config/projects.yaml). */
  parallel?: boolean;
  /** Số task chạy song song tối đa (mặc định 3). */
  concurrency?: number;
  /** Cho phép cắt qua worktree cũ nếu đã tồn tại (mặc định true khi --parallel). */
  onProgress?: (message: string) => void;
}

interface Ctx {
  taskId: string;
  steps: PhaseStep[];
  warnings: string[];
  nextActions: string[];
  recovery?: Diagnosis;
  blocked: boolean;
  /** Phase dừng có chủ đích để chờ bước tiếp (ví dụ merge worktree) — không phải lỗi. */
  awaitingNextStep?: boolean;
}

const MAX_WAVE_ITERATIONS = 50;

/**
 * PhaseOrchestrator (spec mục 9.1, 9.2 — WorkflowEngine).
 *
 * Mỗi lệnh phase gói sẵn chuỗi bước của một pha: kiểm precondition → chạy agent/context/wave
 * → KIỂM ARTIFACT THẬT → thu evidence cơ học → chuyển trạng thái qua gate.
 * Không tin lời agent, không bỏ qua gate: nếu thiếu evidence thì báo rõ còn thiếu gì.
 */
export class PhaseOrchestrator {
  readonly #store: StateStore;
  readonly #runner: AgentRunner;
  readonly #recovery: RecoveryEngine;
  readonly #options: RunPhaseOptions;

  constructor(options: RunPhaseOptions = {}) {
    this.#options = options;
    const storeOptions = options.root === undefined ? {} : { root: options.root };
    this.#store = new StateStore(storeOptions);
    this.#runner = new AgentRunner({
      ...storeOptions,
      ...(options.project ? { project: options.project } : {}),
    });
    this.#recovery = new RecoveryEngine({ ...storeOptions, store: this.#store });
  }

  /** Token lock của phase hiện tại (truyền cho tiến trình con cùng cây thao tác). */
  #lockToken?: string;

  #progress(message: string): void {
    this.#options.onProgress?.(message);
  }

  #exists(taskId: string, rel: string): boolean {
    return readTextFileIfExists(path.join(workstreamDir(taskId, this.#options.root), rel)) !== null;
  }

  #missingArtifacts(taskId: string, role: string, subTaskId?: string): string[] {
    const contract = agentContract(role);
    return contract.outputs
      .map((output) => output.replaceAll("{subTaskId}", subTaskId ?? "TASK"))
      .filter((rel) => !this.#exists(taskId, rel));
  }

  async #runAgent(ctx: Ctx, role: string, subTaskId?: string): Promise<boolean> {
    this.#progress(`chạy agent ${role}${subTaskId ? ` cho ${subTaskId}` : ""}`);
    let result;
    try {
      result = await this.#runner.run({
        taskId: ctx.taskId,
        role,
        ...(subTaskId ? { subTaskId } : {}),
        ...(this.#options.harness ? { harness: this.#options.harness } : {}),
        ...(this.#options.project ? { project: this.#options.project } : {}),
        ...(this.#lockToken ? { lockToken: this.#lockToken } : {}),
      });
    } catch (error) {
      const code = error instanceof EngError ? error.code : "AGENT_RUN_FAILED";
      ctx.steps.push({ name: `agent:${role}`, status: "failed", detail: `${code}: ${error instanceof Error ? error.message : String(error)}` });
      ctx.warnings.push(`Không chạy được agent ${role} (${code}).`);
      return false;
    }

    const missing = this.#missingArtifacts(ctx.taskId, role, subTaskId);
    const ok = result.ok && missing.length === 0;
    ctx.steps.push({
      name: `agent:${role}${subTaskId ? `:${subTaskId}` : ""}`,
      status: ok ? "ok" : "failed",
      detail: `harness=${result.harness} exit=${result.exitCode ?? "?"} ${result.durationMs}ms · skill=${result.skills.length} · artifact thiếu [${missing.join(", ") || "—"}]`,
    });
    for (const warning of result.warnings) ctx.warnings.push(warning);
    return ok;
  }

  #advance(ctx: Ctx, to: TaskStatus, name = `advance:${to}`): boolean {
    try {
      this.#store.transition(ctx.taskId, to, { by: "runtime:phase", reason: `phase step → ${to}` });
      ctx.steps.push({ name, status: "ok", detail: `→ ${to}` });
      return true;
    } catch (error) {
      const code = error instanceof EngError ? error.code : "TRANSITION_FAILED";
      const details = error instanceof EngError ? (error.details as { missing?: string[] } | undefined) : undefined;
      const missing = details?.missing ?? [];
      ctx.steps.push({
        name,
        status: code === "EVIDENCE_REQUIRED" || code === "HUMAN_APPROVAL_REQUIRED" ? "blocked" : "failed",
        detail: `${code}: ${error instanceof Error ? error.message : String(error)}`,
      });
      if (missing.length > 0) ctx.warnings.push(`Thiếu evidence: ${missing.join(" · ")}`);
      return false;
    }
  }

  async #handleFailure(ctx: Ctx, subTaskId?: string): Promise<void> {
    if (this.#options.noRecover === true) {
      ctx.warnings.push("Bỏ qua recovery (--no-recover): task giữ nguyên trạng thái lỗi.");
      return;
    }
    this.#progress("phân loại lỗi + tạo recovery context");
    const outcome = this.#recovery.recover(ctx.taskId, {
      ...(subTaskId ? { subTaskId } : {}),
      apply: true,
      by: "runtime:phase",
    });
    ctx.recovery = outcome.diagnosis;
    ctx.blocked = outcome.blocked;
    ctx.steps.push({
      name: `recovery:${outcome.diagnosis.category}`,
      status: outcome.blocked ? "blocked" : "ok",
      detail: outcome.diagnosis.summary,
    });
    for (const action of outcome.diagnosis.actions.slice(0, 3)) ctx.nextActions.push(action);
    for (const warning of outcome.warnings) ctx.warnings.push(warning);
    if (outcome.blocked) {
      ctx.nextActions.push(`eng unblock ${ctx.taskId}`, `xử lý xong thì chạy lại phase: eng <phase> ${ctx.taskId}`);
    }
  }

  async #compileContexts(ctx: Ctx, subTaskIds: string[]): Promise<boolean> {
    let ok = true;
    for (const subTaskId of subTaskIds) {
      if (this.#exists(ctx.taskId, relPath("context", `${subTaskId}.json`))) {
        ctx.steps.push({ name: `context:${subTaskId}`, status: "skipped", detail: "đã có context" });
        continue;
      }
      this.#progress(`compile context cho ${subTaskId}`);
      try {
        const compiled = await compileTaskContext({
          taskId: ctx.taskId,
          subTaskId,
          ...(this.#options.project ? { project: this.#options.project } : {}),
          ...(this.#options.maxContextTokens !== undefined ? { limits: { maxTokens: this.#options.maxContextTokens } } : {}),
          ...(this.#options.noMcp === true
            ? { providers: undefined }
            : {}),
          ...(this.#options.root !== undefined ? { root: this.#options.root } : {}),
        });
        ctx.steps.push({
          name: `context:${subTaskId}`,
          status: "ok",
          detail: `~${compiled.tokenEstimate} token · ${compiled.context.unknowns?.length ?? 0} unknown`,
        });
        if ((compiled.context.unknowns?.length ?? 0) > 0) {
          ctx.warnings.push(`${subTaskId}: context còn unknowns — worker phải báo BLOCKED nếu cần (INV-06).`);
        }
      } catch (error) {
        ok = false;
        ctx.steps.push({
          name: `context:${subTaskId}`,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return ok;
  }

  async run(taskId: string, phase: PhaseName): Promise<PhaseResult> {
    const spec = PHASES[phase];
    const state = this.#store.require(taskId);
    const ctx: Ctx = { taskId, steps: [], warnings: [], nextActions: [], blocked: false };

    if (!spec.allowedFrom.includes(state.status)) {
      throw new EngError(
        "PHASE_PRECONDITION",
        `Phase ${phase} không chạy được từ status ${state.status}.`,
        {
          hint: `Phase ${phase} chỉ chạy từ: ${spec.allowedFrom.join(", ")}. Xem trạng thái hiện tại: eng resume ${taskId}`,
          details: { allowedFrom: spec.allowedFrom, currentStatus: state.status },
        },
      );
    }

    // Khoá workstream suốt phase: tránh hai lệnh ghi chồng nhau (state/plan/evidence).
    this.#lockToken = `eng-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    acquireLock(taskId, {
      ...(this.#options.root !== undefined ? { root: this.#options.root } : {}),
      command: `phase:${phase}`,
      token: this.#lockToken,
    });

    try {
      return await this.#runLocked(taskId, phase, state, ctx, spec);
    } finally {
      releaseLock(taskId);
      this.#lockToken = undefined;
    }
  }

  async #runLocked(
    taskId: string,
    phase: PhaseName,
    state: TaskState,
    ctx: Ctx,
    spec: (typeof PHASES)[PhaseName],
  ): Promise<PhaseResult> {
    if (this.#options.dryRun === true) {
      const steps: PhaseStep[] = spec.steps.map((step) => ({ name: step, status: "skipped" as const, detail: "(dry run)" }));
      return {
        taskId,
        phase,
        title: spec.title,
        from: state.status,
        to: state.status,
        ok: true,
        blocked: false,
        dryRun: true,
        steps,
        warnings: ["Dry run: chưa thực hiện bước nào."],
        nextActions: [`Bỏ --dry-run để chạy thật: eng ${phase} ${taskId}`],
      };
    }

    switch (phase) {
      case "translate":
        await this.#translate(ctx);
        break;
      case "analyze":
        await this.#analyze(ctx);
        break;
      case "design":
        await this.#design(ctx);
        break;
      case "plan":
        await this.#plan(ctx);
        break;
      case "implement":
        await this.#implement(ctx);
        break;
      case "review":
        await this.#review(ctx);
        break;
      case "audit":
        await this.#audit(ctx);
        break;
      case "verify":
        await this.#verify(ctx);
        break;
    }

    const finalState = this.#store.require(taskId);
    const failed = ctx.steps.some((step) => step.status === "failed");
    const blockedStep = ctx.steps.some((step) => step.status === "blocked");
    // Dừng chờ bước tiếp (merge worktree) vẫn là THÀNH CÔNG: không bước nào fail.
    const ok = !failed && !blockedStep && (finalState.status !== state.status || ctx.awaitingNextStep === true);

    if (finalState.status === state.status && ok && ctx.awaitingNextStep !== true) {
      ctx.warnings.push(`Phase ${phase} không đổi trạng thái (đã ở ${finalState.status}).`);
    }
    return {
      taskId,
      phase,
      title: spec.title,
      from: state.status,
      to: finalState.status,
      ok,
      blocked: ctx.blocked || blockedStep,
      dryRun: false,
      steps: ctx.steps,
      ...(ctx.recovery ? { recovery: ctx.recovery } : {}),
      warnings: [...new Set(ctx.warnings)],
      nextActions: ctx.nextActions.length > 0 ? [...new Set(ctx.nextActions)] : [`eng resume ${taskId}`],
    };
  }

  // ------------------------------------------------------------------ phases

  async #translate(ctx: Ctx): Promise<void> {
    const state = this.#store.require(ctx.taskId);
    if (state.status === "NEW" && !this.#advance(ctx, "TRANSLATING")) return;
    const ok = await this.#runAgent(ctx, "researcher");
    if (!ok) {
      await this.#handleFailure(ctx);
      return;
    }
    if (!this.#advance(ctx, "REQUIREMENT_ANALYSIS")) return;
    ctx.nextActions.push(`eng analyze ${ctx.taskId}`);
  }

  async #analyze(ctx: Ctx): Promise<void> {
    if (!this.#advance(ctx, "IMPACT_ANALYSIS")) return;
    const ok = await this.#runAgent(ctx, "impact");
    if (!ok) {
      await this.#handleFailure(ctx);
      return;
    }
    if (!this.#advance(ctx, "DESIGNING")) return;
    ctx.nextActions.push(`eng design ${ctx.taskId}`);
  }

  async #design(ctx: Ctx): Promise<void> {
    const state = this.#store.require(ctx.taskId);
    if (state.status === "DESIGNING") {
      const ok = await this.#runAgent(ctx, "architect");
      if (!ok) {
        await this.#handleFailure(ctx);
        return;
      }
    } else {
      ctx.steps.push({ name: "agent:architect", status: "skipped", detail: "đã ở WAITING_DESIGN_APPROVAL" });
    }
    if (!this.#advance(ctx, "WAITING_DESIGN_APPROVAL")) return;
    ctx.warnings.push("Dừng ở human gate: cần người approve kiến trúc trước khi lập kế hoạch (INV-05).");
    ctx.nextActions.push(
      `eng record ${ctx.taskId} --type HUMAN_APPROVAL --status PASS --gate-id architecture --approver "<tên>" --approved-at <ISO>`,
      `eng plan ${ctx.taskId}`,
    );
  }

  async #plan(ctx: Ctx): Promise<void> {
    const state = this.#store.require(ctx.taskId);
    if (state.status === "WAITING_DESIGN_APPROVAL") {
      if (!this.#advance(ctx, "PLANNING")) return;
    }

    if (!planMarkdownExists(ctx.taskId, this.#options.root)) {
      const ok = await this.#runAgent(ctx, "architect");
      if (!ok || !planMarkdownExists(ctx.taskId, this.#options.root)) {
        ctx.steps.push({ name: "plan.md", status: "failed", detail: "chưa có plan.md sau khi chạy architect" });
        await this.#handleFailure(ctx);
        return;
      }
    }

    const markdown = readTextFileIfExists(path.join(workstreamDir(ctx.taskId, this.#options.root), "plan.md"));
    if (markdown === null) {
      ctx.steps.push({ name: "plan.md", status: "failed", detail: "không đọc được plan.md" });
      return;
    }
    try {
      const imported = importPlanFromMarkdown(ctx.taskId, markdown, {
        ...(this.#options.root !== undefined ? { root: this.#options.root } : {}),
        ...(this.#exists(ctx.taskId, "architecture.md") ? { architectureRef: "architecture.md" } : {}),
        source: "plan.md",
      });
      ctx.steps.push({
        name: "plan:import",
        status: "ok",
        detail: `${imported.taskCount} task · ${imported.waves} wave`,
      });
      for (const warning of imported.warnings) ctx.warnings.push(warning);
    } catch (error) {
      const code = error instanceof EngError ? error.code : "PLAN_IMPORT_FAILED";
      ctx.steps.push({ name: "plan:import", status: "failed", detail: `${code}: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    const plan = requirePlan(ctx.taskId, this.#options.root);
    const execution = buildExecutionPlan(plan);
    ctx.steps.push({
      name: "plan:graph",
      status: execution.blocked ? "failed" : "ok",
      detail: execution.blocked
        ? `plan không thực thi được: ${execution.errors.join("; ")}`
        : execution.waves.map((wave) => `wave ${wave.index}[${wave.mode}] ${wave.tasks.join(",")}`).join(" · "),
    });
    if (execution.blocked) return;

    if (!this.#advance(ctx, "READY_TO_IMPLEMENT")) return;
    ctx.nextActions.push(`eng implement ${ctx.taskId}`);
  }

  async #implement(ctx: Ctx): Promise<void> {
    const current = this.#store.require(ctx.taskId).status;
    if (current !== "IMPLEMENTING" && !this.#advance(ctx, "IMPLEMENTING")) return;

    const plan = requirePlan(ctx.taskId, this.#options.root);
    const pending = plan.tasks.filter((task) => (task.status ?? "PENDING") !== "DONE").map((task) => task.id);
    if (!(await this.#compileContexts(ctx, pending))) return;

    const manager = this.#options.parallel === true ? new WorktreeManager({ ...(this.#options.project ? { project: this.#options.project } : {}) }) : null;
    if (manager) manager.assertEnabled();
    let usedWorktrees = false;

    let iterations = 0;
    while (iterations < MAX_WAVE_ITERATIONS) {
      iterations += 1;
      const currentPlan = requirePlan(ctx.taskId, this.#options.root);
      const execution = buildExecutionPlan(currentPlan);
      const wave = nextWave(currentPlan, execution);
      if (wave === null) break;

      this.#progress(`wave ${wave.index} (${wave.mode}): ${wave.tasks.join(", ")}`);
      this.#store.patch(
        ctx.taskId,
        { currentWave: wave.index, currentTasks: wave.tasks },
        { by: "runtime:phase", reason: `bắt đầu wave ${wave.index}` },
      );

      const localPlan = requirePlan(ctx.taskId, this.#options.root);
      for (const subTaskId of wave.tasks) setTaskStatus(localPlan, subTaskId, "IN_PROGRESS");
      writePlan(localPlan, this.#options.root);

      ctx.steps.push({
        name: `wave:${wave.index}`,
        status: "ok",
        detail: `${wave.mode} · conflict=${wave.conflictCheck} · ${wave.tasks.join(", ")}`,
      });
      if (wave.mode === "SEQUENTIAL") {
        ctx.warnings.push(`Wave ${wave.index} có conflict ⇒ chạy tuần tự, không parallel (INV-11).`);
      }

      // Song song CHỈ khi có cô lập worktree: hai agent trong cùng working tree sẽ tranh
      // target/, file tạm, cổng test (INV-11 chỉ chặn trùng file của task).
      if (manager !== null && wave.mode === "PARALLEL" && wave.tasks.length > 1) {
        usedWorktrees = true;
        const ok = await this.#runWaveParallel(ctx, manager, wave);
        if (!ok) return;
        continue;
      }

      for (const subTaskId of wave.tasks) {
        const ok = await this.#runAgent(ctx, "developer", subTaskId);
        if (!ok) {
          await this.#handleFailure(ctx, subTaskId);
          return;
        }
        const withDone = requirePlan(ctx.taskId, this.#options.root);
        setTaskStatus(withDone, subTaskId, "DONE");
        writePlan(withDone, this.#options.root);
        const state = this.#store.require(ctx.taskId);
        const completed = new Set(state.completedTasks ?? []);
        completed.add(subTaskId);
        const running = new Set(state.currentTasks ?? []);
        running.delete(subTaskId);
        this.#store.patch(
          ctx.taskId,
          { completedTasks: [...completed].sort(), currentTasks: [...running].sort() },
          { by: "runtime:phase", reason: `${subTaskId} xong theo report của developer` },
        );
      }
    }

    if (usedWorktrees) {
      // Thay đổi đang nằm trong worktree/branch riêng, KHÔNG ở working tree chính
      // ⇒ thu evidence trên cây chính là vô nghĩa. Merge trước, rồi chạy lại implement.
      ctx.awaitingNextStep = true;
      ctx.warnings.push("Thay đổi nằm trong worktree riêng — chưa thu evidence trên cây chính.");
      ctx.nextActions.push(`eng merge ${ctx.taskId}`, `sau khi merge: eng implement ${ctx.taskId} (thu evidence + vào REVIEWING)`);
      return;
    }

    // Evidence cơ học do runtime tự thu — không tin lời agent (INV-12)
    const evidence = await collectMechanicalEvidence(ctx.taskId, {
      kinds: ["tests", "scope"],
      ...(this.#options.project ? { project: this.#options.project } : {}),
      ...(this.#lockToken ? { env: { ENG_WORKSTREAM_LOCK_TOKEN: this.#lockToken } } : {}),
    });
    ctx.steps.push(...evidence.steps);
    ctx.warnings.push(...evidence.errors);

    if (!this.#advance(ctx, "REVIEWING")) {
      ctx.nextActions.push(
        `Thiếu evidence để vào REVIEWING: chạy test/scope thật rồi eng record <TASK_ID> --type TEST|SCOPE_VALIDATION ...`,
        `eng review ${ctx.taskId}`,
      );
      return;
    }
    ctx.nextActions.push(`eng review ${ctx.taskId}`);
  }

  /** Chạy `fn` cho từng item với tối đa `limit` việc đồng thời. */
  async #runWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await fn(items[index] as T);
      }
    });
    await Promise.all(workers);
    return results;
  }

  /** Wave song song trong worktree riêng: tạo worktree → chạy agent đồng thời → commit từng branch. */
  async #runWaveParallel(ctx: Ctx, manager: WorktreeManager, wave: WaveProgress): Promise<boolean> {
    const repoRoot = resolveRepoRoot(this.#options.project);
    if (repoRoot === null) {
      ctx.steps.push({ name: `wave:${wave.index}`, status: "failed", detail: "chưa cấu hình repoRoot — không tạo được worktree" });
      return false;
    }

    const limit = Math.max(1, Math.min(this.#options.concurrency ?? 3, wave.tasks.length));
    ctx.steps.push({
      name: `wave:${wave.index}`,
      status: "ok",
      detail: `PARALLEL x${limit} · worktree cô lập · ${wave.tasks.join(", ")}`,
    });

    const created: Array<{ subTaskId: string; info?: WorktreeInfo }> = [];
    for (const subTaskId of wave.tasks) {
      try {
        const info = await manager.create(repoRoot, ctx.taskId, subTaskId);
        created.push({ subTaskId, info });
        ctx.steps.push({ name: `worktree:${subTaskId}`, status: "ok", detail: `${info.branch} → ${info.path}` });
      } catch (error) {
        ctx.steps.push({
          name: `worktree:${subTaskId}`,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const ready = created.filter((entry): entry is { subTaskId: string; info: WorktreeInfo } => entry.info !== undefined);
    if (ready.length !== wave.tasks.length) {
      ctx.warnings.push("Không tạo đủ worktree — dừng wave song song, không chạy agent.");
      return false;
    }

    const results = await this.#runWithLimit(ready, limit, async (entry) => {
      this.#progress(`chạy developer song song: ${entry.subTaskId}`);
      const result = await this.#runner.run({
        taskId: ctx.taskId,
        role: "developer",
        subTaskId: entry.subTaskId,
        ...(this.#options.harness ? { harness: this.#options.harness } : {}),
        ...(this.#options.project ? { project: this.#options.project } : {}),
        ...(this.#lockToken ? { lockToken: this.#lockToken } : {}),
        repoRoot: entry.info.path,
      });
      const missing = this.#missingArtifacts(ctx.taskId, "developer", entry.subTaskId);
      return { entry, result, missing, ok: result.ok && missing.length === 0 };
    });

    const failures: Array<{ subTaskId: string }> = [];
    for (const item of results) {
      const { entry, result, missing, ok } = item;
      ctx.steps.push({
        name: `agent:developer:${entry.subTaskId}`,
        status: ok ? "ok" : "failed",
        detail:
          `harness=${result.harness} exit=${result.exitCode ?? "?"} ${result.durationMs}ms · worktree=${entry.info.branch}` +
          ` · artifact thiếu [${missing.join(", ") || "—"}]`,
      });
      for (const warning of result.warnings) ctx.warnings.push(warning);
      if (!ok) {
        failures.push({ subTaskId: entry.subTaskId });
        continue;
      }

      const commit = await manager.commit(entry.info, `feat(${ctx.taskId}): ${entry.subTaskId}`);
      const files = await manager.changedFiles(entry.info);
      const diffStat = await manager.diffStat(entry.info);
      const changes = {
        schemaVersion: 1,
        taskId: ctx.taskId,
        subTaskId: entry.subTaskId,
        branch: entry.info.branch,
        baseRef: entry.info.baseRef,
        worktree: entry.info.path,
        sha: commit.sha ?? null,
        files,
        diffStat,
        committed: commit.committed,
        merged: false,
        createdAt: new Date().toISOString(),
      };
      atomicWrite(
        path.join(workstreamDir(ctx.taskId, this.#options.root), relPath("tasks", `${entry.subTaskId}-changes.json`)),
        `${JSON.stringify(changes, null, 2)}\n`,
      );
      ctx.steps.push({
        name: `commit:${entry.subTaskId}`,
        status: "ok",
        detail: `${entry.info.branch} · ${commit.committed ? `${files.length} file` : "không có thay đổi"}${commit.sha ? ` · ${commit.sha}` : ""}`,
      });

      const withDone = requirePlan(ctx.taskId, this.#options.root);
      setTaskStatus(withDone, entry.subTaskId, "DONE");
      writePlan(withDone, this.#options.root);
      const state = this.#store.require(ctx.taskId);
      const completed = new Set(state.completedTasks ?? []);
      completed.add(entry.subTaskId);
      const running = new Set(state.currentTasks ?? []);
      running.delete(entry.subTaskId);
      this.#store.patch(
        ctx.taskId,
        { completedTasks: [...completed].sort(), currentTasks: [...running].sort() },
        { by: "runtime:phase", reason: `${entry.subTaskId} xong (song song, worktree)` },
      );
    }

    if (failures.length > 0) {
      ctx.warnings.push(`${failures.length} task lỗi trong wave song song — giữ nguyên worktree để điều tra.`);
      for (const failure of failures) await this.#handleFailure(ctx, failure.subTaskId);
      ctx.nextActions.push(`Worktree còn nguyên: ${ready.map((entry) => entry.info.path).join(", ")}`);
      return false;
    }

    ctx.warnings.push(
      `Wave ${wave.index} chạy song song trong worktree riêng — CHƯA merge vào branch đang làm việc.`,
    );
    ctx.nextActions.push(`eng merge ${ctx.taskId}`);
    return true;
  }

  async #review(ctx: Ctx): Promise<void> {
    const plan = readPlan(ctx.taskId, this.#options.root);
    const done = (plan?.tasks ?? []).filter((task) => (task.status ?? "PENDING") === "DONE").map((task) => task.id);
    if (done.length === 0) {
      ctx.warnings.push("Không có task nào ở trạng thái DONE để review.");
    }
    for (const subTaskId of done) {
      const ok = await this.#runAgent(ctx, "reviewer", subTaskId);
      if (!ok) {
        await this.#handleFailure(ctx, subTaskId);
        return;
      }
      if (!this.#exists(ctx.taskId, relPath("reviews", `${subTaskId}-quality.md`))) {
        ctx.warnings.push(`${subTaskId}: thiếu reviews/${subTaskId}-quality.md (review 2 tầng chưa đủ).`);
      }
    }
    if (!this.#advance(ctx, "AUDITING")) {
      ctx.nextActions.push(
        `Reviewer phải ghi evidence SPEC_REVIEW + QUALITY_REVIEW (qua MCP record_evidence) rồi: eng audit ${ctx.taskId}`,
      );
      return;
    }
    ctx.nextActions.push(`eng audit ${ctx.taskId}`);
  }

  async #audit(ctx: Ctx): Promise<void> {
    const ok = await this.#runAgent(ctx, "auditor");
    if (!ok) {
      await this.#handleFailure(ctx);
      return;
    }
    if (!this.#advance(ctx, "VERIFYING")) {
      ctx.nextActions.push(`Auditor phải ghi evidence AUDIT rồi: eng verify ${ctx.taskId}`);
      return;
    }
    ctx.nextActions.push(`eng verify ${ctx.taskId}`);
  }

  async #verify(ctx: Ctx): Promise<void> {
    const evidence = await collectMechanicalEvidence(ctx.taskId, {
      kinds: ["build", "tests", "scope"],
      ...(this.#options.project ? { project: this.#options.project } : {}),
      ...(this.#lockToken ? { env: { ENG_WORKSTREAM_LOCK_TOKEN: this.#lockToken } } : {}),
    });
    ctx.steps.push(...evidence.steps);
    ctx.warnings.push(...evidence.errors);

    if (!evidence.mcpAvailable) {
      ctx.nextActions.push(
        "MCP không dùng được nên chưa thu được evidence cơ học — ghi tay: eng record <TASK_ID> --type BUILD|TEST|SCOPE_VALIDATION ...",
      );
      return;
    }
    if (!this.#advance(ctx, "DONE")) {
      ctx.nextActions.push("Còn thiếu evidence để DONE (xem cảnh báo) — chạy lại phần còn thiếu, KHÔNG nới gate.");
      return;
    }
    ctx.nextActions.push(`Ticket xong: eng resume ${ctx.taskId}`);
  }
}
