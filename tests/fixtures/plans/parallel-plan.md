# Implementation plan — hai task độc lập (dùng cho test chạy song song)

## TASK-01 — Thêm field purposeOfLoan vào PolicyInput

### Objective
Thêm field purposeOfLoan và map từ LoanFact.

### Files
- src/main/java/vn/bpm/domain/policy/PolicyInput.java

### Symbols
- PolicyInput

### Dependencies
none

### Existing Pattern
PolicyInputMapper hiện có.

### Acceptance Criteria
- PolicyInput có field purposeOfLoan

### Verification
- PolicyInputMapperTest

## TASK-02 — Thêm test cho nhánh TD2

### Objective
Thêm test cho nhánh TD2 của policy.

### Files
- src/test/java/vn/bpm/domain/policy/PolicyServiceTd2Test.java

### Symbols
- PolicyServiceTest

### Dependencies
none

### Existing Pattern
PolicyInputMapperTest hiện có.

### Acceptance Criteria
- Có test cho nhánh TD2

### Verification
- PolicyServiceTest
