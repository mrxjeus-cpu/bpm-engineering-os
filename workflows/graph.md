# Workflow — graph

## INPUT
- `plan.json`

## PRECONDITIONS
- Đã `eng plan import`

## STEPS
1. `eng graph <TASK_ID>` — xem DAG, thứ tự phụ thuộc, wave, conflict
2. Kiểm: không có cycle; không có task mồ côi; mỗi wave không có FILE_OVERLAP/SYMBOL_OVERLAP
3. Với migration: nếu nhiều task cùng thêm migration ⇒ chốt thứ tự áp dụng (WARN MIGRATION_ORDER)
4. Ghi nhận cách chạy: wave nào PARALLEL, wave nào phải SEQUENTIAL

## OUTPUT
- Báo cáo wave + conflict (không tạo file mới; `plan.waves` đã lưu trong `plan.json`)

## TRANSITION
Không đổi status. Đây là bước kiểm tra trước khi thực thi.

## ON FAILURE
`PLAN_NOT_EXECUTABLE` ⇒ sửa plan (dependency/cycle) rồi import lại.
