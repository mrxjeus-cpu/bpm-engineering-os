# Workflow — wave

## INPUT
- `plan.json` + state task

## PRECONDITIONS
- Status = `IMPLEMENTING`
- Đã compile context cho các task trong wave (`eng context <TASK_ID> --all`)

## STEPS
1. `eng wave <TASK_ID>` — xem wave kế tiếp + mode (PARALLEL/SEQUENTIAL)
2. `eng wave <TASK_ID> --start <N>` — đánh dấu task IN_PROGRESS, ghi `currentWave`
3. Chạy worker: `eng wave <TASK_ID> --start <N> --run --harness <NAME>`
   (Phase 1 chạy tuần tự trong wave; parallel thật chưa implement)
4. Mỗi task xong: `eng subtask <TASK_ID> <TASK-NN> --status DONE`
5. Wave sau chỉ chạy khi wave trước không còn task pending

## OUTPUT
- Code + `tasks/TASK-NN-report.md` cho từng task; state `currentWave/currentTasks/completedTasks`

## TRANSITION
Không đổi status chính; tiến độ nằm ở plan + state.

## ON FAILURE
Worker fail (exit ≠ 0) ⇒ dừng wave, chuyển skill `recovery`; không chạy tiếp task sau trên nền hỏng.
