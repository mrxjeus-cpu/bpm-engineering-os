import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { dataDir, limits, serverConfig } from "./config.js";
import { ToolError } from "./errors.js";
import { overlapScore, tokenize } from "./text.js";

export interface Rule {
  id: string;
  title?: string;
  statement: string;
  condition?: string;
  effect?: string;
  tags?: string[];
  effectiveFrom?: string;
  source?: string;
}

export interface PolicyInput {
  id: string;
  type: string;
  required?: boolean;
  source?: string;
}

export interface PolicyDependency {
  policyId: string;
  type?: string;
  description?: string;
}

export interface Policy {
  id: string;
  code?: string;
  name: string;
  productId?: string;
  status?: string;
  version?: string;
  owner?: string;
  summary?: string;
  inputs?: PolicyInput[];
  outputs?: Array<Record<string, unknown>>;
  rules?: Rule[];
  dependencies?: PolicyDependency[];
  coreAdapter?: string;
  updatedAt?: string;
  source?: string;
}

export interface Product {
  id: string;
  code?: string;
  name: string;
  segment?: string;
  summary?: string;
  policies?: string[];
  channels?: string[];
  status?: string;
  source?: string;
}

export interface FactField {
  name: string;
  type: string;
  required?: boolean;
  values?: string[];
  note?: string;
}

export interface FactType {
  id: string;
  name: string;
  provider?: string;
  summary?: string;
  fields?: FactField[];
  usedByPolicies?: string[];
  source?: string;
}

export interface CoreMapping {
  policyId: string;
  adapter: string;
  target?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  notes?: string;
  source?: string;
}

export interface ChangeRecord {
  id: string;
  ticket: string;
  date: string;
  title: string;
  description: string;
  policies?: string[];
  factTypes?: string[];
  files?: string[];
  pattern?: { name?: string; steps?: string[]; reusable?: boolean; risk?: string };
  outcome?: string;
  source?: string;
}

interface Dataset {
  products: Product[];
  policies: Policy[];
  factTypes: FactType[];
  coreMappings: CoreMapping[];
  changes: ChangeRecord[];
}

let cache: Dataset | null = null;

function readJson<T>(file: string): T {
  const abs = path.join(dataDir(), file);
  if (!existsSync(abs)) {
    throw new ToolError(
      "DATASET_MISSING",
      `Không tìm thấy dataset: ${abs}`,
      "Kiểm tra config/mcp.yaml → servers.mcp-domain-core.data.dir, hoặc set env DOMAIN_DATA_DIR. " +
        "Không suy diễn dữ liệu domain khi thiếu nguồn (INV-06).",
    );
  }
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as T;
  } catch (error) {
    throw new ToolError("DATASET_INVALID", `Dataset ${abs} không parse được: ${String(error)}`);
  }
}

export function dataset(): Dataset {
  if (!cache) {
    const products = readJson<{ products: Product[] }>("products.json").products ?? [];
    const policies = readJson<{ policies: Policy[] }>("policies.json").policies ?? [];
    const factTypes = readJson<{ factTypes: FactType[] }>("facts.json").factTypes ?? [];
    const coreMappings = readJson<{ coreMappings: CoreMapping[] }>("core.json").coreMappings ?? [];
    const changes = readJson<{ changes: ChangeRecord[] }>("changes.json").changes ?? [];
    cache = { products, policies, factTypes, coreMappings, changes };
  }
  return cache;
}

export function isSynthetic(): boolean {
  return serverConfig().data.synthetic;
}

export function requirePolicy(policyId: string): Policy {
  const found = dataset().policies.find((p) => p.id === policyId);
  if (!found) {
    throw new ToolError(
      "POLICY_NOT_FOUND",
      `Không có policy "${policyId}" trong dataset.`,
      `Policy có sẵn: ${dataset().policies.map((p) => p.id).join(", ")}. Không suy diễn policy (INV-06).`,
    );
  }
  return found;
}

export function requireProduct(productId: string): Product {
  const found = dataset().products.find((p) => p.id === productId);
  if (!found) {
    throw new ToolError(
      "PRODUCT_NOT_FOUND",
      `Không có product "${productId}" trong dataset.`,
      `Product có sẵn: ${dataset().products.map((p) => p.id).join(", ")}.`,
    );
  }
  return found;
}

export function requireFactType(factTypeId: string): FactType {
  const found = dataset().factTypes.find((f) => f.id === factTypeId);
  if (!found) {
    throw new ToolError(
      "FACT_TYPE_NOT_FOUND",
      `Không có fact type "${factTypeId}".`,
      `Fact type có sẵn: ${dataset().factTypes.map((f) => f.id).join(", ")}.`,
    );
  }
  return found;
}

export function requireCoreMapping(policyId: string): CoreMapping {
  const found = dataset().coreMappings.find((m) => m.policyId === policyId);
  if (!found) {
    throw new ToolError(
      "CORE_MAPPING_NOT_FOUND",
      `Policy "${policyId}" chưa có core mapping.`,
      `Policy có mapping: ${dataset().coreMappings.map((m) => m.policyId).join(", ")}.`,
    );
  }
  return found;
}

/** Progressive disclosure: find_* chỉ trả summary (spec mục 7.4, 13.1). */
export function policySummary(policy: Policy): Record<string, unknown> {
  return {
    id: policy.id,
    code: policy.code,
    name: policy.name,
    productId: policy.productId,
    status: policy.status,
    version: policy.version,
    inputs: (policy.inputs ?? []).map((i) => i.id),
    rulesCount: (policy.rules ?? []).length,
    dependencies: (policy.dependencies ?? []).map((d) => d.policyId),
    source: policy.source,
  };
}

export function paginate<T>(items: T[], page?: number, pageSize?: number): {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  truncated: boolean;
} {
  const cfg = limits();
  const currentPage = Math.max(1, page ?? 1);
  const size = Math.min(Math.max(pageSize ?? cfg.pagination.defaultPageSize, 1), cfg.pagination.maxPageSize);
  const start = (currentPage - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    items: slice,
    page: currentPage,
    pageSize: size,
    totalItems: items.length,
    totalPages: Math.max(1, Math.ceil(items.length / size)),
    truncated: start + slice.length < items.length,
  };
}

export function searchScored<T>(
  items: T[],
  query: string,
  toText: (item: T) => string,
  maxResults: number,
): Array<{ item: T; score: number }> {
  const tokens = tokenize(query);
  return items
    .map((item) => ({ item, score: Math.round(overlapScore(tokens, toText(item)) * 100) / 100 }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

export function sourceTag(): Record<string, unknown> {
  return {
    _synthetic: isSynthetic(),
    datasetDir: dataDir(),
    ...(isSynthetic() ? { warning: "DỮ LIỆU HƯ CẤU — không dùng để kết luận nghiệp vụ thật." } : {}),
  };
}
