// fetch.go — every exec the cockpit performs. All arguments travel as argv
// arrays through exec.CommandContext — NEVER through a shell — so card
// titles, questions, and typed answers are data, not syntax. The one bash
// invocation (spawn) passes a CONSTANT script string; the issue number rides
// as a positional parameter, same rule.
//
// Secret gate: pane-tail text rendered into the TUI stays IN the terminal
// (the sanctioned surface — attend.sh's SECRET_RE gate applies to
// NOTIFICATION channels, and the cockpit sends none).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// Config resolves once at startup (main.go) and never changes.
type Config struct {
	Board      string        // board CLI path — RALPH_HERDR_BOARD env or argv[1]
	Herdr      string        // herdr path — HERDR_BIN_PATH else PATH; "" = absent
	Gh         string        // gh path; "" = absent (questions/diff hints degrade)
	Repo       string        // working repo (RALPH_HERDR_REPO else cwd)
	ScriptsDir string        // plugin scripts/ dir for the sanctioned spawn path
	Interval   time.Duration // tick + board-poll FLOOR (default 30s, min 10s)
	// MaxInterval is the hard staleness bound on the adaptive board cadence
	// (GH-1805): the board is never walked less often than this, whatever the
	// backoff says. Equal to Interval = backoff off, a constant cadence.
	MaxInterval time.Duration
	// SignalInterval is the SECOND cadence (GH-2062): the board-sourced card
	// markings and the Done window. Slower than the board poll and deliberately
	// non-adaptive — these reads have no free local oracle to snap them to the
	// floor, and they are the ones with real per-pass cost. Never below
	// Interval: a marking cadence faster than the board it marks would read
	// PR fates for cards the columns have not shown yet.
	SignalInterval time.Duration
	// Truecolor is whether the terminal ADVERTISED 24-bit colour (COLORTERM
	// is truecolor/24bit). It gates the selection wash (spec §7) together
	// with lipgloss's detected profile: a wash quantised to the 256 palette
	// reads as a grey slab on a navy background, so below true colour the
	// card draws no wash at all rather than a worse one.
	Truecolor bool
	// LedgerPath is ~/.ralph/<owner>/<repo>/ledger.jsonl for this board scope,
	// resolved once (ralph_ledger_path's rules). "" = no scope discoverable,
	// which costs the age chip and nothing else.
	LedgerPath string
	// MarksGlob matches board.ts's local write stamps (~/.ralph/cache/
	// items-marks-*.json, GH-1806/audit A6): a newer mtime is evidence of a
	// verified local write, and the board is refetched NOW instead of at the
	// backed-off cadence. "" disables the channel; the poll remains.
	MarksGlob string
	// HeartbeatPath is where this cockpit stamps its liveness each tick
	// (audit D6d) so a dead cockpit is a readable fact, not a discovery.
	// "" disables the write.
	HeartbeatPath string
	// Glyphs gates the Nerd Font codepoints. Default ASCII — see signals.go.
	Glyphs glyphSet
}

// Runner is the exec seam: tests substitute a recorder, production uses
// execRunner. Args are ALWAYS a slice — there is no string-command variant.
type Runner interface {
	Run(ctx context.Context, prog string, args ...string) (stdout string, stderr string, err error)
}

type execRunner struct{ env []string }

func (e execRunner) Run(ctx context.Context, prog string, args ...string) (string, string, error) {
	cmd := exec.CommandContext(ctx, prog, args...)
	if len(e.env) > 0 {
		cmd.Env = append(os.Environ(), e.env...)
	}
	cmd.Stdin = nil // scripts that `read` on failure see EOF, never hang
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	err := cmd.Run()
	return out.String(), errb.String(), err
}

// ── argv builders (pure — the fetch arg-construction tests pin these) ───────

// argsBoardList is the WHOLE-BOARD read: no --state, so ONE process answers
// all three columns (GH-1786). `board list --json` already returns every
// own-repo open item cross-state; --state only filtered that same walk
// client-side inside board.ts, so three --state reads paid for three
// identical walks — board.ts's withCache is per-process and shares nothing
// across them. The partition moved here; the walk happens once.
func argsBoardList() []string     { return []string{"list", "--json"} }
func argsBoardGet(n int) []string { return []string{"get", strconv.Itoa(n), "--json"} }
func argsBoardFrontier() []string { return []string{"frontier", "--json"} }

// The second cadence (GH-2062). Two verbs, not one, because they are wanted at
// different times: card-signals marks cards that are always on screen, while
// the Done window is only ever read behind the `D` key. Folding them together
// would pay for a 14-day closed-issue walk on every pass to fill a column
// nobody is looking at.
func argsCardSignals() []string { return []string{"card-signals", "--json"} }
func argsBoardClosed() []string { return []string{"closed", "--json", "--prs"} }
func argsBoardInbox() []string  { return []string{"inbox", "--json"} }

// The topology snapshot (GH-2219) is two verbs on one keypress: the roster is
// the tree (required), the escalations are its counts (best-effort — a failed
// count renders NOT COUNTED beside a live tree, never an empty one).
func argsBoardRoster() []string      { return []string{"roster", "--json"} }
func argsBoardEscalations() []string { return []string{"escalations", "--json"} }
func argsBoardAnswer(n int, msg string) []string {
	return []string{"answer", strconv.Itoa(n), "-m", msg}
}

// The herd read is the session SNAPSHOT, not `agent list` (GH-1774): the
// snapshot is the only response carrying the workspace/worktree provenance
// needed to tell this repository's agents from every other repository's in the
// same herdr session. `agent list` returns them all, undifferentiated.
func argsApiSnapshot() []string { return []string{"api", "snapshot"} }
func argsAgentRead(name string) []string {
	return []string{"agent", "read", name, "--source", "recent-unwrapped", "--lines", "40"}
}
func argsAgentFocus(name string) []string { return []string{"agent", "focus", name} }
func argsAgentPrompt(name, text, timeoutMS string) []string {
	return []string{"agent", "prompt", name, text, "--wait", "--timeout", timeoutMS}
}

func argsGhComments(n int, repo string) []string {
	return []string{"issue", "view", strconv.Itoa(n), "--json", "comments", "-R", repo}
}

// argsRateLimit is a REST read — it does NOT spend GraphQL points, which is
// why a failed board read can afford to consult it once.
func argsRateLimit() []string { return []string{"api", "rate_limit"} }
func argsPaneSplit() []string {
	return []string{"pane", "split", "--current", "--direction", "down", "--focus"}
}
func argsPaneRun(paneID string, pr int) []string {
	return []string{"pane", "run", paneID, "gh", "pr", "diff", strconv.Itoa(pr)}
}

// spawnScript is the CONSTANT bash body for `s` — the sanctioned spawn path
// (lib.sh spawn_work_session), invoked exactly as work-next.sh invokes it.
// $1 = scripts dir, $2 = issue number; both are positional parameters, so
// nothing card-derived is ever shell-interpretable. The `|| exit $?` matches
// the lib.sh caller idiom (rc capture on the RHS disables set -e inside the
// function body, the mode every existing caller runs it in).
const spawnScript = `set -euo pipefail
. "$1/lib.sh"
billing_guard
ralph_plugin_freshness_notice
QUEUE_JSON=$("$BOARD" next --json 2>/dev/null) || QUEUE_JSON=""
spawn_work_session "$2" "$QUEUE_JSON" || exit $?
`

// freshnessNotice reads lib.sh's ralph_plugin_freshness_notice verdict off the
// spawn's stderr (GH-2340). The notice is advisory and prints to stderr, which
// spawnCmd otherwise discards on a successful spawn — so a cockpit spawn on a
// stale plugin would take the risk the notice exists to announce and announce
// it to nobody. The two phrases are lib.sh's own, pinned by spawn.test.sh.
// Silence is the in-sync (or not-applicable) case, so "" means nothing to say.
func freshnessNotice(stderr string) string {
	switch {
	case strings.Contains(stderr, "INSTALLED ralph-herdr differs"):
		return "plugin STALE — sync with the fleet quiesced"
	case strings.Contains(stderr, "freshness NOT CHECKED"):
		return "plugin freshness NOT CHECKED"
	}
	return ""
}

// freshnessPhrases are the lines lib.sh's notice prints — the two verdict
// phrases above plus the "spawning anyway" line that follows a stale one.
var freshnessPhrases = []string{"INSTALLED ralph-herdr differs", "freshness NOT CHECKED", "spawning anyway"}

// stripFreshnessLines removes the notice from a spawn's stderr so a FAILED
// spawn's detail is the spawn's own error, not the advisory that preceded
// it: the notice prints first, so firstLine over the raw stderr would name
// the staleness twice and the failure never (Codex P2 on #2345).
func stripFreshnessLines(stderr string) string {
	var kept []string
	for _, l := range strings.Split(stderr, "\n") {
		notice := false
		for _, p := range freshnessPhrases {
			if strings.Contains(l, p) {
				notice = true
				break
			}
		}
		if !notice {
			kept = append(kept, l)
		}
	}
	return strings.Join(kept, "\n")
}

func argsSpawn(scriptsDir string, n int) []string {
	return []string{"-c", spawnScript, "ralph-cockpit", scriptsDir, strconv.Itoa(n)}
}

// forkScript is the CONSTANT bash body for `f` — the sanctioned fork path
// (scripts/fork.sh, GH-1892). $1 = scripts dir, $2 = the source pane id, both
// positional, so nothing overlay-derived is shell-interpretable. Placement is
// left to fork.sh's own RALPH_FORK_PLACEMENT default so a user's exported
// choice still reaches it.
const forkScript = `set -euo pipefail
RALPH_FORK_PANE="$2" exec bash "$1/fork.sh"
`

func argsFork(scriptsDir, pane string) []string {
	return []string{"-c", forkScript, "ralph-cockpit", scriptsDir, pane}
}

// ── messages ────────────────────────────────────────────────────────────────

type tickMsg time.Time

type boardMsg struct {
	cols   [3][]Card
	failed [3]bool // per-column: read errored — cols[i] is NOT "empty", it is unknown
	err    string
}

// allColumnsUnknown — the failure shape of a single whole-board read. The
// per-column array survives the collapse to one process deliberately: it is
// what update.go merges on, and it keeps "this column is stale" expressible
// rather than "the board is empty". One read failing means all three columns
// are unknown; nothing about that is all-or-nothing about the RENDER, which
// still shows each column's last good cards.
var allColumnsUnknown = [3]bool{true, true, true}

type agentsMsg struct {
	agents  []Agent
	herdrOK bool
	// ledger rides along on the same message because it is read on the same
	// tick and joins to exactly these agents. A stale ledger against fresh
	// agents would age a session by another session's clock.
	ledger Ledger
}

// diffsMsg carries one bounded pass of worktree measurements, keyed by
// agent_ref. Absent from the map = not measured this pass, which the renderer
// draws as ±? — never as a clean worktree.
type diffsMsg struct{ diffs map[string]DiffStat }

// signalsMsg carries one pass of the board-sourced card markings. `ok` is the
// whole degradation contract: false means the read FAILED, and every In Review
// chip renders grey `?` rather than blank. Within a successful pass the map is
// authoritative per issue — an issue present with PRFateNone genuinely has no
// PR, an issue ABSENT was not in the read and stays unread.
type signalsMsg struct {
	prs   map[int]PRMark
	epics map[int]EpicRollup
	ok    bool
	err   string
}

// doneMsg carries the bounded closed-issue window. Same split: `ok` false is a
// failed read, which the column names rather than drawing as "nothing closed".
type doneMsg struct {
	cards      []Card
	windowDays int
	ok         bool
	err        string
}

// inboxMsg carries `board inbox` Tier 1 (GH-2181). Same split again: `ok`
// false is a failed read, which the column names rather than drawing as an
// empty inbox. withheld is the GH-2108 honesty line — rows the classifier
// held back, counted by reason, so "nothing here" and "the reader dropped it"
// can never render alike.
type inboxMsg struct {
	cards    []Card
	withheld string
	leads    string // GH-2218: rows still with their leads — "#N (lead), #M (lead)"
	ok       bool
	err      string
}

type peekMsg struct {
	who  string
	text string
	err  string
}

type replyDoneMsg struct {
	who    string
	ok     bool
	detail string
}

// answerDoneMsg surfaces BOTH halves distinctly: the durable board verb and
// the decorative agent nudge. boardPosted covers board.ts's split failure:
// answer() posts the **Answer** comment BEFORE the Human Needed → In Progress
// move, and a post-comment refusal says "The answer comment IS on the record —
// retry the move, not the answer" — rc≠0 with the comment already durable.
type answerDoneMsg struct {
	issue       int
	boardOK     bool
	boardPosted bool // rc≠0 but the durable Answer comment IS on the record
	boardDetail string
	agentTried  bool
	agentName   string
	agentOK     bool
	agentDetail string
}

type dagMsg struct {
	text string
	err  string
}

// topoMsg carries the topology snapshot (GH-2219). err ≠ "" means the ROSTER
// read failed and there is no tree; escErr ≠ "" means only the escalation
// counts are unreadable and the tree stands with NOT COUNTED beside it.
type topoMsg struct {
	rows       []TopoRow
	repo       string
	withheld   string
	agentsNote string
	escs       []TopoEsc
	escErr     string
	err        string
}

type spawnDoneMsg struct {
	issue  int
	rc     int // 0 spawned, 2 skipped (already owned), else failure
	detail string
	notice string // freshnessNotice verdict; "" when the plugin is in sync
}

type forkDoneMsg struct {
	issue  int
	rc     int // 0 forked, else refusal/failure
	detail string
}

// statusMsg is a typed status-line result (spec §10): the kind picks the
// leading glyph, the text is the message verbatim.
type statusMsg struct {
	kind statusKind
	text string
}

func refused(format string, a ...any) statusMsg {
	return statusMsg{kind: statusRefuse, text: fmt.Sprintf(format, a...)}
}

func landed(format string, a ...any) statusMsg {
	return statusMsg{kind: statusOK, text: fmt.Sprintf(format, a...)}
}

// ── parsers ─────────────────────────────────────────────────────────────────

type listItemJSON struct {
	Number       int    `json:"number"`
	Repo         string `json:"repo"`
	Title        string `json:"title"`
	State        string `json:"state"`
	Priority     string `json:"priority"`
	Estimate     string `json:"estimate"`
	ParentNumber *int   `json:"parentNumber"`
}

// parseBoardColumns partitions ONE cross-state `board list --json` payload
// into the three cockpit columns. Membership is decided by the item's own
// State matched against columnStates — the same verbatim comparison the
// per-state parse used to make, so a board CLI that returned the wrong rows
// still cannot mis-column a card; items in any other state (Backlog, and
// anything the board grows later) are simply not cockpit cards. Board order
// is preserved within each column.
//
// `items` is a POINTER so absence survives decoding: `{}`, `null` and
// `{"items":null}` all leave a plain slice nil, which is indistinguishable
// from a board with no cards. Rendering those as an empty board is exactly the
// "no items" / "I could not find out" collapse this whole change exists to
// prevent — a schema-invalid payload is a FAILED read, and the caller maps a
// failed read to all three columns UNKNOWN. Same rule, and the same pointer
// idiom, as the snapshot envelope's arrays in parseAgents (GH-1774).
func parseBoardColumns(out string) ([3][]Card, error) {
	var cols [3][]Card
	var payload struct {
		Items *[]listItemJSON `json:"items"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		return cols, fmt.Errorf("list --json: %w", err)
	}
	if payload.Items == nil {
		return cols, fmt.Errorf("list --json: payload carries no items array — a malformed read is not an empty board")
	}
	for _, it := range *payload.Items {
		idx := -1
		for i, state := range columnStates {
			if it.State == state {
				idx = i
				break
			}
		}
		if idx < 0 {
			continue
		}
		c := Card{
			Number:   it.Number,
			Repo:     it.Repo,
			Title:    it.Title,
			State:    it.State,
			Priority: it.Priority,
			Estimate: it.Estimate,
		}
		if it.ParentNumber != nil {
			c.ParentNumber = *it.ParentNumber
		}
		cols[idx] = append(cols[idx], c)
	}
	return cols, nil
}

// parseCardSignals reads `board card-signals --json`.
//
// Both arrays are POINTERS for the same reason parseBoardColumns's is: `{}`,
// `null` and a schema-invalid payload all decode to nil slices, and rendering
// those as "every In Review card has no PR" is the confident lie this whole
// unit exists to prevent. A payload missing either array is a FAILED read, and
// the caller maps a failed read to every chip UNREAD.
func parseCardSignals(out string) (map[int]PRMark, map[int]EpicRollup, error) {
	var payload struct {
		InReview *[]struct {
			Number int `json:"number"`
			PRs    *[]struct {
				Number    int    `json:"number"`
				State     string `json:"state"`
				Merged    bool   `json:"merged"`
				Checks    string `json:"checks"`
				Mergeable string `json:"mergeable"`
			} `json:"prs"`
		} `json:"inReview"`
		Epics *[]struct {
			Number    int    `json:"number"`
			Title     string `json:"title"`
			Done      int    `json:"done"`
			Total     int    `json:"total"`
			Truncated bool   `json:"truncated"`
		} `json:"epics"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		return nil, nil, fmt.Errorf("card-signals --json: %w", err)
	}
	if payload.InReview == nil || payload.Epics == nil {
		return nil, nil, fmt.Errorf("card-signals --json: payload carries no inReview/epics array — a malformed read is not an unmarked board")
	}
	prs := make(map[int]PRMark, len(*payload.InReview))
	for _, r := range *payload.InReview {
		// A row whose `prs` key is absent is the same hazard one level down:
		// it would mark the card "no PR" off a read that never answered. Leave
		// the issue OUT of the map, which renders unread.
		if r.PRs == nil {
			continue
		}
		mark := PRMark{Fate: PRFateNone}
		for _, p := range *r.PRs {
			cand := PRMark{Number: p.Number, Fate: prFate(p.State, p.Merged, p.Checks, p.Mergeable)}
			if betterChip(cand, mark) {
				mark = cand
			}
		}
		prs[r.Number] = mark
	}
	epics := make(map[int]EpicRollup, len(*payload.Epics))
	for _, e := range *payload.Epics {
		epics[e.Number] = EpicRollup{
			Number: e.Number, Title: e.Title,
			Done: e.Done, Total: e.Total, Truncated: e.Truncated,
		}
	}
	return prs, epics, nil
}

// parseClosed reads `board closed --json --prs` into Done cards. Same pointer
// rule: an absent `items` array is a failed read, never an empty window.
//
// `closingPRs` is a pointer one level down for the same reason card-signals'
// `prs` is: a row whose array is ABSENT (a board CLI that predates `--prs`
// ignores the flag and emits none) must render the merge chip UNREAD, while
// an empty array is the stronger fact that GitHub links no PR to this close.
func parseClosed(out string) ([]Card, int, error) {
	var payload struct {
		WindowDays int `json:"windowDays"`
		Items      *[]struct {
			Number     int    `json:"number"`
			Repo       string `json:"repo"`
			Title      string `json:"title"`
			ClosedAt   string `json:"closedAt"`
			ClosingPRs *[]struct {
				Number int  `json:"number"`
				Merged bool `json:"merged"`
			} `json:"closingPRs"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		return nil, 0, fmt.Errorf("closed --json: %w", err)
	}
	if payload.Items == nil {
		return nil, 0, fmt.Errorf("closed --json: payload carries no items array — a malformed read is not an empty window")
	}
	cards := make([]Card, 0, len(*payload.Items))
	for _, it := range *payload.Items {
		c := Card{
			Number: it.Number, Repo: it.Repo, Title: it.Title,
			State: doneState, ClosedAt: it.ClosedAt,
		}
		if it.ClosingPRs != nil {
			c.ClosingPRsRead = true
			for _, p := range *it.ClosingPRs {
				// Only a MERGED closing PR is the Done gate's evidence; a
				// closed-unmerged one linked by keyword proves nothing landed.
				if p.Merged && p.Number > c.MergedPR {
					c.MergedPR = p.Number
				}
			}
		}
		cards = append(cards, c)
	}
	return cards, payload.WindowDays, nil
}

// parseInbox reads `board inbox --json` Tier 1 into Inbox cards, in the CLI's
// own section order (decisions, proposals, approvals, deliver-blocked — the
// precedence classifyInbox already decided). Same pointer rule: an absent
// `tier1` object is a failed read, never an empty inbox.
func parseInbox(out string) (cards []Card, withheld, leads string, err error) {
	type row struct {
		Number   int     `json:"number"`
		Repo     *string `json:"repo"`
		Title    string  `json:"title"`
		Queue    string  `json:"queue"`
		Priority *string `json:"priority"`
		Estimate *string `json:"estimate"`
		Detail   *string `json:"detail"`
		Verb     string  `json:"verb"`
	}
	var payload struct {
		Tier1 *struct {
			Decisions      []row `json:"decisions"`
			Proposals      []row `json:"proposals"`
			Approvals      []row `json:"approvals"`
			DeliverBlocked []row `json:"deliverBlocked"`
			Withheld       []struct {
				Reason string `json:"reason"`
				Count  int    `json:"count"`
			} `json:"withheld"`
			LeadPending []struct {
				Number int     `json:"number"`
				Lead   *string `json:"lead"`
			} `json:"leadPending"`
		} `json:"tier1"`
	}
	if uerr := json.Unmarshal([]byte(out), &payload); uerr != nil {
		return nil, "", "", fmt.Errorf("inbox --json: %w", uerr)
	}
	if payload.Tier1 == nil {
		return nil, "", "", fmt.Errorf("inbox --json: payload carries no tier1 object — a malformed read is not an empty inbox")
	}
	deref := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	for _, rows := range [][]row{
		payload.Tier1.Decisions, payload.Tier1.Proposals,
		payload.Tier1.Approvals, payload.Tier1.DeliverBlocked,
	} {
		for _, r := range rows {
			cards = append(cards, Card{
				Number: r.Number, Repo: deref(r.Repo), Title: r.Title,
				State: inboxState, Priority: deref(r.Priority), Estimate: deref(r.Estimate),
				Question: deref(r.Detail), Queue: r.Queue, Verb: r.Verb,
			})
		}
	}
	parts := make([]string, 0, len(payload.Tier1.Withheld))
	for _, w := range payload.Tier1.Withheld {
		parts = append(parts, fmt.Sprintf("%d %s", w.Count, w.Reason))
	}
	// GH-2218: a lead-routed decision inside its window is the LEAD's row.
	// Counted here by number and lead so the view can say where it is; a null
	// lead is an unreadable route payload and is named as such, never blank.
	leadParts := make([]string, 0, len(payload.Tier1.LeadPending))
	for _, l := range payload.Tier1.LeadPending {
		who := "unnamed lead"
		if l.Lead != nil && *l.Lead != "" {
			who = *l.Lead
		}
		leadParts = append(leadParts, fmt.Sprintf("#%d (%s)", l.Number, who))
	}
	return cards, strings.Join(parts, ", "), strings.Join(leadParts, ", "), nil
}

// parseAgents validates a protocol-19 session_snapshot envelope and returns
// only the agents belonging to repoRoot.
//
// Two rejections that look like pedantry and are not:
//
//   - A missing `id` or a `result.type` other than session_snapshot means we
//     are not looking at the reply we asked for. Reading the body anyway would
//     be trusting field names over provenance.
//   - A snapshot whose `agents` key is absent decodes to a nil slice, which is
//     indistinguishable from an empty herd. The cockpit renders that as "no
//     sessions running" — a confident lie about a response we failed to parse.
//     So absence is an error and the caller degrades to herdrOK: false, which
//     the TUI already shows honestly.
//
// Scoping mirrors scripts/scope.sh: server-recorded worktree provenance is
// authoritative, a pane/agent cwd is the fallback and is consulted ONLY when
// the workspace carries no provenance at all. A workspace whose provenance
// points elsewhere is a definite no.
// minProtocol mirrors RALPH_HERDR_MIN_PROTOCOL's default in transport.sh.
const minProtocol = 19

func parseAgents(out, repoRoot string) ([]Agent, error) {
	var payload struct {
		ID     string `json:"id"`
		Result struct {
			Type     string `json:"type"`
			Snapshot struct {
				// No `version` field: nothing here consumes it, and typing it
				// bound the whole parse to the server's choice of scalar —
				// herdr 0.8.0 switched it to a string and silently killed the
				// overlay (GH-1829). `protocol` is the only version gate.
				Protocol   *int `json:"protocol"`
				Workspaces *[]struct {
					ID       string `json:"workspace_id"`
					Worktree *struct {
						RepoRoot     string `json:"repo_root"`
						CheckoutPath string `json:"checkout_path"`
					} `json:"worktree"`
				} `json:"workspaces"`
				Panes *[]struct {
					ID  string `json:"pane_id"`
					Cwd string `json:"cwd"`
				} `json:"panes"`
				Agents *[]struct {
					Name          string `json:"name"`
					Status        string `json:"agent_status"`
					Pane          string `json:"pane_id"`
					Workspace     string `json:"workspace_id"`
					Cwd           string `json:"cwd"`
					ForegroundCwd string `json:"foreground_cwd"`
					// The ralph C8 tokens the spawner stamps and the session
					// refreshes (`herdr pane report-metadata --token …`).
					// They arrive in THIS response — the status dot's second
					// half, the branch, and the ledger join key cost no extra
					// call.
					//
					// Typed `any`, not `string`: encoding/json reports a type
					// error for the WHOLE document if any one value is a
					// number, and the caller treats that as an unparseable
					// snapshot and drops the overlay. Losing a card marking
					// because a token changed shape is chrome; losing the
					// overlay is not.
					Tokens map[string]any `json:"tokens"`
				} `json:"agents"`
			} `json:"snapshot"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		return nil, fmt.Errorf("api snapshot: %w", err)
	}
	if payload.ID == "" {
		return nil, fmt.Errorf("api snapshot: response carries no correlation id")
	}
	if payload.Result.Type != "session_snapshot" {
		return nil, fmt.Errorf("api snapshot: result type %q, want session_snapshot", payload.Result.Type)
	}
	// All three arrays, matching ralph_herdr_snapshot in transport.sh. A
	// snapshot missing `workspaces` is the nastiest of the three: every agent
	// would fall through to the weakest cwd tier, so a foreign agent whose cwd
	// happens to equal our root gets adopted — containment lost precisely when
	// the response was too broken to trust.
	if payload.Result.Snapshot.Agents == nil {
		return nil, fmt.Errorf("api snapshot: snapshot carries no agents array")
	}
	if payload.Result.Snapshot.Workspaces == nil {
		return nil, fmt.Errorf("api snapshot: snapshot carries no workspaces array")
	}
	if payload.Result.Snapshot.Panes == nil {
		return nil, fmt.Errorf("api snapshot: snapshot carries no panes array")
	}
	// The protocol floor, matching ralph_herdr_snapshot. Without it a pre-19
	// server passes: its workspaces carry no `worktree` object, so every agent
	// falls through to the cwd tier and a foreign agent whose cwd equals our
	// root is adopted — containment lost exactly where the checks above claim
	// to preserve it.
	if payload.Result.Snapshot.Protocol == nil {
		return nil, fmt.Errorf("api snapshot: snapshot reports no protocol version")
	}
	if *payload.Result.Snapshot.Protocol < minProtocol {
		return nil, fmt.Errorf("api snapshot: server speaks protocol %d, need %d or newer",
			*payload.Result.Snapshot.Protocol, minProtocol)
	}

	roots := repoRootSpellings(repoRoot)
	// A root itself, or anything beneath it on a path-separator boundary — a
	// worker that cd'd into a subdirectory is still ours, while /repo-other is
	// never /repo. Mirrors the `mine` predicate in scripts/scope.sh.
	mine := func(p string) bool {
		if p == "" {
			return false
		}
		p = strings.TrimRight(p, "/")
		for r := range roots {
			if p == r || strings.HasPrefix(p, r+"/") {
				return true
			}
		}
		return false
	}

	type wsInfo struct {
		hasWorktree bool
		inScope     bool
	}
	workspaces := make(map[string]wsInfo, len(*payload.Result.Snapshot.Workspaces))
	for _, w := range *payload.Result.Snapshot.Workspaces {
		info := wsInfo{hasWorktree: w.Worktree != nil}
		if w.Worktree != nil {
			info.inScope = mine(w.Worktree.RepoRoot) || mine(w.Worktree.CheckoutPath)
		}
		workspaces[w.ID] = info
	}
	paneCwd := make(map[string]string, len(*payload.Result.Snapshot.Panes))
	for _, p := range *payload.Result.Snapshot.Panes {
		paneCwd[p.ID] = p.Cwd
	}

	var agents []Agent
	for _, a := range *payload.Result.Snapshot.Agents {
		ws := workspaces[a.Workspace]
		var inScope bool
		if ws.hasWorktree {
			inScope = ws.inScope
		} else {
			inScope = mine(paneCwd[a.Pane]) || mine(a.Cwd) || mine(a.ForegroundCwd)
		}
		if !inScope {
			continue // another repository's agent — never decorates our cards
		}
		lane, issue, ok := parseAgentName(a.Name)
		if !ok {
			continue // foreign agent — never decorates a card
		}
		status := a.Status
		if status == "" {
			status = "unknown"
		}
		agents = append(agents, Agent{
			Name:       a.Name,
			Status:     status,
			Pane:       a.Pane,
			Issue:      issue,
			Lane:       lane,
			Root:       tokenString(a.Tokens, "root"),
			Parent:     tokenString(a.Tokens, "parent"),
			Depth:      tokenString(a.Tokens, "depth"),
			Branch:     tokenString(a.Tokens, "branch"),
			TokenState: tokenString(a.Tokens, "state"),
			Address:    tokenString(a.Tokens, "address"),
		})
	}
	return agents, nil
}

// tokenString reads one C8 token. A missing key, a null, or a non-string value
// is "" — absence, which every consumer already handles as "this marking has
// no data" rather than inventing one.
func tokenString(tokens map[string]any, key string) string {
	if tokens == nil {
		return ""
	}
	s, _ := tokens[key].(string)
	return s
}

// repoRootSpellings returns the set of paths that all name repoRoot.
//
// herdr reports paths as the process that opened them saw them; git and the
// filesystem resolve symlinks. On macOS that difference is routine rather than
// exotic — /tmp and $TMPDIR both sit under /private — and comparing one
// spelling against the other scopes out every agent silently.
func repoRootSpellings(root string) map[string]struct{} {
	out := make(map[string]struct{}, 3)
	add := func(p string) {
		if p != "" {
			out[strings.TrimRight(p, "/")] = struct{}{}
		}
	}
	add(root)
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		add(resolved)
	}
	if abs, err := filepath.Abs(root); err == nil {
		add(abs)
	}
	return out
}

// firstCommentLine extracts the Human Needed contract line from
// `gh issue view N --json comments`: first line of the LATEST comment.
func firstCommentLine(out string) string {
	var payload struct {
		Comments []struct {
			Body string `json:"body"`
		} `json:"comments"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil || len(payload.Comments) == 0 {
		return ""
	}
	body := payload.Comments[len(payload.Comments)-1].Body
	line := strings.SplitN(strings.ReplaceAll(body, "\r\n", "\n"), "\n", 2)[0]
	return strings.TrimSpace(line)
}

type frontierJSON struct {
	Frontier []struct {
		Number          int    `json:"number"`
		Title           string `json:"title"`
		ParentNumber    *int   `json:"parentNumber"`
		Via             *int   `json:"via"`
		ChildrenBlocked []int  `json:"childrenBlocked"`
		Blockers        []struct {
			Number int    `json:"number"`
			State  string `json:"state"`
		} `json:"blockers"`
	} `json:"frontier"`
	Blocked []struct {
		Number       int   `json:"number"`
		BlockersOpen []int `json:"blockers_open"`
		Truncated    bool  `json:"truncated"`
	} `json:"blocked"`
}

// renderFrontier turns `board frontier --json` into the DAG text tree:
// eligible items (with their satisfied edges) then blocked items with the
// blockers keeping them out.
func renderFrontier(out string) (string, error) {
	var f frontierJSON
	if err := json.Unmarshal([]byte(out), &f); err != nil {
		return "", fmt.Errorf("frontier --json: %w", err)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "FRONTIER — %d eligible, %d blocked\n\n", len(f.Frontier), len(f.Blocked))
	if len(f.Frontier) == 0 {
		b.WriteString("  (nothing eligible)\n")
	}
	for _, it := range f.Frontier {
		fmt.Fprintf(&b, "  ▸ #%d %s", it.Number, it.Title)
		if it.Via != nil {
			fmt.Fprintf(&b, "  (via epic #%d)", *it.Via)
		} else if it.ParentNumber != nil {
			fmt.Fprintf(&b, "  (parent #%d)", *it.ParentNumber)
		}
		b.WriteString("\n")
		for _, bl := range it.Blockers {
			glyph := "✓"
			if bl.State == "OPEN" {
				glyph = "○"
			}
			fmt.Fprintf(&b, "      %s #%d %s\n", glyph, bl.Number, strings.ToLower(bl.State))
		}
		if len(it.ChildrenBlocked) > 0 {
			fmt.Fprintf(&b, "      children blocked: %s\n", numList(it.ChildrenBlocked))
		}
	}
	if len(f.Blocked) > 0 {
		b.WriteString("\nBLOCKED\n")
		sort.Slice(f.Blocked, func(i, j int) bool { return f.Blocked[i].Number < f.Blocked[j].Number })
		for _, it := range f.Blocked {
			fmt.Fprintf(&b, "  ⊘ #%d ← waiting on %s", it.Number, numList(it.BlockersOpen))
			if it.Truncated {
				b.WriteString("  (truncated read — fail-closed)")
			}
			b.WriteString("\n")
		}
	}
	return b.String(), nil
}

func numList(ns []int) string {
	if len(ns) == 0 {
		return "(none listed)"
	}
	parts := make([]string, len(ns))
	for i, n := range ns {
		parts[i] = "#" + strconv.Itoa(n)
	}
	return strings.Join(parts, " ")
}

// ── timeouts ────────────────────────────────────────────────────────────────

const (
	boardTimeout = 25 * time.Second // tsx cold start + GitHub round trips
	herdrTimeout = 8 * time.Second
	ghTimeout    = 12 * time.Second
	gitTimeout   = 5 * time.Second // local; measured ~93 ms per worktree read
	promptWaitMS = "15000"         // ralph-answer.sh nudge parity
)

// boardDeadline: a read deadline tighter than the poll cadence it guards is a
// defect generator — a 60s interval must not kill its own 25s read. Floor at
// boardTimeout so a fast cadence still gets the cold-start budget.
func boardDeadline(cfg Config) time.Duration {
	if cfg.Interval > boardTimeout {
		return cfg.Interval
	}
	return boardTimeout
}

// ── read-failure classification ─────────────────────────────────────────────
//
// Three materially different failures used to render as one word: a fired
// deadline, an exhausted GraphQL budget, and a genuine board/auth break. The
// header now names the cause. Advisory only — nothing here suppresses,
// softens, or retries a failed read; the column still reports as failed.

type rateLimitState struct {
	known     bool
	limit     int
	remaining int
	reset     time.Time
}

// rateProbe consults `gh api rate_limit` at most once per read pass.
type rateProbe struct {
	cfg  Config
	r    Runner
	done bool
	st   rateLimitState
}

func (p *rateProbe) get() rateLimitState {
	if p.done || p.cfg.Gh == "" {
		return p.st
	}
	p.done = true
	ctx, cancel := context.WithTimeout(context.Background(), ghTimeout)
	out, _, err := p.r.Run(ctx, p.cfg.Gh, argsRateLimit()...)
	cancel()
	if err != nil {
		return p.st
	}
	p.st = parseRateLimit(out)
	return p.st
}

func parseRateLimit(out string) rateLimitState {
	var payload struct {
		Resources struct {
			GraphQL struct {
				Limit     int   `json:"limit"`
				Remaining int   `json:"remaining"`
				Reset     int64 `json:"reset"`
			} `json:"graphql"`
		} `json:"resources"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		return rateLimitState{}
	}
	g := payload.Resources.GraphQL
	if g.Limit == 0 && g.Reset == 0 {
		return rateLimitState{}
	}
	// A missing `reset` stays the ZERO time, not the Unix epoch:
	// describeRateLimit reads IsZero() as "no reset known" and omits the
	// clause, but time.Unix(0,0) is a real instant and would render a
	// confident, wrong "resets 01:00 (in 0m)".
	st := rateLimitState{known: true, limit: g.Limit, remaining: g.Remaining}
	if g.Reset != 0 {
		st.reset = time.Unix(g.Reset, 0)
	}
	return st
}

// describeRateLimit renders the operator's two questions: how much budget is
// left, and when it comes back.
func describeRateLimit(st rateLimitState, now time.Time) string {
	if !st.known {
		return ""
	}
	msg := fmt.Sprintf("GitHub GraphQL budget exhausted (%d/%d)", st.remaining, st.limit)
	if st.remaining > 0 {
		msg = fmt.Sprintf("GitHub GraphQL budget low (%d/%d)", st.remaining, st.limit)
	}
	if st.reset.IsZero() {
		return msg
	}
	mins := int(st.reset.Sub(now).Round(time.Minute) / time.Minute)
	if mins < 0 {
		mins = 0
	}
	return fmt.Sprintf("%s — resets %s (in %dm)", msg, st.reset.Local().Format("15:04"), mins)
}

// rateLimitMarkers: what GitHub says when the budget is the reason. board.ts
// often masks these behind "gh api graphql failed (exit N)", which is exactly
// why an unmatched failure still gets a probe.
var rateLimitMarkers = []string{
	"rate limit",
	"rate_limit",
	"ratelimit",
	"submitted too quickly",
	"api rate limit exceeded",
}

func looksRateLimited(s string) bool {
	l := strings.ToLower(s)
	for _, m := range rateLimitMarkers {
		if strings.Contains(l, m) {
			return true
		}
	}
	return false
}

// scrubSignal keeps kernel detail no operator can act on out of the header.
func scrubSignal(s string) string {
	if strings.Contains(s, "signal: killed") {
		return "read killed before completing (deadline or external signal)"
	}
	return s
}

// cardSignalsSince is the ralph release that shipped `board card-signals`
// (7cd8b1b3). A resolved board CLI older than this refuses the subcommand,
// and without naming the skew the chips render the same UNREAD a rate limit
// produces — the cause is undiagnosable from the screen (GH-2073).
const cardSignalsSince = "0.1.168"

// explainStaleBoardCLI names version skew when the board CLI itself refused
// the card-signals subcommand. Matched on board.ts's own usage refusal
// (`unknown command "card-signals"`), never predicted from a version read —
// the refusal IS the evidence, where a version compare would guess. Anything
// else returns "" and the caller falls through to explainReadFailure, so a
// transient failure keeps its ordinary naming (fail-safe: an unmatched skew
// still shows the verbatim refusal, just without the diagnosis).
func explainStaleBoardCLI(boardPath, combined string) string {
	if !strings.Contains(combined, `unknown command "card-signals"`) {
		return ""
	}
	where := boardPath
	if v := pluginPathVersion(boardPath); v != "" {
		where = fmt.Sprintf("%s (ralph %s)", boardPath, v)
	}
	return fmt.Sprintf(
		"board CLI predates card-signals (ships in ralph %s): %s — update the installed plugin (`/plugin`) or point RALPH_HERDR_BOARD at a newer copy",
		cardSignalsSince, where)
}

// pluginPathVersion extracts the version component from a plugin-cache board
// path (…/ralph/<version>/scripts/board) — the same component
// installedBoardCLI ranks by. "" when the path has no such shape (a vendored
// checkout, an explicit override): a guessed version is worse than none.
func pluginPathVersion(p string) string {
	parts := strings.Split(filepath.ToSlash(p), "/")
	if len(parts) < 4 || parts[len(parts)-1] != "board" || parts[len(parts)-2] != "scripts" || parts[len(parts)-4] != "ralph" {
		return ""
	}
	v := parts[len(parts)-3]
	for _, part := range strings.Split(v, ".") {
		if part == "" {
			return ""
		}
		for _, r := range part {
			if r < '0' || r > '9' {
				return ""
			}
		}
	}
	return v
}

// explainReadFailure is the single naming path for a failed board exec.
// timedOut = the cockpit's own deadline fired (ctx.Err() said so).
func explainReadFailure(p *rateProbe, deadline time.Duration, timedOut bool, combined string, err error) string {
	if timedOut {
		return fmt.Sprintf("timed out after %s (cockpit board-read deadline)", deadline)
	}
	verbatim := scrubSignal(firstLine(combined, err))
	if p == nil {
		return verbatim
	}
	st := p.get()
	if looksRateLimited(combined) {
		if d := describeRateLimit(st, time.Now()); d != "" {
			return d
		}
		return verbatim
	}
	// Unmatched failure: the budget is the most common masked cause, so an
	// exhausted budget renames it. A healthy budget leaves it verbatim.
	if st.known && st.remaining == 0 {
		return describeRateLimit(st, time.Now())
	}
	return verbatim
}

// ── tea.Cmds ────────────────────────────────────────────────────────────────

// fetchBoardCmd reads all three columns in ONE board process (GH-1786 — three
// --state reads were three full board walks sharing no cache), then the Human
// Needed question lines (bounded). A failed read reports as an error, never as
// empty: one read covers all three columns, so its failure marks all three
// UNKNOWN — update.go's per-column merge then keeps each column's last good
// cards rather than rendering a falsely calm board.
func fetchBoardCmd(cfg Config, r Runner) tea.Cmd {
	return func() tea.Msg {
		var msg boardMsg
		// One read for all three columns (GH-1786), and when it fails, say WHY
		// (GH-1787): a bare "exit status 1" hides the budget exhaustion that is
		// the most common cause. The single read means one explained failure
		// covers all three columns rather than three identical lines.
		deadline := boardDeadline(cfg)
		probe := &rateProbe{cfg: cfg, r: r}
		ctx, cancel := context.WithTimeout(context.Background(), deadline)
		out, stderr, err := r.Run(ctx, cfg.Board, argsBoardList()...)
		timedOut := ctx.Err() == context.DeadlineExceeded
		cancel()
		if err != nil {
			return boardMsg{
				failed: allColumnsUnknown,
				err:    explainReadFailure(probe, deadline, timedOut, stderr+out, err),
			}
		}
		cols, perr := parseBoardColumns(out)
		if perr != nil {
			return boardMsg{failed: allColumnsUnknown, err: perr.Error()}
		}
		msg.cols = cols
		// Human Needed contract line — one bounded gh read per card. Chrome:
		// a failed read leaves the question empty, never blocks the column.
		if cfg.Gh != "" {
			hn := msg.cols[2]
			for i := range hn {
				if i >= 12 {
					break // phone-glance budget; deeper queues page via `a`
				}
				ctx, cancel := context.WithTimeout(context.Background(), ghTimeout)
				out, _, err := r.Run(ctx, cfg.Gh, argsGhComments(hn[i].Number, hn[i].Repo)...)
				cancel()
				if err == nil {
					hn[i].Question = firstCommentLine(out)
				}
			}
		}
		return msg
	}
}

// fetchSignalsCmd reads the board-sourced card markings (GH-2062). Every
// failure lands as ok:false — a read we could not make must not render like a
// board with nothing to mark, which is the same rule the board columns and the
// worktree diff already follow.
func fetchSignalsCmd(cfg Config, r Runner) tea.Cmd {
	return func() tea.Msg {
		deadline := boardDeadline(cfg)
		probe := &rateProbe{cfg: cfg, r: r}
		ctx, cancel := context.WithTimeout(context.Background(), deadline)
		out, stderr, err := r.Run(ctx, cfg.Board, argsCardSignals()...)
		timedOut := ctx.Err() == context.DeadlineExceeded
		cancel()
		if err != nil {
			if skew := explainStaleBoardCLI(cfg.Board, stderr+out); skew != "" {
				return signalsMsg{err: skew}
			}
			return signalsMsg{err: explainReadFailure(probe, deadline, timedOut, stderr+out, err)}
		}
		prs, epics, perr := parseCardSignals(out)
		if perr != nil {
			return signalsMsg{err: perr.Error()}
		}
		return signalsMsg{prs: prs, epics: epics, ok: true}
	}
}

// fetchDoneCmd reads the closed-issue window. Dispatched only while the Done
// column is on screen — it is the most expensive of this unit's three reads and
// the one nobody is looking at by default.
func fetchDoneCmd(cfg Config, r Runner) tea.Cmd {
	return func() tea.Msg {
		deadline := boardDeadline(cfg)
		probe := &rateProbe{cfg: cfg, r: r}
		ctx, cancel := context.WithTimeout(context.Background(), deadline)
		out, stderr, err := r.Run(ctx, cfg.Board, argsBoardClosed()...)
		timedOut := ctx.Err() == context.DeadlineExceeded
		cancel()
		if err != nil {
			return doneMsg{err: explainReadFailure(probe, deadline, timedOut, stderr+out, err)}
		}
		cards, days, perr := parseClosed(out)
		if perr != nil {
			return doneMsg{err: perr.Error()}
		}
		return doneMsg{cards: cards, windowDays: days, ok: true}
	}
}

// fetchInboxCmd reads `board inbox` Tier 1. Dispatched only while the Inbox
// view is on screen — it is a four-queue walk (the priciest read this unit
// dispatches) and behind a key nobody may ever press.
func fetchInboxCmd(cfg Config, r Runner) tea.Cmd {
	return func() tea.Msg {
		deadline := boardDeadline(cfg)
		probe := &rateProbe{cfg: cfg, r: r}
		ctx, cancel := context.WithTimeout(context.Background(), deadline)
		out, stderr, err := r.Run(ctx, cfg.Board, argsBoardInbox()...)
		timedOut := ctx.Err() == context.DeadlineExceeded
		cancel()
		if err != nil {
			return inboxMsg{err: explainReadFailure(probe, deadline, timedOut, stderr+out, err)}
		}
		cards, withheld, leads, perr := parseInbox(out)
		if perr != nil {
			return inboxMsg{err: perr.Error()}
		}
		return inboxMsg{cards: cards, withheld: withheld, leads: leads, ok: true}
	}
}

// fetchAgentsCmd refreshes the decoration overlay. herdr absent or refusing
// = overlay off — the banner names the degradation; columns are untouched.
func fetchAgentsCmd(cfg Config, r Runner) tea.Cmd {
	return func() tea.Msg {
		if cfg.Herdr == "" {
			return agentsMsg{herdrOK: false}
		}
		ctx, cancel := context.WithTimeout(context.Background(), herdrTimeout)
		out, _, err := r.Run(ctx, cfg.Herdr, argsApiSnapshot()...)
		cancel()
		if err != nil {
			return agentsMsg{herdrOK: false}
		}
		agents, perr := parseAgents(out, cfg.Repo)
		if perr != nil {
			return agentsMsg{herdrOK: false}
		}
		// One local file read on the same tick — no network, no herdr call.
		// It carries the spawn clock the age chip needs and the branch for a
		// unit whose session has already exited.
		return agentsMsg{agents: agents, herdrOK: true, ledger: readLedger(cfg.LedgerPath)}
	}
}

// fetchDiffsCmd measures each target worktree with two local git processes.
// Bounded by the caller (Model.diffTargets) and by a deadline here: a git
// process wedged on a network filesystem must cost one marking, not the tick.
func fetchDiffsCmd(r Runner, targets []LedgerSpawn) tea.Cmd {
	return func() tea.Msg {
		out := make(map[string]DiffStat, len(targets))
		for _, sp := range targets {
			ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
			out[sp.Ref] = worktreeDiff(ctx, r, sp.Checkout)
			cancel()
		}
		return diffsMsg{diffs: out}
	}
}

func peekCmd(cfg Config, r Runner, who string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), herdrTimeout)
		out, stderr, err := r.Run(ctx, cfg.Herdr, argsAgentRead(who)...)
		cancel()
		if err != nil {
			return peekMsg{who: who, err: firstLine(stderr, err)}
		}
		return peekMsg{who: who, text: out}
	}
}

func focusCmd(cfg Config, r Runner, who string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), herdrTimeout)
		_, stderr, err := r.Run(ctx, cfg.Herdr, argsAgentFocus(who)...)
		cancel()
		if err != nil {
			return refused("focus %s failed: %s", who, firstLine(stderr, err))
		}
		return landed("observing %s (herdr focus)", who)
	}
}

// doReply delivers one prompt. The delivered checkmark is EARNED: rc 0 from
// `agent prompt --wait` and nothing else — no optimistic ack, ever.
func doReply(cfg Config, r Runner, who, text string) replyDoneMsg {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, stderr, err := r.Run(ctx, cfg.Herdr, argsAgentPrompt(who, text, promptWaitMS)...)
	if err != nil {
		return replyDoneMsg{who: who, ok: false, detail: firstLine(stderr+out, err)}
	}
	return replyDoneMsg{who: who, ok: true}
}

func replyCmd(cfg Config, r Runner, who, text string) tea.Cmd {
	return func() tea.Msg { return doReply(cfg, r, who, text) }
}

// doAnswer is the comment-first flow, board.ts ordering preserved: the
// DURABLE half (`board answer N -m`) runs FIRST; only on its success does the
// decorative nudge go out to a live agent. Both results surface distinctly.
func doAnswer(cfg Config, r Runner, issue int, text string, agent string) answerDoneMsg {
	msg := answerDoneMsg{issue: issue, agentName: agent}
	ctx, cancel := context.WithTimeout(context.Background(), boardDeadline(cfg))
	out, stderr, err := r.Run(ctx, cfg.Board, argsBoardAnswer(issue, text)...)
	cancel()
	if err != nil {
		msg.boardOK = false
		// board.ts's post-comment refusal marker: the durable half already
		// happened, only the move failed — retrying the ANSWER would
		// duplicate the comment. firstLine alone would drop that guidance.
		msg.boardPosted = strings.Contains(stderr+out, "answer comment IS on the record")
		msg.boardDetail = scrubSignal(firstLine(stderr+out, err))
		return msg // the move (or the whole verb) failed — nothing to nudge about
	}
	msg.boardOK = true
	msg.boardDetail = firstLine(out, nil)
	if agent == "" || cfg.Herdr == "" {
		return msg
	}
	msg.agentTried = true
	nudge := fmt.Sprintf("answered on issue — re-read #%d and resume", issue)
	ctx2, cancel2 := context.WithTimeout(context.Background(), 30*time.Second)
	pout, pstderr, perr := r.Run(ctx2, cfg.Herdr, argsAgentPrompt(agent, nudge, promptWaitMS)...)
	cancel2()
	if perr != nil {
		msg.agentOK = false
		msg.agentDetail = firstLine(pstderr+pout, perr)
		return msg
	}
	msg.agentOK = true
	return msg
}

func answerCmd(cfg Config, r Runner, issue int, text, agent string) tea.Cmd {
	return func() tea.Msg { return doAnswer(cfg, r, issue, text, agent) }
}

func dagCmd(cfg Config, r Runner) tea.Cmd {
	return func() tea.Msg {
		deadline := boardDeadline(cfg)
		ctx, cancel := context.WithTimeout(context.Background(), deadline)
		out, stderr, err := r.Run(ctx, cfg.Board, argsBoardFrontier()...)
		timedOut := ctx.Err() == context.DeadlineExceeded
		cancel()
		if err != nil {
			return dagMsg{err: explainReadFailure(&rateProbe{cfg: cfg, r: r}, deadline, timedOut, stderr+out, err)}
		}
		text, perr := renderFrontier(out)
		if perr != nil {
			return dagMsg{err: perr.Error()}
		}
		return dagMsg{text: text}
	}
}

// parseRoster reads `board roster --json` (the bare RosterView object). The
// boardClaims literal is the shape check: it is pinned to "not-read" by the
// schema (D7.3), so its absence means this is not a roster payload — a
// malformed read must not render as an empty herd.
func parseRoster(out string) (rows []TopoRow, repo, withheld, agentsNote string, err error) {
	type lease struct {
		Stale bool `json:"stale"`
	}
	type row struct {
		Name        *string `json:"name"`
		Address     *string `json:"address"`
		Repo        *string `json:"repo"`
		Team        *string `json:"team"`
		Lane        *string `json:"lane"`
		Issue       *int    `json:"issue"`
		Role        *string `json:"role"`
		State       *string `json:"state"`
		Depth       *string `json:"depth"`
		Parent      *string `json:"parent"`
		AgentStatus *string `json:"agentStatus"`
		Pane        *string `json:"pane"`
		Dispatch    bool    `json:"dispatch"`
		Note        *string `json:"note"`
		Lease       *lease  `json:"lease"`
	}
	var payload struct {
		Repo            string  `json:"repo"`
		BoardClaims     string  `json:"boardClaims"`
		AgentsEvaluated bool    `json:"agentsEvaluated"`
		AgentsReason    *string `json:"agentsReason"`
		Rows            []row   `json:"rows"`
		Withheld        struct {
			ForeignAgents      int `json:"foreignAgents"`
			UnattributedAgents int `json:"unattributedAgents"`
			ForeignLeases      int `json:"foreignLeases"`
			DeadLeases         int `json:"deadLeases"`
		} `json:"withheld"`
	}
	if uerr := json.Unmarshal([]byte(out), &payload); uerr != nil {
		return nil, "", "", "", fmt.Errorf("roster --json: %w", uerr)
	}
	if payload.BoardClaims != "not-read" {
		return nil, "", "", "", fmt.Errorf("roster --json: payload is not a roster (boardClaims != \"not-read\") — a malformed read is not an empty herd")
	}
	deref := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	for _, r := range payload.Rows {
		issue := 0
		if r.Issue != nil {
			issue = *r.Issue
		}
		t := TopoRow{
			Name: deref(r.Name), Address: deref(r.Address), Repo: deref(r.Repo),
			Team: deref(r.Team), Lane: deref(r.Lane), Issue: issue,
			Role: deref(r.Role), TokenState: deref(r.State), Status: deref(r.AgentStatus),
			Depth: deref(r.Depth), Parent: deref(r.Parent), Pane: deref(r.Pane),
			Dispatch: r.Dispatch, Note: deref(r.Note),
		}
		if r.Lease != nil {
			t.HasLease = true
			t.LeaseStale = r.Lease.Stale
		}
		rows = append(rows, t)
	}
	var held []string
	for _, w := range []struct {
		n    int
		what string
	}{
		{payload.Withheld.ForeignAgents, "foreign"},
		{payload.Withheld.UnattributedAgents, "unattributed"},
		{payload.Withheld.ForeignLeases, "foreign lease"},
		{payload.Withheld.DeadLeases, "dead lease"},
	} {
		if w.n > 0 {
			held = append(held, fmt.Sprintf("%d %s", w.n, w.what))
		}
	}
	if !payload.AgentsEvaluated {
		agentsNote = deref(payload.AgentsReason)
		if agentsNote == "" {
			agentsNote = "herd agents not evaluated"
		}
	}
	return rows, payload.Repo, strings.Join(held, ", "), agentsNote, nil
}

// parseEscalations reads `board escalations --json` ({escalations: [...]}) .
// A nil array is a malformed payload, not an empty queue — same guard as
// parseInbox; `[]` unmarshals non-nil, so genuinely-empty still passes.
func parseEscalations(out string) ([]TopoEsc, error) {
	var payload struct {
		Escalations []struct {
			Number      int     `json:"number"`
			Route       string  `json:"route"`
			Lead        *string `json:"lead"`
			Disposition *string `json:"disposition"`
			Answered    *struct {
				At *string `json:"at"`
			} `json:"answered"`
		} `json:"escalations"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		return nil, fmt.Errorf("escalations --json: %w", err)
	}
	if payload.Escalations == nil {
		return nil, fmt.Errorf("escalations --json: payload carries no escalations array — a malformed read is not an empty queue")
	}
	escs := make([]TopoEsc, 0, len(payload.Escalations))
	for _, e := range payload.Escalations {
		t := TopoEsc{Number: e.Number, Route: e.Route, Answered: e.Answered != nil}
		if e.Lead != nil {
			t.Lead = *e.Lead
		}
		if e.Disposition != nil {
			t.Disposition = *e.Disposition
		}
		escs = append(escs, t)
	}
	return escs, nil
}

// topologyCmd takes the GH-2219 snapshot: roster first (required — no roster,
// no tree), then escalations (best-effort — that half is a GitHub walk over
// the Human Needed subset, and a rate limit there may not take down a view
// whose tree is a local read). Both on one keypress, refreshed only by the
// next press — the DAG's snapshot contract.
func topologyCmd(cfg Config, r Runner) tea.Cmd {
	return func() tea.Msg {
		deadline := boardDeadline(cfg)
		probe := &rateProbe{cfg: cfg, r: r}
		ctx, cancel := context.WithTimeout(context.Background(), deadline)
		out, stderr, err := r.Run(ctx, cfg.Board, argsBoardRoster()...)
		timedOut := ctx.Err() == context.DeadlineExceeded
		cancel()
		if err != nil {
			return topoMsg{err: explainReadFailure(probe, deadline, timedOut, stderr+out, err)}
		}
		rows, repo, withheld, agentsNote, perr := parseRoster(out)
		if perr != nil {
			return topoMsg{err: perr.Error()}
		}
		msg := topoMsg{rows: rows, repo: repo, withheld: withheld, agentsNote: agentsNote}
		ctx2, cancel2 := context.WithTimeout(context.Background(), deadline)
		eout, estderr, eerr := r.Run(ctx2, cfg.Board, argsBoardEscalations()...)
		etimedOut := ctx2.Err() == context.DeadlineExceeded
		cancel2()
		if eerr != nil {
			msg.escErr = explainReadFailure(probe, deadline, etimedOut, estderr+eout, eerr)
			return msg
		}
		escs, eperr := parseEscalations(eout)
		if eperr != nil {
			msg.escErr = eperr.Error()
			return msg
		}
		msg.escs = escs
		return msg
	}
}

// spawnCmd runs the sanctioned spawn path in the background; stdin is closed
// so hold_pane's read degrades to EOF instead of hanging the Cmd.
func spawnCmd(cfg Config, r Runner, issue int) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		out, stderr, err := r.Run(ctx, "bash", argsSpawn(cfg.ScriptsDir, issue)...)
		rc := 0
		if err != nil {
			rc = exitCode(err)
		}
		detail := lastNonEmptyLine(out)
		if rc != 0 && rc != 2 {
			detail = firstLine(stripFreshnessLines(stderr)+out, err)
		}
		return spawnDoneMsg{issue: issue, rc: rc, detail: detail, notice: freshnessNotice(stderr)}
	}
}

// forkCmd shells to the sanctioned fork path; the session read stays in
// fork.sh, which is why this passes a pane id and nothing else.
func forkCmd(cfg Config, r Runner, issue int, pane string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		out, stderr, err := r.Run(ctx, "bash", argsFork(cfg.ScriptsDir, pane)...)
		rc := 0
		if err != nil {
			rc = exitCode(err)
		}
		detail := lastNonEmptyLine(out)
		if rc != 0 {
			detail = firstLine(stderr+out, err)
		}
		return forkDoneMsg{issue: issue, rc: rc, detail: detail}
	}
}

// prDiffCmd: `board get N --json` for the PR, then a herdr pane running
// `gh pr diff`. Degradation: no herdr → print the exact gh command as the
// hint (chrome lost, verb reachable by hand).
func prDiffCmd(cfg Config, r Runner, issue int) tea.Cmd {
	return func() tea.Msg {
		deadline := boardDeadline(cfg)
		ctx, cancel := context.WithTimeout(context.Background(), deadline)
		out, stderr, err := r.Run(ctx, cfg.Board, argsBoardGet(issue)...)
		timedOut := ctx.Err() == context.DeadlineExceeded
		cancel()
		if err != nil {
			return refused("board get %d failed: %s", issue,
				explainReadFailure(&rateProbe{cfg: cfg, r: r}, deadline, timedOut, stderr+out, err))
		}
		pr, ok := pickPR(out)
		if !ok {
			return statusMsg{kind: statusNudge, text: fmt.Sprintf("#%d has no PR yet", issue)}
		}
		if cfg.Herdr == "" {
			return refused("no multiplexer — by hand: gh pr diff %d", pr)
		}
		ctx2, cancel2 := context.WithTimeout(context.Background(), herdrTimeout)
		sout, sstderr, serr := r.Run(ctx2, cfg.Herdr, argsPaneSplit()...)
		cancel2()
		if serr != nil {
			return refused("pane split failed (%s) — by hand: gh pr diff %d", firstLine(sstderr, serr), pr)
		}
		paneID := panePaneID(sout)
		if paneID == "" {
			return refused("pane split gave no pane id — by hand: gh pr diff %d", pr)
		}
		ctx3, cancel3 := context.WithTimeout(context.Background(), herdrTimeout)
		_, rstderr, rerr := r.Run(ctx3, cfg.Herdr, argsPaneRun(paneID, pr)...)
		cancel3()
		if rerr != nil {
			return refused("pane run failed (%s) — by hand: gh pr diff %d", firstLine(rstderr, rerr), pr)
		}
		return landed("PR #%d diff open in pane %s", pr, paneID)
	}
}

// openBrowserCmd opens the issue on GitHub — works on every rung.
func openBrowserCmd(card Card) tea.Cmd {
	return func() tea.Msg {
		url := fmt.Sprintf("https://github.com/%s/issues/%d", card.Repo, card.Number)
		opener := "open" // darwin
		if runtime.GOOS != "darwin" {
			opener = "xdg-open"
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := exec.CommandContext(ctx, opener, url).Run(); err != nil {
			return refused("browser open failed — %s", url)
		}
		return landed("opened %s", url)
	}
}

// ── small helpers ───────────────────────────────────────────────────────────

// pickPR chooses the diff target from `board get --json` prs: the first
// unmerged open PR, else the last PR listed.
func pickPR(out string) (int, bool) {
	var payload struct {
		PRs []struct {
			Number int    `json:"number"`
			State  string `json:"state"`
			Merged bool   `json:"merged"`
		} `json:"prs"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil || len(payload.PRs) == 0 {
		return 0, false
	}
	for _, p := range payload.PRs {
		if !p.Merged && strings.EqualFold(p.State, "OPEN") {
			return p.Number, true
		}
	}
	return payload.PRs[len(payload.PRs)-1].Number, true
}

func panePaneID(out string) string {
	var payload struct {
		Result struct {
			Pane struct {
				PaneID string `json:"pane_id"`
			} `json:"pane"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		return ""
	}
	return payload.Result.Pane.PaneID
}

func exitCode(err error) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return 1
}

func firstLine(s string, err error) string {
	s = strings.TrimSpace(s)
	if s == "" {
		if err != nil {
			return err.Error()
		}
		return ""
	}
	return strings.SplitN(s, "\n", 2)[0]
}

func lastNonEmptyLine(s string) string {
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if t := strings.TrimSpace(lines[i]); t != "" {
			return t
		}
	}
	return ""
}
