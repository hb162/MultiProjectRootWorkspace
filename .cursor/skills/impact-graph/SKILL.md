---
name: impact-graph
description: Query the AI First API Impact Graph to find affected tests, callers, and API mappings when code changes. Use for /impact, /find-tests, /find-callers, /api-map commands.
---

# Impact Graph Skill

Use this skill to query the local API-to-test impact graph whenever code changes are involved.

## When to Use

- User changes a Flask handler or route and wants to know which tests are affected.
- User asks "which tests will break if I change this API?"
- User wants to see which files call a specific endpoint.
- User asks about impact of a function/API change in a multi-project workspace.

## How to Use the Extension

The **AI First API Impact Graph** VS Code extension must be installed. It exposes commands via Command Palette (`Cmd+Shift+P`).

### Step 1: Ensure graph is built

If graph hasn't been built yet in this workspace, run:

```
Impact Graph: Bootstrap Projects
Impact Graph: Build Impact Graph
```

After code changes, run:

```
Impact Graph: Refresh Changed
```

### Step 2: Query the graph

Use the appropriate command based on the user's question:

| User asks | Command to run | Input |
|---|---|---|
| Which tests are affected? | `Impact Graph: Find Tests` | handler name or API path |
| Who calls this API? | `Impact Graph: Find Callers` | handler name or API path |
| Full impact analysis | `Impact Graph: Explain Impact` | handler name or API path |
| Show API → handler → controller | `Impact Graph: Show API Map` | API path or controller name |
| Current graph stats | `Impact Graph: Graph Status` | (none) |

### Step 3: Interpret the output

Results appear in the **Impact Graph** output channel as JSON. Example:

```json
{
  "query": "create_user",
  "apis": ["POST /i/v1/api/user/create"],
  "handlers": ["create_user"],
  "affectedTests": [
    {
      "name": "PostUserTest",
      "file": "java-autotest/PostUserTest.java",
      "confidence": 0.89,
      "path": "test -> PostUserTask -> api"
    }
  ]
}
```

## Confidence Scores

- `0.90+`: strong evidence (direct HTTP string match or task import chain)
- `0.70–0.89`: heuristic evidence (naming similarity, helper chain)
- `< 0.70`: weak signal, verify manually

## Input Formats Accepted

The query field accepts any of:
- handler function name: `create_user`
- API path: `/i/v1/api/user/create` or `POST /i/v1/api/user/create`
- file name: `user_controller.py` or `PostUserTest.java`
- partial match: `user/create`

## Saved Context

To save current analysis context for later:

```
Impact Graph: Save Context → enter name, e.g. "user-api-refactor"
```

To retrieve it:

```
Impact Graph: Load Context → enter name: "user-api-refactor"
```

## Important Notes

- Graph data is stored locally in `.ai/kg/index.db` (never sent to cloud).
- If results seem incomplete, run `Impact Graph: Build Impact Graph` to force a full rebuild.
- Flask service routes + Java autotest projects are first-class. Go/JS/TS are heuristic.
