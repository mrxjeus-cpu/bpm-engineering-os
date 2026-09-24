# BPM Engineering OS — Development Specification

> **Trạng thái:** v1.0 — bản tổng hợp từ hội thoại thiết kế (so sánh `obra/superpowers` vs `gsd-build/get-shit-done`)
> **Mục đích:** spec đủ chi tiết để một AI coding agent (hoặc team) implement Phase 1 mà không cần đọc lại hội thoại gốc.
> **Ngôn ngữ triển khai:** không ràng buộc. Runtime có thể là TypeScript/Python/Java; phần "brain" là markdown skills + MCP servers.

---

## 0. Nguồn & bối cảnh

Spec này tổng hợp từ một đoạn hội thoại phân tích kiến trúc, gồm 4 tầng nội dung:

1. **So sánh định vị** `obra/superpowers` (behavior-driven, skills, SDD, TDD) với `gsd-build/get-shit-done` (command-driven, workflow, state, waves).
2. **Phân tích source-level** hai framework: primitive nào đáng copy, primitive nào là bẫy (token burn, workflow phình to).
3. **Thiết kế "BPM Engineering OS"**: kiến trúc, context compiler, state machine, human gates, MCP domain.
4. **Bản spec nháp 46 mục** do hội thoại sinh ra (đã được gộp và tái cấu trúc ở đây).

Các dữ kiện ngoài được hội thoại ghi nhận (giữ nguyên như *finding*, không phải benchmark độc lập):

| Finding | Ý nghĩa cho thiết kế |
|---|---|
| Superpowers v6.4.1; `SDD` rewrite ở v6.0 (fresh subagent/task + review spec & quality + whole-branch review) | Lấy làm **coding kernel** |
| Superpowers có 2 execution mode: subagent-driven và native/inline | Cho phép **adaptive execution**, không ép mọi task qua subagent |
| `task-brief PLAN_FILE N` tách đúng section Task N | Nguồn gốc của **Context Slicing** |
| `verification-before-completion`: không claim done nếu không có evidence mới | Biến thành **machine-readable evidence gate** |
| `writing-skills` áp dụng TDD cho chính skill | Dùng để phát triển & regression-test skill nội bộ |
| GSD `execute-phase.md` ~1.800 dòng / 85 KB | **Anti-pattern**: không viết workflow khổng lồ |
| GSD: 33 agents / 88 workflows / 61 references | **Anti-pattern**: không clone agent organization |
| GSD router: 6 namespace routers, eager skill listing ~2.150 → ~120 token | Lấy **progressive disclosure + routing** |
| MCP schema nặng có thể tốn 20K+ token/turn | Bắt buộc **capability routing**, không expose 100 tools |
| GSD archived 26/06/2026 | GSD chỉ là *reference architecture*, không phải nền tảng để fork |
| Issue: SessionStart hook lỗi trên Windows/PowerShell, inject trùng context | Rủi ro nền tảng — phải test sớm trên môi trường corporate |
| Issue: SDD reviewer "do not re-run the suite" xung đột với verification-before-completion | Thiết kế evidence phải nêu rõ **ai chạy, chạy ở đâu** |
| Issue: verification skill không hỏi **evidence đến từ đâu** | Evidence phải có **provenance** (command, cwd, git SHA) |
| Issue: skill description tóm tắt workflow → agent đi theo description thay vì skill | Description chỉ nêu **WHEN**, không nêu HOW |

---

## 1. Tóm tắt điều hành

### 1.1 Ý tưởng một câu

> Xây một **context-aware engineering operating system** cho phát triển backend BPM/BPM: giữ **kỷ luật quy trình của Superpowers**, thêm **state/context/dependency engine nhẹ kiểu GSD**, và cắm **domain intelligence (DOMAIN/policy/fact/core) qua MCP** — để biến một ticket thật (ví dụ `TASK-49043`) thành một thay đổi code **có thể review, có thể audit, ít regression, với lượng context tối thiểu**.

### 1.2 Không phải là gì

- Không phải "GSD mới" hay bản fork của GSD.
- Không phải framework multi-agent tổng quát.
- Không phải hệ thống autonomous tự approve kiến trúc.
- Không phải RAG platform / knowledge graph toàn doanh nghiệp.

### 1.3 Nguyên tắc số 1 (bất biến)

> **Agent không được nhận toàn bộ project context. Agent chỉ nhận context tối thiểu nhưng đủ để thực hiện đúng task hiện tại.**

Đây là điểm giao nhau mạnh nhất giữa Superpowers và GSD, đồng thời là đòn trực tiếp vào vấn đề **token burn + codebase cực lớn** (20 microservices, 500+ class/service, có class 5.000+ LOC).

### 1.4 Chỉ số thành công chính

Không đo bằng *số agent*. Đo bằng:

> **Hệ thống chuyển một ticket BPM thật thành một code change đã verify, reviewable, ít regression — với bao nhiêu context/token, bao nhiêu lần can thiệp người, và tỉ lệ lỗi thoát (escape rate) là bao nhiêu?**

---

## 2. Bối cảnh & vấn đề cần giải

| Vấn đề | Biểu hiện | Hệ quả |
|---|---|---|
| Codebase lớn, legacy | Nhiều microservice, class dài, business rule phân tán trong policy/fact/rule | Agent không thể "đọc hết repo"; context sai → sửa sai chỗ |
| Token burn | Mỗi agent load PROJECT + REQUIREMENTS + ROADMAP + STATE + RESEARCH + references + MCP schemas | Chi phí cao, context loãng, chất lượng giảm |
| Nguy cơ regression | Yêu cầu kiểu "thêm field" nhưng agent refactor/xóa logic cũ | Rủi ro nghiệp vụ ngân hàng, không chấp nhận được |
| Thiếu evidence | Agent tự nói "done", "test passed" mà không có chứng cứ | Không audit được, không tin được |
| Domain knowledge nằm ngoài model | LLM không biết DOMAIN/policy fact/CoreAdapter/CORE | Impact analysis sai, hallucination |
| Quy trình không đồng nhất | Mỗi người/mỗi session một kiểu | Khó bàn giao, khó kiểm soát |

**Ràng buộc thực tế cần tôn trọng:** môi trường corporate (Windows/PowerShell), Git/GitLab nội bộ, Jira/Confluence, nhiều ticket chạy song song trên cùng codebase.

---

## 3. Định vị: lấy gì từ đâu

### 3.1 Superpowers = "compiler hành vi"

Superpowers biến một câu yêu cầu thành **process graph** (brainstorm → design → plan → execute → review → verify), nhưng graph này **không** nằm trong một workflow engine lớn; nó được encode trong các `SKILL.md`. Bốn nhóm primitive:

```text
Superpowers
├── 1. Bootstrap        → hooks / using-superpowers
├── 2. Process Skills   → brainstorming, writing-plans, TDD, verification
├── 3. Execution Skills → subagent-driven-development, executing-plans
└── 4. Supporting       → task-brief, workspace helpers
```

Hai insight quan trọng:

- **Hook không chạy workflow.** Nó chỉ đưa capability vào context → separation sạch giữa bootstrap và orchestration.
- **Skill chứa cả "when to use".** Skill = instruction **+ policy + routing rule** (ví dụ SDD có decision tree: có plan? → task độc lập? → ở lại session? → mới dùng SDD).

### 3.2 GSD = context-engineering + orchestration

```text
GSD = Context Compiler + Orchestrator + State Machine
Superpowers = Process Skills + Task Context Slicing + Review Discipline
```

Lấy từ GSD: **persistent state, context compiler, dependency graph/waves, model routing, workstreams, recovery, verification gates, progressive disclosure/router**.

### 3.3 Bảng quyết định copy / không copy

| Primitive | Quyết định | Lý do |
|---|---|---|
| Skill architecture (`SKILL.md`), auto-activation | **Copy** | Nhẹ, dễ fork, dễ domain hóa |
| Brainstorm trước plan, plan trước code | **Copy** | Tách WHAT khỏi HOW |
| Fresh subagent per task | **Copy** | Context isolation |
| Two-stage review (spec + quality) | **Copy** | "Code đúng ≠ đúng yêu cầu" |
| Verification-before-completion | **Copy + nâng cấp** | Thành evidence machine-readable |
| Task brief / context slicing | **Copy + mở rộng** | Mở rộng thành Context Compiler |
| TDD cho skill | **Copy** | Regression-test cho chính process |
| Native/inline execution mode | **Copy** | Adaptive execution, tránh overhead |
| Persistent state trên filesystem | **Copy (kiểu GSD)** | State sống qua `/clear`, crash, đổi máy |
| Dependency graph + waves | **Copy** | Parallel có kiểm soát |
| Model routing theo complexity/risk | **Copy** | Cost/quality balance |
| Workstreams tách theo ticket | **Copy** | Nhiều ticket song song |
| Event surface cho hệ thống ngoài | **Tự xây** | Superpowers yếu điểm này |
| `execute-phase.md` 1.800 dòng | **Không copy** | Chia nhỏ < 200 dòng/file |
| 33 agents / 88 workflows / 61 references | **Không copy** | Token + maintenance burden |
| Full autonomous execution mặc định | **Không** | Banking cần human gate |
| Eager load toàn bộ skill/MCP schema | **Không** | Recurring per-turn cost |

### 3.4 Nguyên tắc phân tách trách nhiệm

```text
Skill  = HOW      (cách làm)
MCP    = WHERE    (lấy dữ liệu ở đâu)
State  = WHAT HAPPENED (đã xảy ra gì)
Agent  = DECISION / EXECUTION
Human  = APPROVAL
```

---

## 4. Invariants (bất biến kiến trúc)

Đây là các rule **không được vi phạm** khi implement; mọi PR phải kiểm tra lại danh sách này.

| ID | Invariant |
|---|---|
| INV-01 | Worker agent **không** nhận toàn bộ conversation, toàn bộ repo, toàn bộ `.engineering/`, hay lịch sử agent trước. |
| INV-02 | State sống **ngoài** LLM context, machine-readable, file-based; conversation không phải source of truth. |
| INV-03 | Không transition trạng thái nếu thiếu evidence tương ứng (RULES-001). |
| INV-04 | Không xóa/đổi business logic ngoài scope task; mọi deletion phải nằm trong allowlist. |
| INV-05 | Architecture decision phải qua **human gate** trước implementation (trừ mode hạ thấp rủi ro có cấu hình). |
| INV-06 | MCP không available ⇒ agent **không được** tự bịa domain data; trạng thái chuyển `BLOCKED`. |
| INV-07 | Mọi component runtime phải testable độc lập qua interface; không hard-code một LLM provider hay một frontend (Claude Code). |
| INV-08 | Business logic BPM **không** nằm trong orchestration runtime; nó nằm trong `mcp-domain-core`. |
| INV-09 | Workflow/skill phải nhỏ; không file nào vượt ngưỡng quy định (khuyến nghị < 200 dòng cho workflow, < 300 dòng cho skill). |
| INV-10 | Chỉ expose skill/MCP toolset **liên quan tới phase hiện tại**. |
| INV-11 | Parallel chỉ khi `conflict_check = PASS` (file, interface, DB migration, quyết định kiến trúc). |
| INV-12 | Evidence phải có **provenance**: command, cwd, exit code, timestamp, git SHA, artifact path. |

---

## 5. Kiến trúc tổng thể

```text
                              USER
                                │
                                ▼
                     ┌────────────────────┐
                     │    MAIN AGENT      │  thin orchestrator
                     │  (acts as "user")  │
                     └─────────┬──────────┘
                               │  explicit command (phase)
                               ▼
                     ┌────────────────────┐
                     │   PHASE ROUTER     │  + skill router (implicit)
                     └─────────┬──────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
   REQUIREMENTS             IMPACT                ARCHITECTURE
   (researcher)          (impact agent)           (architect)
        │                      │                      │
        └──────────────────────┼──────────────────────┘
                               ▼
                     ┌────────────────────┐
                     │  CONTEXT COMPILER  │  core technology
                     └─────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
      mcp-engineering   mcp-domain-core      mcp-<domain>*
              │                │                │
              └────────────────┼────────────────┘
                               ▼
                          DESIGN / PLAN
                               │
                       HUMAN GATE (risk-based)
                               │
                     DEPENDENCY GRAPH → WAVES
                               │
                 ┌─────────────┴─────────────┐
                 ▼                           ▼
            fresh worker                fresh worker
                 │                           │
                 └─────────────┬─────────────┘
                               ▼
                    SPEC REVIEW → QUALITY REVIEW
                               ▼
                            AUDIT
                               ▼
                        VERIFICATION
                               ▼
                             DONE

  (*) domain MCP chỉ enable khi task metadata yêu cầu — chống token overhead
```

**Vai trò Main Agent (thin orchestrator):** đọc task state → xác định phase → chọn skill → build context → spawn worker → collect result → update state → enforce gate → recover failure. Main Agent **không chứa** business logic implementation.

### 5.1 Thành phần runtime

| # | Component | Trách nhiệm | Interface |
|---|---|---|---|
| 1 | `StateStore` | Đọc/ghi state task, atomic, resume | `get(taskId)`, `save(state)` |
| 2 | `EvidenceStore` | Lưu evidence có provenance | `record(e)`, `list(taskId, filter)` |
| 3 | `ContextCompiler` | Sinh `task-context.md` tối thiểu | `compile(ContextRequest)` |
| 4 | `DependencyGraph` | Parse plan → DAG → waves | `buildWaves(plan)` |
| 5 | `WaveExecutor` | Chạy wave, conflict check, retry | `execute(wave)` |
| 6 | `AgentRunner` | Chạy worker với prompt contract | `run(AgentRequest)` |
| 7 | `McpGateway` | Gọi MCP, cap output, cache | `call(McpRequest)` |
| 8 | `WorkflowEngine` | Điều phối phase, gate | `execute(taskId)` |
| 9 | `GateEngine` | Đánh giá gate + risk | `evaluate(taskId, gateId)` |
| 10 | `EventBus` | Phát lifecycle events | `emit(event)` |
| 11 | `RecoveryEngine` | Phân loại lỗi, build recovery context | `recover(failure)` |
| 12 | `ModelRouter` | Chọn model theo complexity/risk/phase | `resolve(agentRole, task)` |

---

## 6. Mô hình điều khiển: Hybrid command + skill

**Quyết định:** không chọn 100% Superpowers (implicit, khó debug) cũng không 100% GSD (nhiều command ceremony).

> **Command xác định PHASE. Skill xác định CÁCH LÀM bên trong phase.**

```text
/eng analyze TASK-49043        ← explicit (predictable, auditable)
        │
        └── bên trong (implicit skills)
            ├── requirements-analysis
            ├── impact-analysis
            └── domain skills (policy, fact, core)
```

| Tiêu chí | Command-driven (GSD) | Skill-driven (Superpowers) | Chọn cho BPM |
|---|---|---|---|
| Predictability | Cao | Thấp hơn | Command ở phase |
| User control | Cao | Thấp hơn | Command ở phase |
| UX | Nhiều command | Tự nhiên | Hybrid |
| Debug workflow | Dễ | Khó hơn | Command ở phase |
| Token overhead | Có thể cao | Thấp hơn | Skill bên trong |
| Automation | Rõ ràng | Implicit | Hybrid |

### 6.1 Cấu trúc một skill (3 lớp bắt buộc)

```markdown
---
name: domain-impact-analysis
description: Use when a requirement changes product/policy/input/output or when
  downstream impact of an existing service is unknown.   # chỉ WHEN, không mô tả HOW
---

## WHEN
- ...
## DO
1. ...
## MUST OUTPUT
- impact.md, affected-files.md, risk.md, unknowns.md
## MUST NOT
- modify source code
```

### 6.2 Skill catalog Phase 1

```text
skills/
├── router/                    # ~100 token, chọn skill theo phase + task metadata
├── meta/
│   ├── brainstorming/         # WHAT trước HOW, human approve design
│   ├── writing-plan/          # plan đủ cụ thể cho người ngoài context
│   ├── tdd/                   # RED → GREEN → REFACTOR, bắt buộc thấy test fail
│   ├── systematic-debugging/  # root cause trước khi sửa
│   └── verification/          # NO COMPLETION CLAIMS WITHOUT FRESH EVIDENCE
├── engineering/
│   ├── requirements-analysis/
│   ├── impact-analysis/
│   ├── architecture-review/
│   ├── implementation/
│   ├── code-review/
│   ├── audit/
│   ├── task-context/          # context slicing
│   ├── existing-code-first/   # bắt buộc tìm pattern có sẵn trước khi tạo abstraction
│   └── recovery/
└── domain/
    ├── policy-analysis/
    ├── fact-context/
    ├── policy-core/
    ├── pre-screening/
    └── full-processing/
```

---

## 7. Context Engineering (core technology)

### 7.1 Phân cấp context 4 tầng

```text
GLOBAL   ─ coding standards, security rules, architecture principles, Git rules,
           testing rules, "do not delete existing logic", banking safety constraints
   │
PROJECT  ─ service map, module map, dependency graph, tech stack, DB, conventions
   │
TASK     ─ requirement, business context, affected services, impact, design, AC
   │
SUBTASK  ─ exact files, classes, methods, relevant existing code, expected change,
           test target, constraints
```

Worker context = `GLOBAL + PROJECT(relevant subset) + TASK + SUBTASK`. Không load phần không liên quan.

### 7.2 Context slicing (từ `task-brief`)

```text
Full plan (500 dòng)
    │  dependency analysis
    ▼
Relevant section (Task 7 – 40 dòng)
    │  + interfaces + decisions + tests + business rules
    ▼
task-07-brief.md
    ▼
Fresh agent
```

Quy tắc: **không truyền toàn bộ plan** nếu worker chỉ cần một task. Subagent **không được tự đọc** toàn bộ plan.

### 7.3 Context Compiler

Input: `taskId`, `subTaskId`, `plan`, `architecture`, repository, MCP data.
Output: `.engineering/workstreams/<TICKET>/context/task-NN.md`

Compiler phải:
1. tìm relevant symbols; 2. tìm callers/callees; 3. tìm implementations; 4. tìm similar implementation; 5. lấy architecture constraints; 6. lấy business rules; 7. lấy test locations; 8. lấy Git history khi cần; 9. loại bỏ dữ liệu không liên quan; 10. sinh context compact.

Chiến lược lấy dữ liệu (không lấy nguyên file):

```text
symbol → surrounding method → class structure → callers → dependencies → similar implementation
```

Ví dụ thay vì 5.000 dòng `PolicyService.java`, lấy:

```text
PolicyService.checkPolicy()
PolicyService.buildInput()
PolicyInputMapper.map()
relevant DTO
relevant test
```

Mẫu output:

```markdown
# TASK-03 Context
## Objective      Add Purpose of the Loan to DOMAIN policy input
## Files          PolicyInput.java · PolicyInputMapper.java · PolicyService.java
## Existing Pattern   Policy input fields are mapped through PolicyInputMapper
## Business Rules     TD1: ... ; TD2: ...
## Constraints        Do not delete existing logic; preserve backward compatibility
## Tests              PolicyInputMapperTest · PolicyServiceTest
## Acceptance Criteria  1. ... 2. ... 3. ...
## Verification Criteria
```

### 7.4 Progressive disclosure

MCP trả theo cấp, không trả database:

```text
find_policy(query)          → summary (id, name, inputs, rulesCount)
     ↓
get_policy_details(id)      → metadata
     ↓
get_policy_rules(id, rule)  → specific rule
```

Mục tiêu: **giảm kích thước context trước khi nó tới LLM**, không trông chờ model tự bỏ qua token.

### 7.5 Context budget (định hướng, chỉnh theo đo lường)

```text
MAIN AGENT     ~15%
REQUIREMENTS   ~20%
IMPACT         ~25%
ARCHITECTURE   ~30%
DEV (per task) ~20%
REVIEW         ~15%
```

Nguyên tắc cao hơn con số:

> Không tối ưu bằng cách cắt context mù quáng; tối ưu bằng cách chỉ đưa **context có causal relevance**.

### 7.6 Kiến trúc token-efficient của session

```text
SESSION ── 100–500 tokens ──▶ Skill Router ── ~100 tokens ──▶ Relevant Skill ── 1–3K ──▶
Context Compiler ── targeted context ──▶ Subagent
```

Tuyệt đối tránh: session → load everything → all skills → all MCP schemas → all agents → all project docs.

---

## 8. State & Evidence

### 8.1 State machine

```text
NEW → TRANSLATING → REQUIREMENT_ANALYSIS → IMPACT_ANALYSIS → DESIGNING
    → WAITING_DESIGN_APPROVAL → PLANNING → (WAITING_PLAN_APPROVAL)
    → READY_TO_IMPLEMENT → IMPLEMENTING → REVIEWING → AUDITING → VERIFYING → DONE
```

Nhánh lỗi / nhánh phụ:

```text
IMPLEMENTING → FAILED → DEBUGGING → IMPLEMENTING
REVIEWING    → REWORK_REQUIRED → IMPLEMENTING
<any>        → BLOCKED            (MCP unavailable, thiếu context, chờ human, thiếu evidence)
```

Skill-level (theo task con):

```text
PENDING → IN_PROGRESS → TESTING → SPEC_REVIEW → QUALITY_REVIEW → DONE
                 │            │           │             │
                 └── FAIL ────┴─── FIX ◀──┴─────────────┘
```

### 8.2 State schema (`task.json`)

```json
{
  "taskId": "TASK-49043",
  "title": "Add Purpose of the Loan to DOMAIN policy input",
  "status": "IMPLEMENTING",
  "phase": "implementation",
  "risk": "HIGH",
  "mode": "normal",
  "currentWave": 2,
  "currentTasks": ["TASK-03", "TASK-04"],
  "completedTasks": ["TASK-01", "TASK-02"],
  "blocked": false,
  "blockReason": null,
  "approvals": { "architecture": true, "implementationPlan": false },
  "evidence": ["evidence/requirements.json", "evidence/design-review.json"],
  "domains": ["domain", "loan"],
  "capabilities": ["policy", "fact"],
  "git": { "branch": "feature/TASK-49043", "baseSha": "..." },
  "history": [{ "at": "2026-09-24T09:00:00+07:00", "from": "IMPACT_ANALYSIS", "to": "DESIGNING", "by": "orchestrator" }]
}
```

### 8.3 Evidence schema

```json
{
  "id": "EV-0007",
  "type": "TEST",
  "status": "PASS",
  "command": "./mvnw test -Dtest=PolicyServiceTest",
  "cwd": "/repo/msmb-individual-individual",
  "exitCode": 0,
  "gitSha": "a1b2c3d",
  "artifact": "evidence/logs/EV-0007.txt",
  "timestamp": "2026-09-24T09:00:00+07:00",
  "producer": "developer:TASK-03",
  "summary": "17 tests passed"
}
```

**Evidence types tối thiểu:** `TEST`, `BUILD`, `SPEC_REVIEW`, `QUALITY_REVIEW`, `AUDIT`, `GIT_DIFF`, `SCOPE_VALIDATION`, `HUMAN_APPROVAL`, `MCP_QUERY`, `SIMILAR_CODE_SEARCH`.

### 8.4 RULES-001 — Evidence-gated transition (kernel invariant)

```text
RULE-001: Agent MUST NOT transition IMPLEMENTING → DONE without:
  - tests executed (có exit code)
  - output inspected (log artifact)
  - requirements checked (spec review PASS)
  - diff inspected (scope validation PASS)
  - audit checks passed
```

Hệ quả thiết kế: **reviewer không được giả định là người chạy test**. Mọi evidence ghi rõ `producer` + `command` + `cwd`. Khi reviewer chỉ đọc lại evidence, ghi `type: SPEC_REVIEW` chứ không tạo `TEST` giả.

---

## 9. Workflow chi tiết

### 9.1 CLI (MVP)

> **Đã implement (parallel)**: `eng implement --parallel` chạy wave song song **chỉ khi** bật
> `worktrees.enabled` trong config/projects.yaml — mỗi task một git worktree + branch riêng, cây chính
> không bị đụng, merge bằng lệnh riêng `eng merge` (từ chối merge vào branch bảo vệ, tự abort khi
> conflict). Mọi đường ghi đi qua lock workstream (`WORKSTREAM_LOCKED`) để chống ghi chồng.
>
> **Đã implement**: các lệnh phase gói sẵn chuỗi bước (`translate · analyze · design · plan · implement ·
> review · audit · verify`) có `--dry-run`, tự thu evidence cơ học (build/test/scope qua MCP) và tự
> gọi RecoveryEngine khi worker lỗi. Lệnh dữ liệu (`plan import|show`, `graph`, `wave`, `subtask`,
> `context`, `agent`, `skills`, `recover`) đứng riêng.
>
> **Đã implement — `eng continue`**: chạy LIÊN TIẾP các phase suy ra từ `task.json.status` cho tới khi
> gặp việc phải do người quyết (`DONE` · human gate · evidence gate · phải merge · lỗi). Exit code 0
> chỉ khi ticket tới `DONE`; mỗi điểm dừng in ra đúng lệnh cần gõ tiếp. Không nới gate nào (INV-03/INV-05).

```text
/eng new TASK-49043
/eng status TASK-49043
/eng continue   TASK-49043          # chạy tới khi phải chờ người — đường mặc định cho việc hằng ngày
/eng translate  TASK-49043          # (từng phase, khi cần chạy riêng)
/eng analyze    TASK-49043          # requirements + impact
/eng design     TASK-49043
/eng plan       TASK-49043
/eng implement  TASK-49043
/eng review     TASK-49043
/eng audit      TASK-49043
/eng verify     TASK-49043
/eng resume | retry | approve <TICKET> <gate>
```

### 9.2 Luồng một ticket

```text
Step 1  /eng new        → tạo workstream, state = NEW
Step 2  translate       → Researcher → requirements.md, open_questions.md, assumptions.md
Step 3  requirements    → state = REQUIREMENT_ANALYSIS (WHAT changed/why/who affected/AC/unknowns)
Step 4  impact          → Impact agent + MCP → impact.md (API/DB/entity/service/policy/fact/external/test)
Step 5  design          → Architect → architecture.md (options A/B/C + decision + trade-offs + migration)
Step 6  HUMAN GATE      → state = WAITING_DESIGN_APPROVAL (block mọi implementation)
Step 7  plan            → plan.md chia task nhỏ, có Objective/Files/Dependencies/AC/Verification
Step 8  graph           → parse plan → DAG → waves (conflict check)
Step 9  context compile → mỗi task một context/task-NN.md (fresh, tối thiểu)
Step 10 execute         → wave N: fresh worker/task → spec review → quality review → task done
Step 11 final review    → whole-branch review trên toàn bộ diff
Step 12 audit           → audit.md (banking checks)
Step 13 verify          → build + tests + scope validation + AC check
Step 14 DONE            → emit Completed, cập nhật tracker
```

### 9.3 Plan format (bắt buộc)

```markdown
## TASK-03 — Update Policy Input
### Objective
### Repo         (tên project trong config/projects.yaml — BẮT BUỘC khi ticket chạm nhiều repo)
### Files        (chính xác đường dẫn, file sửa/tạo — tương đối so với repoRoot của Repo)
### Symbols
### Dependencies  (none | TASK-01, TASK-02)
### Existing Pattern (bắt buộc nếu có)
### Acceptance Criteria
### Verification  (test cụ thể / cách kiểm chứng)
```

Plan compiler chuyển markdown → DAG. Task chỉ vào wave khi `all(deps) == DONE`.

### 9.4 Wave execution & conflict detection

```text
TASK-01 ─────┐
             ├── TASK-03 ── TASK-05
TASK-02 ─────┘
TASK-04 ───────────────── TASK-06

Wave 1: T1 T2 T4    Wave 2: T3    Wave 3: T5 T6
```

Parallel chỉ khi: không trùng file, không trùng interface/signature, không trùng DB migration, không phụ thuộc ngữ nghĩa, không dùng chung resource. Ví dụ:

```text
T1 → PolicyService.java   T2 → PolicyService.java      ⇒ KHÔNG parallel
T1 → PolicyService.java   T2 → CustomerMapper.java     ⇒ parallel nếu DAG cho phép
```

Khuyến nghị: **không parallel quá sớm** trên codebase ngân hàng — `parallelism ≠ always faster`.

### 9.5 Multi-repo — một feature sửa nhiều repo

Bối cảnh: một feature BPM thường phải sửa **nhiều repo** cùng lúc (service + consumer/SDK + cấu hình),
và các repo đó có thể nằm ở **các thư mục cha khác nhau**. Mô hình là **1 ticket = 1 feature = n repo**;
không nhồi nhiều repo vào một task, cũng không cần gộp repo về cùng thư mục.

| Khai ở đâu | Ý nghĩa |
|---|---|
| `config/projects.yaml → projects.<name>` | một repo; `repoRoot` lấy từ env (đường dẫn tuyệt đối) ⇒ vị trí thư mục không quan trọng |
| `task.json → projects[]` | repo của ticket; phần tử **đầu** là repo chính |
| `plan.md → ### Repo` / `plan.json → tasks[].repo` | repo của **từng task**; không khai ⇒ repo chính |
| `evidence.project` | evidence thuộc repo nào |

Luật bắt buộc:

1. Tên repo phải là project có thật trong `config/projects.yaml`. Tên lạ ⇒ lỗi rõ ràng, **không** suy ra đường dẫn (INV-06).
2. Mỗi task chỉ sửa **một** repo (khai nhiều ⇒ lỗi `MULTIPLE_REPO`).
3. `Files`/`Symbols` là đường dẫn **tương đối** so với repoRoot của repo task đó; context compiler chỉ tra trong repo đó.
4. Conflict check (INV-11) so theo cặp **(repo, file)** và **(repo, symbol)**: cùng file ở hai repo khác nhau **không** phải conflict; migration chỉ cạnh tranh thứ tự trong cùng repo.
5. Gate evidence: `BUILD`, `TEST`, `SCOPE_VALIDATION` là evidence **cấp repo** ⇒ ticket có ≥ 2 repo phải có đủ cho **từng** repo (`evidence.project` bắt buộc). `SPEC_REVIEW`, `QUALITY_REVIEW`, `AUDIT`, `HUMAN_APPROVAL` là **cấp ticket** (một người review cả feature).
6. `eng implement --parallel`: mỗi task tạo worktree trong repo của nó; `eng merge` merge theo repo ghi trong `tasks/<TASK-NN>-changes.json`.
7. Thứ tự phụ thuộc **xuyên repo** dùng chính `### Dependencies` — ví dụ task ở repo B phụ thuộc task ở repo A để chốt contract trước.
8. Ticket không khai repo nào ⇒ giữ nguyên hành vi cũ: repo lấy từ `--project` hoặc `defaultProject`.

```bash
eng new PAY-101 --title "Đổi contract thanh toán" --risk HIGH \
  --project payment-api --project payment-client
eng plan import PAY-101 --file plan.md          # mỗi task khai ### Repo
eng implement PAY-101 --project payment-api     # (tuỳ chọn) giới hạn 1 repo
eng verify PAY-101                              # verify MỌI repo của ticket
eng metrics PAY-101 --write                     # có breakdown evidence theo repo
```

Giới hạn đã biết: `eng merge` **không** tự merge xuyên repo (thứ tự merge do người quyết: repo contract trước,
consumer sau); contract giữa các repo phải được chốt ở `architecture.md` của ticket — runtime không tự suy diễn.

---

## 10. Agent & skill contracts

Mọi worker prompt theo **prompt contract**:

```text
ROLE
OBJECTIVE
TASK
CONTEXT          (đường dẫn file context, không paste)
CONSTRAINTS
INPUTS
EXPECTED OUTPUT
VERIFICATION
DO NOT
```

### 10.1 Researcher / Translator

- **Input:** raw ticket, project context (GLOBAL + PROJECT subset).
- **Output:** `requirements.md`, `open_questions.md`, `assumptions.md`.
- **Trả lời:** WHAT changed? WHY? WHO affected? WHAT unchanged? AC? Business rules? Unknowns?
- **Không code.**

### 10.2 Impact agent

- **Input:** requirements + repository + `mcp-engineering` + `mcp-domain-core`.
- **Output:** `impact.md`
- **Phải xác định:** affected service / module / class / DB / downstream / API / policy / fact / external; regression risk areas.

### 10.3 Architect

- **Input:** requirements + impact + architecture constraints + existing patterns.
- **Output:** `architecture.md` gồm `Problem · Current Architecture · Proposed · Alternatives · Decision · Trade-offs · Affected Components · Migration · Testing · Risks · Rollback`.
- **Không code.** Phải đưa nhiều option (A/B/C).

### 10.4 Developer

- **Input:** `task-context.md` + relevant files + tests + constraints.
- **Output:** code changes + test evidence + `task-NN-report.md`.
- **Không được** tự đổi architecture decision, không xóa logic cũ, không sửa file ngoài scope.
- Theo TDD: RED (thấy test fail) → GREEN (minimal impl) → REFACTOR.

### 10.5 Reviewer (2 tầng)

- **Spec compliance:** "implementation có đúng yêu cầu không?" (đúng AC, đúng business rule).
- **Code quality:** "implementation có tốt về kỹ thuật không?" (pattern, naming, test, transaction boundary, duplicate).
- Ví dụ vì sao tách: code compile + test pass + sạch, nhưng thiếu nhánh "furniture" của TD1 ⇒ quality = PASS, spec = FAIL.

### 10.6 Auditor

- **Input:** toàn bộ diff + requirements + design + evidence.
- **Output:** `audit.md`.
- Kiểm: requirement coverage, architecture compliance, unexpected behavior change, security, data integrity, backward compatibility, logging, exception handling, transaction boundaries, concurrency, performance, SQL/Oracle compatibility, audit trail.

### 10.7 existing-code-first (skill bắt buộc trước khi tạo abstraction)

```text
1. search existing implementation
2. search similar feature
3. identify existing pattern
4. reuse if applicable
5. explain deviation if not reusable

DO NOT: rewrite existing logic · introduce framework unnecessarily ·
        refactor unrelated code · rename unrelated classes ·
        change public contracts without approval
```

---

## 11. Gates, Risk Engine & Execution modes

### 11.1 Gates

| Gate | Vị trí | Bắt buộc | Bypass |
|---|---|---|---|
| Requirements gate | sau requirements | Không (mặc định) | mode autonomous |
| **Architecture gate** | DESIGNING → PLANNING | **Có** | chỉ khi risk LOW + config |
| Implementation-plan gate | PLAN → IMPLEMENT | Có nếu thay đổi lớn | config cho change nhỏ |
| Evidence gate | mọi transition | **Có (INV-03)** | không |
| Scope gate | trước REVIEWING | **Có (INV-04)** | allowlist tường minh |

### 11.2 Risk engine

Input: DB change, API change, policy change, core integration, security, money calculation, concurrency, backward compatibility.
Output: `LOW | MEDIUM | HIGH | CRITICAL`.

```text
Add nullable DB column            → LOW
Add DTO + mapper                  → LOW/MEDIUM
Modify policy rule (TD1/TD2)      → HIGH
Change loan amount calculation    → CRITICAL
Architecture redesign             → CRITICAL
```

Risk quyết định: **model tier**, **số human gate bắt buộc**, **mức độ audit**, **có được phép parallel hay không**.

### 11.3 Execution modes

| Mode | Gate | Dùng cho |
|---|---|---|
| `safe` | BA → Human, Impact → Human, Design → Human, Plan → Human | Task HIGH/CRITICAL, production-critical |
| `normal` (mặc định) | Design → Human; còn lại tự động | Đa số task |
| `autonomous` | Tự động toàn bộ | Chỉ task LOW risk, có allowlist rõ |

---

## 12. Model routing & cost

```yaml
# config/models.yaml
models:
  translator:   { model: glm-text }
  requirements: { model: sonnet }
  impact:       { model: sonnet }
  architecture: { model: opus }
  developer:    { model: sonnet }
  reviewer:     { model: sonnet }
  auditor:      { model: opus }

complexity:
  simple:  haiku
  medium:  sonnet
  complex: opus

routing:
  weights: { complexity: 0.4, risk: 0.4, contextSize: 0.1, phase: 0.1 }
  caps:    { maxTier: opus, fallback: sonnet }
```

Nguyên tắc:

```text
Model = f(complexity, risk, context, task-type)     # KHÔNG phải cheapest
```

Trong banking, tiết kiệm $0.10 không đáng nếu dẫn tới **wrong policy**.

---

## 13. MCP layer

### 13.1 Nguyên tắc

- Chỉ 2 MCP ở Phase 1: `mcp-engineering`, `mcp-domain-core`.
- Mỗi MCP expose **~10–20 high-level tools**, không phải 100.
- **Bật/tắt ở cấp SERVER**: mỗi server khai `enabled: true|false` trong `config/mcp.yaml`.
  `false` = **TẠM DỪNG**: runtime không spawn tiến trình, ContextCompiler không gọi, `eng doctor`
  chỉ ghi chú (không FAIL), `eng context` in cảnh báo rõ. Code/dataset vẫn nằm trong repo để bật lại 1 dòng.
  **Trạng thái Phase 1: `mcp-domain-core` đang TẠM DỪNG** (lý do ở 13.3) ⇒ context chỉ có dữ liệu kỹ thuật
  từ `mcp-engineering`, và **cấm suy diễn** policy/rule khi thiếu nguồn (INV-06).
- **Capability routing theo task metadata**: chỉ enable MCP/toolset liên quan.
- Kết quả MCP phải: nhỏ, có cấu trúc, có ID, có source/reference, có confidence (nếu semantic), có pagination, không duplicate.
- MCP **không** quyết định workflow; skill **không** chứa data.

```yaml
# task metadata → MCP routing
domain: [domain, loan]
capabilities: [policy, fact]
# ⇒ enable mcp-engineering + mcp-domain-core; KHÔNG enable mcp-card/mcp-deposit
```

### 13.2 `mcp-engineering` — repo/engineering intelligence

```text
context      get_project_context · get_service_context · get_module_context ·
             build_task_context(taskId, subTaskId)
code         search_code · find_symbol · find_references · find_callers ·
             find_implementations · find_similar_code · read_symbol ·
             get_change_context(file, symbol)
architecture get_architecture_constraints · get_service_dependencies ·
             get_module_dependencies · get_project_conventions
git          git_status · git_diff · git_diff_file · git_history ·
             find_related_commits · validate_change_scope
verification run_build · run_test · run_tests · validate_scope
task/state   get_task_state · update_task_state · record_evidence · emit_event
```

`get_change_context(file, symbol)` — tool đáng xây nhất cho codebase lớn:

```json
{ "symbol": "...", "definition": "...", "callers": [], "callees": [],
  "interfaces": [], "tests": [], "dbDependencies": [], "policyDependencies": [] }
```

`find_similar_implementation(requirement)` — cơ chế chống hallucination cho legacy:

```text
"add new policy input" → Policy A / Policy B / Policy C (pattern hiện có)
```

`validate_change_scope(taskId, allowedFiles)` → `{ unexpectedFiles, deletedFiles, status }`.

### 13.3 `mcp-domain-core` — domain intelligence

> ⏸ **TẠM DỪNG ở Phase 1** (`config/mcp.yaml → servers.mcp-domain-core.enabled: false`).
> Lý do: mô hình nguồn nghiệp vụ hiện tại (một thư mục JSON synthetic) chưa khớp với cách tổ chức
> thực tế — nhiều **hệ thống**, mỗi hệ thống nhiều **repo** (BE/FE, core theo sản phẩm), và policy
> có thể đến từ nhiều nguồn khác schema. Khi nào nguồn thật + trục chia được chốt thì bật lại
> (`enabled: true`), hoặc tách theo nguồn qua `routing.byDomain` (tiền lệ: `mcp-card`, `mcp-deposit`).

```text
product   find_product · get_product
policy    find_policy · get_policy · get_policy_inputs · get_policy_rules ·
          get_policy_dependencies · trace_policy_dependency
fact      find_customer_facts · find_loan_facts · find_cic_facts
core      get_core_input_schema · get_core_output_schema · get_core_adapter
reference find_similar_policy · find_similar_change · find_existing_pattern
```

### 13.4 Domain knowledge graph (mục tiêu)

```text
PurposeOfLoan
   ├── APPL
   ├── PolicyInput
   ├── Fact
   ├── Rule
   ├── CoreAdapter
   ├── DB
   └── PDF
```

Impact Agent dùng graph này thay vì tự mò toàn repo.

### 13.5 MCP failure handling

```text
mcp-domain-core unavailable
   ⇒ status = BLOCKED
   ⇒ message: "Cannot verify current policy definition because mcp-domain-core is
      unavailable. Status remains BLOCKED."
   ⇒ TUYỆT ĐỐI không hallucinate policy data
```

---

## 14. Event bus & tích hợp

Superpowers thiếu event surface cho hệ thống ngoài (chỉ quan sát được qua SessionStart/artifact/Git). Engineering OS thiết kế event bus ngay từ đầu:

```text
TaskCreated · RequirementCompleted · ImpactCompleted · DesignApproved ·
PlanCreated · TaskStarted · TaskCompleted · ReviewFailed · ReviewPassed ·
AuditFailed · AuditPassed · HumanApprovalRequired · Blocked · Completed · AgentRun
```

`AgentRun` (thêm ở Phase 1) mang dữ liệu **thật của lần chạy worker**: `role`, `modelTier`, `model`,
`harness`, `durationMs`, `exitCode`, `ok`, `promptTokensEstimate`, `artifactsMissing`, `logRef`, và
`usage` (token) **nếu harness báo** qua `ENG_USAGE_FILE`. Đây là nguồn duy nhất để metric cost/ticket
theo risk tier có provenance — runtime không tự đo token của provider.

Consumer (Phase 4): Jira update · dashboard · audit log · cost tracking · Slack/Teams · state update.

Agent không cần biết các hệ thống này tồn tại.

---

## 15. Failure & recovery

```text
FAILED → collect error → classify → DEBUGGING (KHÔNG restart agent mù quáng)
```

Phân loại: `COMPILE_ERROR · TEST_FAILURE · MISSING_CONTEXT · MCP_FAILURE · DESIGN_CONFLICT · FILE_CONFLICT · ENVIRONMENT_FAILURE · UNKNOWN`

> **Đã implement** trong `runtime/src/recovery/`: phân loại bằng **rule tất định** (không dùng LLM —
> phân loại sai sẽ dẫn tới sửa sai hướng), evidence do máy ghi mạnh hơn heuristic trên log,
> recovery context bị giới hạn dòng (không nhồi lại log/context — INV-01), và có **loop guard**:
> quá `maxAttempts` lần vào DEBUGGING thì dừng tự sửa và escalate cho người. Artifact:
> `tasks/recovery-<TASK-NN>.{md,json}` (validate bằng `schemas/recovery.schema.json`).

Recovery context **chỉ** chứa: `previous task context + error + relevant diff + failed test`.

```text
TESTING
 ├── evidence missing → BLOCKED
 ├── failed           → DEBUGGING → TESTING
 └── passed           → SPEC_REVIEW → QUALITY_REVIEW → AUDIT → DONE
```

---

## 16. Cấu trúc repository & workstream

### 16.1 Repo Engineering OS

```text
engineering-os/
├── README.md
├── ARCHITECTURE.md
├── CLAUDE.md / AGENTS.md          # GLOBAL rules, trỏ tới skill/MCP (không nhồi 20k dòng)
├── config/
│   ├── models.yaml   ├── gates.yaml   ├── risk.yaml
│   ├── mcp.yaml      └── projects.yaml
├── agents/    researcher.md · impact.md · architect.md · developer.md · reviewer.md · auditor.md
├── skills/    router · meta/ · engineering/ · domain/ · banking/
├── workflows/ translate.md · analyze-requirements.md · analyze-impact.md · design.md ·
│              plan.md · graph.md · wave.md · execute.md · review.md · audit.md ·
│              verify.md · recovery.md                # mỗi file < 200 dòng
├── schemas/   task.schema.json · evidence.schema.json · plan.schema.json ·
│              context.schema.json · review.schema.json · event.schema.json ·
│              recovery.schema.json
├── templates/ requirement.md · impact.md · design.md · plan.md · task-brief.md ·
│              task-report.md · review.md · audit.md
├── runtime/   orchestrator/ · state/ · context/ · graph/ · executor/ ·
│              evidence/ · events/ · recovery/ · router/
├── mcp/       mcp-engineering/ · mcp-domain-core/
└── tests/     unit + integration + skill-regression (TDD cho skill)
```

### 16.2 Workstream mỗi ticket (state/artifact, không chứa code)

```text
.engineering/
├── global/
│   ├── architecture.md · conventions.md · coding-standards.md
│   └── domain-map/
└── workstreams/
    └── TASK-49043/
        ├── task.json
        ├── requirements.md · open_questions.md · assumptions.md
        ├── impact.md
        ├── architecture.md
        ├── plan.md
        ├── tasks/    task-01-brief.md · task-01-report.md · task-02-… 
        ├── context/  task-01.md · task-02.md · task-03.md
        ├── evidence/ build.json · tests.json · scope.json · logs/
        ├── reviews/  task-01-spec.md · task-01-quality.md · final.md
        ├── audit.md
        └── events.jsonl
```

Code nằm trong Git repo bình thường; workstream chỉ chứa state/artifact (có thể commit để audit trail).

---

## 17. Runtime interfaces (conceptual)

```java
interface AgentRunner     { AgentResult  run(AgentRequest request); }
interface ContextCompiler { TaskContext  compile(ContextRequest request); }
interface StateStore      { TaskState    get(String taskId); void save(TaskState s); }
interface EvidenceStore   { void record(Evidence e); List<Evidence> get(String taskId); }
interface WorkflowEngine  { WorkflowResult execute(String taskId); }
interface DependencyGraph { List<Wave> buildWaves(Plan plan); }
interface McpGateway      { McpResult call(McpRequest request); }
interface GateEngine      { GateResult evaluate(String taskId, String gateId); }
interface EventBus        { void emit(DomainEvent event); }
```

Ngôn ngữ implementation có thể khác; **boundary** phải giữ nguyên.

---

## 18. Roadmap

### Phase 1 — Coding kernel + workflow end-to-end (MVP)

```text
✓ skill router
✓ brainstorming / writing-plan / TDD / verification / review
✓ task-brief + context slicing
✓ fresh worker per task
✓ state store + evidence store
✓ 4 agents: researcher, impact, architect, developer, reviewer
✓ 5 skills: requirements, impact, architecture, implementation, verification
✓ 1 state machine (task.json) + human gate
✓ 2 MCP (bản mỏng, đủ dùng)
✓ chạy 1 ticket thật end-to-end
✓ multi-repo: 1 ticket sửa nhiều repo ở các thư mục cha khác nhau (mục 9.5)
```

### Phase 2 — Engineering workflow đầy đủ

Translator · BA · impact sâu · SA · audit · risk engine · modes · dependency graph + waves · recovery · event bus (local).

### Phase 3 — BPM intelligence

`mcp-engineering` + `mcp-domain-core` bản đầy đủ · architecture retrieval · policy retrieval · similar implementation · domain knowledge graph.

### Phase 4 — Enterprise integration

Jira · Confluence · GitLab · event bus ra ngoài · audit dashboard · cost telemetry · policy/security compliance.

### 18.1 Thứ tự triển khai Phase 1 (không làm song song tất cả)

```text
 1. Repository skeleton + config loader
 2. Task state schema + StateStore
 3. Evidence schema + EvidenceStore
 4. AgentRunner abstraction + prompt contract renderer
 5. Context Compiler (bản tối thiểu: plan → task brief)
 6. mcp-engineering (bản mỏng: search_code, find_symbol, git_diff, validate_change_scope)
 7. mcp-domain-core (bản mỏng: find_policy, get_policy_inputs, get_policy_rules)
 8. Requirements workflow
 9. Impact workflow
10. Architecture workflow + human gate
11. Plan compiler + DAG + waves
12. Wave executor + conflict detection
13. Developer agent (fresh context, TDD)
14. Spec review
15. Quality review
16. Whole-branch review
17. Audit
18. Verification
19. Recovery
20. Real-ticket validation (TASK-49043) — preflight bằng `eng doctor`, xem `RUNBOOK.md`
```

---

## 19. Acceptance criteria Phase 1

Phase 1 hoàn thành khi hệ thống chạy được **một ticket thật end-to-end**:

```text
Ticket → Requirements → Impact → Architecture → Human approval → Plan → DAG
→ Context slicing → Developer → Task review → Final review → Audit → Verification → DONE
```

Phải chứng minh được:

| # | Tiêu chí | Cách kiểm chứng |
|---|---|---|
| A | **State** sống qua restart | Kill process, `/eng resume`, state đúng |
| B | **Context** slicing | Log cho thấy developer chỉ nhận `context/task-NN.md`, không nhận toàn repo/plan |
| C | **MCP** hoạt động | Ít nhất 1 truy vấn hữu ích qua mỗi MCP server |
| D | **Parallelism** | Ít nhất 2 task độc lập chạy cùng wave |
| E | **Review** độc lập | Output developer được review bởi agent khác context |
| F | **Evidence** | Build/test/review evidence persist, có provenance |
| G | **Regression** | Thay đổi file/symbol ngoài scope bị phát hiện (`validate_change_scope`) |
| H | **Human gate** | Chưa approve architecture thì không thể vào implementation |

**Definition of Done (mỗi task con):** code + test + report + spec review PASS + quality review PASS + evidence đủ + scope validation PASS.

---

## 20. Non-goals (không implement)

```text
✗ Autonomous unrestricted agent swarm
✗ Self-modifying workflows
✗ Automatic production deployment
✗ Automatic production DB migration
✗ Automatic approval of architecture
✗ Full enterprise knowledge graph / full RAG platform
✗ Generic multi-agent framework
✗ 20+ MCP servers
✗ Workflow prompt khổng lồ (kiểu execute-phase.md 1.800 dòng)
✗ Clone 33 agents / 88 workflows của GSD
✗ Đưa business logic BPM vào orchestration runtime
```

---

## 21. Metrics

| Nhóm | Metric | Mục tiêu định hướng |
|---|---|---|
| Context | Token/ticket; % context "causal relevant" | Giảm mạnh so với load-all; đo baseline trước |
| Chất lượng | Spec-review catch rate; regression escape rate | Escape rate → 0 cho HIGH/CRITICAL |
| Quy trình | Số lần human can thiệp/ticket; thời gian gate | Giảm dần theo phase, không giảm gate rủi ro cao |
| Evidence | % transition có evidence hợp lệ + provenance | 100% |
| Vận hành | Thời gian resume sau crash; số lần BLOCKED do MCP | Resume < 1 phút; MCP failure có đường xử lý |
| Cost | Cost/ticket theo risk tier | Opus chỉ dùng cho architecture/audit |
| Vận hành (mới) | Preflight trước khi chạy thật (`eng doctor`) | 0 FAIL trước mỗi lần chạy ticket thật |

**Công cụ đo:** `eng metrics <TASK_ID> [--json] [--write]` (`runtime/src/metrics/`) tính lại các metric **chỉ từ dữ liệu đã ghi** trong workstream (`task.json` history, `context/*.json`, `evidence/*.json`, `events.jsonl`) — không gọi MCP/LLM, không suy diễn số liệu thiếu.

| Metric | Trạng thái | Nguồn |
|---|---|---|
| Thời gian mỗi status (kể cả thời gian chờ gate) | ✅ đo được | `history[]` + `createdAt/updatedAt` |
| Số lần can thiệp người + thời gian gate + approver | ✅ đo được | transition vào/ra `WAITING_*` + evidence `HUMAN_APPROVAL` |
| % transition có evidence hợp lệ + provenance | ✅ đo được, tái dựng **tại thời điểm transition** | `evaluateEvidenceGate` với evidence `timestamp ≤ at` |
| Số lần BLOCKED / BLOCKED do MCP / thời lượng | ✅ đo được (block/unblock ghi vào `history[]`) | `BLOCK_REASON_PREFIX`, `UNBLOCK_REASON` |
| Token/ticket | 🟡 chỉ có **ước lượng** của Context Compiler | `context[].budget.tokenEstimate` — không phải token provider |
| Review rejection rate | 🟡 proxy cho catch rate | evidence `SPEC_REVIEW`/`QUALITY_REVIEW` không PASS |
| Resume sau crash | 🟡 đo gián đoạn BLOCKED; chưa đo thời gian `resume` thực tế | cần thêm timing vào CLI |
| Baseline so với cách làm cũ | ⬜ không đo được từ dữ liệu nội bộ | phải chạy ticket thật (mục 18.1 bước 20) |
| Regression escape rate | ⬜ cần dữ liệu sau release | nối nguồn bug/incident |
| Cost/ticket theo risk tier | ✅ tier + thời gian đo từ event `AgentRun`; token chỉ khi harness báo `ENG_USAGE_FILE` | `events.jsonl` |
| Cost/ticket quy ra tiền | ⬜ chưa có bảng giá theo tier trong repo | thêm `pricePerMTokIn/Out` vào `config/models.yaml → tiers` |
| % context "causal relevant" | ⬜ cần người chấm | reviewer chấm khi review, ghi thành evidence |

Nguyên tắc: metric ⬜/🟡 phải hiện diện trong output của `eng metrics` kèm lý do và cách bổ sung — **không** để chỗ trống dễ bị lấp bằng số ước lượng.

---

## 22. Risks & mitigations

| # | Rủi ro | Mitigation |
|---|---|---|
| R1 | Hook/bootstrap không ổn định trên Windows/PowerShell (đã có issue thực tế) | Test hook sớm, có fallback bootstrap thủ công; đừng để workflow phụ thuộc hook |
| R2 | MCP schema gây token overhead lớn | Capability routing theo phase; cap số tool; đo token/turn |
| R3 | Context Compiler kém → context thiếu → worker sửa sai | Bắt buộc `unknowns.md`; nếu thiếu thì BLOCKED, không đoán; đo "missing context" failure rate |
| R4 | Rơi vào bẫy over-engineering (xây framework-within-framework) | Tuân thủ INV-09, non-goals, thứ tự triển khai 20 bước |
| R5 | Agent hallucinate domain data khi MCP down | INV-06, evidence type MCP_QUERY bắt buộc |
| R6 | Parallel gây conflict interface | Conflict check bắt buộc; mặc định tuần tự khi chưa có kinh nghiệm |
| R7 | Git/worktree thao tác trên branch dùng chung gây rewrite | Định nghĩa remote-safety boundary: cấm push/rewrite branch bảo vệ; chỉ làm việc trên feature branch |
| R8 | Review trùng lặp / bỏ sót do "không chạy lại test" | Evidence ghi rõ producer; reviewer chỉ đọc evidence, không claim test mới |
| R9 | Skill description mô tả workflow khiến agent đi tắt | Description chỉ nêu WHEN; HOW nằm trong body skill |
| R10 | Nhiều ticket song song ghi đè workstream | Mỗi ticket một subtree `.engineering/workstreams/<TICKET>`; ghi atomic; lock file khi update |

---

## 23. Open questions (cần chốt trước/khi implement)

1. **Ngôn ngữ & nơi ở của runtime:** chạy như CLI nội bộ, plugin cho coding agent, hay service? (Phase 1 nên là CLI + file-based.)
2. **MCP server sẵn có:** BPM đã có MCP nội bộ nào để tái sử dụng, hay phải viết mới? Ai sở hữu index symbol?
3. **Symbol/index hạ tầng:** dùng LSP/JavaParser/SCIP hay search text? Đây là yếu tố quyết định chất lượng Context Compiler.
   - **Đã chốt cho Phase 1 (một phần):** dùng **pattern-based symbol index** (`mcp-engineering/src/symbols.ts` + `symbol-index.ts`) — regex khai báo theo ngôn ngữ + `package`/`import` + owner type, cache theo `gitSha` + TTL (`ENG_INDEX_TTL_MS`), pre-filter theo tên trước khi đọc file, kết quả xếp hạng `exact`/`likely`/`weak` kèm `reason`.
   - **Lý do:** không kéo thêm toolchain/build (JavaParser/LSP/SCIP) vào repo Phase 1 và không giả định chỉ một ngôn ngữ; index chỉ cần đủ tốt để **thu hẹp phạm vi đọc** và **xếp hạng** usage.
   - **Còn mở:** khi cần độ chính xác của type resolution (đa hình, generics, overload, kết luận "không còn caller") thì phải nâng cấp. Biên thay thế đã tách sẵn: giữ `extractSymbols()`/`rankUsage()`, thay phần dựng index — `code.ts`/`context.ts` không phải sửa.
4. **Nguồn requirement:** Jira API hay Confluence hay copy thủ công?
5. **Ai là người approve gate** (tech lead / SA / BA) và ghi nhận approval ở đâu?
6. **Baseline token:** đo 1 ticket theo cách hiện tại (dùng GSD/Superpowers) trước khi tối ưu.
7. **Chính sách dữ liệu:** class code nội bộ có được đưa ra LLM ngoài không? Ảnh hưởng tới model routing.
8. **Git workflow chuẩn:** feature branch naming, có dùng worktree không.

---

## 24. Phụ lục A — Prompt handoff cho AI implement

```text
ROLE
You are implementing the "BPM Engineering OS" according to SPEC-bpm-engineering-os.md.

OBJECTIVE
Deliver Phase 1 only: a runnable CLI + file-based state/evidence + context compiler
+ dependency graph/waves + 5 skills + 4 agents + 2 thin MCP servers, verified on ONE
real ticket end-to-end.

CONSTRAINTS (must hold)
- INV-01..INV-12 in section 4 are non-negotiable.
- Follow the implementation order in section 18.1; do not build all agents at once.
- No component may exceed the size limits (workflow < 200 lines, skill < 300 lines).
- Do not hard-code a single LLM provider or a single agent frontend.
- Do not embed BPM business logic in the runtime; it belongs to mcp-domain-core.
- Every MCP tool returns compact, structured, referenced output.

DELIVERABLES
1. Repo skeleton per section 16.1 + config loader.
2. JSON schemas per section 16.1 and stores per section 17.
3. Context Compiler producing context/task-NN.md per section 7.3.
4. Plan compiler + DAG + wave executor with conflict detection per section 9.4.
5. Skills catalog per section 6.2 with WHEN/DO/MUST OUTPUT/MUST NOT structure.
6. Two thin MCP servers with the tools in sections 13.2 and 13.3.
7. Gate engine + risk engine + evidence-gated transitions (RULES-001).
8. Demo run reproducing the section 19 acceptance criteria A–H on TASK-49043
   (or a representative ticket), with evidence artifacts.

VERIFICATION
- Unit tests for every runtime component.
- Integration tests for StateStore, ContextCompiler, DependencyGraph, WaveExecutor,
  McpGateway, WorkflowEngine.
- A skill regression test (TDD for skills): pressure scenario that fails without the
  skill and passes with it.

DO NOT
- Implement anything in section 20 (non-goals).
- Claim completion without fresh evidence (command + exit code + artifact).
```

---

## 25. Phụ lục B — Checklist review cho mọi PR

```text
[ ] INV-01 worker context không chứa conversation/repo/plan đầy đủ
[ ] INV-02 state ghi ra file, không dựa vào conversation
[ ] INV-03 mọi transition mới đều có evidence tương ứng
[ ] INV-04 không có deletion ngoài allowlist (scope validation PASS)
[ ] INV-05 human gate architecture vẫn chặn implementation
[ ] INV-06 MCP down ⇒ BLOCKED, không bịa dữ liệu
[ ] INV-07 qua interface, không hard-code provider/frontend
[ ] INV-08 không có business BPM trong runtime
[ ] INV-09 không file workflow/skill vượt ngưỡng
[ ] INV-10 toolset/skill expose theo phase
[ ] INV-11 parallel có conflict check PASS
[ ] INV-12 evidence có command + cwd + exitCode + gitSha + artifact
```

---

## 26. Kết luận thiết kế

```text
                 MBBANK ENGINEERING OS
                          │
     ┌────────────────────┼────────────────────┐
     │                    │                    │
SUPERPOWERS           GSD IDEAS            MBBANK
───────────           ─────────            ──────
Skills                Persistent state     BA / Impact / SA
Brainstorming         Context compiler     DOMAIN policy & fact
Task brief            Dependency graph     CoreAdapter / DB
Fresh subagent        Waves                Banking audit
TDD                   Model routing        Risk & safety rules
Spec + quality review Workstreams          MCP domain intelligence
Verification          Recovery
     │                    │                    │
     └────────────────────┼────────────────────┘
                          ▼
                     MAIN AGENT
```

**Câu chốt của toàn bộ thiết kế:**

> Đừng xây một "GSD mới". Hãy xây một **"context-aware Superpowers"**: kỷ luật quy trình kiểu Superpowers, state/dependency engine nhẹ kiểu GSD, và domain intelligence BPM cắm vào qua MCP.

**Nguyên tắc thiết kế số 1 (nhắc lại):**

> Agent không được nhận toàn bộ project context. Agent chỉ nhận context cần để thực hiện đúng task hiện tại.

**Nguyên tắc triển khai số 1:**

> Đúng context + đúng quy trình + đúng domain knowledge + human approval + evidence — **không phải** nhiều agent + nhiều prompt + nhiều MCP + nhiều automation.
