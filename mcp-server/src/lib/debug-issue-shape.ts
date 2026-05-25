/**
 * Issue body + comment body builders for `ralph_hero__collate_debug` Phase 3b.
 *
 * Each `SignatureGroup` returned by `groupSpansBySignature` becomes either:
 *   - a fresh GitHub issue (when no existing `debug-auto` issue carries the
 *     same hash within the dedup window), or
 *   - a comment on an existing issue (occurrence-update).
 *
 * The body MUST include a machine-parseable hash marker on its own line —
 * `**Hash**: \`<8-char-hash>\`` — because dedup in Phase 3b matches on this
 * exact line via GitHub's code-search index.
 *
 * Token-shaped values are scrubbed from every emitted field. The regex set
 * mirrors `redactTokenAttributes` in `telemetry.ts`: GitHub tokens
 * (`^gh[ps]_`), basic-auth headers, and any attribute key ending in
 * `_TOKEN` are replaced with `[REDACTED]`.
 */

import type { SignatureGroup, SignatureSpan } from "./error-signature.js";

// ---------------------------------------------------------------------------
// Token redaction (kept local to avoid cross-module coupling at runtime; the
// shape mirrors telemetry.ts:redactTokenAttributes for consistency)
// ---------------------------------------------------------------------------

const GH_TOKEN_VALUE_RE = /\bgh[psour]_[A-Za-z0-9_]{16,}\b/g;
const TOKEN_KEY_RE = /(_TOKEN|authorization)$/i;
const BASIC_AUTH_RE = /\bBasic\s+[A-Za-z0-9+/=]{8,}\b/g;

/**
 * Scrub token-shaped substrings from a free-form string. Used for error
 * messages and serialised metadata before they land in an issue body.
 */
export function scrubTokensFromString(input: string): string {
  if (!input) return input;
  return input.replace(GH_TOKEN_VALUE_RE, "[REDACTED]").replace(
    BASIC_AUTH_RE,
    "Basic [REDACTED]",
  );
}

/**
 * Scrub token-shaped values from a plain attribute bag. Keys matching
 * `_TOKEN` or `authorization` (case-insensitive) are replaced with
 * `[REDACTED]`; values matching the GitHub token regex are scrubbed too.
 *
 * The result is a shallow copy — callers can serialise it without mutating
 * the input. Nested objects are stringified before scrubbing to keep the
 * function flat and predictable.
 */
export function scrubTokensFromAttrs(
  attrs: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (TOKEN_KEY_RE.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (typeof value === "string") {
      out[key] = scrubTokensFromString(value);
    } else if (value !== null && typeof value === "object") {
      out[key] = scrubTokensFromString(JSON.stringify(value));
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IssueShapeEnv {
  /** MCP server semver, surfaced in the "First seen" block. */
  mcpVersion: string;
  /** Node runtime version, e.g. `process.version`. */
  nodeVersion: string;
  /** Short OS descriptor, e.g. `darwin 23.4.0` or `linux x64`. */
  os: string;
}

export interface BuiltIssue {
  title: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TITLE_MAX = 100;
const NORMALIZED_MAX = 60;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…"; // ellipsis
}

/**
 * Pull a short, human-readable error blurb out of a span. Falls back through
 * statusMessage -> exception.message -> metadata.error -> the span name.
 */
function extractMessage(span: SignatureSpan | undefined): string {
  if (!span) return "";
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
 * Take the third segment of a `${spanName}:${errorType}:${normalized}`
 * signature string. Used to populate the title when no sample span message
 * is available.
 */
function normalizedFromSignature(signature: string): string {
  const parts = signature.split(":");
  if (parts.length < 3) return signature;
  return parts.slice(2).join(":");
}

// ---------------------------------------------------------------------------
// buildIssueBody
// ---------------------------------------------------------------------------

/**
 * Build the title + body for a freshly-filed `debug-auto` issue.
 *
 * The body layout is deliberately stable so Phase 3b's dedup regex
 * (`/^\*\*Hash\*\*: `([0-9a-f]{8})`/m`) keeps matching across versions.
 */
export function buildIssueBody(
  group: SignatureGroup,
  env: IssueShapeEnv,
): BuiltIssue {
  const sample = group.sampleSpans[0];
  const rawMessage = extractMessage(sample) || normalizedFromSignature(group.signature);
  const message = scrubTokensFromString(rawMessage);
  const spanName = sample?.name ?? "ralph_hero.error";

  const title = truncate(
    `[Debug] ${spanName}: ${truncate(message, NORMALIZED_MAX)}`,
    TITLE_MAX,
  );

  const occurrenceRows = [
    `| Count | First seen | Last seen |`,
    `|---|---|---|`,
    `| ${group.count} | ${group.firstSeen} | ${group.lastSeen} |`,
  ].join("\n");

  const sampleAttrs = sample?.metadata
    ? scrubTokensFromAttrs(sample.metadata)
    : {};
  const errorDetails = Object.keys(sampleAttrs).length
    ? "```json\n" + JSON.stringify(sampleAttrs, null, 2) + "\n```"
    : "_(no attributes captured on sample span)_";

  const reproduction = sample
    ? "```json\n" +
      JSON.stringify(
        {
          spanName: sample.name,
          traceId: sample.traceId,
          startTime: sample.startTime,
          errorType: sample.errorType,
          message: scrubTokensFromString(extractMessage(sample)),
        },
        null,
        2,
      ) +
      "\n```"
    : "_(no sample span available)_";

  const body = [
    `**Hash**: \`${group.hash}\``,
    ``,
    `**Signature**: \`${scrubTokensFromString(group.signature)}\``,
    ``,
    `## First seen`,
    ``,
    `- mcp-server version: \`${env.mcpVersion}\``,
    `- node: \`${env.nodeVersion}\``,
    `- os: \`${env.os}\``,
    ``,
    `## Error details`,
    ``,
    errorDetails,
    ``,
    `## Reproduction (sample span)`,
    ``,
    reproduction,
    ``,
    `## Occurrences`,
    ``,
    occurrenceRows,
    ``,
    `## Langfuse trace`,
    ``,
    `[Open latest example trace](${group.exampleTraceUrl})`,
    ``,
    `---`,
    ``,
    `_Filed automatically by \`ralph_hero__collate_debug\` — Phase 3b (GH-1100). ` +
      `Re-running collation over the same window will append occurrence ` +
      `comments here instead of creating a duplicate issue._`,
  ].join("\n");

  return { title, body };
}

// ---------------------------------------------------------------------------
// buildCommentBody
// ---------------------------------------------------------------------------

/**
 * Build the occurrence-update comment body posted when an existing
 * `debug-auto` issue is matched by hash. `newCount` is the count returned by
 * the current `groupSpansBySignature` run — i.e., occurrences in the *new*
 * window, not the cumulative total (we don't have read access to historical
 * comment counts without extra queries).
 */
export function buildCommentBody(
  group: SignatureGroup,
  newCount: number,
  latestTraceUrl: string,
): string {
  return [
    `## Recurring occurrence`,
    ``,
    `Detected **${newCount}** new occurrence${newCount === 1 ? "" : "s"} of this signature in the latest collation window.`,
    ``,
    `- Hash: \`${group.hash}\``,
    `- First seen (this window): ${group.firstSeen}`,
    `- Last seen (this window): ${group.lastSeen}`,
    `- [Latest example trace](${scrubTokensFromString(latestTraceUrl)})`,
    ``,
    `_Posted automatically by \`ralph_hero__collate_debug\` (Phase 3b)._`,
  ].join("\n");
}
