---
name: requirements-analysis
description: Use when a raw ticket or request must be turned into verifiable requirements
phase: [requirements]
roles: [researcher]
required: true
priority: 2
---

## WHEN
- Nhận ticket/đề nghị thô cần chuyển thành yêu cầu kỹ thuật.
- Yêu cầu thiếu tiêu chí nghiệm thu hoặc thiếu business rule.

## DO
1. Trả lời rõ: WHAT thay đổi · WHY · WHO bị ảnh hưởng · WHAT giữ nguyên.
2. Viết acceptance criteria kiểm chứng được (có số liệu/điều kiện cụ thể).
3. Liệt kê business rule liên quan; rule nào chưa rõ ⇒ đưa vào `open_questions.md`.
4. Ghi giả định đã dùng vào `assumptions.md` (kèm mức độ ảnh hưởng nếu giả định sai).
5. Nêu phạm vi KHÔNG làm để tránh trượt scope.

## MUST OUTPUT
- `requirements.md` (WHAT/WHY/WHO/không đổi/AC/business rules).
- `open_questions.md` và `assumptions.md` khi có.

## MUST NOT
- Không viết code.
- Không tự chốt rule nghiệp vụ khi ticket không nói rõ.
- Không dùng từ mơ hồ ("nhanh", "ổn định", "hợp lý") trong acceptance criteria.
