import * as vscode from "vscode";
import { COMMAND_IDS, CommandContext, CommandRegistry, SavedContextPayload } from "./commands";
import { ImpactGraphEngine } from "./core/engine";
import { GraphStore } from "./core/graph-store";

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.globalStorageUri.fsPath;
  const contextDirectory = vscode.workspace.getConfiguration("impactGraph").get<string>("contextDirectory", ".ai/kg/context");
  const output = vscode.window.createOutputChannel("Impact Graph");

  // Lazy-init: defer GraphStore/Engine creation to first command use so that
  // commands are always registered even if the SQLite backend fails to load.
  let store: GraphStore | null = null;
  let engine: ImpactGraphEngine | null = null;
  let registry: CommandRegistry | null = null;
  let initError: string | null = null;
  // Cache the pending init promise to prevent double-initialisation on
  // concurrent command invocations.
  let initPromise: Promise<CommandRegistry | null> | null = null;

  async function getRegistry(): Promise<CommandRegistry | null> {
    if (registry) return registry;
    if (initError) return null;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        store = await GraphStore.create(workspaceRoot, contextDirectory);
        engine = new ImpactGraphEngine(workspaceRoot, store);
        registry = new CommandRegistry(engine, store);
        return registry;
      } catch (err) {
        initError = String(err);
        vscode.window.showErrorMessage(`Impact Graph failed to initialize: ${initError}`);
        output.appendLine(`[ERROR] Initialization failed: ${initError}`);
        output.show(true);
        return null;
      }
    })();

    return initPromise;
  }

  context.subscriptions.push(output);
  context.subscriptions.push({ dispose: () => store?.close() });

  const getContext = (): CommandContext => ({
    workspaceRoot,
    activeFilePath: vscode.window.activeTextEditor?.document.uri.fsPath,
    selection: vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection),
  });

  const present = (title: string, body: unknown): void => {
    const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
    output.clear();
    output.appendLine(title);
    output.appendLine("");
    output.appendLine(text);
    output.show(true);
  };

  const prompt = (placeholder: string): Thenable<string | undefined> =>
    vscode.window.showInputBox({ prompt: placeholder, placeHolder: placeholder, ignoreFocusOut: true });

  const register = (commandId: string, handler: () => Promise<void>) => {
    context.subscriptions.push(vscode.commands.registerCommand(commandId, handler));
  };

  register(COMMAND_IDS.bootstrapProjects, async () => {
    const r = await getRegistry(); if (!r) return;
    const result = await r.bootstrapProjects(getContext());
    present("Bootstrapped project roots", { status: "ok", ...result });
  });

  register(COMMAND_IDS.buildFull, async () => {
    const r = await getRegistry(); if (!r) return;
    const result = await r.buildFull(getContext());
    present("Built impact graph", { status: "ok", summary: `Full rebuild completed in ${result.elapsedMs}ms`, ...result });
  });

  register(COMMAND_IDS.refreshChanged, async () => {
    const r = await getRegistry(); if (!r) return;
    const ctx = getContext();
    const result = await r.refreshChanged(ctx);
    const summary = ctx.activeFilePath
      ? `Incremental refresh for ${ctx.activeFilePath.split("/").pop()} in ${result.elapsedMs}ms`
      : `Full rebuild in ${result.elapsedMs}ms`;
    present("Refreshed changed", { status: "ok", summary, ...result });
  });

  register(COMMAND_IDS.findTests, async () => {
    const r = await getRegistry(); if (!r) return;
    const query = await prompt("Find tests for handler, API path, or file");
    if (!query) return;
    const result = r.findTests(query, getContext());
    present("Affected tests", result);
  });

  register(COMMAND_IDS.findCallers, async () => {
    const r = await getRegistry(); if (!r) return;
    const query = await prompt("Find callers for handler or API path");
    if (!query) return;
    const result = r.findCallers(query, getContext());
    present("API callers", result);
  });

  register(COMMAND_IDS.explainImpact, async () => {
    const r = await getRegistry(); if (!r) return;
    const query = await prompt("Explain impact for handler, API path, or file");
    if (!query) return;
    const result = r.explainImpact(query, getContext());
    present("Impact explanation", result);
  });

  register(COMMAND_IDS.showApiMap, async () => {
    const r = await getRegistry(); if (!r) return;
    const query = await prompt("Show API map for controller, task, test, or API path");
    if (!query) return;
    const result = r.showApiMap(query, getContext());
    present("API map", result);
  });

  register(COMMAND_IDS.saveContext, async () => {
    const r = await getRegistry(); if (!r) return;
    const name = await prompt("Context name");
    if (!name) return;
    const ctx = getContext();
    const payload: SavedContextPayload = {
      savedAt: new Date().toISOString(),
      activeFile: ctx.activeFilePath,
      selection: ctx.selection ?? "",
    };
    const result = r.saveContext(name, payload, ctx);
    present("Saved context", { status: "ok", ...result });
  });

  register(COMMAND_IDS.loadContext, async () => {
    const r = await getRegistry(); if (!r) return;
    const name = await prompt("Context name to load");
    if (!name) return;
    const result = r.loadContext(name, getContext());
    present("Loaded context", result);
  });

  register(COMMAND_IDS.graphStatus, async () => {
    const r = await getRegistry(); if (!r) return;
    const result = r.graphStatus(getContext());
    present("Graph status", { status: "ok", ...result });
  });
}

export function deactivate(): void {}
