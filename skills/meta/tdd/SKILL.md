---
name: tdd
description: Use when implementing or changing behavior that has tests or should have tests
phase: [implementation]
roles: [developer]
required: true
priority: 3
---

## WHEN
- Thêm/sửa hành vi có thể kiểm bằng test.
- Sửa bug đã tái hiện được.
- Đổi rule nghiệp vụ (policy, tính toán, mapping).

## DO
1. RED: viết/đổi test trước, chạy và **thấy nó fail** vì đúng lý do mong đợi.
2. GREEN: implement tối thiểu để test pass.
3. REFACTOR: dọn code khi test đã xanh; không đổi hành vi.
4. Chạy lại toàn bộ suite liên quan (không chỉ test mới).
5. Nếu không thể viết test tự động, nêu rõ **verification thay thế** và lý do.

## MUST OUTPUT
- Test đã chạy: command + exit code + số test pass/fail.
- Với bug: test tái hiện được lỗi trước khi sửa.

## MUST NOT
- Không viết test sau khi đã implement xong rồi gọi đó là TDD.
- Không sửa test để nó pass khi hành vi thực tế sai.
- Không bỏ qua việc chạy lại test cũ.
