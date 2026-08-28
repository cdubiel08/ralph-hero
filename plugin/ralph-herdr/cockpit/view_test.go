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

func TestTrimMiddleKeepsRepoAndTail(t *testing.T) {
	addr := "ralph-hero/t2208-herd-topology/w2210-topology-b-canonical"
	// Fits: unchanged.
	if got := trimMiddle(addr, 100); got != addr {
		t.Errorf("fitting address changed: %q", got)
	}
	// Middle-truncated: repo prefix and tail both survive, width exact.
	got := trimMiddle(addr, 30)
	if w := lipgloss.Width(got); w > 30 {
		t.Errorf("width = %d, want <= 30", w)
	}
	if !strings.HasPrefix(got, "ralph-hero/…") {
		t.Errorf("repo prefix lost: %q", got)
	}
	if !strings.HasSuffix(got, "-canonical") {
		t.Errorf("tail lost: %q", got)
	}
	// No slash: degrades to trimTo.
	if got := trimMiddle(strings.Repeat("x", 40), 10); got != trimTo(strings.Repeat("x", 40), 10) {
		t.Errorf("slashless fallback = %q", got)
	}
	// Budget too small for prefix + tail: degrades to trimTo, never a bare tail.
	if got := trimMiddle(addr, 8); got != trimTo(addr, 8) {
		t.Errorf("tiny-budget fallback = %q", got)
	}
}

func TestCardTitleIsAddressWhenKnown(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.agents = setAgents([]Agent{
		{Name: "w10-ten", Status: "working", Pane: "p1", Issue: 10, Lane: "w",
			Address: "repo/t9-epic/w10-ten"},
	})
	out := viewModel(m)
	if !strings.Contains(out, "repo/t9-epic/w10-ten") {
		t.Error("card with a known agent address must render the address as its title")
	}
	// A card with no agent keeps its issue title.
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
	// bodyHeight 14 → visible = (14-2)/cardRows = 3.
	const bh = 14
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
	m.width, m.height = 120, 14 // bodyHeight 10 → visible = 2
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
	m.width, m.height = 120, 14 // visible = 2
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
