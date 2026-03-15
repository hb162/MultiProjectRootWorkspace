import * as crypto from "node:crypto";
import * as path from "node:path";

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function stableId(...parts: Array<string | undefined>): string {
  const text = parts.filter(Boolean).join("::");
  return crypto.createHash("sha1").update(text).digest("hex");
}

export function hashText(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

export function normalizeApiPath(rawPath: string): string {
  if (!rawPath) {
    return "/";
  }

  const withoutQuery = rawPath.split("?")[0].split("#")[0];
  const withoutOrigin = withoutQuery.replace(/^[a-z]+:\/\/[^/]+/i, "");
  const normalized = withoutOrigin.replace(/\/+/g, "/");
  const trimmed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return trimmed.endsWith("/") && trimmed !== "/" ? trimmed.slice(0, -1) : trimmed;
}

export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".py":
      return "python";
    case ".java":
      return "java";
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".go":
      return "go";
    case ".conf":
    case ".hocon":
    case ".properties":
      return "config";
    case ".groovy":
      return "groovy";
    case ".kt":
    case ".kts":
      return "kotlin";
    default:
      return "unknown";
  }
}

export function fileStem(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

export function uniqueBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function confidenceScore(...parts: number[]): number {
  if (!parts.length) {
    return 0;
  }

  const total = parts.reduce((sum, value) => sum + value, 0);
  return Math.max(0, Math.min(1, total / parts.length));
}

export function shortLabel(filePath: string): string {
  const pieces = toPosixPath(filePath).split("/");
  return pieces.slice(Math.max(0, pieces.length - 3)).join("/");
}
