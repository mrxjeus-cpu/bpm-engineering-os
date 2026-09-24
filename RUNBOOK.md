# RUNBOOK — chạy một ticket thật trên máy nội bộ

Mục tiêu: chạy hết một ticket BPM từ `translate` → `verify` bằng Engineering OS, và **biết rõ chỗ nào hỏng thì sửa gì**. Đây là bước 20 của spec mục 18.1 (bước duy nhất còn lại của Phase 1).

Quy tắc xuyên suốt: **không tin lời agent, chỉ tin artifact + evidence có provenance.** Nếu thiếu thì dừng và báo `BLOCKED`, không đoán.

---

## 0. Chuẩn bị máy (một lần)

```powershell
node -v                     # cần >= 22
git --version
cd <thư mục repo này>
npm ci --no-audit --no-fund --cache ./.npm-cache   # ~/.npm có thể không ghi được trên máy nội bộ
npm run build
npm test                    # phải xanh trước khi tin bất cứ thứ gì khác
```

## 1. Preflight: `eng doctor`

```powershell
node runtime/dist/cli.js doctor                 # hoặc: npm run eng -- doctor
node runtime/dist/cli.js doctor --ping          # thêm: khởi động THẬT 2 MCP server, đếm tool
node runtime/dist/cli.js doctor --project individual-service
```

Đọc kết quả:

| Mức | Nghĩa | Phải làm gì |
|---|---|---|
| `FAIL` | chắc chắn hỏng khi chạy thật | sửa hết trước khi đi tiếp; mỗi dòng có `→` chỉ cách sửa |
| `WARN` | chạy được nhưng dễ sinh lỗi/mất evidence | đọc và quyết định; ví dụ working tree dirty sẽ làm `validate_scope` tính sai |
| `ok` | đã kiểm bằng dữ liệu thật | — |

`doctor` **không** gọi LLM và không chạy harness (trừ `--ping` với MCP), nên chạy được bao nhiêu lần cũng rẻ.

## 2. Cấu hình repo đích (env, không hard-code)

`config/projects.yaml` đã khai project `individual-service` với `repoRoot: { env: DOMAIN_REPO_ROOT }`.

```powershell
# PowerShell — session hiện tại
$env:DOMAIN_REPO_ROOT = "C:\src\individual-service"
# hoặc vĩnh viễn: setx DOMAIN_REPO_ROOT "C:\src\individual-service"  (mở shell mới)

node runtime/dist/cli.js doctor --project individual-service --json
```

Bắt buộc:

- `scope.allowedRoots` phải phủ đúng vùng được sửa (INV-04 — mọi deletion ngoài allowlist bị chặn).
- `commands` / `testSuites` phải chạy được trên máy này; command **không** lấy từ input mà từ allowlist (ADR-08).
- Tạo **feature branch** trong repo đích trước khi implement — branch `main`/`dev`/`production`/`release/*` bị chặn ghi (CLAUDE.md mục 2).

## 3. Cấu hình harness LLM thật (INV-07)

Runtime không hard-code provider. Khai trong `config/models.yaml`:

```yaml
harness:
  internal-cli:
    enabled: true
    command: ["bpm-ai", "run", "--prompt-file", "{prompt}", "--model-tier", "{tier}"]  # ví dụ
    cwd: "{repoRoot}"
    timeoutMs: 1800000
```

Harness nhận qua env (không cần parse argv nếu CLI của bạn đọc env):

| Biến | Nội dung |
|---|---|
| `ENG_PROMPT_FILE` | đường dẫn prompt contract (9 phần) |
| `ENG_CONTEXT_FILE` | `context/TASK-NN.md` — **nguồn duy nhất** worker được đọc (INV-01) |
| `ENG_WORKSTREAM` | thư mục workstream để ghi artifact |
| `ENG_ROLE`, `ENG_TASK_ID`, `ENG_SUBTASK_ID`, `ENG_MODEL_TIER` | metadata |
| `ENG_REPO_ROOT` | repo đích |
| `ENG_USAGE_FILE` | **tùy chọn**: harness ghi `{"inputTokens":N,"outputTokens":N,"source":"..."}` để `eng metrics` đo được cost |

Nếu harness không ghi `ENG_USAGE_FILE`, cost vẫn đo được theo **tier + thời gian**; phần token sẽ hiện là "không có nguồn" — không bịa.

## 4. Chạy ticket

> **Ngắn nhất**: `node runtime/dist/cli.js continue $T --harness internal-cli --project $P` chạy liên tiếp
> các pha cho tới khi phải chờ người (human gate / evidence gate / merge / lỗi) rồi in đúng lệnh cần gõ tiếp.
> Exit 0 chỉ khi ticket `DONE`. Các lệnh từng pha dưới đây dùng khi cần chạy riêng một pha.

```powershell
$T = "TASK-49043"
$P = "individual-service"

node runtime/dist/cli.js new $T --title "..." --risk HIGH --domain domain
node runtime/dist/cli.js translate $T --harness internal-cli --project $P
node runtime/dist/cli.js analyze   $T --harness internal-cli --project $P
node runtime/dist/cli.js design    $T --harness internal-cli --project $P   # dừng ở WAITING_DESIGN_APPROVAL
```

Thêm `--dry-run` cho lần chạy đầu: chỉ in các bước sẽ thực hiện, **không** gọi LLM và không đổi state.

### 4.1 Human gate (bắt buộc — INV-05)

Đọc `architecture.md` trong workstream, rồi ghi approval:

```powershell
node runtime/dist/cli.js evidence $T
node runtime/dist/cli.js record $T --type HUMAN_APPROVAL --status PASS `
  --gate-id architecture --approver "tech-lead@bpm" --approved-at 2026-01-01T09:00:00Z `
  --comment "đã review thiết kế"
```

Không có approval thì `plan` sẽ báo `HUMAN_APPROVAL_REQUIRED` — đúng thiết kế, không phải lỗi.

**Risk LOW**: `config/gates.yaml` cho phép bỏ qua gate architecture nếu có cờ — dùng được ở cả `eng advance`
lẫn phase/`eng continue`: `... --allow-bypass`. Mọi lần bypass đều ghi `task.gateBypasses` + event
`HumanGateBypassed` (phân biệt với người duyệt thật), và `eng metrics` hiện `— BYPASSED (lý do)`.

### 4.2 Plan → context → implement

```powershell
node runtime/dist/cli.js plan      $T --harness internal-cli --project $P   # plan.md → plan.json + wave
node runtime/dist/cli.js graph     $T                                       # DAG + conflict check (INV-11)
node runtime/dist/cli.js context   $T --all --project $P                    # mỗi sub-task một context
node runtime/dist/cli.js implement $T --harness internal-cli --project $P   # tuần tự theo wave
# song song (chỉ khi worktrees.enabled: true trong projects.yaml):
node runtime/dist/cli.js implement $T --parallel --concurrency 2 --harness internal-cli --project $P
node runtime/dist/cli.js merge     $T
```

### 4.3 Review → audit → verify

```powershell
node runtime/dist/cli.js review $T --harness internal-cli --project $P
node runtime/dist/cli.js audit  $T --harness internal-cli --project $P
node runtime/dist/cli.js verify $T --project $P      # thu evidence BUILD/TEST/SCOPE_VALIDATION thật
node runtime/dist/cli.js status $T                   # DONE + evidence đầy đủ
```

### 4.4 Ticket sửa NHIỀU repo (spec mục 9.5)

Feature thật thường phải sửa nhiều repo — có thể nằm ở **các thư mục cha khác nhau**. Không cần symlink,
không cần gộp repo: khai mỗi repo là một project trong `config/projects.yaml` (`repoRoot` lấy từ env).

```powershell
$P1 = "payment-api"; $P2 = "payment-client"
node runtime/dist/cli.js new $T --title "..." --risk HIGH --project $P1 --project $P2
# plan.md: mỗi task khai "### Repo: payment-api" (hoặc payment-client); Files tương đối so với repoRoot của repo đó
node runtime/dist/cli.js plan import $T --file plan.md
node runtime/dist/cli.js graph    $T                 # hiển thị [repo] từng task + wave
node runtime/dist/cli.js context  $T --all           # mỗi task lấy context từ REPO CỦA NÓ
node runtime/dist/cli.js implement $T --harness internal-cli            # tuần tự
node runtime/dist/cli.js implement $T --parallel --concurrency 2 --harness internal-cli   # worktree theo từng repo
node runtime/dist/cli.js merge    $T                 # merge theo repo ghi trong tasks/TASK-NN-changes.json
node runtime/dist/cli.js verify   $T                 # build+test+scope cho MỌI repo của ticket
node runtime/dist/cli.js metrics  $T --write         # có breakdown evidence theo repo
```

Bắt buộc nhớ:

- `BUILD`/`TEST`/`SCOPE_VALIDATION` phải có cho **từng** repo ⇒ khi `record` tay phải thêm `--project <repo>`;
  `SPEC_REVIEW`/`QUALITY_REVIEW`/`AUDIT`/`HUMAN_APPROVAL` là cấp ticket.
- Thứ tự phụ thuộc **xuyên repo** ghi ở `### Dependencies` (task repo B phụ thuộc task repo A ⇒ B vào wave sau).
- Conflict check tính theo cặp (repo, file) ⇒ cùng file ở hai repo **không** chặn parallel.
- Thứ tự merge do người quyết (repo contract trước, consumer sau); contract chốt ở `architecture.md`.

## 5. Đo baseline (spec mục 21)

```powershell
node runtime/dist/cli.js metrics $T --write      # in + ghi metrics.md vào workstream
node runtime/dist/cli.js metrics $T --json
```

Có sẵn: thời gian mỗi status, thời gian chờ gate, evidence gate tái dựng tại thời điểm transition, số lần BLOCKED (kể cả do MCP), cost theo model tier thật đã dùng, review rejection rate.
Chưa có (được liệt kê ngay trong output): baseline so với quy trình cũ, escape rate sau release, cost quy ra tiền (cần bảng giá theo tier), % context "causal relevant".

## 6. Khi có sự cố

| Hiện tượng | Xử lý |
|---|---|
| `BLOCKED` khi chạy | `eng resume $T` đọc lý do; `eng recover $T` phân loại; thêm `--apply` để áp recovery |
| Worker fail / test fail | `eng recover $T <TASK-NN> --apply` → sinh context recovery tối thiểu, không nhét lại log dài |
| `WORKSTREAM_LOCKED` | `eng lock $T` xem ai giữ; nếu chắc chắn tiến trình đã chết: `eng lock $T --release` |
| MCP không phản hồi | `eng doctor --ping`; nếu fail ⇒ `BLOCKED` và **không** tự suy diễn domain data (INV-06) |
| Gate từ chối chuyển status | `eng gates $T --to <STATUS>` xem gate nào thiếu; thiếu evidence thì chạy verification thật, không nới gate |
| Muốn xem lại sau crash/`/clear` | `eng resume $T` (artifact thiếu, gate mở, việc tiếp theo) |

## 7. Giới hạn đã biết khi chạy thật

- **Symbol index là heuristic** (regex khai báo + package/import), không phải type resolution. Dùng để thu hẹp phạm vi đọc và xếp hạng caller; **không** dùng để kết luận "không còn caller nào khác" khi xoá code.
- **Parallel** chỉ khi `worktrees.enabled: true`; merge là bước riêng, không tự động.
- **CI**: repo đang private nên kết quả Actions (ubuntu/windows) chỉ xem được trên GitHub; macOS chạy theo lịch tuần để tiết kiệm hạn mức.
- **Dataset DOMAIN** trong `mcp/mcp-domain-core/data/` là synthetic — phải thay bằng nguồn thật trước khi dùng cho quyết định nghiệp vụ.

## 8. Định nghĩa "xong" của Phase 1

Một ticket thật đi hết chuỗi trên với evidence đầy đủ, và `eng metrics` cho ra số baseline đủ để so với cách làm hiện tại. Khi đó spec mục 18.1 bước 20 hoàn thành — không phải khi mọi thứ "có vẻ chạy".
