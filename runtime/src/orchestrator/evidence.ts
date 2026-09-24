import { McpStdioClient, serverSpecFromConfig } from "../mcp/client.js";
import type { PhaseStep } from "./types.js";

export type MechanicalEvidence = "build" | "tests" | "scope";

export interface EvidenceCollection {
  steps: PhaseStep[];
  recorded: Array<{ type: string; status: string; evidenceId?: string }>;
  errors: string[];
  mcpAvailable: boolean;
}

interface ToolOutcome {
  step: PhaseStep;
  evidence?: { type: string; status: string; evidenceId?: string };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Thu evidence CƠ HỌC (build / test / scope) qua mcp-engineering.
 *
 * Vì sao orchestrator tự chạy thay vì tin worker: đây là bằng chứng máy kiểm được,
 * không phải lời khai của agent. Worker vẫn phải tạo artifact của mình (report), nhưng
 * việc chạy test/kiểm scope do runtime thực hiện và ghi evidence kèm provenance (INV-12).
 */
export async function collectMechanicalEvidence(
  taskId: string,
  options: { project?: string; kinds: MechanicalEvidence[]; timeoutMs?: number; env?: Record<string, string> },
): Promise<EvidenceCollection> {
  const steps: PhaseStep[] = [];
  const recorded: EvidenceCollection["recorded"] = [];
  const errors: string[] = [];

  const client = new McpStdioClient(
    { ...serverSpecFromConfig("mcp-engineering"), ...(options.env ? { env: options.env } : {}) },
    { timeoutMs: options.timeoutMs ?? 600_000 },
  );

  try {
    await client.start();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    errors.push(`mcp-engineering không khởi động được: ${detail}`);
    for (const kind of options.kinds) {
      steps.push({
        name: `evidence:${kind}`,
        status: "skipped",
        detail: "MCP không dùng được — không ghi evidence cơ học (INV-06: không suy diễn kết quả)",
      });
    }
    return { steps, recorded, errors, mcpAvailable: false };
  }

  const projectArgs = options.project ? { project: options.project } : {};

  const run = async (
    kind: MechanicalEvidence,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolOutcome> => {
    const result = await client.callTool(tool, args);
    const data = asRecord(result.data);
    const evidenceRef = asRecord(data["evidence"]);
    const status = asString(data["status"]) ?? (result.ok ? "PASS" : "FAIL");
    const evidenceId = asString(evidenceRef["id"]);

    const step: PhaseStep = {
      name: `evidence:${kind}`,
      status: !result.ok ? "failed" : status === "PASS" ? "ok" : "failed",
      detail:
        asString(data["command"]) ??
        (result.ok ? `ghi evidence ${kind}=${status}` : `tool ${tool} lỗi: ${result.errorCode ?? result.errorMessage ?? "không rõ"}`),
    };
    if (evidenceId) {
      step.detail = `${step.detail} (evidence ${evidenceId})`;
      recorded.push({ type: kind === "tests" ? "TEST" : kind === "build" ? "BUILD" : "SCOPE_VALIDATION", status, evidenceId });
    }
    if (!result.ok) errors.push(`${tool}: ${result.errorCode ?? ""} ${result.errorMessage ?? ""}`.trim());
    return evidenceId ? { step, evidence: { type: kind, status, evidenceId } } : { step };
  };

  try {
    for (const kind of options.kinds) {
      if (kind === "build") {
        const outcome = await run("build", "run_build", { taskId, ...projectArgs });
        steps.push(outcome.step);
      } else if (kind === "tests") {
        const outcome = await run("tests", "run_tests", { taskId, ...projectArgs });
        steps.push(outcome.step);
      } else {
        const outcome = await run("scope", "validate_scope", { taskId, ...projectArgs });
        steps.push(outcome.step);
      }
    }
  } finally {
    client.close();
  }

  return { steps, recorded, errors, mcpAvailable: true };
}
