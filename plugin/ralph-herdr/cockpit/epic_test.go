package main

import (
	"strings"
	"testing"
	"time"
)

// GH-2381 — the `e` epic popover.

const epicJSON = `{
 "number": 2376, "title": "Epic: cockpit TUI v2",
 "url": "https://github.com/o/r/issues/2376",
 "state": "Backlog",
 "children": [
  {"number": 2377, "title": "glyph tiers", "issueState": "CLOSED", "state": "Done", "priority": null, "estimate": null, "closedAt": "2026-09-02T10:00:00Z", "fieldValuesTruncated": false},
  {"number": 2378, "title": "cost chip", "issueState": "OPEN", "state": "In Review", "priority": "P1", "estimate": "S", "closedAt": null, "fieldValuesTruncated": false},
  {"number": 2380, "title": "selection wash", "issueState": "OPEN", "state": "Backlog", "priority": "P2", "estimate": "XS", "closedAt": null, "fieldValuesTruncated": false},
  {"number": 2381, "title": "the e popover", "issueState": "OPEN", "state": "In Progress", "priority": "P1", "estimate": "M", "closedAt": null, "fieldValuesTruncated": false},
  {"number": 2382, "title": "blocked one", "issueState": "OPEN", "state": "Human Needed", "priority": "P2", "estimate": "S", "closedAt": null, "fieldValuesTruncated": false},
  {"number": 2383, "title": "unread state", "issueState": "OPEN", "state": null, "priority": null, "estimate": null, "closedAt": null, "fieldValuesTruncated": true},
  {"number": 2384, "title": "off board", "issueState": "OPEN", "state": null, "priority": null, "estimate": null, "closedAt": null, "fieldValuesTruncated": false}
 ],
 "childrenTruncated": false
}`

func TestParseEpicOrdersChildrenAndKeepsTheNotAStateCasesApart(t *testing.T) {
	v, err := parseEpic(epicJSON)
	if err != nil {
		t.Fatal(err)
	}
	if v.Number != 2376 || v.Repo != "o/r" || v.Closed != 1 || v.Truncated {
		t.Fatalf("view = %+v", v)
	}
	var order []int
	for _, c := range v.Children {
		order = append(order, c.Number)
		if c.ParentNumber != 2376 || c.Repo != "o/r" {
			t.Errorf("#%d must carry the epic as parent and its repo: %+v", c.Number, c)
		}
	}
	// Board order (spec §11): In Progress, In Review, Backlog, Human Needed,
	// Done — then the rest in the order the CLI listed them.
	want := []int{2381, 2378, 2380, 2382, 2377, 2383, 2384}
	for i := range want {
		if i >= len(order) || order[i] != want[i] {
			t.Fatalf("order = %v, want %v", order, want)
		}
	}
	byNum := map[int]Card{}
	for _, c := range v.Children {
		byNum[c.Number] = c
	}
	if c := byNum[2380]; c.Priority != "P2" || c.Estimate != "XS" || c.State != "Backlog" {
		t.Errorf("Backlog child must carry priority/estimate: %+v", c)
	}
	if c := byNum[2377]; c.ClosedAt != "2026-09-02T10:00:00Z" || c.State != doneState {
		t.Errorf("Done child must carry closedAt: %+v", c)
	}
	if c := byNum[2383]; !c.StateUnread || c.State != "" {
		t.Errorf("a truncated field page is UNREAD, not off-board: %+v", c)
	}
	if c := byNum[2384]; c.StateUnread || c.State != "" {
		t.Errorf("a null state with a whole page is off-board: %+v", c)
	}
}

func TestParseEpicFailsClosedAndToleratesAnOlderCLI(t *testing.T) {
	for _, bad := range []string{`{}`, `null`, `{"number":1,"children":null}`, `not json`} {
		if _, err := parseEpic(bad); err == nil {
			t.Errorf("%q must be a FAILED read, never a childless epic", bad)
		}
	}
	// A board CLI predating GH-2381 omits priority/estimate/closedAt: the
	// child decodes with them unset rather than refusing the whole read.
	v, err := parseEpic(`{"number":1,"title":"t","url":"https://github.com/o/r/issues/1","children":[{"number":2,"title":"c","issueState":"OPEN","state":"Backlog","fieldValuesTruncated":false}],"childrenTruncated":true}`)
	if err != nil || len(v.Children) != 1 || v.Children[0].Priority != "" || !v.Truncated {
		t.Fatalf("old-CLI payload: %+v err=%v", v, err)
	}
}

func TestRepoFromIssueURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://github.com/o/r/issues/2376":    "o/r",
		"https://ghe.corp/org/repo/issues/1":    "org/repo",
		"":                                      "",
		"https://github.com/o/r/pull/5":         "",
		"https://github.com/o/r/issues/1/extra": "o/r",
	} {
		if got := repoFromIssueURL(in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}

// epicModel: testModel with #10 parented to 2376, live agents on two of the
// epic's children, and a priced ledger fact for one of them.
func epicModel(f *fakeRunner) Model {
	m := testModel(f)
	m.cols[0][0].ParentNumber = 2376
	m.agents = setAgents([]Agent{
		{Name: "w10-ten", Status: "working", Pane: "p1", Issue: 10, Lane: "w"},
		{Name: "w2381-popover", Status: "working", Pane: "p3", Issue: 2381, Lane: "w", Root: "w2381-popover#r1", Branch: "feat/2381-popover"},
		{Name: "w2382-blocked", Status: "blocked", Pane: "p4", Issue: 2382, Lane: "w"},
	})
	m.ledger.Usage = map[string]LedgerUsage{"w2381-popover#r1": {ListUSD: 2.5, MaxContext: 120000}}
	m.ledger.ByIssue = map[int]LedgerSpawn{2380: {Issue: 2380, Branch: "feat/2380-wash"}}
	f.respond = func(prog string, args []string) (string, string, error) {
		if prog == "BOARD" && len(args) > 0 && args[0] == "get" {
			return epicJSON, "", nil
		}
		return "", "", nil
	}
	return m
}

func openEpic(t *testing.T, m Model) Model {
	t.Helper()
	m, cmd := updateModel(m, keyMsg("e"))
	if cmd == nil || !m.epicInFlight || m.statusKind != statusFlight {
		t.Fatalf("e on a parented card must dispatch the read: cmd=%v inFlight=%v status=%q", cmd != nil, m.epicInFlight, m.status)
	}
	m, _ = updateModel(m, cmd())
	if m.mode != ModeEpic {
		t.Fatalf("the read landing must open the overlay; mode=%v status=%q", m.mode, m.status)
	}
	return m
}

func TestEpicKeyRefusesAnUnparentedCardWithAStatusLine(t *testing.T) {
	f := &fakeRunner{}
	m := epicModel(f)
	m.row = 1 // #11, no parent
	m, cmd := updateModel(m, keyMsg("e"))
	if cmd != nil || m.mode != ModeBrowse || m.statusKind != statusRefuse || !strings.Contains(m.status, "#11 has no parent") {
		t.Errorf("unparented: cmd=%v mode=%v status=%q", cmd != nil, m.mode, m.status)
	}
	if len(f.calls) != 0 {
		t.Errorf("a refusal must cost no board read: %v", f.calls)
	}
	// A Done card's parent was never read — named as such, not as parentless.
	m.showDone = true
	m.doneCards = []Card{{Number: 5, State: doneState, ClosedAt: "2026-09-02T10:00:00Z"}}
	m.col, m.row = 2, 0
	m, _ = updateModel(m, keyMsg("e"))
	if m.statusKind != statusRefuse || !strings.Contains(m.status, "Done window") {
		t.Errorf("Done card: status=%q", m.status)
	}
}

func TestEpicKeyOpensOnTheReadAndRoutesVerbsToTheChild(t *testing.T) {
	f := &fakeRunner{}
	m := openEpic(t, epicModel(f))
	if f.calls[0].prog != "BOARD" || strings.Join(f.calls[0].args, " ") != "get 2376 --json" {
		t.Fatalf("the read is one board get: %v", f.calls[0])
	}
	if m.epicRow != 0 || m.epic.Number != 2376 || len(m.epic.Children) != 7 {
		t.Fatalf("epic = %+v row=%d", m.epic, m.epicRow)
	}
	// A Done child with the window never read: the closing PR is fetched once.
	if !m.doneInFlight {
		t.Error("a Done child must dispatch the Done-window read for its closing PR")
	}

	// j/k move between children and clamp at both ends.
	m, _ = updateModel(m, keyMsg("k"))
	if m.epicRow != 0 {
		t.Errorf("k at the top must clamp, row=%d", m.epicRow)
	}
	for i := 0; i < 10; i++ {
		m, _ = updateModel(m, keyMsg("j"))
	}
	if m.epicRow != 6 {
		t.Errorf("j past the end must clamp at 6, row=%d", m.epicRow)
	}
	for i := 0; i < 6; i++ {
		m, _ = updateModel(m, keyMsg("k"))
	}

	// ⏎ observes the SELECTED CHILD's agent, not the board's selected card.
	f.calls = nil
	m, cmd := updateModel(m, keyMsg("enter"))
	if cmd == nil {
		t.Fatal("observe on a live child must dispatch")
	}
	cmd()
	if len(f.calls) != 1 || f.calls[0].prog != "HERDR" || strings.Join(f.calls[0].args, " ") != "agent focus w2381-popover" {
		t.Errorf("observe must focus the child's agent: %v", f.calls)
	}

	// ␣ peeks the child; esc from the peek returns to the OVERLAY.
	f.calls = nil
	m, cmd = updateModel(m, keyMsg("space"))
	if cmd == nil {
		t.Fatal("peek on a live child must dispatch")
	}
	m, _ = updateModel(m, cmd())
	if m.mode != ModePeek || m.peekWho != "w2381-popover" || m.peekReturn != ModeEpic {
		t.Fatalf("peek: mode=%v who=%q return=%v", m.mode, m.peekWho, m.peekReturn)
	}
	m, _ = updateModel(m, keyMsg("esc"))
	if m.mode != ModeEpic || m.peekReturn != ModeBrowse {
		t.Errorf("esc from a peek opened in the overlay must return to it: mode=%v", m.mode)
	}

	// A child with no live agent: the verb's own refusal, on the status line.
	m.epicRow = 2 // #2380 Backlog
	m, cmd = updateModel(m, keyMsg("enter"))
	if cmd != nil || m.statusKind != statusNudge || !strings.Contains(m.status, "#2380") {
		t.Errorf("observe on an agentless child: cmd=%v status=%q", cmd != nil, m.status)
	}

	// esc closes; the board's own cursor is where it was.
	m, _ = updateModel(m, keyMsg("esc"))
	if m.mode != ModeBrowse || m.col != 0 || m.row != 0 {
		t.Errorf("esc: mode=%v cursor=(%d,%d)", m.mode, m.col, m.row)
	}
}

func TestEpicReadLandingAfterTheCursorLeftTheEpicNudgesInsteadOfOpening(t *testing.T) {
	m := epicModel(&fakeRunner{})
	v, _ := parseEpic(epicJSON)
	m.epicFor = 2376
	m.epicInFlight = true
	m.row = 1 // #11 — no parent: the operator moved off the epic's card
	m, _ = updateModel(m, epicMsg{issue: 2376, view: v, ok: true})
	if m.mode != ModeBrowse || m.statusKind != statusNudge || !strings.Contains(m.status, "epic #2376 read landed after the selection moved") {
		t.Errorf("a read for an epic the cursor has left must nudge, never open: mode=%v status=%q", m.mode, m.status)
	}
	if m.epic.Number != 2376 || m.epicInFlight {
		t.Error("the data is kept so the next e is instant")
	}
	// A sibling card of the SAME epic is still "where they pressed e".
	m.cols[0][1].ParentNumber = 2376
	m, _ = updateModel(m, epicMsg{issue: 2376, view: v, ok: true})
	if m.mode != ModeEpic {
		t.Errorf("a sibling card of the same epic opens it: mode=%v", m.mode)
	}
}

func TestEpicReadNeverHijacksAndDropsAReadForAnotherEpic(t *testing.T) {
	m := epicModel(&fakeRunner{})
	v, _ := parseEpic(epicJSON)
	m.epicFor = 2376
	m.mode = ModeReply
	m.input = "typing"
	m, _ = updateModel(m, epicMsg{issue: 2376, view: v, ok: true})
	if m.mode != ModeReply || m.input != "typing" {
		t.Errorf("a read landing mid-reply must not flip the mode: mode=%v input=%q", m.mode, m.input)
	}
	if m.epic.Number != 2376 {
		t.Error("the data is still kept for the next e")
	}
	m.mode = ModeBrowse
	m, _ = updateModel(m, epicMsg{issue: 999, view: EpicView{Number: 999}, ok: true})
	if m.mode != ModeBrowse || m.epic.Number != 2376 {
		t.Errorf("a read for an epic the operator moved off must be dropped: mode=%v epic=%d", m.mode, m.epic.Number)
	}
}

func TestEpicFailedOpenRefusesAndFailedRefreshKeepsTheChildrenUnderAStaleBanner(t *testing.T) {
	m := epicModel(&fakeRunner{})
	m.epicFor = 2376
	m, _ = updateModel(m, epicMsg{issue: 2376, err: "boom"})
	if m.mode != ModeBrowse || m.statusKind != statusRefuse || !strings.Contains(m.status, "epic #2376 read failed: boom") {
		t.Errorf("failed open: mode=%v status=%q", m.mode, m.status)
	}
	m = openEpic(t, m)
	m, _ = updateModel(m, epicMsg{issue: 2376, err: "flap"})
	if m.mode != ModeEpic || len(m.epic.Children) != 7 {
		t.Fatalf("a failed refresh must keep the last good view: mode=%v n=%d", m.mode, len(m.epic.Children))
	}
	out := stripANSI(viewModel(m))
	if !strings.Contains(out, "epic #2376 stale: flap") || !strings.Contains(out, "#2381") {
		t.Errorf("stale banner over the kept children; got:\n%s", out)
	}
}

func TestEpicRefreshRidesTheSignalCadenceOnlyWhileUp(t *testing.T) {
	m := epicModel(&fakeRunner{})
	now := time.Now()
	m.epicFor = 2376
	m.mode = ModeEpic
	if !m.epicDue(now) {
		t.Error("overlay up, never read: due")
	}
	m.lastEpic = now
	if m.epicDue(now) {
		t.Error("just read: not due")
	}
	if !m.epicDue(now.Add(m.cfg.SignalInterval)) {
		t.Error("one signal interval later: due")
	}
	m.epicInFlight = true
	if m.epicDue(now.Add(m.cfg.SignalInterval)) {
		t.Error("in flight: not due")
	}
	m.epicInFlight = false
	m.mode = ModeBrowse
	if m.epicDue(now.Add(m.cfg.SignalInterval)) {
		t.Error("overlay closed: never due")
	}
}

func TestRenderEpicDrawsEveryChildStateAsABoardCard(t *testing.T) {
	m := openEpic(t, epicModel(&fakeRunner{}))
	m.width, m.height = 160, 50
	// The Human Needed child is joined to the column card the poll read —
	// the question rides that card, never the get.
	m.cols[2] = append(m.cols[2], Card{Number: 2382, Repo: "o/r", Title: "blocked one", State: "Human Needed", Question: "Which one?", ParentNumber: 2376})
	// The Done child's closing PR is joined from the Done window.
	m.doneCards = []Card{{Number: 2377, State: doneState, ClosedAt: "2026-09-02T10:00:00Z", MergedPR: 2383, ClosingPRsRead: true}}
	out := stripANSI(viewModel(m))
	for _, want := range []string{
		"epic #2376 — Epic: cockpit TUI v2", "1/7 done", "$2.50",
		"1 live · 1 in review · 1 blocked · 1 backlog · 1 done · 1 off board · 1 state unread",
		"In Progress", "In Review", "Human Needed", "off board", "state ?",
		"? Which one?", "#2383", "closed ",
		"feat/2381-popover", "P2 [XS]",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("popover must show %q; got:\n%s", want, out)
		}
	}
	if strings.Contains(out, "feat/2380-wash") {
		t.Errorf("a Backlog child draws no branch; got:\n%s", out)
	}
	// A parked card's line 3 is the lead alone — no age dash, no cost. That
	// covers the off-board and unread children too: no column, no session.
	for _, line := range strings.Split(out, "\n") {
		if (strings.Contains(line, "P2 [XS]") || strings.Contains(line, "P?")) && strings.Contains(line, "—") {
			t.Errorf("a parked child draws no age: %q", line)
		}
	}
	// Legend: the overlay's own row.
	if !strings.Contains(out, "esc close · j/k child · ⏎ observe · ␣ peek · g browser") {
		t.Errorf("overlay legend; got:\n%s", out)
	}
	// Unread closing PR (window not carrying the child) is `?`, never blank.
	m.doneCards = nil
	out = stripANSI(viewModel(m))
	if !strings.Contains(out, m.glyphSet().merge+"?") {
		t.Errorf("a Done child outside the window must draw the unread merge chip; got:\n%s", out)
	}
}

func TestRenderEpicHeadClipsAndFollowsTheSelection(t *testing.T) {
	m := openEpic(t, epicModel(&fakeRunner{}))
	m.width, m.height = 120, 20
	out := stripANSI(viewModel(m))
	if !strings.Contains(out, "#2381") || strings.Contains(out, "#2384") || !strings.Contains(out, "more") {
		t.Errorf("a short pane keeps the FIRST children and counts the rest; got:\n%s", out)
	}
	m.epicRow = 6
	out = stripANSI(viewModel(m))
	if !strings.Contains(out, "#2384") || !strings.Contains(out, "above") {
		t.Errorf("the window must follow the selection; got:\n%s", out)
	}
	// The overlay never overruns the body budget it was given.
	if n := strings.Count(viewModel(m), "\n"); n > m.height {
		t.Errorf("frame overran the pane: %d rows for height %d", n, m.height)
	}
}

func TestRenderEpicDoneChildTrimsTheClosedLabelWithAnEllipsis(t *testing.T) {
	m := openEpic(t, epicModel(&fakeRunner{}))
	m.width, m.height = 60, 40
	m.doneCards = []Card{{Number: 2377, State: doneState, ClosedAt: time.Now().Add(-43 * time.Minute).UTC().Format(time.RFC3339), MergedPR: 9999, ClosingPRsRead: true}}
	out := stripANSI(viewModel(m))
	found := false
	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(line, "#9999") {
			continue
		}
		found = true
		if strings.Contains(line, " ag ") || strings.Contains(line, " ag│") {
			t.Errorf("a closed label that does not fit is ellipsised, never chopped: %q", line)
		}
		if !strings.Contains(line, "…") && !strings.Contains(line, "ago") {
			t.Errorf("closed label must be whole or ellipsised: %q", line)
		}
	}
	if !found {
		t.Fatalf("the Done child's merge chip must survive at card width; got:\n%s", out)
	}
}

func TestRenderEpicNarrowPaneDropsToOneColumnAndShedsChipsBeforeClipping(t *testing.T) {
	m := openEpic(t, epicModel(&fakeRunner{}))
	m.width, m.height = 32, 60 // innerW 26 → one column of 26, never two of 12
	m.doneCards = []Card{{Number: 2377, State: doneState, ClosedAt: time.Now().Add(-43 * time.Minute).UTC().Format(time.RFC3339), MergedPR: 9999, ClosingPRsRead: true}}
	m.ledger.Usage["w2377-glyphs#r1"] = LedgerUsage{ListUSD: 1.4, MaxContext: 50000}
	m.agents[2377] = []Agent{{Name: "w2377-glyphs", Status: "done", Issue: 2377, Lane: "w", Root: "w2377-glyphs#r1"}}
	out := stripANSI(viewModel(m))
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "#2381") && strings.Contains(line, "#2378") {
			t.Fatalf("a narrow pane must not put two cards on one row: %q", line)
		}
		// The merge chip is whole or absent — never a partial PR number.
		if strings.Contains(line, "closed") && strings.Contains(line, "#") && !strings.Contains(line, "#9999") {
			t.Errorf("a clipped merge chip is a wrong PR number: %q", line)
		}
	}
	if !strings.Contains(out, "#9999") {
		t.Errorf("at 26 cells the merge chip alone fits and must be drawn; got:\n%s", out)
	}
	if strings.Contains(out, "$1.40") {
		t.Errorf("the cost is the first chip shed at this width; got:\n%s", out)
	}
	// Every row stays inside the frame.
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "│") && !strings.HasSuffix(line, "│") {
			t.Errorf("row overran the frame: %q", line)
		}
	}
}

func TestLegendOffersEpicOnlyOnAParentedCard(t *testing.T) {
	m := epicModel(&fakeRunner{})
	out := stripANSI(viewModel(m))
	if !strings.Contains(out, "e epic") {
		t.Errorf("#10 is parented: legend must offer e; got:\n%s", out)
	}
	m.row = 1
	out = stripANSI(viewModel(m))
	if strings.Contains(out, "e epic") {
		t.Errorf("#11 has no parent: e is hidden; got:\n%s", out)
	}
}

func TestEpicTallyNamesEveryStateNonzero(t *testing.T) {
	kids := []Card{
		{State: "In Progress"}, {State: "In Progress"}, {State: "Backlog"}, {State: doneState},
		{State: "Intake"}, {State: "Canceled"}, {State: "", StateUnread: true},
	}
	got := epicTally(kids)
	for _, part := range []string{"2 live", "1 backlog", "1 done", "1 canceled", "1 intake", "1 state unread"} {
		if !strings.Contains(got, part) {
			t.Errorf("tally %q must name %q", got, part)
		}
	}
	if strings.Contains(got, "blocked") || strings.Contains(got, "in review") {
		t.Errorf("a zero bucket is not named: %q", got)
	}
}
