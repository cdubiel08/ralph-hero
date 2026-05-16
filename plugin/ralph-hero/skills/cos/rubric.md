# Cos Morning Brief Grading Rubric

Five dimensions; each scored 1–5. Scores are integers only.

---

## Dimensions

### 1. Specificity

Does the brief ground every claim in a concrete reference (issue number, file path, commit, date)?

| Score | Anchor |
|-------|--------|
| 1 | No concrete references — all vague ("some issues are in progress", "things are moving") |
| 2 | 1–2 issue refs but most claims are unanchored |
| 3 | Roughly half the claims are grounded; the other half are generalised |
| 4 | Most claims anchored; one or two unanchored statements remain |
| 5 | Every actionable claim is backed by a `#NNN`, a file path, or a verifiable date |

### 2. Actionability

Does the brief surface the single highest-priority next action clearly?

| Score | Anchor |
|-------|--------|
| 1 | No next action stated — purely descriptive |
| 2 | Vague next action ("look into the issues", "continue work") with no ownership or issue ref |
| 3 | A next action is named but lacks the specific issue number or owner |
| 4 | Next action named with issue ref; timing is implicit but inferable |
| 5 | Explicit "next action: [verb] #NNN [by whom / before what]" with enough detail to act without follow-up |

### 3. Signal-vs-noise

Is the brief free of filler, repetition, and meta-commentary ("Here is your brief…")?

| Score | Anchor |
|-------|--------|
| 1 | > 50% of word count is preamble, meta-narration, or repetition of prior content |
| 2 | 30–50% filler |
| 3 | 15–30% filler — some preamble or restated information present |
| 4 | < 15% filler; minor hedging phrases remain |
| 5 | Zero filler — every sentence carries new, actionable signal |

### 4. Novelty

Does the brief surface something that wasn't already in yesterday's brief (or is explicitly new)?

| Score | Anchor |
|-------|--------|
| 1 | Verbatim or near-verbatim restatement of yesterday's brief |
| 2 | Mostly old information with at most one new detail |
| 3 | About half new, half repeated from prior briefs |
| 4 | Mostly new; one or two recycled sentences |
| 5 | Entirely new information (new events, new state changes, new risks surfaced) |

### 5. Brevity

Is the brief short enough to read in under 30 seconds on a phone?

| Score | Anchor |
|-------|--------|
| 1 | > 300 words — requires scrolling |
| 2 | 200–300 words |
| 3 | 150–200 words |
| 4 | 100–150 words |
| 5 | ≤ 100 words — fits on a single phone screen without scrolling |

---

## Output contract

When a grading script invokes `cos.sh --role slow` with this rubric, it passes a prompt that includes:

1. The full text of the morning brief to grade.
2. The full text of this rubric file.
3. The following strict instruction:

> "Grade the brief above against each rubric dimension. Output EXACTLY 5 integers, one per line, with no other text, in this order:
> 1. Specificity
> 2. Actionability
> 3. Signal-vs-noise
> 4. Novelty
> 5. Brevity
>
> Each integer must be between 1 and 5 inclusive. No explanations, no labels, no preamble."

The grading script parses exactly 5 lines of output. A response that does not contain exactly 5 lines, each a single integer in [1,5], is treated as a parse failure for that brief.
