---
name: policy-analysis
description: Use when a requirement changes policy input, eligibility rule, or policy output
phase: [impact, architecture, implementation]
roles: [impact, architect, developer]
triggers: [policy, rule, TD, điều kiện, eligibility, domain]
priority: 1
---

## WHEN
- Thêm/đổi input của policy (field fact, mục đích vay, tài sản bảo đảm...).
- Đổi điều kiện xét duyệt hoặc kết quả policy.
- Cần biết policy nào bị ảnh hưởng bởi một thay đổi.

## DO
1. Lấy định nghĩa policy từ `mcp-domain-core` (KHÔNG dùng trí nhớ):
   `find_policy` → `get_policy` → `get_policy_inputs` → `get_policy_rules` (từng rule cụ thể).
2. Xác định input/output: `get_policy_inputs`, `get_core_input_schema`, `get_core_output_schema`.
3. Dò ảnh hưởng lan truyền: `get_policy_dependencies`, `trace_policy_dependency`.
4. Đối chiếu rule hiện có với yêu cầu: rule nào giữ nguyên, rule nào đổi, rule nào thêm mới.
5. Kiểm nhánh cũ có đổi kết quả không (đây là nguồn regression chính trong policy).
6. Nếu định nghĩa policy không lấy được ⇒ `BLOCKED`, không suy diễn điều kiện.

## MUST OUTPUT
- Danh sách policy/rule liên quan kèm `source` (id rule + nguồn dữ liệu).
- Phân biệt rõ: rule đã có · rule cần sửa · rule chưa xác định được.

## MUST NOT
- Không tự viết lại điều kiện nghiệp vụ theo trí nhớ của model.
- Không sửa policy ngoài phạm vi yêu cầu.
- Không đổi thứ tự/ý nghĩa rule cũ nếu yêu cầu không nói tới.
