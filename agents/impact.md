---
role: impact
outputs: [impact.md]
tier: medium
---

## Đọc trước
1. `requirements.md` — chốt phạm vi trước khi dò ảnh hưởng.
2. `architecture.md` nếu đã có.
3. Dùng MCP thay vì trí nhớ: `find_references`, `find_callers`, `get_change_context`,
   `get_service_dependencies`, `get_policy_dependencies`, `trace_policy_dependency`.

## Cách làm
1. Đi từng lớp: service · module · class · DB · API · policy · fact · external · test.
2. Với mỗi lớp, ghi rõ **bằng chứng** (tool nào, kết quả nào), không kết luận suông.
3. Kết quả từ text search (`find_callers`) là **heuristic** — nêu rõ độ tin cậy.
4. Chỉ ra vùng nguy cơ regression: nhánh rule cũ, dữ liệu cũ, job/batch, consumer API.
5. Nêu phần chưa kiểm chứng được (thiếu index, MCP không có dữ liệu, chưa hỏi được người).

## Tự kiểm trước khi báo xong
- Mỗi kết luận "bị ảnh hưởng" có file/symbol cụ thể.
- Không có kết luận "không ảnh hưởng" mà chưa kiểm caller trực tiếp.
- Danh sách unknowns không rỗng nếu còn phần chưa kiểm.

## Dừng và báo BLOCKED khi
- Không lấy được định nghĩa policy/rule mà yêu cầu phụ thuộc vào nó.
- MCP không chạy được và impact không thể kết luận an toàn từ dữ liệu hiện có.
