---
date: 2026-05-11
last_updated: 2026-05-13
status: in-progress
type: plan
github_issue: 1097
github_issues: [1097, 1098, 1099, 1100, 1101]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1097
  - https://github.com/cdubiel08/ralph-hero/issues/1098
  - https://github.com/cdubiel08/ralph-hero/issues/1099
  - https://github.com/cdubiel08/ralph-hero/issues/1100
  - https://github.com/cdubiel08/ralph-hero/issues/1101
primary_issue: 1097
parent_plan: thoughts/shared/plans/2026-05-05-debug-mode-observability-spec-v2.md
tags: [observability, otel, langfuse, debug, mcp-server]
---

# Debug Mode & Self-Healing Observability (OTel-native) — Group Implementation Plan

## Prior Work

- builds_on:: [[2026-05-05-debug-mode-observability-spec-v2]]
- tensions:: [[2026-02-21-debug-mode-observability-spec]]

## Overview

5 related issues for atomic implementation across multiple PRs:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1097 | Phase 1: Enable Claude Code OTel → local Langfuse | XS |
| 2 | GH-1098 | Phase 2: MCP-server OTel SDK + GraphQL child spans | S |
| 3 | GH-1099 | Phase 3a: collate_debug — Langfuse query + signature grouping | S |
| 4 | GH-1100 | Phase 3b: collate_debug — GitHub dedup + issue create/comment | S |
| 5 | GH-1101 | Phase 4: ralph-debug-collate skill wrapper | XS |

**Why grouped**: All 5 issues are children of parent epic #1096 ("Debug Mode & Self-Healing Observability"), share a single spec at `thoughts/shared/plans/2026-05-05-debug-mode-observability-spec-v2.md`, and form a strict linear dependency chain: each phase builds on the artifacts produced by the previous one (env vars → SDK → grouping logic → issue dedup → user-facing skill). They cannot be implemented out of order.

## Execution Status (rebased 2026-05-13)

All five phases were implemented and pushed to feature branches, but **none of the PRs have merged**. An escalation flow on `/ralph-hero:finish` for PR #1197 closed issues #1097–#1101 as completed and reopened-then-reclosed parent #1096 prematurely; the underlying merges never happened. Parent #1096 has been reopened.

| Phase | Issue | Branch | PR | Tip commit | PR base | Status |
|-------|-------|--------|----|-----------|---------|--------|
| 1 | GH-1097 | `feature/GH-1097` | #1196 | `5ca72003` (CLAUDE.md OTel docs) | `main` | OPEN — independent of code phases (doc-only) |
| 2 | GH-1098 | `feature/GH-1098` | #1197 | `b02a1859` (review-feedback fix on top of `f3d129d7`) | `main` | OPEN — code-review iteration #1 left a tautological regression test (Task 2.6 below) |
| 3a | GH-1099 | `feature/GH-1099` | #1198 | `581742fd` (collate_debug Langfuse path) | `main` | OPEN — branch carries `f3d129d7` but **not** `b02a1859`; merging before #1197 lands re-introduces the missing-`await` and outer-span-ERROR bugs |
| 3b | GH-1100 | `feature/GH-1100` | #1199 | `f1500413` (collate_debug GitHub dedup + create/comment) | `main` | OPEN — same stacked-on-`f3d129d7` problem as 3a |
| 4 | GH-1101 | `feature/GH-1101` | #1200 | `977712fe` (ralph-debug-collate skill wrapper) | `main` | OPEN — same stacked-on-`f3d129d7` problem as 3a |

The four code branches (1098, 1099, 1100, 1101) form a linear chain in commit order — each was created on top of the previous tip rather than off `main` — but every PR points its base at `main`. Phase 1 (1097) is independent because it only touches `CLAUDE.md`.

The remaining work to land #1096 is captured below as Task 2.6 plus a new "Merge Sequence" section. No code reimplementation is needed for phases 2–4; the remaining surface is a one-line test fix, four rebases, and four merges in the right order.

## Shared Constraints

Inherited from parent spec `2026-05-05-debug-mode-observability-spec-v2.md` and ralph-hero CLAUDE.md:

1. **Zero overhead when `RALPH_DEBUG` is unset**: All OTel and collation surfaces must skip initialization entirely when `RALPH_DEBUG !== "true"`. Verify via "no exporter threads, no outbound traffic to `:3100`."
2. **No tokens in spans**: `RALPH_HERO_GITHUB_TOKEN`, `OTEL_EXPORTER_OTLP_HEADERS`, and any value matching `^gh[ps]_` must never appear as a span attribute value. Use a single `SpanProcessor` for redaction, not scattered manual filters.
3. **ESM module discipline**: All internal imports require `.js` extensions; the project uses `"type": "module"` with `"module": "NodeNext"`.
4. **`@octokit/graphql` v9 reserved keys**: Never use `query`, `method`, or `url` as GraphQL variable names.
5. **Tool naming**: All MCP tools use the `ralph_hero__` prefix; use `toolSuccess()`/`toolError()` from `types.ts`.
6. **Debug tools gated**: Anything new in `src/tools/debug-tools.ts` must be registered only inside the `if (process.env.RALPH_DEBUG === 'true')` block in `src/index.ts` (line 527-529).
7. **Token resolution preserved**: The `repoToken` resolution chain (`RALPH_GH_REPO_TOKEN` → `RALPH_HERO_GITHUB_TOKEN` → `gh auth token`) must continue to flow only into the internal `repoToken` variable; never re-export as `process.env.GH_TOKEN`.
8. **Span shape**: Spans the MCP server adds are `ralph_hero.graphql` (and optionally `ralph_hero.cache`). Resource attributes set `service.name = "ralph-hero"`, `service.version = <mcp-server semver>`.
9. **Tests use vitest**: `npm test` runs `vitest run --coverage` from `plugin/ralph-hero/mcp-server/`. Place new test files under `src/__tests__/`. Fixtures go in `src/__tests__/fixtures/`.
10. **Plan-document linkage**: Each phase commits independently on `main` (or a feature branch per phase). Issue numbers in `Phase N (#TBD)` placeholders in the original issue bodies resolve to the GH numbers listed in this plan.

## Current State Analysis

The MCP server already has a v1 debug-logging surface:

- `src/lib/debug-logger.ts` — JSONL writer, fire-and-forget appends to `~/.ralph-hero/logs/session-<ts>.jsonl`, sanitizes keys matching `/token|auth|secret|key|password|credential/i`.
- `src/tools/debug-tools.ts` — registers `ralph_hero__collate_debug` (reads JSONL, signature-groups, *attempts* issue create with placeholder `repoId`) and `ralph_hero__debug_stats` (aggregates JSONL). Both gated by `RALPH_DEBUG=true` in `src/index.ts:527`.
- `src/github-client.ts` — already calls `debugLogger.logGraphQL(...)` on every query/mutate with rate-limit attrs (lines 151-170). This is the natural insertion point for OTel spans.
- `src/__tests__/debug-logger.test.ts` + `debug-tools.test.ts` — existing test coverage for the v1 surface.

v2 replaces the JSONL backend with OTel/Langfuse and deletes `debug_stats`. The signature-grouping logic in `groupErrors()` is correct and can be ported.

Langfuse stack at `~/projects/langfuse/`:
- Running on `localhost:3100` (override file remaps host 3000 → 3100).
- OTLP HTTP endpoint: `http://localhost:3100/api/public/otel/v1/traces` (Langfuse exposes `/api/public/otel` for OTLP ingest).
- Auth: basic auth with `pk-lf-local-dev:sk-lf-local-dev`.
- Public API: `/api/public/traces?limit=N`, `/api/public/observations`.

Claude Code's native OTel emits `mcp.tool.*` spans, hook spans, and session lifecycle when `CLAUDE_CODE_ENABLE_TELEMETRY=1` is set alongside the standard `OTEL_*` env vars. The MCP server's GraphQL calls run inside the inbound tool span via standard OTel context propagation.

## Desired End State

### Verification

- [ ] With `RALPH_DEBUG=true`, `CLAUDE_CODE_ENABLE_TELEMETRY=1`, and Langfuse up, every MCP tool call appears as a span in Langfuse with `ralph_hero.graphql` child spans attached.
- [ ] With `RALPH_DEBUG` unset, the MCP server emits zero OTel traffic (no exporter init, no outbound `:3100` connections).
- [ ] No `gh[ps]_*` token value or `_TOKEN`-suffixed attribute appears in any captured span.
- [ ] `ralph_hero__collate_debug(dryRun: true)` returns a grouped error report from real Langfuse data.
- [ ] Running collation twice over the same window produces zero duplicate issues — second run only appends comments.
- [ ] `/ralph-hero:ralph-debug-collate` skill exists, dry-run → confirm flow works against local Langfuse.

## What We're NOT Doing

- Replacing the v1 JSONL writer with a deprecation path — leave `debug-logger.ts` as-is for now (it can coexist; future cleanup is out of scope).
- Adding `ralph_hero__debug_stats` v2. The v2 spec explicitly drops this — Langfuse UI replaces it. (The v1 implementation in `debug-tools.ts` stays registered for now to avoid breaking existing callers, but no new work goes into it.)
- Non-Langfuse backends. The `backend` parameter is reserved in the tool signature but only `langfuse` is implemented in this group.
- Cross-session sampling. `minOccurrences` (default 3) is the only noise filter.
- Auto-running collation on a schedule. Phase 4 ships a skill — invocation is manual or scheduled externally (launchd templates are out of scope for this group).
- Migrating existing v1 JSONL logs to OTel format.

## Implementation Approach

Five phases, strict linear dependency. Phase 1 is a doc/config-only change that unblocks visual verification of the rest. Phase 2 wires the MCP server into OTel and gives Phase 3a real spans to query against. Phase 3a produces the grouped report; Phase 3b adds the GitHub mutation half. Phase 4 wraps the tool in a one-command skill.

**Phase dependency annotations**: Each phase below carries a `depends_on` annotation. Phases 1 → 2 → 3a → 3b → 4 is a strict chain.

---

## Phase 1: Enable Claude Code OTel → Langfuse (GH-1097 — XS)

- **depends_on**: null

### Overview

Document the four `OTEL_*` env vars and the `RALPH_DEBUG` activation pattern in `CLAUDE.md`. Add a sample `settings.local.json` snippet. Manually verify span flow into Langfuse with the existing `~/projects/langfuse` stack. No code changes.

### Tasks

#### Task 1.1: Document OTel env vars in CLAUDE.md
- **files**: `CLAUDE.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] "Environment Variables" section in `CLAUDE.md` documents `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`
  - [ ] Each env var has: required/optional flag, default value, one-sentence description
  - [ ] Note that `RALPH_DEBUG=true` is the activation switch for OTel — the four `OTEL_*` vars are no-ops when `RALPH_DEBUG` is unset
  - [ ] Basic-auth header construction documented: `Authorization=Basic $(printf '%s' "pk-lf-local-dev:sk-lf-local-dev" | base64)`
  - [ ] Cross-link to `~/projects/CLAUDE.md` Langfuse harness section for stack setup

#### Task 1.2: Add settings.local.json sample to docs
- **files**: `CLAUDE.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] A code-fenced JSON block showing the full `env` block with all five vars (`RALPH_DEBUG`, `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`)
  - [ ] Snippet uses `http://localhost:3100/api/public/otel/v1/traces` as the endpoint
  - [ ] Snippet is copy-pasteable into `~/.claude/settings.json` or a per-repo `.claude/settings.local.json`

#### Task 1.3: Manual verification + hook propagation check
- **files**: `CLAUDE.md` (modify — append verification commands), `thoughts/shared/research/2026-05-11-otel-claude-code-langfuse-verification.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Run `cd ~/projects/langfuse && ./scripts/up.sh` and confirm `curl -fsS http://localhost:3100/api/public/health` returns OK
  - [ ] Set the four env vars and `RALPH_DEBUG=true` in a settings file, restart Claude Code, invoke any `ralph_hero__*` tool
  - [ ] Confirm spans appear in the Langfuse UI at `http://localhost:3100`
  - [ ] Document hook-to-tool span relationship (child vs. sibling) in the verification doc — either outcome is acceptable, only the observed behavior needs recording
  - [ ] Inspect the latest trace's `mcp.tool.params` for any `gh[ps]_*` substring or `_TOKEN` key — confirm absent (or document the leak as a follow-up issue)

### Phase Success Criteria

#### Automated Verification:
- (None — doc-only phase)

#### Manual Verification:
- [ ] Spans visible in Langfuse UI after a Claude Code session that touches the ralph-hero MCP server
- [ ] Hook span propagation behavior documented
- [ ] No token leak in `mcp.tool.params`

**Creates for next phase**: A working Langfuse pipeline that receives Claude Code OTel spans — Phase 2 attaches `ralph_hero.graphql` child spans to those parent spans.

---

## Phase 2: MCP-server OTel SDK + GraphQL child spans (GH-1098 — S)

- **depends_on**: [GH-1097]

### Overview

Add `@opentelemetry/sdk-node` to the MCP server, lazy-init guarded by `RALPH_DEBUG=true`, wrap the four GraphQL entry points in `github-client.ts` to emit `ralph_hero.graphql` child spans with rate-limit attributes, and add a `SpanProcessor` that redacts token-shaped values.

### Tasks

#### Task 2.1: Add OTel dependencies
- **files**: `plugin/ralph-hero/mcp-server/package.json` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/api`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions` added to `dependencies`
  - [ ] `npm install` resolves cleanly, lockfile updated if present
  - [ ] `npm run build` continues to pass (the deps are added but not yet imported)

#### Task 2.2: Create telemetry.ts with lazy init + token scrubbing SpanProcessor
- **files**: `plugin/ralph-hero/mcp-server/src/lib/telemetry.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] Exports `initTelemetry(): NodeSDK | null` — returns `null` if `process.env.RALPH_DEBUG !== "true"`
  - [ ] When enabled: configures `NodeSDK` with `OTLPTraceExporter` reading endpoint from `OTEL_EXPORTER_OTLP_ENDPOINT`, auto-instrumentation OFF
  - [ ] Resource attributes set: `service.name = "ralph-hero"`, `service.version` from `mcp-server/package.json` version (read at module load)
  - [ ] Custom `SpanProcessor` (or `onStart` callback) walks attributes on span start; redacts values matching `/^gh[ps]_/` and keys matching `/_TOKEN$/i` or `/^authorization$/i` (replaces value with `[REDACTED]`)
  - [ ] Exports a `redactTokenAttributes(attrs)` pure function for unit-testing the scrub logic in isolation
  - [ ] Unit tests cover: (a) returns null when RALPH_DEBUG unset, (b) returns NodeSDK when set, (c) redactTokenAttributes redacts `^ghp_...`, `^ghs_...`, key `RALPH_HERO_GITHUB_TOKEN`, key `Authorization`, leaves non-matching values unchanged

#### Task 2.3: Wrap GitHubClient GraphQL methods with span emission
- **files**: `plugin/ralph-hero/mcp-server/src/github-client.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.2]
- **acceptance**:
  - [ ] Import `trace`, `SpanStatusCode` from `@opentelemetry/api`
  - [ ] Inside `executeGraphQL()`, wrap the request in `tracer.startActiveSpan("ralph_hero.graphql", ...)` only when a tracer is available (no-op tracer when SDK not initialized — `@opentelemetry/api` provides this for free)
  - [ ] Set span attributes: `ralph_hero.operation` (from `extractOperationName`), `ralph_hero.rate_limit.remaining`, `ralph_hero.rate_limit.cost`
  - [ ] On error, set `ralph_hero.error_type` to one of: `"graphql"` (generic), `"rate_limit"` (status 403 + retry-after header), `"network"` (no status code)
  - [ ] Span status set to `SpanStatusCode.ERROR` with message on failure
  - [ ] Span ends in a `finally` block to guarantee close even on throws
  - [ ] Existing `debugLogger.logGraphQL(...)` calls preserved verbatim (JSONL coexists with spans)
  - [ ] Unit test: mock the tracer, invoke `executeGraphQL` for both success and failure cases, assert span name, attributes, and status

#### Task 2.4: Call initTelemetry from src/index.ts at startup
- **files**: `plugin/ralph-hero/mcp-server/src/index.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.2, 2.3]
- **acceptance**:
  - [ ] `initTelemetry()` called inside `main()` BEFORE `initGitHubClient(debugLogger)` so spans on early GraphQL calls are captured
  - [ ] Result stored in a local `sdk` variable; if non-null, log `"[ralph-hero] OTel telemetry enabled"` to stderr
  - [ ] Add a `process.on("SIGTERM", ...)` handler that calls `sdk.shutdown()` to flush spans on graceful exit (best-effort, swallow errors)
  - [ ] Build + existing tests still pass

#### Task 2.5: Integration test — token redaction end-to-end
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/telemetry.test.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.2]
- **acceptance**:
  - [ ] Test installs an in-memory span exporter, sets `RALPH_DEBUG=true`, initializes SDK
  - [ ] Manually starts a span with attributes `{ RALPH_HERO_GITHUB_TOKEN: "ghp_fakefake1234567890", Authorization: "Basic abc", harmless: "value" }`
  - [ ] Exports the span, asserts `RALPH_HERO_GITHUB_TOKEN` and `Authorization` are `[REDACTED]`, `harmless` is preserved
  - [ ] Test for verifying no-op behavior: with `RALPH_DEBUG` unset, `initTelemetry()` returns null and no exporter is registered

#### Task 2.6: Replace tautological retry-order regression test (REBASE 2026-05-13; SHIPPED 2026-05-13 with deviation, see below)
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/github-client-tracing.test.ts` (modify on `feature/GH-1098`)
- **tdd**: true
- **complexity**: low
- **depends_on**: [2.5]
- **shipped_as**: commit `57cd1dfd` on `feature/GH-1098` (PR #1197)
- **context**: The test added in commit `b02a1859` to guard against the missing-`await` regression in `executeGraphQL`'s recursive retry path is tautological. It maps two span end-times to nanoseconds, sorts them ascending, then asserts `sortedNs[last] >= sortedNs[0]` — which is true by definition for any sorted array of length ≥1. A future change that drops the `await` on the retry call would still pass this test. PR #1197 review comment: https://github.com/cdubiel08/ralph-hero/pull/1197#issuecomment-4435819106
- **deviation from prescribed code**: The originally-prescribed replacement (`expect(toNs(spans[0].endTime)).toBeLessThanOrEqual(toNs(spans[1].endTime))`) turned out to be tautological for the same structural reason as the original sort: `SimpleSpanProcessor` exports in finish order, so `spans[0]` is by definition the first-finished and has the lowest captured endTime regardless of whether the retry was awaited. Empirically verified: with `await` removed, that prescribed assertion passes ~40% of the time (flaky pass) rather than failing consistently. Additionally, raw HrTime samples taken inside `Span.end()` are not reliably monotonic across rapid consecutive calls in this SDK build — calling `outer.end()` strictly before `inner.end()` can still record `outer.endTime > inner.endTime` ~60% of the time. So endTime comparison is both tautological AND flaky.

  **What shipped instead**: A custom `SpanProcessor` that tracks `onStart` order (deterministic — `onStart` fires synchronously inside `tracer.startActiveSpan`) is added alongside the existing `SimpleSpanProcessor`. The new assertion cross-references start order against finish order: `expect(spans[1].spanContext().spanId).toBe(outerSpanId)`, where `outerSpanId = spanStartOrder[0]`. This says: the LAST-to-finish span (`spans[1]` per `SimpleSpanProcessor`'s deterministic insertion order via `onEnd`) must be the FIRST-to-start span (i.e., the outer/initial span). With `await` in place, outer waits for inner before its `finally` fires → outer is `spans[1]`. Without `await`, outer's `finally` fires synchronously after the catch-block return → outer becomes `spans[0]` and the assertion fails.

  **Why context propagation isn't used as the discriminator**: The two emitted spans are siblings (parent=ROOT), not parent/child, because OTel context doesn't propagate across the recursive `executeGraphQL` call in this codebase (no `AsyncHooksContextManager` is registered). So `parentSpanId` can't be used as a discriminator. Fixing context propagation is a separate concern out of scope for Task 2.6.
- **acceptance**:
  - [x] Drop the tautological `sort` block entirely.
  - [x] Add `expect(spans).toHaveLength(2)` and `expect(spanStartOrder).toHaveLength(2)` so an off-by-one regression can't silently turn the comparison into a no-op.
  - [x] Inline comments name the regression the assertion guards and explain why raw endTime comparison is unreliable.
  - [x] Verified empirically: 10/10 PASS with `await` in place, 10/10 FAIL with `await` removed.
  - [ ] Re-run `code-review:code-review` against PR #1197 to confirm the original review finding is now resolved.

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` — no TypeScript errors
- [ ] `npm test` — all existing tests pass plus new `telemetry.test.ts`
- [ ] `npx vitest run src/__tests__/telemetry.test.ts` — telemetry-specific tests pass
- [ ] `npx vitest run src/__tests__/github-client-tracing.test.ts` — retry-order regression test (Task 2.6) passes and fails when the retry `await` is removed
- [ ] `code-review:code-review` against PR #1197 returns no remaining findings (post-Task-2.6)

#### Manual Verification:
- [ ] With `RALPH_DEBUG=true` and Langfuse up, invoke any `ralph_hero__*` tool; confirm `ralph_hero.graphql` span appears in Langfuse UI under the Claude Code parent span
- [ ] With `RALPH_DEBUG` unset, run a tool call and confirm no `:3100` outbound connections via `lsof -i :3100` or equivalent

**Creates for next phase**: Real `ralph_hero.graphql` error spans flowing into Langfuse — Phase 3a queries them.

---

## Phase 3a: collate_debug — Langfuse query + signature grouping (GH-1099 — S)

- **depends_on**: [GH-1098]

### Overview

Add a minimal Langfuse HTTP client and a signature-grouping module. Wire the existing `ralph_hero__collate_debug` tool to query Langfuse instead of JSONL, return the grouped report when `dryRun=true`. Issue creation deferred to Phase 3b.

### Tasks

#### Task 3a.1: Create langfuse-client.ts
- **files**: `plugin/ralph-hero/mcp-server/src/lib/langfuse-client.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Exports `createLangfuseClient({ host, publicKey, secretKey })` returning an object with `queryTraces(params)` and `queryObservations(params)` methods
  - [ ] Constructor reads defaults from env: `LANGFUSE_HOST` (default `http://localhost:3100`), `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`
  - [ ] Uses Node `fetch` (native in Node 20+) with basic-auth header: `Authorization: Basic ${base64(publicKey + ":" + secretKey)}`
  - [ ] `queryObservations` filters: `type=SPAN`, `level=ERROR` OR contains `ralph_hero.error_type` attribute, `fromStartTime` (ISO), pagination via `page` + `limit` query params
  - [ ] Throws a descriptive error if `publicKey`/`secretKey` missing or HTTP status is non-2xx
  - [ ] Unit tests stub `fetch` and assert: correct URL, correct auth header, correct query params, error on 4xx/5xx, correct pagination loop

#### Task 3a.2: Create error-signature.ts (normalization + grouping)
- **files**: `plugin/ralph-hero/mcp-server/src/lib/error-signature.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Exports `normalizeErrorMessage(msg: string): string` — replaces `#?\d+` with `#N`, ISO timestamps with `<TS>`, UUIDs (8-4-4-4-12 hex) with `<ID>`, hex strings ≥8 chars with `<HASH>`, double-quoted dynamic strings with `<STR>`, collapses whitespace, truncates to 200 chars
  - [ ] Exports `buildSignatureKey(spanName, errorType, normalizedMsg): string` — returns `${spanName}:${errorType}:${normalizedMsg}`
  - [ ] Exports `hashSignature(key: string): string` — returns SHA256 truncated to 8 hex chars
  - [ ] Exports `groupSpansBySignature(spans, opts): SignatureGroup[]` — input span shape `{ name, attributes, status, startTime, endTime, traceId }`; output `{ signature, hash, count, firstSeen, lastSeen, exampleTraceUrl, sampleSpans[] }` (sorted by count desc)
  - [ ] `exampleTraceUrl` built as `${langfuseHost}/project/<defaultProjectId>/traces/${traceId}` — keep `<defaultProjectId>` as a literal placeholder if no project ID is configurable; document the limitation
  - [ ] `groupSpansBySignature` honors `minOccurrences` option (default 3); signatures below threshold are dropped
  - [ ] Unit tests cover: multi-issue-number messages (`Issue #123 and #456` → `Issue #N and #N`), mixed timestamps + UUIDs, nested quotes (`"path/to/file"` + `"name"`), `minOccurrences` boundary

#### Task 3a.3: Add `ralph_hero__collate_debug` v2 signature (Langfuse path, dryRun only)
- **files**: `plugin/ralph-hero/mcp-server/src/tools/debug-tools.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [3a.1, 3a.2]
- **acceptance**:
  - [ ] Replace the existing JSONL-reading body of `ralph_hero__collate_debug` with a Langfuse-querying body. Tool registration name and prefix unchanged.
  - [ ] Tool signature: `{ since?: string, dryRun?: boolean (default true in this phase), minOccurrences?: number (default 3), projectNumber?: number }`
  - [ ] When `dryRun` is missing OR `true`: query Langfuse for spans in the window, group by signature with `minOccurrences` filter, return `{ since, errorGroups: count, totalOccurrences, dryRun: true, groups: [{ signature, hash, count, firstSeen, lastSeen, exampleTraceUrl, sampleSpans[0..2] }] }`
  - [ ] When `dryRun: false`: return `toolError("dryRun=false requires GH-1100 (Phase 3b) — not yet implemented")` — Phase 3b removes this stub
  - [ ] Tool remains gated by the `RALPH_DEBUG=true` check in `src/index.ts:527`
  - [ ] Existing `ralph_hero__debug_stats` tool registration untouched (v1 surface preserved per "What We're NOT Doing")
  - [ ] Unit tests use fixture span data (no live network) — see Task 3a.4

#### Task 3a.4: Integration test against recorded Langfuse trace fixture
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/fixtures/langfuse-spans.fixture.json` (create), `plugin/ralph-hero/mcp-server/src/__tests__/error-signature.test.ts` (create), `plugin/ralph-hero/mcp-server/src/__tests__/collate-debug-langfuse.test.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [3a.1, 3a.2, 3a.3]
- **acceptance**:
  - [ ] Fixture file contains ≥10 synthetic spans with ≥2 distinct signatures, ≥3 occurrences each
  - [ ] `error-signature.test.ts` exercises all normalization edge cases listed in Task 3a.2
  - [ ] `collate-debug-langfuse.test.ts` stubs `fetch` to return the fixture, invokes the tool with `dryRun=true`, asserts grouped report shape + counts
  - [ ] Stubbed fetch validates request URL contains `/api/public/observations` and auth header

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` — no TypeScript errors
- [ ] `npx vitest run src/__tests__/error-signature.test.ts` — all normalization tests pass
- [ ] `npx vitest run src/__tests__/collate-debug-langfuse.test.ts` — fixture-driven integration test passes
- [ ] `npm test` — full suite still green

#### Manual Verification:
- [ ] With Langfuse running and at least one captured error trace, invoking `ralph_hero__collate_debug({ dryRun: true })` returns a non-empty grouped report referencing real trace URLs

**Creates for next phase**: A working grouped report — Phase 3b uses this as input to dedup against GitHub and create/comment issues.

---

## Phase 3b: collate_debug — GitHub dedup + issue create/comment (GH-1100 — S)

- **depends_on**: [GH-1099]

### Overview

Extend `ralph_hero__collate_debug` to honor `dryRun=false`: dedupe each signature against existing open issues labeled `debug-auto` (last 7 days), append occurrence comments on matches or file new issues on misses. Issue body matches the v1 shape (signature, hash, occurrences table, sample, version stamp) plus a Langfuse trace URL section.

### Tasks

#### Task 3b.1: Create debug-issue-shape.ts (issue body + comment body builders)
- **files**: `plugin/ralph-hero/mcp-server/src/lib/debug-issue-shape.ts` (create)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Exports `buildIssueBody(group: SignatureGroup, env: { mcpVersion, nodeVersion, os }): { title: string, body: string }`
  - [ ] Title format: `[Debug] ${group.sampleSpans[0].name}: ${truncate(normalized_message, 60)}`
  - [ ] Body sections (in order): Hash (`\`<8-char-hash>\``), Signature (full string), First seen (version + node + os), Error details (sample attributes), Reproduction (sample JSON, sanitized), Occurrences table (count, firstSeen, lastSeen), Langfuse trace URL
  - [ ] Body includes machine-parseable hash marker on its own line: `**Hash**: \`<hash>\`` — Phase 3b dedup matches on this exact line
  - [ ] Exports `buildCommentBody(group, newCount, latestTraceUrl): string` for occurrence-update comments
  - [ ] Unit tests verify: hash line format is dedup-matchable via regex, no token-shaped values pass through into body (uses the same redaction regex from telemetry.ts), trace URL present

#### Task 3b.2: Implement dedup query against GitHub
- **files**: `plugin/ralph-hero/mcp-server/src/tools/debug-tools.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [3b.1]
- **acceptance**:
  - [ ] Helper `findExistingDebugIssue(client, owner, repo, hash, withinDays=7)` queries GitHub Search API for `repo:owner/repo is:issue is:open label:debug-auto "<hash>" in:body updated:>=<7d ago>`
  - [ ] Returns the matching issue `{ number, id }` or `null` if no match in the window
  - [ ] Uses `client.query` (read-only, repo token)
  - [ ] Handles search rate-limit gracefully — on rate-limit error, treat as no match (creates a duplicate this run; next run will collapse via comment)
  - [ ] Unit test stubs the GraphQL client and verifies query string includes hash, label, and updated filter

#### Task 3b.3: Honor `dryRun=false` — create or comment
- **files**: `plugin/ralph-hero/mcp-server/src/tools/debug-tools.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [3b.1, 3b.2]
- **acceptance**:
  - [ ] When `dryRun: false`, iterate each group: call `findExistingDebugIssue` to dedupe
  - [ ] On match: build comment body via `buildCommentBody`, post via `addComment` GraphQL mutation; increment `issuesUpdated`
  - [ ] On miss: build issue title/body via `buildIssueBody`; create issue via `createIssue` GraphQL mutation with repo node ID (fetch via `client.query` if not cached); apply labels `debug-auto` and `ralph-self-report`; set Backlog workflow state on the project via existing helper (`save_issue` path) — increment `issuesCreated`
  - [ ] Repo node ID lookup uses the SessionCache pattern (key `repo-node-id:owner/repo`)
  - [ ] Return shape: `{ since, errorGroups, totalOccurrences, issuesCreated, issuesUpdated, dryRun: false, groups: [...] }`
  - [ ] Replace the stub `toolError("dryRun=false requires GH-1100")` from Phase 3a
  - [ ] Default for `dryRun` flips from `true` (Phase 3a stub) to `false` (production default per v2 spec) — but the `ralph-debug-collate` skill in Phase 4 always passes `dryRun: true` first
  - [ ] Unit test (using stubbed client): 2 signatures × 5 occurrences → 2 issues created; rerun with same fixture → 0 new issues + 2 comments

#### Task 3b.4: Verify integration round-trip with real Langfuse
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/collate-debug-roundtrip.test.ts` (create, integration-tagged so it can be skipped in CI)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3b.3]
- **acceptance**:
  - [ ] Test gated by `process.env.LANGFUSE_INTEGRATION === "1"` (skip by default in CI)
  - [ ] When enabled: queries real Langfuse, runs `collate_debug({ dryRun: true })`, asserts at least one group returned (or skips with "no errors in window")
  - [ ] Does NOT mutate GitHub from automated test — `dryRun=false` exercise is manual only

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` — no TypeScript errors
- [ ] `npm test` — all suites green; integration test skipped without `LANGFUSE_INTEGRATION=1`
- [ ] Running `collate_debug({ dryRun: false })` twice in succession (manually) shows: first run creates N issues, second run creates 0 issues and posts N comments

#### Manual Verification:
- [ ] One filed `debug-auto` issue contains a clickable Langfuse trace URL that opens the originating trace in the UI
- [ ] No `gh[ps]_*` or `_TOKEN` value appears anywhere in issue bodies or comments (visual scan + grep over a fresh issue)

**Creates for next phase**: A complete `ralph_hero__collate_debug` tool — Phase 4 wraps it in a one-command skill.

---

## Phase 4: ralph-debug-collate skill wrapper (GH-1101 — XS)

- **depends_on**: [GH-1100]

### Overview

Thin skill at `plugin/ralph-hero/skills/ralph-debug-collate/SKILL.md` that wraps `ralph_hero__collate_debug` with a dry-run → confirm → file workflow. Lets a human close the feedback loop with a single `/ralph-hero:ralph-debug-collate` invocation.

### Tasks

#### Task 4.1: Create SKILL.md with frontmatter
- **files**: `plugin/ralph-hero/skills/ralph-debug-collate/SKILL.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Frontmatter follows existing `ralph-*` skill conventions (e.g., compare to `ralph-hygiene`, `ralph-triage` SKILL.md frontmatter shapes)
  - [ ] `description:` field is one sentence, includes trigger phrases like "collate debug errors", "file debug-auto issues", "self-healing observability"
  - [ ] `model:` set to `sonnet` (matches other analyst-tier skills)
  - [ ] `allowed-tools:` lists at minimum the `ralph_hero__collate_debug` MCP tool and Bash (for the `curl` health check)

#### Task 4.2: Implement skill body (preflight → dry-run → confirm → file → summarize)
- **files**: `plugin/ralph-hero/skills/ralph-debug-collate/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] Step 1: Preflight — verify `RALPH_DEBUG=true` in active env (instruct skill to inspect a settings file or fail with a copy-pasteable fix). Check Langfuse health via `curl -fsS http://localhost:3100/api/public/health || exit 2`
  - [ ] Step 2: Call `ralph_hero__collate_debug({ dryRun: true })` and pretty-print the grouped report (top 5 by count, with hash, count, signature snippet, example trace URL)
  - [ ] Step 3: If `errorGroups === 0`: exit with "No errors in window — nothing to file." If `errorGroups > 0`: ask the user to confirm filing (skill is interactive; not part of autopilot)
  - [ ] Step 4: On confirm, call `ralph_hero__collate_debug({ dryRun: false })`. On decline, exit cleanly.
  - [ ] Step 5: Summarize results: `N new issues created, M existing issues commented, top 3 by occurrence: <list>`
  - [ ] Step 6: Suggest next step: `/ralph-hero:ralph-triage` to prioritize the freshly-filed `debug-auto` issues

#### Task 4.3: Document skill in README
- **files**: `plugin/ralph-hero/README.md` (modify — only if a skills table already exists; otherwise skip per "Acceptance criteria" of GH-1101)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.2]
- **acceptance**:
  - [ ] Inspect `plugin/ralph-hero/README.md` for an existing skills table. If present, add a new row for `ralph-debug-collate` matching the column layout (name, description, model, etc.)
  - [ ] If no such table exists, document this finding in the PR description and skip — the GH-1101 acceptance criterion is conditional

### Phase Success Criteria

#### Automated Verification:
- [ ] Skill file parses correctly: `cat plugin/ralph-hero/skills/ralph-debug-collate/SKILL.md | head -20` shows valid YAML frontmatter
- [ ] `/ralph-hero:ralph-debug-collate` appears in `/help` output after plugin reload (manual check)

#### Manual Verification:
- [ ] Run `/ralph-hero:ralph-debug-collate` against the local Langfuse stack with at least one captured error — confirm dry-run output renders, confirmation prompt fires, on-confirm issues get filed and summary prints
- [ ] Re-run immediately — second run files 0 new issues and posts comments on the existing ones

**Creates for next phase**: N/A — final phase.

---

## Merge Sequence (added 2026-05-13)

The branches were stacked in commit order (`feature/GH-1099` was created on top of `feature/GH-1098`'s tip, etc.) but every PR points its base at `main`. Because the children carry the original Phase 2 commit `f3d129d7` but **not** the review-feedback fix `b02a1859`, merging them out of order would re-introduce the missing-`await` and outer-span-ERROR bugs. Land in this order:

1. **Fix the tautology test** on `feature/GH-1098` — execute Task 2.6 above. Push to PR #1197.
2. **Re-run code review on PR #1197** via `code-review:code-review` (or `/ralph-hero:finish` from a fresh state). Confirm zero blocking findings.
3. **Merge PR #1197** to `main`. After merge, advance #1098 to Done (the issue was prematurely closed earlier — just verify state matches reality; the merge hook should handle it).
4. **Rebase `feature/GH-1099` onto the new `main`**. Expected outcome: the original `f3d129d7` commit drops out (it's identical to what just landed via `b02a1859`'s parent), leaving only `581742fd` (Phase 3a). Resolve any conflicts in `github-client.ts` and `__tests__/github-client-tracing.test.ts` by taking the `main` version (it has the test fix). Force-push to PR #1198.
5. **Merge PR #1198** to `main`. Reopen #1099 if needed, then advance to Done after merge.
6. **Rebase `feature/GH-1100` onto the new `main`**. Drops `f3d129d7` and `581742fd` (both now in `main`), leaving `f1500413` (Phase 3b). Force-push to PR #1199.
7. **Merge PR #1199** to `main`. Reopen #1100 if needed, then advance to Done after merge.
8. **Rebase `feature/GH-1101` onto the new `main`**. Drops `f3d129d7`, `581742fd`, and `f1500413`, leaving `977712fe` (Phase 4 skill). Force-push to PR #1200.
9. **Merge PR #1200** to `main`. Reopen #1101 if needed, then advance to Done after merge.
10. **Merge PR #1196 (Phase 1)** any time — it's purely doc-only (`CLAUDE.md` OTel env var documentation) and has no code dependency on phases 2–4. Doing it last avoids documenting endpoints that aren't yet wired up.
11. **Advance parent #1096 to Done** once all 5 children are Done. Verify the Status field auto-syncs via the `advance-parent.yml` workflow.

### Recovery checks at each step

- **After step 3**: `ls plugin/ralph-hero/mcp-server/src/lib/telemetry.ts` succeeds on `main`, and `git log --oneline main -- plugin/ralph-hero/mcp-server/src/lib/telemetry.ts` shows `b02a1859` (or its squashed equivalent).
- **After step 5**: `grep -r "groupSpansBySignature" plugin/ralph-hero/mcp-server/src` returns matches in `lib/error-signature.ts`.
- **After step 7**: `grep -r "findExistingDebugIssue" plugin/ralph-hero/mcp-server/src` returns matches in `tools/debug-tools.ts`.
- **After step 9**: `ls plugin/ralph-hero/skills/ralph-debug-collate/SKILL.md` succeeds on `main`.

### What if a rebase has non-trivial conflicts

If a rebase produces conflicts beyond the test-file fix from Task 2.6 — i.e., conflicts in `github-client.ts` proper, `index.ts`, or `package.json` — STOP and escalate to Human Needed with a comment listing the conflicting files and a one-line description of each conflict. Do not auto-resolve substantive code conflicts in this rebase; the original implementation commits are reviewed code and merging the wrong half could re-introduce the bugs that Task 2.6 guards against.

### Issue state hygiene

Issues #1097–#1101 were marked `state: CLOSED, stateReason: COMPLETED` and `workflowState: Done` before their PRs merged. Reopen them before merging their PRs (the merge hook expects an open issue). Parent #1096 was reopened on 2026-05-13 as part of this rebase.

## Integration Testing

- [ ] End-to-end: `RALPH_DEBUG=true` + `CLAUDE_CODE_ENABLE_TELEMETRY=1` + Langfuse up; force a known MCP error (e.g., `ralph_hero__get_issue` with a bogus issue number) at least 3 times; run `/ralph-hero:ralph-debug-collate`; confirm a `debug-auto` issue is created with the correct hash and a Langfuse trace URL.
- [ ] Token redaction round-trip: inject a fake `ghp_*` value into a span attribute, confirm it appears as `[REDACTED]` in the Langfuse UI AND does not appear in any filed issue body.
- [ ] Zero-overhead sanity: with `RALPH_DEBUG` unset, run a representative MCP session and confirm via `lsof -i :3100` that the MCP server makes no outbound connections to Langfuse.

## References

- Parent spec: [thoughts/shared/plans/2026-05-05-debug-mode-observability-spec-v2.md](2026-05-05-debug-mode-observability-spec-v2.md)
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1096
- Phase issues:
  - https://github.com/cdubiel08/ralph-hero/issues/1097
  - https://github.com/cdubiel08/ralph-hero/issues/1098
  - https://github.com/cdubiel08/ralph-hero/issues/1099
  - https://github.com/cdubiel08/ralph-hero/issues/1100
  - https://github.com/cdubiel08/ralph-hero/issues/1101
- Local Langfuse harness: `/Users/dubiel/projects/CLAUDE.md` (sibling workspace doc)
- Superseded v1 draft: `thoughts/shared/plans/2026-02-21-debug-mode-observability-spec.md`
- Related debug surface (v1 coexists): `plugin/ralph-hero/mcp-server/src/lib/debug-logger.ts`, `plugin/ralph-hero/mcp-server/src/tools/debug-tools.ts`
