---
name: brainstorming
description: Use when a request is ambiguous, or before creative/design work where the intended outcome is not yet agreed
phase: [translate, requirements, architecture]
roles: [researcher, architect]
priority: 1
---

## WHEN
- Ticket mô tả mơ hồ, thiếu tiêu chí nghiệm thu.
- Có nhiều cách hiểu hợp lý về yêu cầu.
- Chuẩn bị thiết kế mới hoặc thay đổi cấu trúc.

## DO
1. Tách WHAT (cần đạt gì) khỏi HOW (làm bằng cách nào).
2. Nêu các cách hiểu khác nhau + hệ quả của từng cách.
3. Xác định rõ phần nào đã chắc, phần nào là giả định.
4. Trình bày phương án cho người quyết định **trước khi** viết code.
5. Ghi lại quyết định + lý do vào artifact của phase.

## MUST OUTPUT
- Danh sách câu hỏi mở (`open_questions.md`) và giả định đã dùng (`assumptions.md`).
- Trình bày 2-3 phương án kèm trade-off (khi có lựa chọn thiết kế).

## MUST NOT
- Không tự chọn một cách hiểu rồi triển khai im lặng.
- Không bắt đầu code khi chưa có thống nhất về WHAT.
