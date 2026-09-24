# BPM Engineering OS

Skeleton Phase 1 của **BPM Engineering OS** — hệ điều hành kỹ thuật context-aware cho phát triển backend BPM/BPM.

> **Nguyên tắc số 1:** Agent không được nhận toàn bộ project context. Agent chỉ nhận context tối thiểu nhưng đủ để thực hiện đúng task hiện tại.

Spec đầy đủ: [`SPEC-bpm-engineering-os.md`](./SPEC-bpm-engineering-os.md)

![CI](https://github.com/mrxjeus-cpu/bpm-engineering-os/actions/workflows/ci.yml/badge.svg)

---

## Trạng thái (v0.12.0)

| Hạng mục | Trạng thái |
|---|---|
| `config/` (models, gates, risk, mcp, projects) | ✅ được runtime validate khi khởi động (`npm run eng -- config`) |
| `schemas/` (task, evidence, plan, context, review, event) | ✅ JSON Schema 2020-12, ajv validate trước mọi lần ghi |
| `runtime/` state + evidence + event + CLI | ✅ StateStore, EvidenceStore, EventBus, CLI `eng` |
| `runtime/` plan compiler + DAG + waves | ✅ `plan.md` → `plan.json`, chia wave, conflict check (INV-11) |
| `runtime/` MCP client + ContextCompiler | ✅ stdio MCP client + context slicing theo budget, ghi `context/<TASK-NN>.{md,json}` |
| `runtime/` AgentRunner + prompt contract + ModelRouter | ✅ prompt contract 9 phần, harness cấu hình được (INV-07), kiểm tra artifact thật, `eng wave --run` |
| `runtime/` Skill router | ✅ chọn skill theo role/phase/trigger, `required` không bị cắt, nhúng vào prompt theo budget |
| `runtime/` RecoveryEngine | ✅ phân loại 8 loại lỗi bằng rule tất định, recovery context tối thiểu, loop guard |
| `runtime/` Phase commands | ✅ `eng translate\|analyze\|design\|plan\|implement\|review\|audit\|verify` — mỗi lệnh gói chuỗi bước của một pha, có `--dry-run`; `eng continue` chạy liên tiếp tới khi phải chờ người (exit 0 chỉ khi `DONE`) |
| `runtime/` Song song + khoá | ✅ `eng implement --parallel` chạy wave song song trong git worktree cô lập; lock workstream chống ghi chồng; `eng merge` merge thủ công có kiểm soát |
| `runtime/` **Multi-repo** | ✅ một ticket sửa nhiều repo ở các thư mục cha khác nhau (spec 9.5): `task.projects[]` + `### Repo` theo task; context/evidence/conflict/worktree tính theo **từng repo**; gate đòi `BUILD`/`TEST`/`SCOPE_VALIDATION` cho mọi repo |
| `mcp/mcp-engineering` | ✅ thin server chạy được (stdio), 31 tool chia 6 group; symbol index pattern-based có cache (TTL/gitSha), tra cứu xếp hạng `exact`/`likely`/`weak` |
| `runtime/` Metrics | ✅ `eng metrics <TASK_ID>` — thời gian theo status, context token (ước lượng), evidence gate tái dựng tại thời điểm transition, human gate wait, block episode; metric không đo được thì khai báo rõ chứ không ước lượng thay |
| `runtime/` Doctor (preflight) | ✅ `eng doctor [--project P] [--ping]` — kiểm env, cấu hình, gate↔state machine, model routing, harness/binary, MCP build+routing, skill catalog, repo đích (git/branch/scope/worktree); `--ping` khởi động thật 2 MCP server |
| `runtime/` Cost theo tier | ✅ event `AgentRun` ghi model tier + thời gian + token (nếu harness báo `ENG_USAGE_FILE`); không có nguồn thì `eng metrics` nói rõ chứ không ước lượng |
| `mcp/mcp-domain-core` | ⏸ **TẠM DỪNG** (`enabled: false` trong `config/mcp.yaml`) — code + 17 tool vẫn còn, dataset synthetic; bật lại bằng 1 dòng khi mô hình nguồn nghiệp vụ đã rõ |
| `skills/` (17 skill) · `agents/` (6) · `workflows/` (12) · `templates/` (8) | ✅ đã viết; skill do router chọn, agent/workflow/template là instruction thật |
| `tests/` | ✅ 250 test: 20 runtime/state + 23 plan/graph + 13 context + 21 agent + 19 skill + 21 recovery + 16 phase + 13 song song/khoá + 22 MCP + 9 path contract + 9 symbol index + 20 metrics + 14 doctor + 22 multi-repo + 8 continue |

**Còn heuristic:** symbol index hiện là **pattern-based** (regex khai báo + package/import), *không* phải type resolution — đủ để thu hẹp phạm vi đọc file và xếp hạng caller, **không** đủ để khẳng định "không còn caller nào khác". Điểm thay thế đã tách sẵn (`extractSymbols`/`rankUsage`) để đổi sang LSP/JavaParser/SCIP. Chưa đo baseline token/thời gian trên ticket thật.

---

## Quickstart

```bash
npm install          # cài dependency cho 3 workspace (runtime + 2 MCP)
npm run build        # build runtime trước, rồi 2 MCP server
npm test             # build + 220 test (runtime + 2 MCP smoke + guard đa nền tảng)
```

Chạy thử:

```bash
npm run eng -- config                      # kiểm tra 5 file config
npm run eng -- new TASK-49043 --risk HIGH
npm run eng -- continue TASK-49043         # chạy liên tiếp tới khi phải chờ người (exit 0 chỉ khi DONE)
npm run eng -- resume TASK-49043           # việc tiếp theo, gate đang mở, artifact còn thiếu
npm run eng -- metrics TASK-49043          # đo baseline: thời gian, context, gate, block, cost theo tier (spec mục 21)
npm run eng -- doctor                      # preflight trước khi chạy ticket thật (xem RUNBOOK.md)
npm run mcp:engineering                    # stdio — chờ JSON-RPC trên stdin
npm run mcp:domain
```

Mới bắt đầu? Xem [`GETTING-STARTED.md`](./GETTING-STARTED.md) (cài đặt → `eng doctor` → smoke test không cần LLM).
Chi tiết CLI + API runtime: xem [`runtime/README.md`](./runtime/README.md). Chạy ticket thật: xem [`RUNBOOK.md`](./RUNBOOK.md).

### Đăng ký với coding agent

```jsonc
// ví dụ cấu hình MCP client (Claude Code / Codex / Cursor ...)
{
  "mcpServers": {
    "mcp-engineering": {
      "command": "node",
      "args": ["/duong/dan/toi/bpm-engineering-os/mcp/mcp-engineering/dist/index.js"],
      "env": { "DOMAIN_REPO_ROOT": "/duong/dan/toi/repo/individual-service" }
    },
    "mcp-domain-core": {
      "command": "node",
      "args": ["/duong/dan/toi/bpm-engineering-os/mcp/mcp-domain-core/dist/index.js"]
    }
  }
}
```

> Chỉ enable MCP/toolset liên quan tới phase hiện tại (**INV-10**). Schema MCP là chi phí token lặp lại mỗi turn — xem `config/mcp.yaml → groups`.

---

## Cấu trúc

```text
.
├── .github/workflows/ci.yml        # CI matrix: ubuntu + windows + macos
├── SPEC-bpm-engineering-os.md   # spec nguồn (mục 16.1 định nghĩa cây thư mục này)
├── config/                         # models · gates · risk · mcp · projects
├── schemas/                        # JSON Schema cho state/evidence/plan/context/review/event
├── agents/                         # prompt contract cho 6 agent (researcher → auditor)
├── skills/                         # router · meta/ · engineering/ · domain/ · banking/
├── workflows/                      # mỗi phase 1 file markdown < 200 dòng
├── templates/                      # mẫu artifact sinh ra trong workstream
├── runtime/                        # orchestration runtime (Phase 1 chưa implement)
├── mcp/
│   ├── mcp-engineering/            # repo/code/git/architecture/verification/task intelligence
│   └── mcp-domain-core/              # domain DOMAIN: product/policy/fact/core/reference
├── GETTING-STARTED.md              # điểm bắt đầu: cài đặt → doctor → smoke test không cần LLM
├── RUNBOOK.md                      # quy trình chạy 1 ticket thật trên máy nội bộ
└── tests/                          # smoke test + fixtures
```

Artifact của mỗi ticket nằm ngoài repo code, trong `.engineering/workstreams/<TICKET>/` (state JSON + markdown + evidence; **không** chứa code).

---

## Hai MCP server

### `mcp-engineering` — engineering intelligence

Group (bật/tắt trong `config/mcp.yaml`):

| Group | Tool |
|---|---|
| `context` | `get_project_context`, `get_service_context`, `get_module_context`, `build_task_context`, `get_symbol_index` |
| `code` | `search_code`, `find_symbol`, `find_references`, `find_callers`, `find_implementations`, `find_similar_code`, `read_symbol`, `get_change_context` |
| `architecture` | `get_architecture_constraints`, `get_service_dependencies`, `get_module_dependencies`, `get_project_conventions` |
| `git` | `git_status`, `git_diff`, `git_diff_file`, `git_history`, `find_related_commits`, `validate_change_scope` |
| `verification` | `run_build`, `run_test`, `run_tests`, `validate_scope` |
| `task` | `get_task_state`, `update_task_state`, `record_evidence`, `emit_event` |

Quy tắc an toàn:

- `run_build` / `run_test` / `run_tests` **không nhận command từ input**. Command được resolve từ allowlist trong `config/projects.yaml`. Tool chỉ nhận `suite` (phải có trong allowlist).
- `record_evidence` luôn ghi kèm provenance: `command`, `cwd`, `exitCode`, `gitSha`, `artifact`, `producer` (**INV-12**).
- Tool cần repo nhưng chưa cấu hình `repoRoot` ⇒ trả lỗi rõ ràng, **không** đoán dữ liệu (**INV-06**).

### `mcp-domain-core` — domain intelligence  ⏸ TẠM DỪNG

> Server này đang **tạm dừng** (`config/mcp.yaml → servers.mcp-domain-core.enabled: false`) vì mô hình dữ liệu
> nghiệp vụ chưa khớp với cách tổ chức thực tế (nhiều hệ thống, mỗi hệ thống nhiều repo). Khi tắt: context chỉ có
> dữ liệu kỹ thuật từ `mcp-engineering`, `eng context` in cảnh báo rõ và worker **không được suy diễn** policy (INV-06).
> Code, tool và dataset vẫn nằm nguyên trong repo để bật lại.

| Group | Tool |
|---|---|
| `product` | `find_product`, `get_product` |
| `policy` | `find_policy`, `get_policy`, `get_policy_inputs`, `get_policy_rules`, `get_policy_dependencies`, `trace_policy_dependency` |
| `fact` | `find_customer_facts`, `find_loan_facts`, `find_cic_facts` |
| `core` | `get_core_input_schema`, `get_core_output_schema`, `get_core_adapter` |
| `reference` | `find_similar_policy`, `find_similar_change`, `find_existing_pattern` |

Progressive disclosure: `find_policy` chỉ trả **summary** (id, name, inputs, rulesCount); chi tiết lấy qua `get_policy` → `get_policy_rules`.

⚠️ Dataset trong `mcp/mcp-domain-core/data/` là **synthetic, hư cấu**, chỉ để chạy skeleton (`"_synthetic": true`). Phase 3 sẽ thay bằng nguồn policy thật (DB/service nội bộ).

---

## Nguyên tắc bắt buộc

Xem **mục 4 (INV-01…INV-12)** của spec. Tóm tắt: context tối thiểu · state ngoài prompt · evidence-gated transition · không xóa logic ngoài scope · human gate cho kiến trúc · MCP down thì `BLOCKED` chứ không bịa · workflow/skill nhỏ · không hard-code LLM provider/frontend · không expose toàn bộ toolset.

## CI

`.github/workflows/ci.yml`:

| Khi nào | Chạy trên | Vì sao |
|---|---|---|
| push / pull_request | **ubuntu + windows** | Windows là nền tảng đã làm lọt 2 lỗi (path separator), nên nằm ở matrix mặc định |
| theo lịch (02:00 UTC thứ Hai) | **+ macos** | Runner macOS tính ×10 phút hạn mức trên repo private ⇒ không chạy mỗi push |

```text
npm ci --no-audit --no-fund     # khẳng định package-lock.json đủ và khớp package.json
npm run typecheck               # build runtime rồi tsc --noEmit cho cả 3 workspace
npm test                        # build + 220 test (gồm guard đa nền tảng)
→ khi fail: upload artifact .engineering (state workstream, evidence, log harness)
```

**Vì sao có Windows trong matrix:** hai lỗi thật đã lọt qua vì test chỉ chạy trên macOS —
việc ghép đường dẫn tương đối sinh `\` trên Windows nên mọi so sánh trong workstream "đúng
một cách may mắn" trên macOS. `tests/paths-contract.test.mjs` là guard cho lớp lỗi đó (quét
cả artifact JSON và quét chính file test); CI chạy nó trên Windows mỗi push.

**Vì sao `typecheck` phải build runtime trước:** `mcp-engineering` resolve types của runtime
qua `runtime/dist/index.d.ts` — mà `dist/` bị gitignore. Không build trước thì `npm run
typecheck` fail trên clone sạch (CI run #1 đã bắt đúng lỗi này ở cả 3 OS).

Chạy đúng như CI tại máy:

```bash
npm ci && npm run typecheck && npm test
```

## Bước tiếp theo

1. **Chạy một ticket thật**: `eng translate … → eng verify …` với harness thật trong `config/models.yaml`; dùng `--dry-run` để xem trước từng phase.
2. Symbol index chính xác (LSP/JavaParser/SCIP) thay lớp pattern-based trong `mcp-engineering` — open question #3 của spec; interface thay thế đã có sẵn nên không phải sửa `code.ts`.
3. Đo baseline token/thời gian của ticket thật để so với cách làm hiện tại (mục 21 của spec) — dùng `eng metrics <TASK_ID> --write` làm công cụ đo; các metric cần dữ liệu bên ngoài (baseline quy trình cũ, escape rate, cost/tier) đã được liệt kê rõ trong output kèm cách bổ sung.
4. CI/CD: chạy `eng verify` trong pipeline, publish event ra Jira/Slack (mục 14 của spec).
