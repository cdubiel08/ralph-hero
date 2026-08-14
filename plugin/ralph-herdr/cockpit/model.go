// model.go — cockpit state: the board columns, the agent overlay, the cursor,
// and the mode machine. Board state is AUTHORITATIVE: a card's column derives
// only from the item's own Workflow State in ONE `board list --json` read
// (GH-1786 — three --state reads were three full board walks); herdr agent
// state (the live/blocked
// glyphs) is a decoration overlay joined by parsing agent names (grammar-B
// w<N>-*, legacy gh-N) — losing the overlay loses chrome, never a column.
package main

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Mode is the cockpit's interaction mode. Browse is home; every other mode
// is one keypress deep and Esc returns to browse.
type Mode int

const (
	ModeBrowse Mode = iota
	ModePeek        // agent read tail overlay — no focus steal
	ModeReply       // input line → herdr agent prompt (delivered on rc 0 only)
	ModeAnswer      // input line → board answer FIRST, then best-effort nudge
	ModeDag         // text tree from board frontier --json
)

// columnStates — the three cockpit columns, board Workflow State names
// VERBATIM (the decision-microworld lock). Order is the render order.
var columnStates = [3]string{"In Progress", "In Review", "Human Needed"}

// Card is one board item in a column. Everything here comes from the board
// CLI — never from herdr.
type Card struct {
	Number       int
	Repo         string // nameWithOwner — feeds the browser URL for `g`
	Title        string
	State        string // board state verbatim (== its column)
	Priority     string
	Estimate     string
	ParentNumber int // 0 = no own-repo parent
	// Question is the Human Needed contract line: the FIRST LINE of the
	// issue's LATEST comment, verbatim — the card must be phone-answerable.
	// Empty on non-HN cards and when the gh read failed.
	Question string
}

// Agent is one live herdr agent, joined to an issue by name. Decoration only.
type Agent struct {
	Name   string
	Status string // working | blocked | idle | done | unknown
	Pane   string
	Issue  int
	Lane   string // grammar-B lane char; "w" for legacy gh-N
}

// Grammar-B agent names (naming.sh / contracts.ts parity) plus the legacy
// gh-N shape kept first-class through the transition.
var (
	agentNameRe  = regexp.MustCompile(`^([wrodsx])([0-9]+)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:--[2-9])?$`)
	legacyNameRe = regexp.MustCompile(`^gh-([0-9]+)$`)
)

// parseAgentName maps a herdr agent name to (lane, issue). ok=false for
// anything that is not ralph-shaped — foreign agents never join the overlay.
func parseAgentName(name string) (lane string, issue int, ok bool) {
	if len(name) > 32 {
		return "", 0, false
	}
	if m := legacyNameRe.FindStringSubmatch(name); m != nil {
		n, err := strconv.Atoi(m[1])
		if err != nil {
			return "", 0, false
		}
		return "w", n, true
	}
	if m := agentNameRe.FindStringSubmatch(name); m != nil {
		n, err := strconv.Atoi(m[2])
		if err != nil {
			return "", 0, false
		}
		return m[1], n, true
	}
	return "", 0, false
}

// Model is the whole cockpit. Update is pure over it (fetch.go owns I/O).
type Model struct {
	cfg    Config
	runner Runner

	// Board truth.
	cols     [3][]Card
	boardErr string // last board read failure — a failed read is not an empty board
	lastPoll time.Time

	// Adaptive board cadence (GH-1805). pollEvery is the CURRENT gap between
	// board walks; it grows by pollBackoff on an unchanged board and snaps back
	// to cfg.Interval (the floor) on evidence of a write. boardSig/agentSig are
	// what "unchanged" is measured against.
	pollEvery time.Duration
	boardSig  string
	agentSig  string

	// Agent overlay (decoration).
	agents  map[int][]Agent // issue → live agents, w-lane first then by name
	herdrOK bool            // false = no multiplexer — overlay off, verbs degrade

	// Cursor + mode.
	col, row int
	mode     Mode

	// Reply/answer input line. On a failed send the typed text is PRESERVED
	// and inputErr shows why — never optimistic, never lossy.
	input    string
	inputErr string
	inputFor int    // issue the input targets
	inputWho string // agent name (reply) — "" for answer
	sending  bool   // a send is in flight; input frozen until the result lands

	// Peek overlay.
	peekWho  string
	peekText string

	// DAG overlay.
	dagText string

	// Chrome.
	status       string
	width        int
	height       int
	pollInFlight bool

	// Mouse: double-click = observe.
	lastClickAt  time.Time
	lastClickCol int
	lastClickRow int
}

// newModel builds the initial model. The overlay starts off until the first
// agent-list read lands; the board starts empty until the first poll.
func newModel(cfg Config, r Runner) Model {
	return Model{
		cfg:       cfg,
		runner:    r,
		agents:    map[int][]Agent{},
		herdrOK:   cfg.Herdr != "",
		width:     80,
		height:    24,
		pollEvery: cfg.Interval,
		// Seeded with the EMPTY board's signature so a board that is genuinely
		// empty reads as unchanged from the first poll and backs off, rather
		// than spending one cycle at the floor to discover nothing is there.
		boardSig: boardSignature([3][]Card{}),
	}
}

// selectedCard is the card under the cursor, if any.
func (m Model) selectedCard() (Card, bool) {
	cards := m.cols[m.col]
	if m.row < 0 || m.row >= len(cards) {
		return Card{}, false
	}
	return cards[m.row], true
}

// agentFor picks the agent to observe/peek/reply for an issue: w-lane first,
// then lexicographic — deterministic under fleets.
func (m Model) agentFor(issue int) (Agent, bool) {
	as := m.agents[issue]
	if len(as) == 0 {
		return Agent{}, false
	}
	return as[0], true
}

// glyphStatus is the card's decoration status: blocked wins (it needs the
// human), then working, then the first agent's status.
func (m Model) glyphStatus(issue int) (string, bool) {
	as := m.agents[issue]
	if len(as) == 0 {
		return "", false
	}
	best := as[0].Status
	for _, a := range as {
		if a.Status == "blocked" {
			return "blocked", true
		}
		if a.Status == "working" {
			best = "working"
		}
	}
	return best, true
}

// setAgents replaces the overlay from a fresh agent-list read.
func setAgents(list []Agent) map[int][]Agent {
	byIssue := map[int][]Agent{}
	for _, a := range list {
		byIssue[a.Issue] = append(byIssue[a.Issue], a)
	}
	for n := range byIssue {
		as := byIssue[n]
		sort.Slice(as, func(i, j int) bool {
			if (as[i].Lane == "w") != (as[j].Lane == "w") {
				return as[i].Lane == "w"
			}
			return as[i].Name < as[j].Name
		})
		byIssue[n] = as
	}
	return byIssue
}

// ── adaptive board cadence (GH-1805) ────────────────────────────────────────
//
// The board walk is the expensive read (a full ProjectV2 scan); the agent
// overlay is a local herdr call. So the TICK stays fixed — the overlay must not
// go stale — and only the board walk is gated by a cadence that grows while
// nothing changes.
//
// This is event-COUPLED, not rate-estimated: we can see the writers. A ralph
// session appearing, blocking or finishing shows up in the (free) agent
// overlay BEFORE its board write lands; the cockpit's own answer/spawn verbs
// are writes we perform ourselves; and a keypress means a human is looking.
// Each of those snaps the cadence to the floor. Estimating λ from poll
// outcomes is what a crawler does because it cannot see the writer — the
// deliberately-declined half of #1805.
const pollBackoff = 1.5

// pollDue reports whether the board walk may run at `now`. The in-flight guard
// is the caller's; this is only the cadence half. A zero lastPoll (nothing read
// yet) is always due.
//
// Honest bound: the decision is only ever taken ON a tick, so the gap between
// walks is the cadence rounded UP to the next tick — worst case pollEvery +
// cfg.Interval, not pollEvery. The ceiling bounds the cadence exactly; it
// bounds observed staleness to within one tick of it.
func (m Model) pollDue(now time.Time) bool {
	if m.lastPoll.IsZero() {
		return true
	}
	return !now.Before(m.lastPoll.Add(m.pollEvery))
}

// backoff grows the cadence one step. cfg.MaxInterval is a HARD ceiling — the
// stated staleness bound, clamped here rather than emerging from the curve, so
// no number of unchanged polls can push the board past it.
func (m *Model) backoff() {
	// The ceiling is never below the floor, so an unset MaxInterval means "no
	// backoff" — a constant cadence at the floor. It must not read as a zero
	// ceiling, which would clamp the cadence to nothing and poll every tick:
	// the failure mode this whole mechanism exists to prevent.
	ceiling := m.cfg.MaxInterval
	if ceiling < m.cfg.Interval {
		ceiling = m.cfg.Interval
	}
	next := time.Duration(float64(m.pollEvery) * pollBackoff).Round(time.Second)
	if next <= m.pollEvery {
		next = m.pollEvery + time.Second // never stall on a sub-second floor
	}
	if next > ceiling {
		next = ceiling
	}
	m.pollEvery = next
}

// snapToFloor is the asymmetric half: evidence of a write returns the cadence
// to the floor in ONE step, never gradually. Changes cluster, so one change is
// strong evidence of more (the asymmetry TCP uses, for the same reason).
func (m *Model) snapToFloor() { m.pollEvery = m.cfg.Interval }

// boardSignature is the change oracle for the board columns: the fields a
// change would move a card by. Card.Question is deliberately EXCLUDED — it is
// chrome from a separate, bounded `gh` read that degrades to empty on failure,
// so a flapping gh call would pin the cadence at the floor forever and silently
// undo this whole mechanism.
func boardSignature(cols [3][]Card) string {
	var b strings.Builder
	for i := range cols {
		fmt.Fprintf(&b, "%d:", i)
		for _, c := range cols[i] {
			fmt.Fprintf(&b, "%d|%s|%s|%s|%d|%s;", c.Number, c.State, c.Priority, c.Estimate, c.ParentNumber, c.Title)
		}
	}
	return b.String()
}

// agentSignature is the writer oracle: which sessions are live and what they
// are doing. Sorted, because the overlay is a map.
func agentSignature(byIssue map[int][]Agent) string {
	issues := make([]int, 0, len(byIssue))
	for n := range byIssue {
		issues = append(issues, n)
	}
	sort.Ints(issues)
	var b strings.Builder
	for _, n := range issues {
		fmt.Fprintf(&b, "%d:", n)
		for _, a := range byIssue[n] {
			fmt.Fprintf(&b, "%s=%s,", a.Name, a.Status)
		}
		b.WriteByte(';')
	}
	return b.String()
}

// clampCursor keeps the cursor on a real card after any board refresh or
// column move; an empty column parks the cursor at row 0.
func (m *Model) clampCursor() {
	if m.col < 0 {
		m.col = 0
	}
	if m.col > 2 {
		m.col = 2
	}
	n := len(m.cols[m.col])
	if n == 0 {
		m.row = 0
		return
	}
	if m.row >= n {
		m.row = n - 1
	}
	if m.row < 0 {
		m.row = 0
	}
}
