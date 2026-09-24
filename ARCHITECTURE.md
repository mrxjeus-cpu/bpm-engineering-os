# ARCHITECTURE — BPM Engineering OS

Tài liệu này là bản rút gọn dùng khi code. **Spec là nguồn chân lý**: [`SPEC-bpm-engineering-os.md`](./SPEC-bpm-engineering-os.md).

---

## 1. Định vị

```text
Skill  = HOW            (cách làm)
MCP    = WHERE          (lấy dữ liệu ở đâu)
State  = WHAT HAPPENED  (đã xảy ra gì)
Agent  = DECISION / EXECUTION
Human  = APPROVAL
```

Nguồn gốc thiết kế:

- **Superpowers** → kỷ luật quy trình: skill, brainstorm→plan→execute, TDD, task brief, fresh subagent, spec review + quality review, verification-before-completion.
- **GSD** → state/context engine: persistent state, context compiler, dependency graph/waves, model routing, workstreams, recovery.
- **BPM** → domain layer: BA/Impact/SA, DOMAIN policy/fact/core, banking audit, risk & safety rules.

**Không copy:** `execute-phase.md` 1.800 dòng, 33 agents/88 workflows/61 references, tự động approve kiến trúc, eager load toàn bộ skill/MCP schema.

---

## 2. Luồng một ticket

```text
/eng new → translate → requirements → impact → design → HUMAN GATE
        → plan → DAG → context compile → waves (fresh worker + spec review + quality review)
        → whole-branch review → audit → verify → DONE
```

Chi tiết từng bước: spec mục 9. State machine: spec mục 8.1 (nhánh lỗi: `FAILED → DEBUGGING`, `REVIEWING → REWORK_REQUIRED`, nhánh phụ `BLOCKED`).

---

## 3. Bản đồ component

Trạng thái: ✅ đã implement · ⬜ chưa (theo thứ tự spec mục 18.1)

| Component | Thư mục (Phase 1) | Interface (spec mục 17) | Trạng thái |
|---|---|---|---|
| Config loader | `runtime/src/config/` | `loadConfig()`, `configSummary()` | ✅ |
| Schema validation | `runtime/src/schemas/` | `validateWith()`, `assertValid()` (ajv) | ✅ |
| State | `runtime/src/state/`, `schemas/task.schema.json` | `StateStore.get/create/patch/transition/resume` | ✅ |
| State machine | `runtime/src/state/machine.ts` | `assertTransition()` | ✅ |
| Human gates | `runtime/src/state/gates.ts`, `config/gates.yaml` | `assertHumanGates()`, `openGatesFor()` | ✅ |
| Evidence | `runtime/src/evidence/`, `schemas/evidence.schema.json` | `EvidenceStore.record/list` | ✅ |
| Evidence rules (RULES-001) | `runtime/src/evidence/rules.ts` | `evaluateEvidenceGate()` | ✅ |
| Events | `runtime/src/events/`, `schemas/event.schema.json` | `EventBus.emit/read` | ✅ |
| CLI | `runtime/src/cli.ts` | `eng new/status/resume/advance/record/...` | ✅ (một phần) |
| MCP gateway / servers | `runtime/src/mcp/client.ts`, `mcp/` | `McpGateway.call(McpRequest)` | ✅ (2 server + stdio client) |
| Context Compiler | `runtime/src/context/` | `ContextCompiler.compile` | ✅ |
| Dependency graph / waves | `runtime/src/graph/`, `runtime/src/executor/` | `DependencyGraph.buildWaves`, `WaveExecutor.execute` | ✅ (execute tuần tự hoặc song song trong worktree) |
| Agent runner / router | `runtime/src/agents/`, `runtime/src/router/` | `AgentRunner.run(AgentRequest)` | ✅ |
| Model router | `runtime/src/router/model.ts` + `config/models.yaml` | `ModelRouter.resolve` | ✅ |
| Skill loader + router | `runtime/src/skills/`, `skills/` | `loadSkills`, `routeSkills` | ✅ |
| Orchestrator / WorkflowEngine | `runtime/src/orchestrator/` | `PhaseOrchestrator.run(taskId, phase)` | ✅ |
| Risk engine | `config/risk.yaml` | `GateEngine.evaluate` | 🟡 có config + effects |
| Recovery | `runtime/src/recovery/` | `RecoveryEngine.recover` | ✅ |
| Metrics | `runtime/src/metrics/` | `computeMetrics`, `collectMetrics`, `renderMetrics` (spec mục 21) | ✅ (chỉ số đo được; metric thiếu nguồn được khai báo, không ước lượng) |
| Doctor (preflight) | `runtime/src/doctor/` | `runDoctor({project, ping})` | ✅ (env/config/gate/model/harness/MCP/project; `--ping` khởi động MCP thật) |

---

## 4. Ranh giới (không được vi phạm)

| Ranh giới | Quy tắc |
|---|---|
| Runtime ↔ domain | Business logic BPM **không** nằm trong runtime; thuộc `mcp-domain-core` (**INV-08**) |
| Worker ↔ context | Worker chỉ nhận `context/task-NN.md`, không nhận conversation/repo/plan đầy đủ (**INV-01**) |
| Provider ↔ runtime | Không hard-code LLM provider hay agent frontend; model routing qua `config/models.yaml` (**INV-07**) |
| Toolset ↔ phase | Chỉ expose group/tool liên quan phase hiện tại (**INV-10**) |
| MCP ↔ sự thật | MCP không available ⇒ `BLOCKED`, không hallucinate (**INV-06**, mục 13.5) |
| Evidence ↔ claim | Không transition nếu thiếu evidence hợp lệ + provenance (**INV-03**, **INV-12**) |
| Scope ↔ diff | Deletion ngoài allowlist ⇒ block (**INV-04**) |
| Parallel ↔ conflict | Chỉ parallel khi `conflict_check = PASS` (**INV-11**) |
| Kích thước | workflow < 200 dòng, skill < 300 dòng (**INV-09**) |

---

## 5. Token efficiency (cách hệ thống giữ context nhỏ)

1. Không eager-load skill — chỉ load skill hiện tại.
2. Không expose toàn bộ MCP schema — routing theo group/phase.
3. Không copy conversation — worker context độc lập.
4. Context slicing — mỗi task một file context.
5. Progressive disclosure — MCP trả summary trước, chi tiết sau.
6. File-based state — state không cần nằm trong context.
7. Thin orchestrator — prompt điều phối nhỏ.
8. Pre-filter trước khi đọc — symbol index loại file không hề nhắc tới symbol cần tìm, nên `read_symbol`/`find_references` không nạp cả repo vào context.

---

## 6. ADR tóm tắt

| ID | Quyết định | Hệ quả |
|---|---|---|
| ADR-01 | Borrow Superpowers làm coding kernel, **không** fork GSD | Kernel nhỏ, dễ domain hóa |
| ADR-02 | State = JSON, artifact = Markdown, lưu trong `.engineering/workstreams/<TICKET>/` | Resume được sau crash/`/clear`; commit được để audit |
| ADR-03 | Hybrid: command xác định phase, skill xác định cách làm | Predictable + nhẹ token |
| ADR-04 | 2 MCP server (engineering + domain-core), routing theo task metadata | Tránh schema overhead |
| ADR-05 | Evidence-gated transition (RULES-001) với provenance bắt buộc | Không "claim done" suông |
| ADR-06 | Mặc định `normal` mode, autonomous chỉ cho task LOW risk | Phù hợp ràng buộc ngân hàng |
| ADR-07 | Skill description **chỉ nêu WHEN**, HOW nằm trong body | Tránh agent đi tắt theo description |
| ADR-08 | Command cho verification lấy từ allowlist trong config, không từ tool input | Chống thực thi lệnh tùy ý qua MCP |
| ADR-09 | Symbol index **pattern-based** (regex khai báo + package/import) cache theo `gitSha`+TTL, thay vì kéo LSP/JavaParser/SCIP vào Phase 1 | Không thêm toolchain/build cho repo đích; kết quả là *xếp hạng* (`exact`/`likely`/`weak`) chứ không phải type resolution; biên `extractSymbols`/`rankUsage` là điểm thay thế khi cần chính xác |
| ADR-10 | Metrics tính lại từ workstream, không lưu bản sao số liệu; metric không có nguồn phải khai báo là không đo được | Không có dashboard lệch với state; nhưng mọi state change phải ghi `history[]` (kể cả block/unblock) nếu không sẽ mất dấu vết audit |
| ADR-11 | Worker báo token qua `ENG_USAGE_FILE` (tùy chọn); runtime không tự đo token provider | Cost metric có provenance, nhưng phải nói rõ phần nào chưa đo được; harness không báo thì không có token, không ước lượng |

---

## 7. Môi trường & rủi ro nền tảng

- Hook bootstrap là điểm yếu đã biết của các harness (Windows/PowerShell, inject trùng context). Skeleton này **không** phụ thuộc hook: MCP chạy độc lập qua stdio, bootstrap có thể gọi thủ công.
- MCP schema là chi phí token lặp lại mỗi turn → giữ tool count thấp, bật group theo phase.
- Codebase đích rất lớn (nhiều microservice, class dài) → chất lượng Context Compiler phụ thuộc hạ tầng symbol index (ADR-09). Index Phase 1 là heuristic: nó **thu hẹp** phạm vi đọc file và **xếp hạng** caller, nhưng không thay được kết luận của type resolution; khi độ chính xác là điều kiện tiên quyết (xoá code, refactor đa hình) phải đọc thêm hoặc nâng cấp index.
