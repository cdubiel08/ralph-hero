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
	Interval   time.Duration // board poll cadence (default 30s, min 10s)
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
QUEUE_JSON=$("$BOARD" next --json 2>/dev/null) || QUEUE_JSON=""
spawn_work_session "$2" "$QUEUE_JSON" || exit $?
`

func argsSpawn(scriptsDir string, n int) []string {
	return []string{"-c", spawnScript, "ralph-cockpit", scriptsDir, strconv.Itoa(n)}
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

type spawnDoneMsg struct {
	issue  int
	rc     int // 0 spawned, 2 skipped (already owned), else failure
	detail string
}

type statusMsg string

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
func parseBoardColumns(out string) ([3][]Card, error) {
	var cols [3][]Card
	var payload struct {
		Items []listItemJSON `json:"items"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		return cols, fmt.Errorf("list --json: %w", err)
	}
	for _, it := range payload.Items {
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
				Version    *int `json:"version"`
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
		agents = append(agents, Agent{Name: a.Name, Status: status, Pane: a.Pane, Issue: issue, Lane: lane})
	}
	return agents, nil
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
	promptWaitMS = "15000" // ralph-answer.sh nudge parity
)

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
		ctx, cancel := context.WithTimeout(context.Background(), boardTimeout)
		out, stderr, err := r.Run(ctx, cfg.Board, argsBoardList()...)
		cancel()
		if err != nil {
			return boardMsg{failed: allColumnsUnknown, err: firstLine(stderr, err)}
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
		return agentsMsg{agents: agents, herdrOK: true}
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
			return statusMsg(fmt.Sprintf("focus %s failed: %s", who, firstLine(stderr, err)))
		}
		return statusMsg(fmt.Sprintf("observing %s (herdr focus)", who))
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
	ctx, cancel := context.WithTimeout(context.Background(), boardTimeout)
	out, stderr, err := r.Run(ctx, cfg.Board, argsBoardAnswer(issue, text)...)
	cancel()
	if err != nil {
		msg.boardOK = false
		// board.ts's post-comment refusal marker: the durable half already
		// happened, only the move failed — retrying the ANSWER would
		// duplicate the comment. firstLine alone would drop that guidance.
		msg.boardPosted = strings.Contains(stderr+out, "answer comment IS on the record")
		msg.boardDetail = firstLine(stderr+out, err)
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
		ctx, cancel := context.WithTimeout(context.Background(), boardTimeout)
		out, stderr, err := r.Run(ctx, cfg.Board, argsBoardFrontier()...)
		cancel()
		if err != nil {
			return dagMsg{err: firstLine(stderr, err)}
		}
		text, perr := renderFrontier(out)
		if perr != nil {
			return dagMsg{err: perr.Error()}
		}
		return dagMsg{text: text}
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
			detail = firstLine(stderr+out, err)
		}
		return spawnDoneMsg{issue: issue, rc: rc, detail: detail}
	}
}

// prDiffCmd: `board get N --json` for the PR, then a herdr pane running
// `gh pr diff`. Degradation: no herdr → print the exact gh command as the
// hint (chrome lost, verb reachable by hand).
func prDiffCmd(cfg Config, r Runner, issue int) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), boardTimeout)
		out, stderr, err := r.Run(ctx, cfg.Board, argsBoardGet(issue)...)
		cancel()
		if err != nil {
			return statusMsg(fmt.Sprintf("board get %d failed: %s", issue, firstLine(stderr, err)))
		}
		pr, ok := pickPR(out)
		if !ok {
			return statusMsg(fmt.Sprintf("#%d has no PR yet", issue))
		}
		if cfg.Herdr == "" {
			return statusMsg(fmt.Sprintf("no multiplexer — by hand: gh pr diff %d", pr))
		}
		ctx2, cancel2 := context.WithTimeout(context.Background(), herdrTimeout)
		sout, sstderr, serr := r.Run(ctx2, cfg.Herdr, argsPaneSplit()...)
		cancel2()
		if serr != nil {
			return statusMsg(fmt.Sprintf("pane split failed (%s) — by hand: gh pr diff %d", firstLine(sstderr, serr), pr))
		}
		paneID := panePaneID(sout)
		if paneID == "" {
			return statusMsg(fmt.Sprintf("pane split gave no pane id — by hand: gh pr diff %d", pr))
		}
		ctx3, cancel3 := context.WithTimeout(context.Background(), herdrTimeout)
		_, rstderr, rerr := r.Run(ctx3, cfg.Herdr, argsPaneRun(paneID, pr)...)
		cancel3()
		if rerr != nil {
			return statusMsg(fmt.Sprintf("pane run failed (%s) — by hand: gh pr diff %d", firstLine(rstderr, rerr), pr))
		}
		return statusMsg(fmt.Sprintf("PR #%d diff open in pane %s", pr, paneID))
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
			return statusMsg(fmt.Sprintf("browser open failed — %s", url))
		}
		return statusMsg(fmt.Sprintf("opened %s", url))
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
