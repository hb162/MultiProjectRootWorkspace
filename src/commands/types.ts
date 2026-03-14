import { GraphNode, ImpactResult, ProjectContext } from "../core/types";

export interface CommandContext {
  workspaceRoot: string;
  activeFilePath?: string;
  selection?: string;
}

export interface GraphStatusOutput {
  projects: number;
  files: number;
  nodes: number;
  edges: number;
}

export interface BootstrapOutput {
  projects: Array<{
    name: string;
    rootPath: string;
    languages: string[];
    frameworks: string[];
  }>;
}

export interface BuildOutput extends GraphStatusOutput {
  mode: "full" | "incremental";
  elapsedMs: number;
}

export interface FindTestsOutput {
  query: string;
  apis: string[];
  handlers: string[];
  affectedTests: Array<{
    name: string;
    file: string;
    confidence: number;
    path: string;
  }>;
}

export interface FindCallersOutput {
  query: string;
  apis: string[];
  callers: Array<{
    name: string;
    file: string;
    confidence: number;
    path: string;
  }>;
}

export interface ExplainImpactOutput {
  query: string;
  apis: string[];
  handlers: string[];
  callers: Array<{
    name: string;
    confidence: number;
    evidenceType: string;
  }>;
  tests: Array<{
    name: string;
    confidence: number;
    path: string;
  }>;
}

export interface ApiMapEntry {
  api: string;
  httpMethod?: string;
  fullPath?: string;
  handler?: string;
  controller?: string;
}

export interface ShowApiMapOutput {
  query: string;
  entries: ApiMapEntry[];
}

export interface SavedContextPayload {
  savedAt: string;
  activeFile?: string;
  selection?: string;
  notes?: string;
  [key: string]: unknown;
}

export interface ContextOutput {
  name: string;
  filePath: string;
}

export type CommandHandler<TInput, TOutput> = (input: TInput, ctx: CommandContext) => Promise<TOutput>;
