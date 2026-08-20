// cardsignals_test.go — the board-sourced card markings (GH-2062): the PR
// chip, the epic rollup, and the Done window.
//
// One theme runs through all of it, and it is the reason this half was split
// from GH-2061's machine-local markings: these readings can FAIL, and a
// marking that renders like a value when the read failed is worse than no
// marking at all. So every assertion here is some form of "unread and empty
// must not look alike".
package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestCardSignalsArgv(t *testing.T) {
	if got := argsCardSignals(); len(got) != 2 || got[0] != "card-signals" || got[1] != "--json" {
		t.Errorf("argsCardSignals() = %v", got)
	}
	if got := argsBoardClosed(); len(got) != 2 || got[0] != "closed" || got[1] != "--json" {
		t.Errorf("argsBoardClosed() = %v", got)
	}
}

func TestPrFateNeverGreensWhatItCannotSee(t *testing.T) {
	tests := []struct {
		name                        string
		state                       string
		merged                      bool
		checks, mergeable, wantFate string
	}{
		{"merged by state", "MERGED", true, "SUCCESS", "UNKNOWN", PRFateMerged},
		{"merged flag alone still merged", "OPEN", true, "", "", PRFateMerged},
		{"closed unmerged", "CLOSED", false, "SUCCESS", "UNKNOWN", PRFateClosed},
		{"open, green, mergeable", "OPEN", false, "SUCCESS", "MERGEABLE", PRFateReady},
		// GitHub recomputes mergeability lazily and answers UNKNOWN meanwhile.
		// Demoting on it would flap a green chip to amber for no reason a human
		// could act on, so only CONFLICTING demotes.
		{"open, green, mergeability not yet computed", "OPEN", false, "SUCCESS", "UNKNOWN", PRFateReady},
		{"open, green, conflicted", "OPEN", false, "SUCCESS", "CONFLICTING", PRFatePending},
		{"open, checks running", "OPEN", false, "PENDING", "MERGEABLE", PRFatePending},
		{"open, checks failing", "OPEN", false, "FAILURE", "MERGEABLE", PRFatePending},
		// The load-bearing one: NO rollup at all (no check has run) must never
		// be read as a clean one. Green requires the positive fact.
		{"open, no rollup", "OPEN", false, "", "MERGEABLE", PRFatePending},
	}
	for _, tc := range tests {
		if got := prFate(tc.state, tc.merged, tc.checks, tc.mergeable); got != tc.wantFate {
			t.Errorf("%s: prFate = %q, want %q", tc.name, got, tc.wantFate)
		}
	}
}

func TestParseCardSignalsRefusesAPayloadThatCannotAnswer(t *testing.T) {
	// Every one of these decodes to nil slices, and rendering nil as "no card
	// has a PR" is the confident lie the grey `?` exists to prevent.
	for _, raw := range []string{`{}`, `null`, `{"inReview":null,"epics":[]}`, `{"inReview":[]}`, `not json`} {
		if _, _, err := parseCardSignals(raw); err == nil {
			t.Errorf("parseCardSignals(%q) accepted a payload that cannot answer", raw)
		}
	}
	// A well-formed EMPTY read is a real answer and must be accepted.
	prs, epics, err := parseCardSignals(`{"inReview":[],"epics":[]}`)
	if err != nil || len(prs) != 0 || len(epics) != 0 {
		t.Errorf("an empty but well-formed read must parse: %v %v %v", prs, epics, err)
	}
}

func TestParseCardSignalsKeepsNoPRApartFromNotRead(t *testing.T) {
	prs, epics, err := parseCardSignals(`{
	  "inReview": [
	    {"number": 20, "prs": []},
	    {"number": 21, "prs": [{"number": 2049, "state": "MERGED", "merged": true, "checks": "SUCCESS", "mergeable": "UNKNOWN"}]},
	    {"number": 22}
	  ],
	  "epics": [{"number": 1994, "title": "Epic: cockpit", "done": 2, "total": 4, "truncated": true}]
	}`)
	if err != nil {
		t.Fatal(err)
	}
	// Present with no PR: a real, ordinary state.
	if m, ok := prs[20]; !ok || m.Fate != PRFateNone {
		t.Errorf("#20 = %+v, ok=%v — an item read to have no PR must say so", m, ok)
	}
	if m := prs[21]; m.Number != 2049 || m.Fate != PRFateMerged {
		t.Errorf("#21 = %+v, want pr 2049 merged", m)
	}
	// A row whose `prs` key is ABSENT never answered. It must stay out of the
	// map — one level down, the same hazard the whole-payload check covers.
	if _, ok := prs[22]; ok {
		t.Error("#22 answered nothing about its PRs and must not be marked")
	}
	e := epics[1994]
	if e.Done != 2 || e.Total != 4 || !e.Truncated || e.Title != "Epic: cockpit" {
		t.Errorf("epic = %+v", e)
	}
}

func TestChipPrefersTheLivePRThenTheNewest(t *testing.T) {
	// Several linked PRs is the respawn/reopen shape. The operator acts on the
	// OPEN one; among equals the newest wins.
	prs, _, err := parseCardSignals(`{
	  "inReview": [{"number": 20, "prs": [
	    {"number": 100, "state": "CLOSED", "merged": false},
	    {"number": 101, "state": "MERGED", "merged": true},
	    {"number": 102, "state": "OPEN", "merged": false, "checks": "SUCCESS", "mergeable": "MERGEABLE"}
	  ]}],
	  "epics": []
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if m := prs[20]; m.Number != 102 || m.Fate != PRFateReady {
		t.Errorf("chip = %+v, want the open PR 102", m)
	}

	// With no open PR, merged outranks closed-unmerged: the issue landed.
	prs, _, _ = parseCardSignals(`{
	  "inReview": [{"number": 20, "prs": [
	    {"number": 100, "state": "CLOSED", "merged": false},
	    {"number": 101, "state": "MERGED", "merged": true}
	  ]}],
	  "epics": []
	}`)
	if m := prs[20]; m.Number != 101 || m.Fate != PRFateMerged {
		t.Errorf("chip = %+v, want the merged PR 101", m)
	}
}

func TestPrChipDrawsUnreadAndNoPRDifferently(t *testing.T) {
	m := testModel(&fakeRunner{})
	card := Card{Number: 20, State: "In Review"}

	// Before any successful read — and after a failed one — every chip is `?`.
	if got := prChip(m, card, asciiGlyphs); !strings.Contains(got, "?") {
		t.Errorf("an unread chip = %q, want a ?", got)
	}

	m.signalsOK = true
	m.prs = map[int]PRMark{20: {Fate: PRFateNone}}
	if got := prChip(m, card, asciiGlyphs); got != "" {
		t.Errorf("an item read to have no PR = %q, want nothing at all", got)
	}
	// An issue the successful read did not cover is still unread, not PR-less.
	if got := prChip(m, Card{Number: 99, State: "In Review"}, asciiGlyphs); !strings.Contains(got, "?") {
		t.Errorf("an uncovered issue = %q, want a ?", got)
	}

	m.prs = map[int]PRMark{20: {Number: 2049, Fate: PRFateMerged}}
	if got := prChip(m, card, asciiGlyphs); !strings.Contains(got, "#2049") || strings.Contains(got, "?") {
		t.Errorf("a merged chip = %q, want #2049 and no ?", got)
	}
}

func TestFailedSignalsReadDropsTheMarksRatherThanKeepingThemGreen(t *testing.T) {
	m := testModel(&fakeRunner{})
	m, _ = updateModel(m, signalsMsg{
		ok:    true,
		prs:   map[int]PRMark{20: {Number: 2049, Fate: PRFateReady}},
		epics: map[int]EpicRollup{},
	})
	if _, ok := m.cardPR(20); !ok {
		t.Fatal("a successful read must mark the card")
	}

	// The board columns KEEP their last good cards on a failed read, because a
	// card is the work. A marking is a claim about right now, so it does not
	// survive: a green chip drawn off a read that has since failed is exactly
	// the "nobody looked" failure this unit exists to prevent.
	m, _ = updateModel(m, signalsMsg{err: "timed out after 25s (cockpit board-read deadline)"})
	if _, ok := m.cardPR(20); ok {
		t.Error("a failed markings read must send every chip back to unread")
	}
	if len(m.cols[1]) == 0 {
		t.Error("a failed MARKINGS read must never cost a board column its cards")
	}
	// And it must be visible on a board that has no In Review card to carry a
	// `?` for it.
	if !strings.Contains(viewModel(m), "card markings unread") {
		t.Errorf("a failed markings read must reach the banner:\n%s", viewModel(m))
	}
}

// A failed REFRESH over a non-empty list is the case the in-column empty
// states cannot cover: they only speak when the column is empty, so the last
// good cards would sit there with their count looking current. Found by Codex
// on this PR — the unit's own rule turned back on it.
func TestAStaleDoneWindowNeverLooksCurrent(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.width, m.height = 160, 40
	m, _ = updateKey(m, keyMsg("D"))
	m, _ = updateModel(m, doneMsg{ok: true, windowDays: 14, cards: []Card{
		{Number: 2061, State: doneState, Title: "landed", ClosedAt: time.Now().Add(-time.Hour).Format(time.RFC3339)},
	}})
	if !strings.Contains(viewModel(m), "#2061") {
		t.Fatal("a good read must render its cards")
	}

	m, _ = updateModel(m, doneMsg{err: "timed out after 25s (cockpit board-read deadline)"})
	out := viewModel(m)
	// The cards STAY — a closed-issue list is history, and losing it to one
	// transient timeout costs more than it protects. What may not stay is the
	// impression that it is current.
	if !strings.Contains(out, "#2061") {
		t.Error("a transient failure must not discard the last good window")
	}
	if !strings.Contains(out, "stale") || !strings.Contains(out, "timed out") {
		t.Errorf("a stale window must say so and name the cause:\n%s", out)
	}
	// ...and it must go quiet again once the column is not on screen.
	m, _ = updateKey(m, keyMsg("D"))
	if strings.Contains(viewModel(m), "stale") {
		t.Error("a hidden Done column must not shout about its stale read")
	}
}

func TestEpicChipDegradesOneStepAtATime(t *testing.T) {
	m := testModel(&fakeRunner{})
	card := Card{Number: 20, State: "In Review", ParentNumber: 1994}

	if got := epicChip(m, Card{Number: 20}, asciiGlyphs, 60); got != "" {
		t.Errorf("a card with no parent = %q, want nothing", got)
	}
	// No rollup read: the bare parent number GH-2061 already rendered. A
	// denominator we could not read must not be invented.
	got := epicChip(m, card, asciiGlyphs, 60)
	if !strings.Contains(got, "#1994") {
		t.Errorf("unrolled epic = %q, want the bare parent number", got)
	}
	if strings.Contains(got, "/") {
		t.Errorf("unrolled epic = %q, must not carry a tally", got)
	}

	m.signalsOK = true
	m.epics = map[int]EpicRollup{1994: {Number: 1994, Title: "Epic: cockpit", Done: 2, Total: 4}}
	got = epicChip(m, card, asciiGlyphs, 60)
	if !strings.Contains(got, "Epic: cockpit") || !strings.Contains(got, "2/4") {
		t.Errorf("rolled epic = %q, want the name and 2/4", got)
	}

	// A truncated child list is a FLOOR, not a total.
	m.epics = map[int]EpicRollup{1994: {Number: 1994, Title: "Epic: cockpit", Done: 2, Total: 50, Truncated: true}}
	if got := epicChip(m, card, asciiGlyphs, 60); !strings.Contains(got, "2/50+") {
		t.Errorf("truncated rollup = %q, want a 2/50+ floor", got)
	}
}

// The epic name is the only variable-length thing on line 3, and the age chip
// beside it is right-justified by `pad`, which cannot push back. Caught by
// rendering a real board rather than by a test: a full-length parent name ran
// straight into the timer and produced `…redesign 2/41h 3` — two facts, one
// unreadable string.
func TestALongEpicNameNeverEatsTheAgeChip(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.ledger = Ledger{Read: true, ByRef: map[string]LedgerSpawn{
		"w10-ten#a": {Ref: "w10-ten#a", Issue: 10, SpawnedAt: time.Now().Add(-95 * time.Minute)},
	}}
	m.agents = setAgents([]Agent{{Name: "w10-ten", Status: "working", Issue: 10, Lane: "w", Root: "w10-ten#a"}})
	m.signalsOK = true
	m.epics = map[int]EpicRollup{
		1994: {Number: 1994, Title: strings.Repeat("a very long epic name ", 10), Done: 2, Total: 4},
	}
	card := Card{Number: 10, State: "In Progress", Title: "t", Priority: "P1", Estimate: "M", ParentNumber: 1994}

	for _, width := range []int{24, 40, 60, 120, 200} {
		line3 := strings.Split(renderCard(m, 1, 1, card, width), "\n")[2]
		if !strings.HasSuffix(strings.TrimRight(line3, " "), "1h 35m") {
			t.Errorf("w=%d: the age chip must survive intact at the right edge; got %q", width, line3)
		}
	}
	// Budget spent in order of usefulness: number, then tally, then name.
	if got := epicChip(m, card, asciiGlyphs, 8); !strings.Contains(got, "#1994") || strings.Contains(got, "2/4") {
		t.Errorf("a tight budget = %q, want the bare parent number", got)
	}
	if got := epicChip(m, card, asciiGlyphs, 4); got != "" {
		t.Errorf("a budget too small for the number = %q, want nothing — a fragment reads as another issue", got)
	}
}

func TestParseClosedRefusesAPayloadWithNoItemsArray(t *testing.T) {
	for _, raw := range []string{`{}`, `null`, `{"windowDays":14}`, `{"items":null}`, `nope`} {
		if _, _, err := parseClosed(raw); err == nil {
			t.Errorf("parseClosed(%q) read a malformed payload as an empty window", raw)
		}
	}
	cards, days, err := parseClosed(`{"windowDays":14,"items":[
	  {"number":2061,"repo":"o/r","title":"Cockpit","closedAt":"2026-08-17T04:29:06Z"}
	]}`)
	if err != nil || days != 14 || len(cards) != 1 {
		t.Fatalf("cards=%v days=%d err=%v", cards, days, err)
	}
	// The card must be recognisable as Done by the same verbatim state test
	// every other card uses — that is what routes it away from the priority
	// meter and away from the spawn verb.
	if cards[0].State != doneState || cards[0].ClosedAt == "" || cards[0].Repo != "o/r" {
		t.Errorf("closed card = %+v", cards[0])
	}
}

// A board CLI that predates card-signals refuses the subcommand, and the
// cockpit rendered that refusal indistinguishably from a rate limit — every
// chip UNREAD, cause undiagnosable from the screen (GH-2073, observed
// 2026-08-18). The skew must be named: the resolved path, its version when
// the path carries one, and the remedy.
func TestStaleBoardCLIIsNamedNotRenderedAsATransientFailure(t *testing.T) {
	// The verbatim refusal a pre-0.1.168 board.ts emits (measured on 0.1.167).
	refusal := "usage: unknown command \"card-signals\" — run `board help`"

	got := explainStaleBoardCLI("/home/u/.claude/plugins/cache/mp/ralph/0.1.150/scripts/board", refusal)
	for _, want := range []string{"predates card-signals", "0.1.168", "ralph 0.1.150", "/home/u/.claude/plugins/cache/mp/ralph/0.1.150/scripts/board", "/plugin", "RALPH_HERDR_BOARD"} {
		if !strings.Contains(got, want) {
			t.Errorf("skew diagnosis %q must carry %q", got, want)
		}
	}

	// A path with no version component still names itself — a guessed version
	// would be worse than none.
	got = explainStaleBoardCLI("/repo/ralph/scripts/board", refusal)
	if !strings.Contains(got, "/repo/ralph/scripts/board") || strings.Contains(got, "(ralph ") {
		t.Errorf("vendored-path diagnosis %q must name the path and invent no version", got)
	}

	// Anything that is not the usage refusal falls through to the ordinary
	// naming path: a rate limit, a timeout, a crash are NOT version skew.
	for _, combined := range []string{
		"API rate limit exceeded",
		"gh api graphql failed (exit 1)",
		"",
		"unknown command \"closed\" — run `board help`", // a different subcommand is a different bug
	} {
		if got := explainStaleBoardCLI("/any/board", combined); got != "" {
			t.Errorf("explainStaleBoardCLI(%q) = %q, want fall-through", combined, got)
		}
	}
}

// End to end: the skew diagnosis must reach signalsMsg.err, where the banner
// reads it — and a genuinely transient failure must keep its ordinary naming.
func TestFetchSignalsNamesTheSkewOnTheWireIn(t *testing.T) {
	boardPath := "/h/.claude/plugins/cache/mp/ralph/0.1.150/scripts/board"
	r := &fakeRunner{respond: func(prog string, args []string) (string, string, error) {
		if prog == boardPath && len(args) > 0 && args[0] == "card-signals" {
			return "", "usage: unknown command \"card-signals\" — run `board help`", errors.New("exit status 64")
		}
		return "", "", nil
	}}
	msg := fetchSignalsCmd(Config{Board: boardPath}, r)().(signalsMsg)
	if msg.ok {
		t.Fatal("a refused read must not report ok")
	}
	if !strings.Contains(msg.err, "predates card-signals") || !strings.Contains(msg.err, "ralph 0.1.150") {
		t.Errorf("signalsMsg.err = %q, want the named skew", msg.err)
	}

	r = &fakeRunner{respond: func(string, []string) (string, string, error) {
		return "", "boom", errors.New("exit status 1")
	}}
	msg = fetchSignalsCmd(Config{Board: boardPath}, r)().(signalsMsg)
	if strings.Contains(msg.err, "predates card-signals") {
		t.Errorf("a non-skew failure diagnosed as skew: %q", msg.err)
	}
}

func TestPluginPathVersionReadsOnlyTheCacheShape(t *testing.T) {
	tests := []struct{ path, want string }{
		{"/h/.claude/plugins/cache/mp/ralph/0.1.150/scripts/board", "0.1.150"},
		{"/h/.claude/plugins/cache/mp/ralph/10.20.3/scripts/board", "10.20.3"},
		// A vendored checkout: …/ralph/scripts/board has no version component.
		{"/repo/ralph/scripts/board", ""},
		// A repo directory named ralph must not read its child dir as a version.
		{"/h/ralph/main/scripts/board", ""},
		{"board", ""},
		{"", ""},
	}
	for _, tc := range tests {
		if got := pluginPathVersion(tc.path); got != tc.want {
			t.Errorf("pluginPathVersion(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}

func TestSignalsCadenceSkipsABoardWithNothingToMark(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.cols = [3][]Card{{card(10, "In Progress", "Ten")}, nil, nil}
	if m.signalsWanted() {
		t.Error("a board with no In Review card and no parented card has nothing to mark")
	}
	// A parent alone is enough — the rollup is the other half of this read.
	m.cols[0][0].ParentNumber = 1994
	if !m.signalsWanted() {
		t.Error("a parented card wants a rollup even with no In Review item")
	}

	m.cols = [3][]Card{nil, {card(20, "In Review", "Twenty")}, nil}
	now := time.Now()
	if !m.signalsDue(now) {
		t.Error("the first pass must be due")
	}
	m.lastSignals = now
	if m.signalsDue(now.Add(119 * time.Second)) {
		t.Error("the second cadence must not run below its interval")
	}
	if !m.signalsDue(now.Add(121 * time.Second)) {
		t.Error("the second cadence must run once its interval elapses")
	}
	m.signalsInFlight = true
	if m.signalsDue(now.Add(10 * time.Minute)) {
		t.Error("a pass already in flight must not be dispatched twice")
	}
}

func TestDoneWindowIsOnlyReadWhileItIsOnScreen(t *testing.T) {
	m := testModel(&fakeRunner{})
	if m.doneDue(time.Now()) {
		t.Error("the closed-issue read must not run while its column is hidden")
	}
	m.showDone = true
	if !m.doneDue(time.Now()) {
		t.Error("a shown Done column must refresh on the second cadence")
	}

	// The header states the window the READ used, not a constant: a repo that
	// raises RALPH_AUDIT_DAYS must not be told "14d" over 30 days of closes.
	m, _ = updateModel(m, doneMsg{ok: true, windowDays: 30})
	if m.doneTitle() != "Done · 30d" {
		t.Errorf("doneTitle = %q, want the window the read reported", m.doneTitle())
	}
}

func TestSpawnRefusesAClosedCard(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.showDone = true
	m.doneOK = true
	m.doneCards = []Card{{Number: 2061, State: doneState, Title: "closed"}}
	m.col, m.row = 2, 0
	m, cmd := updateKey(m, keyMsg("s"))
	if cmd != nil {
		t.Error("s on a closed card must not reach the spawn path")
	}
	if !strings.Contains(m.status, "closed") {
		t.Errorf("status = %q, want a legible refusal", m.status)
	}
}
