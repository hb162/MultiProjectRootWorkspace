import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverProjects } from "../core/workspace";

test("discoverProjects keeps nested projects even when root has a manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-graph-workspace-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");

  const serviceRoot = path.join(root, "services", "user-service");
  fs.mkdirSync(serviceRoot, { recursive: true });
  fs.writeFileSync(path.join(serviceRoot, "pyproject.toml"), "[tool.poetry]\nname='svc'\n");

  const projects = await discoverProjects(root);
  const names = projects.map((project) => project.rootPath).sort();

  assert.ok(names.includes(root));
  assert.ok(names.includes(serviceRoot));
});
