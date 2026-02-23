/**
 * Debug logger for Ralph Hero MCP server.
 *
 * Captures tool calls, GraphQL operations, and hook events as JSONL
 * when RALPH_DEBUG=true. Returns null when disabled for zero overhead.
 * Follows the RateLimiter pattern (constructor + factory function).
 */

import { writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DebugLoggerOptions {
  logDir?: string; // defaults to ~/.ralph-hero/logs/
}

export interface GraphQLLogFields {
  operation?: string;
  variables?: Record<string, unknown>;
  durationMs: number;
  status: number;
  rateLimitRemaining?: number;
  rateLimitCost?: number;
  error?: string;
}

export interface ToolLogFields {
  tool: string;
  params: Record<string, unknown>;
  durationMs: number;
  ok: boolean;
  error?: string;
}

interface LogEvent {
  ts: string;
  cat: "tool" | "graphql" | "hook" | "session";
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS = /token|auth|secret|key|password|credential/i;

/**
 * Strip fields whose keys match sensitive patterns.
 */
export function sanitize(
  obj: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!obj) return obj;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_PATTERNS.test(k)) {
      result[k] = "[REDACTED]";
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// DebugLogger
// ---------------------------------------------------------------------------

export class DebugLogger {
  private logPath: string | null = null;
  private logDir: string;

  constructor(options?: DebugLoggerOptions) {
    this.logDir =
      options?.logDir ?? join(homedir(), ".ralph-hero", "logs");
  }

  private async getLogPath(): Promise<string> {
    if (this.logPath) return this.logPath;

    await mkdir(this.logDir, { recursive: true });

    const now = new Date();
    const ts = now
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "-")
      .replace("Z", "");
    const rand = randomBytes(2).toString("hex");
    this.logPath = join(this.logDir, `session-${ts}-${rand}.jsonl`);

    // Create the file
    await writeFile(this.logPath, "");
    return this.logPath;
  }

  private append(event: LogEvent): void {
    // Fire-and-forget — never block tool handlers
    this.getLogPath()
      .then((path) => appendFile(path, JSON.stringify(event) + "\n"))
      .catch(console.error);
  }

  logGraphQL(fields: GraphQLLogFields): void {
    this.append({
      ts: new Date().toISOString(),
      cat: "graphql",
      operation: fields.operation,
      variables: sanitize(fields.variables),
      durationMs: fields.durationMs,
      status: fields.status,
      rateLimitRemaining: fields.rateLimitRemaining,
      rateLimitCost: fields.rateLimitCost,
      ...(fields.error ? { error: fields.error } : {}),
    });
  }

  logTool(fields: ToolLogFields): void {
    this.append({
      ts: new Date().toISOString(),
      cat: "tool",
      tool: fields.tool,
      params: sanitize(fields.params) ?? {},
      durationMs: fields.durationMs,
      ok: fields.ok,
      ...(fields.error ? { error: fields.error } : {}),
    });
  }

  /** Get the current log file path (for testing). */
  getSessionLogPath(): string | null {
    return this.logPath;
  }
}

// ---------------------------------------------------------------------------
// Factory & Wrapper
// ---------------------------------------------------------------------------

/**
 * Create a DebugLogger if RALPH_DEBUG=true, otherwise null (zero overhead).
 */
export function createDebugLogger(
  options?: DebugLoggerOptions,
): DebugLogger | null {
  if (process.env.RALPH_DEBUG !== "true") return null;
  return new DebugLogger(options);
}

/**
 * Extract a GraphQL operation name from a query string.
 */
export function extractOperationName(
  queryString: string,
): string | undefined {
  const match = queryString.match(
    /(?:query|mutation)\s+(\w+)/,
  );
  return match?.[1];
}

/**
 * Wrap a tool handler with debug logging.
 * When logger is null, calls handler directly with zero overhead.
 */
export async function withLogging<T>(
  logger: DebugLogger | null,
  toolName: string,
  params: Record<string, unknown>,
  handler: () => Promise<T>,
): Promise<T> {
  if (!logger) return handler();

  const t0 = Date.now();
  try {
    const result = await handler();
    logger.logTool({
      tool: toolName,
      params,
      durationMs: Date.now() - t0,
      ok: true,
    });
    return result;
  } catch (error) {
    logger.logTool({
      tool: toolName,
      params,
      durationMs: Date.now() - t0,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Monkey-patch McpServer.tool() to wrap all tool handlers with debug logging.
 * Called once at startup when RALPH_DEBUG=true. Zero overhead when disabled
 * (this function is never called).
 *
 * Uses `any` deliberately to handle McpServer's complex overloaded signatures.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wrapServerToolWithLogging(
  server: any,
  logger: DebugLogger,
): void {
  const originalTool = server.tool.bind(server);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.tool = (...args: any[]) => {
    // server.tool(name, desc, schema, handler) or (name, desc, handler) or (name, handler)
    // Handler is always the last argument and is a function
    const name = args[0] as string;
    const handlerIdx = args.length - 1;
    const originalHandler = args[handlerIdx];

    if (typeof originalHandler !== "function") {
      return originalTool(...args);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args[handlerIdx] = async (...handlerArgs: any[]) => {
      const params =
        handlerArgs[0] && typeof handlerArgs[0] === "object"
          ? (handlerArgs[0] as Record<string, unknown>)
          : {};
      return withLogging(logger, name, params, () =>
        originalHandler(...handlerArgs),
      );
    };

    return originalTool(...args);
  };
}
