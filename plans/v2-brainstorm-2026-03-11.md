# Brainstorm Report: V2 — Function-Level Impact Tracking
**Date**: 2026-03-11
**Status**: Agreed — ready for planning

---

## Problem Statement

V1 chỉ track API-level dependencies (Flask route → handler → Java test). Không giải được bài toán:

> "Tôi muốn thay đổi `common_func` trong `utils.py` — những API và test nào bị ảnh hưởng?"

Hiện tại graph không có node nào đại diện cho function nội bộ, không có edge `invokes` giữa functions. AI phải tự grep → tốn token, miss nhiều.

---

## Mục Tiêu V2

Sau v2, query `query_impact("common_func")` trả về:

```json
{
  "query": "common_func",
  "functions": [{ "name": "common_func", "file": "utils.py" }],
  "callers": [
    { "name": "list_transactions", "file": "transaction_controller.py" },
    { "name": "create_transaction", "file": "transaction_controller.py" }
  ],
  "affectedApis": ["GET /list_all", "POST /create"],
  "affectedTests": [
    { "name": "TransactionTest", "file": "TransactionTest.java", "confidence": 0.85 }
  ]
}
```

---

## Approaches Evaluated

### A — Enhanced Regex (~65–70% accuracy)
Tìm pattern `common_func(` trong function body bằng regex.
- ❌ False positive với string/comment
- ❌ Miss alias (`fn = common_func; fn()`)
- ✅ Không thêm dependency
- **Verdict**: Đủ cho prototype nhỏ, không đủ cho production

### B — Tree-sitter (CHỌN) (~90–92% accuracy)
Parse Python thành AST thực sự via `tree-sitter` + `tree-sitter-python` npm packages.
- ✅ Chính xác — phân biệt được call vs string/comment
- ✅ Offline, không cần Python runtime
- ✅ Reusable — tree-sitter có grammar cho Java/Go/TS khi cần mở rộng sau
- ✅ Incremental parsing — nhanh với file lớn
- ⚠️ Thêm native binary — áp dụng pattern db-adapter để fallback về regex nếu load fail
- **Verdict**: Lựa chọn tối ưu cho v2

### C — Python subprocess `ast` (~95% accuracy)
Chạy `python3 -c "import ast..."` per file, nhận JSON output.
- ✅ Chính xác nhất (dùng parser chính thống của Python)
- ❌ Phụ thuộc Python runtime path (đã gặp vấn đề pyenv trước đây)
- ❌ Subprocess overhead per file
- **Verdict**: Backup option nếu tree-sitter ABI conflict

---

## Quyết Định Kỹ Thuật

| Hạng mục | Quyết định |
|---|---|
| Parser | Tree-sitter với fallback regex (pattern từ db-adapter) |
| Scope ngôn ngữ | Python only trong v2, tree-sitter sẵn sàng cho Java/TS/Go sau |
| Framework mở rộng | Chưa cần — Flask đủ cho v2 |
| New node kinds | `function` |
| New edge kinds | `invokes` (function → function), `defines_function` (file → function) |
| Query expansion | `query_impact` nhận function name, không chỉ API path |
| Storage | SQLite — không đổi, thêm rows vào bảng `nodes`/`edges` hiện có |

---

## Graph Schema Mở Rộng

```
Nodes mới:
  function  { id, name, filePath, startLine, endLine, projectId }

Edges mới:
  defines_function  file → function   (file chứa function def)
  invokes           function → function  (A gọi B)
  bound_to_handler  function → handler  (function là implementation của handler)
```

Query chain mới:
```
function: common_func
  ← invokes ← list_transactions (handler)
                ← binds_handler ← GET /list_all (api)    [đã có trong v1]
                                    ← tests_api ← TransactionTest  [đã có trong v1]
```

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| ABI mismatch tree-sitter binary | Adapter pattern: try load, fallback regex |
| False negatives với dynamic dispatch (`getattr(obj, fn_name)()`) | Document limitation, low priority |
| Performance với project lớn (500+ files) | Tree-sitter incremental + chỉ re-parse changed files |
| Scope creep sang Java/Go function tracking | Hard boundary: v2 = Python only |

---

## Success Metrics

- [ ] `query_impact("common_func")` trả đúng callers với confidence ≥ 85%
- [ ] False positive rate < 10% (không bắt nhầm string/comment)
- [ ] Build time tăng < 2x so với v1 với project 50 files
- [ ] Fallback graceful nếu tree-sitter không load được

---

## Implementation Phases (gợi ý cho plan)

**Phase 1 — Tree-sitter adapter** (~2–3 ngày)
- Cài `tree-sitter` + `tree-sitter-python`
- Viết `PythonAstAdapter` extract function definitions
- Viết query để tìm function calls trong body
- Tạo `function` nodes, `invokes` + `defines_function` edges

**Phase 2 — Engine integration** (~1 ngày)
- Mở rộng `linkCallsites` để handle function nodes
- Thêm `bound_to_handler` edge linking function → existing handler
- Update `getImpact` query chain trong `graph-store.ts`

**Phase 3 — MCP tool update** (~0.5 ngày)
- `query_impact` nhận function name (không chỉ API path)
- Update `graph_status` để báo cáo function node count
- Update `AGENTS.md` để AI biết dùng function query

**Phase 4 — Fallback & packaging** (~0.5 ngày)
- Adapter fallback về regex nếu tree-sitter load fail
- Rebuild VSIX + copy sang Kiro extension folder
- Test end-to-end với `common_func` trong FlaskProjectTest
