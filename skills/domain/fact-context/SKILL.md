---
name: fact-context
description: Use when a task touches CustomerFact, LoanFact, or CICFact fields
phase: [impact, implementation]
roles: [impact, developer]
triggers: [fact, customerfact, loanfact, cicfact, cic, thu nhập, purposeofloan]
priority: 1
---

## WHEN
- Thêm/đổi field trong fact hoặc builder/mapper của fact.
- Rule mới cần dữ liệu chưa có trong fact hiện tại.
- Cần biết field nào bắt buộc và nguồn dữ liệu từ đâu.

## DO
1. Lấy schema field thật: `find_customer_facts`, `find_loan_facts`, `find_cic_facts` (mcp-domain-core).
2. Kiểm field đã tồn tại chưa trước khi thêm mới (tránh trùng nghĩa).
3. Xác định nguồn: Core/CIF, APPL/BPM, hay tích hợp ngoài (CIC) — và field nào bắt buộc.
4. Kiểm ảnh hưởng: policy nào dùng fact này (`usedByPolicies`), builder/mapper nào cần cập nhật.
5. Với dữ liệu cũ: field mới phải có giá trị mặc định/nullable hoặc có kế hoạch backfill rõ ràng.

## MUST OUTPUT
- Bảng field: tên · kiểu · bắt buộc · nguồn · policy dùng.
- Danh sách file cần sửa (fact, builder/mapper, test).

## MUST NOT
- Không thêm field trùng nghĩa với field đã có.
- Không đặt field bắt buộc cho dữ liệu cũ mà không có phương án backfill.
- Không suy diễn tên field/kiểu khi MCP không trả về.
