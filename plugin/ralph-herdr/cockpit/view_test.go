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
	styled := styleSelected.Render(strings.Repeat("wide title ", 10))
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

func TestViewTinySizeDoesNotPanic(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width, m.height = 10, 3
	_ = viewModel(m) // clipping paths must hold
	m.width, m.height = 0, 0
	_ = viewModel(m)
}

func TestColWindowFollowsCursor(t *testing.T) {
	// bodyHeight 11 → visible = (11-2)/3 = 3.
	const bh = 11
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
	m.width, m.height = 120, 13 // bodyHeight 9 → visible = 2
	var cards []Card
	for i := 0; i < 8; i++ {
		cards = append(cards, card(200+i, "In Progress", fmt.Sprintf("Deep%d", i)))
	}
	m.cols[0] = cards
	m.row = 6 // past the fold — window must be [5,7)
	out := viewModel(m)
	if !strings.Contains(out, "#206") || !strings.Contains(out, "▸") {
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
	m.width, m.height = 120, 13 // visible = 2
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
