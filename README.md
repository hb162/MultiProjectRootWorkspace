# AI First API Impact Graph

> VS Code / Cursor / Kiro extension giúp AI biết ngay "sửa API này thì test nào bị ảnh hưởng" — không cần scan toàn repo, không tốn token.

---

## Mục Đích

Khi làm việc với **multi-project workspace** (ví dụ: Flask service + Java Serenity BDD auto test), việc sửa một API hoặc handler function có thể ảnh hưởng đến nhiều test ở project khác. AI rất khó phát hiện điều này một cách chủ động vì phải grep toàn bộ codebase — tốn hàng chục nghìn token, chậm, và dễ miss.

Extension này giải quyết bài toán bằng cách xây một **knowledge graph cục bộ** (lưu bằng SQLite), ánh xạ mối quan hệ:

```
Flask API endpoint
  → handler function
    → Java Task (call API)
      → Java Test (Serenity BDD)
```

AI chỉ cần gọi **1 MCP tool** để nhận kết quả có cấu trúc — thay vì đọc hàng chục file.

**Lợi ích đo được:**

| Cách làm | Token tiêu thụ | Độ chính xác |
|---|---|---|
| AI tự grep codebase | ~10,000–28,000 tokens | 60–80% |
| KG query (extension này) | ~1,000 tokens | 90–96% |

---

## Công Nghệ Sử Dụng

| Thành phần | Công nghệ |
|---|---|
| Extension runtime | **TypeScript**, VS Code Extension API |
| Graph storage | **SQLite** (`node:sqlite` built-in Node 22+ hoặc `better-sqlite3` fallback) |
| API extraction | Regex adapter cho **Flask** (Python), **HTTP callsite** scanner cho Java/Go/TS/JS |
| Test framework hỗ trợ | **Java Serenity BDD** (`*Test.java`, `*Task.java`, `*Qst.java`, `*Entity.java`, `*Matcher.java`) |
| AI integration | **Model Context Protocol (MCP)** — stdio JSON-RPC server |
| Packaging | `@vscode/vsce` → `.vsix` |
| Build tool | `tsc` (TypeScript compiler) |
| Test | Node.js built-in test runner |

---

## Clone và Phát Triển Thêm

### Yêu cầu

- **Node.js** >= 18 (khuyến nghị 22+ để dùng `node:sqlite` built-in)
- **npm** >= 9
- **VS Code** >= 1.105 hoặc Cursor / Kiro

### Clone

```bash
git clone <repo-url> MultiprojectWorkspaceExtension
cd MultiprojectWorkspaceExtension
npm install
npm run compile
```

### Cấu trúc source

```
src/
  extension.ts          ← VS Code entry point, đăng ký commands
  mcp-server.ts         ← MCP stdio server cho AI gọi trực tiếp
  core/
    engine.ts           ← Orchestration: build graph, link callsites
    graph-store.ts      ← SQLite read/write (nodes, edges, snapshots)
    db-adapter.ts       ← Abstraction layer: node:sqlite hoặc better-sqlite3
    workspace.ts        ← Phát hiện project roots và source files
    types.ts            ← TypeScript interfaces (GraphNode, GraphEdge, ...)
    utils.ts            ← Hash, normalize path, confidence score, ...
  adapters/
    flask.ts            ← Extract Flask routes từ Python controller files
    httpCallsites.ts    ← Detect HTTP calls + Serenity BDD patterns trong Java/TS/Go/JS
```

### Workflow phát triển

```bash
npm run watch     # tự động recompile khi thay đổi file .ts
```

Sau đó nhấn `F5` trong VS Code để mở **Extension Development Host** và test trực tiếp.

```bash
npm test          # chạy unit tests
```

### Thêm adapter cho framework mới

1. Tạo file `src/adapters/<framework>.ts` implement interface:
   ```typescript
   extract(project: ProjectContext, files: string[]): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>
   ```
2. Đăng ký adapter trong `src/core/engine.ts`.
3. Cập nhật `src/core/workspace.ts` nếu cần detect manifest file mới.

---

## Cài Đặt

### Cách A — Build VSIX và cài local (khuyến nghị)

```bash
# 1. Cài vsce nếu chưa có
npm install -g @vscode/vsce

# 2. Build file .vsix
npm run compile
npx @vscode/vsce package --allow-missing-repository
# → sinh ra: ai-first-api-impact-graph-0.1.0.vsix

# 3. Cài vào editor
code --install-extension ai-first-api-impact-graph-0.1.0.vsix
# hoặc Cursor:
cursor --install-extension ai-first-api-impact-graph-0.1.0.vsix
# hoặc Kiro: Extensions → Install from VSIX → chọn file .vsix
```

### Cách B — Chạy trực tiếp qua Extension Development Host (dùng khi dev)

1. Mở thư mục `MultiprojectWorkspaceExtension` trong VS Code/Cursor.
2. Nhấn `F5` → cửa sổ **Extension Development Host** mở ra.
3. Trong cửa sổ đó, mở workspace multi-project của bạn.

---

## Cấu Hình MCP Server (để AI tự gọi)

Sau khi cài extension, cấu hình MCP server để Cursor/Kiro/Claude gọi được graph tools mà không cần human can thiệp.

### Cursor — `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "impact-graph": {
      "command": "node",
      "args": ["/path/to/installed/dist/mcp-server.js"],
      "env": {
        "WORKSPACE_ROOTS": "/path/to/flask-service,/path/to/java-autotest"
      }
    }
  }
}
```

### Kiro — `~/.kiro/settings/mcp.json`

```json
{
  "mcpServers": {
    "impact-graph": {
      "command": "node",
      "args": ["/Users/<you>/.kiro/extensions/local.ai-first-api-impact-graph-0.1.0/dist/mcp-server.js"],
      "env": {
        "WORKSPACE_ROOTS": "/path/to/flask-service,/path/to/java-autotest"
      }
    }
  }
}
```

> `WORKSPACE_ROOTS`: danh sách đường dẫn tuyệt đối tới các project roots, cách nhau bằng dấu phẩy.

### MCP Tools có sẵn

| Tool | Mô tả |
|---|---|
| `graph_status` | Kiểm tra graph đã build chưa, xem thống kê nodes/edges |
| `build_graph` | Trigger rebuild graph toàn bộ |
| `query_impact` | Phân tích đầy đủ impact của 1 API hoặc handler |
| `list_apis` | Liệt kê tất cả API đang được track |
| `find_tests` | Tìm test files liên quan đến 1 API |

---

## Cách Sử Dụng (VS Code Commands)

Mở Command Palette (`Cmd+Shift+P`) và gõ `Impact Graph`:

| Command | Tác dụng |
|---|---|
| `Impact Graph: Build Impact Graph` | Build graph lần đầu hoặc rebuild toàn bộ |
| `Impact Graph: Find Tests` | Nhập API path hoặc handler name → tìm tests bị ảnh hưởng |
| `Impact Graph: Explain Impact` | Giải thích đầy đủ với confidence score |
| `Impact Graph: Graph Status` | Xem số node/edge trong graph |
| `Impact Graph: Refresh Changed` | Re-index project của file đang mở |

### Ví dụ output

```json
{
  "query": "GET /list_all",
  "apis": ["GET /list_all"],
  "handlers": ["list_transactions"],
  "callers": [
    { "name": "TransactionTask /list_all", "file": "TransactionTask.java", "confidence": 0.965 }
  ],
  "affectedTests": [
    { "name": "TransactionTest", "file": "TransactionTest.java", "confidence": 0.9025, "path": "test -> uses_task -> task -> calls_api -> api" }
  ]
}
```

---

## Cấu Trúc Workspace Được Hỗ Trợ

Extension tự phát hiện project roots dựa trên manifest files:

```
my-workspace/
  flask-service/
    pyproject.toml     ← Python/Flask project
    app.py             ← đăng ký prefix cho controllers
    user_controller.py ← khai báo routes
  java-autotest/
    pom.xml            ← Java project (Serenity BDD)
    src/test/java/
      UserTask.java    ← gọi API Flask
      UserTest.java    ← test runner
      UserQst.java     ← logic helper
      UserEntity.java  ← DB query helper
      UserMatcher.java ← comparison helper
  go-service/
    go.mod             ← Go project
  ts-frontend/
    package.json       ← JS/TS project
```

---

## Giới Hạn Hiện Tại (v0.1)

- Flask extraction yêu cầu `app.py` đăng ký prefix theo dạng `(controller_var, "/prefix")`.
- Chỉ extract API server-side từ Flask; Java/Go/TS/JS đóng vai trò call-site scanner.
- Caller detection dựa trên literal HTTP string — không phát hiện được URL dynamic hoặc generated client.
- Function-level intra-project tracking (ví dụ: `utils.py::common_func`) chưa được hỗ trợ — đây là v2 feature cần tree-sitter AST parsing.
- Graph lưu tại `.ai/kg/index.db` trong folder đầu tiên của `WORKSPACE_ROOTS`.

---

## Artifacts Sinh Ra

```
.ai/
  kg/
    index.db    ← SQLite graph (thêm vào .gitignore)
```
