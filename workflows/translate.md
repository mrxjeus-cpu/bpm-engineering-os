# Workflow — translate

## INPUT
- Ticket thô (Jira/email/chat) do người dùng dán vào `ticket.md` hoặc đưa trực tiếp.

## PRECONDITIONS
- Workstream tồn tại: `eng new <TASK_ID> --title "..." --risk <LEVEL>`
- Status = `NEW`

## STEPS
1. `eng advance <TASK_ID> --to TRANSLATING`
2. `eng agent researcher <TASK_ID>` (hoặc `--dry-run` để đọc prompt trước)
3. Kiểm artifact: `requirements.md` phải tồn tại (runtime tự kiểm sau khi chạy)
4. Nếu còn câu hỏi mở: giữ ở `open_questions.md`, không tự chốt
5. `eng advance <TASK_ID> --to REQUIREMENT_ANALYSIS`

## OUTPUT
- `requirements.md`, `open_questions.md`, `assumptions.md`

## TRANSITION
`NEW → TRANSLATING → REQUIREMENT_ANALYSIS`

## ON FAILURE
Thiếu artifact ⇒ coi như chưa xong: đọc `tasks/researcher-*.log`, sửa prompt/context rồi chạy lại.
