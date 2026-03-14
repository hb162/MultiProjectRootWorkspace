import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ImpactGraphEngine } from "../core/engine";
import { GraphStore } from "../core/graph-store";

test("engine links test and task to Flask API", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-graph-engine-"));
  const serviceRoot = path.join(root, "service");
  const testRoot = path.join(root, "testsuite");
  fs.mkdirSync(serviceRoot, { recursive: true });
  fs.mkdirSync(testRoot, { recursive: true });

  fs.writeFileSync(path.join(serviceRoot, "pyproject.toml"), "[tool.poetry]\nname='svc'\n");
  fs.writeFileSync(
    path.join(serviceRoot, "user_controller.py"),
    `
@app.route("/create", methods=["POST"])
def create_user():
    return {}
`,
  );
  fs.writeFileSync(
    path.join(serviceRoot, "app.py"),
    `
ROUTES = [
    (user_controller, "/i/v1/api/user")
]
`,
  );

  fs.writeFileSync(path.join(testRoot, "pom.xml"), "<project/>");
  fs.writeFileSync(
    path.join(testRoot, "PostUserTask.java"),
    `
public class PostUserTask {
  public void run() {
    SerenityRest.given().post("/i/v1/api/user/create");
  }
}
`,
  );
  fs.writeFileSync(
    path.join(testRoot, "PostUserTest.java"),
    `
import foo.bar.PostUserTask;
public class PostUserTest {
  public void shouldCreateUser() {
    new PostUserTask().run();
  }
}
`,
  );

  const store = new GraphStore(root);
  const engine = new ImpactGraphEngine(root, store);
  await engine.buildAll();

  const impact = store.getImpact("create_user");
  assert.equal(impact.apis.length, 1);
  assert.ok(impact.tests.some((item) => item.node.name.includes("PostUserTest")));

  store.close();
});
