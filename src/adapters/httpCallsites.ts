import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ExtractedCallSite, ProjectContext } from "../core/types";
import { detectLanguage, fileStem, normalizeApiPath } from "../core/utils";
import { VarMap } from "./javaConfigResolver";

const HTTP_CALL_PATTERNS: Array<{ regex: RegExp; methodGroup?: number; pathGroup: number }> = [
  // .get("/path") — method call with string literal
  { regex: /\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g, methodGroup: 1, pathGroup: 2 },
  // .get(BASE + "/path") or .get(VAR + "/path") — concatenation (Serenity/RestAssured pattern)
  { regex: /\.(get|post|put|patch|delete)\([^)'"]*\+\s*["'`](\/[^"'`]*)["'`]/g, methodGroup: 1, pathGroup: 2 },
  // fetch("/path", { method: "POST" })
  { regex: /\bfetch\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*\{[\s\S]*?method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`][\s\S]*?\})?/g, methodGroup: 2, pathGroup: 1 },
  // GET "/path" — explicit method string
  { regex: /\b(GET|POST|PUT|PATCH|DELETE)\s+["'`]([^"'`]+)["'`]/g, methodGroup: 1, pathGroup: 2 },
  // .path("/path").get() — RestAssured/SerenityRest path builder
  { regex: /\.path\(\s*["'`](\/[^"'`]+)["'`]\s*\)\s*\.\s*(get|post|put|patch|delete)\s*\(/g, methodGroup: 2, pathGroup: 1 },
];

/**
 * Pattern for HTTP calls using variable concatenation:
 *   .get(LOCALHOST + LIST_ALL_USER)
 *   .post(BASE_URL + RiskConfig.CREATE_BOND)
 */
const VAR_HTTP_CALL_PATTERN = /\.(get|post|put|patch|delete)\(\s*[A-Za-z_][\w.]*\s*\+\s*([A-Za-z_][\w.]*)\s*\)/g;

export class HttpCallsiteAdapter {
  public async extract(project: ProjectContext, files: string[], varMap?: VarMap): Promise<ExtractedCallSite[]> {
    const supportedFiles = files.filter((file) => {
      const language = detectLanguage(file);
      return language === "java" || language === "typescript" || language === "javascript" || language === "go";
    });

    const callsites: ExtractedCallSite[] = [];
    for (const filePath of supportedFiles) {
      const text = await fs.readFile(filePath, "utf8");
      const refs = this.extractReferences(text, detectLanguage(filePath));
      const role = this.detectRole(filePath);
      const isTest = this.isTestFile(filePath);

      let matched = false;

      // Existing patterns: string literal HTTP calls
      for (const pattern of HTTP_CALL_PATTERNS) {
        let match: RegExpExecArray | null = pattern.regex.exec(text);
        while (match) {
          matched = true;
          const rawPath = match[pattern.pathGroup];
          const rawMethod = pattern.methodGroup ? match[pattern.methodGroup] : undefined;
          callsites.push({
            filePath,
            fileName: path.basename(filePath),
            fileStem: fileStem(filePath),
            projectId: project.id,
            language: detectLanguage(filePath),
            framework: this.detectFramework(filePath),
            isTest,
            role: isTest ? "test" : role,
            httpMethod: rawMethod ? rawMethod.toUpperCase() : undefined,
            rawPath,
            normalizedPath: normalizeApiPath(rawPath),
            references: refs,
          });
          match = pattern.regex.exec(text);
        }
      }

      // V4: Variable-based HTTP calls resolved via config chain
      if (varMap && varMap.size > 0) {
        const varPattern = new RegExp(VAR_HTTP_CALL_PATTERN.source, VAR_HTTP_CALL_PATTERN.flags);
        let varMatch: RegExpExecArray | null = varPattern.exec(text);
        while (varMatch) {
          const httpMethod = varMatch[1].toUpperCase();
          const varName = varMatch[2]; // e.g. "LIST_ALL_USER" or "RiskConfig.LIST_ALL_USER"

          const resolved = varMap.get(varName);
          if (resolved) {
            matched = true;
            callsites.push({
              filePath,
              fileName: path.basename(filePath),
              fileStem: fileStem(filePath),
              projectId: project.id,
              language: detectLanguage(filePath),
              framework: this.detectFramework(filePath),
              isTest,
              role: isTest ? "test" : role,
              httpMethod,
              rawPath: `${varName} → ${resolved.value}`,
              normalizedPath: normalizeApiPath(resolved.value),
              references: refs,
            });
          }
          varMatch = varPattern.exec(text);
        }
      }

      if (!matched && isTest) {
        callsites.push({
          filePath,
          fileName: path.basename(filePath),
          fileStem: fileStem(filePath),
          projectId: project.id,
          language: detectLanguage(filePath),
          framework: this.detectFramework(filePath),
          isTest: true,
          role: "test",
          references: refs,
        });
      }
    }

    return callsites;
  }

  private extractReferences(text: string, language: string): string[] {
    const refs = new Set<string>();

    if (language === "java") {
      // explicit imports: import com.test.TransactionTask;
      for (const match of text.matchAll(/import\s+[\w.]+\.([A-Z][A-Za-z0-9_]*)\s*;/g)) {
        refs.add(match[1]);
      }
      // constructor calls: new TransactionTask()
      for (const match of text.matchAll(/new\s+([A-Z][A-Za-z0-9_]*)\s*\(/g)) {
        refs.add(match[1]);
      }
      // field declarations (handles @Steps, @Autowired, etc.):
      //   private TransactionTask transactionTask;
      //   TransactionQst qst = new TransactionQst();
      for (const match of text.matchAll(/(?:private|protected|public)\s+([A-Z][A-Za-z0-9_]*)\s+[a-z]\w*/g)) {
        refs.add(match[1]);
      }
    }

    if (language === "typescript" || language === "javascript") {
      for (const match of text.matchAll(/import\s+(?:[\w*\s{},]+from\s+)?["'`](.+?)["'`]/g)) {
        refs.add(match[1]);
      }
    }

    if (language === "go") {
      for (const match of text.matchAll(/"([^"]+)"/g)) {
        if (match[1].includes("/")) {
          refs.add(match[1]);
        }
      }
    }

    return Array.from(refs);
  }

  private detectRole(filePath: string): ExtractedCallSite["role"] {
    const base = path.basename(filePath);
    if (/Task\.[^.]+$/.test(base)) return "task";
    if (/Client|Helper|Request\.[^.]+$/.test(base)) return "clientCall";
    // Serenity BDD helpers — Qst, Entity, Matcher treated as clientCall so
    // the engine can link Test → uses_client_call → these → (no API call)
    if (/Qst|Entity|Matcher\.[^.]+$/.test(base)) return "clientCall";
    return "helper";
  }

  private isTestFile(filePath: string): boolean {
    const base = path.basename(filePath);
    // Only the main test runner/step files are test nodes.
    // Task, Qst, Entity, Matcher files live in test/ dir but are helpers.
    return /(Test|Spec|Steps|Runner|Suite)\.[^.]+$/.test(base);
  }

  private detectFramework(filePath: string): string | undefined {
    const language = detectLanguage(filePath);
    switch (language) {
      case "java":
        return "serenity";
      case "typescript":
      case "javascript":
        return "generic-js";
      case "go":
        return "generic-go";
      default:
        return undefined;
    }
  }

  /** CSV/TXT test data files — linked to their sibling *Test.java by name stem. */
  public async extractTestData(project: ProjectContext, files: string[]): Promise<ExtractedCallSite[]> {
    const dataFiles = files.filter((f) => /\.(csv|txt)$/i.test(f));
    return dataFiles.map((filePath) => ({
      filePath,
      fileName: path.basename(filePath),
      fileStem: fileStem(filePath),
      projectId: project.id,
      language: "unknown",
      framework: "serenity",
      isTest: false,
      role: "helper" as const,
      // Reference the sibling Test file stem so the engine links them
      references: [fileStem(filePath).replace(/(?:TestCase|Data|PrepareData|Cases?)$/i, "Test")],
    }));
  }
}
