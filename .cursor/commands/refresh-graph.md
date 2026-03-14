---
description: Refresh the Impact Graph after a code change. Faster than a full rebuild.
---

Tell the user to run in VS Code Command Palette (`Cmd+Shift+P`):

**Impact Graph: Refresh Changed**

This command re-indexes only the project that owns the currently open file.
For Python service changes it triggers a full rebuild because API changes affect cross-project linkage.

After refresh, run `/impact` to query the updated graph.
