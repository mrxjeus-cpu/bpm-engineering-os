# agents/ — Worker agent prompt contracts

Mỗi file là **prompt contract** cho một vai trò (spec mục 10). Worker chạy với **context mới** (INV-01) và chỉ nhận đường dẫn context, không nhận nội dung conversation.

> **Runtime đọc gì ở đây:** `runtime/src/agents/registry.ts` giữ contract máy-đọc-được (input/output/DO NOT) cho 6 vai trò. Nếu tồn tại `agents/<role>.md`, runtime **nối phần thân file vào prompt** ở mục `ADDITIONAL INSTRUCTIONS` (bỏ qua YAML front-matter). Nghĩa là bạn có thể thêm luật riêng của dự án mà không sửa code.
>
> Prompt contract 9 phần (`ROLE → DO NOT`) do `runtime/src/agents/prompt.ts` render — không viết tay ở đây.
> Xem thử: `npm run eng -- agents` và `npm run eng -- agent developer <TASK_ID> <TASK-NN> --dry-run`.

## Mọi prompt phải theo cấu trúc này

```text
ROLE
OBJECTIVE
TASK
CONTEXT          (đường dẫn file, KHÔNG paste)
CONSTRAINTS
INPUTS
EXPECTED OUTPUT
VERIFICATION
DO NOT
```

## Danh sách (đã viết)

| File | Vai trò | Input | Output | Model tier |
|---|---|---|---|---|
| `researcher.md` | Researcher / Translator | raw ticket + GLOBAL/PROJECT subset | `requirements.md`, `open_questions.md`, `assumptions.md` | medium |
| `impact.md` | Impact agent | requirements + repo + 2 MCP | `impact.md` (API/DB/entity/service/policy/fact/external/test + regression risk) | medium |
| `architect.md` | Architect | requirements + impact + architecture constraints + existing patterns | `architecture.md` (options A/B/C, decision, trade-offs, migration, rollback, risks) | large |
| `developer.md` | Developer | `context/task-NN.md` + tests + constraints | code + test evidence + `task-NN-report.md` | medium |
| `reviewer.md` | Reviewer 2 tầng | requirements + design + `git diff` + evidence | `reviews/task-NN-spec.md`, `reviews/task-NN-quality.md` | medium |
| `auditor.md` | Auditor | toàn bộ diff + requirements + design + evidence | `audit.md` | large |

## Bất biến áp dụng cho mọi agent

- Developer **không** tự đổi architecture decision; **không** xóa logic ngoài scope.
- Reviewer **không** claim test mới; chỉ đọc evidence do producer tạo. Thiếu evidence ⇒ `BLOCKED`.
- Mọi agent: không "done" nếu chưa có evidence mới (RULES-001 / INV-03).
- Mọi agent: MCP lỗi hoặc thiếu dữ liệu ⇒ `BLOCKED` kèm lý do, **không** suy diễn (INV-06).

Xem thêm: spec mục 10, 11 và `config/models.yaml`.
