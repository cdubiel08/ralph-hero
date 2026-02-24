---
date: 2026-02-24
status: draft
github_issues: [389]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/389
primary_issue: 389
---

# Record Annotated Showcase Demo - Atomic Implementation Plan

## Overview
1 issue for atomic implementation: a human-operator recording session using existing infrastructure. **No new code is required.** All scripts, skills, and tooling are already merged to `main`.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-389 | Record annotated showcase demo (asciinema + chapter markers) | S |

## Current State Analysis

All prerequisite infrastructure is in place:
- `plugin/ralph-hero/scripts/demo-seed.sh` creates a demo umbrella issue with 3 XS sub-issues (merged via PR #391)
- `plugin/ralph-hero/scripts/demo-cleanup.sh` tears down demo issues after recording (merged via PR #392)
- `plugin/ralph-hero/skills/record-demo/SKILL.md` provides the interactive OBS recording workflow
- `plugin/ralph-hero/scripts/ralph-team-loop.sh` runs the `/ralph-team` session being demonstrated
- `plugin/ralph-hero/.gitignore` already excludes `recordings/` directory

The recording is a **human-in-the-loop operation**: a developer must arrange screen layout, start OBS, run the demo session, observe it, and perform post-production. This cannot be fully automated.

## Desired End State

### Verification
- [ ] Recording shows full lifecycle: issue detection -> triage -> research -> plan -> implementation -> PR merged -> Done
- [ ] Chapter markers at each lifecycle phase (aligned with idea doc timestamps)
- [ ] Recording completes in ~10 minutes (demo issues are trivially small)
- [ ] Split-screen shows both terminal and board updating in real-time
- [ ] Recording is hosted and URL is documented in a GitHub issue comment
- [ ] Demo issues are cleaned up after recording

## What We're NOT Doing
- Interactive walkthrough format (Option B from idea doc) -- out of scope
- Architecture diagram animation (Option C from idea doc) -- out of scope
- README/wiki linking (handled by sibling issue #390)
- Building any new scripts, tools, or MCP server features
- Automated headless recording (requires human screen layout)

## Implementation Approach

This is a single operator-executed phase. The human operator follows a structured checklist using the existing `record-demo` skill and demo scripts. The deliverable is a hosted recording with chapter markers, not a code change.

---

## Phase 1: Record, Post-Produce, and Upload Demo
> **Issue**: [GH-389](https://github.com/cdubiel08/ralph-hero/issues/389) | **Research**: [research doc](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-24-GH-0389-record-annotated-showcase-demo.md)

### Prerequisites
- OBS Studio installed and running with WebSocket server enabled
- `obs-cli` installed (`go install github.com/muesli/obs-cli@latest`)
- `asciinema` installed for terminal-only capture
- GitHub Projects board open in browser
- Local `main` branch up to date: `git pull origin main`

### Step 1: Environment Setup

1. **Pull latest main** to ensure demo scripts are available:
   ```bash
   git pull origin main
   ```

2. **Verify demo scripts exist**:
   ```bash
   ls plugin/ralph-hero/scripts/demo-seed.sh plugin/ralph-hero/scripts/demo-cleanup.sh
   ```

3. **Configure OBS split-screen scene**:
   - Left pane: terminal (Claude Code session)
   - Right pane: browser showing GitHub Projects board at `https://github.com/users/cdubiel08/projects/3/views/1`
   - Resolution: 1920x1080 recommended
   - Verify OBS connection: `obs-cli recording status`

### Step 2: Dry Run (Calibrate Duration)

1. **Create demo issues**:
   ```bash
   cd plugin/ralph-hero
   ISSUES=$(./scripts/demo-seed.sh)
   UMBRELLA=$(echo $ISSUES | cut -d' ' -f1)
   echo "Umbrella: $UMBRELLA, All: $ISSUES"
   ```

2. **Run ralph-team WITHOUT recording** to calibrate timing:
   ```bash
   ./scripts/ralph-team-loop.sh "$UMBRELLA"
   ```

3. **Note the duration** -- target is ~10 minutes. If >15 minutes, consider using `--budget=5.00` to constrain.

4. **Clean up dry run issues**:
   ```bash
   echo "$ISSUES" | ./scripts/demo-cleanup.sh
   ```

### Step 3: Record the Demo

1. **Create fresh demo issues**:
   ```bash
   ISSUES=$(./scripts/demo-seed.sh)
   UMBRELLA=$(echo $ISSUES | cut -d' ' -f1)
   ```

2. **Start OBS recording** (or use the `record-demo` skill for guided workflow):
   ```bash
   obs-cli recording start
   ```

3. **Simultaneously start asciinema** for terminal-only capture:
   ```bash
   asciinema rec -i 2.5 -c "./scripts/ralph-team-loop.sh $UMBRELLA" recordings/showcase-demo.cast
   ```
   The `-i 2.5` flag compresses idle gaps longer than 2.5 seconds.

4. **Monitor the GitHub Projects board** in the browser pane -- it should show issues moving through workflow states in real-time.

5. **Stop OBS recording** when the session completes:
   ```bash
   obs-cli recording stop
   ```

### Step 4: Post-Production

1. **Add chapter markers** as a companion text file (YouTube description format):
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
   Adjust timestamps to match actual recording. Save as `recordings/showcase-demo-chapters.txt`.

2. **Generate terminal GIF** (optional, for embedding in comments):
   ```bash
   agg recordings/showcase-demo.cast recordings/showcase-demo.gif
   ```

### Step 5: Upload and Host

**Two-artifact approach** (recommended):

1. **Upload terminal cast to asciinema.org**:
   ```bash
   asciinema upload recordings/showcase-demo.cast
   ```
   Note the returned URL.

2. **Upload split-screen MP4 as GitHub release asset**:
   ```bash
   gh release create demos-v1.0.0 --title "Showcase Demo v1.0" --notes "Annotated demo of /ralph-team lifecycle"
   gh release upload demos-v1.0.0 recordings/showcase-demo.mp4
   ```

3. **Alternative**: Upload to YouTube unlisted if chapter markers in the video description are preferred.

### Step 6: Document and Clean Up

1. **Post recording URLs to GitHub issue #389** via comment:
   ```
   ## Demo Recording

   **Split-screen (OBS)**: [GitHub release URL or YouTube URL]
   **Terminal replay (asciinema)**: [asciinema.org URL]

   Duration: ~X minutes
   Chapter markers: [link to chapters.txt or YouTube description]
   ```

2. **Clean up demo issues**:
   ```bash
   echo "$ISSUES" | ./scripts/demo-cleanup.sh
   ```

### Success Criteria
- [ ] Manual: Split-screen recording (MP4) is hosted at a publicly accessible URL
- [ ] Manual: Terminal-only recording (.cast) is hosted on asciinema.org
- [ ] Manual: Chapter markers document all lifecycle phases with accurate timestamps
- [ ] Manual: Recording shows complete lifecycle from seed to Done in ~10 minutes
- [ ] Manual: GitHub issue #389 has a comment with both hosted URLs
- [ ] Manual: Demo issues are cleaned up after recording

---

## Integration Testing
- [ ] Manual: Play back the hosted recording and verify all chapter timestamps align with lifecycle events
- [ ] Manual: Verify the asciinema.org link renders correctly in a browser
- [ ] Manual: Verify the split-screen recording shows both terminal output and board state changes

## References
- Research: [GH-389 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-24-GH-0389-record-annotated-showcase-demo.md)
- Recording tools research: [demo-recording-tools](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-22-demo-recording-tools.md)
- Idea doc: `thoughts/ideas/2026-02-21-showcase-demo-onboarding.md`
- Parent issue: [GH-310](https://github.com/cdubiel08/ralph-hero/issues/310)
- Demo seed: [GH-387](https://github.com/cdubiel08/ralph-hero/issues/387) (Done)
- Demo cleanup: [GH-388](https://github.com/cdubiel08/ralph-hero/issues/388) (Done)
- Record-demo skill: [SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/record-demo/SKILL.md)
