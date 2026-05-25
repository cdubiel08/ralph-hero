/**
 * Minimal Langfuse HTTP client for querying traces and observations.
 *
 * Used by `ralph_hero__collate_debug` to fetch error spans emitted by the
 * MCP server's OTel pipeline (see `telemetry.ts`). Authenticates via HTTP
 * basic auth with `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`.
 *
 * No SDK dependency — uses Node's native `fetch` (Node 20+).
 *
 * Reference: https://langfuse.com/docs/api
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LangfuseClientOptions {
  /** Langfuse host URL. Defaults to env `LANGFUSE_HOST` or `http://localhost:3100`. */
  host?: string;
  /** Public key. Defaults to env `LANGFUSE_PUBLIC_KEY`. */
  publicKey?: string;
  /** Secret key. Defaults to env `LANGFUSE_SECRET_KEY`. */
  secretKey?: string;
  /** Override the fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
}

export interface LangfuseTrace {
  id: string;
  name?: string;
  timestamp: string;
  userId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

/**
 * Langfuse observation (span). Field names mirror the Langfuse public API.
 * `level` is the OTel-style severity. `metadata` carries OTel span attributes.
 */
export interface LangfuseObservation {
  id: string;
  traceId: string;
  name: string;
  startTime: string;
  endTime?: string;
  type: "SPAN" | "GENERATION" | "EVENT";
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  metadata?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  [key: string]: unknown;
}

export interface QueryObservationsParams {
  /** ISO date string — only return observations whose startTime >= this value. */
  fromStartTime?: string;
  /** ISO date string — only return observations whose startTime <= this value. */
  toStartTime?: string;
  /** Observation type filter. */
  type?: "SPAN" | "GENERATION" | "EVENT";
  /** Level filter (e.g., "ERROR" for error spans). */
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  /** Span name filter. */
  name?: string;
  /** Page number (1-indexed). */
  page?: number;
  /** Page size. */
  limit?: number;
}

export interface QueryTracesParams {
  fromTimestamp?: string;
  toTimestamp?: string;
  name?: string;
  page?: number;
  limit?: number;
}

export interface LangfusePage<T> {
  data: T[];
  meta?: {
    page?: number;
    limit?: number;
    totalItems?: number;
    totalPages?: number;
  };
}

export interface LangfuseClient {
  host: string;
  queryTraces(params?: QueryTracesParams): Promise<LangfusePage<LangfuseTrace>>;
  queryObservations(
    params?: QueryObservationsParams,
  ): Promise<LangfusePage<LangfuseObservation>>;
  /**
   * Convenience helper: paginate through `queryObservations`, accumulating
   * all matching observations across pages. Stops at `maxPages` (default 10)
   * to avoid runaway loops.
   */
  queryAllObservations(
    params?: QueryObservationsParams,
    maxPages?: number,
  ): Promise<LangfuseObservation[]>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_HOST = "http://localhost:3100";

function buildAuthHeader(publicKey: string, secretKey: string): string {
  const credentials = `${publicKey}:${secretKey}`;
  // Node 20+ provides global Buffer
  const encoded = Buffer.from(credentials, "utf-8").toString("base64");
  return `Basic ${encoded}`;
}

function appendQueryParams(
  url: URL,
  params: Record<string, unknown> | undefined,
): void {
  if (!params) return;
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
}

/**
 * Create a Langfuse HTTP client.
 *
 * Throws on construction if `publicKey` or `secretKey` are missing (in args
 * and in env), because every endpoint requires authentication.
 */
export function createLangfuseClient(
  options: LangfuseClientOptions = {},
): LangfuseClient {
  const host = (options.host ?? process.env.LANGFUSE_HOST ?? DEFAULT_HOST)
    .replace(/\/+$/, "");
  const publicKey = options.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = options.secretKey ?? process.env.LANGFUSE_SECRET_KEY;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!publicKey || !secretKey) {
    throw new Error(
      "Langfuse credentials missing: set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY (or pass via options).",
    );
  }

  const authHeader = buildAuthHeader(publicKey, secretKey);

  async function request<T>(
    path: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const url = new URL(`${host}${path}`);
    appendQueryParams(url, params);

    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `Langfuse request failed: ${response.status} ${response.statusText}` +
          (bodyText ? ` — ${bodyText.slice(0, 200)}` : ""),
      );
    }

    return (await response.json()) as T;
  }

  async function queryTraces(
    params: QueryTracesParams = {},
  ): Promise<LangfusePage<LangfuseTrace>> {
    return request<LangfusePage<LangfuseTrace>>(
      "/api/public/traces",
      params as Record<string, unknown>,
    );
  }

  async function queryObservations(
    params: QueryObservationsParams = {},
  ): Promise<LangfusePage<LangfuseObservation>> {
    return request<LangfusePage<LangfuseObservation>>(
      "/api/public/observations",
      params as Record<string, unknown>,
    );
  }

  async function queryAllObservations(
    params: QueryObservationsParams = {},
    maxPages = 10,
  ): Promise<LangfuseObservation[]> {
    const all: LangfuseObservation[] = [];
    const limit = params.limit ?? 100;
    let page = params.page ?? 1;

    for (let i = 0; i < maxPages; i++) {
      const result = await queryObservations({ ...params, page, limit });
      if (!result.data || result.data.length === 0) break;
      all.push(...result.data);

      const totalPages = result.meta?.totalPages;
      if (totalPages !== undefined && page >= totalPages) break;
      if (result.data.length < limit) break;
      page += 1;
    }

    return all;
  }

  return {
    host,
    queryTraces,
    queryObservations,
    queryAllObservations,
  };
}
