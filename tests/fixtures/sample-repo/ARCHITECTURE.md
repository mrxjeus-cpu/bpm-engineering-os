# ARCHITECTURE (fixture)

## Nguyên tắc

- Policy input MUST được map qua `PolicyInputMapper`; không tạo mapper mới khi mapper hiện có đủ dùng.
- MUST NOT xóa hoặc đổi hành vi của nhánh rule hiện có khi task chỉ yêu cầu thêm field.
- Service MUST NOT gọi trực tiếp Core adapter; mọi tương tác Core đi qua `PolicyService`.
- Field mới MUST có test tương ứng trong `src/test/java`.
- Thay đổi schema input của Core bắt buộc cập nhật tài liệu này.
