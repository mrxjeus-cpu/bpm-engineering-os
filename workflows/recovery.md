# Workflow — recovery

## INPUT
- Lỗi: log harness, output test, state, diff

## PRECONDITIONS
- Status = `FAILED`/`BLOCKED`, hoặc worker exit ≠ 0, hoặc test fail ≥2 lần

## STEPS
1. Phân loại: COMPILE_ERROR · TEST_FAILURE · MISSING_CONTEXT · MCP_FAILURE ·
   DESIGN_CONFLICT · FILE_CONFLICT · ENVIRONMENT_FAILURE · UNKNOWN
2. Tập hợp recovery context TỐI THIỂU: context task + lỗi + diff liên quan + test fail
3. TEST_FAILURE ⇒ skill `systematic-debugging` (root cause trước khi sửa)
4. MISSING_CONTEXT/MCP_FAILURE ⇒ `eng block <TASK_ID> --reason "..."` (không đoán — INV-06)
5. DESIGN_CONFLICT ⇒ quay lại architecture gate
6. Sửa xong: `eng advance <TASK_ID> --to IMPLEMENTING` và chạy lại wave
7. Ghi nguyên nhân vào `eng patch <TASK_ID> --set ...` / event để lần sau không lặp

## OUTPUT
- Phân loại + root cause + bước tiếp theo; state quay lại đúng nhánh

## TRANSITION
`FAILED → DEBUGGING → IMPLEMENTING` · `REVIEWING/AUDITING/VERIFYING → REWORK_REQUIRED → IMPLEMENTING`

## ON FAILURE
Nếu đã loại trừ hết giả thuyết trong phạm vi task ⇒ `BLOCKED` + câu hỏi cụ thể cho người.
Không restart worker với cùng context cũ.
