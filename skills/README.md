# skills/ — Skill catalog

Skill = **HOW**. Skill không chứa data (data thuộc MCP). Vi phạm INV-09 (thân skill < 300 dòng) bị `eng skills` báo lỗi.

## Cách runtime dùng skill (progressive disclosure)

Skill **không** được nạp hết vào prompt. `AgentRunner` chạy **skill router** (`runtime/src/skills/router.ts`) theo dữ liệu khai báo trong front-matter:

```text
role khớp (+3)  ·  phase khớp (+3)  ·  trigger trong objective (+2 mỗi cái)  ·  WHEN gần objective (+1)
→ skill `required: true` khớp role/phase được chọn TRƯỚC
→ phần còn lại chọn theo điểm, cắt theo config/mcp.yaml → limits.context (maxSkills, maxSkillTokens)
```

Xem trước router sẽ chọn gì:

```bash
npm run eng -- skills                                              # kiểm tra + liệt kê catalog
npm run eng -- skills show verification                            # nội dung một skill
npm run eng -- skills route developer --phase implementation --objective "Thêm field X vào policy"
npm run eng -- agent developer <TASK_ID> <TASK-NN> --dry-run       # prompt thật, có section SKILLS
npm run eng -- agent developer <TASK_ID> <TASK-NN> --dry-run --no-skills   # so sánh khi bỏ skill
```

## Định dạng bắt buộc

```markdown
---
name: <kebab-case, khớp tên thư mục>
description: Use when <điều kiện kích hoạt>     # CHỈ WHEN — mô tả workflow là lỗi
phase: [implementation, review]                 # router dùng để chọn
roles: [developer, reviewer]                    # router dùng để chọn
required: true                                  # luật bắt buộc: chọn trước, không bị cắt vì hết slot
priority: 3                                     # tie-break khi cùng điểm
triggers: [policy, TD]                          # từ khoá trong objective
---

## WHEN
## DO
## MUST OUTPUT
## MUST NOT
```

`eng skills` kiểm tra: front-matter đủ field · `name` khớp thư mục · description bắt đầu bằng `Use when` và **không** mô tả workflow (`then`, `→`, `step N`) · đủ 4 section · độ dài.

`required: true` chỉ có nghĩa với role/phase mà chính skill khai báo — nếu router phải cắt skill bắt buộc vì hết budget, nó **cảnh báo rõ tên skill**, không im lặng.

## Catalog hiện có (17 skill)

| Nhóm | Skill | Vai trò chính |
|---|---|---|
| `meta` | `brainstorming`, `writing-plan`, `tdd`, `systematic-debugging`, `verification` | Kỷ luật quy trình (TDD, verification-before-completion, debug có root cause) |
| `engineering` | `requirements-analysis`, `impact-analysis`, `architecture-review`, `implementation`, `code-review`, `audit`, `task-context`, `existing-code-first`, `recovery` | Vòng đời kỹ thuật + anti-hallucination cho legacy |
| `domain` | `policy-analysis`, `fact-context`, `policy-core` | Domain DOMAIN — **chỉ quy trình**, định nghĩa rule luôn lấy từ `mcp-domain-core` (INV-08) |

Skill bắt buộc (`required: true`): `verification` · `tdd` · `implementation` · `requirements-analysis` · `impact-analysis` · `architecture-review` · `writing-plan` · `code-review` · `audit`.

## Còn thiếu (cần người có domain knowledge điền)

- `domain/pre-screening`, `domain/full-processing` — cần quy trình thật của DOMAIN; hiện `policy-analysis` + `policy-core` đã phủ phần chung.
- Skill mới nên được viết theo TDD cho skill: mô tả **pressure scenario** mà agent fail khi chưa có skill, rồi kiểm tra agent pass sau khi có (xem `tests/` cho ví dụ regression).

Xem thêm: spec mục 6.2, 10 và `workflows/` (mỗi phase một file).
