# Implementation Plan: V3 — Cross-file Import Tracking

**Date**: 2026-03-14
**Status**: pending
**Depends on**: V2 (function nodes, invokes edges, tree-sitter infrastructure)

---

## Problem Statement

V2 detect được function calls **trong cùng file**, nhưng trong kiến trúc layered (Controller → Service → Utils), các calls đều là **cross-file**:

```python
# transaction_controller.py
from transaction import transaction_service

def create_transaction():
    transaction_service.create_transaction(data)  # ← V2 KHÔNG detect được


# transaction_service.py
from util.utils import common_func

def create_transaction(data):
    common_func()  # ← V2 detect được
```

**Kết quả V2**: `query_impact("common_func")` trả về `functionCallers` nhưng `apis: []`, `tests: []` — chain bị đứt ở bước service → controller.

**Kết quả V3 mong muốn**:

```json
{
  "query": "common_func",
  "functions": ["common_func"],
  "functionCallers": ["create_transaction (service.py)"],
  "apis": ["POST /create"],
  "handlers": ["create_transaction (controller.py)"],
  "tests": [{ "name": "TransactionTest", "confidence": 0.79 }]
}
```

---

## Scope V3

**IN scope**:
- Python import tracking (absolute + relative imports)
- Cross-module qualified call detection (`module.function()`)
- Complete chain: `common_func → service → controller handler → API → test`
- `from X import Y` và `import X` patterns
- Update `graph_status` báo cáo import edge count

**OUT of scope**:
- Ngôn ngữ khác (Java, Go, TS) — defer V4
- Dynamic dispatch (`getattr`, `globals()[name]`)
- Wildcard imports (`from module import *`)
- Circular import detection
- Lambda/nested function tracking

---

## New Graph Elements

### Node kinds (không thêm mới)
Tái dùng `function` node từ V2.

### Edge kinds mới

| Edge | From | To | Meaning |
|---|---|---|---|
| `imports` | file | file | `controller.py` imports `service.py` |
| `invokes_qualified` | function | function | `controller.create_transaction` calls `service.create_transaction` |

### Evidence types mới

| Evidence | Source |
|---|---|
| `ast_import_statement` | tree-sitter parse `import` / `from X import Y` |
| `ast_qualified_call` | tree-sitter parse `module.method()` cross-file call |

---

## Architecture Overview

```
src/
  adapters/
    pythonAst.ts          ← V2, mở rộng thêm:
                             - extractImports()
                             - extractQualifiedCalls()
  core/
    engine.ts             ← thêm linkImports()
    graph-store.ts        ← mở rộng getImpactFromFunction() để
                             follow invokes_qualified edges
    types.ts              ← thêm EdgeKind, EvidenceType mới
```

---

## Implementation Phases

---

### Phase 1 — Extend PythonAstAdapter với Import Tracking

**File**: `src/adapters/pythonAst.ts`

**Goal**: Parse import statements và qualified calls từ Python files.

#### 1.1 Extract Import Statements

Tree-sitter query các node types:
- `import_statement`: `import transaction_service`
- `import_from_statement`: `from transaction import transaction_service`
- `aliased_import`: `import transaction_service as ts`

**Output mới từ `extract()`**:
```typescript
interface ExtractedImport {
  filePath: string;            // file chứa import
  importedSymbol: string;      // "transaction_service", "common_func"
  fromModule: string | null;   // "transaction", "util.utils"
  alias: string | null;        // "ts" nếu có alias
}
```

**Nodes/Edges tạo ra**:
- Edge `imports`: `file:controller.py → file:service.py` (sau khi resolve module path)

#### 1.2 Extract Qualified Calls

Detect calls dạng `module.function()` hoặc `obj.method()` — tree-sitter `attribute` node.

```python
transaction_service.create_transaction(data)
#    ↑ object              ↑ attribute call
```

**Output mới**:
```typescript
interface ExtractedQualifiedCall {
  callerFilePath: string;    // file chứa call
  callerFunction: string;    // function trong file đó
  objectName: string;        // "transaction_service"
  methodName: string;        // "create_transaction"
}
```

#### 1.3 Module Path Resolution

Chuyển `from transaction import transaction_service` → absolute file path.

**Algorithm**:
```
1. Nếu có fromModule: resolve từ project root
   "transaction" → projectRoot/transaction/__init__.py
                → projectRoot/transaction/transaction_service.py

2. Nếu là relative import (from . import X):
   resolve từ vị trí file hiện tại

3. Fallback: match by filename stem trong project
```

**Estimated effort**: 1 ngày (module resolution là phần phức tạp nhất)

---

### Phase 2 — Engine: Link Cross-file Calls

**File**: `src/core/engine.ts`

#### 2.1 `linkImports()`

Sau khi extract imports từ tất cả files, tạo:
- `imports` edges: `file → file`
- `invokes_qualified` edges: `function → function` (cross-file)

**Logic**:
```typescript
function linkImports(projectId, imports, qualifiedCalls, functionNodes):
  // Build: symbol → [file, function] map từ imports
  const symbolMap = buildSymbolMap(imports)

  // For each qualified call: module.method()
  for call in qualifiedCalls:
    targetFile = symbolMap.get(call.objectName)  // "transaction_service" → service.py
    targetFunc = functionNodes.find(f =>
      f.sourcePath === targetFile && f.name === call.methodName
    )
    callerFunc = functionNodes.find(f =>
      f.sourcePath === call.callerFilePath && f.name === call.callerFunction
    )
    if targetFunc && callerFunc:
      create edge: invokes_qualified(callerFunc → targetFunc)
```

#### 2.2 Update `extractProject()`

Thêm `imports` và `qualifiedCalls` vào `ProjectExtraction`:

```typescript
interface ProjectExtraction {
  snapshot: GraphSnapshot;
  callsites: ExtractedCallSite[];
  functions: ExtractedFunction[];
  imports: ExtractedImport[];           // V3 new
  qualifiedCalls: ExtractedQualifiedCall[];  // V3 new
}
```

#### 2.3 Update `buildAll()`

Sau khi extract tất cả projects, gọi `linkImports()` để tạo cross-file edges.

**Estimated effort**: 1 ngày

---

### Phase 3 — GraphStore: Follow Cross-file Chain

**File**: `src/core/graph-store.ts`

#### 3.1 Mở rộng `getImpactFromFunction()`

Hiện tại: chỉ follow `invokes` edges (same-file).

V3: follow cả `invokes_qualified` edges (cross-file).

```sql
-- Tìm tất cả callers của function (cả same-file và cross-file)
SELECT n.* FROM edges e
JOIN nodes n ON n.id = e.from_id
WHERE e.kind IN ('invokes', 'invokes_qualified')
  AND e.to_id = ?
```

#### 3.2 Multi-hop Chain Traversal

Với layered architecture 3 tầng:
```
common_func
  ← invokes ← service.create_transaction
                ← invokes_qualified ← controller.create_transaction (handler)
                                         ← binds_handler ← POST /create
```

Cần traverse **2 hops** qua `invokes`/`invokes_qualified` edges trước khi đến handler.

**Algorithm** (BFS up to 3 hops):
```typescript
function traceToHandlers(funcId, maxDepth=3):
  visited = Set()
  queue = [(funcId, 0)]
  handlers = []

  while queue:
    (nodeId, depth) = queue.pop()
    if depth > maxDepth: continue
    if visited.has(nodeId): continue
    visited.add(nodeId)

    callers = getCallers(nodeId, ['invokes', 'invokes_qualified'])
    for caller in callers:
      if isHandler(caller): handlers.push(caller)
      else: queue.push((caller.id, depth + 1))

  return handlers
```

#### 3.3 Confidence Decay

Mỗi hop qua `invokes_qualified` giảm confidence:
- `invokes` (same-file): `0.92`
- `invokes_qualified` (cross-file): `0.88`
- Transitive (2 hops): `0.92 × 0.88 = 0.81`
- Transitive (3 hops): `0.92 × 0.88 × 0.88 = 0.71`

**Estimated effort**: 1 ngày

---

### Phase 4 — MCP & Testing

**File**: `src/mcp-server.ts`

#### 4.1 Update `graph_status`

Thêm import edge count:
```json
{
  "projects": 2,
  "files": 34,
  "nodes": 160,
  "edges": 280,
  "functions": 31,
  "imports": 45,
  "roots": [...]
}
```

#### 4.2 Update `query_impact` description

Làm rõ V3 support full chain kể cả layered architecture.

#### 4.3 End-to-end Test

Test với FlaskProjectTest:
```
query_impact("common_func")
→ expects:
  functions: [common_func]
  functionCallers: [create_transaction (service.py)]
  apis: [POST /create]
  handlers: [create_transaction (controller.py)]
  tests: [TransactionTest (confidence ~0.79)]
```

**Estimated effort**: 0.5 ngày

---

## Timeline

| Phase | Task | Effort | Dependency |
|---|---|---|---|
| 1 | PythonAstAdapter: import extraction | 1 ngày | V2 tree-sitter |
| 1 | PythonAstAdapter: qualified call detection | 0.5 ngày | Phase 1 |
| 1 | Module path resolution | 1 ngày | Phase 1 |
| 2 | Engine: linkImports() | 1 ngày | Phase 1 |
| 3 | GraphStore: multi-hop BFS traversal | 1 ngày | Phase 2 |
| 4 | MCP update + end-to-end test | 0.5 ngày | Phase 3 |
| — | **Total** | **~5 ngày** | — |

---

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Python module resolution sai với complex imports | Cao | Cao | Fallback: match by filename stem |
| Circular imports gây infinite loop trong BFS | Trung bình | Cao | `visited` set trong BFS algorithm |
| Quá nhiều noise từ `invokes_qualified` | Trung bình | Trung bình | Confidence threshold: chỉ hiển thị ≥ 0.7 |
| `__init__.py` re-export làm khó resolve | Cao | Trung bình | Parse `__init__.py` để resolve re-exports |
| tree-sitter `attribute` node không phải lúc nào cũng là method call | Trung bình | Thấp | Filter: chỉ xử lý khi trong context `call` node |

---

## Success Criteria

- [ ] `query_impact("common_func")` trả về đúng `apis` và `tests` (không còn rỗng)
- [ ] Chain confidence decay đúng: ~0.79 cho 2-hop chain
- [ ] Không có false positive cho string literals và comments
- [ ] Build time tăng < 1.5x so với V2
- [ ] Fallback graceful nếu module path resolution fail

---

## Compatibility

- V3 **backward compatible** với V1 và V2 queries
- DB schema: thêm edge types mới, không xóa cũ
- Cần rebuild graph sau khi cài V3 VSIX
