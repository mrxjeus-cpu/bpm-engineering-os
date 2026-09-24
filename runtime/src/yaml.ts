import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { EngError } from "./errors.js";

/** Đọc một file YAML thành object, lỗi rõ ràng nếu thiếu file hoặc YAML hỏng. */
export function loadYamlRaw<T>(file: string): T {
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new EngError("CONFIG_LOAD_FAILED", `Không đọc/parse được ${file}: ${String(error)}`, {
      hint: "Kiểm tra file có tồn tại và YAML hợp lệ.",
    });
  }
  if (typeof raw !== "object" || raw === null) {
    throw new EngError("CONFIG_INVALID", `${file} không phải object YAML.`);
  }
  return raw as T;
}
