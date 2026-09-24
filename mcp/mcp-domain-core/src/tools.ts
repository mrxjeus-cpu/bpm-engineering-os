import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type ChangeRecord,
  type Policy,
  dataset,
  paginate,
  policySummary,
  requireCoreMapping,
  requireFactType,
  requirePolicy,
  requireProduct,
  searchScored,
  sourceTag,
} from "./data.js";
import { type ToolContent, ToolError, fail, ok } from "./errors.js";
import { overlapScore, tokenize } from "./text.js";

type Group = "product" | "policy" | "fact" | "core" | "reference";

interface ToolDef {
  group: Group;
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => ToolContent;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

function policySearchText(policy: Policy): string {
  return [
    policy.id,
    policy.code ?? "",
    policy.name,
    policy.summary ?? "",
    (policy.inputs ?? []).map((i) => i.id).join(" "),
    (policy.rules ?? []).map((r) => `${r.id} ${r.title ?? ""} ${r.statement}`).join(" "),
  ].join("\n");
}

function changeSearchText(change: ChangeRecord): string {
  return [
    change.title,
    change.description,
    change.ticket,
    (change.policies ?? []).join(" "),
    (change.pattern?.steps ?? []).join(" "),
    change.pattern?.name ?? "",
  ].join("\n");
}

function defs(): ToolDef[] {
  const list: ToolDef[] = [];
  const add = (def: ToolDef): void => {
    list.push(def);
  };

  // ------------------------------------------------------------------ product
  add({
    group: "product",
    name: "find_product",
    title: "Find product",
    description: "Tìm sản phẩm theo mô tả/từ khóa. Chỉ trả summary (progressive disclosure).",
    inputSchema: {
      query: z.string().optional(),
      page: z.number().int().positive().optional(),
      pageSize: z.number().int().positive().max(50).optional(),
    },
    handler: (args) => {
      const query = str(args, "query");
      const products = dataset().products;
      const matched = query
        ? searchScored(products, query, (p) => [p.id, p.code ?? "", p.name, p.summary ?? "", p.segment ?? ""].join(" "), products.length).map((entry) => entry.item)
        : products;
      const page = paginate(matched, num(args, "page"), num(args, "pageSize"));
      return ok({
        ...sourceTag(),
        query: query ?? null,
        products: page.items.map((p) => ({
          id: p.id,
          code: p.code,
          name: p.name,
          segment: p.segment,
          policies: p.policies,
          status: p.status,
          source: p.source,
        })),
        pagination: { page: page.page, pageSize: page.pageSize, totalItems: page.totalItems, totalPages: page.totalPages, truncated: page.truncated },
      });
    },
  });

  add({
    group: "product",
    name: "get_product",
    title: "Get product details",
    description: "Chi tiết một sản phẩm + danh sách policy kèm số rule.",
    inputSchema: { productId: z.string() },
    handler: (args) => {
      const productId = str(args, "productId");
      if (!productId) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số productId.");
      const product = requireProduct(productId);
      const policies = (product.policies ?? [])
        .map((id) => dataset().policies.find((p) => p.id === id))
        .filter((p): p is Policy => p !== undefined)
        .map((p) => ({ id: p.id, name: p.name, version: p.version, rulesCount: (p.rules ?? []).length, source: p.source }));
      return ok({ ...sourceTag(), product, policies });
    },
  });

  // ------------------------------------------------------------------- policy
  add({
    group: "policy",
    name: "find_policy",
    title: "Find policy (summary)",
    description:
      "Tìm policy theo từ khóa hoặc theo product. Chỉ trả SUMMARY (id, tên, inputs, số rule) — chi tiết lấy qua get_policy/get_policy_rules.",
    inputSchema: {
      query: z.string().optional(),
      productId: z.string().optional(),
      page: z.number().int().positive().optional(),
      pageSize: z.number().int().positive().max(50).optional(),
    },
    handler: (args) => {
      const query = str(args, "query");
      const productId = str(args, "productId");
      let policies = dataset().policies;
      if (productId) policies = policies.filter((p) => p.productId === productId);
      if (query) {
        policies = searchScored(policies, query, policySearchText, policies.length).map((entry) => entry.item);
      }
      const page = paginate(policies, num(args, "page"), num(args, "pageSize"));
      return ok({
        ...sourceTag(),
        query: query ?? null,
        productId: productId ?? null,
        policies: page.items.map(policySummary),
        pagination: { page: page.page, pageSize: page.pageSize, totalItems: page.totalItems, totalPages: page.totalPages, truncated: page.truncated },
        next: "Dùng get_policy(policyId) để lấy chi tiết, get_policy_rules(policyId) để lấy rule.",
      });
    },
  });

  add({
    group: "policy",
    name: "get_policy",
    title: "Get policy metadata",
    description: "Metadata policy (inputs, outputs, dependencies, core adapter). KHÔNG trả rules — dùng get_policy_rules.",
    inputSchema: { policyId: z.string() },
    handler: (args) => {
      const policyId = str(args, "policyId");
      if (!policyId) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số policyId.");
      const policy = requirePolicy(policyId);
      return ok({
        ...sourceTag(),
        policy: {
          id: policy.id,
          code: policy.code,
          name: policy.name,
          productId: policy.productId,
          status: policy.status,
          version: policy.version,
          owner: policy.owner,
          summary: policy.summary,
          inputs: policy.inputs,
          outputs: policy.outputs,
          dependencies: policy.dependencies,
          coreAdapter: policy.coreAdapter,
          rulesCount: (policy.rules ?? []).length,
          updatedAt: policy.updatedAt,
          source: policy.source,
        },
        next: "get_policy_rules(policyId) cho nội dung rule; get_policy_inputs(policyId) cho input schema.",
      });
    },
  });

  add({
    group: "policy",
    name: "get_policy_inputs",
    title: "Get policy inputs",
    description: "Input của policy, kèm field schema nếu input là fact type.",
    inputSchema: { policyId: z.string() },
    handler: (args) => {
      const policyId = str(args, "policyId");
      if (!policyId) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số policyId.");
      const policy = requirePolicy(policyId);
      const inputs = (policy.inputs ?? []).map((input) => {
        const fact = dataset().factTypes.find((f) => f.id === input.id);
        return {
          ...input,
          ...(fact ? { factFields: (fact.fields ?? []).map((field) => ({ name: field.name, type: field.type, required: field.required ?? false, note: field.note })) } : {}),
        };
      });
      return ok({ ...sourceTag(), policyId, inputs, source: policy.source });
    },
  });

  add({
    group: "policy",
    name: "get_policy_rules",
    title: "Get policy rules",
    description: "Rule của policy (có phân trang). Truyền ruleId để lấy đúng một rule.",
    inputSchema: {
      policyId: z.string(),
      ruleId: z.string().optional(),
      page: z.number().int().positive().optional(),
      pageSize: z.number().int().positive().max(50).optional(),
    },
    handler: (args) => {
      const policyId = str(args, "policyId");
      if (!policyId) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số policyId.");
      const policy = requirePolicy(policyId);
      const rules = policy.rules ?? [];
      const ruleId = str(args, "ruleId");
      if (ruleId) {
        const rule = rules.find((r) => r.id === ruleId);
        if (!rule) {
          throw new ToolError(
            "RULE_NOT_FOUND",
            `Policy ${policyId} không có rule "${ruleId}".`,
            `Rule có sẵn: ${rules.map((r) => r.id).join(", ") || "(không có)"}. Không suy diễn rule (INV-06).`,
          );
        }
        return ok({ ...sourceTag(), policyId, rule, source: rule.source ?? policy.source });
      }
      const page = paginate(rules, num(args, "page"), num(args, "pageSize"));
      return ok({
        ...sourceTag(),
        policyId,
        rules: page.items,
        pagination: { page: page.page, pageSize: page.pageSize, totalItems: page.totalItems, totalPages: page.totalPages, truncated: page.truncated },
        source: policy.source,
      });
    },
  });

  add({
    group: "policy",
    name: "get_policy_dependencies",
    title: "Get policy dependencies",
    description: "Dependency trực tiếp của policy (precondition / fact-provider / rule-reference).",
    inputSchema: { policyId: z.string() },
    handler: (args) => {
      const policyId = str(args, "policyId");
      if (!policyId) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số policyId.");
      const policy = requirePolicy(policyId);
      const dependencies = (policy.dependencies ?? []).map((dep) => ({
        ...dep,
        targetName: dataset().policies.find((p) => p.id === dep.policyId)?.name ?? null,
        resolved: dataset().policies.some((p) => p.id === dep.policyId),
      }));
      return ok({ ...sourceTag(), policyId, dependencies, source: policy.source });
    },
  });

  add({
    group: "policy",
    name: "trace_policy_dependency",
    title: "Trace policy dependency graph",
    description:
      "Duyệt đồ thị dependency của policy (downstream = policy này phụ thuộc; upstream = policy nào phụ thuộc nó). " +
      "Dùng cho impact analysis thay vì tự mò repo.",
    inputSchema: {
      policyId: z.string(),
      direction: z.enum(["downstream", "upstream", "both"]).optional(),
      maxDepth: z.number().int().positive().max(10).optional(),
    },
    handler: (args) => {
      const policyId = str(args, "policyId");
      if (!policyId) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số policyId.");
      requirePolicy(policyId);
      const directionRaw = str(args, "direction") ?? "both";
      const direction = (["downstream", "upstream", "both"].includes(directionRaw) ? directionRaw : "both") as
        | "downstream"
        | "upstream"
        | "both";
      const maxDepth = num(args, "maxDepth") ?? 5;

      const edges: Array<{ from: string; to: string; type?: string }> = [];
      for (const policy of dataset().policies) {
        for (const dep of policy.dependencies ?? []) {
          if (!dataset().policies.some((p) => p.id === dep.policyId)) continue;
          edges.push({ from: policy.id, to: dep.policyId, ...(dep.type ? { type: dep.type } : {}) });
        }
      }

      const start = policyId;
      const visited = new Set<string>([start]);
      const collected: Array<{ id: string; depth: number; via: string }> = [];
      let frontier = [start];

      for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
        const next: string[] = [];
        for (const node of frontier) {
          const related: Array<{ id: string; via: string }> = [];
          if (direction === "downstream" || direction === "both") {
            for (const edge of edges.filter((e) => e.from === node)) related.push({ id: edge.to, via: `${node} → ${edge.to}` });
          }
          if (direction === "upstream" || direction === "both") {
            for (const edge of edges.filter((e) => e.to === node)) related.push({ id: edge.from, via: `${edge.from} → ${node}` });
          }
          for (const rel of related) {
            if (visited.has(rel.id)) continue;
            visited.add(rel.id);
            collected.push({ id: rel.id, depth, via: rel.via });
            next.push(rel.id);
          }
        }
        frontier = next;
      }

      return ok({
        ...sourceTag(),
        root: policyId,
        direction,
        maxDepth,
        nodes: collected.map((node) => {
          const policy = dataset().policies.find((p) => p.id === node.id);
          return {
            id: node.id,
            name: policy?.name ?? null,
            depth: node.depth,
            via: node.via,
            resolved: policy !== undefined,
            source: policy?.source ?? null,
          };
        }),
        edges,
        note: "Quan hệ dependency lấy từ dataset policy; không suy diễn quan hệ ngoài dữ liệu.",
      });
    },
  });

  // --------------------------------------------------------------------- fact
  const factTool = (name: string, factTypeId: string, description: string): ToolDef => ({
    group: "fact",
    name,
    title: `Find ${factTypeId}`,
    description,
    inputSchema: {
      query: z.string().optional().describe("Lọc theo tên/ghi chú field"),
      page: z.number().int().positive().optional(),
      pageSize: z.number().int().positive().max(50).optional(),
    },
    handler: (args) => {
      const factType = requireFactType(factTypeId);
      const query = str(args, "query");
      const fields = factType.fields ?? [];
      const filtered = query
        ? fields.filter((field) => overlapScore(tokenize(query), `${field.name} ${field.note ?? ""} ${field.type}`) > 0)
        : fields;
      const page = paginate(filtered, num(args, "page"), num(args, "pageSize"));
      return ok({
        ...sourceTag(),
        factType: { id: factType.id, name: factType.name, provider: factType.provider, summary: factType.summary },
        fields: page.items,
        usedByPolicies: factType.usedByPolicies,
        pagination: { page: page.page, pageSize: page.pageSize, totalItems: page.totalItems, totalPages: page.totalPages, truncated: page.truncated },
        source: factType.source,
      });
    },
  });

  add(factTool("find_customer_facts", "CustomerFact", "Field của CustomerFact (tuổi, thu nhập, vùng...)."));
  add(factTool("find_loan_facts", "LoanFact", "Field của LoanFact (số tiền, kỳ hạn, mục đích vay, tài sản bảo đảm...)."));
  add(factTool("find_cic_facts", "CICFact", "Field của CICFact (nhóm CIC, phân loại nợ, quá hạn...)."));

  // --------------------------------------------------------------------- core
  add({
    group: "core",
    name: "get_core_input_schema",
    title: "Get core input schema",
    description: "JSON schema input mà Core adapter của policy yêu cầu.",
    inputSchema: { policyId: z.string() },
    handler: (args) => {
      const policyId = str(args, "policyId");
      if (!policyId) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số policyId.");
      const mapping = requireCoreMapping(policyId);
      return ok({ ...sourceTag(), policyId, adapter: mapping.adapter, target: mapping.target, inputSchema: mapping.inputSchema, source: mapping.source });
    },
  });

  add({
    group: "core",
    name: "get_core_output_schema",
    title: "Get core output schema",
    description: "JSON schema output mà Core adapter trả về.",
    inputSchema: { policyId: z.string() },
    handler: (args) => {
      const policyId = str(args, "policyId");
      if (!policyId) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số policyId.");
      const mapping = requireCoreMapping(policyId);
      return ok({ ...sourceTag(), policyId, adapter: mapping.adapter, target: mapping.target, outputSchema: mapping.outputSchema, source: mapping.source });
    },
  });

  add({
    group: "core",
    name: "get_core_adapter",
    title: "Get core adapter",
    description: "Thông tin adapter Core của policy (tên, target, ghi chú, các policy dùng cùng adapter).",
    inputSchema: { policyId: z.string() },
    handler: (args) => {
      const policyId = str(args, "policyId");
      if (!policyId) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số policyId.");
      const mapping = requireCoreMapping(policyId);
      const sharedWith = dataset()
        .coreMappings.filter((m) => m.adapter === mapping.adapter && m.policyId !== policyId)
        .map((m) => m.policyId);
      return ok({ ...sourceTag(), policyId, adapter: mapping.adapter, target: mapping.target, notes: mapping.notes, sharedWith, source: mapping.source });
    },
  });

  // ---------------------------------------------------------------- reference
  add({
    group: "reference",
    name: "find_similar_policy",
    title: "Find similar policy",
    description:
      "Tìm policy tương tự (theo policyId đã biết hoặc theo mô tả) — dùng để tái sử dụng pattern policy thay vì tự nghĩ mới.",
    inputSchema: {
      policyId: z.string().optional(),
      description: z.string().optional(),
      maxResults: z.number().int().positive().max(20).optional(),
    },
    handler: (args) => {
      const policyId = str(args, "policyId");
      const description = str(args, "description");
      if (!policyId && !description) {
        throw new ToolError("MISSING_ARGUMENT", "Cần policyId hoặc description.");
      }
      const base = policyId ? requirePolicy(policyId) : undefined;
      const query = description ?? policySearchText(base as Policy);
      const candidates = dataset().policies.filter((p) => p.id !== policyId);
      const scored = searchScored(candidates, query, policySearchText, num(args, "maxResults") ?? 5);
      return ok({
        ...sourceTag(),
        query,
        basePolicy: base ? policySummary(base) : null,
        similar: scored.map((entry) => ({ ...policySummary(entry.item), score: entry.score })),
        confidence: "heuristic",
        note: "Tương đồng dựa trên so khớp token (chưa dùng embedding) — cần review trước khi tái sử dụng.",
      });
    },
  });

  add({
    group: "reference",
    name: "find_similar_change",
    title: "Find similar past change",
    description: "Tìm thay đổi tương tự đã thực hiện trong quá khứ (theo mô tả yêu cầu).",
    inputSchema: {
      description: z.string(),
      maxResults: z.number().int().positive().max(20).optional(),
    },
    handler: (args) => {
      const description = str(args, "description");
      if (!description) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số description.");
      const scored = searchScored(dataset().changes, description, changeSearchText, num(args, "maxResults") ?? 5);
      return ok({
        ...sourceTag(),
        query: description,
        changes: scored.map((entry) => ({
          id: entry.item.id,
          ticket: entry.item.ticket,
          date: entry.item.date,
          title: entry.item.title,
          description: entry.item.description,
          policies: entry.item.policies,
          pattern: entry.item.pattern,
          outcome: entry.item.outcome,
          score: entry.score,
          source: entry.item.source,
        })),
        confidence: "heuristic",
      });
    },
  });

  add({
    group: "reference",
    name: "find_existing_pattern",
    title: "Find existing implementation pattern",
    description:
      "Trả pattern triển khai đã dùng cho thay đổi tương tự (steps + ví dụ ticket/file). Anti-hallucination: agent bám pattern có sẵn.",
    inputSchema: {
      description: z.string(),
      maxResults: z.number().int().positive().max(20).optional(),
    },
    handler: (args) => {
      const description = str(args, "description");
      if (!description) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số description.");
      const scored = searchScored(dataset().changes, description, changeSearchText, num(args, "maxResults") ?? 3);
      if (scored.length === 0) {
        return ok({
          ...sourceTag(),
          query: description,
          patterns: [],
          note: "Không tìm thấy pattern tương tự trong dataset. Cần human xác nhận trước khi tạo abstraction mới (existing-code-first).",
        });
      }
      return ok({
        ...sourceTag(),
        query: description,
        patterns: scored.map((entry) => ({
          name: entry.item.pattern?.name ?? null,
          steps: entry.item.pattern?.steps ?? [],
          reusable: entry.item.pattern?.reusable ?? null,
          risk: entry.item.pattern?.risk ?? null,
          example: {
            ticket: entry.item.ticket,
            changeId: entry.item.id,
            title: entry.item.title,
            files: entry.item.files ?? [],
            policies: entry.item.policies ?? [],
            outcome: entry.item.outcome,
          },
          score: entry.score,
          source: entry.item.source,
        })),
        confidence: "heuristic",
      });
    },
  });

  return list;
}

export function registerMbsmTools(server: McpServer, groups: Record<string, boolean>): string[] {
  const enabled: string[] = [];
  for (const tool of defs()) {
    if (groups[tool.group] === false) continue;
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      (args: Record<string, unknown>) => {
        try {
          return tool.handler(args ?? {});
        } catch (error) {
          return fail(error);
        }
      },
    );
    enabled.push(tool.name);
  }
  return enabled;
}
