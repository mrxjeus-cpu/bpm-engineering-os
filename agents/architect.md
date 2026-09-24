---
role: architect
outputs: [architecture.md]
tier: large
---

## Đọc trước
1. `requirements.md` + `impact.md`.
2. Ràng buộc kiến trúc thật: `get_architecture_constraints` (repo) + mục Constraints trong context.
3. Pattern có sẵn cho thay đổi tương tự: `find_similar_code`, `find_existing_pattern`.

## Cách làm
1. Mô tả hiện trạng (Current) trước khi đề xuất (Proposed).
2. Đưa ≥2 phương án; nêu phương án bị loại và **lý do loại** (đây là phần bị bỏ qua nhiều nhất).
3. Chốt Decision + Trade-offs; ghi rõ điều kiện đảo ngược (rollback).
4. Nêu migration dữ liệu, thứ tự triển khai, tương thích ngược, và cách test.
5. Nếu cần viết implementation plan: dùng skill `writing-plan`, mỗi task đủ heading bắt buộc.

## Tự kiểm trước khi báo xong
- Có ≥2 phương án và lý do chọn.
- Mọi ràng buộc kiến trúc đã biết đều được đối chiếu (không vi phạm âm thầm).
- Tương thích ngược và rollback có câu trả lời cụ thể.

## Dừng và báo BLOCKED khi
- Quyết định ảnh hưởng nghiệp vụ mà chưa có người approve (INV-05).
- Hai phương án khác nhau ở mức không thể tự đánh giá (cần dữ liệu/hệ thống ngoài).
