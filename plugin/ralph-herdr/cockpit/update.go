// update.go — the pure update loop. Every transition lives in updateModel so
// the table tests drive it without a terminal; Model.Update is the thin
// bubbletea adapter. Degradation rule everywhere: losing herdr loses CHROME
// (observe/peek/reply fall back to printed hints) — never a verb (a/g/v/q and
// the board columns keep working).
package main

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

const noMuxBanner = "no multiplexer — observe/reply degraded to board verbs"

func (m Model) Init() tea.Cmd {
	cmds := []tea.Cmd{
		fetchBoardCmd(m.cfg, m.runner),
		fetchAgentsCmd(m.cfg, m.runner),
		tea.Tick(m.cfg.Interval, func(t time.Time) tea.Msg { return tickMsg(t) }),
	}
	// Seed the write-stamp watch (the first observation is a baseline, never a
	// trigger — Init is already fetching) and stamp liveness immediately, so a
	// cockpit that dies inside its first interval still left one heartbeat.
	if c := checkMarksCmd(m.cfg); c != nil {
		cmds = append(cmds, c)
	}
	if c := heartbeatCmd(m.cfg); c != nil {
		cmds = append(cmds, c)
	}
	return tea.Batch(cmds...)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	return updateModel(m, msg)
}

func (m Model) View() string { return viewModel(m) }

// updateModel is the pure core: Model in, Model out, plus any Cmds. No I/O.
func updateModel(m Model, msg tea.Msg) (Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil

	case tickMsg:
		// The tick is FIXED at the floor: the agent overlay is a local herdr
		// call and must stay live. Only the board walk — the expensive read —
		// is gated by the adaptive cadence (GH-1805).
		cmds := []tea.Cmd{
			fetchAgentsCmd(m.cfg, m.runner), // overlay refresh every tick
			tea.Tick(m.cfg.Interval, func(t time.Time) tea.Msg { return tickMsg(t) }),
		}
		// Two free local side channels ride the fixed tick: the write-stamp
		// watch (audit A6 — a local board write is visible here one stat
		// ahead of any poll) and the liveness heartbeat (audit D6d).
		if c := checkMarksCmd(m.cfg); c != nil {
			cmds = append(cmds, c)
		}
		if c := heartbeatCmd(m.cfg); c != nil {
			cmds = append(cmds, c)
		}
		if !m.pollInFlight && m.pollDue(time.Time(msg)) {
			m.pollInFlight = true
			cmds = append(cmds, fetchBoardCmd(m.cfg, m.runner))
		}
		// The second cadence (GH-2062), gated separately: it is skipped
		// entirely when there is nothing to mark, and the Done window is only
		// read while its column is on screen.
		if m.signalsDue(time.Time(msg)) {
			m.signalsInFlight = true
			cmds = append(cmds, fetchSignalsCmd(m.cfg, m.runner))
		}
		if m.doneDue(time.Time(msg)) {
			m.doneInFlight = true
			cmds = append(cmds, fetchDoneCmd(m.cfg, m.runner))
		}
		if m.inboxDue(time.Time(msg)) {
			m.inboxInFlight = true
			cmds = append(cmds, fetchInboxCmd(m.cfg, m.runner))
		}
		if m.epicDue(time.Time(msg)) {
			m.epicInFlight = true
			cmds = append(cmds, fetchEpicCmd(m.cfg, m.runner, m.epicFor))
		}
		return m, tea.Batch(cmds...)

	case marksMsg:
		// board.ts's local write stamp moved (audit A6). Three cases, in the
		// only safe order: a zero time is a failed or absent read and asserts
		// NOTHING; the first successful read is a baseline (Init already
		// fetched); a LATER mtime is evidence of a verified local write —
		// snap the cadence and refetch now, without waiting out the backoff.
		// The channel can only SHORTEN staleness (GH-1806's rule): a missed
		// stamp costs one ordinary poll interval, nothing more.
		if msg.at.IsZero() {
			return m, nil
		}
		if m.lastMarkSeen.IsZero() {
			m.lastMarkSeen = msg.at
			return m, nil
		}
		if !msg.at.After(m.lastMarkSeen) {
			return m, nil
		}
		m.lastMarkSeen = msg.at
		m.snapToFloor()
		if m.pollInFlight {
			return m, nil // the running fetch will carry the write
		}
		m.pollInFlight = true
		return m, fetchBoardCmd(m.cfg, m.runner)

	case boardMsg:
		m.pollInFlight = false
		now := time.Now()
		m.lastPoll = now
		m.boardErr = msg.err
		// Per-column merge: a FAILED column read keeps its last good cards
		// (a failed read and an empty column are different facts — matching
		// fetch.go's "reports as an error, never as empty" and the fzf
		// rung's whole-render refusal); a successful read replaces, empty
		// included. The column header says which it got (colFailed).
		whole := msg.err == ""
		for i := range msg.cols {
			m.colFailed[i] = msg.failed[i]
			if msg.failed[i] {
				whole = false
				continue
			}
			m.cols[i] = msg.cols[i]
			m.colGoodAt[i] = now
		}
		// The liveness spinner turns only on a poll that landed whole; a
		// failed one stops it, and the header goes stale on the age of the
		// last whole poll (spec §6).
		if whole {
			m.lastGoodPoll = now
			m.spinFrame++
		}
		m.clampCursor()
		// Cadence, measured on the MERGED columns: a failed read keeps its last
		// good cards, so it reads as unchanged and backs off — which is what a
		// rate-limited board wants. The first poll (empty signature) is a change
		// only if it found cards.
		if sig := boardSignature(m.cols); sig != m.boardSig {
			m.boardSig = sig
			m.snapToFloor()
		} else {
			m.backoff()
		}
		// The markings hang off these cards, and until they landed there was
		// nothing to mark (signalsWanted is false on an empty board). Asking
		// here rather than waiting for the next tick is what makes the first
		// board a marked board.
		var cmds []tea.Cmd
		if m.signalsDue(time.Now()) {
			m.signalsInFlight = true
			cmds = append(cmds, fetchSignalsCmd(m.cfg, m.runner))
		}
		// A card whose session the last transcript pass never saw — the
		// board landing after the overlay on a cold start — is priced now
		// rather than at the next agents poll, and only then.
		if m.usageMissing() {
			cmds = append(cmds, fetchUsageCmd(m.cfg, m.usageSnapshot(), m.usageTargets(), time.Now()))
		}
		return m, tea.Batch(cmds...)

	case signalsMsg:
		m.signalsInFlight = false
		m.lastSignals = time.Now()
		m.signalsErr = msg.err
		if !msg.ok {
			// REPLACE with nothing, not merge: signalsOK false already sends
			// every chip to `?`, and keeping the last good marks beside it
			// would mean a card drawn green off a read that has since failed.
			// The board columns keep their last good cards because a card is
			// the WORK; a marking is a claim about right now.
			m.signalsOK = false
			return m, nil
		}
		m.signalsOK = true
		m.prs = msg.prs
		m.epics = msg.epics
		return m, nil

	case doneMsg:
		m.doneInFlight = false
		m.lastDone = time.Now()
		m.doneErr = msg.err
		if !msg.ok {
			m.doneOK = false
			return m, nil
		}
		m.doneOK = true
		m.doneGoodAt = m.lastDone
		m.doneCards = msg.cards
		if msg.windowDays > 0 {
			m.doneWindowDays = msg.windowDays
		}
		// The Done list just changed length under a cursor that may be parked
		// past its end — the same clamp the `D` swap itself performs.
		m.clampCursor()
		// Closed units price from their exited sessions (the ledger's
		// claude_session): a window that brought new cards is priced now.
		if m.usageMissing() {
			return m, fetchUsageCmd(m.cfg, m.usageSnapshot(), m.usageTargets(), time.Now())
		}
		return m, nil

	case inboxMsg:
		m.inboxInFlight = false
		m.lastInbox = time.Now()
		m.inboxErr = msg.err
		// A read that predates an answer cannot show its disposition — pay
		// the one read still owed, whether this one succeeded or failed.
		var owed tea.Cmd
		if m.inboxRereadWanted {
			m.inboxRereadWanted = false
			m.inboxInFlight = true
			owed = fetchInboxCmd(m.cfg, m.runner)
		}
		if !msg.ok {
			m.inboxOK = false
			return m, owed
		}
		m.inboxOK = true
		m.inboxGoodAt = m.lastInbox
		m.inboxCards = msg.cards
		m.inboxWithheld = msg.withheld
		m.inboxLeads = msg.leads
		m.clampInboxRow()
		if owed != nil {
			return m, owed
		}
		// Same clamp as doneMsg: the list length just changed under the cursor.
		m.clampCursor()
		return m, nil

	case agentsMsg:
		m.herdrOK = msg.herdrOK
		m.agents = setAgents(msg.agents)
		if msg.ledger.Read {
			// Only a ledger we actually read replaces the last one. An
			// unreadable file is a failed read, and dropping every age chip to
			// a dash on one transient stat error would look exactly like a
			// fleet nobody spawned through the sanctioned path.
			m.ledger = msg.ledger
		}
		// The writers are visible here, one free local read ahead of their board
		// writes: a session appearing (it is about to claim), going blocked (it
		// moved the item to Human Needed), or leaving. Snap, don't wait.
		if sig := agentSignature(m.agents); sig != m.agentSig {
			m.agentSig = sig
			m.snapToFloor()
		}
		// The diff pass runs off the joined state, so it is dispatched here
		// rather than on the tick: before this message there is no agent_ref
		// to measure against, and after it the target list is exact.
		// The transcript join rides the same joined state: the session id
		// arrives in this snapshot, so this is the first moment there is a
		// transcript to name. Always dispatched — a fleet of zero still
		// carries the header's spend log read.
		cmds := []tea.Cmd{fetchUsageCmd(m.cfg, m.usageSnapshot(), m.usageTargets(), time.Now())}
		if targets := m.diffTargets(); len(targets) > 0 {
			cmds = append(cmds, fetchDiffsCmd(m.runner, targets))
		}
		return m, tea.Batch(cmds...)

	case usageMsg:
		// Merged, then pruned to the sessions on screen (mergeUsage) — see
		// there for why this is not the diffs pass's whole-map replace.
		m.mergeUsage(msg.usage)
		m.gql, m.gqlOK = msg.gql, msg.gqlOK
		return m, nil

	case diffsMsg:
		// REPLACE, never merge: a stale entry for an agent that has since
		// exited would keep drawing a diff for a worktree nobody is in.
		m.diffs = msg.diffs
		return m, nil

	case peekMsg:
		if m.mode != ModeBrowse && m.mode != ModeEpic {
			// A slow peek landing after the user moved on (started a reply,
			// opened another overlay) must never hijack the mode — typed
			// keystrokes would leak into overlay/browse verb handling.
			return m, nil
		}
		if msg.err != "" {
			m.say(statusRefuse, fmt.Sprintf("peek %s failed: %s", msg.who, msg.err))
			return m, nil
		}
		// The overlay a peek was opened FROM is where its esc lands (GH-2381):
		// a peek on an epic child returns to the epic, not to the board.
		m.peekReturn = m.mode
		m.mode = ModePeek
		m.peekWho = msg.who
		m.peekText = msg.text
		return m, nil

	case epicMsg:
		m.epicInFlight = false
		m.lastEpic = time.Now()
		if msg.issue != m.epicFor {
			return m, nil // a read for an epic the operator has since moved off, or closed
		}
		if msg.err != "" {
			// A failed OPEN is a refusal on the status line; a failed REFRESH
			// keeps the last good view under the stale banner (viewModel) —
			// the D column's own rule, so children never vanish on a flap.
			m.epicOK, m.epicErr = false, msg.err
			if m.mode != ModeEpic {
				m.say(statusRefuse, fmt.Sprintf("epic #%d read failed: %s", msg.issue, msg.err))
			}
			return m, nil
		}
		m.epicOK, m.epicErr = true, ""
		m.epic = msg.view
		if m.mode == ModeBrowse {
			// Never-hijack, same as peek: the overlay opens only if the
			// operator is still where they pressed `e` — in browse AND on a
			// card of the epic they asked for. A cursor that moved to another
			// epic's card (or off every card) while the read was out keeps
			// the data (the next `e` is instant) and gets a nudge, never an
			// overlay over a context they have left.
			if card, ok := m.selectedCard(); !ok || card.ParentNumber != msg.issue {
				m.say(statusNudge, fmt.Sprintf("epic #%d read landed after the selection moved — e on one of its cards opens it", msg.issue))
				return m, nil
			}
			m.mode = ModeEpic
			m.epicRow = 0
			m.say(statusView, fmt.Sprintf("epic #%d — %d children; esc closes", msg.view.Number, len(msg.view.Children)))
		}
		m.clampEpicRow()
		// A Done child's closing PR is not on the issue fetch (a nested
		// connection under subIssues is the GH-1811 shape); it is joined from
		// the Done-window read the D column already makes, dispatched ONCE
		// here when the window has never been read.
		if m.mode == ModeEpic && m.epicHasDone() && m.lastDone.IsZero() && !m.doneInFlight {
			m.doneInFlight = true
			return m, fetchDoneCmd(m.cfg, m.runner)
		}
		return m, nil

	case dagMsg:
		if m.mode != ModeBrowse {
			return m, nil // stale result — same never-hijack rule as peekMsg
		}
		if msg.err != "" {
			m.say(statusRefuse, "frontier read failed: "+msg.err)
			return m, nil
		}
		m.mode = ModeDag
		m.dagText = msg.text
		return m, nil

	case topoMsg:
		if m.mode != ModeBrowse {
			return m, nil // stale result — same never-hijack rule as peekMsg
		}
		if msg.err != "" {
			m.say(statusRefuse, "roster read failed: "+msg.err)
			return m, nil
		}
		m.mode = ModeTopology
		m.topoRows = msg.rows
		m.topoRepo = msg.repo
		m.topoWithheld = msg.withheld
		m.topoAgentsNote = msg.agentsNote
		m.topoEscs = msg.escs
		m.topoEscErr = msg.escErr
		return m, nil

	case replyDoneMsg:
		m.sending = false
		if msg.ok {
			// The delivered checkmark — ONLY here, on herdr's rc 0.
			m.mode = ModeBrowse
			m.input = ""
			m.inputErr = ""
			m.say(statusOK, fmt.Sprintf("delivered to %s", msg.who))
			return m, nil
		}
		// Failure: typed text is PRESERVED in the input line; the error is
		// shown beside it. Nothing optimistic, nothing lost.
		m.mode = ModeReply
		m.inputErr = fmt.Sprintf("not delivered: %s — text preserved, ⏎ retries, esc leaves", msg.detail)
		return m, nil

	case answerDoneMsg:
		m.sending = false
		if !msg.boardOK {
			if msg.boardPosted {
				// board.ts posted the durable **Answer** comment and THEN
				// refused the move — re-answering would duplicate the
				// comment (the fzf rung's exact guidance: retry the MOVE,
				// not the answer). The text is on the record; clear it.
				m.mode = m.answerReturnMode()
				m.input = ""
				m.inputErr = ""
				m.say(statusRefuse, fmt.Sprintf("#%d: the Answer comment IS on the record — only the move failed; retry the MOVE (board claim %d), never re-answer", msg.issue, msg.issue))
				refresh := m.inboxRefreshAfterAnswer()
				return m, refresh
			}
			// The durable half failed — preserve the answer text for retry.
			// Hedged: an unlabeled crash could still land after the comment,
			// so the coaching names the check before the re-send.
			m.mode = ModeAnswer
			m.inputErr = fmt.Sprintf("board answer failed: %s — text preserved, ⏎ retries (if the Answer comment already posted, esc and retry the move: board claim %d)", msg.boardDetail, msg.issue)
			return m, nil
		}
		m.mode = m.answerReturnMode()
		m.input = ""
		m.inputErr = ""
		board := fmt.Sprintf("board: ✓ #%d answered", msg.issue)
		agent := "agent: none live — spawn or requeue by hand"
		if msg.agentTried {
			if msg.agentOK {
				agent = fmt.Sprintf("agent: ✓ nudged %s", msg.agentName)
			} else {
				agent = fmt.Sprintf("agent: ✗ %s (answer IS on the issue)", msg.agentDetail)
			}
		}
		m.say(statusOK, board+" · "+agent)
		// The item just moved Human Needed → In Progress: re-poll now. Our own
		// write, so the cadence returns to the floor too — more is coming.
		m.pollInFlight = true
		m.snapToFloor()
		refresh := m.inboxRefreshAfterAnswer()
		return m, tea.Batch(fetchBoardCmd(m.cfg, m.runner), refresh)

	case spawnDoneMsg:
		switch msg.rc {
		case 0:
			// A spawned session claims the issue within seconds — a board write
			// we caused. Be at the floor when it lands.
			m.snapToFloor()
			m.say(statusOK, fmt.Sprintf("spawn #%d: %s", msg.issue, msg.detail))
		case 2:
			m.say(statusNudge, fmt.Sprintf("spawn #%d skipped — %s", msg.issue, msg.detail))
		default:
			m.say(statusRefuse, fmt.Sprintf("spawn #%d failed (rc %d): %s", msg.issue, msg.rc, msg.detail))
		}
		// The freshness verdict rides every outcome: a spawn that ran on a
		// stale plugin took the risk whether or not it succeeded (GH-2340).
		if msg.notice != "" {
			m.status += " · " + msg.notice
		}
		return m, fetchAgentsCmd(m.cfg, m.runner)

	case forkDoneMsg:
		if msg.rc == 0 {
			m.say(statusOK, fmt.Sprintf("fork #%d: %s", msg.issue, msg.detail))
		} else {
			m.say(statusRefuse, fmt.Sprintf("fork #%d failed (rc %d): %s", msg.issue, msg.rc, msg.detail))
		}
		return m, fetchAgentsCmd(m.cfg, m.runner)

	case statusMsg:
		m.say(msg.kind, msg.text)
		return m, nil

	case tea.FocusMsg:
		// The pane is visible again. Same evidence a keypress carries — a human
		// is looking — so the same one-step snap, and like a keypress it does
		// not touch lastPoll, so flapping focus can never poll below the floor.
		m.snapToFloor()
		return m, nil

	case tea.BlurMsg:
		// Nobody can see this pane. Back off in one step rather than paying the
		// ramp for a board nobody is reading.
		m.blurToCeiling()
		return m, nil

	case tea.MouseMsg:
		// A human is at the cockpit: freshness is worth paying for again. Only
		// the cadence resets — lastPoll does not — so a burst of keystrokes can
		// never poll faster than the floor.
		m.snapToFloor()
		return updateMouse(m, msg)

	case tea.KeyMsg:
		m.snapToFloor()
		return updateKey(m, msg)
	}
	return m, nil
}

// updateKey routes keys by mode. Input modes swallow everything except their
// few control keys — a focused herdr pane already receives all non-prefix
// keys, so the cockpit must never leak navigation into typed text.
func updateKey(m Model, msg tea.KeyMsg) (Model, tea.Cmd) {
	key := msg.String()

	// Global: ctrl+c always quits; q quits from any non-input mode.
	if key == "ctrl+c" {
		return m, tea.Quit
	}

	switch m.mode {
	case ModeReply, ModeAnswer:
		return updateInputKey(m, msg)

	case ModePeek:
		switch key {
		case "esc", "q", " ", "o":
			m.mode = m.peekReturn
			m.peekReturn = ModeBrowse
			m.peekText = ""
		}
		return m, nil

	case ModeEpic:
		// The popover's verbs act on the selected CHILD through the same
		// functions the board's keys use (GH-2381) — one refusal per verb,
		// wherever it is pressed.
		switch key {
		case "esc", "q", "e":
			// Closing forgets WHICH epic was asked for, so a cadence refresh
			// still out when the overlay closed is dropped on arrival by the
			// "not the epic asked for" rule above — never reopened over a
			// board the operator explicitly returned to. The next `e`
			// dispatches its own read.
			m.mode = ModeBrowse
			m.epicFor = 0
			m.say(statusView, "board")
		case "j", "down":
			m.epicRow++
			m.clampEpicRow()
		case "k", "up":
			m.epicRow--
			m.clampEpicRow()
		case "enter":
			if child, ok := m.selectedEpicChild(); ok {
				return verbObserveCard(m, child)
			}
			m.say(statusNudge, "no child selected")
		case " ", "o":
			if child, ok := m.selectedEpicChild(); ok {
				return verbPeekCard(m, child)
			}
			m.say(statusNudge, "no child selected")
		case "g":
			if child, ok := m.selectedEpicChild(); ok {
				return m, openBrowserCmd(child)
			}
			m.say(statusNudge, "no child selected")
		}
		return m, nil

	case ModeDag:
		switch key {
		case "esc", "q", "v":
			m.mode = ModeBrowse
		}
		return m, nil

	case ModeTopology:
		switch key {
		case "esc", "q", "T":
			m.mode = ModeBrowse
		}
		return m, nil

	case ModeInbox:
		return updateInboxKey(m, key)
	}

	// ModeBrowse.
	switch key {
	case "q":
		return m, tea.Quit

	case "h", "left":
		m.col--
		m.clampCursor()
	case "l", "right":
		m.col++
		m.clampCursor()
	case "j", "down":
		m.row++
		m.clampCursor()
	case "k", "up":
		m.row--
		m.clampCursor()

	case "enter":
		return verbObserve(m)

	case " ", "o":
		return verbPeek(m)

	case "r":
		return verbReply(m)

	case "a":
		return verbAnswer(m)

	case "s":
		return verbSpawn(m)

	case "f":
		return verbFork(m)

	case "v":
		m.say(statusFlight, "reading frontier…")
		return m, dagCmd(m.cfg, m.runner)

	case "T":
		// The topology tree (GH-2219, D6.1) — on its own letter, NOT on D
		// (operator note): D swaps a column, T replaces the body. Upper-case
		// because a slip from `t` should do nothing rather than change a view.
		m.say(statusFlight, "reading roster…")
		return m, topologyCmd(m.cfg, m.runner)

	case "d":
		card, ok := m.selectedCard()
		if !ok {
			m.say(statusNudge, "no card selected")
			return m, nil
		}
		m.say(statusFlight, fmt.Sprintf("looking up #%d's PR…", card.Number))
		return m, prDiffCmd(m.cfg, m.runner, card.Number)

	case "D":
		// Swap the third column between Human Needed and Done. Upper-case
		// because `d` is the PR diff and a slip between the two would open a
		// pane rather than change a view.
		//
		// The cursor is clamped straight after: the two lists are different
		// lengths, and a row index that outlives the swap would leave every
		// verb acting on a card that is not under the cursor.
		m.showDone = !m.showDone
		// The two toggled views share the column, so arriving at Done leaves
		// Inbox — one view at a time, never a stack.
		m.showInbox = false
		if m.col == 2 {
			m.row = 0
		}
		m.clampCursor()
		if !m.showDone {
			m.say(statusView, "third column: Human Needed")
			return m, nil
		}
		// Fetch NOW rather than at the next tick: `D` is the whole signal that
		// anyone wants this column, and waiting up to SignalInterval to fill it
		// would make the key feel broken. Subsequent refreshes ride the second
		// cadence while the column stays up.
		m.say(statusView, m.doneTitle()+" — a WINDOW, not all history; D returns to Human Needed")
		if m.doneInFlight || !m.lastDone.IsZero() {
			return m, nil
		}
		m.doneInFlight = true
		return m, fetchDoneCmd(m.cfg, m.runner)

	case "I":
		// Swap the third column to the inbox — `board inbox` Tier 1, the
		// human's decision queue (GH-2181). The fourth view on the D-toggle
		// precedent: same column, same lazy read, same cursor clamp, and the
		// two toggles displace each other rather than stacking.
		m.showInbox = !m.showInbox
		m.showDone = false
		if m.col == 2 {
			m.row = 0
		}
		m.clampCursor()
		if !m.showInbox {
			m.say(statusView, "third column: Human Needed")
			return m, nil
		}
		// Fetch NOW rather than at the next tick — `I` is the whole signal
		// that anyone wants this view. Refreshes ride the second cadence
		// while the column stays up.
		m.say(statusView, "Inbox — Tier 1 decisions, each with its disposition verb; I returns to Human Needed")
		if m.inboxInFlight || !m.lastInbox.IsZero() {
			return m, nil
		}
		m.inboxInFlight = true
		return m, fetchInboxCmd(m.cfg, m.runner)

	case "i":
		return openInboxView(m)

	case "e":
		// The epic popover (GH-2381, spec §11): one `board get` on the
		// card's parent, dispatched NOW like D/I — the press is the whole
		// signal — and opened when it lands. Always dispatched, even over an
		// in-flight read for another epic: the result names its epic, and a
		// read for one the operator moved off is dropped on arrival.
		card, ok := m.selectedCard()
		if !ok {
			m.say(statusNudge, "no card selected")
			return m, nil
		}
		if kind, why := refuseEpic(card); kind != statusNone {
			m.say(kind, why)
			return m, nil
		}
		m.epicFor = card.ParentNumber
		m.epicInFlight = true
		m.say(statusFlight, fmt.Sprintf("reading epic #%d…", card.ParentNumber))
		return m, fetchEpicCmd(m.cfg, m.runner, card.ParentNumber)

	case "g":
		card, ok := m.selectedCard()
		if !ok {
			m.say(statusNudge, "no card selected")
			return m, nil
		}
		return m, openBrowserCmd(card)
	}
	return m, nil
}

// openInboxView flips the body to the inbox VIEW (GH-2318) — the queue-level
// surface over `board inbox` Tier 1. Lower-case `i` beside the `I` column
// swap deliberately: same letter, same subject, case picks the shape (I swaps
// a column, i replaces the body — the D/T split mirrored). The press takes a
// fresh snapshot when none is in flight, so close-and-reopen IS the refresh;
// while the view is up it rides the signal cadence like the I column.
func openInboxView(m Model) (Model, tea.Cmd) {
	m.mode = ModeInbox
	m.inboxReturn = false
	m.clampInboxRow()
	m.say(statusView, "Inbox — Tier 1, oldest first; a/⏎ answers a decision row; i or esc returns")
	if m.inboxInFlight {
		return m, nil
	}
	m.inboxInFlight = true
	return m, fetchInboxCmd(m.cfg, m.runner)
}

// updateInboxKey is the inbox view's own key map: a cursor over rows, the
// answer verb on the selected decision, the browser on any row, and the
// three ways out. Nothing here mutates the board except through the same
// ModeAnswer input the card's `a` uses.
func updateInboxKey(m Model, key string) (Model, tea.Cmd) {
	switch key {
	case "esc", "q", "i":
		m.mode = ModeBrowse
		m.inboxReturn = false
	case "j", "down":
		m.inboxRow++
		m.clampInboxRow()
	case "k", "up":
		m.inboxRow--
		m.clampInboxRow()
	case "a", "enter":
		card, ok := m.selectedInboxCard()
		if !ok {
			m.say(statusNudge, "inbox: no row selected")
			return m, nil
		}
		next, cmd := verbAnswerCard(m, card)
		if next.mode == ModeAnswer {
			next.inboxReturn = true
		}
		return next, cmd
	case "g":
		card, ok := m.selectedInboxCard()
		if !ok {
			m.say(statusNudge, "inbox: no row selected")
			return m, nil
		}
		return m, openBrowserCmd(card)
	}
	return m, nil
}

// updateInputKey handles the reply/answer input line. While a send is in
// flight the buffer is frozen — the result decides whether it clears.
func updateInputKey(m Model, msg tea.KeyMsg) (Model, tea.Cmd) {
	if m.sending {
		return m, nil
	}
	switch msg.String() {
	case "esc":
		// Leave the mode but KEEP the text — esc must never destroy typing.
		m.mode = m.answerReturnMode()
		return m, nil
	case "enter":
		text := strings.TrimSpace(m.input)
		if text == "" {
			m.inputErr = "empty — nothing sent"
			return m, nil
		}
		m.sending = true
		m.inputErr = ""
		if m.mode == ModeAnswer {
			agent := ""
			if a, ok := m.agentFor(m.inputFor); ok && m.herdrOK {
				agent = a.Name
			}
			return m, answerCmd(m.cfg, m.runner, m.inputFor, text, agent)
		}
		return m, replyCmd(m.cfg, m.runner, m.inputWho, text)
	case "backspace":
		if len(m.input) > 0 {
			runes := []rune(m.input)
			m.input = string(runes[:len(runes)-1])
		}
		return m, nil
	case "ctrl+u":
		m.input = ""
		return m, nil
	}
	switch msg.Type {
	case tea.KeyRunes:
		m.input += string(msg.Runes)
	case tea.KeySpace:
		m.input += " "
	}
	return m, nil
}

// ── browse verbs ────────────────────────────────────────────────────────────

// ── verb predicates ─────────────────────────────────────────────────────────
//
// Each verb's refusal is ONE function that the verb runs and the legend
// reads (spec §9): a verb the legend lists is a verb that would proceed, by
// construction — there is no second predicate to drift. kind == statusNone
// means the verb may proceed; otherwise the pair is the status line verbatim.

func refuseObserve(m Model, card Card) (statusKind, string) {
	if !m.herdrOK {
		return statusRefuse, fmt.Sprintf("%s — by hand: board get %d", noMuxBanner, card.Number)
	}
	if _, ok := m.agentFor(card.Number); !ok {
		return statusNudge, fmt.Sprintf("no live agent for #%d — s spawns one", card.Number)
	}
	return statusNone, ""
}

func refusePeek(m Model, card Card) (statusKind, string) {
	if !m.herdrOK {
		return statusRefuse, fmt.Sprintf("%s — by hand: board get %d", noMuxBanner, card.Number)
	}
	if _, ok := m.agentFor(card.Number); !ok {
		return statusNudge, fmt.Sprintf("no live agent for #%d — nothing to peek", card.Number)
	}
	return statusNone, ""
}

func refuseReply(m Model, card Card) (statusKind, string) {
	if !m.herdrOK {
		return statusRefuse, fmt.Sprintf("%s — by hand: herdr agent prompt w%d-… \"…\"", noMuxBanner, card.Number)
	}
	if _, ok := m.agentFor(card.Number); !ok {
		return statusNudge, fmt.Sprintf("no live agent for #%d — a answers the board, s spawns", card.Number)
	}
	return statusNone, ""
}

// refuseAnswer: two shapes qualify — a Human Needed card, and an inbox
// DECISION row, which IS a Human Needed item seen through the queue (the
// CHEATSHEET's "a answers it in place"; the card carries inboxState, so a
// state-only test refused exactly the row it promised). Every other inbox
// row has a disposition verb that is not `answer`, and the cockpit names it
// rather than running it: it is a viewer.
func refuseAnswer(card Card) (statusKind, string) {
	switch {
	case card.State == "Human Needed":
	case card.State == inboxState && card.Queue == "decision":
	case card.State == inboxState:
		return statusRefuse, fmt.Sprintf("#%d is an inbox %s, not a decision — dispose it by hand: %s", card.Number, card.Queue, card.Verb)
	default:
		return statusRefuse, fmt.Sprintf("#%d is %q — a answers Human Needed cards", card.Number, card.State)
	}
	return statusNone, ""
}

// refuseEpic: `e` needs a parent to open. A Done card's parent is not read
// by the closed window, so it is named as such rather than as parentless.
func refuseEpic(card Card) (statusKind, string) {
	if card.ParentNumber != 0 {
		return statusNone, ""
	}
	if card.State == doneState {
		return statusRefuse, fmt.Sprintf("#%d is closed — the Done window does not carry its parent; g opens it", card.Number)
	}
	return statusRefuse, fmt.Sprintf("#%d has no parent — e opens the epic a card belongs to", card.Number)
}

func refuseSpawn(m Model, card Card) (statusKind, string) {
	if card.State == doneState {
		// A Done card is a closed issue from the window read, not work. The
		// spawn path would take a claim on it; refuse here so the reason is
		// legible instead of arriving as a board refusal two layers down.
		return statusRefuse, fmt.Sprintf("#%d is closed (%s) — nothing to spawn; D returns to Human Needed", card.Number, m.doneTitle())
	}
	if card.State == inboxState {
		// An inbox row is a decision waiting on the HUMAN — spawning a worker
		// at it inverts the queue's whole point (and the claim would be
		// refused by the machine anyway: Intake is unclaimable, Human Needed
		// is a pause). The row's own verb is the way out.
		return statusRefuse, fmt.Sprintf("#%d is an inbox %s — dispose it: %s", card.Number, card.Queue, card.Verb)
	}
	if !m.herdrOK {
		return statusRefuse, fmt.Sprintf("%s — by hand: /ralph:work %d in a session", noMuxBanner, card.Number)
	}
	return statusNone, ""
}

// refuseFork (GH-1957): the row is an ISSUE, so the fork source is only
// unambiguous when the issue has exactly one live agent: two agents get a
// named refusal rather than a silent pick, since the pane actions
// (fork-right/down/tab) already say "beside THIS pane" and are the right
// surface for that case.
func refuseFork(m Model, card Card) (statusKind, string) {
	if !m.herdrOK {
		return statusRefuse, noMuxBanner + " — a fork needs a live pane to fork from"
	}
	as := m.agents[card.Number]
	switch {
	case len(as) == 0:
		return statusNudge, fmt.Sprintf("no live session for #%d — nothing to fork (s spawns one)", card.Number)
	case len(as) > 1:
		names := make([]string, 0, len(as))
		for _, a := range as {
			names = append(names, a.Name)
		}
		return statusRefuse, fmt.Sprintf("#%d has %d live sessions (%s) — fork from the pane itself (herdr's fork-right/down/tab actions)",
			card.Number, len(as), strings.Join(names, ", "))
	}
	if as[0].Pane == "" {
		return statusRefuse, fmt.Sprintf("herdr reports no pane for %s — nothing to fork", as[0].Name)
	}
	return statusNone, ""
}

// ── verbs ───────────────────────────────────────────────────────────────────

func verbObserve(m Model) (Model, tea.Cmd) {
	card, ok := m.selectedCard()
	if !ok {
		m.say(statusNudge, "no card selected")
		return m, nil
	}
	return verbObserveCard(m, card)
}

// verbObserveCard is observe on a named card — the board's selection or an
// epic child (GH-2381); the refusal is the same either way.
func verbObserveCard(m Model, card Card) (Model, tea.Cmd) {
	if kind, why := refuseObserve(m, card); kind != statusNone {
		m.say(kind, why)
		return m, nil
	}
	agent, _ := m.agentFor(card.Number)
	return m, focusCmd(m.cfg, m.runner, agent.Name)
}

func verbPeek(m Model) (Model, tea.Cmd) {
	card, ok := m.selectedCard()
	if !ok {
		m.say(statusNudge, "no card selected")
		return m, nil
	}
	return verbPeekCard(m, card)
}

func verbPeekCard(m Model, card Card) (Model, tea.Cmd) {
	if kind, why := refusePeek(m, card); kind != statusNone {
		m.say(kind, why)
		return m, nil
	}
	agent, _ := m.agentFor(card.Number)
	m.say(statusFlight, fmt.Sprintf("reading %s…", agent.Name))
	return m, peekCmd(m.cfg, m.runner, agent.Name)
}

func verbReply(m Model) (Model, tea.Cmd) {
	card, ok := m.selectedCard()
	if !ok {
		m.say(statusNudge, "no card selected")
		return m, nil
	}
	if kind, why := refuseReply(m, card); kind != statusNone {
		m.say(kind, why)
		return m, nil
	}
	agent, _ := m.agentFor(card.Number)
	// Fresh target resets a stale buffer; same target keeps preserved text.
	if m.inputFor != card.Number || m.inputWho != agent.Name {
		m.input = ""
	}
	m.mode = ModeReply
	m.inputFor = card.Number
	m.inputWho = agent.Name
	m.inputErr = ""
	return m, nil
}

func verbAnswer(m Model) (Model, tea.Cmd) {
	card, ok := m.selectedCard()
	if !ok {
		m.say(statusNudge, "no card selected")
		return m, nil
	}
	m.inboxReturn = false
	return verbAnswerCard(m, card)
}

// verbAnswerCard opens the answer input on one card (refuseAnswer says which).
func verbAnswerCard(m Model, card Card) (Model, tea.Cmd) {
	if kind, why := refuseAnswer(card); kind != statusNone {
		m.say(kind, why)
		return m, nil
	}
	if m.inputFor != card.Number || m.inputWho != "" {
		m.input = ""
	}
	m.mode = ModeAnswer
	m.inputFor = card.Number
	m.inputWho = ""
	m.inputErr = ""
	return m, nil
}

// answerReturnMode is where the answer input hands back to: the inbox view
// when the answer was launched from it, browse otherwise.
func (m Model) answerReturnMode() Mode {
	if m.inboxReturn {
		return ModeInbox
	}
	return ModeBrowse
}

// inboxRefreshAfterAnswer re-reads the inbox after an answer landed from the
// view, so the row the human just disposed does not sit there looking
// pending. nil when the view is not up — the column's own cadence covers it.
//
// A read already in flight is NOT sufficient: it started before the answer
// landed, so its result still shows the row as pending. It is marked as owed
// instead, and the inboxMsg handler pays it when that read returns.
func (m *Model) inboxRefreshAfterAnswer() tea.Cmd {
	if !m.inboxViewUp() {
		return nil
	}
	if m.inboxInFlight {
		m.inboxRereadWanted = true
		return nil
	}
	m.inboxInFlight = true
	return fetchInboxCmd(m.cfg, m.runner)
}

func verbSpawn(m Model) (Model, tea.Cmd) {
	card, ok := m.selectedCard()
	if !ok {
		m.say(statusNudge, "no card selected")
		return m, nil
	}
	if kind, why := refuseSpawn(m, card); kind != statusNone {
		m.say(kind, why)
		return m, nil
	}
	m.say(statusFlight, fmt.Sprintf("spawning a work session for #%d…", card.Number))
	return m, spawnCmd(m.cfg, m.runner, card.Number)
}

// verbFork forks the selected issue's live session (refuseFork says when).
func verbFork(m Model) (Model, tea.Cmd) {
	card, ok := m.selectedCard()
	if !ok {
		m.say(statusNudge, "no card selected")
		return m, nil
	}
	if kind, why := refuseFork(m, card); kind != statusNone {
		m.say(kind, why)
		return m, nil
	}
	as := m.agents[card.Number]
	m.say(statusFlight, fmt.Sprintf("forking %s…", as[0].Name))
	return m, forkCmd(m.cfg, m.runner, card.Number, as[0].Pane)
}

// ── mouse ───────────────────────────────────────────────────────────────────

const doubleClickWindow = 400 * time.Millisecond

// updateMouse: click selects the card under the pointer; a second click on
// the same card inside the double-click window observes it.
func updateMouse(m Model, msg tea.MouseMsg) (Model, tea.Cmd) {
	if m.mode != ModeBrowse {
		return m, nil
	}
	if msg.Action != tea.MouseActionPress || msg.Button != tea.MouseButtonLeft {
		return m, nil
	}
	col, row, ok := hitTest(m, msg.X, msg.Y)
	if !ok {
		return m, nil
	}
	now := time.Now()
	double := col == m.lastClickCol && row == m.lastClickRow &&
		now.Sub(m.lastClickAt) <= doubleClickWindow
	m.lastClickAt = now
	m.lastClickCol, m.lastClickRow = col, row
	m.col, m.row = col, row
	m.clampCursor()
	if double {
		return verbObserve(m)
	}
	return m, nil
}
