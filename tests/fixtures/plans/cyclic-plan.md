# Implementation Plan — vòng phụ thuộc (dùng cho test DAG)

## TASK-01 — Task A

### Objective
A gọi B.

### Dependencies
- TASK-02

### Acceptance Criteria
- A chạy được

### Verification
- Test A

## TASK-02 — Task B

### Objective
B gọi lại A (tạo vòng).

### Dependencies
- TASK-01

### Acceptance Criteria
- B chạy được

### Verification
- Test B
