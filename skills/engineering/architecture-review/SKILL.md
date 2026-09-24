---
name: architecture-review
description: Use when a change needs a design decision or touches architecture constraints
phase: [architecture]
roles: [architect]
required: true
priority: 2
---

## WHEN
- Cần chọn cách triển khai giữa nhiều phương án.
- Thay đổi chạm ràng buộc kiến trúc, contract giữa service, hoặc dữ liệu dùng chung.
- Có yêu cầu phi chức năng (hiệu năng, tương thích ngược, bảo mật).

## DO
1. Đọc ràng buộc thật: `get_architecture_constraints` (repo) + `constraints` trong context.
2. Mô tả hiện trạng (Current) trước khi đề xuất (Proposed).
3. Đưa ít nhất 2 phương án kèm trade-off; nêu phương án bị loại và **lý do loại**.
4. Chốt một quyết định, ghi rõ hệ quả và điều kiện đảo ngược (rollback).
5. Nêu ảnh hưởng migration dữ liệu, thứ tự triển khai, và tương thích ngược.
6. Nếu quyết định ảnh hưởng nghiệp vụ: đánh dấu cần người approve (INV-05).

## MUST OUTPUT
- `architecture.md`: Problem · Current · Proposed · Alternatives · Decision · Trade-offs · Affected Components · Migration · Testing · Risks · Rollback.

## MUST NOT
- Không viết code.
- Không đưa ra duy nhất một phương án mà không so sánh.
- Không tự approve thiết kế của chính mình — human gate quyết định.
