# Research Report: AI-first VS Code/Cursor Extension v1

Conducted: 2026-03-11

## Executive Summary

Mục tiêu này nên đi theo hướng rất lean: một VS Code/Cursor extension Node/TypeScript, command-first, local-only, index theo batch/incremental, lưu metadata + edges vào SQLite, parser/search tận dụng tool có sẵn của máy (`rg`, git, file watcher) và chỉ tách sidecar khi CPU-bound parsing/graph query thật sự bắt đầu làm extension host lag. V1 không cần UI nặng, chỉ cần commands + output channel + file artifacts.

Best v1: extension host điều phối, queue job, cache, expose commands; sidecar **chưa bắt buộc**. Nếu cần semantic parser sâu đa ngôn ngữ, query graph lớn, hoặc embedding/vector/hybrid retrieval, lúc đó mới tách Python/Rust/Node worker riêng. Premature sidecar = tăng complexity, packaging, lifecycle, crash recovery, debug cost.

## Sources

- VS Code Extension Host docs: https://code.visualstudio.com/api/advanced-topics/extension-host
- VS Code performance issues wiki: https://github.com/microsoft/vscode/wiki/performance-issues
- VS Code testing extensions docs: https://code.visualstudio.com/api/working-with-extensions/testing-extension
- Cursor indexing docs/search summaries: https://cursor.com/help/customization/indexing

## Findings

### 1. Kiến trúc nhẹ nhất để chạy indexing local

Recommended shape:

1. `extension.ts`:
   - register commands
   - activation lazy by command/workspace event
   - keep in-memory job queue + cancellation tokens
2. `workspace service`:
   - enumerate workspace folders
   - normalize root IDs
   - respect ignore rules (`.gitignore`, `.cursorignore`, custom config)
3. `indexer`:
   - snapshot files via `rg --files` or VS Code file APIs
   - hash/mtime compare for incremental indexing
   - chunk per symbol/file, not AST-everything at startup
4. `storage`:
   - SQLite local DB per machine or per workspace fingerprint
   - tables: `roots`, `files`, `symbols`, `edges`, `contexts`, `runs`
5. `query layer`:
   - impact query = reverse edges + import/reference heuristics
   - context save/load = compact JSON/Markdown artifacts
6. `agent bridge`:
   - command returns short machine-readable output
   - optionally write artifact file under `.cursor/` or `.ai/graph/`

Why this is enough:

- VS Code already isolates extensions in extension host.
- Lazy activation avoids idle cost.
- SQLite gives persistence, simple schema evolution, local-only story, easy inspectability.
- `rg` + cheap parsing beats full semantic infra for v1.

Do not do in v1:

- custom webview UI
- always-on daemon
- full-project AST for every language
- vector DB unless real retrieval gap appears
- cross-workspace global mega-graph

### 2. Khi nào dùng extension host thuần vs sidecar Python

Use extension host only when:

- index < ~200k files practical scope after ignores
- commands are batchy, user/agent-triggered, not always-on
- parsing mostly regex/tree-sitter/simple TS compiler API
- acceptable latency: `/build-kg` seconds to few minutes, not sub-second global analysis
- you want simplest install/debug/distribution path

Use sidecar when any of these become true:

- CPU-bound parsing saturates extension host, noticeable editor lag
- memory footprint of graph/query cache grows too much for one Node process
- multi-language semantic analysis needs mature Python ecosystem
- long-running background indexing/retry/recovery matters
- graph algorithms become heavy enough to need separate lifecycle

Trade-off:

- Extension host only:
  - Pros: simple, fewer moving parts, easy marketplace install, no process orchestration
  - Cons: shares CPU/memory budget with extension host, easier to cause lag
- Python sidecar:
  - Pros: isolates heavy work, better for graph/ML/parsing libs, easier worker scaling
  - Cons: packaging pain, interpreter/env issues, IPC protocol, harder support on locked-down machines

Practical middle ground:

- v1: extension host + optional child worker abstraction
- v1.5+: same interface can swap implementation to Python/Rust worker if thresholds exceeded

### 3. Model command UX tối giản nhưng hiệu quả cho AI

Principle: commands should be deterministic, composable, terse, machine-readable.

Best command set for v1:

- `/build-kg [scope] [--full|--changed]`
- `/query-impact <symbol-or-file> [--depth N] [--json]`
- `/save-context <name> [target...]`
- `/load-context <name>`
- `/graph-status`
- `/bootstrap-root [path]`

UX rules:

- default output <= 15 lines human-readable
- `--json` for agent consumption
- every command emits:
  - `status`
  - `scope`
  - `counts`
  - `artifacts`
  - `next_suggested_command`
- commands should be idempotent where possible
- failures must say exact actionable reason, no prose wall

Good output shape:

```json
{
  "status": "ok",
  "root": "app-web",
  "updatedFiles": 182,
  "symbols": 1430,
  "edges": 5120,
  "artifact": ".ai/graph/app-web/latest.json",
  "next": "/query-impact src/auth/login.ts"
}
```

### 4. Rủi ro hiệu năng với multi-root / multi-project lớn

Main risks:

1. Duplicate indexing of vendored/shared/generated code across roots.
2. File watchers exploding on monorepos + build output.
3. SQLite write contention if indexing roots concurrently without batching.
4. Memory blow-up from loading full graph into RAM.
5. False cross-root edges if path normalization/root identity weak.
6. Agent-triggered repeated full rebuilds.

Mitigations:

- root-scoped indexes first; cross-root edges opt-in
- aggressive ignore defaults: `node_modules`, `dist`, `build`, `.next`, coverage, binaries, lock caches
- debounce + batch writes
- store only compact symbol/edge facts, not raw AST
- use incremental mode by default; full rebuild explicit
- hard caps + warnings:
  - max files indexed per root
  - max file size
  - skip binary/minified/generated files
- one active indexing job per root

### 5. Cách bootstrap project mới vào graph

Recommended flow:

1. detect workspace roots
2. fingerprint each root:
   - absolute path
   - git top-level if exists
   - package markers (`package.json`, `pyproject.toml`, etc.)
3. infer project type
4. generate root config with ignore defaults
5. run shallow scan first:
   - files
   - imports
   - exported symbols
6. save root manifest
7. only after first successful scan, enable impact queries

Bootstrap command:

`/bootstrap-root` should do scan + config init + first incremental build.

Artifacts:

- `.ai/graph/roots.json`
- `.ai/graph/<root-id>/config.json`
- `.ai/graph/<root-id>/latest.json`

### 6. Cách expose context cho AI agent, format ngắn gọn

Do not dump whole graph. Expose compressed context packets.

Recommended packet:

```json
{
  "root": "app-web",
  "query": "impact:AuthService",
  "summary": "12 direct dependents, 41 transitive, touches login/session/api middleware",
  "topFiles": [
    "src/auth/AuthService.ts",
    "src/api/login.ts",
    "src/session/store.ts"
  ],
  "topSymbols": [
    "AuthService.login",
    "createSession",
    "requireAuth"
  ],
  "risks": [
    "session contract changes",
    "API auth middleware",
    "test fixtures stale"
  ],
  "artifact": ".ai/graph/app-web/queries/impact-authservice.json"
}
```

Rules:

- <= 1 KB inline when possible
- list top N only
- include artifact path for drill-down
- include confidence if query heuristic, not semantic certainty

## Practical v1 Recommendation

Ship v1 as:

- TypeScript extension, `extensionKind: ["workspace"]`
- command palette + slash-style command aliases
- no custom UI beyond output/log channel
- local SQLite store
- incremental root-scoped indexing
- parsers:
  - start with import graph + file-level symbols
  - TS/JS first-class, others heuristic
- outputs:
  - concise text by default
  - JSON optional for AI
- background model:
  - on-demand commands
  - light file change invalidation
  - no aggressive always-on indexing

Why this wins:

- lowest complexity
- lowest support burden
- enough value fast for `/build-kg`, `/query-impact`, `/save-context`
- keeps migration path open to sidecar later

## Decision Table

| Area | v1 choice | Why | Cost |
| --- | --- | --- | --- |
| Process model | Extension host only | simplest possible | limited heavy compute headroom |
| Storage | SQLite | local, inspectable, robust | schema migrations needed later |
| Graph depth | import + symbol + references heuristics | enough for impact/context | not fully precise |
| UX | commands + terse JSON/text | AI-friendly, no UI tax | less discoverable for humans |
| Multi-root | root-scoped first | contains perf risk | weaker cross-project insight |
| Bootstrap | explicit `/bootstrap-root` | deterministic | one-time setup step |

## Suggested v1 Commands

```text
/bootstrap-root
/build-kg --changed
/query-impact AuthService --json
/save-context auth-hotspot src/auth src/api/login.ts
/graph-status
```

## Unresolved Questions

- Need exact target langs in v1? If TS/JS-only, extension-host-only is even safer.
- Need true slash commands inside chat input, or command palette aliases enough?
- Need cross-root impact from day 1, or root-local is acceptable?
- Need AI to read context via files only, or also via direct command stdout?
