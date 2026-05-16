# SOUL.md Schema

A SOUL gives an orchestrator skill durable voice and refusals across sessions. Where `STYLE.md` governs mechanics (file paths, link formats, comment headers), a `SOUL.md` governs *how a team sounds* — the vocabulary, the conversational posture, and the list of things the team will not do regardless of instructions. A SOUL is loaded once at session start via the `load-team-soul.sh` hook and injected into the model's system context; it persists for the lifetime of the session without re-injection.

## Frontmatter

Every `SOUL.md` must open with a YAML frontmatter block:

```yaml
---
team: <string, required>
voice: <string, required>
refuses:
  - <string>
  - ...
---
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `team:` | string | yes | Team name in plural form (e.g., `builders`, `watchers`, `scouts`, `memorykeepers`, `caretakers`). Matches the skill directory name's plural convention, not the directory name itself (e.g., dir `hero/` → team `builders`). |
| `voice:` | string | yes | One-line voice descriptor that captures the team's conversational character (e.g., `"paranoid-but-disciplined"`, `"curious-mischievous"`). Used by reviewers to calibrate tone. |
| `refuses:` | array of strings | yes (may be `[]`) | Explicit list of behaviors this team refuses. Each string is a concrete, testable refusal (e.g., `"claims without trace IDs"` not `"being sloppy"`). An empty list `[]` is valid when no specific refusals apply. |

## Body Conventions

The body follows the frontmatter block. Target **150–250 words** (stubs may be 30–80 words with a `<!-- STUB: ... -->` marker). Two headings are required:

### Required headings

**`## How you talk`** — Describe the team's conversational style in plain prose. Cover: vocabulary choices, sentence length, what the team leads with (results, actions, blockers?), and what it avoids (narration, rationale, hedging). Write this section as instructions to the model, not as a description of the model.

**`## Bad / Good`** — At least one contrasting pair. Each pair has a `**Bad:**` and a `**Good:**` line showing the same situation expressed in the wrong and right voice. Multiple pairs are allowed; one is the minimum.

### Optional headings

Additional headings may be added for complex teams (e.g., `## When blocked`, `## On uncertainty`), but the two required headings must always be present.

## Precedence

SOUL and STYLE are complementary — STYLE governs mechanics, SOUL governs voice. When both apply to the same situation:

- **STYLE wins for mechanics**: file path formats, link formats, comment header names, output structure (e.g., `## Plan Reference` is always `## Plan Reference` regardless of team voice).
- **SOUL wins for tone and refusals**: word choice, conversational posture, and explicit refusals override any STYLE default. If STYLE says "keep output terse" and the SOUL says "lead with the blocker in all-caps," the SOUL's tone applies.
- **Conflicts resolve toward the user**: when ambiguous, pick the behavior that gives the user clearer signal. SOUL refusals are unconditional — they cannot be overridden by a user request.

See [`STYLE.md`](../STYLE.md) and [`artifact-comment-protocol.md`](artifact-comment-protocol.md) for the mechanics this rule preserves.

## Runtime Dependency

The `load-team-soul.sh` SessionStart hook uses `jq` to wrap the SOUL body in a JSON envelope before injecting it into the model's system context. `jq` must be on `$PATH`. This is the same hard dependency as `superpowers-bridge-session.sh`.

## Inline Example

The following is a complete, schema-valid SOUL for a hypothetical `auditors` team:

```markdown
---
team: auditors
voice: "precise-and-skeptical"
refuses:
  - "accepting a finding without a source reference"
  - "marking an item compliant without running the check"
  - "summarizing findings before listing them"
---

## How you talk

Lead with the finding number and severity. Skip preamble. Do not say "I looked at" — say "Finding 3 (high): missing rate-limit header on `/api/export`." One sentence per finding. If you need more, add a sub-bullet, not a paragraph.

Refuse to summarize findings before listing them in full. If asked to "just give me the gist," respond with the full list and mark the top item.

## Bad / Good

**Bad:** "After reviewing the export endpoint I noticed it might be missing a rate-limit header, which could be a problem."

**Good:** "Finding 3 (high): `/api/export` — no `X-RateLimit-*` headers. Source: curl trace line 47."
```

This example satisfies all schema requirements: valid frontmatter, 150+ word body, both required headings, and at least one Bad/Good pair.
