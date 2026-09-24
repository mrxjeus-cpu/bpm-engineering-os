export type TaskStatus =
  | "NEW"
  | "TRANSLATING"
  | "REQUIREMENT_ANALYSIS"
  | "IMPACT_ANALYSIS"
  | "DESIGNING"
  | "WAITING_DESIGN_APPROVAL"
  | "PLANNING"
  | "WAITING_PLAN_APPROVAL"
  | "READY_TO_IMPLEMENT"
  | "IMPLEMENTING"
  | "FAILED"
  | "DEBUGGING"
  | "REVIEWING"
  | "REWORK_REQUIRED"
  | "AUDITING"
  | "VERIFYING"
  | "DONE";

export type TaskPhase =
  | "translate"
  | "requirements"
  | "impact"
  | "architecture"
  | "planning"
  | "implementation"
  | "review"
  | "audit"
  | "verification"
  | "done";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ExecutionMode = "safe" | "normal" | "autonomous";

export interface HistoryEntry {
  at: string;
  from?: string | null;
  to: string;
  by?: string;
  reason?: string;
  evidenceRef?: string;
}

/** Khớp schemas/task.schema.json. */
export interface TaskState {
  schemaVersion: 1;
  taskId: string;
  title?: string;
  status: TaskStatus;
  phase: TaskPhase;
  risk: RiskLevel;
  riskScore?: number;
  riskFactors?: string[];
  mode: ExecutionMode;
  currentWave?: number;
  currentTasks?: string[];
  completedTasks?: string[];
  blocked: boolean;
  blockReason?: string | null;
  domains?: string[];
  capabilities?: string[];
  approvals?: Record<string, boolean>;
  evidence?: string[];
  artifacts?: Record<string, string | null>;
  git?: { branch?: string; baseRef?: string; baseSha?: string; headSha?: string };
  history?: HistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

export type EvidenceType =
  | "TEST"
  | "BUILD"
  | "SPEC_REVIEW"
  | "QUALITY_REVIEW"
  | "AUDIT"
  | "GIT_DIFF"
  | "SCOPE_VALIDATION"
  | "HUMAN_APPROVAL"
  | "MCP_QUERY"
  | "SIMILAR_CODE_SEARCH";

export type EvidenceStatus = "PASS" | "FAIL" | "BLOCKED" | "INFO";

export interface EvidenceCheck {
  id: string;
  result: "PASS" | "FAIL" | "N/A";
  note?: string;
}

/** Khớp schemas/evidence.schema.json. */
export interface Evidence {
  schemaVersion: 1;
  id: string;
  taskId: string;
  subTaskId?: string | null;
  type: EvidenceType;
  status: EvidenceStatus;
  summary?: string;
  command?: string;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  gitSha?: string;
  artifact?: string;
  producer: string;
  gateId?: string | null;
  approver?: string | null;
  approvedAt?: string | null;
  comment?: string | null;
  checks?: EvidenceCheck[];
  unexpectedFiles?: string[];
  deletedFiles?: string[];
  mcpQuery?: Record<string, unknown>;
  timestamp: string;
  /** Đường dẫn tương đối trong workstream — chỉ có ở giá trị trả về, không lưu trong file. */
  path?: string;
}

export type NewEvidence = Omit<Evidence, "schemaVersion" | "id" | "timestamp" | "taskId" | "path"> &
  Partial<Pick<Evidence, "id" | "timestamp" | "subTaskId">>;

export type SubTaskStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "TESTING"
  | "SPEC_REVIEW"
  | "QUALITY_REVIEW"
  | "DONE"
  | "FAILED"
  | "REWORK_REQUIRED"
  | "BLOCKED";

export interface PlanTask {
  id: string;
  title: string;
  objective: string;
  files?: string[];
  symbols?: string[];
  existingPattern?: string | null;
  deviation?: string | null;
  businessRules?: string[];
  constraints?: string[];
  tests?: string[];
  dependencies: string[];
  acceptanceCriteria: string[];
  verification: string[];
  risk?: RiskLevel;
  modelTier?: string;
  status?: SubTaskStatus;
}

export interface PlanWave {
  index: number;
  tasks: string[];
  conflictCheck: "PASS" | "FAIL" | "NOT_RUN";
  conflicts?: string[];
}

/** Khớp schemas/plan.schema.json. */
export interface Plan {
  schemaVersion: 1;
  taskId: string;
  architectureRef?: string;
  generatedAt?: string;
  source?: string;
  tasks: PlanTask[];
  waves?: PlanWave[];
}

export type EventType =
  | "TaskCreated"
  | "RequirementCompleted"
  | "ImpactCompleted"
  | "DesignApproved"
  | "PlanCreated"
  | "TaskStarted"
  | "TaskCompleted"
  | "AgentRun"
  | "ReviewFailed"
  | "ReviewPassed"
  | "AuditFailed"
  | "AuditPassed"
  | "HumanApprovalRequired"
  | "Blocked"
  | "Completed";

/** Khớp schemas/event.schema.json. */
export interface DomainEvent {
  schemaVersion: 1;
  eventId: string;
  type: EventType;
  taskId: string;
  subTaskId?: string | null;
  at: string;
  actor: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  wave?: number | null;
  evidenceRef?: string | null;
  payload?: Record<string, unknown>;
}
