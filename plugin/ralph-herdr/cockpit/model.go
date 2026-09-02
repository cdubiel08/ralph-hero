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
	ModeBrowse   Mode = iota
	ModePeek          // agent read tail overlay — no focus steal
	ModeReply         // input line → herdr agent prompt (delivered on rc 0 only)
	ModeAnswer        // input line → board answer FIRST, then best-effort nudge
	ModeDag           // text tree from board frontier --json
	ModeTopology      // roster tree from board roster --json (GH-2219, unit K)
	ModeInbox         // full-body inbox view over board inbox Tier 1 (GH-2318)
)

// columnStates — the three cockpit columns, board Workflow State names
// VERBATIM (the decision-microworld lock). Order is the render order.
var columnStates = [3]string{"In Progress", "In Review", "Human Needed"}

// doneState is the board state name the closed-issue read's cards carry. Also
// verbatim, so a Done card is recognisable by the same test as every other.
const doneState = "Done"

// inboxState marks a card sourced from `board inbox` Tier 1 (GH-2181). NOT a
// board Workflow State — an inbox row is a cross-queue derivation (Human
// Needed, tend proposals, Intake approvals, deliver-blocked), so the card
// carries its queue kind in Queue and its disposition command in Verb.
const inboxState = "Inbox"

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
	// ClosedAt is set only on Done cards (the closed-issue window). It is the
	// one meta fact a closed card has: priority and estimate are not fetched
	// for it, which is why line 3 must not fall through to the meter that
	// renders an UNSET priority as a defect.
	ClosedAt string
	// Queue and Verb are set only on Inbox cards: which human queue the row
	// came from (decision/proposal/approval/deliver-blocked) and the literal
	// disposition command — the invariant that admitted the row to Tier 1.
	Queue string
	Verb  string
}

// PR chip fates (GH-2062, GH-2321). Six, and the two that mean "we did not
// find out" are deliberately separate: PRFateNone is a read that says this
// issue has no PR (blank chip), while an issue ABSENT from the map was never
// read (grey ?). An unread chip that rendered like a clean one is the failure
// GH-1971 fixed on the merge side.
//
// PRFateConflict is the sixth (GH-2321): a merge-conflicted PR used to demote
// to pending and render the SAME amber as checks-still-running, but "wait" and
// "someone must rebase" are different next actions.
const (
	PRFateNone     = "none"
	PRFateReady    = "ready"
	PRFatePending  = "pending"
	PRFateConflict = "conflict"
	PRFateMerged   = "merged"
	PRFateClosed   = "closed"
)

// PRMark is the chosen PR for one In Review card.
type PRMark struct {
	Number int
	Fate   string
}

// prFate classifies one linked PR.
//
// `ready` is deliberately WEAKER than "the merge gate will pass" — checks green
// and no known conflict, nothing more. Contract rule 7 is that gates are RUN,
// not predicted, and the cockpit is a viewer: `scripts/merge-pr.sh` is still
// the only thing that answers whether a PR may merge. The honest cost of that
// restraint is that a FAILING check renders the same amber as a still-running
// one — red is spoken for by closed-unmerged.
//
// A null rollup (no check has run yet) and a null mergeability (GitHub
// recomputes it lazily) are both "not proven ready", never "ready": green
// requires the positive fact. Only CONFLICTING is read off mergeability, so
// the UNKNOWN GitHub returns while recomputing cannot flap a green chip.
//
// CONFLICTING outranks the check rollup (GH-2321): whatever the checks say, a
// conflicted PR's next action is a rebase, and checks re-run after one.
func prFate(state string, merged bool, checks, mergeable string) string {
	if merged || state == "MERGED" {
		return PRFateMerged
	}
	if state != "OPEN" {
		return PRFateClosed
	}
	if mergeable == "CONFLICTING" {
		return PRFateConflict
	}
	if checks == "SUCCESS" {
		return PRFateReady
	}
	return PRFatePending
}

// chipRank orders the fates a card may draw from when an issue has several
// linked PRs: a live PR is what the operator acts on, and among equals the
// newest (highest number) wins. PRFateNone ranks last so any real PR displaces
// the zero value.
var chipRank = map[string]int{
	PRFateReady:    0,
	PRFatePending:  0, // one class: all three are "the open PR", ink differs
	PRFateConflict: 0,
	PRFateMerged:   1,
	PRFateClosed:   2,
	PRFateNone:     3,
}

func betterChip(a, b PRMark) bool {
	ra, rb := chipRank[a.Fate], chipRank[b.Fate]
	if ra != rb {
		return ra < rb
	}
	return a.Number > b.Number
}

// EpicRollup is one parent's child tally. Truncated is load-bearing: 2/4 read
// off a truncated child list is not 2/4, and the renderer must say so.
type EpicRollup struct {
	Number    int
	Title     string
	Done      int
	Total     int
	Truncated bool
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
	// Parent is tokens.parent — the spawner's own agent_ref for a child
	// spawn (a lead's worker, a driver's investigator). Empty for a depth-0
	// root, which is what every human-launched session is. GH-2217: C8
	// lineage finally read rather than pushed into the void; the peek header
	// renders it, and unit K's tree view joins on it.
	Parent string
	// Depth is tokens.depth, verbatim. "" is NOT "0" — an absent token is a
	// session whose spawner recorded no lineage, and no reader may invent
	// one (the roster's own rule, GH-2211).
	Depth string
	// Branch is tokens.branch — the checkout this session took. Free: it
	// arrives in the same snapshot the status does.
	Branch string
	// TokenState is the ralph C8 `state` token the session pushes at its own
	// checkpoints (spawned → working → blocked → reporting). It expresses what
	// agent_status structurally cannot; cardState decides when it may speak.
	TokenState string
	// Address is tokens.address — the derived herd address the spawner
	// stamped (GH-2209/D0.4). Empty for a pre-grammar spawn.
	Address string
}

// TopoRow is one `board roster --json` row — the derived topology view
// (GH-2219, unit K). Null JSON fields land as zero values here, and the
// renderer keeps absence as absence: an empty Depth is NOT depth 0, an empty
// Team is the flat bucket, and Note carries the reason a null is null.
type TopoRow struct {
	Name       string
	Address    string
	Repo       string
	Team       string // t<epic>-<slug>; "" = no team (the flat bucket)
	Lane       string
	Issue      int
	Role       string
	TokenState string // C8 `state` token, verbatim
	Status     string // herdr agent_status
	Depth      string
	Parent     string
	Pane       string
	Dispatch   bool // the <repo>/dispatch root row
	Note       string
	HasLease   bool
	LeaseStale bool
}

// TopoEsc is one live escalation (`board escalations --json`), the join the
// tree's escalation counts ride: workers join on Number == TopoRow.Issue,
// leads on Lead == TopoRow.Name. A null lead stays "" and is attributed to NO
// row — the count still lands in the header totals.
type TopoEsc struct {
	Number      int
	Route       string // "lead" | "human"
	Lead        string // "" = unreadable route payload — never attributed
	Disposition string // pending | promoted | auto-promoted; "" for route "human"
	Answered    bool   // GH-2204: answered, resume pending
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
	// lastMarkSeen is the newest board.ts write-stamp mtime already acted on
	// (marks.go, audit A6). Zero until the first successful read, which seeds
	// the baseline without triggering a refetch.
	lastMarkSeen time.Time

	// Agent overlay (decoration).
	agents  map[int][]Agent // issue → live agents, w-lane first then by name
	herdrOK bool            // false = no multiplexer — overlay off, verbs degrade

	// Machine-local card markings (signals.go). All three are decoration:
	// losing any of them loses a marking, never a card or a column.
	ledger Ledger              // spawn history — agent age, and branch off a dead session
	diffs  map[string]DiffStat // agent_ref → worktree diff, In Progress only
	glyphs glyphSet

	// Board-sourced card markings (GH-2062) — the second cadence. Both maps
	// are per-issue authoritative WITHIN a successful pass: an issue present
	// with PRFateNone has no PR, an issue absent was not read. signalsOK is
	// false until the first successful pass and again after any failure, which
	// is what makes every chip fall back to the grey `?`.
	prs             map[int]PRMark
	epics           map[int]EpicRollup
	signalsOK       bool
	signalsErr      string
	lastSignals     time.Time
	signalsInFlight bool

	// showDone swaps the third column between Human Needed and Done (the `D`
	// key); the closed-issue read is dispatched LAZILY, only while the column
	// is on screen. doneOK/doneErr keep "not read yet", "read failed" and
	// "nothing closed in the window" three distinct empty states.
	showDone       bool
	doneCards      []Card
	doneOK         bool
	doneErr        string
	doneWindowDays int
	lastDone       time.Time
	doneInFlight   bool

	// showInbox swaps the same third column to `board inbox` Tier 1 (the `I`
	// key, GH-2181) — the fourth view on the D-toggle precedent, so showDone
	// and showInbox are mutually exclusive by construction (each key clears
	// the other). Same lazy-read contract: dispatched only while on screen,
	// with "not read yet", "read failed" and "inbox empty" kept distinct.
	showInbox     bool
	inboxCards    []Card
	inboxOK       bool
	inboxErr      string
	inboxWithheld string // "N reason, M reason" — GH-2108: held-back rows are counted, never dropped silently
	lastInbox     time.Time
	inboxInFlight bool
	inboxLeads    string // GH-2218 "with leads" — rows a lead still holds, counted, never dropped
	// Inbox VIEW (GH-2318) — the queue-level flip-to surface (`i`) over the
	// same read the `I` column uses. inboxRow is the cursor inside it.
	// inboxReturn marks an answer launched FROM the view, so the input line's
	// esc and the answer's result land back in the view rather than in browse.
	inboxRow    int
	inboxReturn bool
	// inboxRereadWanted: an answer landed while a cadence read was already in
	// flight. That read started BEFORE the answer, so its result cannot show
	// the disposition — one more read is owed when it lands.
	inboxRereadWanted bool

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

	// Topology overlay (GH-2219, unit K) — a snapshot taken on the `T` press,
	// like the DAG. topoEscErr keeps "escalation counts unreadable" apart from
	// "no escalations": the roster half is required, the escalations half is
	// best-effort, and a failed count must render as NOT COUNTED, never as 0.
	topoRows       []TopoRow
	topoRepo       string
	topoWithheld   string // counted holdbacks (GH-2108), "" = nothing withheld
	topoAgentsNote string // agentsEvaluated=false reason — an unreadable herd is NOT an empty fleet
	topoEscs       []TopoEsc
	topoEscErr     string

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
		prs:       map[int]PRMark{},
		epics:     map[int]EpicRollup{},
		glyphs:    cfg.Glyphs,
		herdrOK:   cfg.Herdr != "",
		width:     80,
		height:    24,
		pollEvery: cfg.Interval,
		// The label the Done header carries until the read answers. The read's
		// own windowDays replaces it, so a repo that sets RALPH_AUDIT_DAYS is
		// never described by this default for longer than one pass.
		doneWindowDays: defaultAuditDays,
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
	if idx == 2 && m.showInbox {
		return m.inboxCards
	}
	if idx == 2 && m.showDone {
		return m.doneCards
	}
	return m.cols[idx]
}

// columnTitle names the displayed column. "Done · 14d" carries its window in
// the title on purpose: it is the audit window, not all history, and a header
// reading a bare "Done" would claim completeness it does not have.
func (m Model) columnTitle(idx int) string {
	if idx == 2 && m.showInbox {
		return "Inbox"
	}
	if idx == 2 && m.showDone {
		return m.doneTitle()
	}
	return columnStates[idx]
}

// doneTitle states the window the read actually used, not a constant: a repo
// that raises RALPH_AUDIT_DAYS would otherwise be told "14d" over 30 days of
// closes, which is the same class of lie as a bare "Done".
func (m Model) doneTitle() string {
	return fmt.Sprintf("Done · %dd", m.doneWindowDays)
}

// defaultAuditDays mirrors board.ts's RALPH_AUDIT_DAYS default — the header's
// label before the first read answers, never a claim about the data.
const defaultAuditDays = 14

// selectedCard is the card under the cursor, if any.
func (m Model) selectedCard() (Card, bool) {
	cards := m.columnCards(m.col)
	if m.row < 0 || m.row >= len(cards) {
		return Card{}, false
	}
	return cards[m.row], true
}

// selectedInboxCard is the inbox view's row under its cursor, if any.
func (m Model) selectedInboxCard() (Card, bool) {
	if m.inboxRow < 0 || m.inboxRow >= len(m.inboxCards) {
		return Card{}, false
	}
	return m.inboxCards[m.inboxRow], true
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

// agentLineage renders a live agent's C8 lineage tokens for the peek header
// (GH-2217 — parent/root/depth read, never pushed into the void): "depth 1 ·
// parent o2208-…#ab12" for a lead-spawned worker, "depth 0" for a recorded
// root, "" when the spawner recorded nothing — absence stays absence, the
// roster's own rule.
func (m Model) agentLineage(name string) string {
	for _, as := range m.agents {
		for _, a := range as {
			if a.Name != name {
				continue
			}
			var parts []string
			if a.Depth != "" {
				parts = append(parts, "depth "+a.Depth)
			}
			if a.Parent != "" {
				parts = append(parts, "parent "+a.Parent)
			}
			return strings.Join(parts, " · ")
		}
	}
	return ""
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

// cardCost is the LIVE agent's latest usage fact (GH-2347), resolved through
// the same exact agent_ref join as cardAge. ok=false = no fact yet for the
// session on screen: rendered as nothing, never as $0 — a worker between
// spawn and its first done turn has a cost, just not a recorded one.
func (m Model) cardCost(issue int) (LedgerUsage, bool) {
	for _, a := range m.agents[issue] {
		if a.Root == "" {
			continue
		}
		if u, ok := m.ledger.Usage[a.Root]; ok {
			return u, true
		}
	}
	return LedgerUsage{}, false
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

// cardPR is the In Review chip's data. ok=false means UNREAD — the read
// failed, has not landed, or did not cover this issue — and the renderer draws
// that as a grey `?`. ok=true with PRFateNone is the different, stronger fact
// that this issue has no PR, which draws nothing at all.
func (m Model) cardPR(issue int) (PRMark, bool) {
	if !m.signalsOK {
		return PRMark{}, false
	}
	mark, ok := m.prs[issue]
	return mark, ok
}

// cardEpic is the parent rollup for a card. ok=false leaves the caret and the
// bare parent number the Model already holds — a rollup we could not read must
// not invent a denominator.
func (m Model) cardEpic(parent int) (EpicRollup, bool) {
	if !m.signalsOK || parent == 0 {
		return EpicRollup{}, false
	}
	e, ok := m.epics[parent]
	return e, ok
}

// signalsWanted reports whether there is anything for the second cadence to
// mark. A board with no In Review card and no parented card has no chip and no
// rollup to draw, so the pass is skipped entirely rather than paying for a
// board read to fill nothing — the common shape of a quiet board.
func (m Model) signalsWanted() bool {
	if len(m.cols[1]) > 0 {
		return true
	}
	for i := range m.cols {
		for _, c := range m.cols[i] {
			if c.ParentNumber != 0 {
				return true
			}
		}
	}
	return false
}

// signalsDue is the second cadence's gate. Fixed, not adaptive: the board poll
// backs off because its writers are visible in the free agent overlay (GH-1805),
// and nothing here can see a reviewer approving a PR or a check turning green.
func (m Model) signalsDue(now time.Time) bool {
	if m.signalsInFlight || !m.signalsWanted() {
		return false
	}
	return m.lastSignals.IsZero() || !now.Before(m.lastSignals.Add(m.cfg.SignalInterval))
}

// doneDue gates the closed-issue read. Shown-only: the Done column is behind a
// key, so a cockpit nobody has pressed `D` on never pays for the window.
func (m Model) doneDue(now time.Time) bool {
	if m.doneInFlight || !m.showDone {
		return false
	}
	return m.lastDone.IsZero() || !now.Before(m.lastDone.Add(m.cfg.SignalInterval))
}

// inboxDue gates the inbox read the same way: shown-only, so a cockpit nobody
// has pressed `I` on never pays for the four-queue walk.
func (m Model) inboxDue(now time.Time) bool {
	if m.inboxInFlight || !(m.showInbox || m.inboxViewUp()) {
		return false
	}
	return m.lastInbox.IsZero() || !now.Before(m.lastInbox.Add(m.cfg.SignalInterval))
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
// inboxViewUp is whether the body is drawing the inbox VIEW — including while
// an answer launched from it is being typed, since the view stays behind the
// input line and its rows must keep refreshing.
func (m Model) inboxViewUp() bool {
	return m.mode == ModeInbox || (m.mode == ModeAnswer && m.inboxReturn)
}

// clampInboxRow keeps the inbox view's cursor on a row that exists — the list
// changes under it on every refresh (an answered decision leaves it).
func (m *Model) clampInboxRow() {
	n := len(m.inboxCards)
	if n == 0 {
		m.inboxRow = 0
		return
	}
	if m.inboxRow >= n {
		m.inboxRow = n - 1
	}
	if m.inboxRow < 0 {
		m.inboxRow = 0
	}
}

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
