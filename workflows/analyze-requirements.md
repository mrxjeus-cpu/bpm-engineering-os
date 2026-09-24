# Workflow — analyze-requirements

## INPUT
- `requirements.md` + `open_questions.md`

## PRECONDITIONS
- Status = `REQUIREMENT_ANALYSIS`
- Mọi câu hỏi blocking đã được trả lời (nếu chưa: `eng block`)

## STEPS
1. Rà acceptance criteria: kiểm chứng được? có số liệu/điều kiện?
2. Rà business rule: rule nào đến từ đâu; rule nào chưa có nguồn ⇒ mở lại câu hỏi
3. Chốt phạm vi KHÔNG làm để tránh trượt scope
4. Cập nhật `requirements.md` (người hoặc agent), rồi `eng advance <TASK_ID> --to IMPACT_ANALYSIS`

## OUTPUT
- `requirements.md` bản chốt + unknowns còn lại

## TRANSITION
`REQUIREMENT_ANALYSIS → IMPACT_ANALYSIS`

## ON FAILURE
Thiếu rule/quyết định nghiệp vụ ⇒ `eng block <TASK_ID> --reason "..."` (không đoán — INV-06).
