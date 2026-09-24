# runtime/ — Runtime core (Phase 1)

Đã implement: **config loader + StateStore + EvidenceStore + EventBus + Plan compiler (plan.md → plan.json) + DependencyGraph + wave planning + conflict detection + MCP client (stdio) + ContextCompiler + AgentRunner (prompt contract + harness) + ModelRouter + Skill router (progressive disclosure) + RecoveryEngine + PhaseOrchestrator (lệnh phase) + chạy song song trong git worktree + khoá workstream + CLI `eng`**.
Chưa implement: WaveExecutor parallel thật, RecoveryEngine, GateEngine runtime (đã có `assertHumanGates` + `evaluateEvidenceGate` dùng trong `transition`).

```bash
npm run build -w @bpm/engineering-os-runtime   # hoặc: npm run build (cả 3 package)
node runtime/dist/cli.js config                  # hoặc: npm run eng -- config
```

## CLI

```text
eng new <TASK_ID> [--title TEXT] [--risk LOW|MEDIUM|HIGH|CRITICAL] [--mode safe|normal|autonomous]
                  [--domain a,b] [--capability a,b] [--status STATUS]
eng list [--json]
eng status <TASK_ID> [--json]          # 1 dòng + việc tiếp theo
eng resume <TASK_ID> [--json]          # báo cáo đầy đủ: artifact thiếu, gate mở, chuyển cuối, events
eng next <TASK_ID>                     # các status có thể chuyển tới
eng advance <TASK_ID> --to <STATUS> [--expect STATUS] [--reason TEXT] [--allow-bypass]
eng patch <TASK_ID> --set key=value [--set ...]
eng block <TASK_ID> --reason TEXT      # bắt buộc có lý do (INV-06)
eng unblock <TASK_ID>
eng gates <TASK_ID> --to <STATUS>      # human gate nào cần approve
eng evidence <TASK_ID> [--type TYPE] [--json]
eng record <TASK_ID> --type TYPE --status PASS|FAIL|BLOCKED|INFO [--command C --cwd D --exit-code N
           --git-sha S --artifact A --gate-id G --approver U --approved-at ISO
           --unexpected a,b --deleted a,b --sub-task TASK-NN --summary TEXT]
eng events <TASK_ID> [--limit N] [--json]
eng metrics <TASK_ID> [--json] [--write]  # metrics thật từ workstream (spec mục 21)
eng doctor [--project P] [--json] [--ping]  # preflight: env/config/gate/model/harness/MCP/repo
eng config [--json]                    # kiểm tra 5 file config hợp lệ

Plan → DAG → waves:
eng plan import <TASK_ID> --file <plan.md> [--architecture-ref architecture.md]
eng plan show <TASK_ID> [--json]
eng graph <TASK_ID> [--json]           # DAG + waves + conflict check (INV-11)
eng wave <TASK_ID> [--start N] [--json]
eng subtask <TASK_ID> <TASK-NN> --status PENDING|IN_PROGRESS|DONE|FAILED|REWORK_REQUIRED

Context (spec mục 7.3):
eng context <TASK_ID> <TASK-NN> [--project P] [--max-tokens N] [--no-mcp] [--json]
eng context <TASK_ID> --all [--project P] [--no-mcp]     # compile mọi task chưa DONE

Agent (spec mục 10):
eng agents                                              # agent contract + harness có sẵn
eng agent <ROLE> <TASK_ID> [<TASK-NN>] [--harness NAME] [--dry-run] [--project P] [--json]
eng wave <TASK_ID> --start N --run [--harness NAME]      # chạy developer agent cho từng task trong wave

Recovery (spec mục 15):
eng recover <TASK_ID> [<TASK-NN>] [--apply] [--max-attempts N] [--by WHO] [--json]

Phase (spec mục 9.1 — gói sẵn chuỗi bước của một pha):
eng translate|analyze|design|plan|implement|review|audit|verify <TASK_ID>
    [--harness NAME] [--project P] [--dry-run] [--no-recover] [--json]
eng continue <TASK_ID> [--harness NAME] [--project P] [--max-steps N] [--dry-run] [--no-recover] [--json]
    # chạy các pha kế tiếp tới khi: DONE | human gate | evidence gate | phải merge | lỗi
```

Chuỗi đầy đủ cho một ticket:

```bash
eng new TASK-49043 --title "..." --risk HIGH
eng translate TASK-49043 --harness <name>     # researcher → requirements.md
eng analyze   TASK-49043 --harness <name>     # impact → impact.md
eng design    TASK-49043 --harness <name>     # architect → architecture.md, DỪNG ở human gate
eng record TASK-49043 --type HUMAN_APPROVAL --status PASS --gate-id architecture --approver "<tên>" --approved-at <ISO>
eng plan      TASK-49043 --harness <name>     # plan.md → plan.json → waves
eng implement TASK-49043 --harness <name> --project <project>   # context + wave + evidence cơ học
eng review    TASK-49043 --harness <name>     # reviewer 2 tầng theo task
eng audit     TASK-49043 --harness <name>     # auditor → audit.md
eng verify    TASK-49043 --project <project>  # build + test + scope tươi → DONE
```

`--dry-run` in ra danh sách bước mà không đổi gì (kiểm trước khi chạy thật).

### `eng continue` — chạy liên tiếp (đường mặc định cho việc hằng ngày)

Không cần nhớ chuỗi 8 phase: `eng continue` đọc `task.json.status`, suy ra phase kế tiếp và chạy
liên tiếp cho tới khi gặp việc **phải do người quyết**.

```bash
eng continue TASK-49043 --harness <harness> --project individual-service
# → translate → analyze → design, rồi DỪNG ở human gate (exit 1) và in đúng lệnh cần gõ tiếp
eng record TASK-49043 --type HUMAN_APPROVAL --status PASS --gate-id architecture --approver "SA" --approved-at <ISO>
eng continue TASK-49043 --harness <harness> --project individual-service
# → plan → implement → review → audit → verify → DONE (exit 0)
```

| Điểm dừng (`stoppedBecause`) | Nghĩa |
|---|---|
| `DONE` | ticket xong — **exit 0**; mọi điểm dừng khác là exit 1 (chưa xong) |
| `HUMAN_GATE` | cần approve (INV-05); lệnh `eng record ... HUMAN_APPROVAL` được in sẵn |
| `EVIDENCE_OR_ERROR` | phase bị chặn bởi evidence gate, hoặc worker lỗi (recovery đã chạy) |
| `NO_PROGRESS` | phase không đổi trạng thái — thường là phải `eng merge` (khi chạy `--parallel`) |
| `NO_PHASE` | không còn phase nào chạy được từ status hiện tại |
| `MAX_STEPS` | chạm trần `--max-steps` (mặc định 8) — chạy lại để tiếp |

`--dry-run` chiếu các phase sẽ chạy (đọc gate từ config, không đổi state). `--json` trả
`{ from, to, ok, blocked, stoppedBecause, steps[] }` để CI đọc. Không nới gate nào: mọi điểm dừng
đều kèm việc phải làm tiếp.

Ví dụ một vòng đời thật:

```bash
eng new TASK-49043 --title "Thêm Purpose of Loan" --risk HIGH
eng advance TASK-49043 --to TRANSLATING
eng advance TASK-49043 --to REQUIREMENT_ANALYSIS
eng advance TASK-49043 --to IMPACT_ANALYSIS
eng advance TASK-49043 --to DESIGNING
eng advance TASK-49043 --to WAITING_DESIGN_APPROVAL
eng advance TASK-49043 --to PLANNING      # ✖ HUMAN_APPROVAL_REQUIRED
eng record TASK-49043 --type HUMAN_APPROVAL --status PASS \
  --gate-id architecture --approver "SA ..." --approved-at 2026-09-24T09:00:00Z
eng advance TASK-49043 --to PLANNING      # ✓
```

## Multi-repo (spec mục 9.5)

Một ticket sửa **nhiều repo**, kể cả khi các repo nằm ở thư mục cha khác nhau. Không cần symlink
hay gộp repo — `repoRoot` lấy từ env của từng project trong `config/projects.yaml`.

```bash
eng new PAY-101 --title "Đổi contract thanh toán" --risk HIGH \
  --project payment-api --project payment-client   # --project lặp được; phần tử đầu là repo chính
# plan.md: mỗi task khai "### Repo: payment-api" (hoặc payment-client)
eng plan import PAY-101 --file plan.md
eng context PAY-101 --all            # mỗi task lấy context từ REPO CỦA NÓ
eng implement PAY-101                 # wave/parallel: worktree tạo trong repo của từng task
eng verify PAY-101                    # build + test + scope cho MỌI repo của ticket
eng record PAY-101 --type TEST --status PASS --project payment-api ...   # evidence phải gắn repo
eng metrics PAY-101 --write           # có breakdown evidence theo repo
```

Quy tắc:

| Chủ đề | Quy tắc |
|---|---|
| Khai repo | `task.json.projects[]` (ticket) và `plan.json.tasks[].repo` (`### Repo`); tên phải có trong `config/projects.yaml` — sai tên ⇒ lỗi rõ ràng (INV-06) |
| Đường dẫn file | Tương đối so với repoRoot của repo task đó |
| Conflict check (INV-11) | So theo **(repo, file)** và **(repo, symbol)** — cùng file ở hai repo khác nhau KHÔNG chặn parallel |
| Evidence gate | `BUILD`/`TEST`/`SCOPE_VALIDATION` phải có cho **từng** repo (`evidence.project`); `SPEC_REVIEW`/`QUALITY_REVIEW`/`AUDIT`/`HUMAN_APPROVAL` là cấp ticket |
| `--project` | Thu hẹp phạm vi về 1 repo (implement/verify). Repo của **task** luôn thắng `--project` khi compile context |
| Merge | `eng merge` merge theo repo ghi trong `tasks/<TASK-NN>-changes.json`; thứ tự merge do người quyết |
| Không khai gì | Hành vi cũ: repo lấy từ `--project` hoặc `defaultProject` |

Thứ tự phụ thuộc xuyên repo dùng chính `### Dependencies` trong plan (task ở repo B phụ thuộc task ở repo A ⇒ B vào wave sau).

## Library API (spec mục 17)

```ts
import { StateStore, EvidenceStore, EventBus, ConfigError } from "@bpm/engineering-os-runtime";

const store = new StateStore();            // mặc định: .engineering/workstreams/<TASK_ID>/
store.create({ taskId: "TASK-49043", risk: "HIGH" });
store.transition("TASK-49043", "TRANSLATING", { reason: "..." });
store.evidence.record("TASK-49043", { type: "TEST", status: "PASS", command: "mvn test", cwd: "/repo",
  exitCode: 0, gitSha: "abc123", artifact: "evidence/logs/x.log", producer: "mcp:mcp-engineering" });
const report = store.resume("TASK-49043");  // artifact thiếu, gate mở, việc tiếp theo
store.bus.emit({ taskId: "TASK-49043", type: "TaskCompleted", payload: {} });
```

| Interface | File | Ghi chú |
|---|---|---|
| `StateStore` | `src/state/store.ts` | `create`, `get`, `patch`, `transition`, `block`/`unblock`, `resume`, `gatesFor` |
| `EvidenceStore` | `src/evidence/store.ts` | `record`, `list`, `get`, `summary`, `writeLog` |
| `EventBus` | `src/events/bus.ts` | `emit`, `read` → `events.jsonl` |
| State machine | `src/state/machine.ts` | bảng transition (spec 8.1) + `assertTransition` |
| Evidence rules | `src/evidence/rules.ts` | RULES-001: điều kiện evidence theo status |
| Human gates | `src/state/gates.ts` | đọc `config/gates.yaml`: required, bypass theo mode/risk |
| Schema validation | `src/schemas/index.ts` | ajv (JSON Schema 2020-12) cho 6 schema |
| Config loader | `src/config/index.ts` | 5 file YAML; `configSummary()`, `modelTierFor()` |
| Plan parser | `src/plan/parser.ts` | `plan.md` → tasks; lỗi kèm `taskId` + số dòng; bỏ qua code fence |
| Plan store | `src/plan/store.ts` | `plan.json` (validate schema), `setTaskStatus`, `planProgress` |
| Dependency graph | `src/graph/dag.ts` | `buildDag` → waves; phát hiện cycle (kèm đường đi), dependency lạ, tự phụ thuộc |
| Conflict check | `src/graph/conflicts.ts` | `checkWave`: FILE_OVERLAP, SYMBOL_OVERLAP (BLOCK); MIGRATION_ORDER, PATTERN_FORK (WARN) |
| Wave planner | `src/executor/waves.ts` | `buildExecutionPlan`, `waveProgress`, `nextWave`, `attachWaves` |
| MCP client | `src/mcp/client.ts` | `McpStdioClient` (JSON-RPC qua stdio), `serverSpecFromConfig()` |
| Context providers | `src/context/providers.ts` | `McpContextProvider` (gọi 2 MCP server) · `LocalContextProvider` (offline, chỉ artifact) |
| ContextCompiler | `src/context/compiler.ts` | `compileTaskContext()` → `context/<TASK-NN>.json` + `.md` (spec 7.3) |
| ModelRouter | `src/router/model.ts` | `resolveModelDecision()` (role/risk/complexity → tier), `inferComplexity()` |
| Agent registry | `src/agents/registry.ts` | 6 agent + input/output/DO NOT contract (spec 10) |
| Prompt renderer | `src/agents/prompt.ts` | `renderAgentPrompt()` — prompt contract 9 phần |
| AgentRunner | `src/agents/runner.ts` | `buildPrompt()`, `run()` — spawn harness, ghi log, kiểm tra artifact thật |
| Skill loader | `src/skills/loader.ts` | `loadSkills()` + kiểm tra cấu trúc (description chỉ WHEN, 4 section, độ dài) |
| Skill router | `src/skills/router.ts` | `routeSkills()` — chọn skill theo role/phase/trigger, `required` trước, cắt theo budget |
| Recovery classify | `src/recovery/classify.ts` | `classifyFailure()` — 8 loại lỗi bằng rule tất định; `GUIDANCE` (tự phục hồi được hay cần người) |
| RecoveryEngine | `src/recovery/engine.ts` | `diagnose()`, `recover()` — recovery context tối thiểu + loop guard + `recoveryChain()` |
| PhaseOrchestrator | `src/orchestrator/phases.ts` | `run(taskId, phase)` — gói chuỗi bước của 8 phase; `PHASES` (precondition + steps cho `--dry-run`) |
| Evidence cơ học | `src/orchestrator/evidence.ts` | `collectMechanicalEvidence()` — runtime tự chạy build/test/scope qua MCP và ghi evidence |
| Khoá workstream | `src/state/lock.ts` | `acquireLock/releaseLock/withLock` — atomic, reentrant trong process, reentrant theo **cây tiến trình** qua token |
| Git worktree | `src/git/worktree.ts` | `WorktreeManager` — create/commit/diff/remove/merge; từ chối merge vào branch bảo vệ, tự abort khi conflict |

## Bất biến được thực thi (không chỉ ghi trong doc)

| Invariant | Cách thực thi | Mã lỗi khi vi phạm |
|---|---|---|
| **INV-02** state ngoài context | `task.json` ghi atomic (tmp + rename); mọi thay đổi vào `history[]` | `JSON_CORRUPT`, `STATE_NOT_FOUND` |
| **INV-03** evidence-gated transition | `REVIEWING` cần `TEST`+`SCOPE_VALIDATION`, `AUDITING` cần `SPEC_REVIEW`+`QUALITY_REVIEW`, `VERIFYING` cần `AUDIT`, `DONE` cần `BUILD`+`TEST`+`SCOPE_VALIDATION`+`AUDIT` | `EVIDENCE_REQUIRED` (kèm `details.missing`) |
| **INV-05** human gate | `WAITING_DESIGN_APPROVAL → PLANNING` cần evidence `HUMAN_APPROVAL` gateId `architecture` | `HUMAN_APPROVAL_REQUIRED` |
| **INV-12** provenance | `TEST`/`BUILD` cần `command,cwd,exitCode,gitSha,artifact`; `HUMAN_APPROVAL` cần `gateId,approver,approvedAt`; `SCOPE_VALIDATION` cần `unexpectedFiles,deletedFiles` | `EVIDENCE_INCOMPLETE` |
| **INV-06** không đoán | `blocked=true` bắt buộc `blockReason`; MCP down ⇒ agent được hướng dẫn giữ `BLOCKED` | `BLOCK_REASON_REQUIRED` |
| Schema hợp đồng | mọi lần ghi state/evidence/event đều validate trước khi ghi | `SCHEMA_INVALID` |
| Thứ tự trạng thái | bảng transition; `DONE` là terminal | `ILLEGAL_TRANSITION` |
| **INV-11** parallel chỉ khi an toàn | wave có FILE_OVERLAP/SYMBOL_OVERLAP ⇒ `conflictCheck=FAIL` ⇒ `mode=SEQUENTIAL` | `WAVE_BLOCKED`, `PLAN_NOT_EXECUTABLE` |
| Song song phải CÔ LẬP | `--parallel` cần `worktrees.enabled`; mỗi task một git worktree + branch riêng; cây chính không bị đụng; merge là lệnh riêng | `WORKTREES_DISABLED`, `PROTECTED_BRANCH` |
| Ghi đồng thời | mọi đường ghi (state/plan/evidence/event) đi qua lock workstream; lock cũ (pid chết) được thu hồi | `WORKSTREAM_LOCKED` |
| **INV-01** context tối thiểu | ContextCompiler chỉ lấy `files[]` + symbol quanh task, cắt snippet theo `limits.context.maxTokens`, không nhúng task khác | `SCHEMA_INVALID` |
| **INV-06** không đoán | MCP lỗi/không tìm thấy symbol ⇒ ghi vào `unknowns` + cảnh báo, không tự bịa; provider offline ghi rõ lý do | `MCP_SERVER_UNREACHABLE`, `MCP_TIMEOUT` |
| **INV-07** không hard-code provider | Runtime không biết Claude/Codex/… là gì: harness lấy từ `config/models.yaml`; chưa cấu hình ⇒ từ chối chạy | `HARNESS_NOT_CONFIGURED`, `HARNESS_UNKNOWN` |
| Không tin lời agent | Sau khi harness chạy, runtime kiểm tra artifact bắt buộc có THẬT trên đĩa; thiếu ⇒ `ok=false` + cảnh báo; task vẫn `IN_PROGRESS` | exit code 1 |
| Phân loại lỗi tất định | Recovery không dùng LLM để đoán loại lỗi; evidence máy ghi mạnh hơn heuristic log | `UNKNOWN` + confidence `low` khi không đủ dấu hiệu |
| Không restart mù quáng | Quá `maxAttempts` lần vào DEBUGGING ⇒ dừng tự sửa, escalate cho người | `needsHuman = true` |
| Lỗi ngoài nhánh implementation | Không có đường sang DEBUGGING (ví dụ từ TRANSLATING) ⇒ BLOCK kèm lý do, giữ status để chạy lại phase | `blocked = true` |
| Evidence không do agent khai | `eng implement`/`eng verify` tự chạy build/test/`validate_scope` qua MCP rồi ghi evidence; agent chỉ cung cấp report và judgement (SPEC/QUALITY/AUDIT) | `EVIDENCE_REQUIRED` khi thiếu |
| Plan hợp đồng | `plan.md` phải có Objective + Acceptance Criteria + Verification mỗi task; `plan.json` validate schema; cycle/dependency lạ chặn thực thi | `PLAN_PARSE_ERROR`, `SCHEMA_INVALID` |
| Không sửa tắt | `patch` từ chối `status`/`phase`/`history`/`evidence` | `PATCH_FORBIDDEN_FIELD` |

Risk `CRITICAL` cần thêm `HUMAN_APPROVAL` gateId `finalVerification` trước khi vào `DONE` (theo `config/risk.yaml`).

## Đổi hành vi bằng config, không sửa code

| Muốn đổi | Sửa ở đâu |
|---|---|
| Thêm/bớt human gate, đổi transition được gate | `config/gates.yaml` → `gates` |
| Cho phép bỏ qua gate theo mode/risk | `config/gates.yaml` → `bypassInModes`, `bypassIfRiskAtMost` (vẫn cần cờ `--allow-bypass` nếu `bypassRequiresConfigFlag`) |
| Model tier theo vai trò / sàn theo risk | `config/models.yaml` (`modelTierFor()`) |
| Ngân sách context (token, số symbol, số rule) | `config/mcp.yaml` → `limits.context` |
| Harness chạy worker agent (lệnh, cwd, timeout) | `config/models.yaml` → `harness` (placeholders `{prompt}` `{repoRoot}` `{osRoot}` `{taskId}` `{subTaskId}`) |
| Số skill và token skill nhúng vào prompt | `config/mcp.yaml` → `limits.context.maxSkills`, `maxSkillTokens` |
| Điểm rủi ro và hệ quả | `config/risk.yaml` |
| Bật/tắt + chọn harness mặc định | `harness.default.enabled`; chọn tạm bằng `--harness <name>` |
| Thư mục workstream | `config/projects.yaml` → `workspace.workstreamRoot` |

Điều kiện evidence theo status nằm trong `src/evidence/rules.ts` (đổi ở đây khi nghiệp vụ đổi — có test tương ứng).

## Workstream sinh ra

```text
.engineering/workstreams/<TASK_ID>/
├── task.json          # state (nguồn sự thật, INV-02)
├── evidence/
│   ├── EV-0001.json   # evidence + provenance
│   └── logs/          # log thô của lần chạy
├── events.jsonl       # lifecycle events (spec mục 14)
├── tasks/ context/ reviews/    # artifact do các bước sau ghi vào
```

`task.json.evidence[]` được runtime đồng bộ tự động khi ghi evidence (spec 8.2); file trong `evidence/` vẫn là nguồn sự thật.

## Test

`tests/runtime-state.test.mjs` (20 test) — config/schema, state machine, evidence gate, human gate, bypass, block/unblock, và 2 acceptance criteria của spec mục 19:

- **A. State sống qua process restart** — tạo/advance bằng process này, đọc lại bằng process khác (spawn CLI), kiểm tra `task.json` vẫn hợp lệ schema.
- **F. Evidence persist** — evidence có đủ provenance, đúng schema, đọc lại được, không để lại file `.tmp`.

`tests/plan-graph.test.mjs` (23 test) — parser (kể cả code fence và lỗi thiếu field), DAG (wave, cycle, self/unknown dependency), conflict detection (đủ 4 loại), execution plan (SEQUENTIAL/PARALLEL, `blocked` khi có cycle), và luồng CLI `plan import → graph → wave → subtask` (kể cả các nhánh bị chặn).

`tests/context-compiler.test.mjs` (13 test) — compiler với provider giả (gộp 4 nguồn constraints, business rule của plan + MCP, cắt theo budget, unknown thay vì bịa), CLI offline `--no-mcp`, và **CLI với MCP thật** trên repo fixture (snippet symbol + provenance MCP + constraint từ repo; nhánh lấy rule từ `mcp-domain-core` chỉ chạy khi server đó được bật, cộng 1 test cho trạng thái tạm dừng).

`tests/agent-runner.test.mjs` (20 test) — prompt contract 9 phần (thứ tự, placeholder, không lặp DO NOT, **không nhúng nội dung context — INV-01**), ModelRouter (role/risk/complexity/caps), dry run, `CONTEXT_REQUIRED`, `HARNESS_NOT_CONFIGURED` (INV-07), harness thật ghi artifact + harness fail, và `wave --run`.

`tests/skills-router.test.mjs` (19 test) — catalog hợp lệ (front-matter, section, description chỉ WHEN), phát hiện skill lỗi bằng fixture, routing theo role/phase/trigger, skill của role khác **không lọt vào prompt**, cắt theo budget có cảnh báo skill bắt buộc, prompt có `SKILLS` + `OUTPUT FORMAT` đúng thứ tự, và CLI `eng skills list|show|route`.

`tests/recovery.test.mjs` (21 test) — 8 loại lỗi phân đúng từ log/evidence/blockReason (kể cả ca dễ sai: `AssertionError` không phải compile error; thiếu file context không mặc nhiên là MISSING_CONTEXT), evidence mạnh hơn log, `recoveryChain` chỉ sinh transition hợp lệ, loop guard, block path, và **tính tối thiểu**: log 3000 dòng ⇒ recovery md < 6KB, không nhúng lại nội dung context.

`tests/phases.test.mjs` (16 test) — metadata + dry run (không ghi history), `PHASE_PRECONDITION`, `eng plan import|show` không bị phase chiếm, **chuỗi đầy đủ NEW → DONE qua 8 lệnh**, evidence cuối đủ cho gate DONE, worker fail ⇒ block kèm lý do, và implement thiếu evidence thì báo rõ chứ không nới gate.

`tests/parallel-worktree.test.mjs` (13 test) — lock (chặn khi tiến trình khác giữ, thu hồi lock cũ, reentrant), từ chối `--parallel` khi worktree tắt, và **chạy song song thật**: 2 worktree + 2 branch, cây chính sạch, hai agent **chồng lấn thời gian**, `eng merge` từ chối branch bảo vệ, merge + xoá worktree + file có trên cây chính, chạy lại implement để thu evidence → REVIEWING.

`tests/paths-contract.test.mjs` (9 test) — guard đa nền tảng: mọi đường dẫn ghi vào artifact workstream phải dùng `/`, quét cả artifact JSON sinh ra lẫn chính các file test (không cho dùng `path.join` để tạo giá trị tương đối). Đây là lớp lỗi đã lọt CI một lần trên Windows.

`tests/symbol-index.test.mjs` (9 test, qua MCP stdio) — index dựng đúng thống kê repo fixture, dùng lại cache khi còn TTL và dựng lại khi `ENG_INDEX_TTL_MS=0`, `find_symbol` trả file/dòng/kind, và **xếp hạng usage**: `exact` (file khai báo) → `likely` (cùng package / có import / có call site) → `weak` (chỉ trùng tên), `get_change_context` tách strong/weak caller, `read_symbol` không quét cả repo.

`tests/metrics.test.mjs` (17 test) — `computeMetrics` chỉ tính từ dữ liệu đã ghi: thời gian theo status (cộng từ history, kể cả lúc bị block), context token **ước lượng** + số lần bị cắt, evidence gate tái dựng **tại thời điểm transition** (phát hiện transition vào status gated mà lúc đó chưa có evidence), human gate wait + approver, block episode ghép cặp block/unblock, và khai báo thẳng metric **không đo được** (baseline, escape rate, cost/tier) thay vì bịa số; CLI `eng metrics [--json] [--write]` (test riêng: workstream rỗng không sinh NaN, `--write` ghi `metrics.md`).

`tests/doctor.test.mjs` (14 test) — preflight: gate gắn vào transition không tồn tại trong state machine (lỗi đã từng xảy ra), mode tham chiếu gate lạ, risk thiếu effects, riskFloor/agents thiếu mức, harness bật nhưng binary không có trên PATH, không harness nào bật (WARN chứ không FAIL), repo đích (thiếu env ⇒ FAIL khi chỉ định đúng project / WARN khi quét tất cả; không phải git repo ⇒ FAIL; branch bảo vệ ⇒ WARN; repoRoot là thư mục con của repo lớn hơn ⇒ ghi chú), `--json` + exit 1 khi có FAIL, và `--ping` khởi động thật 2 MCP server (đếm tool).

Tổng toàn repo: **220 test** (`npm test`).

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `ENGINEERING_OS_ROOT` | Gốc repo (mặc định: dò ngược lên từ `dist/`) |
| `MCP_CONFIG` / `PROJECTS_CONFIG` / `MODELS_CONFIG` / `GATES_CONFIG` / `RISK_CONFIG` | Override từng file config (hữu ích khi test hoặc chạy nhiều môi trường) |
| `ENG_PROMPT_FILE`, `ENG_TASK_ID`, `ENG_SUBTASK_ID`, `ENG_CONTEXT_FILE`, `ENG_ROLE`, `ENG_MODEL_TIER`, `ENG_WORKSTREAM`, `ENG_OS_ROOT` | Runtime truyền cho worker agent (harness có thể dùng) |
