import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Shape of the optional `~/.ralph/knowledge.config.json` file.
 *
 * All fields are optional. Unknown fields are preserved at parse time but are
 * not surfaced through this interface — callers should treat the file as
 * forward-compatible.
 */
export interface KnowledgeConfig {
  /** Absolute or `~`-prefixed directories to index. */
  roots?: string[];
  /** Extra gitignore-syntax patterns layered on top of per-root `.ralphignore`. */
  ignorePatterns?: string[];
  /** Override for the SQLite database path. */
  dbPath?: string;
}

/**
 * Expand a leading `~` or `~/` segment in a path to the user's home directory.
 * Paths that do not begin with `~` are returned unchanged.
 */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Resolve the knowledge config file path. Precedence:
 *   1. `process.env.RALPH_KNOWLEDGE_CONFIG`
 *   2. `~/.ralph/knowledge.config.json`
 */
export function resolveConfigPath(): string {
  const envPath = process.env.RALPH_KNOWLEDGE_CONFIG;
  if (envPath && envPath.trim().length > 0) {
    return expandHome(envPath);
  }
  return join(homedir(), ".ralph", "knowledge.config.json");
}

/**
 * Load the optional `knowledge.config.json` file. Returns an empty object when
 * the file is missing or malformed. Tilde-prefixed paths inside `roots` and
 * `dbPath` are expanded eagerly so callers receive absolute paths.
 */
export function loadConfig(): KnowledgeConfig {
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (e) {
    console.warn(
      `Failed to read knowledge config at ${configPath}: ${(e as Error).message}`,
    );
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(
      `Malformed JSON in knowledge config at ${configPath}: ${(e as Error).message}`,
    );
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(
      `Knowledge config at ${configPath} is not a JSON object; ignoring.`,
    );
    return {};
  }

  const obj = parsed as Record<string, unknown>;
  const out: KnowledgeConfig = {};

  if (Array.isArray(obj.roots)) {
    out.roots = obj.roots
      .filter((r): r is string => typeof r === "string" && r.length > 0)
      .map(expandHome);
  }

  if (Array.isArray(obj.ignorePatterns)) {
    out.ignorePatterns = obj.ignorePatterns.filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
  }

  if (typeof obj.dbPath === "string" && obj.dbPath.length > 0) {
    out.dbPath = expandHome(obj.dbPath);
  }

  return out;
}
