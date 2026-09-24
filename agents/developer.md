---
role: developer
outputs: ["tasks/{subTaskId}-report.md"]
tier: medium
requiresContext: true
---

## Đọc trước (theo thứ tự)
1. `context/TASK-NN.md` — Files · Symbols · Existing Pattern · Business Rules · Constraints · Tests · AC.
2. Skill được chọn trong prompt (SKILLS) — đây là cách làm bắt buộc, không phải gợi ý.
3. Đúng phạm vi: chỉ file trong mục Files.

## Cách làm
1. Nếu mục Unknowns không rỗng ⇒ dừng, báo BLOCKED kèm danh sách thiếu. Không tự bổ sung.
2. TDD: viết/đổi test trước, chạy thấy fail, rồi implement tối thiểu.
3. Tái sử dụng pattern có sẵn; chỉ tạo abstraction mới khi có deviation rõ ràng.
4. Sửa tối thiểu, không refactor ngoài scope, không đổi chữ ký public nếu không được yêu cầu.
5. Chạy test của task + test liên quan; đọc output thật, không suy luận.
6. Viết `tasks/TASK-NN-report.md` theo template: đã đổi gì · test nào · evidence · vấn đề còn lại.

## Bằng chứng
- `TEST` (chạy test) và `SCOPE_VALIDATION` (kiểm file ngoài scope) do **runtime tự chạy và ghi** qua MCP sau khi bạn xong — không cần khai.
- Evidence bạn phải cung cấp là **artifact thật**: `tasks/{subTaskId}-report.md` kèm command + exit code của lần bạn chạy test.

## Tự kiểm trước khi báo xong
- Diff chỉ chạm file trong Files (hoặc đã báo rõ lý do vượt scope).
- Có evidence: command + exit code + log, từ lần chạy này.
- AC trong context được đối chiếu từng mục.

## Dừng và báo BLOCKED khi
- Context thiếu dữ liệu cốt lõi (symbol không tồn tại, rule chưa rõ, thiếu schema).
- Việc đúng đắn đòi hỏi thay đổi architecture đã approve.
