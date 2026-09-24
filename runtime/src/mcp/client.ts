import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { EngError } from "../errors.js";
import { OS_ROOT, configPath } from "../paths.js";
import { loadYamlRaw } from "../yaml.js";

export interface McpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpToolResult {
  ok: boolean;
  /** Payload JSON nếu tool trả JSON, ngược lại là text thô. */
  data: unknown;
  text: string;
  errorCode?: string;
  errorMessage?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * MCP client tối giản qua stdio (newline-delimited JSON-RPC).
 *
 * Vì sao runtime cần cái này: `mcp-engineering` phụ thuộc runtime, nên runtime KHÔNG được
 * import nó. Runtime nói chuyện với MCP qua giao thức — đúng phân tách "Skill = HOW, MCP = WHERE".
 */
export class McpStdioClient {
  readonly #spec: McpServerSpec;
  readonly #timeoutMs: number;
  #child?: ChildProcess;
  #buffer = "";
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #stderr = "";
  #failure?: EngError;

  constructor(spec: McpServerSpec, options: { timeoutMs?: number } = {}) {
    this.#spec = spec;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  get stderr(): string {
    return this.#stderr;
  }

  async start(): Promise<void> {
    const command = this.#spec.command === "node" ? process.execPath : this.#spec.command;
    const child = spawn(command, this.#spec.args, {
      cwd: this.#spec.cwd ?? OS_ROOT,
      env: { ...process.env, ...(this.#spec.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    child.on("error", (error) => {
      this.#failAll(new EngError("MCP_SERVER_UNREACHABLE", `Không chạy được MCP server (${this.#spec.command}): ${error.message}`));
    });
    child.on("exit", (code) => {
      this.#failAll(
        new EngError("MCP_SERVER_EXITED", `MCP server thoát (code ${String(code)}): ${this.#spec.command}`, {
          hint: `stderr: ${this.#stderr.trim().slice(-500) || "(trống)"}`,
        }),
      );
    });

    await this.#request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "engineering-os-runtime", version: "0.3.0" },
    });
    this.#notify("notifications/initialized", {});
  }

  async listTools(): Promise<string[]> {
    const result = (await this.#request("tools/list", {})) as { tools?: Array<{ name?: string }> };
    return (result.tools ?? []).map((tool) => tool.name ?? "").filter((name) => name !== "");
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    try {
      const result = (await this.#request("tools/call", { name, arguments: args })) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      };
      const text = (result.content ?? [])
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n");
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      const payload = data as { code?: string; message?: string } | null;
      const failed = result.isError === true;
      return {
        ok: !failed,
        data,
        text,
        ...(failed && payload?.code ? { errorCode: payload.code } : {}),
        ...(failed && payload?.message ? { errorMessage: payload.message } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        data: null,
        text: "",
        errorCode: error instanceof EngError ? error.code : "MCP_CALL_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  close(): void {
    this.#child?.kill();
    this.#child = undefined;
  }

  #notify(method: string, params: Record<string, unknown>): void {
    this.#child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new EngError("MCP_TIMEOUT", `MCP ${method} không phản hồi sau ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      index = this.#buffer.indexOf("\n");
      if (line === "") continue;

      let message: { id?: number; result?: unknown; error?: { code?: number; message?: string } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue;
      }
      if (message.id === undefined) continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${message.error.code ?? "?"}: ${message.error.message ?? "lỗi MCP"}`));
      else pending.resolve(message.result);
    }
  }

  #failAll(error: EngError): void {
    this.#failure = error;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }
}

interface McpConfigFile {
  servers?: Record<string, { command?: string; args?: string[] }>;
}

/** Tạo client cho một server khai báo trong config/mcp.yaml. */
export function serverSpecFromConfig(serverName: string): McpServerSpec {
  const config = loadYamlRaw<McpConfigFile>(configPath("mcp"));
  const server = config.servers?.[serverName];
  if (!server?.command || !server.args) {
    throw new EngError("MCP_SERVER_NOT_CONFIGURED", `config/mcp.yaml không khai báo servers.${serverName}.command/args`);
  }
  return {
    command: server.command,
    args: server.args.map((arg) => (path.isAbsolute(arg) ? arg : path.join(OS_ROOT, arg))),
    cwd: OS_ROOT,
  };
}
