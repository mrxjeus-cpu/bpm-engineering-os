import { loadConfig } from "../config/index.js";
import type { RiskLevel } from "../types.js";

export type Complexity = "simple" | "medium" | "complex";

export interface ModelDecision {
  role: string;
  tier: string;
  model: string;
  complexity: Complexity;
  risk: RiskLevel;
  reason: string;
}

function tierOrder(): string[] {
  return Object.keys(loadConfig().models.tiers);
}

function rank(tier: string): number {
  return tierOrder().indexOf(tier);
}

/** Suy ra độ phức tạp từ dấu hiệu khách quan (số file, dependency, kích thước context). */
export function inferComplexity(input: {
  files?: number;
  dependencies?: number;
  contextTokens?: number;
  risk?: RiskLevel;
}): Complexity {
  const files = input.files ?? 0;
  const dependencies = input.dependencies ?? 0;
  const tokens = input.contextTokens ?? 0;

  let score = 0;
  if (files >= 4) score += 2;
  else if (files >= 2) score += 1;
  if (dependencies >= 2) score += 2;
  else if (dependencies >= 1) score += 1;
  if (tokens >= 4000) score += 2;
  else if (tokens >= 1500) score += 1;
  if (input.risk === "HIGH") score += 1;
  if (input.risk === "CRITICAL") score += 2;

  if (score >= 4) return "complex";
  if (score >= 2) return "medium";
  return "simple";
}

/**
 * Model = f(role, complexity, risk) — không phải "cheapest" (spec mục 12).
 * Tier cuối = mức cao nhất trong {vai trò, sàn theo risk, complexity}, có áp trần/sàn của config.
 */
export function resolveModelDecision(input: {
  role: string;
  risk: RiskLevel;
  complexity?: Complexity;
  files?: number;
  dependencies?: number;
  contextTokens?: number;
}): ModelDecision {
  const { models } = loadConfig();
  const complexity = input.complexity ?? inferComplexity(input);

  const roleTier = models.agents[input.role] ?? models.routing.caps.fallback;
  const riskTier = models.riskFloor[input.risk] ?? roleTier;
  const complexityTier = models.complexity[complexity] ?? roleTier;

  const candidates: Array<{ source: string; tier: string }> = [
    { source: `vai trò ${input.role}`, tier: roleTier },
    { source: `sàn risk ${input.risk}`, tier: riskTier },
    { source: `complexity ${complexity}`, tier: complexityTier },
  ];

  let chosen = candidates.reduce((best, candidate) => (rank(candidate.tier) > rank(best.tier) ? candidate : best));

  const maxTier = models.routing.caps.maxTier;
  const minTier = models.routing.caps.minTier;
  if (rank(chosen.tier) > rank(maxTier)) chosen = { source: `trần ${maxTier}`, tier: maxTier };
  if (rank(chosen.tier) < rank(minTier)) chosen = { source: `sàn ${minTier}`, tier: minTier };

  const model = models.tiers[chosen.tier] ?? chosen.tier;
  const reason =
    candidates.map((candidate) => `${candidate.source}=${candidate.tier}`).join(" · ") +
    ` → ${chosen.tier} (${chosen.source})`;

  return { role: input.role, tier: chosen.tier, model, complexity, risk: input.risk, reason };
}
