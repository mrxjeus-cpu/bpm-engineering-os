---
name: systematic-debugging
description: Use when a failure, regression, or unexpected behavior has an unclear root cause
phase: [implementation, review, audit]
roles: [developer, reviewer, auditor]
triggers: [bug, lỗi, fail, failed, regression, sai, không chạy, crash, exception]
priority: 1
---

## WHEN
- Test fail, build fail, hoặc hành vi khác mong đợi mà chưa rõ nguyên nhân.
- Có regression sau một thay đổi.
- Task đã sửa 2 lần mà vẫn fail (dừng đoán mò).

## DO
1. Tái hiện lỗi một cách xác định (command + input tối thiểu).
2. Đọc thông báo lỗi đầy đủ, tìm dòng/stack đầu tiên thuộc code của mình.
3. Thu hẹp phạm vi: so sánh trước/sau thay đổi (`git diff`), bật log cần thiết.
4. Nêu giả thuyết → kiểm giả thuyết bằng một phép thử nhỏ, không sửa nhiều chỗ cùng lúc.
5. Khi tìm ra root cause: sửa tối thiểu, thêm test tái hiện, chạy lại.
6. Nếu không tìm được trong phạm vi task: báo `BLOCKED` kèm những gì đã loại trừ.

## MUST OUTPUT
- Root cause (hoặc danh sách giả thuyết đã loại trừ + bằng chứng).
- Command tái hiện + kết quả trước/sau.
- Test mới bảo vệ khỏi tái phát (nếu được).

## MUST NOT
- Không sửa nhiều nơi cùng lúc để "chắc là được".
- Không tắt/comment test hoặc bọc try/catch để che lỗi.
- Không tuyên bố đã sửa khi chưa chứng minh bằng phép thử tái hiện.
