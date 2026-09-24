# GETTING-STARTED — bắt đầu dùng BPM Engineering OS

Điểm bắt đầu cho người mới: **cài gì, gõ gì, kỳ vọng thấy gì, hỏng thì sửa ở đâu.**

> Tài liệu này **không** thay thế các file khác. Khi cần chi tiết, nguồn sự thật là:
>
> | Câu hỏi | Đọc |
> |---|---|
> | Vì sao thiết kế như vậy | `SPEC-bpm-engineering-os.md` |
> | Chạy 1 ticket thật trên máy nội bộ (ngân hàng) | `RUNBOOK.md` |
> | Tham chiếu CLI + library API đầy đủ | `runtime/README.md` |
> | Bất biến bắt buộc (INV-01…INV-12) | `CLAUDE.md` |
> | Ranh giới kiến trúc + ADR | `ARCHITECTURE.md` |
>
> Mọi lệnh trong file này đã được chạy thật trên repo này (macOS, Node 22.23.2) trước khi viết.

---

## 0. Mental model — 3 lớp, 1 nguyên tắc

| Lớp | Ở đâu | Vai trò |
|---|---|---|
| Cấu hình | `config/*.yaml` | model tier · gate · risk · MCP · project đích + **allowlist command** |
| Runtime + CLI `eng` | `runtime/src` → `runtime/dist/cli.js` | state machine, evidence gate, plan→wave, context compiler, recovery |
| MCP server (stdio) | `mcp/mcp-engineering` · `mcp/mcp-domain-core` | 31 + 17 tool: repo/code/git/verification và domain policy |

**Nguyên tắc số 1 (INV-01/INV-02):** state sống **ngoài** context LLM, dạng file, trong `.engineering/workstreams/<TICKET>/`. Worker agent **không** nhận repo, không nhận `.engineering/`, không nhận lịch sử hội thoại — chỉ nhận `context/TASK-NN.md`.

Mỗi lệnh phase (`eng translate|analyze|design|plan|implement|review|audit|verify`) là một gói bước cố định:

```text
kiểm precondition → chạy agent qua harness → KIỂM ARTIFACT THẬT trên đĩa
→ thu evidence cơ học (runtime tự chạy, không tin lời agent) → advance qua gate
```

Runtime **không tin lời agent** (INV-12): agent nói "xong" mà file artifact không có ⇒ coi như fail và chạy recovery.

---

## 1. Cài đặt một lần

```bash
cd /Users/macprom1/vuongnd/code/bpm-engineering-os
node -v                                        # cần >= 22
npm ci --no-audit --no-fund --cache ./.npm-cache
npm run build
npm test
```

Kỳ vọng: `npm run build` exit 0; `npm test` → `tests 220 / pass 220 / fail 0`.

### Bẫy thật: `npm ci` mặc định có thể fail vì cache `~/.npm`

```text
npm error Your cache folder contains root-owned files...
npm error path /Users/<user>/.npm/_cacache/tmp/705dfbf7
```

Đây **không phải** lỗi của repo — `--cache ./.npm-cache` (như lệnh trên) là cách xử lý; dùng cách này luôn cũng được. Triệt để: `sudo chown -R 501:20 ~/.npm`.

> `node_modules/`, `runtime/dist/`, `mcp/*/dist/` bị gitignore — clone sạch **phải** build trước khi dùng. `mcp-engineering` resolve type của runtime qua `runtime/dist/index.d.ts`, nên `npm run typecheck` cũng cần build runtime trước.

---

## 2. Kiểm tra môi trường trước khi tin bất cứ thứ gì

```bash
E="node runtime/dist/cli.js"        # hoặc: npm run eng --
$E config                           # validate 5 file YAML
$E doctor                           # preflight: env/config/gate/model/harness/MCP/repo
$E doctor --ping                    # khởi động THẬT 2 MCP server rồi đếm tool
```

Đọc kết quả:

| Mức | Nghĩa | Phải làm gì |
|---|---|---|
| `FAIL` | chắc chắn hỏng khi chạy thật | sửa hết trước khi đi tiếp; mỗi dòng có `→` chỉ cách sửa |
| `WARN` | chạy được nhưng dễ sinh lỗi/mất evidence | đọc và quyết định |
| `ok` | đã kiểm bằng dữ liệu thật | — |

Output thật trên repo này:

```text
Kết luận: 11 ok · 3 warn · 0 fail          # eng doctor
Kết luận: 12 ok · 3 warn · 0 fail          # eng doctor --ping
✔ mcp-ping — MCP server khởi động thật + list tool
    mcp-engineering: 31 tool / 6 group · mcp-domain-core: 17 tool / 5 group
```

3 WARN mặc định khi chưa cấu hình (không phải lỗi code):

- `individual-service` / `policy-new`: chưa set `DOMAIN_REPO_ROOT` / `POLICY_NEW_REPO_ROOT`.
- `sample-fixture`: repo fixture đang ở branch bảo vệ `main` → thao tác ghi sẽ bị chặn.

`doctor` không gọi LLM và không chạy harness (trừ `--ping` với MCP) ⇒ chạy bao nhiêu lần cũng rẻ.

---

## 3. Bản đồ lệnh

| Việc | Lệnh |
|---|---|
| Tạo/liệt kê workstream | `new` · `list` · `status` · `resume` · `next` |
| Đổi trạng thái | `advance --to <STATUS>` · `patch --set k=v` · `block --reason` · `unblock` |
| Gate | `gates --to <STATUS>` |
| Evidence | `evidence` · `record --type ... --status ...` · `events` |
| Plan → DAG → wave | `plan import --file` · `plan show` · `graph` · `wave` · `subtask` |
| Context (INV-01) | `context <T> --all --project P` · `context <T> TASK-01` |
| Agent thô | `agents` · `agent <ROLE> <T> [TASK-NN] --harness N` · `skills` · `skills route <ROLE>` |
| **Chạy liên tiếp (khuyến nghị)** | `continue <T> [--max-steps N] [--dry-run]` — tự suy ra pha kế tiếp, dừng khi phải chờ người |
| 8 phase (chạy riêng từng pha) | `translate` · `analyze` · `design` · `plan` · `implement` · `review` · `audit` · `verify` |
| Sự cố | `resume` · `recover [--apply]` · `lock [--release]` · `doctor --ping` |
| Chạy song song | `implement --parallel --concurrency N` → `merge` (cần `worktrees.enabled: true`) |
| Đo baseline | `metrics [--json] [--write]` |

**Bẫy cú pháp:** `eng plan <TASK_ID>` = **chạy pha lập kế hoạch**; `eng plan import|show <TASK_ID>` = lệnh dữ liệu.

**Agent hiện có 6 role** (`$E agents`): `researcher` → `requirements.md`, `impact` → `impact.md`, `architect` → `architecture.md` + `plan.md`, `developer` → `tasks/TASK-NN-report.md`, `reviewer` → `reviews/TASK-NN-spec.md`, `auditor` → `audit.md`.

---

## 4. Vòng đời một ticket

State machine (spec 8.1 — `BLOCKED` là **cờ**, không phải status):

```text
NEW → TRANSLATING → REQUIREMENT_ANALYSIS → IMPACT_ANALYSIS → DESIGNING
    → WAITING_DESIGN_APPROVAL → PLANNING → READY_TO_IMPLEMENT → IMPLEMENTING
    → REVIEWING → AUDITING → VERIFYING → DONE

nhánh lỗi: IMPLEMENTING → FAILED → DEBUGGING → IMPLEMENTING
           REVIEWING|AUDITING|VERIFYING → REWORK_REQUIRED → IMPLEMENTING
```

```bash
E="node runtime/dist/cli.js"
T="TASK-49043"
P="individual-service"          # project trong config/projects.yaml
H="<harness>"                   # harness LLM đã enable trong config/models.yaml

$E new $T --title "Thêm Purpose of Loan" --risk HIGH --domain domain
$E resume $T                                     # artifact thiếu · gate mở · việc tiếp theo

$E translate $T --harness $H --project $P        # researcher → requirements.md
$E analyze   $T --harness $H --project $P        # impact     → impact.md
$E design    $T --harness $H --project $P        # architect  → architecture.md, DỪNG ở gate
#    ... human gate kiến trúc (mục 5.1) ...
$E plan      $T --harness $H --project $P        # plan.md → plan.json + wave
$E implement $T --harness $H --project $P        # context + wave + evidence cơ học
$E review    $T --harness $H --project $P        # reviewer 2 tầng theo từng task
$E audit     $T --harness $H --project $P        # auditor    → audit.md
$E verify    $T --project $P                     # build+test+scope tươi → DONE
$E metrics   $T --write                          # → .engineering/workstreams/$T/metrics.md
```

### Cách ngắn nhất: `eng continue` (chỉ 2 lệnh cho cả ticket)

Bạn **không cần nhớ** chuỗi trên. `eng continue` đọc `task.json.status`, suy ra pha kế tiếp và chạy
liên tiếp cho tới khi gặp việc phải do người quyết:

```bash
$E continue $T --harness $H --project $P
```

```text
⏸ continue DEMO-9 — NEW → WAITING_DESIGN_APPROVAL
  ✔ translate  NEW → REQUIREMENT_ANALYSIS
  ✔ analyze    REQUIREMENT_ANALYSIS → DESIGNING
  ✔ design     DESIGNING → WAITING_DESIGN_APPROVAL
  dừng vì : HUMAN_GATE — cần người approve: architecture (WAITING_DESIGN_APPROVAL → PLANNING)
  việc tiếp:
    1. eng record DEMO-9 --type HUMAN_APPROVAL --status PASS --gate-id architecture --approver "<tên>" --approved-at <ISO>
    2. eng continue DEMO-9
```

Approve xong, chạy lại đúng lệnh đó — nó chạy tiếp tới hết:

```text
✓ continue DEMO-9 — WAITING_DESIGN_APPROVAL → DONE
  ✔ plan       WAITING_DESIGN_APPROVAL → READY_TO_IMPLEMENT
  ✔ implement  READY_TO_IMPLEMENT → REVIEWING
  ✔ review     REVIEWING → AUDITING
  ✔ audit      AUDITING → VERIFYING
  ✔ verify     VERIFYING → DONE
  dừng vì : DONE — ticket DONE
```

Quy tắc cần biết: **exit 0 chỉ khi `DONE`**, mọi điểm dừng khác là exit 1 kèm việc phải làm
(`HUMAN_GATE` · `EVIDENCE_OR_ERROR` · `NO_PROGRESS` (thường là phải `eng merge`) · `NO_PHASE` · `MAX_STEPS`).
`--max-steps N` giới hạn số pha một lần chạy (mặc định 8); `--dry-run` chiếu trước mà không đổi state;
`--json` để CI đọc. Lệnh này **không nới gate nào** — dừng ở đúng chỗ cần con người.

**Chạy `--dry-run` cho lần đầu** — in các bước sẽ làm, **không** gọi LLM, không đổi state:

```text
$ eng translate DEMO-001 --dry-run --project sample-fixture
✓ translate DEMO-001 — NEW → NEW (dry run)
  ○ advance → TRANSLATING — (dry run)
  ○ chạy agent researcher (harness) → requirements.md — (dry run)
  ○ kiểm artifact requirements.md tồn tại thật — (dry run)
  ○ advance → REQUIREMENT_ANALYSIS — (dry run)
```

---

## 5. Ba điểm dừng bắt buộc — đúng thiết kế, không phải lỗi

### 5.1 Human gate kiến trúc (INV-05)

`eng design` **luôn** dừng ở `WAITING_DESIGN_APPROVAL`. Chưa approve thì bị chặn:

```text
$ eng gates DEMO-001 --to PLANNING
  architecture: required=true → CHƯA approve

$ eng advance DEMO-001 --to PLANNING
✖ [HUMAN_APPROVAL_REQUIRED] Chuyển WAITING_DESIGN_APPROVAL → PLANNING cần human approval cho gate: architecture.
```

Ghi approval rồi chạy lại:

```bash
$E record $T --type HUMAN_APPROVAL --status PASS --gate-id architecture \
  --approver "tech-lead@bpm" --approved-at 2026-01-01T09:00:00Z --comment "đã review thiết kế"
$E advance $T --to PLANNING        # ✓
```

Không nới gate bằng `--allow-bypass` trừ khi `config/gates.yaml` cho phép.

### 5.2 Evidence gate (INV-03 / RULES-001)

Bảng dưới lấy từ `runtime/src/evidence/rules.ts` — **không** phải chép tay:

| Chuyển sang | Evidence bắt buộc |
|---|---|
| `REVIEWING` | `TEST=PASS` **và** `SCOPE_VALIDATION=PASS` |
| `AUDITING` | `SPEC_REVIEW=PASS` **và** `QUALITY_REVIEW=PASS` |
| `VERIFYING` | `AUDIT=PASS` |
| `DONE` | `BUILD=PASS` + `TEST=PASS` + `SCOPE_VALIDATION=PASS` + `AUDIT=PASS` (+ `HUMAN_APPROVAL` gate `finalVerification` nếu risk `CRITICAL`) |

Trường provenance **bắt buộc theo loại evidence** (`runtime/src/evidence/store.ts` → `REQUIRED_PROVENANCE`) — thiếu là `EVIDENCE_INCOMPLETE`, ghi không được:

| Loại | Trường bắt buộc |
|---|---|
| `TEST`, `BUILD` | `command` · `cwd` · `exitCode` · `gitSha` · `artifact` |
| `HUMAN_APPROVAL` | `gateId` · `approver` · `approvedAt` |
| `SCOPE_VALIDATION` | `unexpectedFiles` · `deletedFiles` (truyền `--unexpected "" --deleted ""` nếu rỗng) |

```text
✖ [EVIDENCE_INCOMPLETE] Evidence TEST thiếu trường provenance bắt buộc: artifact.
```

Bị chặn trông như thế này (output thật):

```text
✖ [EVIDENCE_REQUIRED] Không thể chuyển IMPLEMENTING → REVIEWING khi chưa đủ evidence.
  thiếu:
    - TEST=PASS — tests đã chạy và pass (có exit code)
    - SCOPE_VALIDATION=PASS — diff đã kiểm, không có file ngoài scope (INV-04)
```

Cách đúng: **chạy verification thật rồi ghi evidence**, không nới gate. `eng verify` tự thu `BUILD`/`TEST`/`SCOPE_VALIDATION` qua MCP:

```text
✓ verify DEMO-001 — VERIFYING → DONE
  ✔ evidence:build — node -e process.stdout.write('fixture build ok') (evidence EV-0007)
  ✔ evidence:tests — node -e console.log('fixture ran all tests')   (evidence EV-0008)
  ✔ evidence:scope — ghi evidence scope=PASS                        (evidence EV-0009)
```

Ghi tay khi MCP không dùng được (bắt buộc kèm provenance — INV-12):

```bash
$E record $T --type TEST --status PASS --command "./mvnw -q -Dtest=PolicyServiceTest test" \
  --cwd /duong/dan/repo --exit-code 0 --git-sha "$(git rev-parse HEAD)" \
  --artifact evidence/logs/test.log --producer "mcp:mcp-engineering"
```

### 5.3 MCP không available ⇒ `BLOCKED`

Không tự suy diễn/bịa domain data (INV-06). Kiểm bằng `$E doctor --ping`; nếu fail thì dừng và báo `BLOCKED` kèm lý do cụ thể.

---

## 6. Smoke test không cần LLM

Dùng khi mới clone repo, sau khi nâng cấp, hoặc khi nghi runtime/MCP hỏng mà chưa muốn đốt token.

### 6.1 Xem worker sẽ nhận gì (harness `dry` có sẵn)

```bash
E="node runtime/dist/cli.js"
T="DEMO-000"

$E new $T --title "Smoke: prompt contract" --risk MEDIUM --domain domain
$E agent researcher $T --harness dry --project sample-fixture
rm -rf .engineering/workstreams/$T
```

```text
✓ researcher — tier=medium (sonnet) · complexity=simple · harness=dry · exit=0 · 30ms
  tier   : vai trò researcher=medium · sàn risk MEDIUM=medium · complexity simple=small → medium
  prompt : tasks/researcher-DEMO-000.prompt.md (~1215 token)
  skills : requirements-analysis, brainstorming (~383 token)
  template: templates/requirement.md
  artifact: có [—] · thiếu [requirements.md]
  ⚠ Worker kết thúc nhưng THIẾU artifact bắt buộc: requirements.md — không coi là hoàn thành (RULES-001).
```

`exit=1` ở đây là **đúng**: harness `dry` không sinh artifact nên runtime từ chối coi là hoàn thành.

Xem thêm: `$E skills` · `$E skills route developer --phase implementation` · `$E agents`.

### 6.2 Chạy hết vòng đời trên fixture (không gọi LLM)

⚠️ Khối này **giả lập** bước của agent và **ghi evidence tay** để đi hết state machine nhằm chứng minh runtime + MCP chạy đúng. Evidence ghi tay **không có giá trị kiểm toán** — đừng dùng cho ticket thật.

```bash
E="node runtime/dist/cli.js"
T="DEMO-001"
P="sample-fixture"

rm -rf .engineering/workstreams/$T    # cho phép chạy lại nhiều lần
$E new $T --title "Smoke: thêm field purposeOfLoan" --risk MEDIUM --domain domain

cat > .engineering/workstreams/$T/plan.md <<'EOF'
# Implementation plan — DEMO-001

## TASK-01 — Thêm field purposeOfLoan vào DTO

### Objective
Bổ sung field purposeOfLoan vào PolicyInput.

### Files
- src/main/java/vn/bpm/domain/policy/PolicyInput.java

### Dependencies
none

### Existing Pattern
PolicyInput hiện dùng field private + getter/setter.

### Acceptance Criteria
- PolicyInput có field purposeOfLoan; mapper test PASS.

### Verification
- ./mvnw -q -Dtest=PolicyInputMapperTest test

## TASK-02 — Map field mới vào policy input

### Objective
Map purposeOfLoan từ DTO vào PolicyInput.

### Files
- src/main/java/vn/bpm/domain/policy/PolicyInputMapper.java

### Dependencies
- TASK-01

### Existing Pattern
Mapper map 1-1 theo field.

### Acceptance Criteria
- Rule TD1 đọc được purposeOfLoan.

### Verification
- ./mvnw -q -Dtest=PolicyServiceTest test
EOF

$E plan import $T --file .engineering/workstreams/$T/plan.md   # → plan.json + wave
$E graph $T                                                   # DAG + conflict check (INV-11)
$E context $T --all --project $P                              # context qua MCP thật (INV-01)

for S in TRANSLATING REQUIREMENT_ANALYSIS IMPACT_ANALYSIS DESIGNING WAITING_DESIGN_APPROVAL; do
  $E advance $T --to $S >/dev/null
done
$E record $T --type HUMAN_APPROVAL --status PASS --gate-id architecture \
  --approver "tech-lead@bpm" --approved-at 2026-01-01T09:00:00Z
$E advance $T --to PLANNING
$E advance $T --to READY_TO_IMPLEMENT
$E advance $T --to IMPLEMENTING

SHA=$(git rev-parse HEAD)
# chạy thật command test của fixture, lưu output làm artifact (provenance đầy đủ — INV-12)
mkdir -p .engineering/workstreams/$T/evidence
node -e "console.log('fixture ran suite: PolicyServiceTest')" > .engineering/workstreams/$T/evidence/smoke-test.log
$E record $T --type TEST --status PASS \
  --command "node -e \"console.log('fixture ran suite: PolicyServiceTest')\"" \
  --cwd tests/fixtures/sample-repo --exit-code 0 --git-sha "$SHA" \
  --artifact evidence/smoke-test.log --producer "smoke-test"
$E record $T --type SCOPE_VALIDATION --status PASS --command "git diff --name-only" \
  --cwd tests/fixtures/sample-repo --exit-code 0 --git-sha "$SHA" --unexpected "" --deleted "" --producer "smoke-test"
$E advance $T --to REVIEWING
$E record $T --type SPEC_REVIEW --status PASS --summary "smoke" --producer "smoke-test"
$E record $T --type QUALITY_REVIEW --status PASS --summary "smoke" --producer "smoke-test"
$E advance $T --to AUDITING
$E record $T --type AUDIT --status PASS --summary "smoke" --artifact audit.md --producer "smoke-test"
$E advance $T --to VERIFYING

$E verify $T --project $P        # build+test+scope THẬT qua MCP → DONE
$E metrics $T --write            # đo baseline (spec mục 21)

rm -rf .engineering/workstreams/$T   # dọn
```

Kỳ vọng ở cuối: `verify` báo 3 dòng `✔ evidence:build|tests|scope` rồi `✔ advance:DONE → DONE`; `$E status $T` → `DONE`.

> **Nếu `verify` báo `✖ evidence:scope — ghi evidence scope=FAIL`:** đó là **hành vi đúng** của INV-04, không phải lỗi. Scope validation tính diff của **git repo chứa `repoRoot`**, mà `sample-fixture` là thư mục con của chính repo OS — đúng như `eng doctor` cảnh báo: *"repoRoot là thư mục CON của git repo tại .../bpm-engineering-os — diff/scope tính trên repo đó"*. Nên **mọi** thay đổi chưa commit trong repo OS (kể cả file hướng dẫn này) đều bị coi là file ngoài `allowedRoots` của fixture.
>
> Muốn smoke test đi tới `DONE` một cách xác định:
>
> ```bash
> git stash push -u -m "smoke-test"     # tạm cất thay đổi ngoài fixture
> #   ... chạy khối smoke test ở trên (bỏ dòng rm -rf nếu muốn xem workstream) ...
> git stash pop
> ```
>
> Trên project thật (repo Java độc lập) tình huống này không xảy ra: repo đích là git repo riêng nên diff chỉ tính trong đó.

---

## 7. Sự cố thường gặp

| Hiện tượng | Xử lý |
|---|---|
| `npm ci` fail vì cache root-owned | thêm `--cache ./.npm-cache` |
| `tsc: command not found` | chưa `npm ci`, hoặc `node_modules` hỏng → cài lại bằng cache cục bộ |
| `REPO_ROOT_NOT_CONFIGURED` / doctor WARN repoRoot | set `DOMAIN_REPO_ROOT` (không hard-code vào config) |
| `BLOCKED` khi chạy | `$E resume $T` đọc lý do → `$E recover $T` → thêm `--apply` để áp dụng |
| Worker fail / test fail | `$E recover $T <TASK-NN> --apply` → sinh context recovery tối thiểu, không nhét lại log dài |
| `WORKSTREAM_LOCKED` | `$E lock $T` xem ai giữ; chắc chắn tiến trình đã chết: `$E lock $T --release` |
| MCP không phản hồi | `$E doctor --ping`; fail ⇒ `BLOCKED`, **không** tự suy diễn domain data (INV-06) |
| `EVIDENCE_INCOMPLETE` | thiếu trường provenance (thường là `--artifact` với `TEST`/`BUILD`) — xem bảng ở mục 5.2 |
| Gate từ chối chuyển status | `$E gates $T --to <STATUS>` xem thiếu gate nào; thiếu evidence thì chạy verification thật, không nới gate |
| Muốn xem lại sau crash/`/clear` | `$E resume $T` (artifact thiếu, gate mở, việc tiếp theo) |
| `implement --parallel` bị từ chối | `worktrees.enabled: false` trong `config/projects.yaml` (mặc định an toàn — INV-11) |
| `verify` báo `scope=FAIL` khi chạy smoke test | đúng thiết kế (INV-04): repo OS đang có thay đổi ngoài `allowedRoots` của fixture — xem ghi chú cuối mục 6.2 |

---

## 8. Checklist trước khi dùng thật

1. **Cắm harness LLM thật** vào `config/models.yaml` (mục `harness:`) rồi `enabled: true`. Runtime không hard-code provider (INV-07). Harness nhận qua env: `ENG_PROMPT_FILE`, `ENG_CONTEXT_FILE`, `ENG_WORKSTREAM`, `ENG_ROLE`, `ENG_TASK_ID`, `ENG_SUBTASK_ID`, `ENG_MODEL_TIER`, `ENG_REPO_ROOT`; nếu harness ghi `ENG_USAGE_FILE` thì `eng metrics` mới đo được token (không ghi ⇒ metrics nói rõ "không có nguồn", không bịa).
2. **Set repo đích**: `export DOMAIN_REPO_ROOT=/duong/dan/individual-service`, và **tạo feature branch** trong repo đó — `main`/`master`/`dev`/`production`/`release/*` bị chặn ghi.
3. **Rà `config/projects.yaml`**: `scope.allowedRoots` phủ đúng vùng được sửa (mọi deletion ngoài allowlist bị chặn — INV-04); `commands`/`testSuites` chạy được trên máy bạn (command chỉ resolve từ allowlist, **không** từ input — ADR-08).
4. **Thay dataset domain**: `mcp/mcp-domain-core/data/` là **synthetic**, không dùng cho quyết định nghiệp vụ.
5. Chạy `$E doctor --project individual-service` → **0 FAIL** trước khi mở ticket thật.

---

## 9. Feature sửa nhiều repo (multi-repo)

Một feature thật thường phải sửa nhiều repo — service, consumer/SDK, cấu hình — và các repo đó
có thể nằm ở **các thư mục cha khác nhau**. Hệ thống hỗ trợ sẵn: **1 ticket = 1 feature = n repo**
(spec mục 9.5). Không cần symlink, không cần gộp repo về một chỗ.

```bash
# 1. Khai MỖI repo là một project trong config/projects.yaml (repoRoot lấy từ env ⇒ thư mục nào cũng được)
#    projects:
#      payment-api:    { repoRoot: { env: PAYMENT_API_ROOT, default: null }, scope: {...}, commands: {...} }
#      payment-client: { repoRoot: { env: PAYMENT_CLIENT_ROOT, default: null }, ... }
export PAYMENT_API_ROOT=/srv/banking/payment-api
export PAYMENT_CLIENT_ROOT=/home/team/sdk/payment-client   # cây thư mục khác hoàn toàn — không sao

# 2. Tạo MỘT ticket cho cả feature, khai các repo (--project lặp được; phần tử đầu là repo chính)
$E new PAY-101 --title "Đổi contract thanh toán" --risk HIGH \
  --project payment-api --project payment-client

# 3. Trong plan.md, mỗi task khai "### Repo"; Files là tương đối so với repoRoot của repo đó
#    ## TASK-01 — Thêm field vào request DTO
#    ### Repo
#    payment-api
#    ### Files
#    src/main/java/.../PaymentRequest.java
#
#    ## TASK-02 — Consumer đọc field mới (phụ thuộc TASK-01 ⇒ tự động vào wave sau)
#    ### Repo
#    payment-client
$E plan import PAY-101 --file plan.md
$E graph PAY-101                     # hiển thị [repo] của từng task + wave

# 4. Chạy — context/agent/evidence đều tính theo REPO CỦA TASK
$E context PAY-101 --all
$E implement PAY-101
$E merge PAY-101                     # nếu chạy --parallel
$E verify PAY-101                    # build + test + scope cho MỌI repo
$E metrics PAY-101 --write           # có breakdown evidence theo repo
```

Quy tắc cần nhớ:

| Chủ đề | Quy tắc |
|---|---|
| Tên repo | Phải là project có thật trong `config/projects.yaml`; sai tên ⇒ lỗi rõ ràng, **không** đoán đường dẫn (INV-06) |
| Mỗi task | Chỉ **một** repo. Khai nhiều ⇒ `MULTIPLE_REPO`; hãy tách thành task riêng |
| `### Files` | Tương đối so với repoRoot của repo task đó; context compiler chỉ tra trong repo đó (context có mục `## Repo` để worker không nhầm) |
| Conflict check (INV-11) | So theo **(repo, file)** và **(repo, symbol)**: cùng file ở hai repo khác nhau **không** chặn parallel; migration chỉ cạnh tranh thứ tự trong cùng repo |
| Evidence gate | `BUILD`/`TEST`/`SCOPE_VALIDATION` phải có cho **từng** repo — ghi evidence phải kèm `--project <repo>`; `SPEC_REVIEW`/`QUALITY_REVIEW`/`AUDIT`/`HUMAN_APPROVAL` là **cấp ticket** |
| `--project` khi chạy | Thu hẹp phạm vi về 1 repo; nhưng repo của **task** luôn thắng khi compile context |
| Thứ tự xuyên repo | Dùng chính `### Dependencies`: task ở repo B phụ thuộc task ở repo A ⇒ B vào wave sau |
| Merge | `eng merge` merge theo repo ghi trong `tasks/<TASK-NN>-changes.json`; **thứ tự merge do bạn quyết** (repo contract trước, consumer sau) |
| Contract giữa các repo | Chốt ở `architecture.md` của ticket — runtime không tự suy diễn |

Ticket **không** khai repo nào thì giữ nguyên hành vi cũ (repo lấy từ `--project` hoặc `defaultProject`),
nên mọi ticket một repo đang chạy không bị ảnh hưởng.

---

## 10. Giới hạn đã biết

- **Symbol index là heuristic** (regex khai báo + package/import), không phải type resolution: dùng để thu hẹp phạm vi đọc và xếp hạng caller, **không** dùng để kết luận "không còn caller nào khác" khi xoá code.
- **Parallel** chỉ khi `worktrees.enabled: true`; `eng merge` là bước riêng, không tự động.
- **Multi-repo**: `eng merge` không tự merge xuyên repo; chưa có "epic" nhiều ticket (mỗi feature vẫn là 1 ticket).
- Metrics **chưa** có: baseline so với quy trình cũ, escape rate sau release, cost quy ra tiền, % context "causal relevant".
- Chạy `npm test` để lại `.engineering/workstreams/TEST-0001` + thư mục rỗng trong `.engineering/worktrees/` (vô hại vì `.engineering/` bị gitignore — xoá tay nếu muốn sạch).

## 11. Đọc tiếp

1. `RUNBOOK.md` — chạy ticket thật theo 8 phase trên máy nội bộ, kèm bảng xử lý sự cố.
2. `runtime/README.md` — tham chiếu CLI + library API (`StateStore`, `EvidenceStore`, `EventBus`).
3. `SPEC-bpm-engineering-os.md` mục 18.1 — thứ tự 20 bước còn lại của Phase 1.
4. `CLAUDE.md` mục 1 — 12 bất biến phải nhớ trước khi sửa bất cứ thứ gì.
