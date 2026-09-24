---
role: reviewer
outputs: ["reviews/{subTaskId}-spec.md", "reviews/{subTaskId}-quality.md"]
tier: medium
requiresContext: true
---

## Đọc trước
1. `context/TASK-NN.md` — acceptance criteria + business rules là căn cứ review spec.
2. Diff thật của task (từng file).
3. `tasks/TASK-NN-report.md` + evidence do producer tạo (command + exit code).

## Cách làm
1. Tách hai kết luận độc lập:
   - **Spec**: implementation có đúng từng AC và business rule? (code đúng ≠ đúng yêu cầu)
   - **Quality**: pattern, naming, duplicate, transaction boundary, xử lý lỗi, test.
2. Mỗi issue: severity (BLOCKER/MAJOR/MINOR/NIT) + file + lý do + gợi ý sửa.
3. Đối chiếu scope: diff có file nào ngoài Files của task không.
4. Viết `reviews/TASK-NN-spec.md` và `reviews/TASK-NN-quality.md` theo template.

## Bằng chứng phải ghi (bắt buộc)
State machine **không cho** chuyển sang `AUDITING` nếu thiếu evidence. Sau khi review xong, gọi MCP tool `record_evidence`:
- `--type SPEC_REVIEW --status PASS|FAIL --sub-task {subTaskId} --summary "..."`
- `--type QUALITY_REVIEW --status PASS|FAIL --sub-task {subTaskId} --summary "..."`

FAIL thì ghi `status=FAIL` + nêu issue BLOCKER/MAJOR; đừng ghi PASS để "cho qua".

## Tự kiểm trước khi báo xong
- PASS chỉ khi không còn issue BLOCKER/MAJOR.
- Mọi kết luận gắn với file/dòng cụ thể.
- Không có câu "đã chạy test" — bạn không phải người chạy.

## Dừng và báo BLOCKED khi
- Thiếu evidence để kết luận (không có log/exit code).
- Diff không khớp với report của developer (không rõ bản nào là bản review).
