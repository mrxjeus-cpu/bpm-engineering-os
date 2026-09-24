# mcp-engineering

MCP server cung cấp **năng lực kỹ thuật** cho Engineering OS: repo, code, git, architecture, verification, task state.

Chạy qua **stdio**:

```bash
node dist/index.js          # hoặc: ../../node_modules/.bin/tsx src/index.ts
```

## Tool theo group (bật/tắt trong `config/mcp.yaml`)

| Group | Tool | Ghi chú |
|---|---|---|
| `context` | `get_project_context`, `get_service_context`, `get_module_context`, `build_task_context`, `get_symbol_index` | summary, không dump code; `get_symbol_index` trả thống kê index (không dump symbol) |
| `code` | `search_code`, `find_symbol`, `find_references`, `find_callers`, `find_implementations`, `find_similar_code`, `read_symbol`, `get_change_context` | tra cứu qua **symbol index** có cache; kết quả xếp hạng `exact`/`likely`/`weak` kèm `reason` (vẫn là phân tích text, chưa type resolution) |
| `architecture` | `get_architecture_constraints`, `get_service_dependencies`, `get_module_dependencies`, `get_project_conventions` | trích ràng buộc thay vì bắt agent đọc cả tài liệu |
| `git` | `git_status`, `git_diff`, `git_diff_file`, `git_history`, `find_related_commits`, `validate_change_scope` | `validate_change_scope` là read-only |
| `verification` | `run_build`, `run_test`, `run_tests`, `validate_scope` | command chỉ lấy từ allowlist |
| `task` | `get_task_state`, `update_task_state`, `record_evidence`, `emit_event` | state/evidence/event của workstream |

## An toàn & bất biến

- **ADR-08 / INV-12:** `run_build`/`run_test`/`run_tests` **không nhận command từ input**. Command resolve từ `config/projects.yaml`; `run_test` chỉ chạy suite có trong `testSuites`; `run_tests` chỉ nhận pattern khớp whitelist. Có `taskId` thì evidence được ghi tự động kèm `command`, `cwd`, `exitCode`, `gitSha`, `artifact`.
- **INV-06:** chưa cấu hình `repoRoot` ⇒ trả `BLOCKED`/lỗi rõ ràng, không suy diễn nội dung repo.
- **INV-04:** `validate_scope` so diff với `scope.allowedRoots` và `allowDeletions`; vi phạm ⇒ `FAIL` + evidence `SCOPE_VALIDATION`.
- **INV-03:** `update_task_state` từ chối chuyển sang `REVIEWING`/`AUDITING`/`VERIFYING`/`DONE` nếu chưa có evidence.
- **INV-02:** state ghi atomic (tmp + rename) vào `.engineering/workstreams/<TASK_ID>/task.json`; mọi thay đổi ghi vào `history[]`.
- **CLAUDE.md mục 2:** `assertNotProtectedBranch` chặn thao tác ghi trên `main`/`dev`/`production`/`release/*`.

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `ENGINEERING_OS_ROOT` | Gốc repo Engineering OS (mặc định: suy ra từ vị trí `dist/`) |
| `MCP_CONFIG` | Đường dẫn `config/mcp.yaml` khác |
| `PROJECTS_CONFIG` | Đường dẫn `config/projects.yaml` khác |
| `DOMAIN_REPO_ROOT` / env khai báo trong `projects.yaml` | repoRoot của dự án đích |
| `ENG_INDEX_TTL_MS` | TTL cache của symbol index (mặc định `30000`; `0` = luôn dựng lại) |

## Symbol index (Phase 1, pattern-based)

`src/symbols.ts` + `src/symbol-index.ts` dựng index khai báo symbol cho repo đích, cache trong process, TTL mặc định 30s (đổi bằng `ENG_INDEX_TTL_MS`, `0` = luôn dựng lại).

- **Nguồn dữ liệu:** khai báo qua regex theo ngôn ngữ (`declarationPatterns`) + `package` + `import` + owner type. Với Java: `package`, `import`, class/interface/enum/record, method.
- **Cache key:** `repoRoot` + `gitSha` ⇒ đổi commit là index tự dựng lại; có `truncated` khi vượt giới hạn file.
- **Pre-filter:** mỗi query hash tên symbol và bỏ qua file không hề nhắc tới tên đó (`maybeMentions`) — index tránh quét toàn repo mỗi lần gọi.
- **Xếp hạng usage:** `exact` (file khai báo) → `likely` (cùng package, hoặc có import tới type chứa symbol, hoặc có call site) → `weak` (chỉ trùng tên, ví dụ getter cùng tên ở class khác). Mỗi hit có `reason` đọc được.
- **Điểm thay thế (swap point):** đây **không phải** type resolution. Khi cần chính xác (đa hình, generics, overload), thay `SymbolIndex` bằng SCIP/LSP/JavaParser — interface `extractSymbols`/`rankUsage` là biên giới, `code.ts` không cần đổi. Đây là open question #3 của spec; Phase 1 chốt dùng pattern-based để không kéo thêm toolchain vào repo.

## Giới hạn đã biết (Phase 1)

- Phân tích code dựa trên **regex/text**, chưa có type resolution ⇒ `find_callers`, `find_references`, `get_change_context` trả `confidence` theo tầng (`exact`/`likely`/`weak`), **không** phải kết quả biên dịch. Đừng dùng để kết luận "không còn caller nào khác" khi muốn xoá code — phải đọc thêm.
- Index nằm trong RAM của từng process MCP, không chia sẻ giữa các process và mất khi restart; chưa persist ra đĩa (Phase 2 nếu repo lớn).
- Chỉ index file text theo extension trong `symbols.ts`; file sinh tự động / generated code vẫn được index (chưa có exclude theo path).
