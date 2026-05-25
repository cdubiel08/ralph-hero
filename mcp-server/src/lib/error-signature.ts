/**
 * Error-signature normalization and grouping for Langfuse OTel spans.
 *
 * Used by `ralph_hero__collate_debug` to collapse noisy, near-identical
 * error spans into a small set of "signatures." Each signature is hashed to
 * an 8-char ID that survives across runs, so Phase 3b's GitHub dedup can
 * match an incoming group to an existing issue body by the hash marker.
 *
 * The normalization rules deliberately strip *dynamic* details (issue
 * numbers, timestamps, UUIDs, hashes, quoted paths/names) while preserving
 * the *structural* shape of the message. Two errors that differ only in
 * which issue number triggered them collapse to the same signature.
 */

import { createHash } from "node:crypto";
import type { LangfuseObservation } from "./langfuse-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal span shape used for grouping. Compatible with `LangfuseObservation`
 * but kept narrow so unit tests can synthesise spans without faking the full
 * Langfuse response shape.
 */
export interface SignatureSpan {
  name: string;
  traceId: string;
  startTime: string;
  endTime?: string;
  /** Free-form attributes (OTel span attrs surface here as `metadata`). */
  metadata?: Record<string, unknown>;
  /** `ralph_hero.error_type` lives in `metadata` but may also be hoisted. */
  errorType?: string;
  /** Error message (`statusMessage` from Langfuse). */
  message?: string;
  level?: string;
}

export interface SignatureGroup {
  /** Full signature key (pre-hash). */
  signature: string;
  /** SHA256 truncated to 8 hex chars — stable dedup key. */
  hash: string;
  /** Number of occurrences in the queried window. */
  count: number;
  /** ISO timestamp of the earliest occurrence. */
  firstSeen: string;
  /** ISO timestamp of the latest occurrence. */
  lastSeen: string;
  /**
   * URL pointing to a representative trace in the Langfuse UI. The
   * `<defaultProjectId>` placeholder is kept literal when no project ID is
   * configurable — Phase 3b can replace it once the project ID is known.
   */
  exampleTraceUrl: string;
  /** Up to 3 representative spans for the group (most-recent first). */
  sampleSpans: SignatureSpan[];
}

export interface GroupOptions {
  /** Minimum number of occurrences for a signature to be reported. Default 3. */
  minOccurrences?: number;
  /** Langfuse host, used to build `exampleTraceUrl`. */
  langfuseHost?: string;
  /** Optional Langfuse project ID. If absent, `<defaultProjectId>` is used. */
  projectId?: string;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const ISO_TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_HASH_RE = /\b[0-9a-f]{8,}\b/gi;
const ISSUE_NUMBER_RE = /#\d+/g;
// Match runs of digits anywhere — without word boundaries so embedded
// numbers like "60s" or "v2" collapse too. ISSUE_NUMBER_RE runs first so
// "#42" becomes "#N" before this fires.
const BARE_NUMBER_RE = /\d+/g;
// Match double-quoted or single-quoted strings (non-greedy).
const QUOTED_STRING_RE = /"[^"\n]*"|'[^'\n]*'/g;

/**
 * Normalize an error message into a comparable signature fragment.
 *
 * Order of replacements matters:
 *   1. Quoted strings first (so a quoted ISO timestamp becomes `<STR>` not
 *      `<TS>`).
 *   2. ISO timestamps before UUIDs (timestamps can contain colons / dashes).
 *   3. UUIDs before generic hex hashes (UUID format is stricter).
 *   4. Issue numbers (`#NNN`) before bare numbers.
 *   5. Bare numbers last.
 *   6. Whitespace collapsed and result truncated to 200 chars.
 */
export function normalizeErrorMessage(msg: string): string {
  if (!msg) return "";

  let out = msg;
  out = out.replace(QUOTED_STRING_RE, "<STR>");
  out = out.replace(ISO_TIMESTAMP_RE, "<TS>");
  out = out.replace(UUID_RE, "<ID>");
  out = out.replace(HEX_HASH_RE, "<HASH>");
  out = out.replace(ISSUE_NUMBER_RE, "#N");
  out = out.replace(BARE_NUMBER_RE, "<N>");
  out = out.replace(/\s+/g, " ").trim();

  return out.slice(0, 200);
}

/**
 * Build the signature key (pre-hash). Format:
 *   `${spanName}:${errorType}:${normalizedMessage}`
 */
export function buildSignatureKey(
  spanName: string,
  errorType: string,
  normalizedMsg: string,
): string {
  return `${spanName}:${errorType}:${normalizedMsg}`;
}

/**
 * SHA256 hash truncated to 8 hex chars. Stable across runs, suitable for
 * dedup body markers like `**Hash**: \`a1b2c3d4\``.
 */
export function hashSignature(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Span helpers
// ---------------------------------------------------------------------------

/**
 * Extract the `ralph_hero.error_type` attribute from a span's metadata, with
 * fallback to a hoisted `errorType` field. Returns `"unknown"` if neither is
 * present.
 */
export function getErrorType(span: SignatureSpan): string {
  if (span.errorType) return span.errorType;
  const meta = span.metadata ?? {};
  const fromMeta =
    meta["ralph_hero.error_type"] ??
    meta.error_type ??
    meta.errorType;
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  return "unknown";
}

/**
 * Extract the error message from a span. Prefers `message` (Langfuse
 * `statusMessage`), then `metadata.exception.message`, then `metadata.error`.
 */
export function getErrorMessage(span: SignatureSpan): string {
  if (span.message) return span.message;
  const meta = span.metadata ?? {};
  const exception = meta.exception;
  if (
    exception &&
    typeof exception === "object" &&
    "message" in exception &&
    typeof (exception as { message: unknown }).message === "string"
  ) {
    return (exception as { message: string }).message;
  }
  if (typeof meta.error === "string") return meta.error;
  if (typeof meta.message === "string") return meta.message;
  return "";
}

/**
 * Convert a `LangfuseObservation` to a `SignatureSpan`. Hoists the
 * `ralph_hero.error_type` attribute up to the top level.
 */
export function observationToSpan(obs: LangfuseObservation): SignatureSpan {
  const meta = obs.metadata ?? {};
  const errorType =
    typeof meta["ralph_hero.error_type"] === "string"
      ? (meta["ralph_hero.error_type"] as string)
      : undefined;
  return {
    name: obs.name,
    traceId: obs.traceId,
    startTime: obs.startTime,
    endTime: obs.endTime,
    metadata: meta,
    errorType,
    message: obs.statusMessage,
    level: obs.level,
  };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function buildTraceUrl(
  langfuseHost: string | undefined,
  projectId: string | undefined,
  traceId: string,
): string {
  const host = (langfuseHost ?? "http://localhost:3100").replace(/\/+$/, "");
  const project = projectId ?? "<defaultProjectId>";
  return `${host}/project/${project}/traces/${traceId}`;
}

/**
 * Group spans by signature. Returns groups sorted by `count` descending.
 *
 * Spans below `minOccurrences` (default 3) are filtered out. Each group's
 * `sampleSpans` contains up to 3 representative spans, most-recent first.
 */
export function groupSpansBySignature(
  spans: SignatureSpan[],
  opts: GroupOptions = {},
): SignatureGroup[] {
  const minOccurrences = opts.minOccurrences ?? 3;
  const buckets = new Map<
    string,
    {
      signature: string;
      hash: string;
      count: number;
      firstSeen: string;
      lastSeen: string;
      latestTraceId: string;
      spans: SignatureSpan[];
    }
  >();

  for (const span of spans) {
    const errorType = getErrorType(span);
    const normalized = normalizeErrorMessage(getErrorMessage(span));
    const signature = buildSignatureKey(span.name, errorType, normalized);
    const hash = hashSignature(signature);

    const existing = buckets.get(hash);
    if (existing) {
      existing.count += 1;
      if (span.startTime > existing.lastSeen) {
        existing.lastSeen = span.startTime;
        existing.latestTraceId = span.traceId;
      }
      if (span.startTime < existing.firstSeen) {
        existing.firstSeen = span.startTime;
      }
      existing.spans.push(span);
    } else {
      buckets.set(hash, {
        signature,
        hash,
        count: 1,
        firstSeen: span.startTime,
        lastSeen: span.startTime,
        latestTraceId: span.traceId,
        spans: [span],
      });
    }
  }

  const groups: SignatureGroup[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.count < minOccurrences) continue;
    // Sort sample spans by startTime desc, keep up to 3.
    const sampleSpans = [...bucket.spans]
      .sort((a, b) => (b.startTime > a.startTime ? 1 : -1))
      .slice(0, 3);
    groups.push({
      signature: bucket.signature,
      hash: bucket.hash,
      count: bucket.count,
      firstSeen: bucket.firstSeen,
      lastSeen: bucket.lastSeen,
      exampleTraceUrl: buildTraceUrl(
        opts.langfuseHost,
        opts.projectId,
        bucket.latestTraceId,
      ),
      sampleSpans,
    });
  }

  groups.sort((a, b) => b.count - a.count);
  return groups;
}
