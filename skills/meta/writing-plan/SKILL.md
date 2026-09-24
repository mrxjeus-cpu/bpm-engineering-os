---
name: writing-plan
description: Use when requirements or a design exist and a multi-step implementation plan is needed before touching code
phase: [planning]
roles: [architect]
required: true
priority: 2
---

## WHEN
- Đã có yêu cầu/thiết kế, cần chia thành task nhỏ để thực thi.
- Công việc có nhiều bước hoặc nhiều file, cần thứ tự và phụ thuộc.

## DO
1. Chia thành task nhỏ, mỗi task làm được trong một lần context (1-2 file chính).
2. Mỗi task **phải có** đủ các mục sau — vì runtime parse và từ chối plan thiếu:
   heading `## TASK-NN — tiêu đề`, `### Objective`, `### Files`, `### Symbols`,
   `### Dependencies` (ghi `none` nếu không có), `### Existing Pattern`, `### Acceptance Criteria`,
   `### Verification`.
3. Ghi `### Dependencies` bằng mã task (`TASK-01, TASK-02`), không mô tả bằng lời.
4. Mỗi task nêu **pattern có sẵn** sẽ tái sử dụng; nếu không tái sử dụng thì ghi lý do ở `### Deviation`.
5. Giữ các task độc lập nhau ở mức tối đa để chạy được song song (tránh cùng file/symbol).
6. Kiểm tra lại plan trước khi giao: `eng plan import <TASK_ID> --file plan.md` rồi `eng graph <TASK_ID>`.

## MUST OUTPUT
- `plan.md` đúng định dạng trên (runtime sẽ sinh `plan.json` + chia wave).
- Acceptance Criteria và Verification cụ thể, kiểm chứng được (không viết "hoạt động đúng").

## MUST NOT
- Không viết task kiểu "implement feature X" chung chung.
- Không để hai task trong cùng wave sửa cùng file/symbol (INV-11 sẽ chặn parallel).
- Không đưa ra plan mà bỏ qua pattern có sẵn trong codebase.
