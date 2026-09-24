import { EngError } from "../errors.js";
import { mcpServerEnabled } from "../config/index.js";
import { McpStdioClient, serverSpecFromConfig, type McpServerSpec } from "../mcp/client.js";
import type { ContextBusinessRule, ContextLimits, ContextSymbol } from "./types.js";
import { DEFAULT_CONTEXT_LIMITS } from "./types.js";

export interface GatherInput {
  taskId: string;
  subTaskId: string;
  objective: string;
  files: string[];
  symbols: string[];
  tests: string[];
  policyIds: string[];
  project?: string;
}

export interface ContextGathering {
  symbols: ContextSymbol[];
  files: string[];
  tests: string[];
  businessRules: ContextBusinessRule[];
  existingPattern: string | null;
  similarCode: Array<{ file: string; score: number }>;
  callers: Array<{ file: string; line: number }>;
  architectureConstraints: string[];
  unknowns: string[];
  mcpQueries: Array<{ server: string; tool: string; args?: Record<string, unknown> }>;
  unavailable: string[];
  /**
   * Server bị TẮT theo config (`enabled: false`) — khác "không dùng được": đây là chủ ý.
   * Optional để provider tự viết (ngoài repo) không bị vỡ khi nâng cấp.
   */
  disabled?: string[];
}

/**
 * Port để ContextCompiler lấy dữ liệu.
 * Runtime không import `mcp-engineering` (package đó phụ thuộc runtime) — đi qua MCP protocol.
 */
export interface ContextProviders {
  readonly name: string;
  gather(input: GatherInput): Promise<ContextGathering>;
  close(): void;
}

function emptyGathering(input: GatherInput): ContextGathering {
  return {
    symbols: [],
    files: [...input.files],
    tests: [...input.tests],
    businessRules: [],
    existingPattern: null,
    similarCode: [],
    callers: [],
    architectureConstraints: [],
    unknowns: [],
    mcpQueries: [],
    unavailable: [],
    disabled: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Provider tối thiểu: chỉ dùng artifact đã có trong workstream (plan), KHÔNG truy cập repo/MCP.
 * Dùng khi MCP không khởi động được (`--no-mcp`) — context vẫn hợp lệ nhưng thiếu snippet,
 * và điều đó được ghi rõ vào `unknowns` thay vì suy diễn (INV-06).
 */
export class LocalContextProvider implements ContextProviders {
  readonly name = "local-artifacts";

  async gather(input: GatherInput): Promise<ContextGathering> {
    const gathering = emptyGathering(input);
    for (const symbol of input.symbols) {
      gathering.unknowns.push(
        `Chưa có snippet của ${symbol}: cần mcp-engineering (read_symbol/get_change_context). Chạy lại không dùng --no-mcp.`,
      );
    }
    if (input.files.length > 0) {
      gathering.unknowns.push("Chưa kiểm tra được existing pattern / callers trong repo vì không có MCP.");
    }
    return gathering;
  }

  close(): void {
    // không có tài nguyên cần đóng
  }
}

/** Plan thường ghi symbol dạng `PolicyService.checkPolicy`; MCP cần tên khai báo trần. */
function symbolName(raw: string): string {
  const parts = raw.split(/[.#]/).filter((part) => part !== "");
  return parts.length === 0 ? raw : (parts[parts.length - 1] as string);
}

/** Chọn file liên quan nhất cho một symbol dạng `Owner.member`. */
function fileForSymbol(files: string[], raw: string): string | undefined {
  const separator = raw.includes(".") ? "." : raw.includes("#") ? "#" : undefined;
  if (separator) {
    const owner = raw.split(separator)[0];
    if (owner) {
      const match = files.find((file) => file.includes(`${owner}.`));
      if (match) return match;
    }
  }
  return files[0];
}

export interface McpProviderOptions {
  engineering?: McpServerSpec;
  domain?: McpServerSpec;
  limits?: Partial<ContextLimits>;
  timeoutMs?: number;
}

/** Provider thật: gọi mcp-engineering (repo/code) + mcp-domain-core (domain). */
export class McpContextProvider implements ContextProviders {
  readonly name = "mcp";
  readonly #limits: ContextLimits;
  readonly #options: McpProviderOptions;
  #engineering?: McpStdioClient;
  #domain?: McpStdioClient;
  #started = false;
  #unavailable: string[] = [];
  #disabled: string[] = [];

  constructor(options: McpProviderOptions = {}) {
    this.#options = options;
    this.#limits = { ...DEFAULT_CONTEXT_LIMITS, ...(options.limits ?? {}) };
  }

  #client(server: "engineering" | "domain"): McpStdioClient {
    if (server === "engineering") {
      this.#engineering ??= new McpStdioClient(
        this.#options.engineering ?? serverSpecFromConfig("mcp-engineering"),
        { timeoutMs: this.#options.timeoutMs ?? 30_000 },
      );
      return this.#engineering;
    }
    this.#domain ??= new McpStdioClient(this.#options.domain ?? serverSpecFromConfig("mcp-domain-core"), {
      timeoutMs: this.#options.timeoutMs ?? 30_000,
    });
    return this.#domain;
  }

  async #ensureStarted(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    for (const server of ["engineering", "domain"] as const) {
      const serverName = server === "engineering" ? "mcp-engineering" : "mcp-domain-core";
      // Server bị tạm dừng theo config ⇒ KHÔNG spawn, ghi nhận riêng (không phải lỗi).
      if (!mcpServerEnabled(serverName)) {
        this.#disabled.push(serverName);
        continue;
      }
      try {
        await this.#client(server).start();
      } catch (error) {
        this.#unavailable.push(`${server}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async gather(input: GatherInput): Promise<ContextGathering> {
    await this.#ensureStarted();
    const gathering = emptyGathering(input);
    gathering.unavailable = [...this.#unavailable];
    gathering.disabled = [...this.#disabled];

    for (const name of this.#unavailable) {
      gathering.unknowns.push(`MCP không dùng được (${name}) — context thiếu phần dữ liệu tương ứng.`);
    }

    if (!this.#unavailable.includes("engineering") && !this.#disabled.includes("mcp-engineering")) {
      await this.#gatherFromEngineering(input, gathering);
    }
    if (!this.#unavailable.includes("domain") && !this.#disabled.includes("mcp-domain-core")) {
      await this.#gatherFromMbsm(input, gathering);
    }

    return gathering;
  }

  async #gatherFromEngineering(input: GatherInput, gathering: ContextGathering): Promise<void> {
    const client = this.#client("engineering");
    const projectArg = input.project ? { project: input.project } : {};

    // 1) symbol chính: definition + callers + tests (heuristic, ghi rõ confidence)
    for (const rawSymbol of input.symbols.slice(0, this.#limits.maxSymbols)) {
      const symbol = symbolName(rawSymbol);
      const targetFile = fileForSymbol(input.files, rawSymbol);
      let snippet: string | undefined;
      let lines: string | undefined;
      let reason = "khai báo trong plan";

      if (targetFile) {
        const args = { file: targetFile, symbol, ...projectArg };
        gathering.mcpQueries.push({ server: "mcp-engineering", tool: "get_change_context", args });
        const result = await client.callTool("get_change_context", args);
        const data = asRecord(result.data);
        const definition = asRecord(data["definition"]);
        if (result.ok && asString(definition["body"])) {
          snippet = asString(definition["body"]);
          const start = asNumber(definition["startLine"]);
          const end = asNumber(definition["endLine"]);
          if (start !== undefined && end !== undefined) lines = `${start}-${end}`;
          reason = "definition + callers + tests (get_change_context)";
        }
        for (const caller of asArray(data["callers"])) {
          const entry = asRecord(caller);
          const file = asString(entry["file"]);
          const line = asNumber(entry["line"]);
          if (file && line !== undefined) gathering.callers.push({ file, line });
        }
        for (const test of asArray(data["tests"])) {
          const file = asString(asRecord(test)["file"]);
          if (file) gathering.tests.push(file);
        }
      }

      if (snippet === undefined) {
        const args = { symbol, ...projectArg };
        gathering.mcpQueries.push({ server: "mcp-engineering", tool: "read_symbol", args });
        const result = await client.callTool("read_symbol", args);
        const data = asRecord(result.data);
        if (result.ok && asString(data["body"])) {
          snippet = asString(data["body"]);
          const start = asNumber(data["startLine"]);
          const end = asNumber(data["endLine"]);
          if (start !== undefined && end !== undefined) lines = `${start}-${end}`;
          const resolved = asString(data["file"]);
          if (resolved && !gathering.files.includes(resolved)) gathering.files.push(resolved);
          reason = "definition (read_symbol)";
        } else {
          gathering.unknowns.push(`Không tìm thấy khai báo của ${rawSymbol} trong repo — kiểm tra lại tên symbol.`);
        }
      }

      const symbolEntry: ContextSymbol = { name: rawSymbol, file: targetFile ?? "(chưa xác định)", reason };
      if (lines !== undefined) symbolEntry.lines = lines;
      if (snippet !== undefined) symbolEntry.snippet = snippet;
      gathering.symbols.push(symbolEntry);
    }

    // 2) architecture constraints từ repo (thay vì bắt agent đọc cả tài liệu)
    gathering.mcpQueries.push({ server: "mcp-engineering", tool: "get_architecture_constraints", args: projectArg });
    const constraints = await client.callTool("get_architecture_constraints", projectArg);
    if (constraints.ok) {
      const data = asRecord(constraints.data);
      for (const item of asArray(data["constraints"]).slice(0, this.#limits.maxArchitectureConstraints)) {
        const text = asString(asRecord(item)["text"]);
        if (text) gathering.architectureConstraints.push(text);
      }
    }

    // 3) code tương tự (anti-hallucination cho legacy)
    const similarArgs = { query: input.objective.slice(0, 200), maxResults: this.#limits.maxSimilar, ...projectArg };
    gathering.mcpQueries.push({ server: "mcp-engineering", tool: "find_similar_code", args: similarArgs });
    const similar = await client.callTool("find_similar_code", similarArgs);
    if (similar.ok) {
      for (const item of asArray(asRecord(similar.data)["results"])) {
        const entry = asRecord(item);
        const file = asString(entry["file"]);
        if (file) gathering.similarCode.push({ file, score: asNumber(entry["score"]) ?? 0 });
      }
    }
  }

  async #gatherFromMbsm(input: GatherInput, gathering: ContextGathering): Promise<void> {
    const client = this.#client("domain");

    // 4) rule nghiệp vụ của policy được nhắc tới trong task
    for (const policyId of input.policyIds.slice(0, 3)) {
      const args = { policyId, pageSize: this.#limits.maxRules };
      gathering.mcpQueries.push({ server: "mcp-domain-core", tool: "get_policy_rules", args });
      const result = await client.callTool("get_policy_rules", args);
      if (!result.ok) continue;
      const data = asRecord(result.data);
      const rules = asArray(data["rules"]).length > 0 ? asArray(data["rules"]) : [asRecord(data)["rule"]];
      for (const item of rules.slice(0, this.#limits.maxRules)) {
        const rule = asRecord(item);
        const id = asString(rule["id"]);
        const statement = asString(rule["statement"]);
        if (!id || !statement) continue;
        gathering.businessRules.push({
          id: `${policyId}/${id}`,
          statement,
          source: asString(rule["source"]) ?? `mcp-domain-core:get_policy_rules(${policyId})`,
          confidence: 0.9,
        });
      }
    }

    // 5) pattern đã dùng cho thay đổi tương tự
    const patternArgs = { description: input.objective.slice(0, 200), maxResults: 3 };
    gathering.mcpQueries.push({ server: "mcp-domain-core", tool: "find_existing_pattern", args: patternArgs });
    const pattern = await client.callTool("find_existing_pattern", patternArgs);
    if (pattern.ok) {
      const patterns = asArray(asRecord(pattern.data)["patterns"]);
      const top = asRecord(patterns[0]);
      const name = asString(top["name"]);
      if (name) {
        const steps = asArray(top["steps"]).map((step) => String(step));
        const example = asRecord(top["example"]);
        const ticket = asString(example["ticket"]);
        gathering.existingPattern = `${name}${ticket ? ` (ví dụ: ${ticket})` : ""}${steps.length > 0 ? ` — ${steps.slice(0, 4).join("; ")}` : ""}`;
      } else {
        gathering.unknowns.push("mcp-domain-core không tìm thấy pattern tương tự trong lịch sử thay đổi.");
      }
    }
  }

  close(): void {
    this.#engineering?.close();
    this.#domain?.close();
    this.#engineering = undefined;
    this.#domain = undefined;
  }
}

export function createProviders(options: { noMcp?: boolean; project?: string; limits?: Partial<ContextLimits> } = {}): ContextProviders {
  if (options.noMcp === true) return new LocalContextProvider();
  try {
    return new McpContextProvider(options.limits ? { limits: options.limits } : {});
  } catch (error) {
    if (error instanceof EngError) return new LocalContextProvider();
    throw error;
  }
}
