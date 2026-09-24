# templates/ — Mẫu artifact trong workstream (đã có đủ 8 file)

Template dùng để sinh artifact trong `.engineering/workstreams/<TICKET>/`. Template là **cấu trúc**, không phải nội dung nghiệp vụ.

## Danh sách (đã viết)

| Template | Sinh ra | Ràng buộc |
|---|---|---|
| `requirement.md` | `requirements.md` | Phải trả lời: WHAT changed · WHY · WHO affected · WHAT unchanged · AC · business rules · unknowns |
| `impact.md` | `impact.md` | Phải liệt kê: service / module / class / DB / downstream / API / policy / fact / external / test + regression risk areas |
| `design.md` | `architecture.md` | Bắt buộc có: Problem · Current · Proposed · Alternatives · Decision · Trade-offs · Affected Components · Migration · Testing · Risks · Rollback |
| `plan.md` | `plan.md` | Theo `schemas/plan.schema.json`; mỗi task có Objective/Files/Symbols/Dependencies/Existing Pattern/AC/Verification |
| `task-brief.md` | `context/task-NN.md` | Chỉ chứa nội dung của **một** task (context slicing). Không nhúng toàn bộ plan |
| `task-report.md` | `tasks/task-NN-report.md` | Code thay đổi · test đã chạy · evidence · vấn đề còn lại · đề xuất |
| `review.md` | `reviews/task-NN-{spec,quality}.md` | Theo `schemas/review.schema.json`; review FAIL phải có issue BLOCKER/MAJOR |
| `audit.md` | `audit.md` | Requirement coverage · architecture compliance · unexpected behavior change · security · data integrity · backward compatibility · logging · exception · transaction boundary · concurrency · performance |

## Runtime dùng template thế nào

`agents/registry.ts` khai báo `templates: [...]` cho từng agent. Khi chạy `eng agent`, runtime đọc file template và nhúng vào prompt ở mục **OUTPUT FORMAT** (giới hạn 80 dòng), để artifact của worker đúng cấu trúc ngay từ lần đầu:

| Agent | Template nhúng |
|---|---|
| researcher | `requirement.md` |
| impact | `impact.md` |
| architect | `design.md`, `plan.md` |
| developer | `task-report.md` |
| reviewer | `review.md` |
| auditor | `audit.md` |

`task-brief.md` là bản mô tả cấu trúc của `context/TASK-NN.md` (runtime sinh tự động, không viết tay) — dùng để đối chiếu.

## Nguyên tắc

- Markdown cho artifact người đọc; JSON cho state/evidence (`schemas/`).
- Không đưa dữ liệu khách hàng thật vào ví dụ trong template.
- Template không được dài dòng: đây là thứ agent đọc mỗi task, mỗi dòng tốn token.

Xem spec mục 7.3, 9.3 và 16.1.
