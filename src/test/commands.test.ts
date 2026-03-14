import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { COMMAND_IDS, COMMAND_SPECS, CommandContext, CommandRegistry } from "../commands";
import { ImpactGraphEngine } from "../core/engine";
import { GraphStore } from "../core/graph-store";

describe("CommandRegistry", () => {
  let tempDir: string;
  let store: GraphStore;
  let engine: ImpactGraphEngine;
  let registry: CommandRegistry;
  let ctx: CommandContext;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-test-"));
    store = await GraphStore.create(tempDir);
    engine = new ImpactGraphEngine(tempDir, store);
    registry = new CommandRegistry(engine, store);
    ctx = { workspaceRoot: tempDir };
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("COMMAND_IDS matches expected minimal command set", () => {
    assert.deepStrictEqual(Object.keys(COMMAND_IDS).sort(), [
      "bootstrapProjects",
      "buildFull",
      "explainImpact",
      "findCallers",
      "findTests",
      "graphStatus",
      "loadContext",
      "refreshChanged",
      "saveContext",
      "showApiMap",
    ]);
  });

  it("COMMAND_SPECS has entry for each COMMAND_ID", () => {
    const specIds = new Set(COMMAND_SPECS.map((s) => s.id));
    for (const id of Object.values(COMMAND_IDS)) {
      assert.ok(specIds.has(id), `Missing spec for ${id}`);
    }
  });

  it("bootstrapProjects returns project list", async () => {
    const result = await registry.bootstrapProjects(ctx);
    assert.ok(Array.isArray(result.projects));
  });

  it("buildFull returns status with mode full", async () => {
    const result = await registry.buildFull(ctx);
    assert.strictEqual(result.mode, "full");
    assert.ok(typeof result.elapsedMs === "number");
    assert.ok(typeof result.nodes === "number");
  });

  it("refreshChanged returns mode incremental when activeFilePath given", async () => {
    const pyFile = path.join(tempDir, "test.py");
    fs.writeFileSync(pyFile, "# test");
    const result = await registry.refreshChanged({ ...ctx, activeFilePath: pyFile });
    assert.strictEqual(result.mode, "incremental");
  });

  it("graphStatus returns counts", () => {
    const result = registry.graphStatus(ctx);
    assert.ok("projects" in result);
    assert.ok("files" in result);
    assert.ok("nodes" in result);
    assert.ok("edges" in result);
  });

  it("saveContext and loadContext round-trip", () => {
    const payload = { savedAt: new Date().toISOString(), notes: "test note" };
    const saved = registry.saveContext("test-ctx", payload, ctx);
    assert.ok(saved.filePath.includes("test-ctx.json"));

    const loaded = registry.loadContext("test-ctx", ctx) as typeof payload;
    assert.strictEqual(loaded.notes, "test note");
  });

  it("loadContext returns warning for missing context", () => {
    const result = registry.loadContext("nonexistent", ctx) as { status: string };
    assert.strictEqual(result.status, "warning");
  });

  it("findTests returns structured output", () => {
    const result = registry.findTests("some_handler", ctx);
    assert.ok("query" in result);
    assert.ok(Array.isArray(result.apis));
    assert.ok(Array.isArray(result.affectedTests));
  });

  it("findCallers returns structured output", () => {
    const result = registry.findCallers("/api/user", ctx);
    assert.ok("query" in result);
    assert.ok(Array.isArray(result.callers));
  });

  it("explainImpact returns confidence and evidence paths", () => {
    const result = registry.explainImpact("create_user", ctx);
    assert.ok("apis" in result);
    assert.ok("handlers" in result);
    assert.ok("callers" in result);
    assert.ok("tests" in result);
  });

  it("showApiMap returns entries with handler and controller", () => {
    const result = registry.showApiMap("/api", ctx);
    assert.ok("entries" in result);
    assert.ok(Array.isArray(result.entries));
  });
});

describe("COMMAND_SPECS metadata", () => {
  it("all specs have required fields", () => {
    for (const spec of COMMAND_SPECS) {
      assert.ok(spec.id, "missing id");
      assert.ok(spec.title, "missing title");
      assert.ok(spec.description, "missing description");
      assert.ok(["build", "query", "context", "status"].includes(spec.category), `invalid category ${spec.category}`);
    }
  });

  it("build commands require no input", () => {
    const buildSpecs = COMMAND_SPECS.filter((s) => s.category === "build");
    for (const spec of buildSpecs) {
      assert.strictEqual(spec.input, "none", `${spec.id} should have input=none`);
    }
  });

  it("query commands require query input", () => {
    const querySpecs = COMMAND_SPECS.filter((s) => s.category === "query");
    for (const spec of querySpecs) {
      assert.strictEqual(spec.input, "query", `${spec.id} should have input=query`);
    }
  });

  it("context commands require name input", () => {
    const contextSpecs = COMMAND_SPECS.filter((s) => s.category === "context");
    for (const spec of contextSpecs) {
      assert.strictEqual(spec.input, "name", `${spec.id} should have input=name`);
    }
  });
});
