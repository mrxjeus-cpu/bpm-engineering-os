# Workflow — review

## INPUT
- Diff của task, `context/TASK-NN.md`, `tasks/TASK-NN-report.md`, evidence

## PRECONDITIONS
- Status = `REVIEWING`
- Có evidence TEST PASS + SCOPE_VALIDATION PASS

## STEPS
1. `eng agent reviewer <TASK_ID> <TASK-NN>` — 2 tầng: spec compliance + code quality
2. Kiểm `reviews/TASK-NN-spec.md` (bắt buộc) và `reviews/TASK-NN-quality.md`
3. Đọc evidence do producer tạo — reviewer KHÔNG tự claim đã chạy test
4. FAIL ⇒ ghi issue BLOCKER/MAJOR, `eng advance <TASK_ID> --to REWORK_REQUIRED`
5. PASS ⇒ `eng advance <TASK_ID> --to AUDITING`

## OUTPUT
- `reviews/*.md`

## TRANSITION
`REVIEWING → AUDITING` (PASS) hoặc `REVIEWING → REWORK_REQUIRED` (FAIL)

## ON FAILURE
Thiếu evidence để kết luận ⇒ review trả BLOCKED, không đoán.
