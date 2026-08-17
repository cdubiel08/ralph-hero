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
	Status string // herdr's own agent_status: working | blocked | idle | done | unknown
	Pane   string
	Issue  int
	Lane   string // grammar-B lane char; "w" for legacy gh-N
	// Root is the agent_ref the spawner recorded (tokens.root, e.g.
	// "w2061-cockpit-card-markings#f9f8678d") — the EXACT key onto the
	// ledger's own agent_ref. Empty for an agent nobody spawned through the
	// sanctioned path.
	Root string
	// Branch is tokens.branch — the checkout this session took. Free: it
	// arrives in the same snapshot the status does.
	Branch string
	// TokenState is the ralph C8 `state` token the session pushes at its own
	// checkpoints (spawned → working → blocked → reporting). It expresses what
	// agent_status structurally cannot; cardState decides when it may speak.
	TokenState string
}

// Card marking states — the vocabulary the status dot renders, ranked so a
// fleet on one issue resolves to the state that most needs a human's eye.
const (
	stateBlocked   = "blocked"
	stateReporting = "reporting"
	stateWorking   = "working"
	stateStarting  = "starting"
	stateIdle      = "idle"
	stateUnknown   = "unknown"
)

var stateRank = map[string]int{
	stateBlocked:   0,
	stateReporting: 1,
	stateWorking:   2,
	stateStarting:  3,
	stateIdle:      4,
	stateUnknown:   5,
}

// joinAgentState merges herdr's live observation with the session's own last
// checkpoint token.
//
// The rule is that the token REFINES and never contradicts. agent_status is
// herdr watching the process right now; the token is the session's last
// self-report and can be arbitrarily stale. So:
//
//   - blocked from EITHER wins. A session that escalated and then went idle
//     waiting for the answer is still the card that needs a human, and
//     agent_status shows it as plain idle.
//   - reporting is taken only over live motion (working). herdr cannot express
//     it at all — the whole reason the token is read — and it is a close-out
//     checkpoint, so it is the more specific truth about a working session.
//   - spawned/briefed is taken ONLY where agent_status has nothing to say.
//     This is narrower than it first looks and deliberately so: `spawned` is
//     written by the SPAWNER, not by the session, so it persists until the
//     session's first self-report — and a session that never runs the
//     checkpoint never overwrites it. Reading it over an idle status rendered
//     a five-hour-old session as "starting" (observed against the live
//     snapshot while building this). agent_status can express idle, so idle
//     wins; the age chip beside the dot is what actually says "young".
//
// Anything else falls through to agent_status, which is the only half that is
// live.
func joinAgentState(status, token string) string {
	if status == "blocked" || token == "blocked" {
		return stateBlocked
	}
	switch status {
	case "working":
		if token == "reporting" {
			return stateReporting
		}
		return stateWorking
	case "idle", "done":
		return stateIdle
	case "", "unknown":
		// herdr has no observation — the pane exists but no agent session has
		// registered yet. This IS the starting window, and it is the only
		// place the token can speak without contradicting a live fact.
		switch token {
		case "spawned", "briefed":
			return stateStarting
		case stateWorking, stateReporting:
			return token
		}
		return stateUnknown
	}
	return stateUnknown
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

	// Machine-local card markings (signals.go). All three are decoration:
	// losing any of them loses a marking, never a card or a column.
	ledger Ledger              // spawn history — agent age, and branch off a dead session
	diffs  map[string]DiffStat // agent_ref → worktree diff, In Progress only
	glyphs glyphSet

	// showDone swaps the third column between Human Needed and Done (the `D`
	// key). doneCards is its data and stays nil here — GH-2062 owns the
	// bounded closed-issue read that fills it, so this unit renders the swap
	// and an empty state that NAMES what is missing.
	showDone  bool
	doneCards []Card

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
		diffs:     map[string]DiffStat{},
		glyphs:    cfg.Glyphs,
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

// glyphSet is the set the card strip draws from. A zero-valued set — a Config
// built without resolveGlyphs — falls back to ASCII rather than rendering the
// whole strip as empty strings: an unset knob must mean "the safe default",
// never "no glyphs at all".
func (m Model) glyphSet() glyphSet {
	if m.glyphs.dotFull == "" {
		return asciiGlyphs
	}
	return m.glyphs
}

// columnCards is the card list column idx is DISPLAYING. Every reader —
// cursor clamping, the scroll window, the renderer, hitTest — goes through
// here, so the `D` swap cannot leave one of them addressing Human Needed while
// another draws Done.
func (m Model) columnCards(idx int) []Card {
	if idx == 2 && m.showDone {
		return m.doneCards
	}
	return m.cols[idx]
}

// columnTitle names the displayed column. "Done · 14d" carries its window in
// the title on purpose: it is the audit window, not all history, and a header
// reading a bare "Done" would claim completeness it does not have.
func (m Model) columnTitle(idx int) string {
	if idx == 2 && m.showDone {
		return doneColumnTitle
	}
	return columnStates[idx]
}

// doneColumnTitle — the window is RALPH_AUDIT_DAYS, which GH-2062's read will
// honour; the label states it here so the swap can never ship without it.
const doneColumnTitle = "Done · 14d"

// selectedCard is the card under the cursor, if any.
func (m Model) selectedCard() (Card, bool) {
	cards := m.columnCards(m.col)
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

// cardState is the card's dot: every live agent's joined state, resolved by
// stateRank so the most attention-worthy wins. ok=false means no live agent —
// which the renderer must not draw like a live agent in an unknown state.
func (m Model) cardState(issue int) (string, bool) {
	as := m.agents[issue]
	if len(as) == 0 {
		return "", false
	}
	best := stateUnknown
	for _, a := range as {
		s := joinAgentState(a.Status, a.TokenState)
		if stateRank[s] < stateRank[best] {
			best = s
		}
	}
	return best, true
}

// cardAge is the LIVE agent's age since spawn. It resolves through the
// agent_ref the spawner recorded, so a respawned unit ages from the session
// actually on screen. ok=false = no record: rendered as a dash, never as 0m.
func (m Model) cardAge(issue int, now time.Time) (time.Duration, bool) {
	for _, a := range m.agents[issue] {
		if a.Root == "" {
			continue
		}
		if sp, ok := m.ledger.ByRef[a.Root]; ok {
			return now.Sub(sp.SpawnedAt), true
		}
	}
	return 0, false
}

// cardBranch is the checkout the work is on. The live agent's own token is
// preferred; the ledger's newest spawn for the issue answers for a session
// that has since exited, which is why an In Review card still names a branch.
func (m Model) cardBranch(issue int) string {
	for _, a := range m.agents[issue] {
		if a.Branch != "" {
			return a.Branch
		}
	}
	if sp, ok := m.ledger.ByIssue[issue]; ok {
		return sp.Branch
	}
	return ""
}

// cardDiff is the worktree measurement for a live agent's checkout. Two
// distinct falses: no live agent with a recorded checkout (live=false — there
// is nothing to measure, so nothing is drawn), and a measurement that failed
// (live=true, DiffStat.Known=false — drawn as ±?).
func (m Model) cardDiff(issue int) (DiffStat, bool) {
	for _, a := range m.agents[issue] {
		if a.Root == "" {
			continue
		}
		if st, ok := m.diffs[a.Root]; ok {
			return st, true
		}
		if sp, ok := m.ledger.ByRef[a.Root]; ok && sp.Checkout != "" {
			// A checkout we know about but have not measured yet: the read is
			// pending, not absent. ±? is the honest ink until it lands.
			return DiffStat{}, true
		}
	}
	return DiffStat{}, false
}

// diffTargets lists the (agent_ref, checkout) pairs worth measuring: live
// agents on In Progress cards, in board order, bounded. The bound is the point
// — each measurement is two local git processes, and an unbounded column would
// put that on the overlay tick.
func (m Model) diffTargets() []LedgerSpawn {
	var out []LedgerSpawn
	for _, c := range m.cols[0] { // In Progress only — the worktree column
		for _, a := range m.agents[c.Number] {
			if a.Root == "" {
				continue
			}
			sp, ok := m.ledger.ByRef[a.Root]
			if !ok || sp.Checkout == "" {
				continue
			}
			out = append(out, sp)
			if len(out) >= maxDiffReads {
				return out
			}
		}
	}
	return out
}

// maxDiffReads bounds one pass. Beyond it the chip stays ±? rather than
// silently reading as measured-and-clean.
const maxDiffReads = 8

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

// blurToCeiling is the third cadence input (GH-1876): the pane lost focus, so
// nobody can see the board. That is not "nothing changed" — it is "the reader
// left" — so it jumps straight to the staleness bound instead of walking there
// through the ×1.5 ramp.
//
// Bounded by construction, which is why a terminal that sends BlurMsg and never
// FocusMsg cannot strand the cadence: the ceiling IS the stated staleness bound
// (an unset MaxInterval leaves it at the floor — no backoff means no blur
// backoff either), and any keypress snaps back — and a pane you are not focused
// on is a pane you cannot type into.
func (m *Model) blurToCeiling() {
	ceiling := m.cfg.MaxInterval
	if ceiling < m.cfg.Interval {
		ceiling = m.cfg.Interval
	}
	m.pollEvery = ceiling
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
			// The C8 token rides along: a session pushing state=blocked is
			// about to move its item to Human Needed, which is exactly the
			// write this oracle exists to get ahead of.
			fmt.Fprintf(&b, "%s=%s/%s,", a.Name, a.Status, a.TokenState)
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
	n := len(m.columnCards(m.col))
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
