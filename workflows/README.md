# workflows/ — Phase workflows (đã có đủ 12 file)

Workflow = orchestration mỏng cho **một phase**. Mỗi file **< 200 dòng** (INV-09).

> Anti-pattern bị cấm: file kiểu `execute-phase.md` 1.800 dòng / 85 KB của GSD. Nếu một workflow phình to, tách thành nhiều file nhỏ + một router.

## Danh sách (đã viết — mỗi file có INPUT/PRECONDITIONS/STEPS/OUTPUT/TRANSITION/ON FAILURE)

| File | Phase | Vào | Ra | Gate |
|---|---|---|---|---|
| `translate.md` | translate | raw ticket | `requirements.md`, `open_questions.md`, `assumptions.md` | — |
| `analyze-requirements.md` | requirements | ticket + context | AC + business rules + unknowns | (mode safe) |
| `analyze-impact.md` | impact | requirements + MCP | `impact.md` | (mode safe) |
| `design.md` | architecture | requirements + impact + patterns | `architecture.md` (options A/B/C) | → **architecture gate** |
| `plan.md` | planning | architecture đã approve | `plan.md` (task nhỏ, có AC + verification) | (implementationPlan gate nếu risk cao) |
| `graph.md` | planning | `plan.md` | DAG + waves + conflict check | — |
| `wave.md` | implementation | waves | thứ tự chạy + điều kiện vào wave | — |
| `execute.md` | implementation | context đã compile | code + test + `task-NN-report.md` | → spec/quality review |
| `review.md` | review | diff + evidence | `reviews/*.md` | → audit |
| `audit.md` | audit | diff + requirements + design | `audit.md` | → verify |
| `verify.md` | verification | build/test/scope evidence | kết luận + `DONE` hoặc rework | evidence gate |
| `recovery.md` | any | failure đã phân loại | recovery context + bước tiếp | — |

## Router

`execute.md` không tự ôm hết. Chuỗi router:

```text
prepare → graph → wave → execute → review → finalize → recovery
```

## Contract mỗi workflow

Mỗi workflow là checklist chạy được: các bước ghi thẳng lệnh `eng` tương ứng, nên người và agent đều theo được.

```text
INPUT (artifact/state nào)
PRECONDITIONS (status bắt buộc, gate đã pass chưa)
STEPS (ngắn, có điều kiện dừng)
OUTPUT (artifact + evidence)
TRANSITION (status → status, chỉ khi evidence hợp lệ)
ON FAILURE (phân loại lỗi → recovery.md)
```

Xem spec mục 9 và 15.
