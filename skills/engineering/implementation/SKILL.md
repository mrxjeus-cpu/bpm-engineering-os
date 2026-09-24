---
name: implementation
description: Use when executing one compiled task inside its context package
phase: [implementation]
roles: [developer]
required: true
priority: 3
---

## WHEN
- Bắt đầu thực hiện một `TASK-NN` đã có `context/<TASK-NN>.md`.
- Sửa file trong phạm vi Files của task.

## DO
1. Đọc hết context trước khi sửa: Files · Symbols · Existing Pattern · Business Rules · Constraints · Tests · AC.
2. Kiểm tra scope: chỉ sửa file trong `Files`; nếu buộc phải sửa ngoài ⇒ dừng và báo lý do.
3. Theo TDD (skill `tdd`): test trước, thấy fail, implement tối thiểu.
4. Tái sử dụng pattern có sẵn (skill `existing-code-first`); không tạo abstraction mới nếu không cần.
5. Chạy test của task + test liên quan; đọc output thật.
6. Tự kiểm scope: `validate_scope` (hoặc `eng record` evidence SCOPE_VALIDATION) trước khi báo xong.
7. Viết `tasks/TASK-NN-report.md`: đã đổi gì · test nào · evidence · vấn đề còn lại.

## MUST OUTPUT
- Code thay đổi đúng phạm vi + test.
- `tasks/TASK-NN-report.md` (artifact bắt buộc — thiếu thì hệ thống coi như chưa xong).
- Evidence: command, exit code, artifact log.

## MUST NOT
- Không xóa/đổi business logic ngoài scope (INV-04).
- Không tự thay đổi architecture decision đã approve.
- Không sửa test để pass khi hành vi sai.
- Không tuyên bố hoàn thành khi chưa chạy verification (skill `verification`).
