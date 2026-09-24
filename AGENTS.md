# AGENTS.md — hướng dẫn cho agent làm việc trong repo này

Repo này là **BPM Engineering OS** (skeleton Phase 1). Nguồn chân lý thiết kế: `SPEC-bpm-engineering-os.md`. Ranh giới kiến trúc: `ARCHITECTURE.md`. Quy tắc bắt buộc: `CLAUDE.md`.

## Bản đồ nhanh

| Cần gì | Xem ở đâu |
|---|---|
| Bắt đầu từ số 0 (cài đặt → doctor → smoke test không cần LLM) | `GETTING-STARTED.md` |
| Nguyên tắc/bất biến | `CLAUDE.md`, spec mục 4 |
| Kiến trúc & ADR | `ARCHITECTURE.md`, spec mục 5, 6 |
| Cấu hình model/gate/risk/MCP/project | `config/*.yaml` |
| Feature sửa nhiều repo (1 ticket = n repo) | spec mục 9.5 · `GETTING-STARTED.md` mục 9 · `config/projects.yaml` |
| Hợp đồng dữ liệu state/evidence/plan | `schemas/*.schema.json` |
| Tool repo/code/git/verification | `mcp/mcp-engineering/src/` |
| Tool domain DOMAIN | `mcp/mcp-domain-core/src/` |
| Việc còn phải làm | spec mục 18.1 (thứ tự 20 bước) |
| Chạy 1 ticket thật | `RUNBOOK.md` (chuẩn bị máy → `eng doctor` → cấu hình repo/harness → 8 phase) |
| Đo baseline | `eng metrics <TASK_ID>` (spec mục 21) |

## Quy trình làm việc

1. Đọc spec mục liên quan **trước khi** viết code; nếu spec và code lệch nhau, sửa spec hoặc code cho khớp — không để hai nguồn sự thật.
2. Phase 1 chỉ gồm: state/evidence store, context compiler, dependency graph/waves, skill router, 5 skill, agent prompts, 2 MCP server mỏng. **Không** implement non-goals (spec mục 20).
3. Không build tất cả agent cùng lúc — theo thứ tự spec mục 18.1.
4. Verification: `npm run build && npm test`. Evidence phải có provenance.
   Trước khi chạy ticket thật: `eng doctor` (phải 0 FAIL) rồi làm theo `RUNBOOK.md`.
5. Nếu là task liên quan MCP: giữ tool count thấp, bật/tắt theo group trong `config/mcp.yaml`.

## Ranh giới khi sửa code

- `mcp/mcp-engineering`: chỉ năng lực **kỹ thuật** (repo, code, git, architecture, verification, task state). Không chứa kiến thức nghiệp vụ DOMAIN.
- `mcp/mcp-domain-core`: chỉ **domain** (product, policy, rule, fact, core adapter). Không chứa logic orchestration.
- `runtime/`: chỉ điều phối. Không chứa logic nghiệp vụ (INV-08).
- `skills/`, `workflows/`: chỉ quy trình/instruction. Không nhúng data (skill = HOW, MCP = WHERE).

## Artifact runtime

Artifact của ticket nằm ở `.engineering/workstreams/<TICKET>/` (bị `.gitignore` ở skeleton này):

```text
task.json · requirements.md · impact.md · architecture.md · plan.md
tasks/ · context/ · evidence/ · reviews/ · audit.md · events.jsonl
```

Không commit code của dự án đích vào đây; workstream chỉ chứa state/artifact.
