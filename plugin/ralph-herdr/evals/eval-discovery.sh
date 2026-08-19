#!/usr/bin/env bash
# eval-discovery.sh — can a blind session find the sanctioned entry point for a
# likely user instruction, and in how many turns? (GH-2075)
#
# Measures DISCOVERY, not execution: the prompt asks for the exact command,
# tools are capped to read-only, and headless -p denies everything else.
# Baseline 2026-08-18: haiku failed `fleet` (answered tick.sh off CLAUDE.md in
# 1 turn); sonnet passed all three at 5-13 turns; opus at 9-15. Turn counts are
# the UX cost GH-2074 exists to shrink — re-run after any change to skills,
# CLAUDE.md, or the cheat sheet, and when a new model or harness shows up.
#
# Env lanes (GH-2075 correction): the runner may itself be cockpit-hosted, and
# children inherit HERDR_*. Never let them — clean-room strips the vars; the
# hosted lane is a real pane and is NOT this script's job.
#
# Usage: eval-discovery.sh [-m MODELS] [-s SCENARIOS] [-o OUTDIR]
set -uo pipefail

# ── simple knobs ─────────────────────────────────────────────────────────────
MODELS="haiku sonnet opus"            # -m; space-separated `claude --model` names
SCENARIOS="fleet cockpit status"      # -s; see scenario_prompt below
OUTDIR="${TMPDIR:-/tmp}/ralph-evals"  # -o; one JSON per run + results.md
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TIMEOUT_SEC=300                       # per run
# ─────────────────────────────────────────────────────────────────────────────

while getopts m:s:o: opt; do case $opt in
  m) MODELS=$OPTARG;; s) SCENARIOS=$OPTARG;; o) OUTDIR=$OPTARG;;
  *) echo "usage: $0 [-m MODELS] [-s SCENARIOS] [-o OUTDIR]" >&2; exit 2;;
esac; done

scenario_prompt() {
  case $1 in
    fleet)   echo "You are in the ralph-hero repo. A user asks: launch a fleet on whatever is workable. Find the sanctioned way to do this and print the exact command(s) you would run. Do NOT execute them.";;
    cockpit) echo "You are in the ralph-hero repo. A user asks: open the ralph cockpit. Find the sanctioned way to do this and print the exact command(s) you would run. Do NOT execute them.";;
    status)  echo "You are in the ralph-hero repo. A user asks: what is the state of the board and is anyone working right now. Find the sanctioned commands to answer this and print them. Do NOT execute anything that mutates state.";;
    *) echo "unknown scenario: $1" >&2; return 2;;
  esac
}

# PASS = the answer names the sanctioned surface. Patterns are the contract:
# editing one is a deliberate re-statement of what "sanctioned" means.
scenario_pattern() {
  case $1 in
    fleet)   echo 'work-fleet\.sh|work-these|work-next';;
    cockpit) echo 'cockpit-launch\.sh|action invoke .*cockpit|entrypoint cockpit';;
    status)  echo 'board (list|next|doctor|frontier)|herdr (pane|agent) list';;
  esac
}

run_one() { # model scenario -> writes $OUTDIR/$model-$scenario.json
  local model=$1 scen=$2 out="$OUTDIR/$1-$2.json"
  ( cd "$REPO_ROOT" && env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
      timeout "$TIMEOUT_SEC" \
      claude -p "$(scenario_prompt "$scen")" --model "$model" --output-format json \
        --allowedTools "Read" "Grep" "Glob" \
        --disallowedTools "Bash" "Edit" "Write" "Task" \
        > "$out" 2>"$out.err" )
}

grade_one() { # model scenario -> one markdown row on stdout
  local model=$1 scen=$2 f="$OUTDIR/$1-$2.json"
  python3 - "$f" "$(scenario_pattern "$scen")" "$model" "$scen" <<'PY'
import json, re, sys
f, pat, model, scen = sys.argv[1:5]
try:
    d = json.load(open(f))
except Exception:
    print(f"| {model} | {scen} | ERROR | - | - | - | run produced no JSON |"); sys.exit(0)
ans = d.get("result", "") or ""
verdict = "PASS" if re.search(pat, ans) else "FAIL"
print(f"| {model} | {scen} | {verdict} | {d.get('num_turns','?')} "
      f"| {round(d.get('duration_ms',0)/1000)}s | ${round(d.get('total_cost_usd',0),3)} | |")
PY
}

mkdir -p "$OUTDIR"
for m in $MODELS; do for s in $SCENARIOS; do run_one "$m" "$s" & done; done
wait

R="$OUTDIR/results.md"
{ echo "# discovery eval — $(date -u +%Y-%m-%dT%H:%MZ) — $(cd "$REPO_ROOT" && git rev-parse --short HEAD)"
  echo; echo "| model | scenario | verdict | turns | dur | cost | notes |"
  echo "|---|---|---|---|---|---|---|"
  for m in $MODELS; do for s in $SCENARIOS; do grade_one "$m" "$s"; done; done
} > "$R"
cat "$R"
grep -q ' FAIL \| ERROR ' "$R" && exit 1 || exit 0
