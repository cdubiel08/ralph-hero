/**
 * OpenTelemetry initialization for the ralph-hero MCP server.
 *
 * Lazy-initialized when `RALPH_DEBUG=true`. When the env var is unset or any
 * value other than the literal string `"true"`, `initTelemetry()` returns
 * `null` and no OpenTelemetry SDK objects are constructed — zero overhead.
 *
 * The OTLP HTTP exporter reads its endpoint from `OTEL_EXPORTER_OTLP_ENDPOINT`
 * (standard OTel convention). Auto-instrumentation is explicitly OFF — only
 * the explicit `ralph_hero.graphql` spans emitted from `github-client.ts`
 * appear in the resulting trace.
 *
 * A custom `SpanProcessor` redacts token-shaped attribute values at span
 * start so secrets never reach the exporter. See `redactTokenAttributes()`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Span, SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { Context } from "@opentelemetry/api";

/**
 * Attribute value matching `^gh[ps]_` (GitHub PAT/server-to-server token shape)
 * and key matching `_TOKEN$` (case-insensitive) or `^authorization$` are
 * replaced with this sentinel before the span is exported.
 */
const REDACTED = "[REDACTED]";

const TOKEN_VALUE_RE = /^gh[ps]_/;
const TOKEN_KEY_RE = /(_TOKEN$|^authorization$)/i;

/**
 * Pure function — exported for unit tests. Returns a shallow copy of `attrs`
 * with any token-shaped value or key replaced by `[REDACTED]`.
 *
 * Keys are matched case-insensitively against `_TOKEN$` and `^authorization$`.
 * Values are matched (when they are strings) against `^gh[ps]_`.
 *
 * Non-matching attributes (including non-string values like numbers and
 * booleans) pass through unchanged.
 */
export function redactTokenAttributes(
  attrs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!attrs) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (TOKEN_KEY_RE.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (typeof value === "string" && TOKEN_VALUE_RE.test(value)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * SpanProcessor that scrubs token-shaped attributes from each span.
 *
 * The scrub runs on `onEnd` rather than `onStart` because we need to see the
 * full set of attributes that any caller has set on the span. Crucially, once
 * a span has ended, `span.setAttribute()` is a documented no-op — the only
 * way to mutate the final exported attribute set is to write directly to the
 * `attributes` object. TypeScript types it as readonly but the runtime
 * representation is a plain mutable object owned by the span instance.
 *
 * Order matters: this processor must be registered BEFORE the exporting
 * processor (`BatchSpanProcessor` or `SimpleSpanProcessor`) so the mutation
 * is visible by the time the export call reads `attributes`.
 */
export class TokenScrubbingSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {
    // No-op — attributes set on an active span go through `setAttribute`,
    // not the readable snapshot. We catch them all in `onEnd`.
  }

  onEnd(span: ReadableSpan): void {
    const attrs = span.attributes;
    if (!attrs) return;
    // attrs is `Attributes` (readonly per the type) but mutable at runtime.
    // Mutate in-place so downstream processors see the redacted values.
    const mut = attrs as Record<string, unknown>;
    for (const [key, value] of Object.entries(mut)) {
      if (TOKEN_KEY_RE.test(key)) {
        mut[key] = REDACTED;
      } else if (typeof value === "string" && TOKEN_VALUE_RE.test(value)) {
        mut[key] = REDACTED;
      }
    }
  }

  async shutdown(): Promise<void> {
    // No-op — this processor holds no resources.
  }

  async forceFlush(): Promise<void> {
    // No-op — this processor performs no async work.
  }
}

/**
 * Read the MCP server semver from package.json next to this module.
 *
 * Falls back to `"unknown"` if the file is missing or unreadable so the SDK
 * still starts up — the version is informational, not load-bearing.
 */
function resolveServiceVersion(): string {
  try {
    // In ESM, __dirname isn't defined; compute it from import.meta.url.
    const here = dirname(fileURLToPath(import.meta.url));
    // Walk up from src/lib (or dist/lib at runtime) to the package root.
    const pkgPath = resolve(here, "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Initialize the OpenTelemetry NodeSDK when `RALPH_DEBUG=true`.
 *
 * - Returns `null` (zero overhead) when `process.env.RALPH_DEBUG !== "true"`.
 * - When enabled: configures an OTLP/HTTP trace exporter, no auto-instrumentation,
 *   a `TokenScrubbingSpanProcessor` ahead of the default batch processor, and
 *   resource attrs `service.name = "ralph-hero"`, `service.version = <semver>`.
 *
 * Caller is responsible for calling `sdk.shutdown()` (e.g., on SIGTERM) to
 * flush in-flight spans.
 */
export async function initTelemetry(): Promise<unknown | null> {
  if (process.env.RALPH_DEBUG !== "true") {
    return null;
  }

  // Dynamic imports keep zero-overhead in the disabled path — when RALPH_DEBUG
  // is unset, none of these modules are loaded into memory.
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import(
    "@opentelemetry/exporter-trace-otlp-http"
  );
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const {
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
  } = await import("@opentelemetry/semantic-conventions");
  const { BatchSpanProcessor } = await import(
    "@opentelemetry/sdk-trace-base"
  );

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    "http://localhost:3100/api/public/otel/v1/traces";

  const exporter = new OTLPTraceExporter({ url: endpoint });

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "ralph-hero",
      [ATTR_SERVICE_VERSION]: resolveServiceVersion(),
    }),
    spanProcessors: [
      new TokenScrubbingSpanProcessor(),
      new BatchSpanProcessor(exporter),
    ],
    // No auto-instrumentation — only explicit ralph_hero.* spans are emitted.
    instrumentations: [],
  });

  sdk.start();
  return sdk;
}
