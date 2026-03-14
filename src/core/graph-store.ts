import * as fs from "node:fs";
import * as path from "node:path";
import { Db, DbRow, openDb } from "./db-adapter";
import { GraphEdge, GraphNode, GraphSnapshot, ImpactResult, ProjectContext } from "./types";
import { stableId } from "./utils";

interface NodeRow extends GraphNode {
  data_json: string | null;
}

interface EdgeRow extends GraphEdge {
  data_json: string | null;
}

export class GraphStore {
  private readonly db: Db;
  private readonly contextDir: string;

  public constructor(private readonly rootPath: string, contextDirectory = ".ai/kg/context") {
    const dbPath = path.join(rootPath, ".ai", "kg", "index.db");
    this.contextDir = path.join(rootPath, contextDirectory);
    this.db = openDb(dbPath);
    this.migrate();
  }

  public close(): void {
    this.db.close();
  }

  public saveProjectContext(projects: ProjectContext[]): void {
    const projectIds = new Set(projects.map((project) => project.id));
    const insert = this.db.prepare(`
      INSERT INTO projects (id, name, root_path, workspace_root, manifest_path, language_hints, framework_hints)
      VALUES (@id, @name, @rootPath, @workspaceRoot, @manifestPath, @languageHints, @frameworkHints)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        root_path = excluded.root_path,
        workspace_root = excluded.workspace_root,
        manifest_path = excluded.manifest_path,
        language_hints = excluded.language_hints,
        framework_hints = excluded.framework_hints
    `);

    const transaction = this.db.transaction((items: ProjectContext[]) => {
      const currentIds = Array.from(projectIds);
      if (currentIds.length) {
        const placeholders = currentIds.map(() => "?").join(", ");
        this.db.prepare(`DELETE FROM projects WHERE id NOT IN (${placeholders})`).run(...currentIds);
        this.db.prepare(`DELETE FROM files WHERE project_id NOT IN (${placeholders})`).run(...currentIds);
        this.db.prepare(`DELETE FROM nodes WHERE project_id NOT IN (${placeholders})`).run(...currentIds);
        this.db.prepare(`DELETE FROM edges WHERE project_id NOT IN (${placeholders})`).run(...currentIds);
      }

      for (const item of items) {
        insert.run({
          id: item.id,
          name: item.name,
          rootPath: item.rootPath,
          workspaceRoot: item.workspaceRoot,
          manifestPath: item.manifestPath ?? null,
          languageHints: JSON.stringify(item.languageHints),
          frameworkHints: JSON.stringify(item.frameworkHints),
        });
      }
    });

    transaction(projects);
  }

  public replaceSnapshot(snapshot: GraphSnapshot): void {
    const deleteProjectNodes = this.db.prepare("DELETE FROM nodes WHERE project_id = ?");
    const deleteProjectEdges = this.db.prepare("DELETE FROM edges WHERE project_id = ?");
    const deleteProjectFiles = this.db.prepare("DELETE FROM files WHERE project_id = ?");

    const insertFile = this.db.prepare(`
      INSERT INTO files (path, project_id, hash, language, last_seen_ms)
      VALUES (@path, @projectId, @hash, @language, @lastSeenMs)
    `);

    const insertNode = this.db.prepare(`
      INSERT INTO nodes (id, kind, name, project_id, source_path, language, framework, normalized_path, http_method, data_json)
      VALUES (@id, @kind, @name, @projectId, @sourcePath, @language, @framework, @normalizedPath, @httpMethod, @dataJson)
    `);

    const insertEdge = this.db.prepare(`
      INSERT INTO edges (id, kind, from_id, to_id, project_id, source_path, confidence, evidence_type, evidence_score, data_json)
      VALUES (@id, @kind, @fromId, @toId, @projectId, @sourcePath, @confidence, @evidenceType, @evidenceScore, @dataJson)
    `);

    const transaction = this.db.transaction((value: GraphSnapshot) => {
      deleteProjectEdges.run(value.project.id);
      deleteProjectNodes.run(value.project.id);
      deleteProjectFiles.run(value.project.id);

      for (const file of value.files) {
        insertFile.run(file);
      }

      for (const node of value.nodes) {
        insertNode.run({
          ...node,
          language: node.language ?? null,
          framework: node.framework ?? null,
          normalizedPath: node.normalizedPath ?? null,
          httpMethod: node.httpMethod ?? null,
          dataJson: node.data ? JSON.stringify(node.data) : null,
        });
      }

      for (const edge of value.edges) {
        insertEdge.run({
          ...edge,
          dataJson: edge.data ? JSON.stringify(edge.data) : null,
        });
      }
    });

    transaction(snapshot);
  }

  public getStatus(): { projects: number; files: number; nodes: number; edges: number } {
    return {
      projects: this.count("projects"),
      files: this.count("files"),
      nodes: this.count("nodes"),
      edges: this.count("edges"),
    };
  }

  public getAllApis(excludedProjectIds: string[] = []): GraphNode[] {
    const baseQuery = `
      SELECT id, kind, name, project_id as projectId, source_path as sourcePath, language, framework,
             normalized_path as normalizedPath, http_method as httpMethod, data_json
      FROM nodes
      WHERE kind = 'api'
    `;

    const rows =
      excludedProjectIds.length > 0
        ? (this.db
            .prepare(
              `${baseQuery} AND project_id NOT IN (${excludedProjectIds.map(() => "?").join(", ")})`,
            )
            .all(...excludedProjectIds) as unknown as NodeRow[])
        : (this.db.prepare(baseQuery).all() as unknown as NodeRow[]);

    return rows.map(this.nodeFromRow);
  }

  public getApisForQuery(query: string): GraphNode[] {
    const text = query.trim();
    const rows = this.db
      .prepare(
        `
        SELECT id, kind, name, project_id as projectId, source_path as sourcePath, language, framework,
               normalized_path as normalizedPath, http_method as httpMethod, data_json
        FROM nodes
        WHERE kind = 'api'
          AND (
            name LIKE @likeQuery OR
            normalized_path LIKE @likeQuery OR
            source_path LIKE @likeQuery
          )
      `,
      )
      .all({
        likeQuery: `%${text}%`,
      }) as unknown as NodeRow[];

    return rows.map(this.nodeFromRow);
  }

  public getHandlersForQuery(query: string): GraphNode[] {
    const text = query.trim();
    const rows = this.db
      .prepare(
        `
        SELECT id, kind, name, project_id as projectId, source_path as sourcePath, language, framework,
               normalized_path as normalizedPath, http_method as httpMethod, data_json
        FROM nodes
        WHERE kind = 'handler'
          AND (
            name LIKE @likeQuery OR
            source_path LIKE @likeQuery
          )
      `,
      )
      .all({
        likeQuery: `%${text}%`,
      }) as unknown as NodeRow[];

    return rows.map(this.nodeFromRow);
  }

  public getApiMap(query: string): Array<{ api: GraphNode; handler?: GraphNode; controller?: GraphNode }> {
    const apis = this.resolveApis(query);
    const bindStmt = this.db.prepare(`
      SELECT n.id, n.kind, n.name, n.project_id as projectId, n.source_path as sourcePath,
             n.language, n.framework, n.normalized_path as normalizedPath, n.http_method as httpMethod, n.data_json
      FROM edges e
      JOIN nodes n ON n.id = e.to_id
      WHERE e.kind = 'binds_handler' AND e.from_id = ?
    `);
    const controllerStmt = this.db.prepare(`
      SELECT n.id, n.kind, n.name, n.project_id as projectId, n.source_path as sourcePath,
             n.language, n.framework, n.normalized_path as normalizedPath, n.http_method as httpMethod, n.data_json
      FROM edges e
      JOIN nodes n ON n.id = e.from_id
      WHERE e.kind = 'defines_api' AND e.to_id = ?
    `);

    return apis.map((api) => {
      const handlerRow = bindStmt.get(api.id) as NodeRow | undefined;
      const controllerRow = controllerStmt.get(api.id) as NodeRow | undefined;
      return {
        api,
        handler: handlerRow ? this.nodeFromRow(handlerRow) : undefined,
        controller: controllerRow ? this.nodeFromRow(controllerRow) : undefined,
      };
    });
  }

  public getImpact(query: string): ImpactResult {
    const apis = this.resolveApis(query);
    const directHandlers = this.getHandlersForQuery(query);
    const resolvedApis = apis.length ? apis : this.resolveApisFromHandlers(directHandlers);
    const handlers = directHandlers.length ? directHandlers : this.resolveHandlersFromApis(resolvedApis);
    const apiIds = resolvedApis.map((item) => item.id);
    const callers = this.getCallerRows(apiIds);
    const tests = this.getTestRows(apiIds);

    return {
      query,
      apis: resolvedApis,
      handlers,
      callers,
      tests,
    };
  }

  private resolveApisFromHandlers(handlers: GraphNode[]): GraphNode[] {
    const stmt = this.db.prepare(`
      SELECT n.id, n.kind, n.name, n.project_id as projectId, n.source_path as sourcePath,
             n.language, n.framework, n.normalized_path as normalizedPath, n.http_method as httpMethod, n.data_json
      FROM edges e
      JOIN nodes n ON n.id = e.from_id
      WHERE e.kind = 'binds_handler' AND e.to_id = ?
    `);

    return handlers.flatMap((handler) => {
      const row = stmt.get(handler.id) as NodeRow | undefined;
      return row ? [this.nodeFromRow(row)] : [];
    });
  }

  private resolveHandlersFromApis(apis: GraphNode[]): GraphNode[] {
    const stmt = this.db.prepare(`
      SELECT n.id, n.kind, n.name, n.project_id as projectId, n.source_path as sourcePath,
             n.language, n.framework, n.normalized_path as normalizedPath, n.http_method as httpMethod, n.data_json
      FROM edges e
      JOIN nodes n ON n.id = e.to_id
      WHERE e.kind = 'binds_handler' AND e.from_id = ?
    `);

    return apis.flatMap((api) => {
      const row = stmt.get(api.id) as NodeRow | undefined;
      return row ? [this.nodeFromRow(row)] : [];
    });
  }

  private resolveApis(query: string): GraphNode[] {
    const directApis = this.getApisForQuery(query);
    if (directApis.length) {
      return directApis;
    }

    const matchingNodes = this.getNodesForQuery(query, ["controller", "handler", "task", "clientCall", "test", "file"]);
    const apiRows = new Map<string, GraphNode>();

    const outgoingStmt = this.db.prepare(`
      SELECT n.id, n.kind, n.name, n.project_id as projectId, n.source_path as sourcePath,
             n.language, n.framework, n.normalized_path as normalizedPath, n.http_method as httpMethod, n.data_json
      FROM edges e
      JOIN nodes n ON n.id = e.to_id
      WHERE e.from_id = ? AND e.kind IN ('calls_api', 'tests_api')
    `);
    const controllerStmt = this.db.prepare(`
      SELECT n.id, n.kind, n.name, n.project_id as projectId, n.source_path as sourcePath,
             n.language, n.framework, n.normalized_path as normalizedPath, n.http_method as httpMethod, n.data_json
      FROM edges e
      JOIN nodes n ON n.id = e.to_id
      WHERE e.from_id = ? AND e.kind = 'defines_api'
    `);
    const handlerStmt = this.db.prepare(`
      SELECT n.id, n.kind, n.name, n.project_id as projectId, n.source_path as sourcePath,
             n.language, n.framework, n.normalized_path as normalizedPath, n.http_method as httpMethod, n.data_json
      FROM edges e
      JOIN nodes n ON n.id = e.from_id
      WHERE e.kind = 'binds_handler' AND e.to_id = ?
    `);
    const testChainStmt = this.db.prepare(`
      SELECT n.id, n.kind, n.name, n.project_id as projectId, n.source_path as sourcePath,
             n.language, n.framework, n.normalized_path as normalizedPath, n.http_method as httpMethod, n.data_json
      FROM edges e
      JOIN edges api_edge ON api_edge.from_id = e.to_id AND api_edge.kind = 'calls_api'
      JOIN nodes n ON n.id = api_edge.to_id
      WHERE e.from_id = ? AND e.kind IN ('uses_task', 'uses_client_call')
    `);

    for (const node of matchingNodes) {
      const rows =
        node.kind === "controller"
          ? (controllerStmt.all(node.id) as unknown as NodeRow[])
          : node.kind === "handler"
            ? ((() => {
                const row = handlerStmt.get(node.id) as NodeRow | undefined;
                return row ? [row] : [];
              })())
            : node.kind === "test"
              ? ([...(outgoingStmt.all(node.id) as unknown as NodeRow[]), ...(testChainStmt.all(node.id) as unknown as NodeRow[])])
              : (outgoingStmt.all(node.id) as unknown as NodeRow[]);

      for (const row of rows) {
        apiRows.set(row.id, this.nodeFromRow(row));
      }
    }

    return Array.from(apiRows.values());
  }

  private getCallerRows(apiIds: string[]): ImpactResult["callers"] {
    const stmt = this.db.prepare(`
      SELECT n.id, n.kind, n.name, n.project_id as projectId, n.source_path as sourcePath,
             n.language, n.framework, n.normalized_path as normalizedPath, n.http_method as httpMethod, n.data_json,
             e.confidence
      FROM edges e
      JOIN nodes n ON n.id = e.from_id
      WHERE e.kind = 'calls_api' AND e.to_id = ?
    `);

    return apiIds.flatMap((apiId) => {
      const rows = stmt.all(apiId) as unknown as Array<NodeRow & { confidence: number }>;
      return rows.map((row) => ({
        node: this.nodeFromRow(row),
        confidence: row.confidence,
        path: `${row.kind} -> api`,
      }));
    });
  }

  private getTestRows(apiIds: string[]): ImpactResult["tests"] {
    const directStmt = this.db.prepare(`
      SELECT n.id, n.kind, n.name, n.project_id as projectId, n.source_path as sourcePath,
             n.language, n.framework, n.normalized_path as normalizedPath, n.http_method as httpMethod, n.data_json,
             e.confidence
      FROM edges e
      JOIN nodes n ON n.id = e.from_id
      WHERE e.kind = 'tests_api' AND e.to_id = ?
    `);

    return apiIds.flatMap((apiId) => {
      const rows = directStmt.all(apiId) as unknown as Array<NodeRow & { confidence: number }>;
      return rows.map((row) => ({
        node: this.nodeFromRow(row),
        confidence: row.confidence,
        path: "test -> ... -> api",
      }));
    });
  }

  public saveContext(name: string, payload: unknown): string {
    fs.mkdirSync(this.contextDir, { recursive: true });
    const filePath = path.join(this.contextDir, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));

    const node: GraphNode = {
      id: stableId("context", name),
      kind: "context",
      name,
      projectId: "workspace",
      sourcePath: filePath,
      data: { filePath },
    };

    this.db
      .prepare(
        `
        INSERT INTO nodes (id, kind, name, project_id, source_path, language, framework, normalized_path, http_method, data_json)
        VALUES (@id, @kind, @name, @projectId, @sourcePath, @language, @framework, @normalizedPath, @httpMethod, @dataJson)
        ON CONFLICT(id) DO UPDATE SET source_path = excluded.source_path, data_json = excluded.data_json
      `,
      )
      .run({
        ...node,
        language: null,
        framework: null,
        normalizedPath: null,
        httpMethod: null,
        dataJson: JSON.stringify(node.data ?? {}),
      });

    return filePath;
  }

  public loadContext(name: string): unknown {
    const filePath = path.join(this.contextDir, `${name}.json`);
    if (!fs.existsSync(filePath)) {
      return {
        status: "warning",
        message: `Context '${name}' was not found.`,
      };
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  private count(tableName: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as DbRow;
    return Number(row?.count ?? 0);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        manifest_path TEXT,
        language_hints TEXT NOT NULL,
        framework_hints TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        language TEXT NOT NULL,
        last_seen_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        project_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        language TEXT,
        framework TEXT,
        normalized_path TEXT,
        http_method TEXT,
        data_json TEXT
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        confidence REAL NOT NULL,
        evidence_type TEXT NOT NULL,
        evidence_score REAL NOT NULL,
        data_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
      CREATE INDEX IF NOT EXISTS idx_nodes_project_id ON nodes(project_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_normalized_path ON nodes(normalized_path);
      CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
      CREATE INDEX IF NOT EXISTS idx_edges_to_id ON edges(to_id);
      CREATE INDEX IF NOT EXISTS idx_edges_from_id ON edges(from_id);
    `);
  }

  private nodeFromRow = (row: NodeRow): GraphNode => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    projectId: row.projectId,
    sourcePath: row.sourcePath,
    language: row.language,
    framework: row.framework,
    normalizedPath: row.normalizedPath,
    httpMethod: row.httpMethod,
    data: row.data_json ? JSON.parse(row.data_json) : undefined,
  });

  private getNodesForQuery(query: string, kinds: string[]): GraphNode[] {
    const rows = this.db
      .prepare(
        `
        SELECT id, kind, name, project_id as projectId, source_path as sourcePath, language, framework,
               normalized_path as normalizedPath, http_method as httpMethod, data_json
        FROM nodes
        WHERE kind IN (${kinds.map(() => "?").join(", ")})
          AND (name LIKE ? OR source_path LIKE ?)
      `,
      )
      .all(...kinds, `%${query}%`, `%${query}%`) as unknown as NodeRow[];

    return rows.map(this.nodeFromRow);
  }
}
