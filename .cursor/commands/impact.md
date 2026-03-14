---
description: Find affected tests and callers for the current file or a given handler/API path using the Impact Graph extension.
---

Look at the currently open file or the user's query to determine the target handler, function, or API path.

Then do the following:

1. Instruct the user to run this command in VS Code Command Palette (`Cmd+Shift+P`):
   - **Impact Graph: Find Tests** — input: the handler or API path
   - **Impact Graph: Find Callers** — input: the same target
2. Read the JSON output from the **Impact Graph** output channel.
3. List the affected test files and callers with their confidence scores.
4. If confidence < 0.7, note that manual verification is recommended.
5. If the graph returns no results, suggest running **Impact Graph: Build Impact Graph** first.

If the user hasn't specified a target, use the function or route nearest to their cursor position.
