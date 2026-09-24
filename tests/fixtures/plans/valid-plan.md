# Implementation Plan — TASK-49043

Thêm Purpose of Loan vào policy input của DOMAIN nhà đất.

## TASK-01 — Thêm enum PurposeOfLoan

### Objective
Bổ sung enum PurposeOfLoan với các value nghiệp vụ, không đổi enum hiện có.

### Files
- src/main/java/vn/bpm/domain/policy/PurposeOfLoan.java
- src/main/java/vn/bpm/domain/policy/PolicyInputMapper.java
- src/test/java/vn/bpm/domain/policy/PurposeOfLoanTest.java

### Symbols
- PurposeOfLoan
- PolicyInputMapper

### Dependencies
none

### Existing Pattern
Enum LoanPurpose hiện có, map qua PolicyInputMapper.

### Acceptance Criteria
- Có value FURNITURE và REPAIR_NO_STRUCTURE_CHANGE
- Enum cũ vẫn giữ nguyên thứ tự và giá trị
- Test mapping enum pass

### Verification
- PolicyInputMapperTest
- ./mvnw test -Dtest=PurposeOfLoanTest

## TASK-02 — Map purposeOfLoan vào PolicyInput

### Objective
Thêm field purposeOfLoan vào PolicyInput và map từ LoanFact.

### Files
- src/main/java/vn/bpm/domain/policy/PolicyInput.java
- src/main/java/vn/bpm/domain/policy/PolicyInputMapper.java

### Symbols
- PolicyInput
- PolicyInputMapper

### Dependencies
- TASK-01

### Existing Pattern
PolicyInputMapper.map() hiện có — thêm field theo đúng pattern cũ.

### Acceptance Criteria
- PolicyInput có getter/setter purposeOfLoan
- Mapper copy đúng giá trị từ LoanFact
- Không đổi chữ ký method hiện có

### Verification
- PolicyInputMapperTest
- ./mvnw test -Dtest=PolicyInputMapperTest

## TASK-03 — Nhánh rule TD1/TD2 cho mục đích vay

### Objective
Cập nhật nhánh điều kiện policy theo bảng TD1/TD2 nhưng không đổi hành vi các nhánh khác.

### Files
- src/main/java/vn/bpm/domain/policy/PolicyService.java

### Symbols
- PolicyService.checkPolicy

### Dependencies
- TASK-01, TASK-02

### Existing Pattern
Nhánh if theo purpose hiện có trong PolicyService.checkPolicy.

### Business Rules
- TD1: mục đích sửa chữa không đổi kết cấu HOẶC mua sắm nội thất ⇒ ELIGIBLE
- TD2: mục đích khác ⇒ REFER

### Constraints
- Không xóa nhánh cũ
- Giữ backward compatibility cho dữ liệu hồ sơ cũ

### Acceptance Criteria
- TD1 trả ELIGIBLE cho cả hai nhánh (sửa chữa không kết cấu, nội thất)
- TD2 trả REFER
- Các nhánh hiện có vẫn pass toàn bộ test cũ

### Verification
- PolicyServiceTest
- Kiểm tra diff không có nhánh bị xóa

## TASK-04 — Migration cột purpose_code

### Objective
Thêm cột nullable purpose_code để lưu mã mục đích vay cho hồ sơ mới.

### Files
- src/main/resources/db/migration/V2026_09_24__add_purpose_code.sql
- src/main/java/vn/bpm/domain/entity/LoanApplication.java

### Symbols
- LoanApplication

### Dependencies
none

### Acceptance Criteria
- Cột nullable, không ảnh hưởng dữ liệu cũ
- Entity map được cột mới

### Verification
- Migration chạy trên schema test
- LoanApplicationTest

## TASK-05 — Integration test cho luồng mục đích vay

### Objective
Thêm integration test end-to-end cho luồng thêm mục đích vay.

### Files
- src/test/java/vn/bpm/domain/policy/PurposeOfLoanIT.java

### Dependencies
- TASK-03

### Existing Pattern
PolicyInputMapperIT hiện có.

### Acceptance Criteria
- Test chạy được end-to-end từ LoanFact tới quyết định policy
- Bao phủ cả TD1 và TD2

### Verification
- ./mvnw verify -Dit.test=PurposeOfLoanIT

## TASK-06 — Migration index cho purpose_code

### Objective
Thêm index cho cột purpose_code phục vụ tra cứu.

### Files
- src/main/resources/db/migration/V2026_09_24__index_purpose_code.sql
- src/main/java/vn/bpm/domain/entity/LoanApplication.java

### Symbols
- LoanApplication

### Dependencies
none

### Acceptance Criteria
- Index tạo được trên schema test
- Không khóa bảng quá lâu

### Verification
- Kiểm tra explain plan dùng index
