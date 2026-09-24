import { loadConfig } from "../config/index.js";
import { McpStdioClient, serverSpecFromConfig } from "../mcp/client.js";
import { OS_ROOT } from "../paths.js";
import {
  checkConfig,
  checkGates,
  checkGit,
  checkHarness,
  checkMcp,
  checkModels,
  checkNode,
  checkOsRoot,
  checkProjects,
  checkRisk,
  checkSkills,
} from "./checks.js";
import { renderDoctor, summarize, type DoctorCheck, type DoctorReport } from "./types.js";

export interface DoctorOptions {
  /** Chỉ kiểm project này (các project khác bị bỏ qua). */
  project?: string;
  /** Khởi động THẬT 2 MCP server và list tool — chậm hơn nhưng là bằng chứng thật. */
  ping?: boolean;
  /** Số ms tối đa cho mỗi MCP server khi --ping. */
  pingTimeoutMs?: number;
}

/**
 * `eng doctor` — preflight trước khi chạy ticket thật.
 *
 * Vì sao cần: rủi ro R1/R2 của spec là môi trường (Windows/PATH/hook/MCP chưa build). Chết giữa
 * phase tốn thời gian hơn nhiều so với 2 giây kiểm tra trước. Doctor KHÔNG gọi LLM và không chạy
 * harness — chỉ `--ping` mới khởi động MCP server.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(checkNode());
  checks.push(checkOsRoot());
  try {
    checks.push(checkConfig());
  } catch (error) {
    checks.push({
      id: "config",
      title: "5 file config hợp lệ",
      level: "fail",
      detail: String(error),
      hint: "Sửa YAML trong config/ (xem `eng config`) rồi chạy lại doctor.",
    });
    return finish(checks, options);
  }
  checks.push(checkGates());
  checks.push(checkRisk());
  checks.push(...checkModels());
  checks.push(checkHarness());
  checks.push(checkMcp());
  checks.push(checkSkills());
  checks.push(await checkGit());
  checks.push(...(await checkProjects(options.project)));
  if (options.ping === true) checks.push(await checkMcpPing(options.pingTimeoutMs ?? 30_000));
  return finish(checks, options);
}

function finish(checks: DoctorCheck[], options: DoctorOptions): DoctorReport {
  return {
    generatedAt: new Date().toISOString(),
    osRoot: OS_ROOT,
    nodeVersion: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    project: options.project,
    checks,
    summary: summarize(checks),
  };
}

/** Bằng chứng thật: spawn từng MCP server ĐANG BẬT và list tool. Server tắt chỉ ghi chú. */
export async function checkMcpPing(timeoutMs: number): Promise<DoctorCheck> {
  const config = loadConfig();
  const names = Object.keys(config.mcp.servers);
  const results: string[] = [];
  const failures: string[] = [];
  for (const name of names) {
    // Server tạm dừng: không spawn, nêu rõ trạng thái thay vì im lặng.
    if (config.mcp.servers[name]?.enabled === false) {
      results.push(`${name}: TẮT (enabled: false)`);
      continue;
    }
    const client = new McpStdioClient(serverSpecFromConfig(name), { timeoutMs });
    try {
      await client.start();
      const tools = await client.listTools();
      const groups = Object.keys(config.mcp.servers[name]?.groups ?? {}).length;
      results.push(`${name}: ${tools.length} tool / ${groups} group`);
    } catch (error) {
      failures.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}` +
          (client.stderr.trim() === "" ? "" : ` — stderr: ${client.stderr.trim().split("\n").slice(-2).join(" | ")}`),
      );
    } finally {
      client.close();
    }
  }
  if (failures.length > 0) {
    return {
      id: "mcp-ping",
      title: "MCP server khởi động thật + list tool",
      level: "fail",
      detail: failures.join(" · "),
      hint: "Chạy `npm run build`, rồi thử tay: node mcp/mcp-engineering/dist/index.js (phải im lặng và chờ JSON-RPC trên stdin).",
    };
  }
  return { id: "mcp-ping", title: "MCP server khởi động thật + list tool", level: "ok", detail: results.join(" · ") };
}

export { renderDoctor };
export type { DoctorReport, DoctorCheck };
