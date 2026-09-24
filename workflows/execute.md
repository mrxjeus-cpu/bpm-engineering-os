# Workflow — execute (router)

## INPUT
- State + `plan.json` + `context/*`

## PRECONDITIONS
- Status = `IMPLEMENTING`; wave đã xác định

## STEPS
Chuỗi router (mỗi bước là một file riêng, không gộp thành một workflow khổng lồ):
1. `prepare` — kiểm state, `eng resume <TASK_ID>`, context đã compile
2. `graph` — `eng graph <TASK_ID>` (wave + conflict)
3. `wave` — `eng wave <TASK_ID> --start N --run`
4. `review` — `eng agent reviewer <TASK_ID> <TASK-NN>` sau mỗi task
5. `finalize` — tổng hợp, `eng subtask ... --status DONE`
6. `recovery` — khi có lỗi (xem `recovery.md`)

## OUTPUT
- Code + report theo task; evidence TEST + SCOPE_VALIDATION để mở gate REVIEWING

## TRANSITION
`IMPLEMENTING → REVIEWING` chỉ khi có evidence TEST + SCOPE_VALIDATION (INV-03)

## ON FAILURE
Xem `recovery.md`. Không tự đánh dấu DONE để thoát trạng thái lỗi.
