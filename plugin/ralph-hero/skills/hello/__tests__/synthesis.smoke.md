# /hello synthesis smoke check (GH-975)

Manual smoke check until a skill-test harness lands; convert to fixture
when available.

## What this checks

1. The `/hello` skill **synthesizes** per-direction prose from
   `signals + title + memory` rather than rendering `direction.reason`
   verbatim.
2. Two similarly-scored directions produce **meaningfully different**
   prose — not the templated near-duplicates that motivated GH-975.
3. An XL item never gets the substring `"small unblock"` — size language
   reflects `signals.estimateWeight` / `issue.estimate` honestly.
4. The picker label includes a ≤30-char title fragment.

## How to run

Drop one of the fixtures below into a Claude Code session as the
`next_actions` MCP tool's response. The simplest approach is to run
`/hello` against a real board and observe the rendered briefing. If the
real board doesn't reproduce a tied-at-score scenario, mock the tool
output by editing the skill's Step 2 capture to inline one of the
fixtures below, then re-run.

## Fixture A — two similarly-scored P2 stale items + one tied at top

Input (from the live 2026-05-03 14:25 UTC smoke test that motivated this
issue):

```json
{
  "directions": [
    {
      "rank": 1,
      "recommended": true,
      "kind": "issue",
      "issue": {
        "number": 566,
        "title": "Skill audit phase 2 — deep individual audits for remaining skills",
        "workflowState": "Ready for Plan",
        "priority": "P2",
        "estimate": "XL"
      },
      "pr": null,
      "signals": {
        "tags": ["stale", "high-priority"],
        "staleDays": 7,
        "staleThresholdDays": 2,
        "tiedAtScore": 3
      },
      "reason": "Sitting in Ready for Plan for 7 days — small unblock if you have a moment",
      "tags": ["stale", "high-priority"],
      "score": -28
    },
    {
      "rank": 2,
      "recommended": false,
      "kind": "issue",
      "issue": {
        "number": 809,
        "title": "ralph-playwright: baseline trace-YAML refs + step matcher for semantic diff",
        "workflowState": "Ready for Plan",
        "priority": "P2",
        "estimate": "S"
      },
      "pr": null,
      "signals": {
        "tags": ["stale", "high-priority"],
        "staleDays": 11,
        "staleThresholdDays": 2,
        "tiedAtScore": 3
      },
      "reason": "Sitting in Ready for Plan for 11 days — small unblock if you have a moment",
      "tags": ["stale", "high-priority"],
      "score": -28
    },
    {
      "rank": 3,
      "recommended": false,
      "kind": "issue",
      "issue": {
        "number": 813,
        "title": "ralph-playwright: Opus 4.7 semantic diff prompt + regression signal emitter",
        "workflowState": "Ready for Plan",
        "priority": "P2",
        "estimate": "S"
      },
      "pr": null,
      "signals": {
        "tags": ["stale", "high-priority"],
        "staleDays": 11,
        "staleThresholdDays": 2,
        "tiedAtScore": 3
      },
      "reason": "Sitting in Ready for Plan for 11 days — small unblock if you have a moment",
      "tags": ["stale", "high-priority"],
      "score": -28
    }
  ],
  "fetchedAt": "2026-05-03T14:25:00.000Z",
  "totalCandidates": 47
}
```

Expected behaviour (the skill synthesizes prose):

- The recommended-direction sentence mentions the title `"Skill audit
  phase 2"` (or a clear paraphrase) — NOT the verbatim `reason` template.
- Per-direction descriptions vary meaningfully: at least two of the three
  reference different titles AND surface `tiedAtScore: 3` ("tied with 2
  others at the top score" or similar).
- The XL item (#566) is never described as a "small unblock" — the prose
  reflects size honestly given `issue.estimate === "XL"`.
- Picker labels render with a ≤30-char title fragment:
  - rank 1: `"Plan #566 · Skill audit phase 2 — deep…"` (or close
    variant — exact fragment per the truncation rule in SKILL.md Step 4)
  - rank 2: `"Plan #809 · ralph-playwright: baselin…"`
  - rank 3: `"Plan #813 · ralph-playwright: Opus 4.…"`

## Fixture B — single XL stale P2 (negative assertion: never "small unblock")

```json
{
  "directions": [
    {
      "rank": 1,
      "recommended": true,
      "kind": "issue",
      "issue": {
        "number": 566,
        "title": "Skill audit phase 2 — deep individual audits for remaining skills",
        "workflowState": "Ready for Plan",
        "priority": "P2",
        "estimate": "XL"
      },
      "pr": null,
      "signals": {
        "tags": ["stale", "high-priority"],
        "staleDays": 7,
        "staleThresholdDays": 2
      },
      "reason": "Sitting in Ready for Plan for 7 days — small unblock if you have a moment",
      "tags": ["stale", "high-priority"],
      "score": -28
    }
  ],
  "fetchedAt": "2026-05-03T14:25:00.000Z",
  "totalCandidates": 1
}
```

Expected behaviour:

- Synthesized prose **never** contains the literal substring `"small
  unblock"`. The skill must reflect `estimate: "XL"` (large /
  non-trivial / chunky / etc.).
- The synthesized prose mentions the title `"Skill audit phase 2"`.

## Pass criteria

- [ ] Fixture A: synthesized prose for the recommended pick mentions the
      title; descriptions for ranks 2 and 3 differ meaningfully from each
      other (different titles surfaced).
- [ ] Fixture A: at least one direction's prose surfaces the
      `tiedAtScore: 3` count or the tiebreak rationale (rank-1 by issue
      number).
- [ ] Fixture B: synthesized prose contains no `"small unblock"`
      substring.
- [ ] Fixture A & B: picker labels include a title fragment of ≤30 chars
      with `…` suffix when truncated.

## Notes

- This file is a manual checklist because no skill-test harness exists
  in `plugin/ralph-hero/skills/*/__tests__/` yet. Convert to a real
  fixture once a harness lands.
- The `reason` field is intentionally still populated in these fixtures
  — that's the back-compat window. The skill must NOT render it
  verbatim, but the wire shape continues to carry it through 2.6.x.
