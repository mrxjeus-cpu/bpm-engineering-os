/** Khớp schemas/context.schema.json — context package tối thiểu cho MỘT task con (spec mục 7.3). */
export interface ContextSymbol {
  name: string;
  file: string;
  lines?: string;
  snippet?: string;
  reason?: string;
}

export interface ContextBusinessRule {
  id: string;
  statement: string;
  source: string;
  confidence?: number;
}

export interface ContextMcpQuery {
  server: string;
  tool: string;
  args?: Record<string, unknown>;
}

export interface ContextProvenance {
  generatedAt: string;
  generatedBy: string;
  gitSha?: string;
  planRef?: string;
  architectureRef?: string;
  mcpQueries?: ContextMcpQuery[];
}

export interface ContextBudget {
  tokenEstimate?: number;
  maxTokenBudget?: number;
  truncated?: boolean;
}

export interface TaskContext {
  schemaVersion: 1;
  taskId: string;
  subTaskId: string;
  /** Repo (project trong config/projects.yaml) mà task này sửa — multi-repo, spec 9.4. */
  repo?: string;
  objective: string;
  files?: string[];
  symbols?: ContextSymbol[];
  existingPattern?: string | null;
  businessRules?: ContextBusinessRule[];
  constraints: string[];
  tests?: string[];
  acceptanceCriteria: string[];
  verificationCriteria: string[];
  dependencies?: string[];
  unknowns?: string[];
  provenance: ContextProvenance;
  budget?: ContextBudget;
}

export interface ContextLimits {
  maxTokens: number;
  maxSymbols: number;
  maxSnippetLines: number;
  maxSimilar: number;
  maxRules: number;
  maxArchitectureConstraints: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  maxTokens: 6000,
  maxSymbols: 4,
  maxSnippetLines: 40,
  maxSimilar: 5,
  maxRules: 12,
  maxArchitectureConstraints: 12,
};
