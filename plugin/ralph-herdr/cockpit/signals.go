// signals.go — the card markings whose data is machine-local: the spawn
// ledger (agent age + branch), the agent's own worktree diff, and the glyph
// set the whole strip is drawn from. Nothing here touches the network, and
// every reader returns a distinguishable "not read" rather than a value —
// a diff we could not measure must never render like a clean worktree.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ── glyphs ──────────────────────────────────────────────────────────────────
//
// The branch/clock/agents glyphs are Nerd Font private-use codepoints. A host
// without a Nerd Font renders tofu at the wrong advance width, which shears
// the whole fixed-width strip — and the strip is what hitTest maps clicks
// through. So they are behind a knob that DEFAULTS TO ASCII: a cockpit that
// looks plainer than it could is strictly better than one whose columns no
// longer line up with the mouse.
//
// The three dots are deliberately NOT gated: ● ○ · are ordinary Unicode with
// predictable single-cell width, not Nerd Font, so the status dot survives on
// every host.
type glyphSet struct {
	branch  string
	clock   string
	chevron string
	agents  string
	// pr leads the In Review chip. ⇅ is ordinary Unicode with a predictable
	// single-cell width, so unlike the branch/clock/agents glyphs it is NOT
	// gated — the chip is the one marking whose absence would be read as
	// "no PR", and a font knob must not be able to say that.
	pr string

	dotFull   string
	dotHollow string
	dotSmall  string
}

// Every codepoint here was verified present in JetBrainsMonoNerdFont-Regular.
var nerdGlyphs = glyphSet{
	branch:    "", // nf-dev-git_branch
	clock:     "", // nf-fa-clock_o
	chevron:   "❯",
	agents:    "", // nf-fa-users
	pr:        "⇅",
	dotFull:   "●",
	dotHollow: "○",
	dotSmall:  "·",
}

var asciiGlyphs = glyphSet{
	branch:    "",
	clock:     "",
	chevron:   ">",
	agents:    "x",
	pr:        "⇅",
	dotFull:   "●",
	dotHollow: "○",
	dotSmall:  "·",
}

// resolveGlyphs reads RALPH_COCKPIT_GLYPHS. Anything that is not exactly
// "nerd" — unset, misspelt, "yes" — takes ASCII: opting IN to a font
// requirement has to be deliberate, because the failure mode is a sheared
// grid rather than a missing icon.
func resolveGlyphs(raw string) glyphSet {
	if strings.EqualFold(strings.TrimSpace(raw), "nerd") {
		return nerdGlyphs
	}
	return asciiGlyphs
}

// ── the spawn ledger ────────────────────────────────────────────────────────

// LedgerSpawn is one `ev:spawn` record: when a session started, where its
// checkout is, and what branch it took.
type LedgerSpawn struct {
	Ref       string
	Issue     int
	SpawnedAt time.Time
	Checkout  string
	Branch    string
	Address   string
}

// Ledger is the parsed spawn history for one board scope.
//
// ByRef is the EXACT join: the snapshot's `tokens.root` is the same
// agent_ref the ledger writes, so a live agent resolves to the record for
// THAT session. Joining on the agent NAME instead reads correctly until a
// unit is respawned, at which point two records share one name and the age
// chip silently reports the dead session's clock.
//
// ByIssue is the weaker, deliberately separate index: the newest spawn for an
// issue, used only for the branch — a fact that outlives the session that
// took it. It is never used for the age, because "some session for this issue
// started at T" is not "the agent you are looking at is T old".
type Ledger struct {
	ByRef   map[string]LedgerSpawn
	ByIssue map[int]LedgerSpawn
	// Read is false when the ledger could not be read at all. The renderer
	// needs it: no ledger and an agent with no record both produce a dash, but
	// only the second is a fact about that agent.
	Read bool
}

// ledgerPath mirrors ralph_ledger_path (ledger.sh): the RALPH_HERDR_LEDGER
// override wins outright, otherwise the board scope is read from the repo's
// own config — .ralph.json when present, ELSE .claude/settings.json's env
// block, wholesale per file and never mixed, matching board.ts loadConfig.
// Process env is deliberately not consulted: the scope is repo-anchored, and
// a stray RALPH_GH_REPO in a shell profile must not repoint the ledger.
//
// Unlike the shell version this never creates the directory — the cockpit
// only ever reads.
func ledgerPath(repo string, getenv func(string) string) string {
	if p := getenv("RALPH_HERDR_LEDGER"); p != "" {
		return p
	}
	owner, name, ok := ledgerScope(repo)
	if !ok {
		return ""
	}
	root := getenv("RALPH_HERDR_LEDGER_ROOT")
	if root == "" {
		home := getenv("HOME")
		if home == "" {
			return ""
		}
		root = filepath.Join(home, ".ralph")
	}
	// Nested <owner>/<repo>, never "<owner>-<repo>": '-' is legal in both
	// names, so the joined form is not injective and two boards would
	// interleave into one file.
	return filepath.Join(root, ledgerSlug(owner), ledgerSlug(name), "ledger.jsonl")
}

func ledgerScope(repo string) (owner, name string, ok bool) {
	if repo == "" {
		return "", "", false
	}
	if raw, err := os.ReadFile(filepath.Join(repo, ".ralph.json")); err == nil {
		var cfg struct {
			Owner string `json:"owner"`
			Repo  string `json:"repo"`
		}
		if json.Unmarshal(raw, &cfg) == nil && cfg.Owner != "" && cfg.Repo != "" {
			return cfg.Owner, cfg.Repo, true
		}
		return "", "", false // .ralph.json exists and answers: no fallback
	}
	raw, err := os.ReadFile(filepath.Join(repo, ".claude", "settings.json"))
	if err != nil {
		return "", "", false
	}
	var cfg struct {
		Env struct {
			Owner string `json:"RALPH_GH_OWNER"`
			Repo  string `json:"RALPH_GH_REPO"`
		} `json:"env"`
	}
	if json.Unmarshal(raw, &cfg) != nil || cfg.Env.Owner == "" || cfg.Env.Repo == "" {
		return "", "", false
	}
	return cfg.Env.Owner, cfg.Env.Repo, true
}

var ledgerUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func ledgerSlug(s string) string {
	s = ledgerUnsafe.ReplaceAllString(s, "-")
	if s == "." || s == ".." {
		return "_" + s
	}
	return s
}

type ledgerRow struct {
	TS       string `json:"ts"`
	Ev       string `json:"ev"`
	AgentRef string `json:"agent_ref"`
	Checkout string `json:"checkout"`
	Lineage  *struct {
		Issue     int    `json:"issue"`
		SpawnedAt string `json:"spawned_at"`
	} `json:"lineage"`
	Tokens map[string]string `json:"tokens"`
}

// readLedger parses the spawn history. Malformed lines are skipped — the
// ledger is append-only and a torn final write must not cost the whole file —
// but an unreadable SOURCE is reported, so "no ledger here" and "every agent
// predates the ledger" stay distinguishable.
//
// Since phase D (GH-2311) the tape is the sqlite sibling: when it exists it
// is served, full stop — the JSONL beside it is frozen at conversion time,
// and serving it would render every later spawn invisible. An unreadable
// present tape reads as "not read" (Read=false), never as the frozen file.
// Only a machine with no sqlite at all still reads the legacy JSONL. The
// sibling path is an extension swap mirroring ralph_lc_db_path (the GH-2310
// shape); the read shells out to sqlite3 rather than linking a driver, the
// same dependency every shell reader already carries.
func readLedger(path string) Ledger {
	l := Ledger{ByRef: map[string]LedgerSpawn{}, ByIssue: map[int]LedgerSpawn{}}
	if path == "" {
		return l
	}
	var src io.Reader
	db := strings.TrimSuffix(path, ".jsonl") + ".sqlite"
	if _, err := os.Stat(db); err == nil {
		bin := os.Getenv("RALPH_SQLITE3_BIN")
		if bin == "" {
			bin = "sqlite3"
		}
		out, err := exec.Command(bin, db, "SELECT payload FROM facts ORDER BY seq;").Output()
		if err != nil {
			return l
		}
		src = bytes.NewReader(out)
	} else {
		f, err := os.Open(path)
		if err != nil {
			return l
		}
		defer f.Close()
		src = f
	}
	l.Read = true

	sc := bufio.NewScanner(src)
	// Lineage records carry a nested object; the default 64 KiB token is
	// ample, but a single over-long line must skip rather than abort the scan.
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var row ledgerRow
		if json.Unmarshal([]byte(line), &row) != nil || row.Ev != "spawn" || row.AgentRef == "" {
			continue
		}
		// lineage.spawned_at is the spawner's own stamp; ts is the ledger
		// write. They agree in practice, and the first is the one that means
		// "the session began".
		stamp := row.TS
		if row.Lineage != nil && row.Lineage.SpawnedAt != "" {
			stamp = row.Lineage.SpawnedAt
		}
		at, err := time.Parse(time.RFC3339, stamp)
		if err != nil {
			continue // an unparseable stamp is not a spawn we can age
		}
		sp := LedgerSpawn{
			Ref:       row.AgentRef,
			SpawnedAt: at,
			Checkout:  row.Checkout,
			Branch:    row.Tokens["branch"],
			Address:   row.Tokens["address"],
		}
		if row.Lineage != nil {
			sp.Issue = row.Lineage.Issue
		}
		l.ByRef[sp.Ref] = sp
		if sp.Issue != 0 {
			if prev, ok := l.ByIssue[sp.Issue]; !ok || at.After(prev.SpawnedAt) {
				l.ByIssue[sp.Issue] = sp
			}
		}
	}
	return l
}

// ── the worktree diff ───────────────────────────────────────────────────────

// DiffStat is one worktree measurement. Known=false is a read that FAILED and
// must never render as +0/-0: a repo we could not measure is not a repo with
// no changes.
type DiffStat struct {
	Add, Del int
	Known    bool
}

// mergeBaseRefs — the default branch, then the conventional name. origin/HEAD
// is the correct answer and is what a normal clone has; a worktree created
// without it (or a repo whose default branch is not tracked) falls back rather
// than reporting every card unreadable.
var mergeBaseRefs = []string{"origin/HEAD", "origin/main"}

var shortstatRe = regexp.MustCompile(`(\d+) insertions?\(\+\)|(\d+) deletions?\(-\)`)

// worktreeDiff measures the agent's checkout against its merge base with the
// default branch: `git diff <base>`, which is committed AND uncommitted work
// in one number — the total sitting in that worktree.
//
// Honest limit, deliberately not fixed: `git diff <commit>` does not count
// UNTRACKED files, so an agent that has written new files without `git add`
// reads +0/-0. Catching them would mean `--intent-to-add` staging, i.e.
// mutating a live agent's index from a viewer.
func worktreeDiff(ctx context.Context, r Runner, checkout string) DiffStat {
	if checkout == "" {
		return DiffStat{}
	}
	base := ""
	for _, ref := range mergeBaseRefs {
		out, _, err := r.Run(ctx, "git", "-C", checkout, "merge-base", "HEAD", ref)
		if err == nil {
			if b := strings.TrimSpace(out); b != "" {
				base = b
				break
			}
		}
	}
	if base == "" {
		return DiffStat{}
	}
	out, _, err := r.Run(ctx, "git", "-C", checkout, "diff", "--shortstat", base)
	if err != nil {
		return DiffStat{}
	}
	// An EMPTY shortstat is a real measurement — a worktree at its base — so
	// it is Known with zeroes, unlike every failure above.
	return parseShortstat(out)
}

func parseShortstat(out string) DiffStat {
	st := DiffStat{Known: true}
	for _, m := range shortstatRe.FindAllStringSubmatch(out, -1) {
		if m[1] != "" {
			st.Add = atoiSafe(m[1])
		}
		if m[2] != "" {
			st.Del = atoiSafe(m[2])
		}
	}
	return st
}

func atoiSafe(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return n
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// ── age formatting ──────────────────────────────────────────────────────────

// formatAge renders a spawn age at MINUTE precision — deliberately, so the
// existing adaptive poll can drive it and no 1 Hz repaint is needed.
//
// A negative age (a clock skew, or a ledger written on another host) renders
// as 0m rather than as a negative duration: the sign is not information the
// operator can use, and "—" is reserved for the stronger fact that there is no
// record at all.
func formatAge(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	mins := int(d / time.Minute)
	days, rem := mins/1440, mins%1440
	hours, m := rem/60, rem%60
	switch {
	case days > 0:
		return fmt.Sprintf("%dd %02dh %02dm", days, hours, m)
	case hours > 0:
		return fmt.Sprintf("%dh %02dm", hours, m)
	default:
		return fmt.Sprintf("%dm", m)
	}
}
