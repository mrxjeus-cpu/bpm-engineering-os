---
name: verification
description: Use when you are about to claim that work is complete, or when asked whether something works
phase: [implementation, review, audit, verification]
roles: [developer, reviewer, auditor]
required: true
priority: 3
---

## WHEN
- Trước khi nói "xong", "đã sửa", "test pass".
- Khi được hỏi một thứ có hoạt động không.
- Sau khi sửa bug, thêm field, đổi rule.

## DO
1. Xác định chính xác điều cần chứng minh (không phải "chạy thử xem sao").
2. Chạy command thật, **đọc output**, kiểm exit code. Không suy luận từ việc code "trông đúng".
3. Kiểm tra diff thật (`git diff`) và đối chiếu với scope task.
4. Ghi evidence kèm provenance: command, cwd, exit code, artifact log.
5. Chỉ kết luận sau khi có bằng chứng mới trong lần chạy này.

## MUST OUTPUT
- Evidence có provenance: `{command, cwd, exitCode, gitSha, artifact}`.
- Câu kết luận nêu rõ: đã chạy gì, kết quả gì, còn gì chưa kiểm được.

## MUST NOT
- Không nói "should work", "looks good", "tests should pass".
- Không dùng evidence của lần chạy trước hoặc của người khác làm bằng chứng hiện tại.
- Không bỏ qua bước đọc output — exit code 0 mà log có lỗi vẫn phải xem.
