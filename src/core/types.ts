export type NodeKind =
  | "project"
  | "file"
  | "controller"
  | "api"
  | "handler"
  | "task"
  | "clientCall"
  | "test"
  | "context"
  | "function";  // V2: Python function definition

export type EdgeKind =
  | "contains"
  | "registers_prefix"
  | "defines_api"
  | "binds_handler"
  | "calls_api"
  | "uses_task"
  | "uses_client_call"
  | "tests_api"
  | "depends_on"
  | "defines_function"    // V2: file → function
  | "invokes"             // V2: function → function (same-file)
  | "imports"             // V3: file → file (module import)
  | "invokes_qualified";  // V3: function → function (cross-file via module.method())

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
  | "derived_transitive_link"
  | "ast_function_definition"  // V2: tree-sitter found function def
  | "ast_function_call"        // V2: tree-sitter found function call
  | "ast_import_statement"     // V3: tree-sitter found import
  | "ast_qualified_call";      // V3: tree-sitter found module.method() call

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
  // V2: function-level tracking
  functions?: GraphNode[];
  functionCallers?: Array<{
    node: GraphNode;
    confidence: number;
    path: string;
  }>;
}

// V2: Extracted function info from Python AST
export interface ExtractedFunction {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  calls: string[];  // names of functions called within this function
  qualifiedCalls: ExtractedQualifiedCall[];  // V3: module.method() calls
}

// V3: Import statement info
export interface ExtractedImport {
  filePath: string;           // file containing the import
  importedSymbol: string;     // "transaction_service", "common_func"
  fromModule: string | null;  // "transaction", "util.utils" (null for plain import)
  alias: string | null;       // "ts" if aliased
  isRelative: boolean;        // true for "from . import X"
}

// V3: Qualified call info (module.method())
export interface ExtractedQualifiedCall {
  callerFilePath: string;     // file containing the call
  callerFunction: string;     // function making the call
  objectName: string;         // "transaction_service"
  methodName: string;         // "create_transaction"
  line: number;               // line number of the call
}
