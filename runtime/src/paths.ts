import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tìm gốc Engineering OS bằng cách dò ngược lên các dấu hiệu nhận biết,
 * để hoạt động đúng cả khi package được import qua node_modules (symlink).
 */
function detectOsRoot(): string {
  const fromEnv = process.env["ENGINEERING_OS_ROOT"];
  if (fromEnv) return path.resolve(fromEnv);

  let dir = here;
  for (let i = 0; i < 6; i += 1) {
    const hasConfig = existsSync(path.join(dir, "config", "mcp.yaml"));
    const hasSchemas = existsSync(path.join(dir, "schemas", "task.schema.json"));
    if (hasConfig && hasSchemas) return dir;
    const parent = path.resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(here, "..", "..");
}

export const OS_ROOT = detectOsRoot();

export function osPath(...segments: string[]): string {
  return path.join(OS_ROOT, ...segments);
}

const CONFIG_ENV: Record<string, string> = {
  mcp: "MCP_CONFIG",
  projects: "PROJECTS_CONFIG",
  models: "MODELS_CONFIG",
  gates: "GATES_CONFIG",
  risk: "RISK_CONFIG",
};

export function configPath(name: string): string {
  const override = CONFIG_ENV[name] ? process.env[CONFIG_ENV[name] as string] : undefined;
  return override ? path.resolve(override) : osPath("config", `${name}.yaml`);
}
