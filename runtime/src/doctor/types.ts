import type { RiskLevel } from "../types.js";

export type CheckLevel = "ok" | "warn" | "fail";

/** Một kiểm tra tiền chạy (preflight). `hint` phải nói CÁCH SỬA, không chỉ nói sai. */
export interface DoctorCheck {
  id: string;
  title: string;
  level: CheckLevel;
  detail: string;
  hint?: string;
  /** Dữ liệu phụ để debug (không đưa vào kết luận pass/fail). */
  details?: Record<string, unknown>;
}

export interface DoctorSummary {
  ok: number;
  warn: number;
  fail: number;
  level: CheckLevel;
  exitCode: number;
}

export interface DoctorReport {
  generatedAt: string;
  osRoot: string;
  nodeVersion: string;
  platform: string;
  project?: string | undefined;
  checks: DoctorCheck[];
  summary: DoctorSummary;
}

export const RISK_LEVELS: RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export function summarize(checks: DoctorCheck[]): DoctorSummary {
  const ok = checks.filter((check) => check.level === "ok").length;
  const warn = checks.filter((check) => check.level === "warn").length;
  const fail = checks.filter((check) => check.level === "fail").length;
  const level: CheckLevel = fail > 0 ? "fail" : warn > 0 ? "warn" : "ok";
  return { ok, warn, fail, level, exitCode: fail > 0 ? 1 : 0 };
}

const MARK: Record<CheckLevel, string> = { ok: "✔", warn: "⚠", fail: "✖" };

export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`# eng doctor — ${report.platform} · Node ${report.nodeVersion}`);
  lines.push(`OS root: ${report.osRoot}${report.project !== undefined ? ` · project: ${report.project}` : ""}`);
  lines.push("");
  for (const check of report.checks) {
    lines.push(`${MARK[check.level]} ${check.id} — ${check.title}`);
    lines.push(`    ${check.detail}`);
    if (check.hint !== undefined) lines.push(`    → ${check.hint}`);
  }
  lines.push("");
  lines.push(
    `Kết luận: ${report.summary.ok} ok · ${report.summary.warn} warn · ${report.summary.fail} fail` +
      (report.summary.fail > 0 ? " — sửa hết FAIL trước khi chạy ticket thật." : ""),
  );
  if (report.summary.fail === 0 && report.summary.warn > 0) {
    lines.push("WARN không chặn chạy, nhưng mỗi mục đều là thứ sẽ làm phase chết giữa chừng hoặc làm mất evidence.");
  }
  return `${lines.join("\n")}\n`;
}
