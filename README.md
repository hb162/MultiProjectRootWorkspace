# AI First API Impact Graph

> VS Code / Cursor / Kiro extension for **multi-project workspaces**. Helps AI see which tests and functions in other projects are affected when you modify an API or function.

---

## Purpose

In a workspace with multiple projects (e.g. Flask service + Java test suite), changing an API or a shared function can impact another project. This extension builds a **local knowledge graph** (SQLite) that maps those relationships so AI can query impact via MCP instead of scanning the whole codebase.

---

## How It Works

1. **Build phase** — the extension scans all configured project roots, extracts API endpoints, handler functions, HTTP call sites, test files, and Python functions. It stores them as nodes and edges in a local SQLite graph.
2. **Query phase** — AI calls `query_impact("create_user")` via MCP and gets back which APIs, handlers, callers, and tests are affected. No file scanning required.
3. **Refresh** — on file save or manual command, only the changed project is re-indexed.

---

## Tech Stack

| Component | Technology |
|---|---|
| Extension runtime | **TypeScript**, VS Code Extension API |
| Graph storage | **SQLite** (`node:sqlite` Node 23.4+ or `sql.js` WASM fallback — no native binaries, cross-platform) |
| Python extraction | Regex adapter for **Flask** routes + **tree-sitter** AST for function/import tracking |
| Cross-language scanner | HTTP call-site detector for Java / Go / TypeScript / JavaScript |
| Test framework | **Java Serenity BDD** (`*Test.java`, `*Task.java`, `*Qst.java`, `*Entity.java`, `*Matcher.java`) |
| AI integration | **Model Context Protocol (MCP)** — stdio JSON-RPC 2.0 server |
| Packaging | `@vscode/vsce` → `.vsix` |

---

## Development Setup

### Prerequisites

- **Node.js** >= 18 (22+ recommended for `node:sqlite` built-in)
- **npm** >= 9
- **VS Code** >= 1.85, or Cursor / Kiro

### Clone & Build

```bash
git clone <repo-url> MultiprojectWorkspaceExtension
cd MultiprojectWorkspaceExtension
npm install
npm run compile
```

### Source Layout

```
src/
  extension.ts          ← VS Code entry point, registers commands
  mcp-server.ts         ← MCP stdio server for AI to call directly
  core/
    engine.ts           ← Orchestration: build graph, link call sites
    graph-store.ts      ← SQLite read/write (nodes, edges, snapshots)
    db-adapter.ts       ← node:sqlite (fast) or sql.js WASM (universal fallback)
    workspace.ts        ← Discovers project roots and source files
    types.ts            ← TypeScript interfaces (GraphNode, GraphEdge, …)
    utils.ts            ← Hashing, path normalisation, confidence scoring
  adapters/
    flask.ts            ← Extracts Flask routes from Python controller files
    httpCallsites.ts    ← Detects HTTP calls + Serenity BDD patterns in Java/TS/Go/JS
    pythonAst.ts        ← tree-sitter AST: Python function definitions, imports, qualified calls
```

### Dev Workflow

```bash
npm run watch     # auto-recompile on .ts changes
```

Press `F5` in VS Code to open the **Extension Development Host** and test live.

```bash
npm test          # run unit tests
```

### Adding a New Framework Adapter

1. Create `src/adapters/<framework>.ts` implementing:
   ```typescript
   extract(project: ProjectContext, files: string[]): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>
   ```
2. Register the adapter in `src/core/engine.ts`.
3. Update `src/core/workspace.ts` if the new framework uses a different manifest file.

---

## Installation

### Option A — Build VSIX and install locally (recommended)

```bash
# 1. Install vsce if not already installed
npm install -g @vscode/vsce

# 2. Build the .vsix package
npm run compile
npx @vscode/vsce package --allow-missing-repository
# → produces: ai-first-api-impact-graph-0.1.0.vsix

# 3. Install into your editor
code --install-extension ai-first-api-impact-graph-0.1.0.vsix
# or Cursor:
cursor --install-extension ai-first-api-impact-graph-0.1.0.vsix
# or Kiro: Extensions → Install from VSIX → select the .vsix file
```

### Option B — Run via Extension Development Host (for development)

1. Open the `MultiprojectWorkspaceExtension` folder in VS Code/Cursor.
2. Press `F5` → the **Extension Development Host** window opens.
3. In that window, open your multi-project workspace.

---

## MCP Server Configuration (for AI auto-use)

After installing the extension, configure the MCP server so that Cursor / Kiro / Claude can call the graph tools autonomously — no human intervention needed.

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

> `WORKSPACE_ROOTS`: comma-separated list of absolute paths to all project roots in your workspace.

### Available MCP Tools

| Tool | Description |
|---|---|
| `graph_status` | Check whether the graph is built; show node/edge/function counts |
| `build_graph` | Trigger a full graph rebuild across all roots |
| `query_impact` | Full impact analysis for an API path, handler, or Python function |
| `list_apis` | List all tracked API endpoints |
| `list_functions` | List all tracked Python functions |
| `find_tests` | Find test files related to a specific API or function |

---

## VS Code Commands

Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and type `Impact Graph`:

| Command | Action |
|---|---|
| `Impact Graph: Build Impact Graph` | First-time build or full rebuild |
| `Impact Graph: Find Tests` | Enter an API path or handler name → find affected tests |
| `Impact Graph: Explain Impact` | Full impact explanation with confidence scores |
| `Impact Graph: Graph Status` | View node/edge counts |
| `Impact Graph: Refresh Changed` | Re-index the project containing the currently open file |

### Example Output

```json
{
  "query": "GET /list_all",
  "apis": ["GET /list_all"],
  "handlers": ["list_transactions"],
  "callers": [
    { "name": "TransactionTask /list_all", "file": "TransactionTask.java", "confidence": 0.965 }
  ],
  "tests": [
    { "name": "TransactionTest", "file": "TransactionTest.java", "confidence": 0.9025 }
  ]
}
```

---

## Supported Workspace Layout

The extension auto-discovers project roots based on manifest files (`pyproject.toml`, `pom.xml`, `go.mod`, `package.json`):

```
my-workspace/
  flask-service/
    pyproject.toml     ← Python/Flask project root
    app.py             ← registers route prefixes for controllers
    user_controller.py ← declares routes
    util/
      utils.py         ← shared utility functions (tracked by graph)
  java-autotest/
    pom.xml            ← Java project root (Serenity BDD)
    src/test/java/
      UserTask.java    ← calls Flask API
      UserTest.java    ← test runner
      UserQst.java     ← logic helper
      UserEntity.java  ← DB query helper
      UserMatcher.java ← comparison helper
  go-service/
    go.mod             ← Go project root
  ts-frontend/
    package.json       ← JS/TS project root
```

---

## Current Limitations (v0.1)

- Flask extraction requires `app.py` to register route prefixes in the form `(controller_var, "/prefix")`.
- Only Flask is used as an API server extractor; Java/Go/TS/JS are treated as call-site scanners.
- Caller detection is based on literal HTTP strings — dynamic or generated URLs are not detected.
- Cross-project function tracking only works for Python (via tree-sitter AST); Java/Go/TS/JS function tracking is not yet implemented.
- The graph database is stored at `.ai/kg/index.db` inside the first folder listed in `WORKSPACE_ROOTS`.

---

## Generated Artifacts

```
.ai/
  kg/
    index.db    ← SQLite graph database (add to .gitignore)
```
