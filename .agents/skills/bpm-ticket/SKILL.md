---
name: bpm-ticket
description: Use when running or resuming a BPM Engineering OS ticket (eng CLI) and you need the exact commands — create, translate, analyze, design, human gate, plan, implement, review, audit, verify, metrics, recovery
whenToUse: Người dùng nói "chạy ticket", "làm ticket TASK-xxxx", "ticket đang tới bước nào", hoặc cần lệnh `eng` cho một pha.
---

# Chạy một ticket BPM Engineering OS

Adapter mỏng: nguồn sự thật vẫn là `GETTING-STARTED.md` (mục 4, 5, 9) và `RUNBOOK.md` (mục 4).
Skill này chỉ để khỏi phải nhớ cú pháp — KHÔNG chép lại luật nghiệp vụ.

## Trạng thái MCP (đọc trước khi hứa hẹn gì)

- `mcp-engineering`: **đang bật** — tra code/symbol/git, chạy build/test theo allowlist, ghi evidence.
- `mcp-domain-core`: **TẠM DỪNG** (`config/mcp.yaml → enabled: false`). Đừng hứa "tra policy/rule nghiệp vụ";
  `eng context` sẽ in cảnh báo `MCP đang TẮT theo config (mcp-domain-core)`. Khi thiếu dữ liệu nghiệp vụ:
  báo `BLOCKED`, **không suy diễn** (INV-06).

## Trước khi chạy: xác định 3 biến

```bash
E="node <OS_ROOT>/runtime/dist/cli.js"   # hoặc: npm run eng --   (khi đang ở repo OS)
T="<TASK_ID>"                            # dạng <PREFIX>-<số>, ví dụ TASK-49043
P="<project>"                            # tên project trong config/projects.yaml
```

Repo đích phải ở **feature branch** (`main`/`dev`/`production`/`release/*` bị chặn ghi).
Environment: `DOMAIN_REPO_ROOT` (repo đích), `PROJECTS_CONFIG` nếu dùng config riêng.

## Ticket đang tới bước nào? (luôn chạy cái này trước)

```bash
$E resume $T          # artifact thiếu · gate đang mở · việc tiếp theo
$E status $T          # 1 dòng + việc tiếp
$E next   $T          # các status có thể chuyển tới
```

## Cách ngắn nhất — `eng continue` (2 lệnh cho cả ticket)

```bash
$E continue $T --harness <harness> --project $P
# → chạy các pha kế tiếp tới khi phải chờ người; in sẵn lệnh cần gõ tiếp
# → exit 0 CHỈ khi DONE; HUMAN_GATE / EVIDENCE_OR_ERROR / NO_PROGRESS / MAX_STEPS = exit 1
$E continue $T --dry-run          # chiếu trước, không đổi state
$E continue $T --max-steps 3      # giới hạn số pha một lần chạy
```

Điểm dừng `HUMAN_GATE` nghĩa là phải có người approve — nó in ra đúng lệnh `eng record ... HUMAN_APPROVAL`
để gõ tiếp rồi chạy lại `eng continue`. `NO_PROGRESS` thường là phải `eng merge` (khi chạy `--parallel`).
Lệnh này KHÔNG nới gate nào.

## 8 pha — khi cần chạy riêng từng pha

```bash
$E new       $T --title "..." --risk LOW|MEDIUM|HIGH|CRITICAL --project $P
$E translate $T --harness <harness> --project $P     # → requirements.md
$E analyze   $T --harness <harness> --project $P     # → impact.md
$E design    $T --harness <harness> --project $P     # → architecture.md, DỪNG ở human gate
$E plan      $T --harness <harness> --project $P     # plan.md → plan.json + wave
$E implement $T --harness <harness> --project $P     # context + wave + evidence
$E review    $T --harness <harness> --project $P     # reviewer 2 tầng
$E audit     $T --harness <harness> --project $P     # → audit.md
$E verify    $T --project $P                         # build+test+scope → DONE
$E metrics   $T --write                              # baseline (spec 21)
```

Thêm `--dry-run` để xem các bước mà KHÔNG gọi LLM và không đổi state.

## Hai điểm dừng bắt buộc (không phải lỗi)

1. **Human gate kiến trúc**: sau `design`, phải có người duyệt rồi mới `plan`:

```bash
$E record $T --type HUMAN_APPROVAL --status PASS --gate-id architecture \
  --approver "<tên>" --approved-at <ISO-8601>
```

2. **Evidence gate**: `IMPLEMENTING→REVIEWING` cần `TEST` + `SCOPE_VALIDATION`; `REVIEWING→AUDITING` cần
   `SPEC_REVIEW` + `QUALITY_REVIEW`; `AUDITING→VERIFYING` cần `AUDIT`. Thiếu ⇒ chạy verification thật,
   **không** nới gate. `TEST`/`BUILD` bắt buộc có `--artifact` (INV-12).

## Ticket sửa NHIỀU repo (spec 9.5)

```bash
$E new $T --title "..." --project payment-api --project payment-client
# plan.md: mỗi task khai "### Repo: <project>"; Files tương đối so với repoRoot của repo đó
$E plan import $T --file plan.md
$E context  $T --all          # mỗi task lấy context từ repo của nó
$E implement $T --harness <harness>
$E merge    $T                # nếu chạy --parallel
$E verify   $T                # build+test+scope cho MỌI repo
```

`BUILD`/`TEST`/`SCOPE_VALIDATION` phải có cho **từng** repo ⇒ khi `record` tay nhớ `--project <repo>`.
`SPEC_REVIEW`/`QUALITY_REVIEW`/`AUDIT`/`HUMAN_APPROVAL` là cấp ticket. Chi tiết: `GETTING-STARTED.md` mục 9.

## Khi hỏng

| Hiện tượng | Lệnh |
|---|---|
| `BLOCKED` | `$E resume $T` → `$E recover $T [--apply]` |
| Worker/test fail | `$E recover $T <TASK-NN> --apply` |
| `WORKSTREAM_LOCKED` | `$E lock $T` · `$E lock $T --release` |
| MCP treo | `$E doctor --ping` (fail ⇒ BLOCKED, không đoán — INV-06) |
| Gate từ chối | `$E gates $T --to <STATUS>` |
| `EVIDENCE_INCOMPLETE` | thiếu `--artifact` (TEST/BUILD) hoặc `--unexpected/--deleted` (SCOPE_VALIDATION) |

## MUST NOT

- Không tự chuyển status bằng cách sửa `task.json`; mọi thay đổi qua `advance` (INV-03).
- Không tự approve kiến trúc, không tuyên bố "done" khi `eng status` chưa `DONE` (INV-05).
- Không đoán domain data khi MCP không dùng được — báo `BLOCKED` (INV-06).
- Không dùng `--allow-bypass` trừ khi `config/gates.yaml` cho phép.
