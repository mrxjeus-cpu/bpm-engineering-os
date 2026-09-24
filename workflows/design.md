# Workflow — design

## INPUT
- `requirements.md`, `impact.md`, ràng buộc kiến trúc (repo + workstream)

## PRECONDITIONS
- Status = `DESIGNING`

## STEPS
1. `eng agent architect <TASK_ID>`
2. Bắt buộc có ≥2 phương án + trade-off + phương án bị loại (skill `architecture-review`)
3. Kiểm `architecture.md` có: Problem · Current · Proposed · Alternatives · Decision · Trade-offs ·
   Affected Components · Migration · Testing · Risks · Rollback
4. `eng advance <TASK_ID> --to WAITING_DESIGN_APPROVAL` → hệ thống emit `HumanApprovalRequired`
5. Người có thẩm quyền approve:
   `eng record <TASK_ID> --type HUMAN_APPROVAL --status PASS --gate-id architecture --approver "<tên>" --approved-at <ISO>`
6. `eng advance <TASK_ID> --to PLANNING` (nếu chưa approve sẽ bị chặn — INV-05)

## OUTPUT
- `architecture.md` + evidence `HUMAN_APPROVAL`

## TRANSITION
`DESIGNING → WAITING_DESIGN_APPROVAL → PLANNING`

## ON FAILURE
Chưa approve ⇒ giữ `WAITING_DESIGN_APPROVAL`. Không dùng `--allow-bypass` trừ khi risk LOW có chủ đích.
