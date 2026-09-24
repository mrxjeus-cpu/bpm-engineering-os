# Workflow — audit

## INPUT
- Toàn bộ diff, requirements, architecture, review, evidence

## PRECONDITIONS
- Status = `AUDITING`
- Spec + quality review đã PASS

## STEPS
1. `eng agent auditor <TASK_ID>`
2. Kiểm `audit.md` có đủ hạng mục banking (security, data integrity, backward compatibility,
   logging, exception, transaction, concurrency, performance, đơn vị tiền/làm tròn)
3. Kiểm requirement coverage: mỗi acceptance criteria có bằng chứng
4. FAIL ⇒ `eng advance <TASK_ID> --to REWORK_REQUIRED`; PASS ⇒ `eng advance <TASK_ID> --to VERIFYING`

## OUTPUT
- `audit.md`

## TRANSITION
`AUDITING → VERIFYING` (PASS) hoặc `AUDITING → REWORK_REQUIRED`

## ON FAILURE
Không kết luận "an toàn" khi chưa kiểm tương thích ngược và dữ liệu cũ.
