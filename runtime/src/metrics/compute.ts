import type {
  DomainEvent,
  Evidence,
  EvidenceStatus,
  EvidenceType,
  RiskLevel,
  TaskState,
  TaskStatus,
} from "../types.js";
import type { TaskContext } from "../context/types.js";
import { EVIDENCE_REQUIREMENTS, evaluateEvidenceGate } from "../evidence/rules.js";
import { REQUIRED_PROVENANCE } from "../evidence/store.js";
import { BLOCK_REASON_PREFIX, UNBLOCK_REASON } from "../state/store.js";
import { checkHumanGates } from "../state/gates.js";

/**
 * Metrics của MỘT ticket (spec mục 21) — chỉ tính từ dữ liệu ĐÃ GHI trong workstream:
 * task.json (history), context/*.json, evidence/*.json, events.jsonl.
 *
 * Nguyên tắc: không suy diễn số liệu không có nguồn. Metric nào hệ thống chưa ghi được
 * thì nằm trong `notMeasurable` kèm lý do và cách bổ sung — KHÔNG ước lượng thay.
 */
export interface TimeInStatus {
  status: TaskStatus;
  ms: number;
  sharePct: number;
}

export interface GateEpisode {
  gateId: string;
  transition: string;
  waitMs: number;
  open: boolean;
  required: boolean;
  satisfied: boolean;
  bypassed: boolean;
  /** Lý do bypass, đọc từ `task.json → gateBypasses` (không suy diễn từ approvals — INV-05/INV-12). */
  bypassReason?: string;
  approver?: string | null;
}

export interface BlockEpisode {
  reason: string;
  ms: number;
  open: boolean;
  at: string;
  mcpRelated: boolean;
}

export interface UncoveredTransition {
  at: string;
  transition: string;
  missing: string[];
}

export interface TierCost {
  tier: string;
  runs: number;
  failedRuns: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface CostMetrics {
  measurable: boolean;
  reason: string;
  runs: number;
  failedRuns: number;
  runsWithUsage: number;
  byTier: TierCost[];
  note: string;
}

export interface NotMeasurable {
  metric: string;
  why: string;
  howToEnable: string;
}

export interface TaskMetrics {
  taskId: string;
  generatedAt: string;
  status: TaskStatus;
  risk: RiskLevel;
  mode: string;
  /** Repo của ticket (multi-repo — spec 9.4). */
  projects: string[];
  window: { createdAt: string; updatedAt: string; wallMs: number };
  timeInStatus: TimeInStatus[];
  context: {
    subtasks: number;
    tokenEstimateTotal: number;
    tokenEstimateAvg: number;
    tokenEstimateMax: number;
    budgetLimit: number | null;
    truncated: number;
    estimate: true;
  };
  evidence: {
    total: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    /** Đếm evidence theo repo (multi-repo — spec 9.4); evidence không gắn repo nằm ở khoá "(không gắn repo)". */
    byProject: Record<string, number>;
    provenance: { complete: number; missingRequired: number; incomplete: { id: string; type: EvidenceType; missing: string[] }[] };
  };
  transitions: {
    total: number;
    gated: number;
    coveredAtTheTime: number;
    coveragePct: number;
    uncovered: UncoveredTransition[];
  };
  quality: {
    reviewRuns: number;
    reviewFailed: number;
    reviewRejectionRatePct: number | null;
    reworkTransitions: number;
  };
  process: {
    humanGates: GateEpisode[];
    humanWaitTotalMs: number;
    humanWaitMaxMs: number;
    humanApprovals: number;
  };
  ops: {
    blocked: BlockEpisode[];
    blockedTotalMs: number;
    blockedOpenMs: number;
    mcpBlockedEpisodes: number;
    mcpQueryBlocked: number;
  };
  cost: CostMetrics;
  notMeasurable: NotMeasurable[];
}

const WAITING_STATUSES: TaskStatus[] = ["WAITING_DESIGN_APPROVAL", "WAITING_PLAN_APPROVAL"];

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function missingProvenance(evidence: Evidence): string[] {
  const required = REQUIRED_PROVENANCE[evidence.type] ?? [];
  return required.filter((field) => {
    const value = (evidence as unknown as Record<string, unknown>)[field];
    return value === undefined || value === null || value === "";
  });
}

/** Timeline status: (createdAt, NEW) + mỗi history entry là một mốc thời gian → status. */
function statusTimeline(state: TaskState): { at: number; status: TaskStatus }[] {
  const base = state.createdAt || state.updatedAt;
  const points: { at: number; status: TaskStatus }[] = [{ at: Date.parse(base), status: "NEW" }];
  for (const entry of state.history ?? []) {
    const at = Date.parse(entry.at);
    if (Number.isNaN(at)) continue;
    points.push({ at, status: entry.to as TaskStatus });
  }
  const last = points[points.length - 1] as { at: number; status: TaskStatus };
  const end = Date.parse(state.updatedAt);
  if (!Number.isNaN(end) && end > last.at) points.push({ at: end, status: last.status });
  return points.filter((point) => !Number.isNaN(point.at)).sort((a, b) => a.at - b.at);
}

function timeInStatusOf(state: TaskState): TimeInStatus[] {
  const points = statusTimeline(state);
  const total = new Map<TaskStatus, number>();
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1] as { at: number; status: TaskStatus };
    const next = points[i] as { at: number; status: TaskStatus };
    const delta = Math.max(0, next.at - prev.at);
    total.set(prev.status, (total.get(prev.status) ?? 0) + delta);
  }
  const wall = points.length > 1 ? (points[points.length - 1] as { at: number }).at - (points[0] as { at: number }).at : 0;
  return [...total.entries()]
    .map(([status, ms]) => ({ status, ms, sharePct: pct(ms, wall) }))
    .sort((a, b) => b.ms - a.ms);
}

function blockEpisodes(state: TaskState): BlockEpisode[] {
  const episodes: BlockEpisode[] = [];
  let open: { at: number; reason: string } | null = null;
  const end = Date.parse(state.updatedAt);
  for (const entry of state.history ?? []) {
    const reason = entry.reason ?? "";
    const at = Date.parse(entry.at);
    if (Number.isNaN(at)) continue;
    if (reason.startsWith(BLOCK_REASON_PREFIX)) {
      if (open) episodes.push(closeBlock(open, at, false));
      open = { at, reason: reason.slice(BLOCK_REASON_PREFIX.length).trim() };
      continue;
    }
    if (reason === UNBLOCK_REASON && open) {
      episodes.push(closeBlock(open, at, false));
      open = null;
    }
  }
  if (open) episodes.push(closeBlock(open, Number.isNaN(end) ? (open as { at: number }).at : end, true));
  return episodes;
}

function closeBlock(open: { at: number; reason: string }, to: number, isOpen: boolean): BlockEpisode {
  const reason = open.reason;
  const episode: BlockEpisode = {
    reason,
    ms: Math.max(0, to - open.at),
    open: isOpen,
    at: new Date(open.at).toISOString(),
    mcpRelated: /\bmcp\b/i.test(reason),
  };
  return episode;
}

function gateEpisodes(state: TaskState, evidence: Evidence[]): GateEpisode[] {
  const episodes: GateEpisode[] = [];
  const history = state.history ?? [];
  for (let i = 0; i < history.length; i += 1) {
    const entry = history[i] as { at: string; from?: string | null; to: string };
    const from = entry.from as TaskStatus | null | undefined;
    if (!from || from === entry.to || !WAITING_STATUSES.includes(from)) continue;
    const at = Date.parse(entry.at);
    if (Number.isNaN(at)) continue;
    const available = evidence.filter((item) => Date.parse(item.timestamp) <= at);
    const check = checkHumanGates({ ...state, status: from }, entry.to, available)[0];
    if (!check) continue;
    // Bypass được ghi vào state.gateBypasses lúc transition; checkHumanGates() ở đây KHÔNG có
    // cờ allow-bypass của lần chạy đó nên không thể tự suy ra — đọc từ state mới đúng.
    const bypassReason = state.gateBypasses?.[check.gateId];
    const next = history.slice(i + 1).find((item) => Date.parse(item.at) > at);
    const closedAt = next ? Date.parse(next.at) : Date.parse(state.updatedAt);
    episodes.push({
      gateId: check.gateId,
      transition: check.transition,
      waitMs: Math.max(0, closedAt - at),
      open: !next,
      required: check.required,
      satisfied: check.satisfied,
      bypassed: bypassReason !== undefined || check.bypassed,
      ...(bypassReason !== undefined ? { bypassReason } : {}),
      approver: check.approver ?? null,
    });
  }
  return episodes;
}

function evidenceCoverage(state: TaskState, evidence: Evidence[], projects: string[] = []) {
  const uncovered: UncoveredTransition[] = [];
  let gated = 0;
  let covered = 0;
  for (const entry of state.history ?? []) {
    const to = entry.to as TaskStatus;
    if (entry.from === to) continue; // patch metadata không phải transition
    if ((EVIDENCE_REQUIREMENTS[to] ?? []).length === 0) continue;
    gated += 1;
    const at = Date.parse(entry.at);
    const available = evidence.filter((item) => Date.parse(item.timestamp) <= at);
    const evaluation = evaluateEvidenceGate(to, available, { risk: state.risk, ...(projects.length > 0 ? { projects } : {}) });
    if (evaluation.ok) covered += 1;
    else uncovered.push({ at: entry.at, transition: `${entry.from ?? "?"} → ${to}`, missing: evaluation.missing });
  }
  return { gated, covered, uncovered };
}

/**
 * Cost theo tier đọc từ event `AgentRun` do AgentRunner phát ra (role, modelTier, thời gian,
 * usage nếu harness báo). Không có event ⇒ chưa đo được, KHÔNG ước lượng từ số khác.
 */
function tokenOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function costOf(events: DomainEvent[], risk: RiskLevel): CostMetrics {
  const runs = events.filter((event) => event.type === "AgentRun");
  if (runs.length === 0) {
    return {
      measurable: false,
      reason: "chưa có event AgentRun nào — chưa lần nào chạy worker agent trên ticket này.",
      runs: 0,
      failedRuns: 0,
      runsWithUsage: 0,
      byTier: [],
      note: `risk=${risk}; cost quy ra tiền cần bảng giá theo tier (chưa có trong repo).`,
    };
  }

  const tiers = new Map<string, TierCost>();
  let failedRuns = 0;
  let runsWithUsage = 0;
  for (const run of runs) {
    const payload = run.payload ?? {};
    const tier = typeof payload["modelTier"] === "string" ? payload["modelTier"] : "(không rõ)";
    const entry = tiers.get(tier) ?? { tier, runs: 0, failedRuns: 0, durationMs: 0, inputTokens: null, outputTokens: null };
    entry.runs += 1;
    const durationMs = payload["durationMs"];
    if (typeof durationMs === "number" && Number.isFinite(durationMs)) entry.durationMs += Math.max(0, durationMs);
    if (payload["ok"] === false) {
      entry.failedRuns += 1;
      failedRuns += 1;
    }
    const usage = payload["usage"];
    if (typeof usage === "object" && usage !== null) {
      // Chỉ nhận token hợp lệ: số hữu hạn, không âm. Payload event có thể do producer khác ghi.
      const input = tokenOf((usage as Record<string, unknown>)["inputTokens"]);
      const output = tokenOf((usage as Record<string, unknown>)["outputTokens"]);
      if (input !== undefined || output !== undefined) {
        runsWithUsage += 1;
        entry.inputTokens = (entry.inputTokens ?? 0) + (input ?? 0);
        entry.outputTokens = (entry.outputTokens ?? 0) + (output ?? 0);
      }
    }
    tiers.set(tier, entry);
  }

  const byTier = [...tiers.values()].sort((a, b) => b.runs - a.runs);
  return {
    measurable: true,
    reason:
      runsWithUsage === runs.length
        ? "tier + thời gian + token đều có nguồn (harness báo usage)."
        : `tier + thời gian có nguồn; token chỉ có cho ${runsWithUsage}/${runs.length} lần chạy (harness chưa báo usage).`,
    runs: runs.length,
    failedRuns,
    runsWithUsage,
    byTier,
    note: `risk=${risk}; cost quy ra tiền cần bảng giá theo tier (chưa có trong repo).`,
  };
}

function countBy<T extends string>(items: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return out;
}

export interface MetricsInput {
  state: TaskState;
  evidence: Evidence[];
  contexts: TaskContext[];
  events: DomainEvent[];
  /** Repo của ticket (multi-repo — spec 9.4); rỗng/1 phần tử ⇒ xử lý như single-repo. */
  projects?: string[];
}

export function computeMetrics(input: MetricsInput): TaskMetrics {
  const { state, evidence, contexts, events } = input;
  const projects = input.projects ?? [];
  const createdAt = Date.parse(state.createdAt);
  const updatedAt = Date.parse(state.updatedAt);

  const tokenEstimates = contexts.map((context) => context.budget?.tokenEstimate ?? 0);
  const tokenTotal = tokenEstimates.reduce((sum, value) => sum + value, 0);
  const budgetLimits = contexts
    .map((context) => context.budget?.maxTokenBudget)
    .filter((value): value is number => typeof value === "number");

  const incomplete = evidence
    .map((item) => ({ id: item.id, type: item.type, missing: missingProvenance(item) }))
    .filter((item) => item.missing.length > 0);

  const coverage = evidenceCoverage(state, evidence, projects);
  const reviews = evidence.filter((item) => item.type === "SPEC_REVIEW" || item.type === "QUALITY_REVIEW");
  const reviewFailed = reviews.filter((item) => item.status !== "PASS").length;

  const blocks = blockEpisodes(state);
  const gates = gateEpisodes(state, evidence);
  const closedGates = gates.filter((gate) => !gate.open);

  return {
    taskId: state.taskId,
    generatedAt: new Date().toISOString(),
    status: state.status,
    risk: state.risk,
    mode: state.mode,
    projects,
    window: {
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      wallMs: Number.isNaN(createdAt) || Number.isNaN(updatedAt) ? 0 : Math.max(0, updatedAt - createdAt),
    },
    timeInStatus: timeInStatusOf(state),
    context: {
      subtasks: contexts.length,
      tokenEstimateTotal: tokenTotal,
      tokenEstimateAvg: contexts.length > 0 ? Math.round(tokenTotal / contexts.length) : 0,
      tokenEstimateMax: tokenEstimates.length > 0 ? Math.max(...tokenEstimates) : 0,
      budgetLimit: budgetLimits.length > 0 ? Math.min(...budgetLimits) : null,
      truncated: contexts.filter((context) => context.budget?.truncated === true).length,
      estimate: true,
    },
    evidence: {
      total: evidence.length,
      byType: countBy(evidence.map((item) => item.type)),
      byStatus: countBy(evidence.map((item) => item.status as EvidenceStatus)),
      byProject: countBy(evidence.map((item) => item.project ?? "(không gắn repo)")),
      provenance: { complete: evidence.length - incomplete.length, missingRequired: incomplete.length, incomplete },
    },
    transitions: {
      total: (state.history ?? []).length,
      gated: coverage.gated,
      coveredAtTheTime: coverage.covered,
      coveragePct: pct(coverage.covered, coverage.gated),
      uncovered: coverage.uncovered,
    },
    quality: {
      reviewRuns: reviews.length,
      reviewFailed,
      reviewRejectionRatePct: reviews.length > 0 ? pct(reviewFailed, reviews.length) : null,
      reworkTransitions: (state.history ?? []).filter(
        (entry) =>
          entry.from !== entry.to &&
          (entry.to === "REWORK_REQUIRED" || entry.to === "FAILED" || entry.to === "DEBUGGING"),
      ).length,
    },
    process: {
      humanGates: gates,
      humanWaitTotalMs: closedGates.reduce((sum, gate) => sum + gate.waitMs, 0),
      humanWaitMaxMs: closedGates.length > 0 ? Math.max(...closedGates.map((gate) => gate.waitMs)) : 0,
      humanApprovals: evidence.filter((item) => item.type === "HUMAN_APPROVAL" && item.status === "PASS").length,
    },
    ops: {
      blocked: blocks,
      blockedTotalMs: blocks.filter((block) => !block.open).reduce((sum, block) => sum + block.ms, 0),
      blockedOpenMs: blocks.filter((block) => block.open).reduce((sum, block) => sum + block.ms, 0),
      mcpBlockedEpisodes: blocks.filter((block) => block.mcpRelated).length,
      mcpQueryBlocked: evidence.filter((item) => item.type === "MCP_QUERY" && item.status === "BLOCKED").length,
    },
    cost: costOf(events, state.risk),
    notMeasurable: [
      {
        metric: "baseline token/thời gian so với cách làm hiện tại",
        why: "cần chạy song song một ticket thật bằng quy trình cũ để so — không suy ra được từ dữ liệu của chính hệ thống.",
        howToEnable: "chạy 1 ticket thật (spec mục 18.1 bước 20) và ghi lại số của quy trình cũ, rồi so với `eng metrics`.",
      },
      {
        metric: "regression escape rate",
        why: "cần dữ liệu lỗi lọt ra sau khi merge/release — hệ thống chỉ thấy trong ticket.",
        howToEnable: "nối nguồn bug/incident (Jira) vào event bus, hoặc ghi thủ công sau release.",
      },
      {
        metric: "cost/ticket quy ra tiền",
        why: "đã có tier + thời gian + token (khi harness báo usage), nhưng repo không có bảng giá theo tier nên không thể quy ra tiền.",
        howToEnable: "thêm pricePerMTokIn/pricePerMTokOut vào config/models.yaml → tiers, rồi nhân với token thật trong `cost`.",
      },
      {
        metric: "% context 'causal relevant'",
        why: "cần người chấm hoặc vòng đo can thiệp thủ công để biết phần context nào thực sự dùng.",
        howToEnable: "reviewer chấm trên context/task-NN.md khi review, ghi kết quả thành evidence.",
      },
    ],
  };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${restSeconds > 0 ? `${restSeconds}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 > 0 ? `${minutes % 60}m` : ""}`;
}

/** Bản markdown để ghi thành artifact `metrics.md` của workstream. */
export function renderMetrics(metrics: TaskMetrics): string {
  const lines: string[] = [];
  lines.push(`# Metrics — ${metrics.taskId}`, "");
  lines.push(
    `Trạng thái: **${metrics.status}** · risk=${metrics.risk} · mode=${metrics.mode} · ` +
      `tổng thời gian ${formatDuration(metrics.window.wallMs)} (${metrics.window.createdAt} → ${metrics.window.updatedAt})`,
    "",
  );
  lines.push("Nguồn: `task.json`, `context/*.json`, `evidence/*.json`, `events.jsonl`. Metric không có nguồn thì không tính.", "");

  lines.push("## Thời gian theo status", "");
  lines.push("| Status | Thời gian | Tỉ lệ |", "|---|---|---|");
  for (const row of metrics.timeInStatus) lines.push(`| ${row.status} | ${formatDuration(row.ms)} | ${row.sharePct}% |`);
  lines.push("");

  lines.push("## Context (ước lượng, không phải token provider)", "");
  if (metrics.context.subtasks === 0) lines.push("Chưa compile context nào.");
  else {
    lines.push(
      `- ${metrics.context.subtasks} context · tổng ~${metrics.context.tokenEstimateTotal} token · ` +
        `trung bình ~${metrics.context.tokenEstimateAvg} · lớn nhất ~${metrics.context.tokenEstimateMax}`,
    );
    lines.push(
      `- trần cấu hình: ${metrics.context.budgetLimit ?? "?"} token · bị cắt: ${metrics.context.truncated}`,
    );
  }
  lines.push("");

  lines.push("## Evidence", "");
  lines.push(`- tổng ${metrics.evidence.total} · provenance đủ ${metrics.evidence.provenance.complete}/${metrics.evidence.total}`);
  if (metrics.evidence.provenance.incomplete.length > 0) {
    for (const item of metrics.evidence.provenance.incomplete) {
      lines.push(`  - ${item.id} (${item.type}) thiếu: ${item.missing.join(", ")}`);
    }
  }
  lines.push(`- theo loại: ${Object.entries(metrics.evidence.byType).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}`);
  lines.push(`- theo kết quả: ${Object.entries(metrics.evidence.byStatus).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}`);
  if ((metrics.projects?.length ?? 0) > 1) {
    lines.push(
      `- theo repo: ${Object.entries(metrics.evidence.byProject).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}` +
        ` (multi-repo — gate DONE đòi BUILD/TEST/SCOPE_VALIDATION cho TỪNG repo)`,
    );
  }
  lines.push("");

  lines.push("## Evidence gate & human gate (INV-03, INV-05)", "");
  lines.push(
    `- transition cần evidence: ${metrics.transitions.gated} · hợp lệ tại thời điểm đó: ` +
      `${metrics.transitions.coveredAtTheTime} (${metrics.transitions.coveragePct}%)`,
  );
  for (const item of metrics.transitions.uncovered) {
    lines.push(`  - ⚠ ${item.at} ${item.transition} thiếu: ${item.missing.join("; ")}`);
  }
  if (metrics.process.humanGates.length === 0) lines.push("- chưa đi qua human gate nào");
  for (const gate of metrics.process.humanGates) {
    lines.push(
      `- gate ${gate.gateId} (${gate.transition}): chờ ${formatDuration(gate.waitMs)}` +
        `${gate.open ? " — đang mở" : ""}${gate.bypassed ? ` — BYPASSED${gate.bypassReason ? ` (${gate.bypassReason})` : ""}` : ""}` +
        `${gate.approver ? ` · approver ${gate.approver}` : ""}`,
    );
  }
  lines.push(`- human approval (PASS): ${metrics.process.humanApprovals}`);
  lines.push("");

  lines.push("## Chất lượng & vận hành", "");
  lines.push(
    `- review đã chạy: ${metrics.quality.reviewRuns} · không pass: ${metrics.quality.reviewFailed}` +
      ` · tỉ lệ phải làm lại: ${metrics.quality.reviewRejectionRatePct ?? "n/a"}%`,
  );
  lines.push(`- transition sang REWORK_REQUIRED/FAILED/DEBUGGING: ${metrics.quality.reworkTransitions}`);
  lines.push(
    `- BLOCKED: ${metrics.ops.blocked.length} lần · tổng ${formatDuration(metrics.ops.blockedTotalMs)}` +
      ` · do MCP: ${metrics.ops.mcpBlockedEpisodes} · MCP_QUERY blocked: ${metrics.ops.mcpQueryBlocked}`,
  );
  for (const block of metrics.ops.blocked) {
    lines.push(`  - ${block.at} ${formatDuration(block.ms)}${block.open ? " (đang mở)" : ""}: ${block.reason}`);
  }
  lines.push("");

  lines.push("## Cost — theo model tier thật đã dùng (event AgentRun)", "");
  if (!metrics.cost.measurable) {
    lines.push(`- chưa đo được: ${metrics.cost.reason}`);
  } else {
    lines.push(`- ${metrics.cost.runs} lần chạy agent · thất bại ${metrics.cost.failedRuns} · có usage: ${metrics.cost.runsWithUsage}/${metrics.cost.runs}`);
    lines.push(`- ${metrics.cost.reason}`);
    for (const tier of metrics.cost.byTier) {
      lines.push(
        `  - tier ${tier.tier}: ${tier.runs} lần · ${formatDuration(tier.durationMs)}` +
          (tier.inputTokens !== null || tier.outputTokens !== null
            ? ` · token in ${tier.inputTokens ?? "?"} / out ${tier.outputTokens ?? "?"}`
            : " · token: không có nguồn"),
      );
    }
    lines.push(`- ${metrics.cost.note}`);
  }
  lines.push("");

  lines.push("## Không đo được từ dữ liệu hiện có", "");
  for (const item of metrics.notMeasurable) {
    lines.push(`- **${item.metric}** — ${item.why} → cách bổ sung: ${item.howToEnable}`);
  }
  lines.push("");
  return lines.join("\n");
}
