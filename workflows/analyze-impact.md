# Workflow — analyze-impact

## INPUT
- `requirements.md`, repo (qua MCP), domain data (mcp-domain-core)

## PRECONDITIONS
- Status = `IMPACT_ANALYSIS`
- `repoRoot` đã cấu hình (nếu không: chạy `--no-mcp` và chấp nhận unknowns)

## STEPS
1. `eng agent impact <TASK_ID>` (cần `requirements.md` trong workstream)
2. Agent gọi MCP: `find_references`, `find_callers`, `get_change_context`, `get_service_dependencies`
3. Với policy: `get_policy_dependencies`, `trace_policy_dependency`
4. Kiểm `impact.md` có đủ 10 lớp (service/module/class/DB/API/policy/fact/external/test/regression)
5. `eng advance <TASK_ID> --to DESIGNING`

## OUTPUT
- `impact.md`

## TRANSITION
`IMPACT_ANALYSIS → DESIGNING`

## ON FAILURE
MCP không dùng được ⇒ ghi unknowns rõ ràng; nếu impact không thể kết luận ⇒ giữ status + `eng block`.
