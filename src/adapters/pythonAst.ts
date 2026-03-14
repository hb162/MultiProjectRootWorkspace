/**
 * V2/V3 Adapter: Extract Python function definitions, call relationships,
 * imports, and qualified calls using tree-sitter for accurate AST parsing.
 *
 * V2: Function definitions and same-file calls
 * V3: Import statements and cross-file qualified calls (module.method())
 *
 * Falls back to regex if tree-sitter fails to load (ABI mismatch, etc.)
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ExtractedFunction, ExtractedImport, ExtractedQualifiedCall, GraphEdge, GraphNode, ProjectContext } from "../core/types";
import { stableId } from "../core/utils";

// Tree-sitter types (loaded dynamically to handle ABI issues)
interface TreeSitterParser {
  setLanguage(lang: unknown): void;
  parse(code: string): TreeSitterTree;
}

interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

interface TreeSitterNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: TreeSitterNode[];
  namedChildren: TreeSitterNode[];
  childForFieldName(name: string): TreeSitterNode | null;
}

let treeSitterParser: TreeSitterParser | null = null;
let treeSitterAvailable: boolean | null = null;

async function getParser(): Promise<TreeSitterParser | null> {
  if (treeSitterAvailable === false) {
    return null;
  }

  if (treeSitterParser) {
    return treeSitterParser;
  }

  try {
    // Dynamic require to handle ABI mismatch gracefully
    const Parser = require("tree-sitter") as new () => TreeSitterParser;
    const Python = require("tree-sitter-python") as unknown;

    const parser = new Parser();
    parser.setLanguage(Python);
    treeSitterParser = parser;
    treeSitterAvailable = true;
    return parser;
  } catch (err) {
    console.warn("[PythonAstAdapter] tree-sitter load failed, falling back to regex:", err);
    treeSitterAvailable = false;
    return null;
  }
}

/**
 * Extract function definitions and calls using tree-sitter AST.
 */
function extractFunctionsFromAst(tree: TreeSitterTree, filePath: string): ExtractedFunction[] {
  const functions: ExtractedFunction[] = [];
  const root = tree.rootNode;

  // Find all function_definition nodes
  const functionDefs = findNodes(root, "function_definition");

  for (const funcNode of functionDefs) {
    const nameNode = funcNode.childForFieldName("name");
    if (!nameNode) continue;

    const funcName = nameNode.text;
    const startLine = funcNode.startPosition.row + 1; // 1-indexed
    const endLine = funcNode.endPosition.row + 1;

    // Find all calls within this function's body
    const bodyNode = funcNode.childForFieldName("body");
    const calls: string[] = [];
    const qualifiedCalls: ExtractedQualifiedCall[] = [];

    if (bodyNode) {
      const callNodes = findNodes(bodyNode, "call");
      for (const callNode of callNodes) {
        const callInfo = extractCallInfo(callNode);
        if (!callInfo) continue;

        if (callInfo.type === "simple" && callInfo.name !== funcName) {
          calls.push(callInfo.name);
        } else if (callInfo.type === "qualified") {
          qualifiedCalls.push({
            callerFilePath: filePath,
            callerFunction: funcName,
            objectName: callInfo.objectName,
            methodName: callInfo.methodName,
            line: callNode.startPosition.row + 1,
          });
        }
      }
    }

    functions.push({
      name: funcName,
      filePath,
      startLine,
      endLine,
      calls: [...new Set(calls)],
      qualifiedCalls,
    });
  }

  return functions;
}

/**
 * V3: Extract import statements from AST.
 */
function extractImportsFromAst(tree: TreeSitterTree, filePath: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const root = tree.rootNode;

  // Find import_statement: import X, import X as Y
  const importStmts = findNodes(root, "import_statement");
  for (const stmt of importStmts) {
    const names = findNodes(stmt, "dotted_name");
    const aliases = findNodes(stmt, "aliased_import");

    if (aliases.length > 0) {
      for (const alias of aliases) {
        const nameNode = alias.childForFieldName("name");
        const aliasNode = alias.childForFieldName("alias");
        if (nameNode) {
          imports.push({
            filePath,
            importedSymbol: nameNode.text,
            fromModule: null,
            alias: aliasNode?.text ?? null,
            isRelative: false,
          });
        }
      }
    } else {
      for (const name of names) {
        imports.push({
          filePath,
          importedSymbol: name.text,
          fromModule: null,
          alias: null,
          isRelative: false,
        });
      }
    }
  }

  // Find import_from_statement: from X import Y, from . import Y
  const fromStmts = findNodes(root, "import_from_statement");
  for (const stmt of fromStmts) {
    const moduleNode = stmt.childForFieldName("module_name");
    const fromModule = moduleNode?.text ?? null;

    // Check for relative import (starts with .)
    const stmtText = stmt.text;
    const isRelative = stmtText.startsWith("from .") || stmtText.startsWith("from ..");

    // Get imported names
    const importedNames: Array<{ symbol: string; alias: string | null }> = [];

    const aliasedImports = findNodes(stmt, "aliased_import");
    if (aliasedImports.length > 0) {
      for (const alias of aliasedImports) {
        const nameNode = alias.childForFieldName("name");
        const aliasNode = alias.childForFieldName("alias");
        if (nameNode) {
          importedNames.push({
            symbol: nameNode.text,
            alias: aliasNode?.text ?? null,
          });
        }
      }
    } else {
      // Non-aliased imports in from...import
      const identifiers = stmt.namedChildren.filter(
        (c) => c.type === "dotted_name" && c !== moduleNode,
      );
      for (const id of identifiers) {
        importedNames.push({ symbol: id.text, alias: null });
      }
    }

    for (const { symbol, alias } of importedNames) {
      imports.push({
        filePath,
        importedSymbol: symbol,
        fromModule,
        alias,
        isRelative,
      });
    }
  }

  return imports;
}

/**
 * V3: Extract call info including qualified calls.
 */
interface CallInfo {
  type: "simple" | "qualified";
  name: string;
  objectName: string;
  methodName: string;
}

function extractCallInfo(callNode: TreeSitterNode): CallInfo | null {
  const funcNode = callNode.childForFieldName("function");
  if (!funcNode) return null;

  // Simple call: func()
  if (funcNode.type === "identifier") {
    return {
      type: "simple",
      name: funcNode.text,
      objectName: "",
      methodName: "",
    };
  }

  // Attribute call: obj.method() — V3: track as qualified call
  if (funcNode.type === "attribute") {
    const objectNode = funcNode.childForFieldName("object");
    const attrNode = funcNode.childForFieldName("attribute");

    if (objectNode && attrNode) {
      // Only track if object is a simple identifier (module.method)
      // Skip chained calls like obj.foo.bar()
      if (objectNode.type === "identifier") {
        return {
          type: "qualified",
          name: attrNode.text,
          objectName: objectNode.text,
          methodName: attrNode.text,
        };
      }
    }

    // Fallback: return method name for V2 compatibility
    return attrNode
      ? { type: "simple", name: attrNode.text, objectName: "", methodName: "" }
      : null;
  }

  return null;
}

/**
 * Recursively find all nodes of a given type.
 */
function findNodes(node: TreeSitterNode, type: string): TreeSitterNode[] {
  const results: TreeSitterNode[] = [];

  if (node.type === type) {
    results.push(node);
  }

  for (const child of node.children) {
    results.push(...findNodes(child, type));
  }

  return results;
}

// extractCallName removed — replaced by extractCallInfo in V3

/**
 * Fallback: regex-based extraction (less accurate but always works).
 */
function extractFunctionsWithRegex(code: string, filePath: string): ExtractedFunction[] {
  const functions: ExtractedFunction[] = [];
  const lines = code.split("\n");

  // Match function definitions: def func_name(
  const defPattern = /^(\s*)def\s+(\w+)\s*\(/;
  let currentFunc: {
    name: string;
    startLine: number;
    indent: number;
    calls: string[];
    qualifiedCalls: ExtractedQualifiedCall[];
  } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const defMatch = defPattern.exec(line);

    if (defMatch) {
      // Save previous function
      if (currentFunc) {
        functions.push({
          name: currentFunc.name,
          filePath,
          startLine: currentFunc.startLine,
          endLine: i,
          calls: [...new Set(currentFunc.calls)],
          qualifiedCalls: currentFunc.qualifiedCalls,
        });
      }

      currentFunc = {
        name: defMatch[2],
        startLine: i + 1,
        indent: defMatch[1].length,
        calls: [],
        qualifiedCalls: [],
      };
    } else if (currentFunc) {
      // Inside a function — look for calls
      // Simple call: word followed by (
      const simpleCallPattern = /\b(\w+)\s*\(/g;
      let callMatch: RegExpExecArray | null;
      while ((callMatch = simpleCallPattern.exec(line)) !== null) {
        const callName = callMatch[1];
        const keywords = new Set([
          "if", "for", "while", "with", "except", "def", "class", "return",
          "print", "len", "str", "int", "float", "list", "dict", "set",
          "tuple", "range", "isinstance", "type", "open", "super",
        ]);
        if (!keywords.has(callName) && callName !== currentFunc.name) {
          currentFunc.calls.push(callName);
        }
      }

      // V3: Qualified call: module.method(
      const qualifiedCallPattern = /\b(\w+)\.(\w+)\s*\(/g;
      let qMatch: RegExpExecArray | null;
      while ((qMatch = qualifiedCallPattern.exec(line)) !== null) {
        currentFunc.qualifiedCalls.push({
          callerFilePath: filePath,
          callerFunction: currentFunc.name,
          objectName: qMatch[1],
          methodName: qMatch[2],
          line: i + 1,
        });
      }
    }
  }

  // Don't forget the last function
  if (currentFunc) {
    functions.push({
      name: currentFunc.name,
      filePath,
      startLine: currentFunc.startLine,
      endLine: lines.length,
      calls: [...new Set(currentFunc.calls)],
      qualifiedCalls: currentFunc.qualifiedCalls,
    });
  }

  return functions;
}

/**
 * V3: Fallback regex import extraction.
 */
function extractImportsWithRegex(code: string, filePath: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const lines = code.split("\n");

  for (const line of lines) {
    // from X import Y, from X import Y as Z
    const fromMatch = /^\s*from\s+(\.{0,2}[\w.]*)\s+import\s+(.+)$/.exec(line);
    if (fromMatch) {
      const fromModule = fromMatch[1] || null;
      const isRelative = fromMatch[1].startsWith(".");
      const importPart = fromMatch[2];

      // Handle multiple imports: from X import A, B as C
      const parts = importPart.split(",").map((p) => p.trim());
      for (const part of parts) {
        const asMatch = /^(\w+)\s+as\s+(\w+)$/.exec(part);
        if (asMatch) {
          imports.push({
            filePath,
            importedSymbol: asMatch[1],
            fromModule,
            alias: asMatch[2],
            isRelative,
          });
        } else {
          const symbolMatch = /^(\w+)$/.exec(part);
          if (symbolMatch) {
            imports.push({
              filePath,
              importedSymbol: symbolMatch[1],
              fromModule,
              alias: null,
              isRelative,
            });
          }
        }
      }
      continue;
    }

    // import X, import X as Y
    const importMatch = /^\s*import\s+(.+)$/.exec(line);
    if (importMatch) {
      const parts = importMatch[1].split(",").map((p) => p.trim());
      for (const part of parts) {
        const asMatch = /^([\w.]+)\s+as\s+(\w+)$/.exec(part);
        if (asMatch) {
          imports.push({
            filePath,
            importedSymbol: asMatch[1],
            fromModule: null,
            alias: asMatch[2],
            isRelative: false,
          });
        } else {
          const symbolMatch = /^([\w.]+)$/.exec(part);
          if (symbolMatch) {
            imports.push({
              filePath,
              importedSymbol: symbolMatch[1],
              fromModule: null,
              alias: null,
              isRelative: false,
            });
          }
        }
      }
    }
  }

  return imports;
}

export class PythonAstAdapter {
  /**
   * Extract function definitions, calls, and imports from Python files.
   * V2: functions + same-file calls
   * V3: imports + qualified cross-file calls
   */
  async extract(
    project: ProjectContext,
    files: string[],
  ): Promise<{
    nodes: GraphNode[];
    edges: GraphEdge[];
    functions: ExtractedFunction[];
    imports: ExtractedImport[];
  }> {
    const pythonFiles = files.filter((f) => f.endsWith(".py"));
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const allFunctions: ExtractedFunction[] = [];
    const allImports: ExtractedImport[] = [];

    const parser = await getParser();

    for (const filePath of pythonFiles) {
      try {
        const code = await fs.readFile(filePath, "utf8");

        // V2: Functions
        const functions = parser
          ? extractFunctionsFromAst(parser.parse(code), filePath)
          : extractFunctionsWithRegex(code, filePath);
        allFunctions.push(...functions);

        // V3: Imports
        const imports = parser
          ? extractImportsFromAst(parser.parse(code), filePath)
          : extractImportsWithRegex(code, filePath);
        allImports.push(...imports);

        const fileId = stableId(project.id, "file", filePath);

        // Create function nodes
        for (const func of functions) {
          const funcId = stableId(project.id, "function", filePath, func.name);

          nodes.push({
            id: funcId,
            kind: "function",
            name: func.name,
            projectId: project.id,
            sourcePath: filePath,
            language: "python",
            data: {
              startLine: func.startLine,
              endLine: func.endLine,
            },
          });

          // file → function edge
          edges.push({
            id: stableId(project.id, "defines_function", fileId, funcId),
            kind: "defines_function",
            fromId: fileId,
            toId: funcId,
            projectId: project.id,
            sourcePath: filePath,
            confidence: 0.98,
            evidenceType: parser ? "ast_function_definition" : "direct_http_string_match",
            evidenceScore: parser ? 0.98 : 0.75,
          });
        }
      } catch (err) {
        // Skip unreadable files
        console.warn(`[PythonAstAdapter] Failed to parse ${filePath}:`, err);
      }
    }

    return { nodes, edges, functions: allFunctions, imports: allImports };
  }

  /**
   * Create invokes edges between functions based on call relationships.
   * Must be called after all function nodes are created.
   */
  linkFunctionCalls(
    projectId: string,
    functions: ExtractedFunction[],
    functionNodes: GraphNode[],
  ): GraphEdge[] {
    const edges: GraphEdge[] = [];

    // Build lookup: function name → node
    const funcByName = new Map<string, GraphNode>();
    for (const node of functionNodes) {
      if (node.kind === "function") {
        funcByName.set(node.name, node);
      }
    }

    // Create invokes edges
    for (const func of functions) {
      const callerNode = funcByName.get(func.name);
      if (!callerNode) continue;

      for (const calleeName of func.calls) {
        const calleeNode = funcByName.get(calleeName);
        if (!calleeNode) continue;

        edges.push({
          id: stableId(projectId, "invokes", callerNode.id, calleeNode.id),
          kind: "invokes",
          fromId: callerNode.id,
          toId: calleeNode.id,
          projectId,
          sourcePath: callerNode.sourcePath,
          confidence: 0.92,
          evidenceType: "ast_function_call",
          evidenceScore: 0.92,
        });
      }
    }

    return edges;
  }

  /**
   * Check if tree-sitter is available.
   */
  async isTreeSitterAvailable(): Promise<boolean> {
    const parser = await getParser();
    return parser !== null;
  }

  /**
   * V3: Resolve module path from import to absolute file path.
   */
  resolveModulePath(
    imp: ExtractedImport,
    projectRoot: string,
    allPythonFiles: string[],
  ): string | null {
    // Build symbol to look for
    let modulePath: string;

    if (imp.fromModule) {
      // from transaction import transaction_service
      // → look for transaction/transaction_service.py or transaction.py with transaction_service function
      if (imp.isRelative) {
        // Relative import: from . import X or from .. import X
        const importerDir = path.dirname(imp.filePath);
        const dots = imp.fromModule.match(/^\.+/)?.[0] ?? ".";
        const levels = dots.length;
        let baseDir = importerDir;
        for (let i = 1; i < levels; i++) {
          baseDir = path.dirname(baseDir);
        }
        const restModule = imp.fromModule.slice(levels);
        modulePath = restModule
          ? path.join(baseDir, restModule.replace(/\./g, "/"), imp.importedSymbol)
          : path.join(baseDir, imp.importedSymbol);
      } else {
        // Absolute import: from transaction import transaction_service
        modulePath = path.join(
          projectRoot,
          imp.fromModule.replace(/\./g, "/"),
          imp.importedSymbol,
        );
      }
    } else {
      // import transaction_service
      modulePath = path.join(projectRoot, imp.importedSymbol.replace(/\./g, "/"));
    }

    // Try to find matching file
    const candidates = [
      `${modulePath}.py`,
      path.join(modulePath, "__init__.py"),
    ];

    for (const candidate of candidates) {
      if (allPythonFiles.includes(candidate)) {
        return candidate;
      }
    }

    // Fallback: fuzzy match by filename stem
    const targetStem = path.basename(modulePath);
    const fuzzyMatch = allPythonFiles.find((f) => {
      const stem = path.basename(f, ".py");
      return stem === targetStem || stem === imp.importedSymbol;
    });

    return fuzzyMatch ?? null;
  }

  /**
   * V3: Create imports edges (file → file) and invokes_qualified edges.
   */
  linkImportsAndQualifiedCalls(
    projectId: string,
    imports: ExtractedImport[],
    functions: ExtractedFunction[],
    functionNodes: GraphNode[],
    projectRoot: string,
    allPythonFiles: string[],
  ): GraphEdge[] {
    const edges: GraphEdge[] = [];

    // Build symbol → resolved file path map
    const symbolToFile = new Map<string, string>();
    for (const imp of imports) {
      const resolvedPath = this.resolveModulePath(imp, projectRoot, allPythonFiles);
      if (resolvedPath) {
        const symbolName = imp.alias ?? imp.importedSymbol;
        // Key by (importer file, symbol name)
        symbolToFile.set(`${imp.filePath}:${symbolName}`, resolvedPath);

        // Create imports edge: file → file
        const fromFileId = stableId(projectId, "file", imp.filePath);
        const toFileId = stableId(projectId, "file", resolvedPath);

        if (imp.filePath !== resolvedPath) {
          edges.push({
            id: stableId(projectId, "imports", fromFileId, toFileId, imp.importedSymbol),
            kind: "imports",
            fromId: fromFileId,
            toId: toFileId,
            projectId,
            sourcePath: imp.filePath,
            confidence: 0.95,
            evidenceType: "ast_import_statement",
            evidenceScore: 0.95,
            data: {
              importedSymbol: imp.importedSymbol,
              alias: imp.alias ?? "",
            },
          });
        }
      }
    }

    // Build function lookup: (filePath, functionName) → node
    const funcLookup = new Map<string, GraphNode>();
    for (const node of functionNodes) {
      if (node.kind === "function") {
        funcLookup.set(`${node.sourcePath}:${node.name}`, node);
      }
    }

    // Create invokes_qualified edges from qualified calls
    for (const func of functions) {
      const callerNode = funcLookup.get(`${func.filePath}:${func.name}`);
      if (!callerNode) continue;

      for (const qcall of func.qualifiedCalls) {
        // Look up which file the object name points to
        const targetFilePath = symbolToFile.get(`${qcall.callerFilePath}:${qcall.objectName}`);
        if (!targetFilePath) continue;

        // Find target function in that file
        const targetNode = funcLookup.get(`${targetFilePath}:${qcall.methodName}`);
        if (!targetNode) continue;

        // Don't create edge to self
        if (callerNode.id === targetNode.id) continue;

        edges.push({
          id: stableId(projectId, "invokes_qualified", callerNode.id, targetNode.id),
          kind: "invokes_qualified",
          fromId: callerNode.id,
          toId: targetNode.id,
          projectId,
          sourcePath: callerNode.sourcePath,
          confidence: 0.88,
          evidenceType: "ast_qualified_call",
          evidenceScore: 0.88,
          data: {
            objectName: qcall.objectName,
            line: qcall.line,
          },
        });
      }
    }

    return edges;
  }
}
