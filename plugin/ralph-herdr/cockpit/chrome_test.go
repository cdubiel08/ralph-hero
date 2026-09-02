// chrome_test.go — the v2 chrome (GH-2379): the liveness spinner and its
// stale verdict, the typed status line, the in-flight column headers, and
// the footer pinned to the bottom with the contextual legend (spec §6, §9,
// §10). The legend table is pinned row by row, and every row is checked
// against the verbs' own refusals, since that agreement is the point.
package main

import (
	"strings"
	"testing"
	"time"
)

func hintsOf(hs []verbHint) string {
	parts := make([]string, 0, len(hs))
	for _, h := range hs {
		parts = append(parts, h.key+" "+h.label)
	}
	return strings.Join(parts, legendSep)
}

// TestLegendRowPerSelectionKind pins spec §9's table. `e epic` is absent on
// purpose: the verb lands in unit 5, and a legend entry for a key that does
// nothing is exactly the disagreement this unit removes.
func TestLegendRowPerSelectionKind(t *testing.T) {
	base := func() Model {
		m := testModel(&fakeRunner{})
		m.cols[0] = append(m.cols[0], card(13, "In Progress", "Thirteen"))
		m.agents = setAgents([]Agent{
			{Name: "w10-ten", Status: "working", Pane: "p1", Issue: 10, Lane: "w"},
			{Name: "w13-a", Status: "working", Pane: "p3", Issue: 13, Lane: "w"},
			{Name: "o13-b", Status: "working", Pane: "p4", Issue: 13, Lane: "o"},
			{Name: "w30-thirty", Status: "blocked", Pane: "p2", Issue: 30, Lane: "w"},
		})
		return m
	}
	cases := []struct {
		name string
		prep func(m *Model)
		want string
	}{
		{"In Progress, one live agent", func(m *Model) { m.col, m.row = 0, 0 },
			"⏎ observe · ␣ peek · r reply · f fork · d diff · g browser"},
		{"In Progress, no live agent", func(m *Model) { m.col, m.row = 0, 1 },
			"s spawn · d diff · g browser"},
		{"In Progress, fleet ≥ 2", func(m *Model) { m.col, m.row = 0, 3 },
			"⏎ observe w-lane · ␣ peek · r reply · d diff · g browser"},
		{"In Review, no live agent", func(m *Model) { m.col, m.row = 1, 0 },
			"d diff · s spawn · g browser"},
		{"Human Needed, blocked agent up", func(m *Model) { m.col, m.row = 2, 0 },
			"a answer · r reply · ⏎ observe · ␣ peek · g browser"},
		{"Human Needed, no session", func(m *Model) { m.col, m.row = 2, 1 },
			"a answer · g browser"},
		{"Done", func(m *Model) {
			m.showDone, m.doneOK = true, true
			m.doneCards = []Card{{Number: 90, State: doneState, Title: "Ninety"}}
			m.col, m.row = 2, 0
		}, "g browser · d diff · D back to Human Needed"},
		{"Inbox decision", func(m *Model) {
			m.showInbox, m.inboxOK = true, true
			m.inboxCards = []Card{{Number: 91, State: inboxState, Queue: "decision", Verb: "board answer 91 -m"}}
			m.col, m.row = 2, 0
		}, "a answer · g browser"},
		{"Inbox proposal", func(m *Model) {
			m.showInbox, m.inboxOK = true, true
			m.inboxCards = []Card{{Number: 92, State: inboxState, Queue: "proposal", Verb: "board resolve 92 --accept"}}
			m.col, m.row = 2, 0
		}, "g browser"},
		{"no herdr, In Progress", func(m *Model) { m.herdrOK = false; m.agents = nil; m.col, m.row = 0, 0 },
			"d diff · g browser"},
		{"no herdr, Human Needed still answers", func(m *Model) { m.herdrOK = false; m.agents = nil; m.col, m.row = 2, 0 },
			"a answer · g browser"},
		{"one live agent with no pane hides fork", func(m *Model) {
			m.agents = setAgents([]Agent{{Name: "w10-ten", Status: "working", Issue: 10, Lane: "w"}})
			m.col, m.row = 0, 0
		}, "⏎ observe · ␣ peek · r reply · d diff · g browser"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := base()
			c.prep(&m)
			m.clampCursor()
			sel, ok := m.selectedCard()
			if !ok {
				t.Fatal("no card selected")
			}
			if got := hintsOf(cardVerbs(m, sel)); got != c.want {
				t.Errorf("row 1 = %q\nwant     %q", got, c.want)
			}
			// Every listed verb must be one its own key would run, and every
			// hidden one must be one its key would refuse.
			verbs := map[string]func(Model, Card) (statusKind, string){
				"⏎": refuseObserve, "␣": refusePeek, "r": refuseReply, "f": refuseFork, "s": refuseSpawn,
				"a": func(_ Model, c Card) (statusKind, string) { return refuseAnswer(c) },
			}
			shown := map[string]bool{}
			for _, h := range cardVerbs(m, sel) {
				shown[h.key] = true
			}
			for key, refuse := range verbs {
				kind, _ := refuse(m, sel)
				if shown[key] && kind != statusNone {
					t.Errorf("legend lists %q but the verb refuses", key)
				}
				if !shown[key] && kind == statusNone {
					for _, h := range legendTable(m, sel) {
						if h.key == key {
							t.Errorf("legend hides %q though the verb would run", key)
						}
					}
				}
			}
		})
	}
}

func TestLegendRowWithoutACard(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.cols = [3][]Card{}
	m.clampCursor()
	if got := stripANSI(legendLines(m)[0]); got != "(no card — views only)" {
		t.Errorf("row 1 = %q", got)
	}
}

// TestFooterPinnedToTheBottomAtThreeHeights: the last rows of the pane are
// the legend and the status line whatever the body holds — a short column
// pads, it does not float.
func TestFooterPinnedToTheBottomAtThreeHeights(t *testing.T) {
	for _, h := range []int{18, 30, 50} {
		for _, short := range []bool{true, false} {
			m := testModel(&fakeRunner{})
			m.width, m.height = 200, h
			if !short {
				m.cols = manyCards()
			}
			m.say(statusOK, "delivered to w10-ten")
			out := viewModel(m)
			lines := strings.Split(out, "\n")
			if len(lines) != h {
				t.Errorf("h=%d short=%v: rendered %d lines, want exactly the pane height:\n%s", h, short, len(lines), out)
				continue
			}
			if got := stripANSI(lines[h-1]); got != "✓ delivered to w10-ten" {
				t.Errorf("h=%d short=%v: last row must be the status line; got %q", h, short, got)
			}
			if got := stripANSI(lines[h-2]); !strings.HasPrefix(got, "h/l j/k move") {
				t.Errorf("h=%d short=%v: row -2 must be the navigation row; got %q", h, short, got)
			}
			if got := stripANSI(lines[h-3]); !strings.HasPrefix(got, "on #") {
				t.Errorf("h=%d short=%v: row -3 must be the card verbs; got %q", h, short, got)
			}
			if got := headerRows + bodyHeightOf(m) + footerRowsOf(m); got != h {
				t.Errorf("h=%d: header+body+footer = %d", h, got)
			}
		}
	}
}

func TestFooterPinnedUnderAnOverlay(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width, m.height = 120, 30
	m.mode = ModePeek
	m.peekWho, m.peekText = "w10-ten", "one line"
	lines := strings.Split(viewModel(m), "\n")
	if len(lines) != m.height {
		t.Fatalf("rendered %d lines for a %d-row pane", len(lines), m.height)
	}
	if got := stripANSI(lines[m.height-2]); got != "esc close" {
		t.Errorf("overlay legend must sit on row -2; got %q", got)
	}
}

// TestHeaderSpinnerAdvancesThenGoesStale: the spinner turns once per poll
// that lands whole, stops on a failed one and goes amber with the age of the
// last whole poll; an overdue poll reads the same way.
func TestHeaderSpinnerAdvancesThenGoesStale(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width = 220
	first := m.spinner()
	m, _ = updateModel(m, boardOf(m))
	if m.spinner() == first {
		t.Fatal("a whole poll must advance the spinner")
	}
	if m.lastGoodPoll.IsZero() {
		t.Fatal("a whole poll must stamp lastGoodPoll")
	}
	live := stripANSI(liveness(m, m.lastGoodPoll.Add(10*time.Second)))
	if live != m.spinner() {
		t.Errorf("on cadence the header shows the spinner; got %q", live)
	}

	// Overdue: past the cadence plus one tick (60 s here), no failure recorded.
	late := m.lastGoodPoll.Add(4 * time.Minute)
	if got := stripANSI(liveness(m, late)); got != "◍ stale 4m" {
		t.Errorf("an overdue poll must read stale with the age; got %q", got)
	}

	// Failed: the spinner stops (frame unchanged) and the verdict is stale
	// from the LAST WHOLE poll, not from the failure.
	frame := m.spinner()
	failed := boardMsg{failed: [3]bool{false, true, false}, err: "In Review: timeout"}
	m, _ = updateModel(m, failed)
	if m.spinner() != frame {
		t.Error("a failed poll must not advance the spinner")
	}
	if got := stripANSI(liveness(m, m.lastGoodPoll.Add(90*time.Second))); got != "◍ stale 1m" {
		t.Errorf("a failed poll reads stale on the last whole poll's age; got %q", got)
	}
	// Recovery: the next whole poll turns the spinner again.
	m, _ = updateModel(m, boardOf(m))
	if m.spinner() == frame {
		t.Error("recovery must advance the spinner")
	}
	if got := stripANSI(liveness(m, m.lastGoodPoll)); got != m.spinner() {
		t.Errorf("after recovery the header shows the spinner; got %q", got)
	}
}

func TestHeaderBeforeAnyPoll(t *testing.T) {
	m := testModel(&fakeRunner{})
	if got := stripANSI(liveness(m, time.Now())); got != m.spinner() {
		t.Errorf("the first poll still out is alive, not stale; got %q", got)
	}
	m, _ = updateModel(m, boardMsg{failed: [3]bool{true, true, true}, err: "exit 75"})
	if got := stripANSI(liveness(m, time.Now())); got != "◍ stale · no poll has landed" {
		t.Errorf("a first poll that failed has no age to show and must say so; got %q", got)
	}
}

// TestColumnHeaderCarriesItsReadState: a spinner left of the count while the
// column's read is out, `stale Nm` when the last read failed and the cards
// are the last good ones, nothing when current. The third column answers for
// whichever read it shows.
func TestColumnHeaderCarriesItsReadState(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width = 220
	m, _ = updateModel(m, boardOf(m))
	now := m.lastGoodPoll
	for i := 0; i < 3; i++ {
		if got := columnFlight(m, i, now); got != "" {
			t.Errorf("column %d current must carry no note; got %q", i, stripANSI(got))
		}
	}
	m.pollInFlight = true
	if got := stripANSI(columnFlight(m, 0, now)); got != m.spinner() {
		t.Errorf("in flight = %q, want the spinner", got)
	}
	m.pollInFlight = false
	m, _ = updateModel(m, boardMsg{failed: [3]bool{false, true, false}, err: "In Review: timeout"})
	at := m.colGoodAt[1].Add(4 * time.Minute)
	if got := stripANSI(columnFlight(m, 1, at)); got != "stale 4m" {
		t.Errorf("failed column = %q, want stale 4m", got)
	}
	if got := columnFlight(m, 0, at); got != "" {
		t.Errorf("a column that read fine is current; got %q", stripANSI(got))
	}
	// The rendered header carries it left of the count.
	head := strings.Split(stripANSI(viewModel(m)), "\n")[2]
	if !strings.Contains(head, "stale") || strings.Index(head, "stale") > strings.Index(head, " 1") {
		t.Errorf("stale must sit left of the count in the header row: %q", head)
	}
	// A read still out outranks the stale verdict — the cure is in flight.
	m.pollInFlight = true
	if got := stripANSI(columnFlight(m, 1, at)); got != m.spinner() {
		t.Errorf("in flight over stale = %q, want the spinner", got)
	}

	// Third column: Done and Inbox views answer for their own reads.
	m.pollInFlight = false
	m.showDone, m.doneInFlight = true, true
	if got := stripANSI(columnFlight(m, 2, at)); got != m.spinner() {
		t.Errorf("Done in flight = %q", got)
	}
	m.doneInFlight = false
	m, _ = updateModel(m, doneMsg{ok: true, cards: nil, windowDays: 14})
	m, _ = updateModel(m, doneMsg{ok: false, err: "exit 75"})
	if got := stripANSI(columnFlight(m, 2, m.doneGoodAt.Add(2*time.Minute))); got != "stale 2m" {
		t.Errorf("Done failed after a good read = %q, want stale 2m", got)
	}
	m.showDone, m.showInbox = false, true
	m, _ = updateModel(m, inboxMsg{ok: false, err: "exit 75"})
	if got := stripANSI(columnFlight(m, 2, at)); got != "stale" {
		t.Errorf("Inbox failed with no good read yet = %q, want a bare stale", got)
	}
}

// TestStatusLineIsTypedByItsGlyph pins spec §10's glyph per kind, and that
// the text itself stays plain.
func TestStatusLineIsTypedByItsGlyph(t *testing.T) {
	m := testModel(&fakeRunner{})
	cases := []struct {
		kind statusKind
		text string
		want string
	}{
		{statusFlight, "spawning a work session for #11…", m.spinner() + " spawning a work session for #11…"},
		{statusOK, "delivered to w10-ten", "✓ delivered to w10-ten"},
		{statusRefuse, `#20 is "In Review" — a answers Human Needed cards`, `✗ #20 is "In Review" — a answers Human Needed cards`},
		{statusNudge, "no live agent for #11 — s spawns one", "● no live agent for #11 — s spawns one"},
		{statusView, "third column: Human Needed", "· third column: Human Needed"},
		{statusNone, "", ""},
	}
	for _, c := range cases {
		m.say(c.kind, c.text)
		if got := stripANSI(statusLine(m)); got != c.want {
			t.Errorf("kind %d: %q, want %q", c.kind, got, c.want)
		}
		if m.status != c.text {
			t.Errorf("the stored text must stay plain; got %q", m.status)
		}
	}
}

// TestVerbsTypeTheirOwnStatus: a refusal is ✗ with the reason verbatim, a
// nudge is ●, a dispatch is the spinner — set by the verbs themselves.
func TestVerbsTypeTheirOwnStatus(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.col, m.row = 1, 0 // #20 In Review, no agent
	m, _ = updateModel(m, keyMsg("a"))
	if m.statusKind != statusRefuse || !strings.Contains(m.status, "a answers Human Needed cards") {
		t.Errorf("a on In Review: kind %d, %q", m.statusKind, m.status)
	}
	m, _ = updateModel(m, keyMsg("enter"))
	if m.statusKind != statusNudge || !strings.Contains(m.status, "s spawns one") {
		t.Errorf("observe with no agent: kind %d, %q", m.statusKind, m.status)
	}
	m, _ = updateModel(m, keyMsg("s"))
	if m.statusKind != statusFlight || !strings.HasPrefix(m.status, "spawning a work session for #20") {
		t.Errorf("spawn: kind %d, %q", m.statusKind, m.status)
	}
	m, _ = updateModel(m, keyMsg("D"))
	if m.statusKind != statusView {
		t.Errorf("a view change is dim: kind %d, %q", m.statusKind, m.status)
	}
	m, _ = updateModel(m, statusMsg{kind: statusOK, text: "observing w10-ten (herdr focus)"})
	if got := stripANSI(statusLine(m)); got != "✓ observing w10-ten (herdr focus)" {
		t.Errorf("a typed fetch result renders its glyph; got %q", got)
	}
}
