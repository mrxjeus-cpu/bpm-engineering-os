---
name: audit
description: Use when a change must be assessed for banking safety before verification
phase: [audit]
roles: [auditor]
required: true
priority: 2
---

## WHEN
- Change đã qua review, cần đánh giá an toàn trước khi verify.
- Thay đổi chạm tiền, dữ liệu khách hàng, transaction, hoặc tương thích ngược.

## DO
1. Kiểm requirement coverage: mọi acceptance criteria có bằng chứng tương ứng.
2. Kiểm architecture compliance: có đi lệch quyết định đã approve không.
3. Kiểm thay đổi hành vi ngoài dự kiến: nhánh cũ có bị đổi kết quả không.
4. Kiểm các điểm banking: security · data integrity · backward compatibility · logging ·
   exception handling · transaction boundary · concurrency · performance.
5. Kiểm dữ liệu cũ và hợp đồng đang chạy còn đúng không.
6. Kết luận theo hạng mục, mỗi hạng mục PASS/FAIL/N-A + bằng chứng.

## MUST OUTPUT
- `audit.md`: từng hạng mục + kết luận + bằng chứng; danh sách rủi ro còn lại.

## MUST NOT
- Không sửa code.
- Không kết luận "an toàn" khi chưa kiểm tương thích ngược và dữ liệu cũ.
- Không bỏ qua khác biệt giữa "không thấy lỗi" và "đã kiểm và không có lỗi".
