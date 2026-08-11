// fetch_test.go — argv construction is pinned EXACTLY: every exec goes
// through a Runner with an args slice, never a shell, so hostile card titles
// and answers must survive verbatim as single argv elements.
package main

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// fakeRunner records every invocation in order and answers from a table —
// the cockpit-side sibling of tests/fake-herdr.sh's invocation log.
type recordedCall struct {
	prog string
	args []string
}

type fakeRunner struct {
	calls   []recordedCall
	respond func(prog string, args []string) (string, string, error)
}

func (f *fakeRunner) Run(_ context.Context, prog string, args ...string) (string, string, error) {
	f.calls = append(f.calls, recordedCall{prog: prog, args: args})
	if f.respond != nil {
		return f.respond(prog, args)
	}
	return "", "", nil
}

const hostile = `"; rm -rf / #$(boom) & | > /etc/passwd '` + "`tick`"

func TestArgvConstruction(t *testing.T) {
	tests := []struct {
		name string
		got  []string
		want []string
	}{
		{"board list", argsBoardList("Human Needed"),
			[]string{"list", "--state", "Human Needed", "--json"}},
		{"board get", argsBoardGet(1234),
			[]string{"get", "1234", "--json"}},
		{"board frontier", argsBoardFrontier(),
			[]string{"frontier", "--json"}},
		{"board answer carries hostile text as ONE element", argsBoardAnswer(7, hostile),
			[]string{"answer", "7", "-m", hostile}},
		{"agent list", argsAgentList(),
			[]string{"agent", "list"}},
		{"agent read", argsAgentRead("w7-fix-the-thing"),
			[]string{"agent", "read", "w7-fix-the-thing", "--source", "recent-unwrapped", "--lines", "40"}},
		{"agent focus", argsAgentFocus("gh-12"),
			[]string{"agent", "focus", "gh-12"}},
		{"agent prompt carries hostile text as ONE element", argsAgentPrompt("w7-x", hostile, "15000"),
			[]string{"agent", "prompt", "w7-x", hostile, "--wait", "--timeout", "15000"}},
		{"gh comments", argsGhComments(9, "cdubiel08/ralph-hero"),
			[]string{"issue", "view", "9", "--json", "comments", "-R", "cdubiel08/ralph-hero"}},
		{"pane split", argsPaneSplit(),
			[]string{"pane", "split", "--current", "--direction", "down", "--focus"}},
		{"pane run", argsPaneRun("pS1", 88),
			[]string{"pane", "run", "pS1", "gh", "pr", "diff", "88"}},
		{"spawn: constant script, data positional", argsSpawn("/plug/scripts", 42),
			[]string{"-c", spawnScript, "ralph-cockpit", "/plug/scripts", "42"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if !reflect.DeepEqual(tt.got, tt.want) {
				t.Errorf("argv mismatch\n got: %q\nwant: %q", tt.got, tt.want)
			}
		})
	}
}

func TestSpawnScriptIsConstant(t *testing.T) {
	// The ONLY bash -c body the cockpit ever runs. Data must ride as $1/$2 —
	// the script text itself must never interpolate an issue or title.
	if !strings.Contains(spawnScript, `spawn_work_session "$2"`) {
		t.Fatalf("spawnScript must call spawn_work_session with the positional issue: %q", spawnScript)
	}
	if strings.Contains(spawnScript, "%s") || strings.Contains(spawnScript, "%d") {
		t.Fatalf("spawnScript looks templated — it must be constant: %q", spawnScript)
	}
}

func TestParseBoardList(t *testing.T) {
	out := `{"items":[
	  {"number":10,"repo":"o/r","title":"Ten","state":"In Progress","priority":"P1","estimate":"M","parentNumber":3},
	  {"number":11,"repo":"o/r","title":"Wrong column","state":"Backlog","priority":null,"estimate":null,"parentNumber":null}
	],"foreign":[]}`
	cards, err := parseBoardList(out, "In Progress")
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) != 1 {
		t.Fatalf("want 1 card (state filter must hold), got %d", len(cards))
	}
	c := cards[0]
	if c.Number != 10 || c.Title != "Ten" || c.State != "In Progress" || c.ParentNumber != 3 || c.Priority != "P1" {
		t.Errorf("card mis-parsed: %+v", c)
	}
	if _, err := parseBoardList("not json", "In Review"); err == nil {
		t.Error("garbage must error, not read as an empty board")
	}
}

func TestParseAgents(t *testing.T) {
	out := `{"result":{"agents":[
	  {"name":"w123-fix-the-flaky-test","agent_status":"working","pane_id":"p1"},
	  {"name":"gh-45","agent_status":"blocked","pane_id":"p2"},
	  {"name":"random-agent","agent_status":"working","pane_id":"p3"},
	  {"name":"r45-review-pass--2","agent_status":"idle","pane_id":"p4"},
	  {"name":null,"agent_status":"working","pane_id":"p5"}
	]}}`
	agents, err := parseAgents(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 3 {
		t.Fatalf("want 3 ralph-shaped agents (foreign filtered), got %d: %+v", len(agents), agents)
	}
	byName := map[string]Agent{}
	for _, a := range agents {
		byName[a.Name] = a
	}
	if a := byName["w123-fix-the-flaky-test"]; a.Issue != 123 || a.Lane != "w" || a.Status != "working" {
		t.Errorf("grammar-B parse wrong: %+v", a)
	}
	if a := byName["gh-45"]; a.Issue != 45 || a.Lane != "w" {
		t.Errorf("legacy gh-N parse wrong: %+v", a)
	}
	if a := byName["r45-review-pass--2"]; a.Issue != 45 || a.Lane != "r" {
		t.Errorf("generation-suffix parse wrong: %+v", a)
	}
}

func TestParseAgentNameTable(t *testing.T) {
	tests := []struct {
		name  string
		lane  string
		issue int
		ok    bool
	}{
		{"w123-fix-things", "w", 123, true},
		{"gh-7", "w", 7, true},
		{"x0-relay", "x", 0, true},
		{"r45-review--3", "r", 45, true}, // generation suffix range is 2..9
		{"r45-review--2", "r", 45, true},
		{"r45-review--1", "", 0, false}, // 1 is outside the gen range, and a slug never holds "--"
		{"w12-", "", 0, false},
		{"z9-nope", "", 0, false}, // lane outside the registry
		{"w12-3digits", "", 0, false},
		{"", "", 0, false},
		{"w123456789012345678901234567890123-x", "", 0, false}, // > 32 chars
	}
	for _, tt := range tests {
		lane, issue, ok := parseAgentName(tt.name)
		if lane != tt.lane || issue != tt.issue || ok != tt.ok {
			t.Errorf("parseAgentName(%q) = (%q,%d,%v), want (%q,%d,%v)",
				tt.name, lane, issue, ok, tt.lane, tt.issue, tt.ok)
		}
	}
}

func TestFirstCommentLine(t *testing.T) {
	out := `{"comments":[{"body":"older\ncomment"},{"body":"Which DB should GH-9 use?\r\nContext below."}]}`
	if got := firstCommentLine(out); got != "Which DB should GH-9 use?" {
		t.Errorf("question line = %q", got)
	}
	if got := firstCommentLine(`{"comments":[]}`); got != "" {
		t.Errorf("no comments should give empty, got %q", got)
	}
	if got := firstCommentLine("garbage"); got != "" {
		t.Errorf("garbage should give empty, got %q", got)
	}
}

func TestRenderFrontier(t *testing.T) {
	out := `{"frontier":[
	  {"number":12,"title":"Leaf","via":9,"blockers":[{"number":8,"state":"CLOSED"}],"eligible":true}
	],"blocked":[
	  {"number":30,"blockers_open":[12,13]},
	  {"number":31,"blockers_open":[],"truncated":true}
	]}`
	text, err := renderFrontier(out)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"#12 Leaf", "via epic #9", "✓ #8", "BLOCKED", "#30", "#12 #13", "truncated"} {
		if !strings.Contains(text, want) {
			t.Errorf("frontier tree missing %q in:\n%s", want, text)
		}
	}
	if _, err := renderFrontier("nope"); err == nil {
		t.Error("garbage frontier must error")
	}
}

func TestPickPR(t *testing.T) {
	open := `{"prs":[{"number":1,"state":"MERGED","merged":true},{"number":2,"state":"OPEN","merged":false}]}`
	if pr, ok := pickPR(open); !ok || pr != 2 {
		t.Errorf("want open PR 2, got %d %v", pr, ok)
	}
	mergedOnly := `{"prs":[{"number":3,"state":"MERGED","merged":true}]}`
	if pr, ok := pickPR(mergedOnly); !ok || pr != 3 {
		t.Errorf("want last PR 3, got %d %v", pr, ok)
	}
	if _, ok := pickPR(`{"prs":[]}`); ok {
		t.Error("no PRs must report none")
	}
}

func TestDoReplyHonestDelivery(t *testing.T) {
	cfg := Config{Herdr: "herdr"}
	ok := &fakeRunner{}
	msg := doReply(cfg, ok, "w7-x", "carry on")
	if !msg.ok {
		t.Fatal("rc 0 must read as delivered")
	}
	bad := &fakeRunner{respond: func(string, []string) (string, string, error) {
		return "", `{"error":{"code":"agent_prompt_stalled"}}`, errors.New("exit status 1")
	}}
	msg = doReply(cfg, bad, "w7-x", "carry on")
	if msg.ok {
		t.Fatal("a failed prompt must NEVER read as delivered — no optimistic ack")
	}
	if !strings.Contains(msg.detail, "agent_prompt_stalled") {
		t.Errorf("failure detail should carry herdr's refusal, got %q", msg.detail)
	}
}
