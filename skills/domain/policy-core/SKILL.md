---
name: policy-core
description: Use when policy output must be mapped to the Core adapter contract
phase: [architecture, implementation]
roles: [architect, developer]
triggers: [core, adapter, t24, output schema, input schema]
priority: 1
---

## WHEN
- Thay đổi input/output của policy ảnh hưởng payload gửi Core.
- Cần biết adapter nào đang dùng và contract ra sao.
- Có thay đổi kiểu dữ liệu, đơn vị tiền, làm tròn, hoặc enum gửi Core.

## DO
1. Lấy contract thật: `get_core_adapter`, `get_core_input_schema`, `get_core_output_schema`.
2. So sánh contract hiện tại với thay đổi đề xuất: field nào thêm/đổi/bỏ.
3. Kiểm tính tương thích ngược: Core cũ có chấp nhận payload mới không.
4. Kiểm đơn vị/làm tròn/định dạng ngày và enum trước khi gửi.
5. Xác nhận adapter nào dùng chung cho nhiều policy (thay đổi có thể ảnh hưởng policy khác).

## MUST OUTPUT
- Contract trước/sau + danh sách policy dùng cùng adapter.
- Đánh giá tương thích ngược và phương án rollback.

## MUST NOT
- Không đổi contract Core khi chưa xác nhận với phía tích hợp.
- Không đổi cách làm tròn/đơn vị tiền ngoài yêu cầu — đây là thay đổi nghiệp vụ nhạy cảm.
- Không suy diễn schema Core từ code phía client.
