import { ImpactGraphEngine } from "../core/engine";
import { GraphStore } from "../core/graph-store";
import { shortLabel } from "../core/utils";
import {
  ApiMapEntry,
  BootstrapOutput,
  BuildOutput,
  CommandContext,
  ContextOutput,
  ExplainImpactOutput,
  FindCallersOutput,
  FindTestsOutput,
  GraphStatusOutput,
  SavedContextPayload,
  ShowApiMapOutput,
} from "./types";

export const COMMAND_IDS = {
  bootstrapProjects: "impactGraph.bootstrapProjects",
  buildFull: "impactGraph.buildImpactGraph",
  refreshChanged: "impactGraph.refreshChanged",
  findTests: "impactGraph.findTests",
  findCallers: "impactGraph.findCallers",
  explainImpact: "impactGraph.explainImpact",
  showApiMap: "impactGraph.showApiMap",
  saveContext: "impactGraph.saveContext",
  loadContext: "impactGraph.loadContext",
  graphStatus: "impactGraph.graphStatus",
} as const;

export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];

export interface CommandSpec {
  id: CommandId;
  title: string;
  description: string;
  input?: "query" | "name" | "none";
  category: "build" | "query" | "context" | "status";
}

export const COMMAND_SPECS: CommandSpec[] = [
  {
    id: COMMAND_IDS.bootstrapProjects,
    title: "Bootstrap Projects",
    description: "Discover project roots, manifest files, language/framework hints",
    input: "none",
    category: "build",
  },
  {
    id: COMMAND_IDS.buildFull,
    title: "Build Impact Graph",
    description: "Full rebuild of API-to-test impact graph across all projects",
    input: "none",
    category: "build",
  },
  {
    id: COMMAND_IDS.refreshChanged,
    title: "Refresh Changed",
    description: "Incremental update for the currently active file's project",
    input: "none",
    category: "build",
  },
  {
    id: COMMAND_IDS.findTests,
    title: "Find Tests",
    description: "Find tests affected by a handler, API path, or file",
    input: "query",
    category: "query",
  },
  {
    id: COMMAND_IDS.findCallers,
    title: "Find Callers",
    description: "Find tasks, clients, and helpers that call a specific API",
    input: "query",
    category: "query",
  },
  {
    id: COMMAND_IDS.explainImpact,
    title: "Explain Impact",
    description: "Detailed impact analysis with confidence scores and evidence paths",
    input: "query",
    category: "query",
  },
  {
    id: COMMAND_IDS.showApiMap,
    title: "Show API Map",
    description: "Map APIs to their handlers and controllers",
    input: "query",
    category: "query",
  },
  {
    id: COMMAND_IDS.saveContext,
    title: "Save Context",
    description: "Save current editor state and annotations for later retrieval",
    input: "name",
    category: "context",
  },
  {
    id: COMMAND_IDS.loadContext,
    title: "Load Context",
    description: "Load a previously saved context packet",
    input: "name",
    category: "context",
  },
  {
    id: COMMAND_IDS.graphStatus,
    title: "Graph Status",
    description: "Show counts of projects, files, nodes, and edges in the graph",
    input: "none",
    category: "status",
  },
];

export class CommandRegistry {
  constructor(
    private readonly engine: ImpactGraphEngine,
    private readonly store: GraphStore,
  ) {}

  async bootstrapProjects(_ctx: CommandContext): Promise<BootstrapOutput> {
    const projects = await this.engine.bootstrapProjects();
    return {
      projects: projects.map((p) => ({
        name: p.name,
        rootPath: p.rootPath,
        languages: p.languageHints,
        frameworks: p.frameworkHints,
      })),
    };
  }

  async buildFull(_ctx: CommandContext): Promise<BuildOutput> {
    const start = Date.now();
    const status = await this.engine.buildAll();
    return {
      ...status,
      mode: "full",
      elapsedMs: Date.now() - start,
    };
  }

  async refreshChanged(ctx: CommandContext): Promise<BuildOutput> {
    const start = Date.now();
    const status = await this.engine.refreshChanged(ctx.activeFilePath);
    return {
      ...status,
      mode: ctx.activeFilePath ? "incremental" : "full",
      elapsedMs: Date.now() - start,
    };
  }

  findTests(query: string, _ctx: CommandContext): FindTestsOutput {
    const impact = this.store.getImpact(query);
    return {
      query,
      apis: impact.apis.map((a) => a.name),
      handlers: impact.handlers.map((h) => h.name),
      affectedTests: impact.tests.map((t) => ({
        name: t.node.name,
        file: shortLabel(t.node.sourcePath),
        confidence: Number(t.confidence.toFixed(2)),
        path: t.path,
      })),
    };
  }

  findCallers(query: string, _ctx: CommandContext): FindCallersOutput {
    const impact = this.store.getImpact(query);
    return {
      query,
      apis: impact.apis.map((a) => a.name),
      callers: impact.callers.map((c) => ({
        name: c.node.name,
        file: shortLabel(c.node.sourcePath),
        confidence: Number(c.confidence.toFixed(2)),
        path: c.path,
      })),
    };
  }

  explainImpact(query: string, _ctx: CommandContext): ExplainImpactOutput {
    const impact = this.store.getImpact(query);
    return {
      query,
      apis: impact.apis.map((a) => a.name),
      handlers: impact.handlers.map((h) => h.name),
      callers: impact.callers.map((c) => ({
        name: c.node.name,
        confidence: Number(c.confidence.toFixed(2)),
        evidenceType: c.path,
      })),
      tests: impact.tests.map((t) => ({
        name: t.node.name,
        confidence: Number(t.confidence.toFixed(2)),
        path: t.path,
      })),
    };
  }

  showApiMap(query: string, _ctx: CommandContext): ShowApiMapOutput {
    const apiMap = this.store.getApiMap(query);
    return {
      query,
      entries: apiMap.map((item): ApiMapEntry => ({
        api: item.api.name,
        httpMethod: item.api.httpMethod,
        fullPath: item.api.normalizedPath,
        handler: item.handler?.name,
        controller: item.controller?.name,
      })),
    };
  }

  saveContext(name: string, payload: SavedContextPayload, _ctx: CommandContext): ContextOutput {
    const filePath = this.store.saveContext(name, payload);
    return { name, filePath };
  }

  loadContext(name: string, _ctx: CommandContext): unknown {
    return this.store.loadContext(name);
  }

  graphStatus(_ctx: CommandContext): GraphStatusOutput {
    return this.store.getStatus();
  }
}
