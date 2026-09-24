---
name: existing-code-first
description: Use when you are about to create a new class, mapper, adapter, helper, or abstraction in an existing codebase
phase: [architecture, implementation]
roles: [architect, developer]
triggers: [tạo mới, thêm class, abstraction, refactor, mapper mới, adapter]
priority: 2
---

## WHEN
- Chuẩn bị tạo class/method/adapter/mapper mới.
- Thấy code hiện tại "chưa đẹp" và định viết lại.
- Cần chọn chỗ đặt logic mới.

## DO
1. Tìm implementation tương tự trước: `find_similar_code`, `find_existing_pattern` (mcp-domain-core), `search_code`.
2. Xem pattern của policy/feature tương tự gần nhất: `get_change_context` trên symbol liên quan.
3. Nếu tái sử dụng được: dùng lại đúng pattern đó, chỉ thêm phần còn thiếu.
4. Nếu không tái sử dụng được: ghi rõ lý do (deviation) + phương án thay thế trong báo cáo.
5. Ưu tiên sửa điểm nhỏ nhất có thể thay vì tạo lớp trung gian mới.

## MUST OUTPUT
- Trong báo cáo: pattern đã tái sử dụng (tên file/class) **hoặc** lý do không tái sử dụng.
- Danh sách file dự kiến sửa, đối chiếu với `### Files` trong context.

## MUST NOT
- Không tạo mapper/adapter/service mới khi đã có cái đủ dùng.
- Không refactor code ngoài scope task (INV-04).
- Không đổi chữ ký method public hoặc contract API nếu task không yêu cầu.
