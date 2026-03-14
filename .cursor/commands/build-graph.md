---
description: Build or rebuild the API Impact Graph for all projects in this workspace.
---

Tell the user to run the following commands in VS Code Command Palette (`Cmd+Shift+P`) in order:

1. **Impact Graph: Bootstrap Projects** — detects all project roots (Flask, Java, Go, TS/JS).
2. **Impact Graph: Build Impact Graph** — scans all source files and builds the API-to-test graph.

After the build completes, run **Impact Graph: Graph Status** to confirm the node/edge counts.

Typical output:
```json
{
  "status": "ok",
  "projects": 2,
  "files": 45,
  "nodes": 180,
  "edges": 320
}
```

If this is the first time building, the process may take a few seconds depending on workspace size.
After a code change, use `/refresh-graph` instead to do a faster incremental update.
