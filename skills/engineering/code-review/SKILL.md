---
name: code-review
description: Use when a diff must be reviewed for spec compliance and code quality
phase: [review]
roles: [reviewer]
required: true
priority: 2
---

## WHEN
- Có diff của một task cần review trước khi sang audit.
- Cần xác nhận implementation có đúng yêu cầu VÀ đúng kỹ thuật.

## DO
1. Review 2 tầng, tách biệt kết luận:
   - Spec compliance: đối chiếu từng acceptance criteria + business rule trong context.
   - Code quality: pattern, naming, duplicate, transaction boundary, xử lý lỗi, test.
2. Đọc diff thật theo từng file; không đánh giá qua mô tả của developer.
3. Kiểm evidence do producer tạo (command + exit code). Không tự claim đã chạy test.
4. Mỗi issue ghi: severity (BLOCKER/MAJOR/MINOR/NIT) · file · lý do · gợi ý.
5. Nếu thiếu evidence để kết luận ⇒ báo `BLOCKED`, không đoán.

## MUST OUTPUT
- `reviews/TASK-NN-spec.md` (artifact bắt buộc) và `reviews/TASK-NN-quality.md`.
- Kết luận PASS/FAIL kèm danh sách issue có severity.

## MUST NOT
- Không sửa code trong lúc review.
- Không nói "đã chạy test" nếu bạn không phải người chạy.
- Không PASS khi còn issue BLOCKER/MAJOR.
