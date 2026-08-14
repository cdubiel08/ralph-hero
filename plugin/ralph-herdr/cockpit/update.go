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
		return m, nil

	case agentsMsg:
		m.herdrOK = msg.herdrOK
		m.agents = setAgents(msg.agents)
		// The writers are visible here, one free local read ahead of their board
		// writes: a session appearing (it is about to claim), going blocked (it
		// moved the item to Human Needed), or leaving. Snap, don't wait.
		if sig := agentSignature(m.agents); sig != m.agentSig {
			m.agentSig = sig
			m.snapToFloor()
		}
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
	if !m.herdrOK {
		m.status = fmt.Sprintf("%s — by hand: /ralph:work %d in a session", noMuxBanner, card.Number)
		return m, nil
	}
	m.status = fmt.Sprintf("spawning a work session for #%d…", card.Number)
	return m, spawnCmd(m.cfg, m.runner, card.Number)
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
