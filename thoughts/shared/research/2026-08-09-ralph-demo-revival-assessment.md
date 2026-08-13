---
date: 2026-08-09
github_issue: 1748
github_url: https://github.com/cdubiel08/ralph-hero/issues/1748
topic: "ralph-demo revival assessment: full archaeology, runtime check, three adversarially-judged refactor designs, and the merged capture→caption→assemble decision"
tags: [research, ralph-demo, remotion, playwright, demo-video, refactor]
status: complete
type: research
---

# Research: ralph-demo revival — assess, judge, decide (epic #1748)

## Prior Work

- builds_on:: [[2026-02-22-demo-recording-skills]] (plan — the original Lineage-A spec: asciinema autonomous + OBS attended)
- builds_on:: [[2026-02-24-GH-0389-record-annotated-showcase-demo]] (research + plan — Lineage B: the public onboarding showcase, never recorded)
- builds_on:: [[2026-07-31-ralph-v2-minimal-harness]] (idea — the v2 principles any revival must conform to; ralph-demo was "kept verbatim", unexamined)
- tensions:: the unspecced Remotion framework itself (PR #565, commit `1ca3d5b3`) — no thoughts/ doc ever described it; this doc is its first and last design record

## Research Question

The owner asked: assess where ralph-demo is or was at, recover the full spirit of the original spec, and decide whether to completely refactor it. Stated vision, verbatim spirit: *"claude tests code in the browser and takes videos of itself explaining what it built — or claude can get much better at using remotion."* Goal of any refactor: **simplification of complex machinery into something an agent can understand and drive.**

Method: 11-agent ultracode workflow — five parallel understanding readers (spec/spirit, code state, live runtime check, board+git archaeology, external landscape), three independent architects with opposing priors, two adversarial judges (skeptic, operator), one completeness critic.

## Verdict

**Full refactor — but "refactor" understates it: the product was never built.** The vision was specced twice (Feb 2026) and delivered **zero** times. No MP4, WebM, or GIF produced by this plugin exists anywhere in the repo or thoughts/. Even the skill eval (#865) closed with "This skill not run" (skipped for lack of a real sprint dataset). What exists is a working render toolchain pointed at the wrong product. Decision: burn both skills and the framework; build the capture → caption → assemble pipeline in v2 idiom (~350 owned lines, one judgment skill). Epic #1748, children #1749–#1752.

## Archaeology (how it got here)

**Two original lineages — neither is the Remotion project:**

- *Lineage A* (GH-364, `thoughts/shared/plans/2026-02-22-demo-recording-skills.md`): "capture product demos and attach video artifacts to outputs." Two modes: **autonomous** (asciinema wraps ralph sessions headlessly, `RALPH_RECORD=true`, `.cast`→GIF→GitHub upload) and **interactive** (human-narrated OBS capture; the skill only does start/stop + pacing). Audience: GitHub issue readers, via a `## Demo Recording` comment extending the Artifact Comment Protocol. The autonomous mode — the closest ancestor of the owner's current vision — was **never built** (wrapper scripts documented only; no trace survives).
- *Lineage B* (GH-310 → #387–390): a ~10-minute public onboarding showcase — split-screen terminal + live board, ralph driving seeded trivial issues end-to-end. #389 escalated `__ESCALATE__ requires human action`, moved to Human Needed, and was closed in a sweep. GH-390's README merged with "recording URL pending from #389" — still pending today. **The showcase was never recorded.**

**The Remotion framework has no spec.** It landed sideways in one commit (`1ca3d5b3`, 2026-03-14, inside skill-audit PR #565): plugin.json, demo-video SKILL.md, and all ~1,860 lines (7 templates, themes, transitions, zod schema, CompositionGenerator, 51 tests) as pure adds — born whole. That commit is also the **last feature commit the machinery ever received**. Everything after is housekeeping (audit touch-ups, the Bucket-3 port of record-demo, the GH-1455 README) and then dependabot only, 2026-05-06 → 2026-08-09.

**What killed momentum: consumerlessness, not cancellation.** Every demo issue closed COMPLETED; attention pivoted (April → ralph-playwright, May → self-containment epic #1430, July → v2 cutover) and never returned. Zero open demo/remotion issues existed on the board before #1748. The v2 cutover kept `plugin/ralph-demo` "verbatim" — deliberately out of scope, neither audited nor endorsed.

## Current state (2026-08-09)

**Runtime: NOT bit-rotted.** Verified live: `pnpm install` resolves in 1.9s (remotion 4.0.507, react 19.2.8, zod 4.4.3); 51/51 vitest tests pass; all 4 compositions list; a real 31-frame MP4 rendered in under a minute. One known flake: the first-ever render on a fresh machine dies once (`ProtocolError: Target closed`) after the ~94MB chrome-headless-shell download; immediate retry succeeds.

**But it renders the wrong product, with latent bugs at its only load-bearing boundary:**

1. `Root.tsx:24` computes `durationInFrames` from `defaultInput` with no `calculateMetadata` — any real input truncates at 495 frames (16.5s).
2. The composition schema wraps props as `{input: VideoInput}` (`Root.tsx:37`) but the SKILL.md render step and `sample-sprint.json` pass a bare `VideoInput` — shape mismatch at the render boundary.
3. 15-frame transition overlaps are never subtracted from total duration.
4. SKILL.md step 4 is validation theater: `pnpm test` only ever reads `sample-sprint.json`, never the newly-authored input.
5. 6 `tsc --noEmit` errors from dependency-typing drift — while all 51 tests stayed green. Tests don't gate what rots.

**Speculative generality:** a pluggable theme system with exactly one theme and a never-rendered `ThemeLogo`; `resolvePreset` with zero production callers; schema-*required* `sprint`/`team`/`date` fields no template renders (the skill interviews the user for data the video discards); an opaque `speedMultiplier` threaded through every animation.

**`record-demo` is dead:** OBS Studio running + `obs-cli` + WebSocket server manually enabled + scene manually configured + human performing the demo live. Autonomous viability: zero. Its `allowed-tools` reference v1 MCP tools (`mcp__plugin_ralph_ralph-github__*`) deleted in the GH-1662 cutover.

**What the owner's vision needs that is entirely absent:** audio/narration (no carrier of any kind), real footage (nothing ingests browser video; no `OffthreadVideo` scene), and autogeneration (content comes from a human interview, not from the issue/diff/test run — inverted for an agent-driven workflow).

## Landscape (Aug 2026)

- **Remotion officially wants agents writing compositions directly**: LLM system prompt at remotion.dev/llms.txt, 11 official agent skills (`npx skills add remotion-dev/skills`), all docs served as raw markdown. This is the vendor-sanctioned path for "claude gets much better at remotion." License: free ≤3-person companies — free here.
- **playwright-cli ships native video**: `video-start` / `video-stop` / `video-chapter` → WebM. `plugin/ralph-playwright/skills/browser/SKILL.md:113` already *lists* `video-start` — but nothing in this repo has ever exercised it. OBS is obviated for browser demos. Caveat: Playwright WebM duration metadata is unreliable → explicit measured durations (ffprobe) required downstream.
- **Prior art is cribbable**: Ultrademo (ultrademo.net, Apache-2.0) is exactly the vision — Playwright real-click capture + TTS + Remotion assembly, shipped as a Claude Code skill. Also Vorec (manifest → recorder → AI narration → MP4).
- **Delivery constraint**: the GitHub API cannot attach video to issue/PR comments (both judges caught rival designs assuming otherwise). Release asset + `## Demo` comment is the pragmatic convention. Comment-drag-drop (~10MB) is human-only.

## The three designs and how the panel judged them

Three independent architects, opposing priors; full structured proposals preserved in the epic's provenance (workflow `wf_da888e86-575`).

1. **blank-stage** (full-rewrite): burn everything; keep a 5-file scaffold + ONE judgment skill; the agent writes a bespoke Remotion composition per demo against a distilled idioms reference, self-verifying by rendering spot frames and Reading the PNGs. ~350 owned lines.
2. **Typed Rail** (incremental-revive): keep the zod→CompositionGenerator spine as "the v2 idiom", fix the render-boundary bugs, add clip+narration scene types, delete themes/presets/OBS.
3. **self-demo pipeline** (gut-and-keep-skeleton): the revival IS the pipeline — capture (playwright video) → script (judgment) → voice (tts.sh) → assemble (thin OffthreadVideo+Audio wrapper), each stage degrading gracefully; Remotion is act-3 polish, not a slide factory.

**Judgment:** the skeptic picked the pipeline (only design whose unattended run degrades to a shippable artifact instead of stranding; caught the gh-attach false premise in both rivals). The operator picked blank-stage (smallest keep-alive surface, drops zod/vitest from the dependabot surface, best repo-fit epic shape; penalized the pipeline's cross-plugin journey-trace schema coupling and L-scope on a repo whose demo lineages die of attention drift). **Both ranked Typed Rail last, for the same reason: its core claim — "the schema hiding Remotion is reliability engineering" — restates the documented failure mode and negates the owner's stated goal.** Its "mastery banks into the template library" defense is empirically contradicted by five months of the library existing and growing by zero templates.

**Completeness critic's sharpest catches:** (a) the history reader initially mis-read eval #865 as having run — it did not; zero end-to-end executions exist to learn from; (b) unaddressed failure modes recorded as standing risks: truth-checking the narration (an agent praising its own work can overclaim; the merge gate reviews code, not media), secrets/PII visible in captured footage, artifact storage/retention; (c) both prior lineages died of consumerlessness and no design names the consumer — hence the retention hook below.

## The merged decision (what #1748 builds)

Blank-stage's minimal owned surface and idiom, with the pipeline's degradation ladder and delivery convention, plus three Typed-Rail grafts:

- **Capture** — playwright-cli `video-start`/`video-stop` in ralph-playwright's existing session-dir conventions. Validated FIRST as its own issue (#1749) before anything depends on it; fallback is Playwright's `recordVideo` context option. No journey-trace schema changes — capture stays a file convention, not a cross-plugin contract.
- **Script** — the agent writes narration from the issue, the PR diff, and the journey it just drove. Pure judgment, no code.
- **Assemble** — 5-file scaffold (`package.json` with proven pins minus vitest/zod/jsdom, `tsconfig` with dom lib, `remotion.config.ts`, `Root.tsx` with ONE composition + `calculateMetadata` deriving duration from props — the truncation bug class dies by construction, blank `Demo.tsx`). References: `remotion-idioms.md` distilled offline from remotion.dev/llms.txt; worked examples `TitleCard.tsx` (salvaged from TitleSlide) and `CaptionedClip.tsx` (`OffthreadVideo` + caption overlay from owned narration text — no whisper — with explicit ffprobe-measured clip duration). Hardened `render.sh`: real exit codes, echoes output path — the one contract at the mutation path, RUN not predicted. Self-verify: render spot frames, Read the PNGs (visual only — it cannot observe timing; honest limit).
- **Deliver** — release asset + `## Demo` comment (the surviving intent of the 2026-02 Artifact Comment Protocol).
- **CI** — install + `remotion compositions` smoke + `tsc --noEmit` (typing drift already rotted silently once under green tests).
- **One skill replaces two**: `ralph-demo:demo`, bare input, explicit degradation ladder (no live UI → slides+captions; render fails after one retry → ship WebM + script.md). Official remotion-dev/skills as granted-never-prescribed equipment. `record-demo` deleted with no successor.
- **Acceptance gate** (#1752): one real captioned MP4 of an actually-shipped change, attached and linked — closing the loop #389 left open. **Retention hook** against a third consumerless death: `/ralph:work` close-out may *offer* the demo lane on feature units — granted, never prescribed.

## Owner decisions (2026-08-09, recorded)

| Decision | Choice |
|---|---|
| Audience / delivery | PR/issue artifacts: release asset + `## Demo` comment |
| Narration v1 | **Captions-only** — burned-in captions from the agent's narration text; no TTS dependency. Voice (macOS `say` → API TTS) is a documented follow-up, not built |
| record-demo (OBS) | Delete, no successor |
| Process | Form the epic now (#1748 → #1749/#1750 parallel → #1751 → #1752) |

Captions-only simplifies the merged design further: the `tts.sh` layer and audio-sync problem drop out of v1 entirely; caption timing anchors to step timestamps.

## Deferred follow-ups (documented, not built)

- TTS voice track (`tts.sh`: macOS `say` free path; OpenAI TTS ~$0.015/min quality path — API-key billing hygiene applies), then `@remotion/captions` styling if voice lands.
- Social formats (vertical/square) — return only when a consumer exists.
- The #389 public onboarding showcase — a natural second dogfood after #1752 proves the pipeline; the README's "recording URL pending" is still open.
- Narration truth-check: before any public-facing use, decide who reviews a video before it posts (the merge gate reviews code, not media).
- Footage hygiene: captured browser video can contain secrets/PII; demos must run against seeded/dev data only.

## Risks carried into the epic

1. Bespoke-per-demo TSX trades a typed contract for judgment — quality varies; the accumulation surface is `references/examples/`, which needs feeding discipline (dogfood retro in #1752 is the mechanism).
2. playwright-cli video commands are young and unexercised here — #1749 validates before dependence; `recordVideo` is the fallback.
3. Spot-frame self-verify is silent — it cannot catch caption-timing drift; v1 keeps sync crude (step-timestamp anchors) rather than growing sync machinery.
4. Third demo lineage on a solo-attention repo — both priors died of drift; the retention hook and 4-issue scope (M total, not L) are the mitigations.
5. Remotion license is free at ≤3 people — revisit if the team grows.
