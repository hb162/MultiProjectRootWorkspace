import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GraphEdge, GraphNode, ProjectContext } from "../core/types";
import { detectLanguage, normalizeApiPath, stableId } from "../core/utils";

interface FlaskRoute {
  controllerPath: string;
  controllerName: string;
  handlerName: string;
  relativePath: string;
  fullPath: string;
  httpMethod: string;
}

export class FlaskAdapter {
  public async extract(project: ProjectContext, files: string[]): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const pythonFiles = files.filter((file) => detectLanguage(file) === "python");
    if (!pythonFiles.length) {
      return { nodes: [], edges: [] };
    }

    const prefixMap = await this.extractPrefixMap(pythonFiles);
    const routes = await this.extractRoutes(project, pythonFiles, prefixMap);

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    for (const route of routes) {
      const controllerId = stableId(project.id, "controller", route.controllerPath);
      const fileId = stableId(project.id, "file", route.controllerPath);
      const handlerId = stableId(project.id, "handler", route.controllerPath, route.handlerName);
      const apiId = stableId(project.id, "api", route.httpMethod, route.fullPath);

      nodes.push(
        {
          id: fileId,
          kind: "file",
          name: path.basename(route.controllerPath),
          projectId: project.id,
          sourcePath: route.controllerPath,
          language: "python",
          framework: "flask",
        },
        {
          id: controllerId,
          kind: "controller",
          name: route.controllerName,
          projectId: project.id,
          sourcePath: route.controllerPath,
          language: "python",
          framework: "flask",
        },
        {
          id: handlerId,
          kind: "handler",
          name: route.handlerName,
          projectId: project.id,
          sourcePath: route.controllerPath,
          language: "python",
          framework: "flask",
        },
        {
          id: apiId,
          kind: "api",
          name: `${route.httpMethod} ${route.fullPath}`,
          projectId: project.id,
          sourcePath: route.controllerPath,
          language: "python",
          framework: "flask",
          normalizedPath: route.fullPath,
          httpMethod: route.httpMethod,
        },
      );

      edges.push(
        this.edge(project.id, "contains", fileId, controllerId, route.controllerPath, 0.99, "route_registration"),
        this.edge(project.id, "contains", fileId, handlerId, route.controllerPath, 0.99, "route_registration"),
        this.edge(project.id, "contains", fileId, apiId, route.controllerPath, 0.99, "route_registration"),
        this.edge(project.id, "defines_api", controllerId, apiId, route.controllerPath, 0.98, "route_registration", {
          relativePath: route.relativePath,
        }),
        this.edge(project.id, "binds_handler", apiId, handlerId, route.controllerPath, 0.98, "route_registration"),
      );
    }

    return { nodes, edges };
  }

  private async extractPrefixMap(files: string[]): Promise<Map<string, string>> {
    const prefixMap = new Map<string, string>();
    const appFiles = files.filter((file) => path.basename(file) === "app.py");

    for (const filePath of appFiles) {
      const text = await fs.readFile(filePath, "utf8");
      const tupleRegex = /\(\s*([A-Za-z_][\w]*)\s*,\s*["']([^"']+)["']\s*\)/g;
      let match: RegExpExecArray | null = tupleRegex.exec(text);

      while (match) {
        prefixMap.set(match[1], normalizeApiPath(match[2]));
        match = tupleRegex.exec(text);
      }
    }

    return prefixMap;
  }

  private async extractRoutes(
    project: ProjectContext,
    files: string[],
    prefixMap: Map<string, string>,
  ): Promise<FlaskRoute[]> {
    const routes: FlaskRoute[] = [];
    const routeDecoratorRegex = /^\s*@([\w]+)\.(route|get|post|put|patch|delete)\(\s*["']([^"']+)["'](.*)$/;
    const defRegex = /^\s*def\s+([A-Za-z_]\w*)/;

    for (const filePath of files) {
      const text = await fs.readFile(filePath, "utf8");
      const lines = text.split("\n");

      for (let index = 0; index < lines.length; index += 1) {
        const match = routeDecoratorRegex.exec(lines[index]);
        if (!match) {
          continue;
        }

        const controllerName = path.basename(filePath, ".py");
        const routeSymbol = match[1];
        const prefix =
          prefixMap.get(routeSymbol) ??
          prefixMap.get(controllerName) ??
          prefixMap.get(controllerName.replace(/_controller$/, "")) ??
          "";
        const relativePath = normalizeApiPath(match[3]);
        const decoratorKind = (match[2] ?? "").toUpperCase();
        const methodsMatch = /methods\s*=\s*\[([^\]]+)\]/.exec(match[4] ?? "");
        const explicitMethods = methodsMatch?.[1]
          ? Array.from(methodsMatch[1].matchAll(/["']([A-Z]+)["']/g)).map((item) => item[1])
          : [];
        const methods = decoratorKind && decoratorKind !== "ROUTE" ? [decoratorKind] : explicitMethods.length ? explicitMethods : ["GET"];
        const handlerName = this.findNextHandler(lines, index + 1, defRegex);
        if (!handlerName) {
          continue;
        }

        for (const httpMethod of methods) {
          routes.push({
            controllerPath: filePath,
            controllerName,
            handlerName,
            relativePath,
            fullPath: normalizeApiPath(`${prefix}${relativePath}`),
            httpMethod,
          });
        }
      }
    }
    return routes;
  }

  private findNextHandler(lines: string[], startIndex: number, defRegex: RegExp): string | undefined {
    for (let index = startIndex; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) {
        continue;
      }
      if (line.startsWith("@")) {
        continue;
      }
      const match = defRegex.exec(line);
      return match?.[1];
    }
    return undefined;
  }

  private edge(
    projectId: string,
    kind: GraphEdge["kind"],
    fromId: string,
    toId: string,
    sourcePath: string,
    confidence: number,
    evidenceType: GraphEdge["evidenceType"],
    data?: Record<string, string>,
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
      data,
    };
  }
}
