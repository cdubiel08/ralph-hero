// update_test.go — table-driven tests for the pure update loop: navigation
// bounds, mode transitions, the preserve-on-failure reply contract, and the
// comment-first answer ordering (board recorded BEFORE herdr, via the fake
// runner's invocation log).
package main

import (
	"errors"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func keyMsg(s string) tea.KeyMsg {
	switch s {
	case "enter":
		return tea.KeyMsg{Type: tea.KeyEnter}
	case "esc":
		return tea.KeyMsg{Type: tea.KeyEsc}
	case "space":
		return tea.KeyMsg{Type: tea.KeySpace, Runes: []rune{' '}}
	case "backspace":
		return tea.KeyMsg{Type: tea.KeyBackspace}
	case "ctrl+u":
		return tea.KeyMsg{Type: tea.KeyCtrlU}
	case "ctrl+c":
		return tea.KeyMsg{Type: tea.KeyCtrlC}
	case "up":
		return tea.KeyMsg{Type: tea.KeyUp}
	case "down":
		return tea.KeyMsg{Type: tea.KeyDown}
	case "left":
		return tea.KeyMsg{Type: tea.KeyLeft}
	case "right":
		return tea.KeyMsg{Type: tea.KeyRight}
	default:
		return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)}
	}
}

func card(n int, state, title string) Card {
	return Card{Number: n, Repo: "o/r", Title: title, State: state}
}

// testModel: 3 In Progress, 1 In Review, 2 Human Needed; herdr present with
// a live agent on #10 and a blocked one on #30.
func testModel(f *fakeRunner) Model {
	m := newModel(Config{
		Board: "BOARD", Herdr: "HERDR", Gh: "", Repo: "/tmp/repo",
		ScriptsDir: "/plug/scripts", Interval: 30 * time.Second,
		MaxInterval: 300 * time.Second, SignalInterval: 120 * time.Second,
	}, f)
	m.width, m.height = 120, 40
	m.cols = [3][]Card{
		{card(10, "In Progress", "Ten"), card(11, "In Progress", "Eleven"), card(12, "In Progress", "Twelve")},
		{card(20, "In Review", "Twenty")},
		{card(30, "Human Needed", "Thirty"), card(31, "Human Needed", "ThirtyOne")},
	}
	m.agents = setAgents([]Agent{
		{Name: "w10-ten", Status: "working", Pane: "p1", Issue: 10, Lane: "w"},
		{Name: "w30-thirty", Status: "blocked", Pane: "p2", Issue: 30, Lane: "w"},
	})
	return m
}

func TestNavigationBounds(t *testing.T) {
	tests := []struct {
		name               string
		startCol, startRow int
		keys               []string
		wantCol, wantRow   int
	}{
		{"h at col 0 stays", 0, 0, []string{"h"}, 0, 0},
		{"left arrow at col 0 stays", 0, 0, []string{"left"}, 0, 0},
		{"l walks right and clamps at 2", 0, 0, []string{"l", "l", "l", "l"}, 2, 0},
		{"right arrow clamps at 2", 2, 0, []string{"right"}, 2, 0},
		{"j walks down and clamps at last card", 0, 0, []string{"j", "j", "j", "j", "j"}, 0, 2},
		{"k at row 0 stays", 0, 0, []string{"k"}, 0, 0},
		{"down/up arrows mirror j/k", 0, 0, []string{"down", "down", "up"}, 0, 1},
		{"column switch clamps the row to the shorter column", 0, 2, []string{"l"}, 1, 0},
		{"switch into Human Needed keeps a legal row", 0, 2, []string{"l", "l"}, 2, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := testModel(&fakeRunner{})
			m.col, m.row = tt.startCol, tt.startRow
			for _, k := range tt.keys {
				m, _ = updateModel(m, keyMsg(k))
			}
			if m.col != tt.wantCol || m.row != tt.wantRow {
				t.Errorf("cursor = (%d,%d), want (%d,%d)", m.col, m.row, tt.wantCol, tt.wantRow)
			}
		})
	}
}

func TestModeTransitions(t *testing.T) {
	tests := []struct {
		name  string
		setup func(Model) Model
		msg   tea.Msg
		want  Mode
		check func(*testing.T, Model)
	}{
		{"peekMsg opens the peek overlay", nil,
			peekMsg{who: "w10-ten", text: "tail"}, ModePeek, nil},
		{"esc closes peek", func(m Model) Model { m.mode = ModePeek; return m },
			keyMsg("esc"), ModeBrowse, nil},
		{"space closes peek too", func(m Model) Model { m.mode = ModePeek; return m },
			keyMsg("space"), ModeBrowse, nil},
		{"dagMsg opens the DAG overlay", nil,
			dagMsg{text: "FRONTIER"}, ModeDag, nil},
		{"a stale peekMsg never hijacks reply typing", func(m Model) Model {
			m.mode = ModeReply
			m.input = "half a typed sentence"
			return m
		}, peekMsg{who: "w10-ten", text: "tail"}, ModeReply,
			func(t *testing.T, m Model) {
				if m.input != "half a typed sentence" {
					t.Errorf("input = %q", m.input)
				}
			}},
		{"a stale dagMsg never hijacks answer typing", func(m Model) Model {
			m.mode = ModeAnswer
			m.input = "the decision so far"
			return m
		}, dagMsg{text: "FRONTIER"}, ModeAnswer,
			func(t *testing.T, m Model) {
				if m.input != "the decision so far" {
					t.Errorf("input = %q", m.input)
				}
			}},
		{"a stale dagMsg never replaces an open peek overlay", func(m Model) Model {
			m.mode = ModePeek
			m.peekText = "tail"
			return m
		}, dagMsg{text: "FRONTIER"}, ModePeek, nil},
		{"v closes the DAG overlay", func(m Model) Model { m.mode = ModeDag; return m },
			keyMsg("v"), ModeBrowse, nil},
		{"r on a card with a live agent enters reply", nil,
			keyMsg("r"), ModeReply,
			func(t *testing.T, m Model) {
				if m.inputWho != "w10-ten" || m.inputFor != 10 {
					t.Errorf("reply target = %q/#%d", m.inputWho, m.inputFor)
				}
			}},
		{"r without a live agent stays browse with a hint", func(m Model) Model { m.row = 1; return m },
			keyMsg("r"), ModeBrowse,
			func(t *testing.T, m Model) {
				if !strings.Contains(m.status, "no live agent for #11") {
					t.Errorf("status = %q", m.status)
				}
			}},
		{"a on a Human Needed card enters answer", func(m Model) Model { m.col, m.row = 2, 0; return m },
			keyMsg("a"), ModeAnswer,
			func(t *testing.T, m Model) {
				if m.inputFor != 30 {
					t.Errorf("answer target = #%d", m.inputFor)
				}
			}},
		{"a elsewhere is refused with the column named", nil,
			keyMsg("a"), ModeBrowse,
			func(t *testing.T, m Model) {
				if !strings.Contains(m.status, "Human Needed") {
					t.Errorf("status = %q", m.status)
				}
			}},
		{"esc leaves reply but keeps the text", func(m Model) Model {
			m.mode = ModeReply
			m.input = "typed so far"
			return m
		}, keyMsg("esc"), ModeBrowse,
			func(t *testing.T, m Model) {
				if m.input != "typed so far" {
					t.Errorf("esc destroyed typing: %q", m.input)
				}
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := testModel(&fakeRunner{})
			if tt.setup != nil {
				m = tt.setup(m)
			}
			m, _ = updateModel(m, tt.msg)
			if m.mode != tt.want {
				t.Errorf("mode = %v, want %v", m.mode, tt.want)
			}
			if tt.check != nil {
				tt.check(t, m)
			}
		})
	}
}

func TestDegradedVerbsWithoutHerdr(t *testing.T) {
	// Absent herdr: observe/peek/reply/spawn print the board/gh equivalent
	// hint; a (answer), g, v stay full verbs. Chrome lost, verbs kept.
	for _, k := range []string{"enter", "space", "r", "s"} {
		t.Run(k, func(t *testing.T) {
			m := testModel(&fakeRunner{})
			m.herdrOK = false
			m2, cmd := updateModel(m, keyMsg(k))
			if m2.mode != ModeBrowse {
				t.Errorf("degraded %q must stay browse, got %v", k, m2.mode)
			}
			if cmd != nil {
				t.Errorf("degraded %q must not exec anything", k)
			}
			if !strings.Contains(m2.status, "no multiplexer") {
				t.Errorf("degraded %q status = %q", k, m2.status)
			}
		})
	}
	t.Run("a still opens the answer input", func(t *testing.T) {
		m := testModel(&fakeRunner{})
		m.herdrOK = false
		m.col, m.row = 2, 0
		m2, _ := updateModel(m, keyMsg("a"))
		if m2.mode != ModeAnswer {
			t.Errorf("answer must survive herdr loss, mode = %v", m2.mode)
		}
	})
	t.Run("v still reads the frontier", func(t *testing.T) {
		m := testModel(&fakeRunner{})
		m.herdrOK = false
		_, cmd := updateModel(m, keyMsg("v"))
		if cmd == nil {
			t.Error("v must survive herdr loss")
		}
	})
}

func TestReplyPreservedOnFailure(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.mode = ModeReply
	m.inputFor, m.inputWho = 10, "w10-ten"
	m.input = "please rebase onto main first"
	m.sending = true

	m, _ = updateModel(m, replyDoneMsg{who: "w10-ten", ok: false, detail: "agent_prompt_stalled"})
	if m.mode != ModeReply {
		t.Errorf("failure must return to the input, mode = %v", m.mode)
	}
	if m.input != "please rebase onto main first" {
		t.Errorf("typed text lost on failure: %q", m.input)
	}
	if !strings.Contains(m.inputErr, "agent_prompt_stalled") || !strings.Contains(m.inputErr, "preserved") {
		t.Errorf("inputErr = %q", m.inputErr)
	}
	if m.sending {
		t.Error("sending flag must clear so the retry can go out")
	}

	// Success: ONLY here does the delivered checkmark appear.
	m.sending = true
	m, _ = updateModel(m, replyDoneMsg{who: "w10-ten", ok: true})
	if m.mode != ModeBrowse || m.input != "" {
		t.Errorf("delivery must clear the input, mode=%v input=%q", m.mode, m.input)
	}
	if !strings.Contains(m.status, "✓ delivered to w10-ten") {
		t.Errorf("status = %q", m.status)
	}
}

func TestNoOptimisticCheckmarkWhileSending(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.mode = ModeReply
	m.inputFor, m.inputWho = 10, "w10-ten"
	m.input = "hello"
	m, cmd := updateModel(m, keyMsg("enter"))
	if cmd == nil {
		t.Fatal("enter must dispatch the reply")
	}
	if !m.sending {
		t.Fatal("sending must be marked in-flight")
	}
	if strings.Contains(m.status, "✓") || strings.Contains(viewModel(m), "✓ delivered") {
		t.Error("no delivered checkmark before herdr confirms")
	}
}

func TestAnswerOrderingBoardFirst(t *testing.T) {
	f := &fakeRunner{}
	m := testModel(f)
	m.mode = ModeAnswer
	m.inputFor, m.inputWho = 30, ""
	m.input = "Use Postgres; sqlite only for the tests"

	_, cmd := updateModel(m, keyMsg("enter"))
	if cmd == nil {
		t.Fatal("enter must dispatch the answer")
	}
	msg := cmd() // runs doAnswer synchronously against the fake runner
	done, ok := msg.(answerDoneMsg)
	if !ok {
		t.Fatalf("got %T", msg)
	}
	if len(f.calls) != 2 {
		t.Fatalf("want board answer + herdr nudge, got %d calls: %+v", len(f.calls), f.calls)
	}
	// THE ordering assertion: the durable board verb is recorded FIRST.
	if f.calls[0].prog != "BOARD" || f.calls[0].args[0] != "answer" {
		t.Errorf("call 0 must be `board answer`, got %s %v", f.calls[0].prog, f.calls[0].args)
	}
	if f.calls[0].args[1] != "30" || f.calls[0].args[3] != "Use Postgres; sqlite only for the tests" {
		t.Errorf("board answer argv = %v", f.calls[0].args)
	}
	if f.calls[1].prog != "HERDR" || f.calls[1].args[1] != "prompt" || f.calls[1].args[2] != "w30-thirty" {
		t.Errorf("call 1 must be the herdr nudge, got %s %v", f.calls[1].prog, f.calls[1].args)
	}
	if !done.boardOK || !done.agentTried || !done.agentOK {
		t.Errorf("both halves should report success: %+v", done)
	}
}

func TestAnswerBoardFailureSkipsNudgeAndPreservesText(t *testing.T) {
	f := &fakeRunner{respond: func(prog string, args []string) (string, string, error) {
		if prog == "BOARD" {
			return "", "answer refused: not Human Needed", errors.New("exit status 1")
		}
		return "", "", nil
	}}
	m := testModel(f)
	m.mode = ModeAnswer
	m.inputFor = 30
	m.input = "the decision"

	_, cmd := updateModel(m, keyMsg("enter"))
	msg := cmd()
	done := msg.(answerDoneMsg)
	if done.boardOK {
		t.Fatal("board failure must be reported")
	}
	if done.agentTried || len(f.calls) != 1 {
		t.Fatalf("the nudge must NOT go out when the durable half failed: %+v", f.calls)
	}
	// And the update loop preserves the typed answer for the retry.
	m.sending = true
	m, _ = updateModel(m, msg)
	if m.mode != ModeAnswer || m.input != "the decision" {
		t.Errorf("answer text lost on board failure: mode=%v input=%q", m.mode, m.input)
	}
	if !strings.Contains(m.inputErr, "board answer failed") {
		t.Errorf("inputErr = %q", m.inputErr)
	}
}

func TestAnswerMoveFailureAfterDurableCommentNeverCoachesReanswer(t *testing.T) {
	// board.ts answer() posts the **Answer** comment FIRST; a refusal on the
	// subsequent Human Needed → In Progress move exits nonzero with the
	// on-the-record marker on its SECOND line. Coaching "⏎ retries" there
	// would re-run `board answer` and DUPLICATE the durable comment.
	f := &fakeRunner{respond: func(prog string, args []string) (string, string, error) {
		if prog == "BOARD" {
			return "", "refused: #30 fleet co-holders still on the claim\n" +
					"The answer comment IS on the record — retry the move (`board claim 30`), not the answer.\n",
				errors.New("exit status 2")
		}
		return "", "", nil
	}}
	m := testModel(f)
	m.mode = ModeAnswer
	m.inputFor = 30
	m.input = "the decision"

	_, cmd := updateModel(m, keyMsg("enter"))
	msg := cmd()
	done := msg.(answerDoneMsg)
	if done.boardOK || !done.boardPosted {
		t.Fatalf("a post-comment refusal must read as posted-but-not-moved: %+v", done)
	}
	if done.agentTried || len(f.calls) != 1 {
		t.Fatalf("no nudge when the move failed: %+v", f.calls)
	}
	m.sending = true
	m, _ = updateModel(m, msg)
	if m.mode == ModeAnswer {
		t.Error("must not re-open the answer input — Enter there re-posts the durable comment")
	}
	if m.input != "" {
		t.Errorf("the answer IS on the record; the buffer must clear, got %q", m.input)
	}
	if !strings.Contains(m.status, "board claim 30") || !strings.Contains(m.status, "IS on the record") {
		t.Errorf("status must coach the MOVE retry, got %q", m.status)
	}
	if strings.Contains(m.status, "⏎ retries") {
		t.Errorf("must never coach a re-answer: %q", m.status)
	}
}

func TestAnswerSurfacesBothHalvesDistinctly(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.sending = true
	m, _ = updateModel(m, answerDoneMsg{
		issue: 30, boardOK: true, agentTried: true, agentOK: false,
		agentName: "w30-thirty", agentDetail: "timeout",
	})
	if !strings.Contains(m.status, "board: ✓") || !strings.Contains(m.status, "agent: ✗") {
		t.Errorf("both halves must surface distinctly, status = %q", m.status)
	}
	m2 := testModel(&fakeRunner{})
	m2.sending = true
	m2, _ = updateModel(m2, answerDoneMsg{issue: 30, boardOK: true, agentTried: true, agentOK: true, agentName: "w30-thirty"})
	if !strings.Contains(m2.status, "board: ✓") || !strings.Contains(m2.status, "agent: ✓ nudged w30-thirty") {
		t.Errorf("status = %q", m2.status)
	}
}

func TestInputEditing(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.mode = ModeReply
	m.inputWho, m.inputFor = "w10-ten", 10
	for _, r := range []string{"h", "i", "space", "t", "e", "n"} {
		m, _ = updateModel(m, keyMsg(r))
	}
	if m.input != "hi ten" {
		t.Errorf("typed = %q", m.input)
	}
	m, _ = updateModel(m, keyMsg("backspace"))
	if m.input != "hi te" {
		t.Errorf("backspace = %q", m.input)
	}
	m, _ = updateModel(m, keyMsg("ctrl+u"))
	if m.input != "" {
		t.Errorf("ctrl+u = %q", m.input)
	}
	m, cmd := updateModel(m, keyMsg("enter"))
	if cmd != nil || !strings.Contains(m.inputErr, "empty") {
		t.Error("an empty reply must be refused locally, nothing sent")
	}
}

func TestBoardMsgKeepsLastGoodOnTotalFailure(t *testing.T) {
	m := testModel(&fakeRunner{})
	before := m.cols
	m, _ = updateModel(m, boardMsg{
		failed: [3]bool{true, true, true},
		err:    "In Progress: connect timeout · In Review: connect timeout · Human Needed: connect timeout",
	})
	if len(m.cols[0]) != len(before[0]) {
		t.Error("a failed poll must keep the last good columns — a failed read is not an empty board")
	}
	if m.boardErr == "" {
		t.Error("the failure must be surfaced")
	}
	// A successful empty poll IS an empty board.
	m, _ = updateModel(m, boardMsg{})
	if len(m.cols[0]) != 0 || m.boardErr != "" {
		t.Error("a clean empty poll must replace the columns")
	}
}

func TestBoardMsgPartialFailureKeepsOnlyTheFailedColumn(t *testing.T) {
	// One state's read failing while another returns cards must never render
	// the failed column as "(none)" — per-column, a failed read keeps the
	// last good cards under the error banner.
	//
	// Since GH-1786 one poll is ONE read, so fetchBoardCmd emits all-or-none
	// (TestFetchBoardFailureMarksEveryColumnUnknown). This pins the MERGE
	// contract, which stays per-column deliberately: "which column is stale"
	// remains expressible, and a future partial source needs no update here.
	m := testModel(&fakeRunner{})
	beforeIP := len(m.cols[0])
	m, _ = updateModel(m, boardMsg{
		cols:   [3][]Card{nil, {card(21, "In Review", "Fresh")}, nil},
		failed: [3]bool{true, false, false},
		err:    "In Progress: timeout",
	})
	if len(m.cols[0]) != beforeIP {
		t.Errorf("the FAILED column must keep its last good cards, got %d", len(m.cols[0]))
	}
	if len(m.cols[1]) != 1 || m.cols[1][0].Number != 21 {
		t.Errorf("the successful column must refresh, got %+v", m.cols[1])
	}
	if len(m.cols[2]) != 0 {
		t.Error("a successful EMPTY read is an empty column — it must replace")
	}
	if m.boardErr == "" {
		t.Error("the partial failure must stay surfaced")
	}
}

func TestBoardRefreshClampsCursor(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.col, m.row = 0, 2
	m, _ = updateModel(m, boardMsg{cols: [3][]Card{
		{card(10, "In Progress", "Ten")}, {}, {},
	}})
	if m.row != 0 {
		t.Errorf("cursor must clamp after a shrinking refresh, row = %d", m.row)
	}
}

func TestAgentsMsgTogglesOverlay(t *testing.T) {
	m := testModel(&fakeRunner{})
	m, _ = updateModel(m, agentsMsg{herdrOK: false})
	if m.herdrOK {
		t.Error("overlay must drop when herdr goes away")
	}
	if len(m.agents) != 0 {
		t.Error("stale agents must not decorate cards")
	}
	m, _ = updateModel(m, agentsMsg{herdrOK: true, agents: []Agent{{Name: "w10-ten", Status: "idle", Issue: 10, Lane: "w"}}})
	if !m.herdrOK || len(m.agents[10]) != 1 {
		t.Error("overlay must come back with the read")
	}
}

func TestMouseClickSelectsDoubleClickObserves(t *testing.T) {
	f := &fakeRunner{}
	m := testModel(f)
	// Column 1, row 0 — x in the middle column, y on the first card.
	colW := (m.width-2)/3 + 1
	x := colW + 2
	y := headerRows + colHeaderRows // first card line
	click := tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: x, Y: y}

	m, cmd := updateModel(m, click)
	if m.col != 1 || m.row != 0 {
		t.Fatalf("click selected (%d,%d), want (1,0)", m.col, m.row)
	}
	if cmd != nil {
		t.Fatal("single click must only select")
	}
	m, _ = updateModel(m, click) // second click inside the window = observe
	if !strings.Contains(m.status, "no live agent for #20") {
		t.Errorf("double-click must observe (here: the no-agent hint), status = %q", m.status)
	}
}

func TestTickSchedulesPollAndOverlay(t *testing.T) {
	m := testModel(&fakeRunner{})
	m2, cmd := updateModel(m, tickMsg(time.Now()))
	if cmd == nil {
		t.Fatal("tick must schedule work")
	}
	if !m2.pollInFlight {
		t.Error("tick must mark the board poll in flight")
	}
	m3, _ := updateModel(m2, tickMsg(time.Now()))
	if !m3.pollInFlight {
		t.Error("a second tick must not clear the in-flight guard")
	}
}

// boardOf rebuilds the testModel columns as a successful whole-board read.
func boardOf(m Model) boardMsg { return boardMsg{cols: m.cols} }

// settle drives n unchanged board reads, the way a quiet board does.
func settle(m Model, n int) Model {
	for i := 0; i < n; i++ {
		m, _ = updateModel(m, boardOf(m))
	}
	return m
}

func TestPollBacksOffOnUnchangedBoardAndStopsAtTheCeiling(t *testing.T) {
	m := testModel(&fakeRunner{})
	// First read is a change (cards appear from the seeded empty signature).
	m, _ = updateModel(m, boardOf(m))
	if m.pollEvery != 30*time.Second {
		t.Fatalf("first read must sit at the floor, got %v", m.pollEvery)
	}
	want := []time.Duration{45 * time.Second, 68 * time.Second, 102 * time.Second, 153 * time.Second, 230 * time.Second, 300 * time.Second}
	for i, w := range want {
		m, _ = updateModel(m, boardOf(m))
		if m.pollEvery != w {
			t.Fatalf("unchanged read %d: cadence %v, want %v", i+1, m.pollEvery, w)
		}
	}
	// The ceiling is HARD: no number of unchanged reads may pass it.
	m = settle(m, 50)
	if m.pollEvery != 300*time.Second {
		t.Errorf("cadence %v breached the %v ceiling", m.pollEvery, m.cfg.MaxInterval)
	}
}

func TestPollNeverGoesBelowTheFloor(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.cfg.MaxInterval = 0 // unconfigured ceiling = backoff off, NOT a zero cadence
	m = settle(m, 20)
	if m.pollEvery != m.cfg.Interval {
		t.Errorf("cadence %v, want the floor %v", m.pollEvery, m.cfg.Interval)
	}
}

func TestPollSnapsToFloorOnBoardChange(t *testing.T) {
	m := testModel(&fakeRunner{})
	m = settle(m, 8)
	if m.pollEvery == m.cfg.Interval {
		t.Fatal("precondition: the cadence must have backed off")
	}
	// #11 moves In Progress → In Review: one step back to the floor, not a
	// gradual decrease.
	changed := boardOf(m)
	changed.cols[0] = []Card{card(10, "In Progress", "Ten"), card(12, "In Progress", "Twelve")}
	changed.cols[1] = []Card{card(20, "In Review", "Twenty"), card(11, "In Review", "Eleven")}
	m, _ = updateModel(m, changed)
	if m.pollEvery != m.cfg.Interval {
		t.Errorf("a changed board must snap to the floor, got %v", m.pollEvery)
	}
}

// ── focus as a third cadence input (GH-1876) ────────────────────────────────

func TestBlurJumpsToTheCeilingAndFocusSnapsBack(t *testing.T) {
	m := testModel(&fakeRunner{})
	m, _ = updateModel(m, boardOf(m)) // first read: at the floor
	if m.pollEvery != m.cfg.Interval {
		t.Fatalf("precondition: want the floor, got %v", m.pollEvery)
	}
	m, _ = updateModel(m, tea.BlurMsg{})
	if m.pollEvery != m.cfg.MaxInterval {
		t.Errorf("blur must jump straight to the ceiling %v, got %v", m.cfg.MaxInterval, m.pollEvery)
	}
	m, _ = updateModel(m, tea.FocusMsg{})
	if m.pollEvery != m.cfg.Interval {
		t.Errorf("focus must snap to the floor %v, got %v", m.cfg.Interval, m.pollEvery)
	}
}

// A terminal that reports a blur and never a focus cannot strand the cadence
// past the stated staleness bound, and a keypress recovers it.
func TestBlurIsBoundedByTheCeilingAndRecoverableByAKeypress(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.cfg.MaxInterval = 0 // backoff off: the ceiling collapses to the floor
	m, _ = updateModel(m, tea.BlurMsg{})
	if m.pollEvery != m.cfg.Interval {
		t.Errorf("with backoff off, blur must stay at the floor, got %v", m.pollEvery)
	}

	m = testModel(&fakeRunner{})
	m, _ = updateModel(m, boardOf(m))
	before := m.lastPoll
	m, _ = updateModel(m, tea.BlurMsg{})
	if m.lastPoll != before {
		t.Error("blur must not touch lastPoll — flapping focus would poll below the floor")
	}
	m = settle(m, 5) // no focus event ever arrives
	if m.pollEvery != m.cfg.MaxInterval {
		t.Errorf("stranded cadence %v must be pinned at the ceiling", m.pollEvery)
	}
	m, _ = updateModel(m, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	if m.pollEvery != m.cfg.Interval {
		t.Errorf("a keypress must recover the cadence, got %v", m.pollEvery)
	}
}

func TestQuestionChurnDoesNotPinTheCadence(t *testing.T) {
	m := testModel(&fakeRunner{})
	m = settle(m, 3)
	before := m.pollEvery
	// The Human Needed question line comes from a separate bounded gh read that
	// degrades to empty; flapping it must NOT read as a board change.
	churn := boardOf(m)
	churn.cols[2] = []Card{
		{Number: 30, Repo: "o/r", Title: "Thirty", State: "Human Needed", Question: "pick A or B?"},
		{Number: 31, Repo: "o/r", Title: "ThirtyOne", State: "Human Needed"},
	}
	m, _ = updateModel(m, churn)
	if m.pollEvery <= before {
		t.Errorf("question churn pinned the cadence at %v (was %v)", m.pollEvery, before)
	}
}

func TestFailedBoardReadBacksOff(t *testing.T) {
	m := testModel(&fakeRunner{})
	m, _ = updateModel(m, boardOf(m))
	// A failed read keeps its last good cards, so it is unchanged — and a
	// rate-limited board is exactly what backoff is for.
	m, _ = updateModel(m, boardMsg{failed: allColumnsUnknown, err: "GitHub GraphQL budget exhausted (0/5000)"})
	if m.pollEvery != 45*time.Second {
		t.Errorf("failed read: cadence %v, want 45s", m.pollEvery)
	}
	if len(m.cols[0]) != 3 {
		t.Error("a failed read must keep the last good cards")
	}
}

func TestAgentOverlayChangeSnapsToFloor(t *testing.T) {
	live := []Agent{
		{Name: "w10-ten", Status: "working", Pane: "p1", Issue: 10, Lane: "w"},
		{Name: "w30-thirty", Status: "blocked", Pane: "p2", Issue: 30, Lane: "w"},
	}
	m := testModel(&fakeRunner{})
	m.agentSig = agentSignature(m.agents)
	m = settle(m, 6)
	backedOff := m.pollEvery

	// Identical overlay: no writer news, cadence untouched.
	m, _ = updateModel(m, agentsMsg{herdrOK: true, agents: live})
	if m.pollEvery != backedOff {
		t.Errorf("an unchanged overlay must not move the cadence (%v → %v)", backedOff, m.pollEvery)
	}
	// A session goes working → blocked: it just moved the item to Human Needed.
	moved := []Agent{live[0], {Name: "w30-thirty", Status: "working", Pane: "p2", Issue: 30, Lane: "w"}}
	m, _ = updateModel(m, agentsMsg{herdrOK: true, agents: moved})
	if m.pollEvery != m.cfg.Interval {
		t.Errorf("an overlay change must snap to the floor, got %v", m.pollEvery)
	}
}

func TestBoardPollWaitsForTheCadenceButTheOverlayDoesNot(t *testing.T) {
	m := testModel(&fakeRunner{})
	m = settle(m, 6) // cadence well above the 30s tick
	base := time.Now()
	m.lastPoll = base

	m2, cmd := updateModel(m, tickMsg(base.Add(30*time.Second)))
	if cmd == nil {
		t.Fatal("every tick must still refresh the overlay and re-arm")
	}
	if m2.pollInFlight {
		t.Errorf("board poll fired %v into a %v cadence", 30*time.Second, m.pollEvery)
	}
	m3, _ := updateModel(m, tickMsg(base.Add(m.pollEvery)))
	if !m3.pollInFlight {
		t.Errorf("board poll must fire once the %v cadence elapses", m.pollEvery)
	}
}

func TestInteractionAndOwnWritesSnapToFloor(t *testing.T) {
	tests := []struct {
		name string
		msg  tea.Msg
	}{
		{"keypress", keyMsg("j")},
		{"mouse click", tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: 2, Y: headerRows + colHeaderRows}},
		{"our own answer", answerDoneMsg{issue: 30, boardOK: true}},
		{"our own spawn", spawnDoneMsg{issue: 11, rc: 0, detail: "w11-eleven"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := settle(testModel(&fakeRunner{}), 6)
			if m.pollEvery == m.cfg.Interval {
				t.Fatal("precondition: the cadence must have backed off")
			}
			m, _ = updateModel(m, tt.msg)
			if m.pollEvery != m.cfg.Interval {
				t.Errorf("cadence %v, want the floor %v", m.pollEvery, m.cfg.Interval)
			}
		})
	}
}

func TestSkippedSpawnDoesNotSnap(t *testing.T) {
	// rc 2 = already owned: nothing was started, so nothing is about to write.
	m := settle(testModel(&fakeRunner{}), 6)
	before := m.pollEvery
	m, _ = updateModel(m, spawnDoneMsg{issue: 11, rc: 2, detail: "already owned"})
	if m.pollEvery != before {
		t.Errorf("a skipped spawn moved the cadence %v → %v", before, m.pollEvery)
	}
}

// TestIdleBoardCostsFarFewerWalks is the claim in GH-1805 measured rather than
// asserted: an hour of ticks with nobody working and nobody watching. The
// harness stamps lastPoll itself because boardMsg reads the real clock — the
// simulated hour is the harness's, and every cadence decision under test is
// the model's.
func TestIdleBoardCostsFarFewerWalks(t *testing.T) {
	m := testModel(&fakeRunner{})
	base := time.Now()
	tick := m.cfg.Interval
	walks := 0
	for elapsed := tick; elapsed <= time.Hour; elapsed += tick {
		now := base.Add(elapsed)
		var next Model
		next, _ = updateModel(m, tickMsg(now))
		m = next
		if !m.pollInFlight {
			continue
		}
		walks++
		m, _ = updateModel(m, boardOf(m))
		m.lastPoll = now
	}
	fixed := int(time.Hour / tick)
	if walks*5 > fixed {
		t.Errorf("idle hour cost %d board walks vs %d at a fixed cadence — want at least 5× fewer", walks, fixed)
	}
	if m.pollEvery != m.cfg.MaxInterval {
		t.Errorf("an idle hour must end at the ceiling, got %v", m.pollEvery)
	}
	t.Logf("idle hour: %d adaptive walks vs %d fixed (%.1f×)", walks, fixed, float64(fixed)/float64(walks))
}

func TestMaxPollInterval(t *testing.T) {
	floor := 30 * time.Second
	tests := []struct {
		raw  string
		want time.Duration
	}{
		{"", 300 * time.Second},
		{"garbage", 300 * time.Second},
		{"0", 300 * time.Second},
		{"-5", 300 * time.Second},
		{"600", 600 * time.Second},
		{"10", floor}, // below the floor collapses TO it: backoff off
	}
	for _, tt := range tests {
		if got := maxPollInterval(tt.raw, floor); got != tt.want {
			t.Errorf("maxPollInterval(%q) = %v, want %v", tt.raw, got, tt.want)
		}
	}
}

func TestPollInterval(t *testing.T) {
	tests := []struct {
		raw  string
		want time.Duration
	}{
		{"", 30 * time.Second},
		{"garbage", 30 * time.Second},
		{"0", 30 * time.Second},
		{"-5", 30 * time.Second},
		{"5", 10 * time.Second}, // floor: never hammer the API
		{"10", 10 * time.Second},
		{"120", 120 * time.Second},
	}
	for _, tt := range tests {
		if got := pollInterval(tt.raw); got != tt.want {
			t.Errorf("pollInterval(%q) = %v, want %v", tt.raw, got, tt.want)
		}
	}
}

// The fork verb (GH-1957). The row is an ISSUE, so the source pane is only
// unambiguous at exactly one live agent — the multi-agent case must refuse
// and name them rather than silently picking the first.
func TestVerbFork(t *testing.T) {
	t.Run("one live agent forks its pane", func(t *testing.T) {
		f := &fakeRunner{}
		m := testModel(f)
		m.col, m.row = 0, 0 // #10, one agent on pane p1
		m2, cmd := updateModel(m, keyMsg("f"))
		if cmd == nil {
			t.Fatalf("f must dispatch a fork; status = %q", m2.status)
		}
		cmd()
		if len(f.calls) == 0 {
			t.Fatal("fork ran no command")
		}
		got := strings.Join(f.calls[0].args, " ")
		if !strings.Contains(got, "p1") || !strings.Contains(got, "/plug/scripts") {
			t.Errorf("fork args must carry the scripts dir and the source pane: %q", got)
		}
	})

	t.Run("no live agent refuses and names spawn", func(t *testing.T) {
		m := testModel(&fakeRunner{})
		m.col, m.row = 0, 1 // #11, no agent
		m2, cmd := updateModel(m, keyMsg("f"))
		if cmd != nil {
			t.Error("fork with no session must not exec anything")
		}
		if !strings.Contains(m2.status, "nothing to fork") {
			t.Errorf("status = %q", m2.status)
		}
	})

	t.Run("two live agents refuse and name both", func(t *testing.T) {
		m := testModel(&fakeRunner{})
		m.agents = setAgents([]Agent{
			{Name: "w10-ten", Status: "working", Pane: "p1", Issue: 10, Lane: "w"},
			{Name: "r10-review", Status: "working", Pane: "p9", Issue: 10, Lane: "r"},
		})
		m.col, m.row = 0, 0
		m2, cmd := updateModel(m, keyMsg("f"))
		if cmd != nil {
			t.Error("an ambiguous fork source must not exec anything")
		}
		if !strings.Contains(m2.status, "w10-ten") || !strings.Contains(m2.status, "r10-review") {
			t.Errorf("the refusal must name both sessions; status = %q", m2.status)
		}
	})

	t.Run("no herdr degrades to a hint", func(t *testing.T) {
		m := testModel(&fakeRunner{})
		m.herdrOK = false
		m.col, m.row = 0, 0
		m2, cmd := updateModel(m, keyMsg("f"))
		if cmd != nil {
			t.Error("degraded f must not exec anything")
		}
		if !strings.Contains(m2.status, "no multiplexer") {
			t.Errorf("status = %q", m2.status)
		}
	})
}
