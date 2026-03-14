/**
 * Standalone MCP stdio server for the Impact Graph.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (newline-delimited).
 * Cursor reads .cursor/mcp.json and spawns this process automatically.
 *
 * Workspace root is resolved from:
 *   1. WORKSPACE_ROOT env var (explicit override)
 *   2. process.cwd() (Cursor sets CWD = workspace root)
 */
import * as readline from "readline";
import { GraphStore } from "./core/graph-store";

// Support single root (WORKSPACE_ROOT) or multiple comma-separated roots
// (WORKSPACE_ROOTS). The first root is used for DB storage.
const rawRoots = (process.env.WORKSPACE_ROOTS ?? process.env.WORKSPACE_ROOT ?? process.cwd())
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

const primaryRoot = rawRoots[0];
const workspaceRoots: string | string[] = rawRoots.length === 1 ? rawRoots[0] : rawRoots;

let store: GraphStore | null = null;
let engine: import("./core/engine").ImpactGraphEngine | null = null;

function getStore(): GraphStore {
  if (!store) {
    store = new GraphStore(primaryRoot);
  }
  return store;
}

function getEngine(): import("./core/engine").ImpactGraphEngine {
  if (!engine) {
    const { ImpactGraphEngine } = require("./core/engine") as typeof import("./core/engine");
    engine = new ImpactGraphEngine(workspaceRoots, getStore());
  }
  return engine;
}

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "query_impact",
    description:
      "Full impact analysis for an API, handler, or Python function. Returns affected APIs, handlers, callers, and test files. " +
      "V2: Now supports function queries — e.g. 'common_func' will trace function → handler → API → test chain. " +
      "Use this when asked to fix/modify any API or function — it tells you exactly what to change and what tests to update.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "API path (e.g. /list_all or GET /list_all), handler function name (e.g. list_transactions), " +
            "or any Python function name (e.g. common_func, validate_data)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_apis",
    description:
      "List all tracked API endpoints across all projects. Use to discover available APIs before querying impact.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Optional: filter by project name or project ID substring",
        },
      },
    },
  },
  {
    name: "list_functions",
    description:
      "V2: List all tracked Python functions. Use to discover internal functions that may affect APIs. " +
      "Useful when user asks about function dependencies or wants to see what functions exist in a project.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Optional: filter by project name or project ID substring",
        },
        file: {
          type: "string",
          description: "Optional: filter by source file path (e.g. 'utils.py' or 'controller')",
        },
      },
    },
  },
  {
    name: "find_tests",
    description:
      "Find test files that cover a specific API, handler, or function. More focused than query_impact — returns only tests.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "API path, handler name, or function name",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "graph_status",
    description:
      "Check if the impact graph has been built and show statistics (projects, files, nodes, edges, functions). " +
      "Call this first if unsure whether the graph is ready.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "build_graph",
    description:
      "Trigger a full rebuild of the impact graph across all configured workspace roots. " +
      "V2: Now includes Python function extraction with tree-sitter for function-level tracking. " +
      "Use when: (1) graph is empty/outdated after code changes, (2) first-time setup, (3) after adding new projects. " +
      "Returns status after build completes.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const s = getStore();

  switch (name) {
    case "query_impact":
      return s.getImpact(args.query as string);

    case "list_apis": {
      const apis = s.getAllApis();
      if (args.project) {
        const filter = (args.project as string).toLowerCase();
        return apis.filter(
          (a) => a.projectId.toLowerCase().includes(filter) || a.name.toLowerCase().includes(filter),
        );
      }
      return apis;
    }

    case "list_functions": {
      const functions = s.getAllFunctions();
      let filtered = functions;

      if (args.project) {
        const filter = (args.project as string).toLowerCase();
        filtered = filtered.filter(
          (f) => f.projectId.toLowerCase().includes(filter) || f.name.toLowerCase().includes(filter),
        );
      }

      if (args.file) {
        const fileFilter = (args.file as string).toLowerCase();
        filtered = filtered.filter((f) => f.sourcePath.toLowerCase().includes(fileFilter));
      }

      return filtered;
    }

    case "find_tests": {
      const impact = s.getImpact(args.query as string);
      return { query: impact.query, tests: impact.tests };
    }

    case "graph_status": {
      const status = s.getStatus();
      const functionCount = s.getAllFunctions().length;
      return { ...status, functions: functionCount, roots: rawRoots };
    }

    case "build_graph": {
      const status = await getEngine().buildAll();
      const functionCount = s.getAllFunctions().length;
      return { ...status, functions: functionCount, roots: rawRoots, message: "Graph rebuilt successfully." };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC transport (stdio)
// ---------------------------------------------------------------------------

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (raw) => {
  const line = raw.trim();
  if (!line) return;

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  const { id, method, params } = msg as {
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };

  if (method === "initialize") {
    reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "impact-graph", version: "0.1.0" },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    reply(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const toolName = p.name ?? "";
    const toolArgs = p.arguments ?? {};

    callTool(toolName, toolArgs).then((result) => {
      reply(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    }).catch((err: unknown) => {
      replyError(id, -32603, String(err));
    });
    return;
  }

  if (id !== undefined) {
    replyError(id, -32601, `Method not found: ${String(method)}`);
  }
});

process.on("SIGINT", () => {
  store?.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  store?.close();
  process.exit(0);
});
