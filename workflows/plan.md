# Workflow — plan

## INPUT
- `architecture.md` (đã approve)

## PRECONDITIONS
- Status = `PLANNING`
- `approvals.architecture = true`

## STEPS
1. Viết `plan.md` theo skill `writing-plan` (mỗi task đủ heading bắt buộc)
2. `eng plan import <TASK_ID> --file plan.md` — parser sẽ từ chối nếu thiếu Objective/AC/Verification
3. `eng graph <TASK_ID>` — xem wave + conflict check (INV-11)
4. Nếu có FILE_OVERLAP/SYMBOL_OVERLAP: sửa plan cho tách phạm vi, hoặc chấp nhận chạy tuần tự
5. `eng advance <TASK_ID> --to READY_TO_IMPLEMENT`

## OUTPUT
- `plan.md` + `plan.json` (kèm waves)

## TRANSITION
`PLANNING → (WAITING_PLAN_APPROVAL) → READY_TO_IMPLEMENT`

## ON FAILURE
Parser báo lỗi kèm task + số dòng ⇒ sửa plan rồi import lại. Plan có cycle ⇒ không thực thi được.
