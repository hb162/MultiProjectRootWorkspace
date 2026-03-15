import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FlaskAdapter } from "../adapters/flask";
import { HttpCallsiteAdapter } from "../adapters/httpCallsites";
import { JavaConfigResolver, VarMap } from "../adapters/javaConfigResolver";
import { PythonAstAdapter } from "../adapters/pythonAst";
import { GraphStore } from "./graph-store";
import { ExtractedCallSite, ExtractedFunction, ExtractedImport, GraphEdge, GraphNode, GraphSnapshot, ProjectContext } from "./types";
import { confidenceScore, detectLanguage, fileStem, hashText, shortLabel, stableId, uniqueBy } from "./utils";
import { discoverProjects, listSourceFiles } from "./workspace";

interface ProjectExtraction {
  snapshot: GraphSnapshot;
  callsites: ExtractedCallSite[];
  functions: ExtractedFunction[];  // V2: Python function data for linking
  imports: ExtractedImport[];      // V3: Python imports for cross-file linking
  pythonFiles: string[];           // V3: All Python files for module resolution
}

export class ImpactGraphEngine {
  private readonly flaskAdapter = new FlaskAdapter();
  private readonly callsiteAdapter = new HttpCallsiteAdapter();
  private readonly pythonAstAdapter = new PythonAstAdapter();  // V2
  private readonly javaConfigResolver = new JavaConfigResolver();  // V4

  public constructor(
    private readonly workspaceRoot: string | string[],
    private readonly store: GraphStore,
  ) {}

  public async bootstrapProjects(): Promise<ProjectContext[]> {
    const projects = await discoverProjects(this.workspaceRoot);
    this.store.saveProjectContext(projects);
    return projects;
  }

  public async buildAll(): Promise<{ projects: number; files: number; nodes: number; edges: number }> {
    const projects = await this.bootstrapProjects();
    const extractions = await Promise.all(projects.map((project) => this.extractProject(project)));
    const allApis = extractions.flatMap((entry) => entry.snapshot.nodes.filter((node) => node.kind === "api"));

    // V2: Collect all function nodes for cross-file linking
    const allFunctionNodes = extractions.flatMap((entry) =>
      entry.snapshot.nodes.filter((node) => node.kind === "function"),
    );

    for (const extraction of extractions) {
      const linked = this.linkCallsites(extraction.snapshot.project.id, extraction.callsites, allApis);

      // V2: Link function → handler (if handler name matches function name)
      const funcToHandlerEdges = this.linkFunctionsToHandlers(
        extraction.snapshot.project.id,
        extraction.snapshot.nodes.filter((n) => n.kind === "function"),
        extraction.snapshot.nodes.filter((n) => n.kind === "handler"),
      );

      // V2: Create invokes edges between functions (same-file)
      const invokesEdges = this.pythonAstAdapter.linkFunctionCalls(
        extraction.snapshot.project.id,
        extraction.functions,
        extraction.snapshot.nodes.filter((n) => n.kind === "function"),
      );

      // V3: Create imports + invokes_qualified edges (cross-file)
      const importEdges = this.pythonAstAdapter.linkImportsAndQualifiedCalls(
        extraction.snapshot.project.id,
        extraction.imports,
        extraction.functions,
        extraction.snapshot.nodes.filter((n) => n.kind === "function"),
        extraction.snapshot.project.rootPath,
        extraction.pythonFiles,
      );

      const snapshot: GraphSnapshot = {
        ...extraction.snapshot,
        nodes: uniqueBy([...extraction.snapshot.nodes, ...linked.nodes], (node) => node.id),
        edges: uniqueBy(
          [...extraction.snapshot.edges, ...linked.edges, ...funcToHandlerEdges, ...invokesEdges, ...importEdges],
          (edge) => edge.id,
        ),
      };
      this.store.replaceSnapshot(snapshot);
    }

    return this.store.getStatus();
  }

  public async refreshChanged(activeFilePath?: string): Promise<{ projects: number; files: number; nodes: number; edges: number }> {
    const projects = await this.bootstrapProjects();
    if (!activeFilePath) {
      return this.buildAll();
    }

    const owningProject = projects
      .filter((project) => activeFilePath.startsWith(project.rootPath))
      .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
    if (!owningProject) {
      return this.buildAll();
    }

    const looksLikeServiceFile = activeFilePath.endsWith(".py");
    if (looksLikeServiceFile) {
      return this.buildAll();
    }

    const extraction = await this.extractProject(owningProject);
    const otherApis = this.store.getAllApis([owningProject.id]);
    const localApis = extraction.snapshot.nodes.filter((node) => node.kind === "api");
    const linked = this.linkCallsites(owningProject.id, extraction.callsites, [...otherApis, ...localApis]);
    const snapshot: GraphSnapshot = {
      ...extraction.snapshot,
      nodes: uniqueBy([...extraction.snapshot.nodes, ...linked.nodes], (node) => node.id),
      edges: uniqueBy([...extraction.snapshot.edges, ...linked.edges], (edge) => edge.id),
    };
    this.store.replaceSnapshot(snapshot);
    return this.store.getStatus();
  }

  private async extractProject(project: ProjectContext): Promise<ProjectExtraction> {
    const files = await listSourceFiles(project.rootPath);
    const fingerprints = await Promise.all(
      files.map(async (filePath) => {
        const text = await fs.readFile(filePath, "utf8");
        return {
          path: filePath,
          projectId: project.id,
          hash: hashText(text),
          language: detectLanguage(filePath),
          lastSeenMs: Date.now(),
        };
      }),
    );

    const baseNodes: GraphNode[] = [
      {
        id: stableId(project.id, "project", project.rootPath),
        kind: "project",
        name: project.name,
        projectId: project.id,
        sourcePath: project.rootPath,
        language: project.languageHints[0],
        framework: project.frameworkHints[0],
        data: {
          workspaceRoot: project.workspaceRoot,
          manifestPath: project.manifestPath ?? "",
        },
      },
    ];

    const baseEdges: GraphEdge[] = [];
    const flask = await this.flaskAdapter.extract(project, files);

    // V4: Resolve Java config chain (.conf → Config.java → variable map)
    const varMap = await this.javaConfigResolver.resolve(files);

    const callsites = await this.callsiteAdapter.extract(project, files, varMap);
    const testData = await this.callsiteAdapter.extractTestData(project, files);

    // V2: Extract Python functions with tree-sitter
    const pythonAst = await this.pythonAstAdapter.extract(project, files);

    return {
      snapshot: {
        project: {
          id: project.id,
          name: project.name,
          rootPath: project.rootPath,
          languageHints: project.languageHints,
          frameworkHints: project.frameworkHints,
        },
        files: fingerprints,
        nodes: uniqueBy([...baseNodes, ...flask.nodes, ...pythonAst.nodes], (node) => node.id),
        edges: uniqueBy([...baseEdges, ...flask.edges, ...pythonAst.edges], (edge) => edge.id),
      },
      callsites: [...callsites, ...testData],
      functions: pythonAst.functions,  // V2: pass function data for linking
      imports: pythonAst.imports,      // V3: pass imports for cross-file linking
      pythonFiles: files.filter((f) => f.endsWith(".py")),  // V3: for module resolution
    };
  }

  private linkCallsites(projectId: string, callsites: ExtractedCallSite[], apiNodes: GraphNode[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const apiByPath = new Map<string, GraphNode[]>();
    for (const api of apiNodes) {
      if (api.normalizedPath) {
        const key = this.apiLookupKey(api.httpMethod, api.normalizedPath);
        apiByPath.set(key, [...(apiByPath.get(key) ?? []), api]);
      }
    }

    // stem → all nodes for that file (a Task file may have multiple nodes, one per API call)
    const helperByStem = new Map<string, GraphNode[]>();

    for (const site of callsites) {
      const fileId = stableId(projectId, "file", site.filePath);
      const nodeKind = site.role === "task" ? "task" : site.role === "test" ? "test" : "clientCall";
      const siteId = stableId(projectId, nodeKind, site.filePath, site.httpMethod ?? "", site.normalizedPath ?? "");

      const fileNode: GraphNode = {
        id: fileId,
        kind: "file",
        name: path.basename(site.filePath),
        projectId,
        sourcePath: site.filePath,
        language: site.language,
        framework: site.framework,
      };

      const siteNode: GraphNode = {
        id: siteId,
        kind: nodeKind,
        name: site.role === "test" ? site.fileStem : `${site.fileStem}${site.normalizedPath ? ` ${site.normalizedPath}` : ""}`,
        projectId,
        sourcePath: site.filePath,
        language: site.language,
        framework: site.framework,
        normalizedPath: site.normalizedPath,
        httpMethod: site.httpMethod,
        data: {
          role: site.role,
          fileName: site.fileName,
          rawPath: site.rawPath ?? "",
        },
      };

      nodes.push(fileNode, siteNode);
      edges.push(
        this.edge(projectId, "contains", fileId, siteNode.id, site.filePath, 0.95, site.isTest ? "direct_test_call" : "http_client_method_match"),
      );

      // Accumulate all nodes per stem so references from Test files link to ALL
      // API-call nodes of a Task (not just the last one).
      helperByStem.set(site.fileStem, [...(helperByStem.get(site.fileStem) ?? []), siteNode]);

      if (site.normalizedPath) {
        const matchedApis = this.findMatchingApis(apiByPath, apiNodes, site.httpMethod, site.normalizedPath);
        for (const matchedApi of matchedApis) {
          edges.push(
            this.edge(
              projectId,
              "calls_api",
              siteNode.id,
              matchedApi.id,
              site.filePath,
              confidenceScore(site.httpMethod ? 0.98 : 0.82, matchedApi.httpMethod === site.httpMethod || !site.httpMethod ? 0.95 : 0.6),
              site.isTest ? "direct_test_call" : "direct_http_string_match",
            ),
          );
        }
      }
    }

    // Deduplicate test nodes before processing (same file may appear multiple times)
    const testNodes = uniqueBy(
      nodes.filter((node) => node.kind === "test"),
      (node) => node.sourcePath,
    );
    for (const testNode of testNodes) {
      const summary = callsites.find((site) => site.filePath === testNode.sourcePath);
      if (!summary) {
        continue;
      }

      for (const ref of summary.references) {
        // Find all nodes for this stem (a Task file has one node per API call)
        const targets =
          helperByStem.get(ref) ??
          Array.from(helperByStem.entries()).find(([stem]) => ref.endsWith(stem))?.[1] ??
          [];

        for (const target of targets) {
          const edgeKind: GraphEdge["kind"] = target.kind === "task" ? "uses_task" : "uses_client_call";
          edges.push(this.edge(projectId, edgeKind, testNode.id, target.id, testNode.sourcePath, 0.84, "test_imports_helper"));
        }
      }
    }

    const callerToApi = edges.filter((edge) => edge.kind === "calls_api");
    const testToCaller = edges.filter((edge) => edge.kind === "uses_task" || edge.kind === "uses_client_call");

    for (const testEdge of testToCaller) {
      for (const callEdge of callerToApi.filter((edge) => edge.fromId === testEdge.toId)) {
        edges.push(
          this.edge(
            projectId,
            "tests_api",
            testEdge.fromId,
            callEdge.toId,
            testEdge.sourcePath,
            confidenceScore(testEdge.confidence, callEdge.confidence),
            "derived_transitive_link",
          ),
        );
      }
    }

    for (const directTestCall of callerToApi) {
      const sourceNode = nodes.find((node) => node.id === directTestCall.fromId);
      if (sourceNode?.kind === "test") {
        edges.push(
          this.edge(
            projectId,
            "tests_api",
            sourceNode.id,
            directTestCall.toId,
            sourceNode.sourcePath,
            directTestCall.confidence,
            "direct_test_call",
          ),
        );
      }
    }

    return {
      nodes: uniqueBy(nodes, (node) => node.id),
      edges: uniqueBy(edges, (edge) => edge.id),
    };
  }

  public explainImpact(query: string): string {
    const impact = this.store.getImpact(query);
    const lines = [
      `query: ${impact.query}`,
      `apis: ${impact.apis.map((api) => api.name).join(", ") || "none"}`,
      `handlers: ${impact.handlers.map((handler) => handler.name).join(", ") || "none"}`,
      `callers: ${impact.callers.map((caller) => `${caller.node.name} (${caller.confidence.toFixed(2)})`).join(", ") || "none"}`,
      `tests: ${impact.tests.map((test) => `${test.node.name} (${test.confidence.toFixed(2)})`).join(", ") || "none"}`,
    ];
    return lines.join("\n");
  }

  public formatStatus(): string {
    const status = this.store.getStatus();
    return JSON.stringify(
      {
        status: "ok",
        ...status,
      },
      null,
      2,
    );
  }

  public formatImpact(query: string): string {
    const impact = this.store.getImpact(query);
    return JSON.stringify(
      {
        query,
        apis: impact.apis.map((api) => api.name),
        handlers: impact.handlers.map((handler) => handler.name),
        callers: impact.callers.map((caller) => ({
          name: caller.node.name,
          file: shortLabel(caller.node.sourcePath),
          confidence: Number(caller.confidence.toFixed(2)),
          path: caller.path,
        })),
        affectedTests: impact.tests.map((test) => ({
          name: test.node.name,
          file: shortLabel(test.node.sourcePath),
          confidence: Number(test.confidence.toFixed(2)),
          path: test.path,
        })),
      },
      null,
      2,
    );
  }

  private findApiSuffixMatch(apiNodes: GraphNode[], normalizedPath: string): GraphNode | undefined {
    return apiNodes.find((api) => api.normalizedPath === normalizedPath || api.normalizedPath?.endsWith(normalizedPath));
  }

  private findMatchingApis(
    apiByPath: Map<string, GraphNode[]>,
    apiNodes: GraphNode[],
    httpMethod: string | undefined,
    normalizedPath: string,
  ): GraphNode[] {
    const exactByMethod = apiByPath.get(this.apiLookupKey(httpMethod, normalizedPath)) ?? [];
    if (exactByMethod.length) {
      return exactByMethod;
    }

    const exactPathMatches = apiNodes.filter((api) => api.normalizedPath === normalizedPath);
    const filteredByMethod = httpMethod ? exactPathMatches.filter((api) => api.httpMethod === httpMethod) : exactPathMatches;
    if (filteredByMethod.length) {
      return filteredByMethod;
    }

    return apiNodes.filter((api) => {
      if (!api.normalizedPath || !api.normalizedPath.endsWith(normalizedPath)) {
        return false;
      }
      return !httpMethod || !api.httpMethod || api.httpMethod === httpMethod;
    });
  }

  private apiLookupKey(httpMethod: string | undefined, normalizedPath: string): string {
    return `${httpMethod ?? "*"} ${normalizedPath}`;
  }

  private edge(
    projectId: string,
    kind: GraphEdge["kind"],
    fromId: string,
    toId: string,
    sourcePath: string,
    confidence: number,
    evidenceType: GraphEdge["evidenceType"],
  ): GraphEdge {
    return {
      id: stableId(projectId, kind, fromId, toId, evidenceType),
      kind,
      fromId,
      toId,
      projectId,
      sourcePath,
      confidence,
      evidenceType,
      evidenceScore: confidence,
    };
  }

  /**
   * V2: Link function nodes to handler nodes when they share the same name.
   * This connects common_func → handler so we can trace function → API → test.
   */
  private linkFunctionsToHandlers(
    projectId: string,
    functionNodes: GraphNode[],
    handlerNodes: GraphNode[],
  ): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const handlerByName = new Map<string, GraphNode>();

    for (const handler of handlerNodes) {
      handlerByName.set(handler.name, handler);
    }

    for (const func of functionNodes) {
      const matchingHandler = handlerByName.get(func.name);
      if (matchingHandler && func.sourcePath === matchingHandler.sourcePath) {
        // Same name + same file = function IS the handler implementation
        edges.push(
          this.edge(
            projectId,
            "binds_handler",
            func.id,
            matchingHandler.id,
            func.sourcePath,
            0.98,
            "ast_function_definition",
          ),
        );
      }
    }

    return edges;
  }
}
