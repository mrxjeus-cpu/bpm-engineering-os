# GLOBAL rules — BPM Engineering OS

> Đây là tầng **GLOBAL** của context hierarchy (spec mục 7.1). Giữ file này ngắn — mọi dòng ở đây tốn token ở **mọi** session. Chi tiết đầy đủ nằm trong `SPEC-bpm-engineering-os.md`.

## 1. Bất biến (không được vi phạm)

1. **INV-01** Worker agent không nhận toàn bộ conversation / repo / `.engineering/` / lịch sử agent. Chỉ nhận `context/task-NN.md`.
2. **INV-02** State sống ngoài LLM context, machine-readable, file-based. Conversation không phải source of truth.
3. **INV-03** Không transition trạng thái nếu thiếu evidence tương ứng (RULES-001).
4. **INV-04** Không xóa/đổi business logic ngoài scope task. Mọi deletion phải nằm trong allowlist.
5. **INV-05** Architecture phải qua human gate trước implementation (trừ mode hạ rủi ro có cấu hình).
   Bypass chỉ khi `config/gates.yaml` cho phép (vd `bypassIfRiskAtMost: LOW` + cờ `--allow-bypass`) và **phải ghi vết**
   vào `task.json → gateBypasses` (gateId → lý do) + event `HumanGateBypassed`; không được lẫn với người duyệt thật.
6. **INV-06** MCP không available ⇒ `BLOCKED`. **Không** tự suy diễn/bịa domain data.
7. **INV-07** Không hard-code một LLM provider hay một agent frontend.
8. **INV-08** Business logic BPM không nằm trong orchestration runtime.
9. **INV-09** Workflow < 200 dòng, skill < 300 dòng. Không viết file khổng lồ.
10. **INV-10** Chỉ expose skill/MCP toolset liên quan phase hiện tại.
11. **INV-11** Parallel chỉ khi `conflict_check = PASS` (file, interface, DB migration, quyết định kiến trúc).
12. **INV-12** Evidence phải có provenance: `command`, `cwd`, `exitCode`, `gitSha`, `artifact`, `producer`.

## 2. Safety — môi trường ngân hàng

- Không push, không rewrite, không force-push lên branch dùng chung (`main`, `dev`, `production`, `release/*`). Chỉ làm việc trên feature branch.
- Không chạy migration/DDL trên môi trường thật.
- Không tự approve kiến trúc; không tự tuyên bố "done" khi chưa có evidence mới.
- Không đưa dữ liệu khách hàng thật vào test/fixture/commit. Dataset trong repo này là **synthetic**.

## 3. Quy tắc code (repo này)

- TypeScript ESM (`"type": "module"`, `module: NodeNext`) — import tương đối phải có đuôi `.js`.
- Không thêm dependency mới nếu chưa cần; ưu tiên code đơn giản hơn abstraction.
- Mọi component runtime phải test được độc lập qua interface.
- MCP tool phải trả kết quả: nhỏ, có cấu trúc, có ID, có `source`/reference, có `confidence` nếu là semantic search, có phân trang khi cần.
- MCP tool **không** nhận command thực thi từ input; command lấy từ allowlist trong `config/projects.yaml`.
- Mọi thay đổi phải giữ `npm run build` và `npm test` xanh.

## 4. Cách viết skill

```markdown
---
name: <kebab-case>
description: Use when <điều kiện kích hoạt>   # chỉ WHEN — KHÔNG mô tả workflow
---
## WHEN   ## DO   ## MUST OUTPUT   ## MUST NOT
```

Lý do: nếu description tóm tắt workflow, agent có xu hướng đi theo description thay vì đọc skill.

## 5. Trước khi kết thúc task

- Chạy verification thật (build/test), đọc output, kiểm exit code.
- Ghi evidence kèm provenance; không claim thành công từ lời của agent khác.
- Nếu thiếu context hoặc MCP lỗi ⇒ báo `BLOCKED` kèm lý do cụ thể, không đoán.
