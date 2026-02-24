---
date: 2026-02-24
github_issue: 389
github_url: https://github.com/cdubiel08/ralph-hero/issues/389
status: complete
type: research
---

# GH-389: Record Annotated Showcase Demo (asciinema + Chapter Markers)

## Problem Statement

Issue #389 is the third deliverable in the 4-issue onboarding showcase group (#387, #388, #389, #390 under parent #310). Its goal is to **record a real `/ralph-team` session** end-to-end using the demo seed issues created by #387, annotate the recording with chapter markers at key lifecycle phases, and host the result at a publicly accessible URL.

The recording is the core deliverable of the onboarding showcase: it demonstrates the full "From Idea to Merged PR in One Command" narrative without requiring a reader to set up ralph-hero first.

Dependencies:
- **#387** (demo-seed.sh) — Done. Script exists on `feature/GH-387` branch, not yet merged to `main`.
- **#388** (demo-cleanup.sh) — Done. Script exists on `feature/GH-388` branch, not yet merged to `main`.
- **#390** (README/wiki section) — Blocked on #389.

**Important**: As of 2026-02-24, the demo scripts (#387, #388) have been implemented and their PRs (#391, #392) are merged according to GitHub issue comments, but the local git `main` branch does not reflect this. The implementer of #389 must first `git pull origin main` to obtain `demo-seed.sh` and `demo-cleanup.sh`.

---

## Current State Analysis

### Infrastructure Already Available

| Asset | Location | Status |
|-------|----------|--------|
| `demo-seed.sh` | `plugin/ralph-hero/scripts/demo-seed.sh` | Merged (need `git pull`) |
| `demo-cleanup.sh` | `plugin/ralph-hero/scripts/demo-cleanup.sh` | Merged (need `git pull`) |
| `record-demo` skill | `plugin/ralph-hero/skills/record-demo/SKILL.md` | Merged on `main` |
| `ralph-team-loop.sh` | `plugin/ralph-hero/scripts/ralph-team-loop.sh` | On `main` |
| `recordings/` gitignore | `plugin/ralph-hero/.gitignore` | On `main` |
| Recording tools research | `thoughts/shared/research/2026-02-22-demo-recording-tools.md` | On `main` |

### Recording Infrastructure Design (from GH-381 + GH-380 research)

The project already has a fully designed recording infrastructure:

**Autonomous Mode (asciinema)**:
- `asciinema rec -c "..." output.cast` — wraps command execution, headless
- `agg` converts `.cast` → `.gif` for embedding in GitHub comments
- Opt-in via `RALPH_RECORD=true` env var
- Idle compression: `-i 2.5` (gaps > 2.5s are compressed)

**Interactive Mode (OBS + obs-cli)**:
- `obs-cli recording start` / `obs-cli recording stop` via WebSocket
- Split-screen scene: left pane = terminal, right pane = browser (GitHub board)
- Full audio + screen capture

**Upload Path**:
- Terminal GIFs: upload to GitHub release asset (`gh release upload demos-v0.0.0 file.gif`)
- Screen recordings: same pattern, or asciinema.org for `.cast` files
- Issue comment linking via `ralph_hero__create_comment` with `## Demo Recording` header

### Issue Spec Requirements

From the issue body and idea doc (`thoughts/ideas/2026-02-21-showcase-demo-onboarding.md`):

1. **Format**: Split-screen — left pane = Claude Code terminal running `/ralph-team NNN`, right pane = GitHub Projects board
2. **Tools**: asciinema for terminal capture + OBS (or equivalent) for split-screen
3. **Chapter markers** at these lifecycle phases (from idea doc timestamp table):

| Timestamp | Event | Description |
|-----------|-------|-------------|
| 0:00 | `/ralph-team 42` | Single command entry point |
| 0:15 | `get_issue` + `detect_pipeline_position` | MCP reads GitHub Projects as source of truth |
| 0:30 | TeamCreate + analyst spawned | Agent teams, parallel workers, task list |
| 1:00 | Issues move on board | Workflow states drive state machine |
| 3:00 | Research doc appears | Artifacts are durable |
| 5:00 | Plan document created | Plans are diffable, stored in git |
| 7:00 | PR opens, CI runs | Standard GitHub flow |
| 9:00 | PR merged, board shows Done | End-to-end traceability |

4. **Target duration**: ~10 minutes (demo issues are trivially small XS sub-issues)
5. **Hosting**: repo wiki, YouTube unlisted, or asciinema.org

### Demo Issues to Use

From `demo-seed.sh` implementation (GH-387 research doc):
- **Umbrella**: `"Demo: Add greeting message to CLI"` (labeled `ralph-demo`)
- **Sub-issue 1**: `"Add 'Welcome to Ralph' banner on first run"` (XS)
- **Sub-issue 2**: `"Add --version flag to ralph-cli.sh"` (XS)
- **Sub-issue 3**: `"Add --help flag with usage summary"` (XS)

These are intentionally trivial so the demo focuses on the *process*, not the implementation.

---

## Key Discoveries

### 1. Split-Screen Recording is Human-Operator Work

The issue requires both a terminal pane (Claude Code running `/ralph-team`) and a browser pane (GitHub Projects board). The `record-demo` skill (GH-381) handles the OBS-controlled recording workflow interactively. The implementer must:
1. Set up OBS with the split-screen scene
2. Have the GitHub Projects board visible in a browser
3. Run `/ralph-hero:record-demo #389` to orchestrate the recording

This is **not fully autonomous** — the human must initiate and narrate. The `record-demo` skill guides this with `AskUserQuestion` prompts.

### 2. Chapter Markers Are Post-Production

asciinema `.cast` files do not natively support chapter markers. Chapter markers must be added during post-production:
- **For OBS recordings (MP4)**: Use `ffmpeg` chapter metadata injection or a companion `.txt` file (YouTube chapter format: timestamp + title per line)
- **For asciinema.org**: Chapter markers can be added to a playlist description
- **For GitHub release assets**: Document chapters in the issue comment body or a companion `CHAPTERS.md`

**YouTube chapter format** (if hosting on YouTube unlisted):
```
0:00 Ralph Hero Demo: From Issue to Merged PR
0:15 MCP Server reads GitHub Projects
0:30 Agent team spins up
1:00 Issues advance through workflow states
3:00 Research documents created
5:00 Implementation plan generated
7:00 PR opened and CI runs
9:00 PR merged, issues marked Done
```

This is the simplest approach: paste into the YouTube video description. No post-production tooling required.

### 3. Hosting Decision

Three options, in order of effort:

| Option | Effort | Pros | Cons |
|--------|--------|------|------|
| asciinema.org (terminal only) | Low | Free, cast playback, shareable URL | Terminal-only; no browser pane visible |
| GitHub release asset | Low | CLI-native, no external accounts | No chapter markers; raw file download |
| YouTube unlisted | Medium | Chapter markers in description; shareable; playback quality | Requires Google account; upload via `yt-dlp` or browser |

**Recommendation**: Two-artifact approach:
1. Upload terminal `.cast` to asciinema.org for pure terminal replay
2. Upload full OBS recording (`.mp4`) as GitHub release asset for the split-screen version
Document both URLs in the issue comment and README.

### 4. `/ralph-hero:record-demo` Skill Already Exists

The skill at `plugin/ralph-hero/skills/record-demo/SKILL.md` provides a 7-step workflow that directly addresses this issue:
- Step 2 fetches issue context from `ralph_hero__get_issue`
- Step 4 starts OBS recording via `obs-cli recording start`
- Step 6 uploads and links recording to the GitHub issue
- Step 7 reports recording file location and upload URL

Implementation of #389 **uses this skill** — it does not extend or modify it.

### 5. Demo Script Interface

`demo-seed.sh` outputs space-separated issue numbers on stdout: `"UMBRELLA_NUM SUB1 SUB2 SUB3"`. The implementation workflow is:

```bash
# 1. Create demo issues
ISSUES=$(./plugin/ralph-hero/scripts/demo-seed.sh)
UMBRELLA=$(echo $ISSUES | cut -d' ' -f1)

# 2. Start OBS recording (via /ralph-hero:record-demo skill)

# 3. Run ralph-team on the umbrella
./plugin/ralph-hero/scripts/ralph-team-loop.sh "$UMBRELLA"

# 4. Stop recording (via /ralph-hero:record-demo skill)

# 5. Clean up
echo "$ISSUES" | ./plugin/ralph-hero/scripts/demo-cleanup.sh
```

### 6. Recording Duration Risk

The idea doc estimates ~10 minutes for XS issues. In practice, `/ralph-team` processing time varies based on:
- GitHub API rate limits (rate limiter may pause)
- Claude model response latency
- Number of issues in the group (4 issues + parent = 5 state transitions)

If the session runs long (>15 min), the recording becomes unwieldy. **Mitigation**: Run a dry-run first without recording to calibrate duration, then record the second run.

---

## Potential Approaches

### Approach A: OBS Split-Screen + YouTube (Recommended)

Record with OBS capturing the split-screen layout (terminal left, GitHub board right). Upload to YouTube unlisted with chapter markers in description. Also upload `.cast` to asciinema.org for terminal-only replay.

**Pros:**
- Chapter markers are first-class via YouTube description
- Split-screen shows the board updating live (most compelling)
- YouTube URL is permanent and shareable
- `/ralph-hero:record-demo` skill handles OBS orchestration

**Cons:**
- Requires OBS to be configured (split-screen scene setup)
- Requires YouTube account and upload step
- OBS requires display (not headless); must be done on a local workstation

### Approach B: asciinema Only (Simpler, Terminal-Only)

Record just the terminal output with `asciinema rec`. Upload to asciinema.org. Chapter markers added as annotations in the description.

**Pros:**
- Fully CLI-native, no GUI required
- asciinema.org provides playback with speed control
- Durable `.cast` format (text-based, diffable in git)

**Cons:**
- Does not show the GitHub Projects board updating — loses the most compelling visual
- Chapter markers are not embedded in the cast; rely on description text
- Does not fulfill the issue spec ("right pane = GitHub Projects board")

### Approach C: asciinema + Playwright Screenshots Composite

Record terminal with asciinema, capture GitHub board screenshots at each phase with Playwright MCP, compose into a side-by-side video with `ffmpeg`.

**Pros:**
- Headless; no OBS required
- Automated screenshot capture at state transitions

**Cons:**
- Complex post-production (ffmpeg composition)
- Screenshots are static, not live video of the board
- Much higher implementation effort than A or B
- Out of scope for S-estimate

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Demo scripts not on local `main` (PRs merged remotely but not pulled) | High | `git pull origin main` before starting |
| OBS not installed/configured on implementer machine | Medium | Fallback to asciinema-only approach (Approach B) |
| `/ralph-team` session runs >20 minutes (too long) | Medium | Do a dry run first; use `--budget=5.00` to constrain |
| GitHub API rate limit pause mid-recording | Low | `RALPH_RECORD_IDLE=15` to suppress idle gaps up to 15s |
| asciinema.org upload requires login | Low | `asciinema auth` or use GitHub release as fallback host |
| Recording shows agent error / needs human escalation | Low | Use well-understood trivial XS issues; rehearse the session |

---

## Recommended Next Steps

1. **Pull latest main**: `git pull origin main` to get `demo-seed.sh` and `demo-cleanup.sh`
2. **Dry run**: Run `demo-seed.sh`, then `ralph-team-loop.sh <UMBRELLA>` without recording to verify duration and behavior
3. **Setup OBS**: Configure split-screen scene (terminal + browser). Verify `obs-cli recording status` works
4. **Record**: Use `/ralph-hero:record-demo #389` skill to guide the recording. Run `ralph-team-loop.sh <UMBRELLA>` while recording
5. **Post-produce**: Add chapter markers (YouTube description or companion `.txt` file)
6. **Upload**: Post to asciinema.org and/or GitHub release asset and/or YouTube unlisted
7. **Clean up**: Run `demo-cleanup.sh` with the umbrella issue number
8. **Document**: Create a companion `RECORDING.md` or update issue with hosting URL, duration, chapter timestamps

The implementation plan should be a **single phase** (record + upload + document) since all infrastructure is already in place. No new scripts or MCP tools are required.

---

## Files Affected

### Will Modify
- None — this issue produces a recording artifact (hosted externally), not a code or doc change. The only codebase artifact is a new research document (this file) and potentially a `RECORDING.md` or issue comment with the hosted URL.

### Will Read (Dependencies)
- `plugin/ralph-hero/scripts/demo-seed.sh` - Creates demo issues for the recording session
- `plugin/ralph-hero/scripts/demo-cleanup.sh` - Tears down demo issues after recording
- `plugin/ralph-hero/scripts/ralph-team-loop.sh` - Command to run during the recording
- `plugin/ralph-hero/skills/record-demo/SKILL.md` - Skill that guides OBS recording workflow
- `thoughts/shared/research/2026-02-22-demo-recording-tools.md` - Tool evaluation and artifact pipeline design
- `thoughts/ideas/2026-02-21-showcase-demo-onboarding.md` - Chapter marker timestamp table and demo narrative
