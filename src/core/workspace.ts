import * as fs from "node:fs/promises";
import * as path from "node:path";
import { detectLanguage, toPosixPath } from "./utils";
import { ProjectContext } from "./types";

const DEFAULT_MANIFESTS = ["pyproject.toml", "package.json", "pom.xml", "go.mod"];
const DEFAULT_IGNORES = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  "coverage",
  "target",
  "bin",
  "vendor",
]);

export async function discoverProjects(fallbackWorkspaceRoot?: string | string[]): Promise<ProjectContext[]> {
  const vscodeApi = getVscodeApi();

  let folders: Array<{ uri: { fsPath: string }; name: string; index: number }>;

  if (vscodeApi?.workspace.workspaceFolders) {
    // Running inside VS Code / Kiro — use all workspace folders (multi-root aware).
    folders = vscodeApi.workspace.workspaceFolders;
  } else if (Array.isArray(fallbackWorkspaceRoot)) {
    // Standalone mode (MCP server) with multiple roots provided explicitly.
    folders = fallbackWorkspaceRoot.map((p, i) => ({
      uri: { fsPath: p },
      name: path.basename(p),
      index: i,
    }));
  } else if (fallbackWorkspaceRoot) {
    folders = [{ uri: { fsPath: fallbackWorkspaceRoot }, name: path.basename(fallbackWorkspaceRoot), index: 0 }];
  } else {
    folders = [];
  }
  const discovered: ProjectContext[] = [];

  for (const folder of folders) {
    const workspaceRoot = folder.uri.fsPath;
    const projectRoots = await discoverProjectRoots(workspaceRoot);

    for (const rootPath of projectRoots) {
      const manifestPath = await firstExistingManifest(rootPath);
      const hints = manifestPath ? languageAndFrameworkHints(manifestPath) : { languages: [], frameworks: [] };
      discovered.push({
        id: toPosixPath(rootPath),
        name: path.basename(rootPath),
        rootPath,
        workspaceRoot,
        manifestPath,
        languageHints: hints.languages,
        frameworkHints: hints.frameworks,
      });
    }
  }

  return discovered;
}

async function discoverProjectRoots(workspaceRoot: string): Promise<string[]> {
  const config = getConfiguration();
  const manifestNames = new Set<string>(config.get("projectManifestFiles", DEFAULT_MANIFESTS));
  const ignored = new Set<string>(config.get("ignoreDirectories", Array.from(DEFAULT_IGNORES)));
  const candidates = new Set<string>();

  async function walk(currentPath: string, depth: number): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    let foundManifest = false;

    for (const entry of entries) {
      if (entry.isFile() && manifestNames.has(entry.name)) {
        foundManifest = true;
      }
    }

    if (foundManifest) {
      candidates.add(currentPath);
    }

    if (depth >= 2) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || ignored.has(entry.name)) {
        continue;
      }
      await walk(path.join(currentPath, entry.name), depth + 1);
    }
  }

  await walk(workspaceRoot, 0);

  if (!candidates.size) {
    candidates.add(workspaceRoot);
  }

  return Array.from(candidates).sort();
}

async function firstExistingManifest(projectRoot: string): Promise<string | undefined> {
  const manifestNames = getConfiguration().get("projectManifestFiles", DEFAULT_MANIFESTS);
  for (const name of manifestNames) {
    const candidate = path.join(projectRoot, name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function languageAndFrameworkHints(manifestPath: string): { languages: string[]; frameworks: string[] } {
  const fileName = path.basename(manifestPath);
  switch (fileName) {
    case "pyproject.toml":
      return { languages: ["python"], frameworks: ["flask"] };
    case "package.json":
      return { languages: ["javascript", "typescript"], frameworks: ["express", "nest"] };
    case "pom.xml":
      return { languages: ["java"], frameworks: ["spring", "serenity"] };
    case "go.mod":
      return { languages: ["go"], frameworks: ["gin", "net/http"] };
    default:
      return { languages: [detectLanguage(manifestPath)], frameworks: [] };
  }
}

export async function listSourceFiles(projectRoot: string): Promise<string[]> {
  const config = getConfiguration();
  const ignored = new Set<string>(config.get("ignoreDirectories", Array.from(DEFAULT_IGNORES)));
  const files: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) {
          await walk(path.join(currentPath, entry.name));
        }
        continue;
      }

      const fullPath = path.join(currentPath, entry.name);
      const language = detectLanguage(fullPath);
      // Include source files + CSV/TXT test data files inside test directories
      const isTestData = /\.(csv|txt)$/i.test(entry.name) && /[/\\](test|tests|features)[/\\]/.test(fullPath);
      if (language !== "unknown" || isTestData) {
        files.push(fullPath);
      }
    }
  }

  await walk(projectRoot);
  return files.sort();
}

function getVscodeApi():
  | {
      workspace: {
        workspaceFolders?: Array<{ uri: { fsPath: string }; name: string; index: number }>;
        getConfiguration: (section: string) => { get: <T>(key: string, defaultValue: T) => T };
      };
    }
  | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("vscode");
  } catch {
    return undefined;
  }
}

function getConfiguration(): { get: <T>(key: string, defaultValue: T) => T } {
  return (
    getVscodeApi()?.workspace.getConfiguration("impactGraph") ?? {
      get: <T>(_key: string, defaultValue: T) => defaultValue,
    }
  );
}
