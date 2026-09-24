# mcp-domain-core

MCP server cung cấp **domain intelligence DOMAIN**: product, policy, rule, fact, core adapter, reference.

> ⚠️ Dataset trong `data/` là **HƯ CẤU** (`"_synthetic": true`), chỉ để chạy skeleton Phase 1. Không phải định nghĩa sản phẩm/policy thật của BPM. Phase 3 thay bằng nguồn thật (DB/service nội bộ).

## Tool theo group (bật/tắt trong `config/mcp.yaml`)

| Group | Tool |
|---|---|
| `product` | `find_product`, `get_product` |
| `policy` | `find_policy`, `get_policy`, `get_policy_inputs`, `get_policy_rules`, `get_policy_dependencies`, `trace_policy_dependency` |
| `fact` | `find_customer_facts`, `find_loan_facts`, `find_cic_facts` |
| `core` | `get_core_input_schema`, `get_core_output_schema`, `get_core_adapter` |
| `reference` | `find_similar_policy`, `find_similar_change`, `find_existing_pattern` |

## Progressive disclosure

```text
find_policy(query)          → summary: id, name, productId, inputs, rulesCount
      ↓
get_policy(policyId)        → metadata: inputs, outputs, dependencies, coreAdapter
      ↓
get_policy_rules(policyId, ruleId)   → nội dung rule (TD1, TD2, ...)
```

Không trả toàn bộ rule khi caller chỉ hỏi metadata — đây là cách giảm context trước khi tới LLM.

## Bất biến

- **INV-06 (fail-closed):** policy/rule/fact không tồn tại ⇒ lỗi rõ ràng kèm danh sách id có sẵn. Không suy diễn.
- **INV-08:** server này **chỉ** chứa domain (product/policy/rule/fact/core). Không chứa logic orchestration, không đọc repo, không chạy build.
- **INV-10:** group bật/tắt qua `config/mcp.yaml` để không trả schema thừa mỗi turn.
- Mọi kết quả kèm `source` (trỏ tới file/id trong dataset) và cờ `_synthetic`.

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `ENGINEERING_OS_ROOT` | Gốc repo Engineering OS (mặc định suy ra từ vị trí `dist/`) |
| `MCP_CONFIG` | Đường dẫn `config/mcp.yaml` khác |
| `DOMAIN_DATA_DIR` | Override thư mục dataset |

## Dataset hiện có

| File | Nội dung |
|---|---|
| `data/products.json` | 3 sản phẩm (nhà đất, tiêu dùng, kinh doanh) |
| `data/policies.json` | 5 policy: `POLICY-NHADAT`, `POLICY-PRESCREEN-01`, `POLICY-CIC-BASIC`, `POLICY-VAYTIEUTUNG`, `POLICY-VAYKINHDOANH` + rule TD1/TD2/TD3/TD4, PS1/PS2, CIC1/CIC2, CT1/CT2, KD1 |
| `data/facts.json` | `CustomerFact`, `LoanFact` (có `purposeOfLoan`), `CICFact` |
| `data/core.json` | Core adapter + input/output schema cho từng policy |
| `data/changes.json` | 5 thay đổi quá khứ (gồm `TASK-49043` "Add Purpose of Loan") để `find_similar_change` / `find_existing_pattern` có dữ liệu minh họa |

## Giới hạn đã biết (Phase 1)

- Tìm kiếm tương đồng bằng **so khớp token**, chưa dùng embedding ⇒ kết quả `confidence: "heuristic"`.
- Chưa có versioning/effective-date resolution: rule có `effectiveFrom` nhưng chưa lọc theo ngày hiệu lực.
- Chưa có kiểm tra phân quyền theo vai trò khi trả dữ liệu policy.
