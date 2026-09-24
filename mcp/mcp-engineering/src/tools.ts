import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getArchitectureConstraints,
  getModuleDependencies,
  getProjectConventions,
  getServiceDependencies,
} from "./architecture.js";
import {
  findCallers,
  findImplementations,
  findReferences,
  findSimilarCode,
  findSymbol,
  getChangeContext,
  readSymbol,
  searchCode,
} from "./code.js";
import { buildTaskContext, getModuleContext, getProjectContext, getServiceContext } from "./context.js";
import { symbolIndexFor } from "./symbol-index.js";
import { type ToolContent, ToolError, blocked, fail, ok } from "./errors.js";
import { findRelatedCommits, gitDiff, gitDiffFile, gitHistory, gitStatus, validateChangeScope } from "./git.js";
import { resolveRepo } from "./repo.js";
import { runAllowlisted } from "./verification.js";
import {
  emitEvent,
  ensureWorkstream,
  getTaskState,
  listWorkstreamFiles,
  recordEvidence,
  updateTaskState,
} from "./workstream.js";

type Group = "context" | "code" | "architecture" | "git" | "verification" | "task";

interface ToolDef {
  group: Group;
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<ToolContent> | ToolContent;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

function strArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

function defs(): ToolDef[] {
  const list: ToolDef[] = [];
  const add = (def: ToolDef): void => {
    list.push(def);
  };

  // ------------------------------------------------------------------ context
  add({
    group: "context",
    name: "get_project_context",
    title: "Project context",
    description:
      "Summary cấp project: language, build system, branch, top-level dirs, số file theo extension, tài liệu conventions. " +
      "Dùng để định hướng — KHÔNG load toàn bộ repo (INV-01).",
    inputSchema: { project: z.string().optional().describe("Tên project trong config/projects.yaml") },
    handler: (args) => ok(getProjectContext(resolveRepo(str(args, "project")))),
  });

  add({
    group: "context",
    name: "get_service_context",
    title: "Service context",
    description: "Summary một service/module: số file, package chính, entry point, test. Không trả nội dung code.",
    inputSchema: {
      service: z.string().describe("Tên service/thư mục, ví dụ msmb-individual-individual"),
      project: z.string().optional(),
    },
    handler: (args) => {
      const service = str(args, "service");
      if (!service) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số service.");
      return ok(getServiceContext(resolveRepo(str(args, "project")), { service }));
    },
  });

  add({
    group: "context",
    name: "get_module_context",
    title: "Module context",
    description: "Summary một module: số file, danh sách type (class/interface/enum) kèm file. Không dump nội dung.",
    inputSchema: {
      module: z.string().describe("Đường dẫn module, ví dụ src/main/java/.../policy"),
      project: z.string().optional(),
      maxResults: z.number().int().positive().max(500).optional(),
    },
    handler: (args) => {
      const module = str(args, "module");
      if (!module) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số module.");
      const maxResults = num(args, "maxResults");
      return ok(
        getModuleContext(resolveRepo(str(args, "project")), {
          module,
          ...(maxResults !== undefined ? { maxResults } : {}),
        }),
      );
    },
  });

  add({
    group: "context",
    name: "build_task_context",
    title: "Build task context (nguyên liệu)",
    description:
      "Context slicing: lấy đúng section của một sub-task trong plan.md + brief/context đã có + file/symbol liên quan + " +
      "code tương tự, kèm provenance. Runtime ContextCompiler tổng hợp thành context/task-NN.md.",
    inputSchema: {
      taskId: z.string().describe("Mã ticket, ví dụ TASK-49043"),
      subTaskId: z.string().describe("Mã task con, ví dụ TASK-03"),
      project: z.string().optional(),
    },
    handler: (args) => {
      const taskId = str(args, "taskId");
      const subTaskId = str(args, "subTaskId");
      if (!taskId || !subTaskId) throw new ToolError("MISSING_ARGUMENT", "Cần cả taskId và subTaskId.");
      return ok(buildTaskContext(resolveRepo(str(args, "project")), { taskId, subTaskId }));
    },
  });

  add({
    group: "context",
    name: "get_symbol_index",
    title: "Symbol index status",
    description:
      "Trạng thái symbol index của repo: số file, số symbol, thời điểm dựng, git SHA, có dùng cache hay không. " +
      "Dùng để biết kết quả find_symbol/find_callers có đang phản ánh code mới nhất không. force=true để dựng lại.",
    inputSchema: {
      force: z.boolean().optional().describe("Dựng lại index ngay, bỏ qua cache"),
      project: z.string().optional(),
    },
    handler: (args) => {
      const repo = resolveRepo(str(args, "project"));
      const stats = symbolIndexFor(repo).stats(args["force"] === true ? { force: true } : {});
      return ok({
        ...stats,
        note:
          "Index trích khai báo bằng pattern (class/interface/enum/method/function), KHÔNG phải type resolution. " +
          "Dùng để tra cứu nhanh và xếp hạng caller theo package/import.",
      });
    },
  });

  // --------------------------------------------------------------------- code
  add({
    group: "code",
    name: "search_code",
    title: "Search code",
    description: "Tìm text/regex trong repo (có phân trang). Kết quả gồm file, dòng, snippet.",
    inputSchema: {
      query: z.string(),
      isRegex: z.boolean().optional().describe("true nếu query là regex"),
      include: z.array(z.string()).optional().describe("Glob include, ví dụ ['**/*.java']"),
      page: z.number().int().positive().optional(),
      pageSize: z.number().int().positive().max(50).optional(),
      project: z.string().optional(),
    },
    handler: (args) => {
      const query = str(args, "query");
      if (!query) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số query.");
      const include = strArray(args, "include");
      const page = num(args, "page");
      const pageSize = num(args, "pageSize");
      return ok(
        searchCode(resolveRepo(str(args, "project")), {
          query,
          ...(args["isRegex"] === true ? { isRegex: true } : {}),
          ...(include ? { include } : {}),
          ...(page !== undefined ? { page } : {}),
          ...(pageSize !== undefined ? { pageSize } : {}),
        }),
      );
    },
  });

  add({
    group: "code",
    name: "find_symbol",
    title: "Find symbol declaration",
    description: "Tìm khai báo class/interface/enum/method/function theo tên. Trả file + dòng + signature.",
    inputSchema: {
      name: z.string(),
      kind: z.string().optional().describe("type | method | function | field | table | procedure"),
      maxResults: z.number().int().positive().max(100).optional(),
      project: z.string().optional(),
    },
    handler: (args) => {
      const name = str(args, "name");
      if (!name) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số name.");
      const kind = str(args, "kind");
      const maxResults = num(args, "maxResults");
      return ok(
        findSymbol(resolveRepo(str(args, "project")), {
          name,
          ...(kind ? { kind } : {}),
          ...(maxResults !== undefined ? { maxResults } : {}),
        }),
      );
    },
  });

  add({
    group: "code",
    name: "find_references",
    title: "Find references",
    description: "Tìm mọi chỗ xuất hiện của một symbol (text search, word-boundary).",
    inputSchema: {
      symbol: z.string(),
      include: z.array(z.string()).optional(),
      maxResults: z.number().int().positive().max(200).optional(),
      project: z.string().optional(),
    },
    handler: (args) => {
      const symbol = str(args, "symbol");
      if (!symbol) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số symbol.");
      const include = strArray(args, "include");
      const maxResults = num(args, "maxResults");
      return ok(
        findReferences(resolveRepo(str(args, "project")), {
          symbol,
          ...(include ? { include } : {}),
          ...(maxResults !== undefined ? { maxResults } : {}),
        }),
      );
    },
  });

  add({
    group: "code",
    name: "find_callers",
    title: "Find callers",
    description: "Tìm nơi gọi một method/hàm. Kết quả là HEURISTIC (text search) — phải xác nhận trước khi kết luận impact.",
    inputSchema: {
      symbol: z.string(),
      maxResults: z.number().int().positive().max(200).optional(),
      project: z.string().optional(),
    },
    handler: (args) => {
      const symbol = str(args, "symbol");
      if (!symbol) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số symbol.");
      const maxResults = num(args, "maxResults");
      return ok(
        findCallers(resolveRepo(str(args, "project")), {
          symbol,
          ...(maxResults !== undefined ? { maxResults } : {}),
        }),
      );
    },
  });

  add({
    group: "code",
    name: "find_implementations",
    title: "Find implementations",
    description: "Tìm class implements/extends một interface/base class.",
    inputSchema: {
      symbol: z.string(),
      maxResults: z.number().int().positive().max(100).optional(),
      project: z.string().optional(),
    },
    handler: (args) => {
      const symbol = str(args, "symbol");
      if (!symbol) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số symbol.");
      const maxResults = num(args, "maxResults");
      return ok(
        findImplementations(resolveRepo(str(args, "project")), {
          symbol,
          ...(maxResults !== undefined ? { maxResults } : {}),
        }),
      );
    },
  });

  add({
    group: "code",
    name: "find_similar_code",
    title: "Find similar implementation",
    description:
      "Tìm implementation tương tự theo mô tả (anti-hallucination cho legacy codebase): agent học pattern có sẵn thay vì tự nghĩ kiến trúc mới.",
    inputSchema: {
      query: z.string().describe("Mô tả, ví dụ 'add new policy input'"),
      include: z.array(z.string()).optional(),
      maxResults: z.number().int().positive().max(50).optional(),
      project: z.string().optional(),
    },
    handler: (args) => {
      const query = str(args, "query");
      if (!query) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số query.");
      const include = strArray(args, "include");
      const maxResults = num(args, "maxResults");
      return ok(
        findSimilarCode(resolveRepo(str(args, "project")), {
          query,
          ...(include ? { include } : {}),
          ...(maxResults !== undefined ? { maxResults } : {}),
        }),
      );
    },
  });

  add({
    group: "code",
    name: "read_symbol",
    title: "Read symbol body",
    description: "Đọc thân của một symbol (cắt theo brace matching, có giới hạn dòng). Dùng thay cho việc đọc cả file 5.000 dòng.",
    inputSchema: {
      symbol: z.string(),
      file: z.string().optional().describe("Giới hạn trong một file"),
      kind: z.string().optional(),
      project: z.string().optional(),
    },
    handler: (args) => {
      const symbol = str(args, "symbol");
      if (!symbol) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số symbol.");
      const file = str(args, "file");
      const kind = str(args, "kind");
      return ok(
        readSymbol(resolveRepo(str(args, "project")), {
          symbol,
          ...(file ? { file } : {}),
          ...(kind ? { kind } : {}),
        }),
      );
    },
  });

  add({
    group: "code",
    name: "get_change_context",
    title: "Get change context",
    description:
      "Gói context để sửa một symbol: definition + callers + implementations + tests + db/policy dependencies (heuristic). " +
      "Tool quan trọng nhất cho codebase lớn.",
    inputSchema: {
      file: z.string(),
      symbol: z.string(),
      maxResults: z.number().int().positive().max(100).optional(),
      project: z.string().optional(),
    },
    handler: (args) => {
      const file = str(args, "file");
      const symbol = str(args, "symbol");
      if (!file || !symbol) throw new ToolError("MISSING_ARGUMENT", "Cần cả file và symbol.");
      const maxResults = num(args, "maxResults");
      return ok(
        getChangeContext(resolveRepo(str(args, "project")), {
          file,
          symbol,
          ...(maxResults !== undefined ? { maxResults } : {}),
        }),
      );
    },
  });

  // ------------------------------------------------------------- architecture
  add({
    group: "architecture",
    name: "get_architecture_constraints",
    title: "Architecture constraints",
    description: "Trích các dòng mang tính ràng buộc từ tài liệu kiến trúc — để agent không phải đọc toàn bộ tài liệu.",
    inputSchema: {
      paths: z.array(z.string()).optional(),
      maxResults: z.number().int().positive().max(200).optional(),
      project: z.string().optional(),
    },
    handler: (args) => {
      const paths = strArray(args, "paths");
      const maxResults = num(args, "maxResults");
      return ok(
        getArchitectureConstraints(resolveRepo(str(args, "project")), {
          ...(paths ? { paths } : {}),
          ...(maxResults !== undefined ? { maxResults } : {}),
        }),
      );
    },
  });

  add({
    group: "architecture",
    name: "get_service_dependencies",
    title: "Service dependencies",
    description: "Đọc dependency khai báo trong build file (pom.xml/build.gradle) của service.",
    inputSchema: {
      service: z.string().optional(),
      maxResults: z.number().int().positive().max(200).optional(),
      project: z.string().optional(),
    },
    handler: (args) => {
      const service = str(args, "service");
      const maxResults = num(args, "maxResults");
      return ok(
        getServiceDependencies(resolveRepo(str(args, "project")), {
          ...(service ? { service } : {}),
          ...(maxResults !== undefined ? { maxResults } : {}),
        }),
      );
    },
  });

  add({
    group: "architecture",
    name: "get_module_dependencies",
    title: "Module dependencies",
    description: "Thống kê package được import nhiều nhất trong một module (heuristic, từ import statement).",
    inputSchema: {
      module: z.string(),
      maxResults: z.number().int().positive().max(100).optional(),
      project: z.string().optional(),
    },
    handler: (args) => {
      const module = str(args, "module");
      if (!module) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số module.");
      const maxResults = num(args, "maxResults");
      return ok(
        getModuleDependencies(resolveRepo(str(args, "project")), {
          module,
          ...(maxResults !== undefined ? { maxResults } : {}),
        }),
      );
    },
  });

  add({
    group: "architecture",
    name: "get_project_conventions",
    title: "Project conventions",
    description: "Danh sách tài liệu conventions + heading, scope cho phép, protected branches.",
    inputSchema: {
      paths: z.array(z.string()).optional(),
      project: z.string().optional(),
    },
    handler: (args) => {
      const paths = strArray(args, "paths");
      return ok(
        getProjectConventions(resolveRepo(str(args, "project")), {
          ...(paths ? { paths } : {}),
        }),
      );
    },
  });

  // ---------------------------------------------------------------------- git
  add({
    group: "git",
    name: "git_status",
    title: "Git status",
    description: "Trạng thái working tree + branch hiện tại.",
    inputSchema: { project: z.string().optional() },
    handler: async (args) => ok(await gitStatus(resolveRepo(str(args, "project")))),
  });

  add({
    group: "git",
    name: "git_diff",
    title: "Git diff",
    description: "Diff có giới hạn kích thước. Có thể giới hạn theo file hoặc so với base ref.",
    inputSchema: {
      file: z.string().optional(),
      base: z.string().optional(),
      staged: z.boolean().optional(),
      maxBytes: z.number().int().positive().max(2_000_000).optional(),
      project: z.string().optional(),
    },
    handler: async (args) => {
      const file = str(args, "file");
      const base = str(args, "base");
      const maxBytes = num(args, "maxBytes");
      return ok(
        await gitDiff(resolveRepo(str(args, "project")), {
          ...(file ? { file } : {}),
          ...(base ? { base } : {}),
          ...(args["staged"] === true ? { staged: true } : {}),
          ...(maxBytes !== undefined ? { maxBytes } : {}),
        }),
      );
    },
  });

  add({
    group: "git",
    name: "git_diff_file",
    title: "Git diff (one file)",
    description: "Diff của đúng một file — dùng khi review từng file để tiết kiệm context.",
    inputSchema: {
      path: z.string(),
      base: z.string().optional(),
      project: z.string().optional(),
    },
    handler: async (args) => {
      const filePath = str(args, "path");
      if (!filePath) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số path.");
      const base = str(args, "base");
      return ok(
        await gitDiffFile(resolveRepo(str(args, "project")), {
          path: filePath,
          ...(base ? { base } : {}),
        }),
      );
    },
  });

  add({
    group: "git",
    name: "git_history",
    title: "Git history",
    description: "Lịch sử commit (có thể theo file). Kèm SHA + ngày + tác giả + subject.",
    inputSchema: {
      path: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
      base: z.string().optional(),
      project: z.string().optional(),
    },
    handler: async (args) => {
      const filePath = str(args, "path");
      const limit = num(args, "limit");
      const base = str(args, "base");
      return ok(
        await gitHistory(resolveRepo(str(args, "project")), {
          ...(filePath ? { path: filePath } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(base ? { base } : {}),
        }),
      );
    },
  });

  add({
    group: "git",
    name: "find_related_commits",
    title: "Find related commits",
    description: "Tìm commit theo từ khóa (git log --grep). Dùng để tìm thay đổi tương tự trong quá khứ.",
    inputSchema: {
      query: z.string(),
      limit: z.number().int().positive().max(100).optional(),
      project: z.string().optional(),
    },
    handler: async (args) => {
      const query = str(args, "query");
      if (!query) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số query.");
      const limit = num(args, "limit");
      return ok(
        await findRelatedCommits(resolveRepo(str(args, "project")), {
          query,
          ...(limit !== undefined ? { limit } : {}),
        }),
      );
    },
  });

  add({
    group: "git",
    name: "validate_change_scope",
    title: "Validate change scope (read-only)",
    description:
      "So diff thực tế với scope cho phép: phát hiện file ngoài scope và file bị xóa không nằm trong allowlist (INV-04). " +
      "Chỉ đọc, không ghi evidence — dùng validate_scope nếu muốn ghi evidence.",
    inputSchema: {
      allowedFiles: z.array(z.string()).optional(),
      allowedRoots: z.array(z.string()).optional(),
      base: z.string().optional(),
      project: z.string().optional(),
    },
    handler: async (args) => {
      const allowedFiles = strArray(args, "allowedFiles");
      const allowedRoots = strArray(args, "allowedRoots");
      const base = str(args, "base");
      return ok(
        await validateChangeScope(resolveRepo(str(args, "project")), {
          ...(allowedFiles ? { allowedFiles } : {}),
          ...(allowedRoots ? { allowedRoots } : {}),
          ...(base ? { base } : {}),
        }),
      );
    },
  });

  // -------------------------------------------------------------- verification
  add({
    group: "verification",
    name: "run_build",
    title: "Run build",
    description:
      "Chạy build bằng command trong allowlist (config/projects.yaml). Không nhận command từ input (ADR-08). " +
      "Nếu có taskId, tự ghi evidence BUILD kèm provenance.",
    inputSchema: {
      project: z.string().optional(),
      taskId: z.string().optional(),
      subTaskId: z.string().optional(),
    },
    handler: async (args) => {
      const taskId = str(args, "taskId");
      const subTaskId = str(args, "subTaskId");
      return ok(
        await runAllowlisted(resolveRepo(str(args, "project")), {
          kind: "build",
          ...(taskId ? { taskId } : {}),
          ...(subTaskId ? { subTaskId } : {}),
        }),
      );
    },
  });

  add({
    group: "verification",
    name: "run_test",
    title: "Run one test suite",
    description:
      "Chạy một test suite đã khai báo trong allowlist. Suite không có trong allowlist ⇒ lỗi, không chạy.",
    inputSchema: {
      suite: z.string().describe("Tên suite trong config/projects.yaml → testSuites"),
      project: z.string().optional(),
      taskId: z.string().optional(),
      subTaskId: z.string().optional(),
    },
    handler: async (args) => {
      const suite = str(args, "suite");
      if (!suite) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số suite.");
      const taskId = str(args, "taskId");
      const subTaskId = str(args, "subTaskId");
      return ok(
        await runAllowlisted(resolveRepo(str(args, "project")), {
          kind: "test",
          suite,
          ...(taskId ? { taskId } : {}),
          ...(subTaskId ? { subTaskId } : {}),
        }),
      );
    },
  });

  add({
    group: "verification",
    name: "run_tests",
    title: "Run tests (pattern)",
    description:
      "Chạy nhiều test theo pattern; pattern phải khớp whitelist trong config/mcp.yaml. Dùng cho lần chạy đầy đủ trước khi verify.",
    inputSchema: {
      pattern: z.string().optional().describe("Pattern test hợp lệ, ví dụ 'Policy*Test'"),
      project: z.string().optional(),
      taskId: z.string().optional(),
      subTaskId: z.string().optional(),
    },
    handler: async (args) => {
      const pattern = str(args, "pattern");
      const taskId = str(args, "taskId");
      const subTaskId = str(args, "subTaskId");
      return ok(
        await runAllowlisted(resolveRepo(str(args, "project")), {
          kind: "testAll",
          ...(pattern ? { suite: pattern } : {}),
          ...(taskId ? { taskId } : {}),
          ...(subTaskId ? { subTaskId } : {}),
        }),
      );
    },
  });

  add({
    group: "verification",
    name: "validate_scope",
    title: "Validate scope + ghi evidence",
    description:
      "Như validate_change_scope nhưng ghi evidence SCOPE_VALIDATION vào workstream (bắt buộc trước khi chuyển sang REVIEWING).",
    inputSchema: {
      taskId: z.string(),
      allowedFiles: z.array(z.string()).optional(),
      allowedRoots: z.array(z.string()).optional(),
      base: z.string().optional(),
      project: z.string().optional(),
    },
    handler: async (args) => {
      const taskId = str(args, "taskId");
      if (!taskId) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số taskId.");
      const allowedFiles = strArray(args, "allowedFiles");
      const allowedRoots = strArray(args, "allowedRoots");
      const base = str(args, "base");
      const repo = resolveRepo(str(args, "project"));
      const result = await validateChangeScope(repo, {
        ...(allowedFiles ? { allowedFiles } : {}),
        ...(allowedRoots ? { allowedRoots } : {}),
        ...(base ? { base } : {}),
      });
      const evidence = recordEvidence(
        taskId,
        {
          type: "SCOPE_VALIDATION",
          status: result.status,
          summary: `changed=${result.changedFiles.length}, unexpected=${result.unexpectedFiles.length}, deleted=${result.deletedFiles.length}`,
          unexpectedFiles: result.unexpectedFiles,
          deletedFiles: result.deletedFiles,
          producer: "mcp:mcp-engineering:validate_scope",
        },
        repo.project,
      );
      return ok({ ...result, evidence });
    },
  });

  // --------------------------------------------------------------------- task
  add({
    group: "task",
    name: "get_task_state",
    title: "Get task state",
    description: "Đọc task.json của workstream. State là nguồn sự thật, không phải conversation (INV-02).",
    inputSchema: { taskId: z.string() },
    handler: (args) => {
      const taskId = str(args, "taskId");
      if (!taskId) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số taskId.");
      const state = getTaskState(taskId);
      if (state === null) {
        return ok({
          status: "NOT_FOUND",
          taskId,
          files: listWorkstreamFiles(taskId),
          note: "Chưa có workstream. Dùng update_task_state để tạo, hoặc chạy /eng new.",
        });
      }
      return ok(state);
    },
  });

  add({
    group: "task",
    name: "update_task_state",
    title: "Update task state",
    description:
      "Cập nhật state (atomic write + ghi history). Chuyển sang REVIEWING/AUDITING/VERIFYING/DONE mà không có evidence ⇒ lỗi (INV-03). " +
      "blocked=true phải kèm blockReason (INV-06).",
    inputSchema: {
      taskId: z.string(),
      patch: z.record(z.string(), z.unknown()).describe("Các field cần cập nhật, ví dụ { status: 'IMPLEMENTING' }"),
      expectedStatus: z.string().optional().describe("Chỉ cập nhật nếu state hiện tại đúng giá trị này"),
      evidenceRef: z.string().optional(),
      by: z.string().optional(),
      reason: z.string().optional(),
    },
    handler: (args) => {
      const taskId = str(args, "taskId");
      if (!taskId) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số taskId.");
      const patch = args["patch"];
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        throw new ToolError("INVALID_ARGUMENT", "patch phải là object.");
      }
      const expectedStatus = str(args, "expectedStatus");
      const evidenceRef = str(args, "evidenceRef");
      const by = str(args, "by");
      const reason = str(args, "reason");
      return ok(
        updateTaskState(taskId, patch as Record<string, unknown>, {
          ...(expectedStatus ? { expectedStatus } : {}),
          ...(evidenceRef ? { evidenceRef } : {}),
          ...(by ? { by } : {}),
          ...(reason ? { reason } : {}),
        }),
      );
    },
  });

  add({
    group: "task",
    name: "record_evidence",
    title: "Record evidence",
    description:
      "Ghi evidence vào workstream kèm provenance (INV-12). TEST/BUILD cần command, cwd, exitCode, gitSha, artifact; " +
      "HUMAN_APPROVAL cần gateId, approver, approvedAt; SCOPE_VALIDATION cần unexpectedFiles, deletedFiles.",
    inputSchema: {
      taskId: z.string(),
      evidence: z
        .object({
          type: z.string(),
          status: z.string(),
          summary: z.string().optional(),
          subTaskId: z.string().optional(),
          command: z.string().optional(),
          cwd: z.string().optional(),
          exitCode: z.number().int().optional(),
          gitSha: z.string().optional(),
          artifact: z.string().optional(),
          producer: z.string().optional(),
          gateId: z.string().optional(),
          approver: z.string().optional(),
          approvedAt: z.string().optional(),
          comment: z.string().optional(),
          checks: z.array(z.unknown()).optional(),
          unexpectedFiles: z.array(z.string()).optional(),
          deletedFiles: z.array(z.string()).optional(),
          mcpQuery: z.record(z.string(), z.unknown()).optional(),
          durationMs: z.number().int().optional(),
        })
        .describe("Evidence theo schemas/evidence.schema.json"),
      project: z.string().optional(),
    },
    handler: (args) => {
      const taskId = str(args, "taskId");
      if (!taskId) throw new ToolError("MISSING_ARGUMENT", "Thiếu tham số taskId.");
      const evidence = args["evidence"];
      if (typeof evidence !== "object" || evidence === null) {
        throw new ToolError("INVALID_ARGUMENT", "evidence phải là object.");
      }
      return ok(recordEvidence(taskId, evidence as never, str(args, "project")));
    },
  });

  add({
    group: "task",
    name: "emit_event",
    title: "Emit lifecycle event",
    description:
      "Ghi lifecycle event vào events.jsonl (TaskCreated, TaskCompleted, HumanApprovalRequired, Blocked, ...). " +
      "Consumer ngoài (Jira/dashboard) đọc file này, agent không cần biết chúng tồn tại.",
    inputSchema: {
      taskId: z.string(),
      type: z.string(),
      subTaskId: z.string().optional(),
      toStatus: z.string().optional(),
      fromStatus: z.string().optional(),
      wave: z.number().int().optional(),
      evidenceRef: z.string().optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
      actor: z.string().optional(),
      createIfMissing: z.boolean().optional(),
    },
    handler: (args) => {
      const taskId = str(args, "taskId");
      const type = str(args, "type");
      if (!taskId || !type) throw new ToolError("MISSING_ARGUMENT", "Cần cả taskId và type.");
      if (args["createIfMissing"] === true) ensureWorkstream(taskId);
      const subTaskId = str(args, "subTaskId");
      const toStatus = str(args, "toStatus");
      const fromStatus = str(args, "fromStatus");
      const evidenceRef = str(args, "evidenceRef");
      const actor = str(args, "actor");
      const wave = num(args, "wave");
      const payload = args["payload"];
      return ok(
        emitEvent(taskId, {
          type,
          ...(subTaskId ? { subTaskId } : {}),
          ...(toStatus ? { toStatus } : {}),
          ...(fromStatus ? { fromStatus } : {}),
          ...(evidenceRef ? { evidenceRef } : {}),
          ...(actor ? { actor } : {}),
          ...(wave !== undefined ? { wave } : {}),
          ...(typeof payload === "object" && payload !== null ? { payload: payload as Record<string, unknown> } : {}),
        }),
      );
    },
  });

  return list;
}

export function registerEngineeringTools(server: McpServer, groups: Record<string, boolean>): string[] {
  const enabled: string[] = [];
  for (const tool of defs()) {
    if (groups[tool.group] === false) continue;
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => {
        try {
          return await tool.handler(args ?? {});
        } catch (error) {
          if (error instanceof ToolError && error.code === "REPO_ROOT_NOT_CONFIGURED") {
            return blocked(error.message, ["repoRoot"], error.hint);
          }
          return fail(error);
        }
      },
    );
    enabled.push(tool.name);
  }
  return enabled;
}
