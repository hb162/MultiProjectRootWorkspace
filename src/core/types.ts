export type NodeKind =
  | "project"
  | "file"
  | "controller"
  | "api"
  | "handler"
  | "task"
  | "clientCall"
  | "test"
  | "context";

export type EdgeKind =
  | "contains"
  | "registers_prefix"
  | "defines_api"
  | "binds_handler"
  | "calls_api"
  | "uses_task"
  | "uses_client_call"
  | "tests_api"
  | "depends_on";

export type EvidenceType =
  | "project_manifest"
  | "route_registration"
  | "route_prefix_registration"
  | "direct_http_string_match"
  | "http_client_method_match"
  | "task_class_usage"
  | "test_imports_helper"
  | "naming_similarity"
  | "same_feature_folder"
  | "direct_test_call"
  | "derived_transitive_link";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  projectId: string;
  sourcePath: string;
  language?: string;
  framework?: string;
  normalizedPath?: string;
  httpMethod?: string;
  data?: Record<string, string | number | boolean | null>;
}

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  fromId: string;
  toId: string;
  projectId: string;
  sourcePath: string;
  confidence: number;
  evidenceType: EvidenceType;
  evidenceScore: number;
  data?: Record<string, string | number | boolean | null>;
}

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  languageHints: string[];
  frameworkHints: string[];
}

export interface FileFingerprint {
  path: string;
  projectId: string;
  hash: string;
  language: string;
  lastSeenMs: number;
}

export interface GraphSnapshot {
  project: ProjectRecord;
  files: FileFingerprint[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ProjectContext {
  id: string;
  name: string;
  rootPath: string;
  workspaceRoot: string;
  manifestPath?: string;
  languageHints: string[];
  frameworkHints: string[];
}

export interface ExtractedCallSite {
  filePath: string;
  fileName: string;
  fileStem: string;
  projectId: string;
  language: string;
  framework?: string;
  isTest: boolean;
  role: "task" | "clientCall" | "test" | "helper";
  httpMethod?: string;
  rawPath?: string;
  normalizedPath?: string;
  references: string[];
}

export interface CommandResult<T> {
  status: "ok" | "warning" | "error";
  summary: string;
  payload: T;
}

export interface ImpactResult {
  query: string;
  apis: GraphNode[];
  handlers: GraphNode[];
  callers: Array<{
    node: GraphNode;
    confidence: number;
    path: string;
  }>;
  tests: Array<{
    node: GraphNode;
    confidence: number;
    path: string;
  }>;
}
