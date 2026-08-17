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
	return tea.Batch(
		fetchBoardCmd(m.cfg, m.runner),
		fetchAgentsCmd(m.cfg, m.runner),
		tea.Tick(m.cfg.Interval, func(t time.Time) tea.Msg { return tickMsg(t) }),
	)
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
		return m, tea.Batch(cmds...)

	case boardMsg:
		m.pollInFlight = false
		m.lastPoll = time.Now()
		m.boardErr = msg.err
		// Per-column merge: a FAILED column read keeps its last good cards
		// (a failed read and an empty column are different facts — matching
		// fetch.go's "reports as an error, never as empty" and the fzf
		// rung's whole-render refusal); a successful read replaces, empty
		// included.
		for i := range msg.cols {
			if !msg.failed[i] {
				m.cols[i] = msg.cols[i]
			}
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
		if m.signalsDue(time.Now()) {
			m.signalsInFlight = true
			return m, fetchSignalsCmd(m.cfg, m.runner)
		}
		return m, nil

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
		m.doneCards = msg.cards
		if msg.windowDays > 0 {
			m.doneWindowDays = msg.windowDays
		}
		// The Done list just changed length under a cursor that may be parked
		// past its end — the same clamp the `D` swap itself performs.
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
		if targets := m.diffTargets(); len(targets) > 0 {
			return m, fetchDiffsCmd(m.runner, targets)
		}
		return m, nil

	case diffsMsg:
		// REPLACE, never merge: a stale entry for an agent that has since
		// exited would keep drawing a diff for a worktree nobody is in.
		m.diffs = msg.diffs
		return m, nil

	case peekMsg:
		if m.mode != ModeBrowse {
			// A slow peek landing after the user moved on (started a reply,
			// opened another overlay) must never hijack the mode — typed
			// keystrokes would leak into overlay/browse verb handling.
			return m, nil
		}
		if msg.err != "" {
			m.status = fmt.Sprintf("peek %s failed: %s", msg.who, msg.err)
			return m, nil
		}
		m.mode = ModePeek
		m.peekWho = msg.who
		m.peekText = msg.text
		return m, nil

	case dagMsg:
		if m.mode != ModeBrowse {
			return m, nil // stale result — same never-hijack rule as peekMsg
		}
		if msg.err != "" {
			m.status = "frontier read failed: " + msg.err
			return m, nil
		}
		m.mode = ModeDag
		m.dagText = msg.text
		return m, nil

	case replyDoneMsg:
		m.sending = false
		if msg.ok {
			// The delivered checkmark — ONLY here, on herdr's rc 0.
			m.mode = ModeBrowse
			m.input = ""
			m.inputErr = ""
			m.status = fmt.Sprintf("✓ delivered to %s", msg.who)
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
				m.mode = ModeBrowse
				m.input = ""
				m.inputErr = ""
				m.status = fmt.Sprintf("#%d: the Answer comment IS on the record — only the move failed; retry the MOVE (board claim %d), never re-answer", msg.issue, msg.issue)
				return m, nil
			}
			// The durable half failed — preserve the answer text for retry.
			// Hedged: an unlabeled crash could still land after the comment,
			// so the coaching names the check before the re-send.
			m.mode = ModeAnswer
			m.inputErr = fmt.Sprintf("board answer failed: %s — text preserved, ⏎ retries (if the Answer comment already posted, esc and retry the move: board claim %d)", msg.boardDetail, msg.issue)
			return m, nil
		}
		m.mode = ModeBrowse
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
		m.status = board + " · " + agent
		// The item just moved Human Needed → In Progress: re-poll now. Our own
		// write, so the cadence returns to the floor too — more is coming.
		m.pollInFlight = true
		m.snapToFloor()
		return m, fetchBoardCmd(m.cfg, m.runner)

	case spawnDoneMsg:
		switch msg.rc {
		case 0:
			// A spawned session claims the issue within seconds — a board write
			// we caused. Be at the floor when it lands.
			m.snapToFloor()
			m.status = fmt.Sprintf("spawn #%d: %s", msg.issue, msg.detail)
		case 2:
			m.status = fmt.Sprintf("spawn #%d skipped — %s", msg.issue, msg.detail)
		default:
			m.status = fmt.Sprintf("spawn #%d failed (rc %d): %s", msg.issue, msg.rc, msg.detail)
		}
		return m, fetchAgentsCmd(m.cfg, m.runner)

	case forkDoneMsg:
		if msg.rc == 0 {
			m.status = fmt.Sprintf("fork #%d: %s", msg.issue, msg.detail)
		} else {
			m.status = fmt.Sprintf("fork #%d failed (rc %d): %s", msg.issue, msg.rc, msg.detail)
		}
		return m, fetchAgentsCmd(m.cfg, m.runner)

	case statusMsg:
		m.status = string(msg)
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
			m.mode = ModeBrowse
			m.peekText = ""
		}
		return m, nil

	case ModeDag:
		switch key {
		case "esc", "q", "v":
			m.mode = ModeBrowse
		}
		return m, nil
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
		m.status = "reading frontier…"
		return m, dagCmd(m.cfg, m.runner)

	case "d":
		card, ok := m.selectedCard()
		if !ok {
			m.status = "no card selected"
			return m, nil
		}
		m.status = fmt.Sprintf("looking up #%d's PR…", card.Number)
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
		if m.col == 2 {
			m.row = 0
		}
		m.clampCursor()
		if !m.showDone {
			m.status = "third column: Human Needed"
			return m, nil
		}
		// Fetch NOW rather than at the next tick: `D` is the whole signal that
		// anyone wants this column, and waiting up to SignalInterval to fill it
		// would make the key feel broken. Subsequent refreshes ride the second
		// cadence while the column stays up.
		m.status = m.doneTitle() + " — a WINDOW, not all history; D returns to Human Needed"
		if m.doneInFlight || !m.lastDone.IsZero() {
			return m, nil
		}
		m.doneInFlight = true
		return m, fetchDoneCmd(m.cfg, m.runner)

	case "g":
		card, ok := m.selectedCard()
		if !ok {
			m.status = "no card selected"
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
		m.mode = ModeBrowse
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

func verbObserve(m Model) (Model, tea.Cmd) {
	card, ok := m.selectedCard()
	if !ok {
		m.status = "no card selected"
		return m, nil
	}
	if !m.herdrOK {
		m.status = fmt.Sprintf("%s — by hand: board get %d", noMuxBanner, card.Number)
		return m, nil
	}
	agent, ok := m.agentFor(card.Number)
	if !ok {
		m.status = fmt.Sprintf("no live agent for #%d — s spawns one", card.Number)
		return m, nil
	}
	return m, focusCmd(m.cfg, m.runner, agent.Name)
}

func verbPeek(m Model) (Model, tea.Cmd) {
	card, ok := m.selectedCard()
	if !ok {
		m.status = "no card selected"
		return m, nil
	}
	if !m.herdrOK {
		m.status = fmt.Sprintf("%s — by hand: board get %d", noMuxBanner, card.Number)
		return m, nil
	}
	agent, ok := m.agentFor(card.Number)
	if !ok {
		m.status = fmt.Sprintf("no live agent for #%d — nothing to peek", card.Number)
		return m, nil
	}
	m.status = fmt.Sprintf("reading %s…", agent.Name)
	return m, peekCmd(m.cfg, m.runner, agent.Name)
}

func verbReply(m Model) (Model, tea.Cmd) {
	card, ok := m.selectedCard()
	if !ok {
		m.status = "no card selected"
		return m, nil
	}
	if !m.herdrOK {
		m.status = fmt.Sprintf("%s — by hand: herdr agent prompt w%d-… \"…\"", noMuxBanner, card.Number)
		return m, nil
	}
	agent, ok := m.agentFor(card.Number)
	if !ok {
		m.status = fmt.Sprintf("no live agent for #%d — a answers the board, s spawns", card.Number)
		return m, nil
	}
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
		m.status = "no card selected"
		return m, nil
	}
	if card.State != "Human Needed" {
		m.status = fmt.Sprintf("#%d is %q — a answers Human Needed cards", card.Number, card.State)
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

func verbSpawn(m Model) (Model, tea.Cmd) {
	card, ok := m.selectedCard()
	if !ok {
		m.status = "no card selected"
		return m, nil
	}
	if card.State == doneState {
		// A Done card is a closed issue from the window read, not work. The
		// spawn path would take a claim on it; refuse here so the reason is
		// legible instead of arriving as a board refusal two layers down.
		m.status = fmt.Sprintf("#%d is closed (%s) — nothing to spawn; D returns to Human Needed", card.Number, m.doneTitle())
		return m, nil
	}
	if !m.herdrOK {
		m.status = fmt.Sprintf("%s — by hand: /ralph:work %d in a session", noMuxBanner, card.Number)
		return m, nil
	}
	m.status = fmt.Sprintf("spawning a work session for #%d…", card.Number)
	return m, spawnCmd(m.cfg, m.runner, card.Number)
}

// verbFork forks the selected issue's live session (GH-1957). The row is an
// ISSUE, so the fork source is only unambiguous when the issue has exactly one
// live agent: two agents get a named refusal rather than a silent pick, since
// the pane actions (fork-right/down/tab) already say "beside THIS pane" and
// are the right surface for that case.
func verbFork(m Model) (Model, tea.Cmd) {
	card, ok := m.selectedCard()
	if !ok {
		m.status = "no card selected"
		return m, nil
	}
	if !m.herdrOK {
		m.status = noMuxBanner + " — a fork needs a live pane to fork from"
		return m, nil
	}
	as := m.agents[card.Number]
	switch {
	case len(as) == 0:
		m.status = fmt.Sprintf("no live session for #%d — nothing to fork (s spawns one)", card.Number)
		return m, nil
	case len(as) > 1:
		names := make([]string, 0, len(as))
		for _, a := range as {
			names = append(names, a.Name)
		}
		m.status = fmt.Sprintf("#%d has %d live sessions (%s) — fork from the pane itself (herdr's fork-right/down/tab actions)",
			card.Number, len(as), strings.Join(names, ", "))
		return m, nil
	}
	if as[0].Pane == "" {
		m.status = fmt.Sprintf("herdr reports no pane for %s — nothing to fork", as[0].Name)
		return m, nil
	}
	m.status = fmt.Sprintf("forking %s…", as[0].Name)
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
