---
description: Show the API map for a controller, API path, or test file — showing the full chain from route to handler to tests.
---

Ask the user for a target if not clear from context. Accepted inputs:
- controller file: `user_controller.py`
- API path: `/i/v1/api/user/create`
- partial path: `user/create`

Then instruct them to run in Command Palette:

**Impact Graph: Show API Map** — input: the target above

Read the JSON output and display it as a readable table:

| API | HTTP Method | Handler | Controller |
|-----|-------------|---------|------------|
| /i/v1/api/user/create | POST | create_user | user_controller |

Then offer to run `/impact` to see which tests are linked to these APIs.
