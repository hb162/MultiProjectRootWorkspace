import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HttpCallsiteAdapter } from "../adapters/httpCallsites";
import { normalizeApiPath } from "../core/utils";
import { ProjectContext } from "../core/types";

test("normalizeApiPath strips origin and query string", () => {
  assert.equal(normalizeApiPath("https://svc.example.com/i/v1/api/user/create?dryRun=true"), "/i/v1/api/user/create");
});

test("HttpCallsiteAdapter extracts fetch calls without forcing FETCH as method", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-graph-fetch-"));
  const filePath = path.join(root, "UserApiTest.ts");
  fs.writeFileSync(
    filePath,
    `
fetch("https://svc.example.com/i/v1/api/user/create?dryRun=true", {
  method: "POST"
});
`,
  );

  const project: ProjectContext = {
    id: root,
    name: "web",
    rootPath: root,
    workspaceRoot: root,
    languageHints: ["typescript"],
    frameworkHints: [],
  };

  const adapter = new HttpCallsiteAdapter();
  const [site] = await adapter.extract(project, [filePath]);

  assert.ok(site);
  assert.equal(site.httpMethod, "POST");
  assert.equal(site.normalizedPath, "/i/v1/api/user/create");
});
