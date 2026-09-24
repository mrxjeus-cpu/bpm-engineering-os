---
name: task-context
description: Use when worker context must be assembled, or when the provided context looks insufficient to do the task safely
phase: [planning, implementation]
roles: [developer, architect]
priority: 2
---

## WHEN
- Chuẩn bị giao việc cho worker agent (cần context tối thiểu).
- Đang làm task nhưng thiếu thông tin để sửa đúng (thiếu file, thiếu symbol, không rõ rule).
- Context quá dài hoặc chứa phần không liên quan.

## DO
1. Xác định task con cụ thể (`TASK-NN`) — không compile context cho cả plan.
2. Sinh context: `eng context <TASK_ID> <TASK-NN>` (thêm `--project` nếu có repo, `--no-mcp` khi offline).
3. Đọc `context/<TASK-NN>.md`: Files · Symbols · Existing Pattern · Business Rules · Constraints · Tests · AC.
4. Nếu mục `Unknowns` không rỗng: báo `BLOCKED` kèm danh sách thiếu — **không** tự bổ sung bằng suy đoán.
5. Nếu context vượt budget: giảm `--max-tokens` hoặc thu hẹp Files trong plan, không cắt AC/constraints.

## MUST OUTPUT
- Context package tối thiểu cho **một** task, có provenance (MCP query nào, git SHA nào).
- Danh sách unknowns (nếu có) để người quyết định xử lý.

## MUST NOT
- Không đưa toàn bộ plan/repo/lịch sử hội thoại cho worker (INV-01).
- Không tự điền business rule còn thiếu — rule phải đến từ `mcp-domain-core` hoặc người có thẩm quyền.
