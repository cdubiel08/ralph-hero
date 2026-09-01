// view_test.go — render smoke: the view must produce sane output (no panic,
// non-empty, board state names verbatim) at small and large sizes, with zero
// cards and with 50, and in every mode. Golden-ish, not pixel-golden: the
// assertions pin content, not styling.
package main

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/lipgloss"
)

func manyCards() [3][]Card {
	var cols [3][]Card
	states := columnStates
	for i := 0; i < 50; i++ {
		state := states[i%3]
		c := Card{
			Number: 100 + i,
			Repo:   "o/r",
			Title:  fmt.Sprintf("Card number %d with a fairly long title that must truncate cleanly", 100+i),
			State:  state,
		}
		if state == "Human Needed" {
			c.Question = fmt.Sprintf("Question %d: which of the two options should GH-%d take?", i, 100+i)
		}
		cols[i%3] = append(cols[i%3], c)
	}
	return cols
}

func TestViewSmoke(t *testing.T) {
	sizes := []struct{ w, h int }{{80, 24}, {200, 50}}
	fills := []struct {
		name string
		cols [3][]Card
	}{
		{"zero cards", [3][]Card{}},
		{"50 cards", manyCards()},
	}
	for _, size := range sizes {
		for _, fill := range fills {
			t.Run(fmt.Sprintf("%dx%d/%s", size.w, size.h, fill.name), func(t *testing.T) {
				m := testModel(&fakeRunner{})
				m.width, m.height = size.w, size.h
				m.cols = fill.cols
				m.clampCursor()
				out := viewModel(m) // must not panic
				if out == "" {
					t.Fatal("empty render")
				}
				// The three board states, verbatim, always name the columns
				// (narrow renders show the current column's name).
				if size.w >= narrowThreshold {
					for _, state := range columnStates {
						if !strings.Contains(out, state) {
							t.Errorf("missing column header %q", state)
						}
					}
				} else if !strings.Contains(out, columnStates[m.col]) {
					t.Errorf("narrow render missing current column %q", columnStates[m.col])
				}
			})
		}
	}
}

func TestViewNarrowSingleColumn(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width = 60 // below narrowThreshold
	m.col = 2
	out := viewModel(m)
	if !strings.Contains(out, "Human Needed") {
		t.Error("narrow view must show the current column")
	}
	if strings.Contains(out, "In Review") {
		t.Error("narrow view must show ONLY the current column")
	}
	if !strings.Contains(out, "◀") || !strings.Contains(out, "▶") {
		t.Error("narrow view must hint at the h/l column switch")
	}
}

func TestViewHumanNeededQuestionVerbatim(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width = 220 // wide enough that the column clip cannot cut the line
	m.cols[2][0].Question = "Should GH-30 gate on the TTL or the holder count?"
	out := viewModel(m)
	if !strings.Contains(out, "Should GH-30 gate on the TTL or the holder count?") {
		t.Error("the Human Needed question line must render verbatim — the phone-answerable contract")
	}
	// And an unavailable question says so rather than faking one.
	m.cols[2][1].Question = ""
	out = viewModel(m)
	if !strings.Contains(out, "question unavailable") {
		t.Error("a missing question must be named, not invented")
	}
}

func TestViewHeaderNamesTheLiveCadence(t *testing.T) {
	// The cadence is adaptive, so the last-poll time alone is misleading: five
	// quiet minutes must read as a quiet board, not a hung cockpit.
	m := testModel(&fakeRunner{})
	m.width = 220
	m = settle(m, 8) // boardMsg stamps lastPoll itself, so fix the clock after
	m.lastPoll = time.Date(2026, 8, 13, 14, 5, 9, 0, time.Local)
	out := viewModel(m)
	if !strings.Contains(out, "polled 14:05:09 · every 5m0s") {
		t.Errorf("header must name the live cadence beside the poll time; got:\n%s", out)
	}
}

func TestViewBannerWithoutHerdr(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.herdrOK = false
	out := viewModel(m)
	if !strings.Contains(out, noMuxBanner) {
		t.Errorf("the degradation banner must show; got:\n%s", out)
	}
}

func TestViewBoardErrNeverShadowedByNoMuxBanner(t *testing.T) {
	// On a herdr-less host a total board-read failure must still render as a
	// failure — a failed read and an empty board are different facts, and the
	// no-multiplexer banner is chrome, not a substitute for that fact.
	m := testModel(&fakeRunner{})
	m.width = 220
	m.herdrOK = false
	m.boardErr = "In Progress: timeout"
	out := viewModel(m)
	if !strings.Contains(out, "board read failed: In Progress: timeout") {
		t.Errorf("board failure shadowed by the no-mux banner; got:\n%s", out)
	}
	if !strings.Contains(out, noMuxBanner) {
		t.Errorf("the no-mux fact should ride along when width allows; got:\n%s", out)
	}
}

func TestViewOverlaysAndInput(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.mode = ModePeek
	m.peekWho = "w10-ten"
	m.peekText = "some pane tail\nwith lines"
	out := viewModel(m)
	if !strings.Contains(out, "w10-ten") || !strings.Contains(out, "with lines") {
		t.Error("peek overlay must show the agent and its tail")
	}
	if !strings.Contains(out, "no focus steal") {
		t.Error("peek must advertise that it does not steal focus")
	}

	// GH-2217: a live agent's C8 lineage rides the peek header — and a
	// session with no recorded lineage shows none (absence is not depth 0).
	m.agents = setAgents([]Agent{
		{Name: "w10-ten", Status: "working", Issue: 10, Lane: "w",
			Parent: "o2208-herd-topology#ab12", Depth: "1"},
	})
	out = viewModel(m)
	if !strings.Contains(out, "depth 1 · parent o2208-herd-topology#ab12") {
		t.Errorf("peek header must carry the lineage tokens; got:\n%s", out)
	}
	m.agents = setAgents([]Agent{{Name: "w10-ten", Status: "working", Issue: 10, Lane: "w"}})
	out = viewModel(m)
	if strings.Contains(out, "depth ") || strings.Contains(out, "parent ") {
		t.Errorf("no lineage recorded must render no lineage; got:\n%s", out)
	}

	m.mode = ModeDag
	m.dagText = "FRONTIER — 1 eligible, 0 blocked\n  ▸ #12 Leaf"
	out = viewModel(m)
	if !strings.Contains(out, "#12 Leaf") {
		t.Error("dag overlay must show the tree")
	}

	m.mode = ModeReply
	m.inputWho = "w10-ten"
	m.input = "typed reply"
	m.inputErr = "not delivered: timeout — text preserved, ⏎ retries, esc leaves"
	out = viewModel(m)
	if !strings.Contains(out, "typed reply") || !strings.Contains(out, "text preserved") {
		t.Error("reply input must show the preserved text and the failure")
	}

	m.mode = ModeAnswer
	m.inputFor = 30
	out = viewModel(m)
	if !strings.Contains(out, "answer #30") || !strings.Contains(out, "board answer first") {
		t.Error("answer input must name the comment-first ordering")
	}
}

func TestTruncateStyledStaysWellFormed(t *testing.T) {
	styled := styleNumSel.Render(strings.Repeat("wide title ", 10))
	got := truncate(styled, 10)
	if w := lipgloss.Width(got); w > 10 {
		t.Errorf("truncate width = %d, want <= 10", w)
	}
	// Never end inside an escape sequence — a dangling partial CSI would eat
	// the following line's bytes on strict terminal parsers.
	if regexp.MustCompile("\x1b\\[[0-9;]*$").MatchString(got) {
		t.Errorf("truncate left a dangling CSI: %q", got)
	}
	// Plain text still clips plainly.
	if p := truncate("abcdef", 3); p != "abc" {
		t.Errorf("plain truncate = %q", p)
	}
}

func TestCardTitleIsIssueTitleEvenWithAddress(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.agents = setAgents([]Agent{
		{Name: "w10-ten", Status: "working", Pane: "p1", Issue: 10, Lane: "w",
			Address: "repo/t9-epic/w10-ten"},
	})
	out := viewModel(m)
	// GH-2320: the address suffix duplicated the branch line and displaced
	// the title; the card keeps the title whether or not an address exists.
	if !strings.Contains(out, "Ten") {
		t.Error("card with a known agent address must still render its issue title")
	}
	if strings.Contains(out, "t9-epic/w10-ten") {
		t.Error("card must not render the address suffix as its title (GH-2320)")
	}
	if !strings.Contains(out, "Eleven") {
		t.Error("card without an address must keep its issue title")
	}
}
func TestViewTinySizeDoesNotPanic(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width, m.height = 10, 3
	_ = viewModel(m) // clipping paths must hold
	m.width, m.height = 0, 0
	_ = viewModel(m)
}

func TestColWindowFollowsCursor(t *testing.T) {
	// bodyHeight 16 → visible = (16-colHeaderRows-bodyOverheadRows)/cardRows = 3.
	const bh = 16
	mk := func(n int) Model {
		m := testModel(&fakeRunner{})
		var cards []Card
		for i := 0; i < n; i++ {
			cards = append(cards, card(100+i, "In Progress", fmt.Sprintf("T%d", i)))
		}
		m.cols = [3][]Card{cards, nil, nil}
		return m
	}
	tests := []struct {
		name               string
		n, col, row        int
		wantStart, wantEnd int
	}{
		{"cursor above the fold renders from the top", 10, 0, 0, 0, 3},
		{"cursor on the fold edge keeps the top window", 10, 0, 2, 0, 3},
		{"cursor past the fold slides the window", 10, 0, 5, 3, 6},
		{"cursor on the last card pins the tail", 10, 0, 9, 7, 10},
		{"a non-cursor column stays at the top", 10, 1, 9, 0, 3},
		{"short columns render whole", 2, 0, 1, 0, 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := mk(tt.n)
			m.col, m.row = tt.col, tt.row
			start, end := colWindow(m, 0, bh)
			if start != tt.wantStart || end != tt.wantEnd {
				t.Errorf("colWindow = [%d,%d), want [%d,%d)", start, end, tt.wantStart, tt.wantEnd)
			}
		})
	}
}

func TestViewScrollFollowKeepsSelectionVisible(t *testing.T) {
	m := testModel(&fakeRunner{})
	// Wide enough for the one-line legend (GH-2319 wraps it under ~165 cols,
	// which would take a body row): bodyHeight 12 → visible = 2.
	m.width, m.height = 200, 16
	var cards []Card
	for i := 0; i < 8; i++ {
		cards = append(cards, card(200+i, "In Progress", fmt.Sprintf("Deep%d", i)))
	}
	m.cols[0] = cards
	m.row = 6 // past the fold — window must be [5,7)
	out := viewModel(m)
	if !strings.Contains(out, "#206") || !strings.Contains(out, "▌") {
		t.Errorf("the selected card must stay rendered (every verb acts on it); got:\n%s", out)
	}
	if strings.Contains(out, "#200 ") {
		t.Errorf("cards above the window must not render; got:\n%s", out)
	}
	if !strings.Contains(out, "↑5 above") || !strings.Contains(out, "+1 more") {
		t.Errorf("the hidden counts must be named both ways; got:\n%s", out)
	}
}

func TestHitTestScrolledWindow(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width, m.height = 200, 16 // one-line legend (see above); visible = 2
	var cards []Card
	for i := 0; i < 8; i++ {
		cards = append(cards, card(200+i, "In Progress", fmt.Sprintf("Deep%d", i)))
	}
	m.cols[0] = cards
	m.row = 6 // window [5,7)
	// The first rendered card line maps to index 5, not 0.
	if col, row, ok := hitTest(m, 2, headerRows+colHeaderRows); !ok || col != 0 || row != 5 {
		t.Errorf("got (%d,%d,%v), want (0,5,true)", col, row, ok)
	}
	if col, row, ok := hitTest(m, 2, headerRows+colHeaderRows+cardRows); !ok || col != 0 || row != 6 {
		t.Errorf("got (%d,%d,%v), want (0,6,true)", col, row, ok)
	}
	// The "↑N above · +N more" line below the window maps to NOTHING — a
	// click there must never select an invisible card.
	if _, _, ok := hitTest(m, 2, headerRows+colHeaderRows+2*cardRows); ok {
		t.Error("clicks on the more-line must not select a hidden card")
	}
}

func TestHitTestMirrorsLayout(t *testing.T) {
	m := testModel(&fakeRunner{})
	// Above the columns: no hit.
	if _, _, ok := hitTest(m, 5, 0); ok {
		t.Error("header clicks must not select")
	}
	// First card of column 0.
	if col, row, ok := hitTest(m, 2, headerRows+colHeaderRows); !ok || col != 0 || row != 0 {
		t.Errorf("got (%d,%d,%v)", col, row, ok)
	}
	// Second card of column 0 (cardRows lines down).
	if col, row, ok := hitTest(m, 2, headerRows+colHeaderRows+cardRows); !ok || col != 0 || row != 1 {
		t.Errorf("got (%d,%d,%v)", col, row, ok)
	}
	// Beyond the column's cards: no hit.
	if _, _, ok := hitTest(m, 2, headerRows+colHeaderRows+cardRows*10); ok {
		t.Error("clicks past the last card must not select")
	}
	// Narrow mode: clicks stay in the shown column.
	m.width = 60
	m.col = 1
	if col, _, ok := hitTest(m, 55, headerRows+colHeaderRows); !ok || col != 1 {
		t.Errorf("narrow hit col = %d ok=%v, want current column 1", col, ok)
	}
}

// ── card markings (GH-2061) ─────────────────────────────────────────────────

// TestCardHeightIsUniformInEveryState is the load-bearing one. hitTest maps
// clicks through cardRows as a FIXED STRIDE, so a card that reflowed on
// selection — or on having a chip, a question, a branch — would move the grid
// under the cursor and every click below it would land on the wrong issue.
func TestCardHeightIsUniformInEveryState(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.ledger = Ledger{
		Read:    true,
		ByRef:   map[string]LedgerSpawn{"w10-ten#aaa": {Ref: "w10-ten#aaa", Issue: 10, SpawnedAt: time.Now().Add(-3 * time.Hour), Checkout: "/wt/10", Branch: "feat/10-ten"}},
		ByIssue: map[int]LedgerSpawn{10: {Branch: "feat/10-ten"}},
	}
	m.agents = setAgents([]Agent{
		{Name: "w10-ten", Status: "working", Issue: 10, Lane: "w", Root: "w10-ten#aaa", Branch: "feat/10-ten", TokenState: "working"},
	})
	m.diffs = map[string]DiffStat{"w10-ten#aaa": {Add: 1233, Del: 1234, Known: true}}
	// GH-2062's markings are the new reflow risk: a PR chip, an epic name that
	// can be arbitrarily long, and a Done card's close time all land on rows
	// hitTest maps through as a fixed stride.
	m.signalsOK = true
	m.prs = map[int]PRMark{20: {Number: 2049, Fate: PRFateMerged}}
	m.epics = map[int]EpicRollup{
		1930: {Number: 1930, Title: strings.Repeat("Epic: a very long parent name ", 8), Done: 2, Total: 4, Truncated: true},
	}

	cards := []Card{
		{Number: 10, State: "In Progress", Title: "short", Priority: "P0", Estimate: "M"},
		{Number: 11, State: "In Progress", Title: strings.Repeat("a very long title ", 20)},
		{Number: 20, State: "In Review", Title: "review", Priority: "P2", ParentNumber: 1930},
		{Number: 21, State: "In Review", Title: "unread chip", ParentNumber: 9999}, // epic present, rollup absent
		{Number: 30, State: "Human Needed", Title: "blocked", Question: strings.Repeat("q ", 90)},
		{Number: 31, State: "Human Needed", Title: "blocked, no question"},
		{Number: 40, State: "In Progress", Title: "no agent, no marking at all"},
		{Number: 50, State: doneState, Title: "closed", ClosedAt: time.Now().Add(-30 * time.Hour).Format(time.RFC3339)},
		{Number: 51, State: doneState, Title: "closed, unreadable stamp", ClosedAt: "not-a-time"},
	}
	for _, width := range []int{20, 40, 60, 120, 200} {
		for _, c := range cards {
			for _, sel := range []bool{false, true} {
				col, row := 1, 1 // not the cursor
				if sel {
					col, row = m.col, m.row
				}
				out := renderCard(m, col, row, c, width)
				if got := strings.Count(out, "\n"); got != cardRows {
					t.Fatalf("#%d w=%d selected=%v rendered %d lines, want cardRows=%d:\n%q",
						c.Number, width, sel, got, cardRows, out)
				}
				for _, line := range strings.Split(strings.TrimSuffix(out, "\n"), "\n") {
					if w := lipgloss.Width(line); w > width {
						t.Fatalf("#%d w=%d selected=%v line overflows to %d cells: %q",
							c.Number, width, sel, w, line)
					}
				}
			}
		}
	}
}

// TestHitTestMirrorsRenderedStride reads the mapping off the ACTUAL render
// rather than recomputing the formula: the Nth rendered card must start on the
// line hitTest maps to the Nth card, or the mouse and the eye disagree.
func TestHitTestMirrorsRenderedStride(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width, m.height = 140, 40
	var cards []Card
	for i := 0; i < 6; i++ {
		cards = append(cards, card(300+i, "In Progress", fmt.Sprintf("Card%d", i)))
	}
	m.cols = [3][]Card{cards, nil, nil}
	m.col, m.row = 0, 0

	lines := strings.Split(viewModel(m), "\n")
	start, end := colWindow(m, 0, bodyHeightOf(m))
	for i := start; i < end; i++ {
		y := headerRows + colHeaderRows + (i-start)*cardRows
		if y >= len(lines) {
			t.Fatalf("card %d maps past the render (%d lines)", i, len(lines))
		}
		if !strings.Contains(lines[y], fmt.Sprintf("#%d", cards[i].Number)) {
			t.Errorf("hitTest maps y=%d to card %d (#%d), but that line renders:\n%q",
				y, i, cards[i].Number, lines[y])
		}
		// Every line of the card maps to the same card, including the rule.
		for k := 0; k < cardRows; k++ {
			col, row, ok := hitTest(m, 2, y+k)
			if !ok || col != 0 || row != i {
				t.Errorf("hitTest(2,%d) = (%d,%d,%v), want (0,%d,true)", y+k, col, row, ok, i)
			}
		}
	}
}

func TestJoinAgentStateTokenRefinesNeverContradicts(t *testing.T) {
	tests := []struct {
		name          string
		status, token string
		want          string
	}{
		{"herdr working, no token", "working", "", stateWorking},
		{"reporting is only expressible by the token", "working", "reporting", stateReporting},
		{"blocked from herdr wins", "blocked", "working", stateBlocked},
		// The case the token exists for: a session escalated and then went
		// idle waiting for the answer. herdr sees plain idle; the card must
		// still be the one that needs a human.
		{"blocked from the token wins over idle", "idle", "blocked", stateBlocked},
		// `spawned` is written by the SPAWNER and persists until the session's
		// first self-report — which a session that never checkpoints never
		// makes. So it may only speak where herdr has no observation at all;
		// over a live idle it rendered a five-hour-old session as "starting".
		{"spawned speaks only where herdr is silent", "unknown", "spawned", stateStarting},
		{"briefed counts as starting too", "", "briefed", stateStarting},
		{"a stale spawned token loses to live idle", "idle", "spawned", stateIdle},
		{"a stale spawned token loses to live motion", "working", "spawned", stateWorking},
		{"a stale working token loses to live idle", "idle", "working", stateIdle},
		{"done is idle — nothing is happening", "done", "", stateIdle},
		{"unknown with no token stays unknown", "unknown", "", stateUnknown},
		{"a token can speak when herdr cannot", "unknown", "working", stateWorking},
		{"an unrecognised herdr status is unknown, not invented", "wedged", "", stateUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := joinAgentState(tt.status, tt.token); got != tt.want {
				t.Errorf("joinAgentState(%q,%q) = %q, want %q", tt.status, tt.token, got, tt.want)
			}
		})
	}
}

func TestCardStateRanksTheMostAttentionWorthyAgent(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.agents = setAgents([]Agent{
		{Name: "w50-a", Status: "idle", Issue: 50, Lane: "w"},
		{Name: "w50-b", Status: "idle", Issue: 50, Lane: "x", TokenState: "blocked"},
		{Name: "w50-c", Status: "working", Issue: 50, Lane: "r"},
	})
	if s, ok := m.cardState(50); !ok || s != stateBlocked {
		t.Errorf("cardState = %q,%v — a blocked member of a fleet must win", s, ok)
	}
	// No live agent is NOT a live agent in an unknown state.
	if _, ok := m.cardState(999); ok {
		t.Error("an issue with no agents must report no state")
	}
}

func TestCardAgeUsesTheAgentRefNotTheName(t *testing.T) {
	now := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	m := testModel(&fakeRunner{})
	m.ledger = Ledger{Read: true, ByRef: map[string]LedgerSpawn{
		"w60-x#old": {Ref: "w60-x#old", Issue: 60, SpawnedAt: now.Add(-90 * time.Hour)},
		"w60-x#new": {Ref: "w60-x#new", Issue: 60, SpawnedAt: now.Add(-2 * time.Hour)},
	}}
	// Both records share the agent NAME; only the ref tells them apart. A
	// name-keyed join would age this session by the dead one's clock.
	m.agents = setAgents([]Agent{{Name: "w60-x", Status: "working", Issue: 60, Lane: "w", Root: "w60-x#new"}})
	age, ok := m.cardAge(60, now)
	if !ok || age != 2*time.Hour {
		t.Errorf("cardAge = %v,%v — want the live session's own spawn", age, ok)
	}

	// An agent nobody spawned through the sanctioned path carries no root, so
	// there is no record — a dash, never 0m.
	m.agents = setAgents([]Agent{{Name: "w60-x", Status: "working", Issue: 60, Lane: "w"}})
	if _, ok := m.cardAge(60, now); ok {
		t.Error("an agent with no ledger record must not report an age")
	}
}

func TestCardDiffThreeCasesStayDistinct(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.ledger = Ledger{Read: true, ByRef: map[string]LedgerSpawn{
		"w70-a#r": {Ref: "w70-a#r", Issue: 70, Checkout: "/wt/70"},
		"w71-a#r": {Ref: "w71-a#r", Issue: 71, Checkout: "/wt/71"},
	}}
	m.agents = setAgents([]Agent{
		{Name: "w70-a", Status: "working", Issue: 70, Lane: "w", Root: "w70-a#r"},
		{Name: "w71-a", Status: "working", Issue: 71, Lane: "w", Root: "w71-a#r"},
	})
	m.diffs = map[string]DiffStat{"w70-a#r": {Add: 5, Del: 1, Known: true}}

	// Measured.
	if st, live := m.cardDiff(70); !live || !st.Known || st.Add != 5 {
		t.Errorf("measured diff = %+v live=%v", st, live)
	}
	if got := diffChip(m, Card{Number: 70}); !strings.Contains(got, "+5") || !strings.Contains(got, "-1") {
		t.Errorf("measured chip = %q", got)
	}
	// Known checkout, not yet measured — pending, not clean.
	if got := diffChip(m, Card{Number: 71}); !strings.Contains(got, "±?") {
		t.Errorf("unmeasured chip = %q, want ±?", got)
	}
	// No live agent — nothing to measure, so nothing is drawn. This must not
	// look like either of the two above.
	if got := diffChip(m, Card{Number: 999}); got != "" {
		t.Errorf("agentless chip = %q, want empty", got)
	}
}

func TestDiffTargetsAreInProgressOnlyAndBounded(t *testing.T) {
	m := testModel(&fakeRunner{})
	var inProgress []Card
	agents := []Agent{}
	refs := map[string]LedgerSpawn{}
	for i := 0; i < maxDiffReads+4; i++ {
		n := 400 + i
		inProgress = append(inProgress, card(n, "In Progress", "x"))
		ref := fmt.Sprintf("w%d-x#r", n)
		agents = append(agents, Agent{Name: fmt.Sprintf("w%d-x", n), Status: "working", Issue: n, Lane: "w", Root: ref})
		refs[ref] = LedgerSpawn{Ref: ref, Issue: n, Checkout: fmt.Sprintf("/wt/%d", n)}
	}
	// An In Review agent must never be measured: its work has left the
	// worktree, and the right slot there belongs to the PR chip.
	reviewRef := "w500-r#r"
	agents = append(agents, Agent{Name: "w500-r", Status: "working", Issue: 500, Lane: "w", Root: reviewRef})
	refs[reviewRef] = LedgerSpawn{Ref: reviewRef, Issue: 500, Checkout: "/wt/500"}

	m.cols = [3][]Card{inProgress, {card(500, "In Review", "r")}, nil}
	m.agents = setAgents(agents)
	m.ledger = Ledger{Read: true, ByRef: refs}

	targets := m.diffTargets()
	if len(targets) != maxDiffReads {
		t.Errorf("diffTargets = %d, want the bound %d — each target is two local git processes", len(targets), maxDiffReads)
	}
	for _, sp := range targets {
		if sp.Issue == 500 {
			t.Error("an In Review agent must not be measured")
		}
	}
}

func TestColumnHeaderCountIsRightJustifiedWithoutParens(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width, m.height = 180, 40
	out := viewModel(m)
	if strings.Contains(out, "In Progress (3)") {
		t.Error("the count must be right-justified and parenthesis-free")
	}
	head := strings.Split(out, "\n")[headerRows]
	if !strings.Contains(head, "In Progress") || !strings.Contains(head, "3") {
		t.Errorf("header line lost its name or count: %q", head)
	}
}

func TestDoneSwapClampsTheCursorAndKeepsItsThreeEmptyStatesApart(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width, m.height = 180, 40
	m.col, m.row = 2, 1 // on the second Human Needed card

	m, cmd := updateKey(m, keyMsg("D"))
	if !m.showDone {
		t.Fatal("D must swap the third column")
	}
	// The two lists are different lengths, so a row index that outlived the
	// swap would leave every verb acting on a card that is not under the
	// cursor.
	if m.row != 0 {
		t.Errorf("row = %d after the swap, want 0", m.row)
	}
	// `D` is the only signal that anyone wants this column, so the read is
	// dispatched on the key rather than at the next tick.
	if cmd == nil || !m.doneInFlight {
		t.Fatal("D must dispatch the closed-issue read immediately")
	}
	out := viewModel(m)
	if !strings.Contains(out, m.doneTitle()) {
		t.Errorf("the Done header must carry its window; got:\n%s", out)
	}
	if strings.Contains(out, "Thirty") {
		t.Error("the Done column must not still be rendering Human Needed cards")
	}
	// Three facts, three renderings. Reading-not-yet-landed first.
	if strings.Contains(out, "(none)") || strings.Contains(out, "nothing closed") {
		t.Errorf("an unread window must not claim to be empty; got:\n%s", out)
	}

	// A FAILED read must never render like a window with nothing in it.
	failed, _ := updateModel(m, doneMsg{err: "gh api graphql failed (exit 1)"})
	fout := viewModel(failed)
	if !strings.Contains(fout, "gh api graphql failed") {
		t.Errorf("a failed Done read must name its cause; got:\n%s", fout)
	}
	if strings.Contains(fout, "nothing closed") {
		t.Error("a failed read must not render as an empty window")
	}

	// A read that succeeded and found nothing says exactly that.
	okEmpty, _ := updateModel(m, doneMsg{ok: true, windowDays: 14})
	if !strings.Contains(viewModel(okEmpty), "nothing closed in the window") {
		t.Error("a successful, empty window must say so rather than looking unread")
	}

	// And a read with cards renders them, with the close time — never the
	// empty priority meter, which on a live card means a real defect.
	filled, _ := updateModel(m, doneMsg{
		ok:         true,
		windowDays: 14,
		cards: []Card{{
			Number: 2061, Repo: "o/r", Title: "Cockpit card markings",
			State: doneState, ClosedAt: time.Now().Add(-90 * time.Minute).Format(time.RFC3339),
		}},
	})
	dout := viewModel(filled)
	if !strings.Contains(dout, "#2061") || !strings.Contains(dout, "closed 1h 30m ago") {
		t.Errorf("a Done card must carry its number and when it closed; got:\n%s", dout)
	}

	m, _ = updateKey(m, keyMsg("D"))
	if m.showDone || !strings.Contains(viewModel(m), "Human Needed") {
		t.Error("D must swap back")
	}
}

func TestPriorityGlyphMarksP0AndNullDistinctly(t *testing.T) {
	if !strings.Contains(priorityGlyph("P0"), "[!]") {
		t.Error("P0 must be an alert, not a meter position")
	}
	// A null priority sinks an item below stale backlog in `board next`, so it
	// is a real defect and renders as an EMPTY meter rather than as blank.
	empty := priorityGlyph("")
	if empty == "" {
		t.Error("an unset priority must render as an empty meter, not as nothing")
	}
	for _, p := range []string{"P1", "P2", "P3"} {
		if g := priorityGlyph(p); lipgloss.Width(g) != lipgloss.Width(empty) {
			t.Errorf("priorityGlyph(%q) is %d cells, empty is %d — the meter must be fixed-width",
				p, lipgloss.Width(g), lipgloss.Width(empty))
		}
	}
}

func TestAgeChipDashesRatherThanZero(t *testing.T) {
	m := testModel(&fakeRunner{})
	// A live agent with no ledger record: not an agent that is zero minutes old.
	m.agents = setAgents([]Agent{{Name: "w80-x", Status: "working", Issue: 80, Lane: "w"}})
	if got := ageChip(m, Card{Number: 80}, asciiGlyphs); !strings.Contains(got, "—") {
		t.Errorf("ageChip = %q, want a dash", got)
	}
	if strings.Contains(ageChip(m, Card{Number: 80}, asciiGlyphs), "0m") {
		t.Error("a missing record must never render as 0m")
	}
}

func TestInboxSwapClampsTheCursorAndKeepsItsThreeEmptyStatesApart(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width, m.height = 180, 40
	m.col, m.row = 2, 1

	m, cmd := updateKey(m, keyMsg("I"))
	if !m.showInbox {
		t.Fatal("I must swap the third column")
	}
	if m.row != 0 {
		t.Errorf("row = %d after the swap, want 0", m.row)
	}
	if cmd == nil || !m.inboxInFlight {
		t.Fatal("I must dispatch the inbox read immediately")
	}
	out := viewModel(m)
	if !strings.Contains(out, "Inbox") {
		t.Errorf("the header must name the Inbox view; got:\n%s", out)
	}
	if strings.Contains(out, "Thirty") {
		t.Error("the Inbox view must not still be rendering Human Needed cards")
	}
	// Unread first: it must not claim emptiness.
	if strings.Contains(out, "(none)") || strings.Contains(out, "inbox empty") {
		t.Errorf("an unread inbox must not claim to be empty; got:\n%s", out)
	}

	// A FAILED read must never render like an empty inbox.
	failed, _ := updateModel(m, inboxMsg{err: "gh api graphql failed (exit 1)"})
	fout := viewModel(failed)
	if !strings.Contains(fout, "gh api graphql failed") {
		t.Errorf("a failed inbox read must name its cause; got:\n%s", fout)
	}
	if strings.Contains(fout, "inbox empty") {
		t.Error("a failed read must not render as an empty inbox")
	}

	// A read that succeeded and found nothing says exactly that — and still
	// counts what the classifier held back (GH-2108).
	okEmpty, _ := updateModel(m, inboxMsg{ok: true, withheld: "1 reviewer-rate-limited"})
	eout := viewModel(okEmpty)
	if !strings.Contains(eout, "inbox empty") {
		t.Error("a successful, empty inbox must say so rather than looking unread")
	}
	if !strings.Contains(eout, "withheld: 1 reviewer-rate-limited") {
		t.Errorf("held-back rows must be counted even over an empty inbox; got:\n%s", eout)
	}

	// A read with rows renders the decision's why-line and every other row's
	// disposition verb — the two facts the queue admits rows on.
	filled, _ := updateModel(m, inboxMsg{ok: true, cards: []Card{
		{Number: 30, State: inboxState, Queue: "decision", Title: "Thirty",
			Question: "merge or split the epic?", Verb: `board answer 30 -m "<the decision>"`},
		{Number: 40, State: inboxState, Queue: "approval", Title: "Forty",
			Verb: "board move 40 backlog"},
	}})
	iout := viewModel(filled)
	if !strings.Contains(iout, "? merge or split the epic?") {
		t.Errorf("a decision row must render its why-line; got:\n%s", iout)
	}
	if !strings.Contains(iout, "→ board move 40 backlog") {
		t.Errorf("a non-decision row must render its disposition verb; got:\n%s", iout)
	}
	if !strings.Contains(iout, "approval") {
		t.Errorf("the queue kind must ride the card; got:\n%s", iout)
	}

	m, _ = updateKey(m, keyMsg("I"))
	if m.showInbox || !strings.Contains(viewModel(m), "Human Needed") {
		t.Error("I must swap back")
	}
}

func TestDoneAndInboxDisplaceEachOtherRatherThanStacking(t *testing.T) {
	m := testModel(&fakeRunner{})
	m, _ = updateKey(m, keyMsg("D"))
	m, _ = updateKey(m, keyMsg("I"))
	if m.showDone || !m.showInbox {
		t.Error("I over Done must land on Inbox, not a stack")
	}
	m, _ = updateKey(m, keyMsg("D"))
	if m.showInbox || !m.showDone {
		t.Error("D over Inbox must land on Done, not a stack")
	}
}

// ── topology overlay (GH-2219, unit K) ──────────────────────────────────────

func topoModel() Model {
	m := testModel(&fakeRunner{})
	m.mode = ModeTopology
	m.topoRepo = "ralph-hero"
	m.topoRows = []TopoRow{
		{Name: "hero", Address: "ralph-hero/dispatch", Dispatch: true, Status: "working"},
		{Name: "w2219-topology-k", Team: "t2208-herd", Lane: "w", Issue: 2219,
			Status: "idle", TokenState: "blocked"},
		{Name: "o2208-herd-topology", Team: "t2208-herd", Lane: "o", Issue: 2208,
			Status: "working", TokenState: "working"},
		{Name: "", Status: "idle", Note: "no derivable address"},
	}
	m.topoEscs = []TopoEsc{
		{Number: 2219, Route: "lead", Lead: "o2208-herd-topology", Disposition: "pending"},
		{Number: 40, Route: "human"},
		{Number: 41, Route: "lead", Disposition: "auto-promoted"},
		{Number: 42, Route: "lead", Lead: "o2208-herd-topology", Answered: true},
	}
	m.topoWithheld = "2 foreign"
	m.width = 120
	m.height = 40
	return m
}

func TestRenderTopologyTree(t *testing.T) {
	out := viewModel(topoModel())
	// The rungs, top-down: dispatch → team → lead (first) → worker → flat.
	for _, want := range []string{
		"topology — ralph-hero", "board claims not read",
		"ralph-hero/dispatch", "t2208-herd/",
		"o2208-herd-topology", "w2219-topology-k", "(unnamed)",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("topology must contain %q; got:\n%s", want, out)
		}
	}
	// The lead renders BEFORE its worker inside the team (board.ts ordering).
	if strings.Index(out, "o2208-herd-topology") > strings.Index(out, "w2219-topology-k") {
		t.Error("the lead must render before its workers inside a team")
	}
	// Escalation counts per rung: the lead's pending queue, the worker's own
	// escalation, the human tier on the dispatch line, and the header totals.
	for _, want := range []string{
		"1 decision(s) pending", // lead rung — #42 is answered, so ONE pending
		"⚠ decision → lead",     // worker rung, its own issue
		"2 in inbox",            // dispatch rung: human-routed #40 + auto-promoted #41
		"escalations: 1 with leads · 2 with human · 1 answered · resume pending",
		"withheld: 2 foreign",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("topology must contain %q; got:\n%s", want, out)
		}
	}
	// The unnamed row keeps its reason, and absence stays absence.
	if !strings.Contains(out, "[no derivable address]") {
		t.Errorf("a null address must carry its note; got:\n%s", out)
	}
	// A worker whose token says blocked joins to the blocked state (the token
	// wins over an idle agent_status — joinAgentState's own rule).
	if !strings.Contains(out, "blocked") {
		t.Errorf("the joined state word must render; got:\n%s", out)
	}
}

func TestRenderTopologyEscalationsNotCountedIsNeverZero(t *testing.T) {
	m := topoModel()
	m.topoEscs = nil
	m.topoEscErr = "rate limited"
	out := viewModel(m)
	if !strings.Contains(out, "NOT COUNTED") || !strings.Contains(out, "rate limited") {
		t.Errorf("a failed count must say NOT COUNTED and why; got:\n%s", out)
	}
	// No per-rung count may render off a failed read.
	for _, banned := range []string{"decision(s) pending", "in inbox", "⚠"} {
		if strings.Contains(out, banned) {
			t.Errorf("a failed count must render NO per-rung counts (%q); got:\n%s", banned, out)
		}
	}
}

func TestRenderTopologyEmptyStatesStayApart(t *testing.T) {
	// Genuinely empty: no agents, no escalations.
	m := topoModel()
	m.topoRows = nil
	m.topoEscs = []TopoEsc{}
	m.topoWithheld = ""
	out := viewModel(m)
	if !strings.Contains(out, "(no live agents on this machine)") {
		t.Errorf("an empty herd must say so; got:\n%s", out)
	}
	if !strings.Contains(out, "no live escalations") {
		t.Errorf("an empty queue must say so; got:\n%s", out)
	}
	if !strings.Contains(out, "dispatch — no live binding") {
		t.Errorf("no dispatch row must render the no-binding line; got:\n%s", out)
	}
	// Unreadable herd ≠ empty herd: the reason renders.
	m.topoAgentsNote = "herdr not on PATH"
	out = viewModel(m)
	if !strings.Contains(out, "herd agents not read: herdr not on PATH") {
		t.Errorf("an unreadable herd must name its reason; got:\n%s", out)
	}
}

func TestRenderTopologyHeadClips(t *testing.T) {
	m := topoModel()
	for i := 0; i < 60; i++ {
		m.topoRows = append(m.topoRows, TopoRow{
			Name: fmt.Sprintf("w%d-filler", 3000+i), Issue: 3000 + i, Status: "working"})
	}
	m.height = 20
	out := viewModel(m)
	if !strings.Contains(out, "more — board roster shows all") {
		t.Errorf("an over-tall tree must clip and say so; got:\n%s", out)
	}
	// Top-down: the header and dispatch rung survive the clip, the tail goes.
	if !strings.Contains(out, "ralph-hero/dispatch") {
		t.Errorf("the clip must keep the FIRST lines; got:\n%s", out)
	}
}

func TestLegendNamesTopology(t *testing.T) {
	m := testModel(&fakeRunner{})
	if !strings.Contains(legend(m), "T topology") {
		t.Errorf("browse legend must name the T toggle: %q", legend(m))
	}
	m.mode = ModeTopology
	if legend(m) != "esc close" {
		t.Errorf("topology overlay legend must be esc close: %q", legend(m))
	}
}

// ── inbox view (GH-2318) ────────────────────────────────────────────────────

func TestRenderInboxViewRowsInFull(t *testing.T) {
	m := inboxViewModel()
	m.mode = ModeInbox
	m.inboxCards[0].Question = strings.Repeat("a long decision line that the three-line card had to clip ", 4)
	m.inboxWithheld = "1 reviewer-rate-limited"
	m.inboxLeads = "#2219 (o2208-herd-topology)"
	m.width, m.height = 100, 40
	out := viewModel(m)
	for _, want := range []string{
		"inbox — repo  (Tier 1)",
		"3 waiting — 1 decisions, 1 proposals, 1 approvals, 0 deliver-blocked",
		"#30", "decision", "Thirty",
		"? a long decision line",
		`→ board answer 30 -m "<the decision>"`,
		"#40", "approval", `reject: board cancel 40 -m "<why>"`, "→ board move 40 backlog",
		"#50", "proposal", "→ board resolve 50 --accept",
		"withheld: 1 reviewer-rate-limited",
		"with leads: #2219 (o2208-herd-topology)",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("inbox view must contain %q; got:\n%s", want, out)
		}
	}
	// The decision text is WRAPPED, not clipped to one line: its tail survives.
	if strings.Count(out, "three-line") < 4 {
		t.Errorf("the decision text must wrap in full; got:\n%s", out)
	}
	// The columns are not drawn behind it.
	if strings.Contains(out, "Eleven") {
		t.Error("the inbox view must replace the columns, not overlay them")
	}
	// The selected row carries the cursor gutter; only one row does.
	if strings.Count(out, "▌") == 0 {
		t.Error("the selected row must carry the cursor gutter")
	}
}

func TestRenderInboxViewEmptyStatesStayApart(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.mode = ModeInbox
	m.width, m.height = 100, 30

	unread := viewModel(m)
	if !strings.Contains(unread, "(reading the inbox…)") || strings.Contains(unread, "inbox empty") {
		t.Errorf("an unread inbox must not claim emptiness; got:\n%s", unread)
	}

	m.inboxOK = false
	m.inboxErr = "gh api graphql failed (exit 1)"
	failed := viewModel(m)
	if !strings.Contains(failed, "inbox read failed: gh api graphql failed") || strings.Contains(failed, "inbox empty") {
		t.Errorf("a failed read must name its cause and never read as empty; got:\n%s", failed)
	}

	// A failed REFRESH over rows keeps the rows and says they may be stale.
	m.inboxCards = inboxViewModel().inboxCards
	stale := viewModel(m)
	if !strings.Contains(stale, "showing the last good read (3 rows)") || !strings.Contains(stale, "#30") {
		t.Errorf("a failed refresh must keep the last rows and label them; got:\n%s", stale)
	}

	m.inboxCards = nil
	m.inboxErr = ""
	m.inboxOK = true
	m.inboxLeads = "#7 (unnamed lead)"
	empty := viewModel(m)
	if !strings.Contains(empty, "(inbox empty — no decisions waiting)") {
		t.Errorf("a successful empty read must say so; got:\n%s", empty)
	}
	if !strings.Contains(empty, "with leads: #7 (unnamed lead)") {
		t.Errorf("rows held by leads must be counted even over an empty inbox; got:\n%s", empty)
	}
}

func TestRenderInboxViewScrollsToKeepTheCursorVisible(t *testing.T) {
	m := inboxViewModel()
	m.mode = ModeInbox
	m.inboxCards = nil
	for i := 0; i < 30; i++ {
		m.inboxCards = append(m.inboxCards, Card{Number: 100 + i, State: inboxState, Queue: "decision",
			Title: fmt.Sprintf("Row %d", i), Question: "q?", Verb: fmt.Sprintf("board answer %d", 100+i)})
	}
	m.width, m.height = 100, 24
	top := viewModel(m)
	if !strings.Contains(top, "#100") || !strings.Contains(top, "more below — j scrolls") {
		t.Errorf("at the top the first row and the below-marker must render; got:\n%s", top)
	}
	if strings.Contains(top, "above — k scrolls") {
		t.Error("no above-marker at the top")
	}
	m.inboxRow = 29
	bottom := viewModel(m)
	if !strings.Contains(bottom, "#129") || !strings.Contains(bottom, "above — k scrolls") {
		t.Errorf("at the bottom the last row and the above-marker must render; got:\n%s", bottom)
	}
	if strings.Contains(bottom, "more below") {
		t.Error("no below-marker at the bottom")
	}
	// The rendered body never exceeds the body height it was given.
	if n := strings.Count(bottom, "\n"); n > m.height+2 {
		t.Errorf("view rendered %d lines for a %d-row terminal", n, m.height)
	}
}

func TestRenderInboxViewStaysBehindTheAnswerInput(t *testing.T) {
	m := inboxViewModel()
	m.mode = ModeAnswer
	m.inboxReturn = true
	m.inputFor = 30
	m.input = "merge it"
	m.width, m.height = 100, 30
	out := viewModel(m)
	if !strings.Contains(out, "merge or split the epic?") || !strings.Contains(out, "answer #30") {
		t.Errorf("the decision text and the input line must both render; got:\n%s", out)
	}
	if strings.Contains(out, "Eleven") {
		t.Error("the columns must not replace the view while its answer is typed")
	}
}

func TestLegendNamesInboxView(t *testing.T) {
	m := testModel(&fakeRunner{})
	if !strings.Contains(legend(m), "i inbox") || !strings.Contains(legend(m), "I inbox⇄human") {
		t.Errorf("browse legend must name both inbox keys: %q", legend(m))
	}
	m.mode = ModeInbox
	if !strings.Contains(legend(m), "a/⏎ answer decision") || !strings.Contains(legend(m), "i/esc close") {
		t.Errorf("inbox view legend must name answer and close: %q", legend(m))
	}
}

func TestWrapWords(t *testing.T) {
	got := wrapWords("one two three four", 9, 0)
	want := []string{"one two", "three", "four"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("wrap = %q, want %q", got, want)
	}
	if got := wrapWords("abcdefghij", 4, 0); strings.Join(got, "|") != "abcd|efgh|ij" {
		t.Errorf("an over-long word must hard-break: %q", got)
	}
	if got := wrapWords("a b c d e f", 1, 2); len(got) != 2 || !strings.HasSuffix(got[1], "…") {
		t.Errorf("a clipped wrap must end in an ellipsis: %q", got)
	}
	if got := wrapWords("", 10, 0); len(got) != 1 || got[0] != "" {
		t.Errorf("empty input yields one empty line: %q", got)
	}
}

func TestRenderInboxViewClipsAnOverTallSelectedRowToTheBody(t *testing.T) {
	m := inboxViewModel()
	m.mode = ModeInbox
	m.inboxCards[0].Question = strings.Repeat("a very long decision that wraps across many many lines of the view ", 12)
	m.inboxWithheld = "1 settling"
	m.width, m.height = 60, 14
	out := viewModel(m)
	if !strings.Contains(out, "row clipped to the screen") {
		t.Errorf("an over-tall selected row must say it was clipped; got:\n%s", out)
	}
	// The footers and the legend survive below it.
	for _, want := range []string{"withheld: 1 settling", "i/esc close"} {
		if !strings.Contains(out, want) {
			t.Errorf("clipping must keep %q on screen; got:\n%s", want, out)
		}
	}
	if n := strings.Count(out, "\n"); n > m.height {
		t.Errorf("view rendered %d lines for a %d-row terminal:\n%s", n, m.height, out)
	}
}

// GH-2319: the hotkey legend wraps at a narrow pane instead of truncating —
// one whole hint per break, every verb still on screen, and the body shrinks
// by exactly the rows the legend grew.
func TestLegendWrapsWholeHintsWhenNarrow(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width, m.height = 60, 30
	lines := legendLines(m)
	if len(lines) < 2 {
		t.Fatalf("a 60-col pane must wrap the browse legend; got %d line(s): %q", len(lines), lines)
	}
	for _, l := range lines {
		if lipgloss.Width(l) > m.width {
			t.Errorf("legend row overflows %d cols: %q", m.width, l)
		}
	}
	if got := strings.Join(lines, legendSep); got != legend(m) {
		t.Errorf("wrapping must lose no hint and split none:\n got %q\nwant %q", got, legend(m))
	}
}

func TestLegendStaysOneLineWhenWide(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width, m.height = 220, 30
	if lines := legendLines(m); len(lines) != 1 || lines[0] != legend(m) {
		t.Errorf("a wide pane keeps the one-line legend; got %q", lines)
	}
}

func TestLegendCapMarksDroppedHints(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width, m.height = 18, 30
	lines := legendLines(m)
	if len(lines) != maxLegendRows {
		t.Fatalf("legend must cap at %d rows; got %d", maxLegendRows, len(lines))
	}
	if !strings.HasSuffix(lines[len(lines)-1], "…") {
		t.Errorf("a capped legend must say hints were dropped; last row %q", lines[len(lines)-1])
	}
	for _, l := range lines {
		if lipgloss.Width(l) > m.width {
			t.Errorf("legend row overflows %d cols: %q", m.width, l)
		}
	}
}

func TestNarrowViewKeepsWrappedLegendInsideTerminalHeight(t *testing.T) {
	m := testModel(&fakeRunner{})
	// 60×24 is the Codex counter-example on #2330: it fit before the wrap
	// and overran after, until the body budget reserved its overhead rows.
	m.width, m.height = 60, 24
	var cards []Card
	for i := 0; i < 12; i++ {
		cards = append(cards, card(400+i, "In Progress", fmt.Sprintf("Card%d", i)))
	}
	m.cols = [3][]Card{cards, nil, nil}
	m.status = "status here"
	if got := headerRows + bodyHeightOf(m) + footerRowsOf(m); got != m.height {
		t.Errorf("header+body+footer = %d, want the %d-row terminal", got, m.height)
	}
	if fr := footerRowsOf(m); fr != len(legendLines(m))+1 || fr < 3 {
		t.Errorf("footer rows = %d for a %d-line legend", fr, len(legendLines(m)))
	}
	out := viewModel(m)
	lines := strings.Split(out, "\n")
	if len(lines) > m.height {
		t.Errorf("view rendered %d lines for a %d-row terminal:\n%s", len(lines), m.height, out)
	}
	if last := lines[len(lines)-1]; !strings.Contains(last, "status here") {
		t.Errorf("status line must stay the last row; got %q", last)
	}
	if !strings.Contains(out, "q quit") || !strings.Contains(out, "h/l col") {
		t.Errorf("both ends of the legend must survive the wrap:\n%s", out)
	}
	// Body sizing and mouse mapping share footerRowsOf, so a click still lands
	// on the card it renders over.
	start, end := colWindow(m, 0, bodyHeightOf(m))
	for i := start; i < end; i++ {
		y := headerRows + colHeaderRows + (i-start)*cardRows
		if !strings.Contains(lines[y], fmt.Sprintf("#%d", cards[i].Number)) {
			t.Errorf("y=%d should render card #%d; got %q", y, cards[i].Number, lines[y])
		}
		if c, r, ok := hitTest(m, 5, y); !ok || c != 0 || r != i {
			t.Errorf("hitTest(5,%d) = (%d,%d,%v), want (0,%d,true)", y, c, r, ok, i)
		}
	}
}

// The frame must fit the terminal at EVERY height, not the lucky parity: the
// "+N more" line and the separator used to ride the rounding slack of the
// card division, so half of all heights overran by two rows whenever a column
// hid cards (measured on main: 120×14 rendered 16 lines). The wrapped legend
// (GH-2319) moved which heights those were; this pins that none are left.
func TestViewFitsTerminalAtEveryHeight(t *testing.T) {
	for _, w := range []int{60, 120, 200} {
		for h := 12; h <= 40; h++ {
			for _, withheld := range []string{"", "2 settling"} {
				m := testModel(&fakeRunner{})
				m.width, m.height = w, h
				m.cols = manyCards()
				m.showInbox, m.inboxOK, m.inboxWithheld = withheld != "", true, withheld
				m.col, m.row = 0, 7 // scrolled: both "↑N above" and "+N more" render
				m.clampCursor()
				if headerRows+bodyHeightOf(m)+withheldRows(m)+footerRowsOf(m) > h {
					continue // below the one-card floor: the floor wins by design
				}
				out := viewModel(m)
				if n := len(strings.Split(out, "\n")); n > h {
					t.Errorf("%dx%d withheld=%q: rendered %d lines:\n%s", w, h, withheld, n, out)
				}
			}
		}
	}
}
