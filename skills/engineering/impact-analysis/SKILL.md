---
name: impact-analysis
description: Use when a change may affect code, database, API, or policy beyond the files being edited
phase: [impact]
roles: [impact]
required: true
priority: 2
---

## WHEN
- Thay đổi input/output của policy, DTO, fact, hoặc schema.
- Sửa logic dùng chung nhiều nơi.
- Chưa rõ downstream nào bị ảnh hưởng.

## DO
1. Xác định affected: service · module · class · DB · API · policy · fact · external · test.
2. Dùng MCP để lấy dữ liệu thật thay vì đoán:
   `find_symbol`, `find_references`, `find_callers`, `get_change_context`, `get_service_dependencies`.
3. Với policy: `get_policy_dependencies`, `trace_policy_dependency` để thấy policy nào phụ thuộc.
4. Chỉ ra vùng có nguy cơ regression (nhánh rule cũ, dữ liệu cũ, job/batch, API đang dùng).
5. Ghi rõ phần **chưa** kiểm chứng được (thiếu index, MCP không có dữ liệu).

## MUST OUTPUT
- `impact.md` theo template, có phân loại mức ảnh hưởng.
- Danh sách unknowns (không được để trống nếu có phần chưa kiểm chứng).

## MUST NOT
- Không sửa source code.
- Không kết luận "không ảnh hưởng" khi chưa kiểm ít nhất các caller trực tiếp.
- Không dùng kết quả heuristic (callers từ text search) như sự thật tuyệt đối — nêu rõ độ tin cậy.
