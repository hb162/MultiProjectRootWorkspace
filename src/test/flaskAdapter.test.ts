import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FlaskAdapter } from "../adapters/flask";
import { ProjectContext } from "../core/types";

test("FlaskAdapter resolves full API path from app.py prefix and controller route", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-graph-flask-"));
  const controllerPath = path.join(root, "user_controller.py");
  const appPath = path.join(root, "app.py");

  fs.writeFileSync(
    controllerPath,
    `
@app.route("/create", methods=["POST"])
def create_user():
    return {}
`,
  );

  fs.writeFileSync(
    appPath,
    `
ROUTES = [
    (user_controller, "/i/v1/api/user")
]
`,
  );

  const project: ProjectContext = {
    id: root,
    name: "svc",
    rootPath: root,
    workspaceRoot: root,
    languageHints: ["python"],
    frameworkHints: ["flask"],
  };

  const adapter = new FlaskAdapter();
  const result = await adapter.extract(project, [appPath, controllerPath]);
  const apiNode = result.nodes.find((node) => node.kind === "api");
  const handlerNode = result.nodes.find((node) => node.kind === "handler");

  assert.ok(apiNode);
  assert.equal(apiNode.normalizedPath, "/i/v1/api/user/create");
  assert.equal(apiNode.httpMethod, "POST");
  assert.ok(handlerNode);
  assert.equal(handlerNode.name, "create_user");
});

test("FlaskAdapter creates one API node per declared method", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-graph-flask-"));
  const controllerPath = path.join(root, "user_controller.py");

  fs.writeFileSync(
    controllerPath,
    `
@app.route("/status", methods=["GET", "POST"])
def status_user():
    return {}
`,
  );

  const project: ProjectContext = {
    id: root,
    name: "svc",
    rootPath: root,
    workspaceRoot: root,
    languageHints: ["python"],
    frameworkHints: ["flask"],
  };

  const adapter = new FlaskAdapter();
  const result = await adapter.extract(project, [controllerPath]);
  const apiNodes = result.nodes.filter((node) => node.kind === "api");

  assert.equal(apiNodes.length, 2);
  assert.deepEqual(
    apiNodes.map((node) => node.httpMethod).sort(),
    ["GET", "POST"],
  );
});
