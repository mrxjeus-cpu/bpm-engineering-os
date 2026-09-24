---
name: recovery
description: Use when a worker failed, tests fail repeatedly, or the task is blocked or looping
phase: [implementation, review, audit, verification]
roles: [developer, reviewer, auditor]
triggers: [fail, failed, blocked, lỗi, không qua, treo, lặp]
priority: 0
---

## WHEN
- Worker trả exit code khác 0 hoặc thiếu artifact bắt buộc.
- Test vẫn fail sau 2 lần sửa.
- Task bị `BLOCKED` (thiếu context, MCP không dùng được, chờ quyết định).

## DO
1. Phân loại lỗi trước khi sửa: COMPILE_ERROR · TEST_FAILURE · MISSING_CONTEXT ·
   MCP_FAILURE · DESIGN_CONFLICT · FILE_CONFLICT · ENVIRONMENT_FAILURE · UNKNOWN.
2. Chỉ đưa vào recovery context phần tối thiểu: context của task + lỗi + diff liên quan + test fail.
3. Với MISSING_CONTEXT / MCP_FAILURE: giữ `BLOCKED`, ghi rõ thiếu gì; **không** đoán (INV-06).
4. Với TEST_FAILURE: chuyển sang skill `systematic-debugging`, tìm root cause trước khi sửa.
5. Với DESIGN_CONFLICT: quay lại architecture gate, không tự đổi thiết kế.
6. Ghi lại nguyên nhân + cách xử lý vào event/history để lần sau không lặp lại.

## MUST OUTPUT
- Phân loại lỗi + nguyên nhân gốc (hoặc giả thuyết đã loại trừ).
- Bước tiếp theo cụ thể (retry / debug / xin quyết định / dừng).

## MUST NOT
- Không restart worker mù quáng với cùng context cũ.
- Không "sửa cho qua" bằng cách nới test, bọc try/catch, hoặc tắt kiểm tra.
- Không đánh dấu task DONE để thoát khỏi trạng thái lỗi.
