# Workflow — verify

## INPUT
- Evidence: BUILD, TEST, SCOPE_VALIDATION, AUDIT

## PRECONDITIONS
- Status = `VERIFYING`
- Tất cả wave/task đã DONE; context + review đầy đủ

## STEPS
1. Chạy build thật: `run_build` (MCP) hoặc `eng record` evidence BUILD với command + exit code
2. Chạy test đầy đủ; ghi evidence TEST
3. `validate_scope` để xác nhận không có file ngoài scope (INV-04)
4. Đối chiếu acceptance criteria với evidence từng mục
5. `eng advance <TASK_ID> --to DONE` — chỉ pass khi evidence gate đủ (INV-03)
6. Risk CRITICAL: cần thêm `HUMAN_APPROVAL --gate-id finalVerification`
7. `eng events <TASK_ID>` để xác nhận chuỗi lifecycle event đầy đủ

## OUTPUT
- Chuỗi evidence đầy đủ + `DONE`

## TRANSITION
`VERIFYING → DONE` (hoặc `→ REWORK_REQUIRED`)

## ON FAILURE
Thiếu evidence ⇒ `EVIDENCE_REQUIRED` kèm danh sách thiếu; chạy lại phần còn thiếu, không nới gate.
