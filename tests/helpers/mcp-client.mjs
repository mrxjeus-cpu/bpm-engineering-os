import { spawn } from "node:child_process";

/**
 * Client JSON-RPC tối giản cho MCP stdio transport (newline-delimited JSON).
 * Không dùng SDK để test đúng thứ mà client thật sẽ gửi qua đường dây.
 */
export class McpClient {
  #child;
  #buffer = "";
  #pending = new Map();
  #nextId = 1;
  stderr = "";

  constructor({ command, args = [], env = {}, cwd }) {
    this.#child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: { ...process.env, ...env },
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      index = this.#buffer.indexOf("\n");
      if (line === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // log không phải JSON-RPC (server ghi ra stderr nên thường không có)
      }
      if (message.id === undefined || !this.#pending.has(message.id)) continue;
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
    }
  }

  request(method, params) {
    const id = this.#nextId++;
    const payload = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`timeout khi gọi ${method}`));
        }
      }, 30000);
    });
  }

  notify(method, params) {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`);
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
    return result;
  }

  listTools() {
    return this.request("tools/list", {});
  }

  async callTool(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    const text = (result?.content ?? [])
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // giữ nguyên text nếu không phải JSON
    }
    return { isError: result?.isError === true, text, data };
  }

  close() {
    this.#child.kill();
  }
}
