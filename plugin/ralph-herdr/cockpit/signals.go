// signals.go — the card markings whose data is machine-local: the spawn
// ledger (agent age + branch), the agent's own worktree diff, and the glyph
// tier the whole strip is drawn from. Nothing here touches the network, and
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
	"sort"
	"strings"
	"time"
)

// ── glyphs ──────────────────────────────────────────────────────────────────
//
// Three tiers (GH-2377, the pi-kit shape): nerd, unicode, ascii. Every
// unicode glyph is a single-cell BMP character, so the fixed-width strip —
// which hitTest maps clicks through — cannot shear; unicode is therefore the
// DEFAULT. The nerd tier's chip glyphs are private-use codepoints that render
// as tofu at the wrong advance width without the font, so opting in stays
// deliberate. ascii is the escape hatch for a terminal that draws nothing
// above 7 bits.
//
// The herdr STATE glyphs (the gutter dot) are not in the tier at all: they are
// ordinary Unicode in every tier, nerd included, and dotFor reads the
// constants below directly — three identical rows in a table would be a
// convention, a single definition is the fact.
//
// The nerd tier is written as \uXXXX escapes on purpose: the raw private-use
// characters were silently dropped by one editor write during the design and
// the tier became a set of empty strings. An escape cannot be lost that way.
type glyphSet struct {
	name string // "nerd" | "unicode" | "ascii"; "" is a zero value, never a tier

	branch  string
	chevron string // epic caret
	agents  string // fleet count
	pr      string // the In Review chip
	merge   string // the Done chip: the closing PR that landed
	usd     string
	token   string
	ctx     string
	bang    string // P0
	ok      string
	err     string
	stalled string
	// spin is the liveness spinner's frame set, one rune per frame; the
	// header and the in-flight column headers index it by poll count.
	spin string
}

// Every codepoint here was verified present in JetBrainsMono Nerd Font (cmap
// check, 2026-09-01).
var nerdGlyphs = glyphSet{
	name:    "nerd",
	branch:  "\uE725", // nf-dev-git_branch
	chevron: "❯",
	agents:  "\uF0C0", // nf-fa-users
	pr:      "\uF407", // nf-oct-git_pull_request
	merge:   "\uF419", // nf-oct-git_merge
	usd:     "\uF155", // nf-fa-dollar
	token:   "\uEDE8", // coin
	ctx:     "\uF50C", // context
	bang:    "\uF12A", // nf-fa-exclamation
	ok:      "\uF00C", // nf-fa-check
	err:     "\uF00D", // nf-fa-close
	stalled: "\uF071", // nf-fa-warning
	spin:    "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
}

var unicodeGlyphs = glyphSet{
	name:    "unicode",
	branch:  "⎇",
	chevron: "❯",
	agents:  "×",
	pr:      "⇅",
	merge:   "⌥",
	usd:     "$",
	token:   "¤",
	ctx:     "⛶",
	bang:    "!",
	ok:      "✓",
	err:     "✗",
	stalled: "◍",
	spin:    "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
}

var asciiGlyphs = glyphSet{
	name:    "ascii",
	branch:  "",
	chevron: ">",
	agents:  "x",
	pr:      "pr",
	merge:   "M",
	usd:     "$",
	token:   "tok",
	ctx:     "ctx",
	bang:    "!",
	ok:      "ok",
	err:     "!!",
	stalled: "x",
	spin:    `|/-\`,
}

// The state vocabulary's glyphs — the same in every tier (see above). Filled
// and hollow circles of predictable single-cell width; the status dot must
// survive on every host.
const (
	glyphDotStarting  = "◌"
	glyphDotFilled    = "●" // working, blocked, done — colour tells them apart
	glyphDotReporting = "◕"
	glyphDotHollow    = "○" // idle
	glyphDotNone      = "·"
)

// resolveGlyphs reads RALPH_COCKPIT_GLYPHS: exactly "nerd" or "ascii"
// (case-insensitive, trimmed) selects that tier; anything else — unset,
// misspelt, "yes" — is unicode. Opting IN to a font requirement has to be
// deliberate, because the failure mode is a sheared grid rather than a
// missing icon; opting DOWN to ascii is equally explicit so a typo cannot
// quietly plain the strip.
func resolveGlyphs(raw string) glyphSet {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "nerd":
		return nerdGlyphs
	case "ascii":
		return asciiGlyphs
	}
	return unicodeGlyphs
}

// resolveGlyphTier is the reader the cockpit actually runs (GH-2405): the
// process env first, else the `cockpit_glyphs=` line of the machine-local
// `$RALPH_HOME/config` (`~/.ralph/config`, where `autopilot=` already lives).
// A glyph tier is a property of THIS MACHINE's terminal font, not of a repo
// or a shell: a herdr pane inherits the server's env, not the operator's
// profile exports, so an env-only knob was silently unreachable from the
// sanctioned launch path. Neither source set = unicode, the same default.
func resolveGlyphTier(getenv func(string) string) glyphSet {
	if raw := getenv("RALPH_COCKPIT_GLYPHS"); strings.TrimSpace(raw) != "" {
		return resolveGlyphs(raw)
	}
	return resolveGlyphs(ralphConfigValue(ralphConfigPath(getenv), "cockpit_glyphs"))
}

// ralphConfigPath is $RALPH_HOME/config, else ~/.ralph/config — the file
// tick.sh reads `autopilot=` from. "" when neither root resolves.
func ralphConfigPath(getenv func(string) string) string {
	root := getenv("RALPH_HOME")
	if root == "" {
		home := getenv("HOME")
		if home == "" {
			return ""
		}
		root = filepath.Join(home, ".ralph")
	}
	return filepath.Join(root, "config")
}

// ralphConfigValue reads one `key=value` line from the config file, last
// occurrence wins, both sides trimmed; `#` lines are comments. An unreadable
// file or an absent key is "", which every caller treats as unset.
func ralphConfigValue(path, key string) string {
	if path == "" {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	val := ""
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if ok && strings.TrimSpace(k) == key {
			val = strings.TrimSpace(v)
		}
	}
	return val
}

// resolveTruecolor reads COLORTERM the way termenv does: exactly "truecolor"
// or "24bit" (case-insensitive, trimmed) means the terminal advertised 24-bit
// colour. Unset or anything else is false — the wash is opt-in by the
// TERMINAL's own claim, never inferred from TERM or guessed.
func resolveTruecolor(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "truecolor", "24bit":
		return true
	}
	return false
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

// LedgerUsage is one `ev:usage` record (GH-2347): what the worker's Claude
// session had consumed when the fact was written — the latest per ref wins,
// since every fact is the whole transcript re-read, never a delta. ListUSD is
// a list-price equivalent (rate-limit weight, not a bill); MaxContext is the
// largest single prompt in tokens.
type LedgerUsage struct {
	Ref        string
	At         time.Time
	Model      string
	Calls      int
	ListUSD    float64
	MaxContext int
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
	// Usage is the latest usage fact per agent_ref (GH-2347) — the same
	// exact join as ByRef, for the same reason: a respawned unit's cost is
	// the session on screen, not its dead predecessor's.
	Usage map[string]LedgerUsage
	// Sessions is the Claude session id per agent_ref (GH-2347's
	// claude_session, last-non-empty across the ref's state/discover records
	// — the spawn record predates the conversation). It is the transcript
	// join for a unit whose session has EXITED: a Done card has no live
	// agent to read agent_session from, and this is the durable copy.
	Sessions map[string]string
	// Read is false when the ledger could not be read at all. The renderer
	// needs it: no ledger and an agent with no record both produce a dash, but
	// only the second is a fact about that agent.
	Read bool
}

// todayRefs lists, sorted, every agent_ref with a known Claude session that
// SPAWNED since the local midnight or whose latest usage fact was written
// since then — the day's fleet, for the header's "today" (GH-2405). A ref
// with no session id is not listed: there is no transcript to price.
func (l Ledger) todayRefs(now time.Time) []string {
	y, mo, d := now.Date()
	midnight := time.Date(y, mo, d, 0, 0, 0, 0, now.Location())
	seen := map[string]bool{}
	for ref, sp := range l.ByRef {
		if !sp.SpawnedAt.Before(midnight) && l.Sessions[ref] != "" {
			seen[ref] = true
		}
	}
	for ref, u := range l.Usage {
		if !u.At.Before(midnight) && l.Sessions[ref] != "" {
			seen[ref] = true
		}
	}
	out := make([]string, 0, len(seen))
	for ref := range seen {
		out = append(out, ref)
	}
	sort.Strings(out)
	return out
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
	Tokens  map[string]string `json:"tokens"`
	Session string            `json:"claude_session"`
	Usage   *struct {
		Model      string  `json:"model"`
		Calls      int     `json:"calls"`
		ListUSD    float64 `json:"list_usd"`
		MaxContext int     `json:"max_context"`
	} `json:"usage"`
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
	l := Ledger{ByRef: map[string]LedgerSpawn{}, ByIssue: map[int]LedgerSpawn{}, Usage: map[string]LedgerUsage{}, Sessions: map[string]string{}}
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
		// Same schema gate as the shell readers: a user_version above 1 is a
		// newer ralph's tape, and serving it as v1 would present
		// misinterpreted data as read — degrade to "not read" instead.
		uv, err := exec.Command(bin, db, "PRAGMA user_version;").Output()
		if err != nil {
			return l
		}
		if v := strings.TrimSpace(string(uv)); v != "0" && v != "1" {
			return l
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
	// Phase D lifted the 4096-byte event ceiling, so a single event can be
	// large; the cap is generous accordingly, and a scan that still dies on
	// an over-long token is reported as NOT read (below) rather than served
	// as a silently truncated history.
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var row ledgerRow
		if json.Unmarshal([]byte(line), &row) != nil || row.AgentRef == "" {
			continue
		}
		if row.Session != "" {
			l.Sessions[row.AgentRef] = row.Session
		}
		if row.Ev == "usage" {
			// Latest wins by tape order; a fact with no usage object or an
			// unparseable stamp is skipped rather than served as free.
			if row.Usage == nil {
				continue
			}
			at, err := time.Parse(time.RFC3339, row.TS)
			if err != nil {
				continue
			}
			l.Usage[row.AgentRef] = LedgerUsage{
				Ref: row.AgentRef, At: at, Model: row.Usage.Model, Calls: row.Usage.Calls,
				ListUSD: row.Usage.ListUSD, MaxContext: row.Usage.MaxContext,
			}
			continue
		}
		if row.Ev != "spawn" {
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
	if sc.Err() != nil {
		// A scan aborted mid-stream saw a PREFIX of history; presenting it
		// as read would hide every later spawn behind a healthy flag.
		l.Read = false
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

// ── the transcript join (GH-2378) ───────────────────────────────────────────
//
// Per-session cost and context come from the worker's own Claude transcript:
// herdr's snapshot carries `agent_session.value`, the Claude session id, and
// the harness writes $CLAUDE_CONFIG_DIR/projects/<slug(cwd)>/<id>.jsonl with a
// `usage` block on every assistant row. Machine-local, zero API calls. The
// reduction mirrors ralph_usage_from_transcript (ledger.sh, GH-2347) — dedupe
// by message.id taking the max per field, price at list rates under the
// 1-hour cache TTL Claude Code uses — so the chip and the ledger fact agree
// about the same transcript. Dollars are rate-limit weight, not a bill.

// usagePriceTable stamps which rates priced a number; bump it with the rows.
// The rows are the SAME table ledger.sh carries (`_RALPH_USAGE_PRICES`), and
// usage_test.go asserts byte-for-byte parity so the two cannot drift.
const usagePriceTable = "2026-09-01"

// priceRow is USD per million tokens: input, cache write (5m), cache write
// (1h), cache read, output.
type priceRow struct{ in, w5, w1, read, out float64 }

var usagePrices = map[string]priceRow{
	"claude-fable-5-1":  {10, 12.5, 20, 0.25, 50},
	"claude-mythos-5-1": {10, 12.5, 20, 0.25, 50},
	"claude-fable-5":    {10, 12.5, 20, 1.0, 50},
	"claude-opus-5":     {5, 6.25, 10, 0.5, 25},
	"claude-opus-4-8":   {5, 6.25, 10, 0.5, 25},
	"claude-opus-4-7":   {5, 6.25, 10, 0.5, 25},
	"claude-opus-4-6":   {5, 6.25, 10, 0.5, 25},
	"claude-opus-4-5":   {5, 6.25, 10, 0.5, 25},
	"claude-sonnet-5":   {2, 2.5, 4, 0.2, 10},
	"claude-sonnet-4-6": {3, 3.75, 6, 0.3, 15},
	"claude-sonnet-4-5": {3, 3.75, 6, 0.3, 15},
	"claude-haiku-4-5":  {1, 1.25, 2, 0.1, 5},
}

// priceFor matches a model id by PREFIX, longest row wins — a dated snapshot
// like claude-haiku-4-5-20251001 shares its family's row, and claude-fable-5
// must not swallow claude-fable-5-1.
func priceFor(model string) (priceRow, bool) {
	best, ok, n := priceRow{}, false, -1
	for k, p := range usagePrices {
		if strings.HasPrefix(model, k) && len(k) > n {
			best, ok, n = p, true, len(k)
		}
	}
	return best, ok
}

// contextWindows is each model family's context window in tokens, matched
// by prefix like the price rows (longest wins). The context alert is drawn
// as a FRACTION of this (GH-2405): the fleet runs 1M-window models, and a
// fixed 120k gate — 60% of the 200k window it was written against —
// painted every healthy 240k prompt red. An unknown model takes the
// smaller window, so an unpriced family alerts early rather than never.
var contextWindows = map[string]int{
	"claude-fable-5":    1_000_000,
	"claude-mythos-5":   1_000_000,
	"claude-opus-5":     1_000_000,
	"claude-opus-4-8":   1_000_000,
	"claude-opus-4-7":   1_000_000,
	"claude-opus-4-6":   1_000_000,
	"claude-opus-4-5":   200_000,
	"claude-sonnet-5":   1_000_000,
	"claude-sonnet-4-6": 1_000_000,
	"claude-sonnet-4-5": 200_000,
	"claude-haiku-4-5":  200_000,
}

const defaultContextWindow = 200_000

// contextWindow resolves a model id to its window, prefix-matched.
func contextWindow(model string) int {
	best, n := defaultContextWindow, -1
	for k, w := range contextWindows {
		if strings.HasPrefix(model, k) && len(k) > n {
			best, n = w, len(k)
		}
	}
	return best
}

// CallUsage is one model call after dedupe: when it happened, what it cost,
// and how large its prompt was.
type CallUsage struct {
	At      time.Time // zero when the row carried no parseable timestamp
	USD     float64
	Tokens  int // input + cache write + cache read + output
	Context int // input + cache read + cache write — the prompt the call carried
	Priced  bool
}

// SessionUsage is one transcript reduced. Read=false is a transcript that
// could not be read or held no model call, and it must never render as $0:
// an unmeasured session is not a free one. The per-call slice is kept so the
// header's clock windows ("today", "/h") can be cut at render time against
// the CURRENT clock rather than the clock at read time.
type SessionUsage struct {
	Read        bool
	USD         float64
	Tokens      int
	LastContext int
	// LastModel is the model the last call ran on — the window LastContext
	// is judged against (contextWindow).
	LastModel string
	Unpriced  int
	Calls     []CallUsage
}

// priced reports a reduction that is complete: read, and every call had a
// price row. A session with an unpriced call is NOT a measured session —
// its number would read complete while understating the spend (the
// ledger.sh contract: unpriced is counted, never folded into a total).
func (u SessionUsage) priced() bool { return u.Read && u.Unpriced == 0 }

// since sums the calls at or after t. A call with no timestamp is counted in
// no window — it cannot be placed on the clock.
func (u SessionUsage) since(t time.Time) (usd float64, tokens int) {
	for _, c := range u.Calls {
		if !c.At.IsZero() && !c.At.Before(t) {
			usd += c.USD
			tokens += c.Tokens
		}
	}
	return usd, tokens
}

type transcriptRow struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Message   *struct {
		ID    string `json:"id"`
		Model string `json:"model"`
		Usage *struct {
			Input     *int `json:"input_tokens"`
			CacheW    *int `json:"cache_creation_input_tokens"`
			CacheRead *int `json:"cache_read_input_tokens"`
			Output    *int `json:"output_tokens"`
			Creation  *struct {
				M5 *int `json:"ephemeral_5m_input_tokens"`
				H1 *int `json:"ephemeral_1h_input_tokens"`
			} `json:"cache_creation"`
		} `json:"usage"`
	} `json:"message"`
}

// rawCall is the per-message-id accumulator: a streamed message lands as
// several rows whose input-side counts agree and whose output grows, so the
// max per field is the message's real usage.
type rawCall struct {
	model                            string
	at                               time.Time
	input, w5, w1, wtotal, read, out int
}

func deref(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

// readTranscriptUsage reduces one transcript. Torn or foreign lines are
// skipped, never fatal — the last line of a live transcript is routinely
// mid-write — and lines are read without a length ceiling, because a tool
// result can be megabytes and a scanner that dies on it would serve a PREFIX
// of the session as the whole.
func readTranscriptUsage(path string) SessionUsage {
	f, err := os.Open(path)
	if err != nil {
		return SessionUsage{}
	}
	defer f.Close()
	byID := map[string]*rawCall{}
	var order []string
	rd := bufio.NewReaderSize(f, 256*1024)
	assistant := []byte(`"assistant"`)
	for {
		line, err := rd.ReadBytes('\n')
		if len(line) > 0 && bytes.Contains(line, assistant) {
			var row transcriptRow
			if json.Unmarshal(line, &row) == nil && row.Type == "assistant" &&
				row.Message != nil && row.Message.Usage != nil && row.Message.ID != "" {
				u := row.Message.Usage
				rc, seen := byID[row.Message.ID]
				if !seen {
					rc = &rawCall{model: row.Message.Model}
					byID[row.Message.ID] = rc
					order = append(order, row.Message.ID)
				}
				if rc.model == "" {
					rc.model = row.Message.Model
				}
				if at, perr := time.Parse(time.RFC3339Nano, row.Timestamp); perr == nil && (rc.at.IsZero() || at.Before(rc.at)) {
					rc.at = at
				}
				rc.input = max(rc.input, deref(u.Input))
				rc.wtotal = max(rc.wtotal, deref(u.CacheW))
				rc.read = max(rc.read, deref(u.CacheRead))
				rc.out = max(rc.out, deref(u.Output))
				if u.Creation != nil {
					rc.w5 = max(rc.w5, deref(u.Creation.M5))
					rc.w1 = max(rc.w1, deref(u.Creation.H1))
				}
			}
		}
		if err != nil {
			break
		}
	}
	if len(order) == 0 {
		return SessionUsage{}
	}
	out := SessionUsage{Read: true, Calls: make([]CallUsage, 0, len(order))}
	for _, id := range order {
		rc := byID[id]
		w5, w1 := rc.w5, rc.w1
		if w5+w1 == 0 && rc.wtotal > 0 {
			// A pre-TTL-split usage block reports only the total; charge it
			// at the 1h rate (what Claude Code uses) rather than as free.
			w1 = rc.wtotal
		}
		c := CallUsage{
			At:      rc.at,
			Tokens:  rc.input + w5 + w1 + rc.read + rc.out,
			Context: rc.input + rc.read + w5 + w1,
		}
		if p, ok := priceFor(rc.model); ok {
			c.Priced = true
			c.USD = (float64(rc.input)*p.in + float64(w5)*p.w5 + float64(w1)*p.w1 +
				float64(rc.read)*p.read + float64(rc.out)*p.out) / 1e6
		} else {
			out.Unpriced++
		}
		out.USD += c.USD
		out.Tokens += c.Tokens
		out.LastContext = c.Context
		out.LastModel = rc.model
		out.Calls = append(out.Calls, c)
	}
	return out
}

// transcriptRoot is $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects —
// the harness's own rule (ralph_usage_transcript in ledger.sh). "" = no home,
// which costs the cost chip and nothing else.
func transcriptRoot(getenv func(string) string) string {
	if d := getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return filepath.Join(d, "projects")
	}
	home := getenv("HOME")
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".claude", "projects")
}

var sessionIDRe = regexp.MustCompile(`^[A-Za-z0-9-]+$`)

// transcriptPath locates a session's transcript. The harness slugs the cwd
// with every char outside [A-Za-z0-9] → '-'; that derived path is tried
// first, then a glob over every project dir — a session id is a UUID, so the
// glob cannot collide, and it covers a checkout the ledger recorded
// differently from the pane's cwd. "" = not found (or an id that is not a
// session id, which must never reach a glob).
func transcriptPath(root, checkout, sid string) string {
	if root == "" || sid == "" || !sessionIDRe.MatchString(sid) {
		return ""
	}
	if checkout != "" {
		p := filepath.Join(root, transcriptSlug(checkout), sid+".jsonl")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	matches, err := filepath.Glob(filepath.Join(root, "*", sid+".jsonl"))
	if err != nil || len(matches) == 0 {
		return ""
	}
	return matches[0]
}

func transcriptSlug(p string) string {
	b := []byte(p)
	for i, c := range b {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			b[i] = '-'
		}
	}
	return string(b)
}

// usageEntry is one session's cached reduction, keyed on the transcript's
// size+mtime so an unchanged file is not re-parsed every tick — a live
// transcript is tens of megabytes and a fleet has several.
type usageEntry struct {
	Path  string
	Size  int64
	MTime time.Time
	Usage SessionUsage
	// At is the dispatch time of the pass that produced (or re-confirmed)
	// this entry. Passes overlap, and the one that LANDS last is not the
	// one that READ last: mergeUsage keeps the newer dispatch.
	At time.Time
}

// readSessionUsage resolves and reduces one session, reusing prev when the
// file has not moved. A session whose transcript cannot be found or read
// yields Read=false — the "unread" chip — never a stale prev, which would
// keep drawing a number for a transcript that has since gone.
func readSessionUsage(root, checkout, sid string, prev map[string]usageEntry) usageEntry {
	path := transcriptPath(root, checkout, sid)
	if path == "" {
		return usageEntry{}
	}
	st, err := os.Stat(path)
	if err != nil {
		return usageEntry{}
	}
	if p, ok := prev[sid]; ok && p.Path == path && p.Size == st.Size() && p.MTime.Equal(st.ModTime()) && p.Usage.Read {
		return p
	}
	return usageEntry{Path: path, Size: st.Size(), MTime: st.ModTime(), Usage: readTranscriptUsage(path)}
}

// ── the GraphQL spend log ───────────────────────────────────────────────────

// budgetPath is ~/.ralph/budget.jsonl (RALPH_HOME honoured) — the spend line
// board.ts appends on every invocation (GH-2278). Reading it is how the header
// knows the fleet's GraphQL weight with zero API calls; the number is points
// SPENT in the trailing hour, which is the rolling window GitHub bills on.
func budgetPath(getenv func(string) string) string {
	root := getenv("RALPH_HOME")
	if root == "" {
		home := getenv("HOME")
		if home == "" {
			return ""
		}
		root = filepath.Join(home, ".ralph")
	}
	return filepath.Join(root, "budget.jsonl")
}

// budgetTail bounds the read: the log is append-only and the window is one
// hour, so only the tail can matter. A window that outgrows the tail is
// under-counted, which the caller cannot distinguish from a quiet hour — the
// bound is generous for that reason (a busy fleet writes ~200 lines/hour).
const budgetTail = 512 * 1024

// readBudgetSpend sums the points spent at or after since. ok=false is a log
// that could not be read — rendered as nothing, never as 0.
func readBudgetSpend(path string, since time.Time) (points int, ok bool) {
	if path == "" {
		return 0, false
	}
	f, err := os.Open(path)
	if err != nil {
		return 0, false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return 0, false
	}
	var src io.Reader = f
	if st.Size() > budgetTail {
		if _, err := f.Seek(st.Size()-budgetTail, io.SeekStart); err != nil {
			return 0, false
		}
		src = f
	}
	sc := bufio.NewScanner(src)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	first := st.Size() > budgetTail // a mid-line seek: drop the torn head
	for sc.Scan() {
		if first {
			first = false
			continue
		}
		var row struct {
			At     string `json:"at"`
			Points int    `json:"points"`
		}
		if json.Unmarshal(sc.Bytes(), &row) != nil {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, row.At)
		if err != nil || at.Before(since) {
			continue
		}
		points += row.Points
	}
	if sc.Err() != nil {
		return 0, false
	}
	return points, true
}
