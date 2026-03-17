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

test("HttpCallsiteAdapter extracts method call + string literal pattern (Java Serenity)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-graph-java-"));
  const filePath = path.join(root, "SellingCapTask.java");
  fs.writeFileSync(
    filePath,
    `
public class SellingCapTask {
  public void calculateSellingCap() {
    String baseUri = getDomainIrisBondV1ByType("wn") + "ioptima-sellingcap/calculate";
    given().baseUri(baseUri).post();
  }
}
`,
  );

  const project: ProjectContext = {
    id: root,
    name: "ct-iris-bond-service-test",
    rootPath: root,
    workspaceRoot: root,
    languageHints: ["java"],
    frameworkHints: ["serenity"],
  };

  const adapter = new HttpCallsiteAdapter();
  const sites = await adapter.extract(project, [filePath]);

  // Should find the method call + string literal pattern
  const apiSite = sites.find(s => s.normalizedPath?.includes("ioptima-sellingcap/calculate"));
  assert.ok(apiSite, "Should extract method call + string literal pattern");
  assert.equal(apiSite.rawPath, "ioptima-sellingcap/calculate");
  assert.equal(apiSite.normalizedPath, "/ioptima-sellingcap/calculate");
  assert.equal(apiSite.httpMethod, "POST");
});

test("HttpCallsiteAdapter extracts concatenation pattern without leading slash", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-graph-concat-"));
  const filePath = path.join(root, "ApiTask.java");
  fs.writeFileSync(
    filePath,
    `
public class ApiTask {
  public void callApi() {
    given().baseUri(BASE_URL + "api/users/list").get();
  }
}
`,
  );

  const project: ProjectContext = {
    id: root,
    name: "test-project",
    rootPath: root,
    workspaceRoot: root,
    languageHints: ["java"],
    frameworkHints: ["serenity"],
  };

  const adapter = new HttpCallsiteAdapter();
  const sites = await adapter.extract(project, [filePath]);

  const apiSite = sites.find(s => s.normalizedPath?.includes("api/users/list"));
  assert.ok(apiSite, "Should extract concatenation pattern without leading slash");
  assert.equal(apiSite.httpMethod, "GET");
  assert.equal(apiSite.normalizedPath, "/api/users/list");
});
