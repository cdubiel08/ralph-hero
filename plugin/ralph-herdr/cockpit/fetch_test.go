// fetch_test.go — argv construction is pinned EXACTLY: every exec goes
// through a Runner with an args slice, never a shell, so hostile card titles
// and answers must survive verbatim as single argv elements.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
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
		{"board list is the whole-board read — no --state (GH-1786)", argsBoardList(),
			[]string{"list", "--json"}},
		{"board get", argsBoardGet(1234),
			[]string{"get", "1234", "--json"}},
		{"board frontier", argsBoardFrontier(),
			[]string{"frontier", "--json"}},
		{"board answer carries hostile text as ONE element", argsBoardAnswer(7, hostile),
			[]string{"answer", "7", "-m", hostile}},
		{"api snapshot", argsApiSnapshot(),
			[]string{"api", "snapshot"}},
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
	// forkScript: same contract — the pane id is positional, never interpolated,
	// and the session read stays in fork.sh (GH-1957).
	if !strings.Contains(forkScript, `RALPH_FORK_PANE="$2"`) || !strings.Contains(forkScript, `"$1/fork.sh"`) {
		t.Fatalf("forkScript must pass the pane positionally to fork.sh: %q", forkScript)
	}
	if strings.Contains(forkScript, "%s") || strings.Contains(forkScript, "%d") {
		t.Fatalf("forkScript looks templated — it must be constant: %q", forkScript)
	}
	if got := argsFork("/plug/scripts", hostile); got[len(got)-1] != hostile {
		t.Fatalf("a hostile pane id must arrive as one positional arg, got %q", got)
	}
}

func TestParseBoardColumns(t *testing.T) {
	// One cross-state payload — exactly what `board list --json` returns —
	// partitioned into the three columns. Deliberately NOT grouped by state
	// in the payload: board order is per-column, not per-block.
	out := `{"items":[
	  {"number":10,"repo":"o/r","title":"Ten","state":"In Progress","priority":"P1","estimate":"M","parentNumber":3},
	  {"number":11,"repo":"o/r","title":"Backlog item","state":"Backlog","priority":null,"estimate":null,"parentNumber":null},
	  {"number":12,"repo":"o/r","title":"Twelve","state":"Human Needed","priority":"P0","estimate":null,"parentNumber":null},
	  {"number":13,"repo":"o/r","title":"Thirteen","state":"In Review","priority":null,"estimate":null,"parentNumber":null},
	  {"number":14,"repo":"o/r","title":"Fourteen","state":"In Progress","priority":null,"estimate":null,"parentNumber":null},
	  {"number":15,"repo":"o/r","title":"Off-cockpit","state":"Done","priority":null,"estimate":null,"parentNumber":null}
	],"foreign":[]}`
	cols, err := parseBoardColumns(out)
	if err != nil {
		t.Fatal(err)
	}
	got := [3][]int{}
	for i := range cols {
		for _, c := range cols[i] {
			got[i] = append(got[i], c.Number)
			if c.State != columnStates[i] {
				t.Errorf("column %d holds a %q card: %+v", i, c.State, c)
			}
		}
	}
	want := [3][]int{{10, 14}, {13}, {12}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("partition mismatch (order within a column is board order)\n got: %v\nwant: %v", got, want)
	}
	c := cols[0][0]
	if c.Number != 10 || c.Title != "Ten" || c.ParentNumber != 3 || c.Priority != "P1" || c.Estimate != "M" {
		t.Errorf("card mis-parsed: %+v", c)
	}
	if _, err := parseBoardColumns("not json"); err == nil {
		t.Error("garbage must error, not read as an empty board")
	}
}

// TestParseBoardColumnsRejectsMissingItemsArray closes the schema-invalid
// hole in the "empty is not unknown" rule (CodeRabbit on #1820).
//
// A slice decodes to nil from all three of these, which read as a board with
// no cards — the precise collapse TestFetchBoardFailureMarksEveryColumnUnknown
// exists to prevent, just arriving as a well-formed-JSON payload rather than
// as a failed exec. A truncated response or a board CLI printing `{}` on an
// internal error would render three empty columns and look calm.
func TestParseBoardColumnsRejectsMissingItemsArray(t *testing.T) {
	for _, payload := range []string{`{}`, `null`, `{"items":null}`, `{"foreign":[]}`} {
		t.Run(payload, func(t *testing.T) {
			cols, err := parseBoardColumns(payload)
			if err == nil {
				t.Fatalf("%s must be a FAILED read, not an empty board; got cols=%+v", payload, cols)
			}
			if !strings.Contains(err.Error(), "no items array") {
				t.Errorf("the refusal should name the reason, got %q", err)
			}
		})
	}
	// The boundary that must NOT move: a real empty board still parses.
	cols, err := parseBoardColumns(`{"items":[],"foreign":[]}`)
	if err != nil {
		t.Fatalf("an EMPTY items array is a real fact, not a failure: %v", err)
	}
	for i := range cols {
		if len(cols[i]) != 0 {
			t.Errorf("column %d should be empty, got %+v", i, cols[i])
		}
	}
}

// TestFetchBoardMalformedPayloadMarksEveryColumnUnknown carries the rule
// through the Cmd: a schema-invalid payload must reach the model as all three
// columns UNKNOWN, so update.go keeps the last good cards under an error
// banner instead of rendering a falsely calm board.
func TestFetchBoardMalformedPayloadMarksEveryColumnUnknown(t *testing.T) {
	for _, payload := range []string{`{}`, `null`, `{"items":null}`} {
		t.Run(payload, func(t *testing.T) {
			r := &fakeRunner{respond: func(string, []string) (string, string, error) {
				return payload, "", nil // rc 0 — the board CLI "succeeded"
			}}
			msg := fetchBoardCmd(Config{Board: "board"}, r)().(boardMsg)
			if msg.failed != allColumnsUnknown {
				t.Errorf("every column must read as unknown, got %v", msg.failed)
			}
			for i := range msg.cols {
				if msg.cols[i] != nil {
					t.Errorf("column %d must carry no cards, got %+v", i, msg.cols[i])
				}
			}
			if msg.err == "" {
				t.Error("the failure must be surfaced, not swallowed")
			}
		})
	}
}

// TestParseBoardColumnsNeedsOnlyCoreFields pins the cockpit's half of the
// board contract after GH-1803 made nested connections a per-caller choice.
//
// `labels`/`labelsTruncated` and `openBlockers`/`blockersTruncated` are now
// OPTIONAL GROUPS — a read that did not select them omits the keys entirely
// rather than sending `[]` with `truncated: false`. `list` selects both today
// (QUEUE_SELECT_FULL, "contract kept"), so this is not a bug being fixed; it
// is the guarantee that leaning `list` later cannot silently blank the board.
//
// Everything the partition reads lives in QueueItemCore, which every selection
// carries. This payload proves it by omitting both groups outright.
func TestParseBoardColumnsNeedsOnlyCoreFields(t *testing.T) {
	lean := `{"items":[
	  {"number":10,"repo":"o/r","title":"Ten","state":"In Progress","priority":"P1","hasParent":true,"parentNumber":3,"fieldValuesTruncated":false,"claim":null,"claimRaw":null},
	  {"number":13,"repo":"o/r","title":"Thirteen","state":"In Review","priority":null,"hasParent":false,"parentNumber":null,"fieldValuesTruncated":false,"claim":null,"claimRaw":null},
	  {"number":12,"repo":"o/r","title":"Twelve","state":"Human Needed","priority":"P0","hasParent":false,"parentNumber":null,"fieldValuesTruncated":false,"claim":null,"claimRaw":null}
	],"foreign":[],"foreignEvaluated":false}`
	cols, err := parseBoardColumns(lean)
	if err != nil {
		t.Fatalf("a lean selection must still parse — the cockpit reads no optional group: %v", err)
	}
	for i, want := range [3]int{10, 13, 12} {
		if len(cols[i]) != 1 || cols[i][0].Number != want {
			t.Fatalf("column %d (%s) mis-partitioned under a lean read: %+v", i, columnStates[i], cols[i])
		}
	}
	// The fields the TUI actually renders survive; estimate is legitimately
	// absent here and must read as empty, not break the parse.
	c := cols[0][0]
	if c.Title != "Ten" || c.Priority != "P1" || c.ParentNumber != 3 || c.Repo != "o/r" {
		t.Errorf("core fields lost under a lean read: %+v", c)
	}
	if c.Estimate != "" {
		t.Errorf("an unselected estimate must read as empty, got %q", c.Estimate)
	}
}

// snap builds a protocol-19 session_snapshot envelope whose single workspace
// has worktree provenance pointing at root — i.e. a herd that belongs to us.
// `version` is the string herdr 0.8.0 actually sends, not the int the earlier
// fixtures assumed (GH-1829).
func snap(root, agents string) string {
	return `{"id":"cli:api:snapshot","result":{"type":"session_snapshot","snapshot":{
	  "version":"0.8.0","protocol":19,"tabs":[],"layouts":[],
	  "workspaces":[{"workspace_id":"wR","worktree":{"repo_root":"` + root + `","checkout_path":"` + root + `"}}],
	  "panes":[],
	  "agents":[` + agents + `]}}}`
}

// TestFetchBoardIsOneRead is GH-1786's invariant, pinned: one poll costs ONE
// board process. Three `--state` reads were three full board walks (board.ts's
// withCache is per-process, so they shared nothing) — ~3x the GraphQL points
// and ~3x the wall time for one refresh.
func TestFetchBoardIsOneRead(t *testing.T) {
	payload := `{"items":[
	  {"number":10,"repo":"o/r","title":"Ten","state":"In Progress"},
	  {"number":12,"repo":"o/r","title":"Twelve","state":"Human Needed"},
	  {"number":13,"repo":"o/r","title":"Thirteen","state":"In Review"}
	],"foreign":[]}`
	r := &fakeRunner{respond: func(prog string, args []string) (string, string, error) {
		return payload, "", nil
	}}
	// Gh empty: the bounded question reads are separate chrome, not the scan.
	msg, ok := fetchBoardCmd(Config{Board: "board"}, r)().(boardMsg)
	if !ok {
		t.Fatal("fetchBoardCmd must return a boardMsg")
	}
	boardCalls := 0
	for _, c := range r.calls {
		if c.prog == "board" {
			boardCalls++
		}
	}
	if boardCalls != 1 {
		t.Fatalf("one poll must be ONE board read (GH-1786), got %d: %+v", boardCalls, r.calls)
	}
	if !reflect.DeepEqual(r.calls[0].args, []string{"list", "--json"}) {
		t.Errorf("the single read must be the whole-board list, got %q", r.calls[0].args)
	}
	for i, want := range [3]int{10, 13, 12} {
		if len(msg.cols[i]) != 1 || msg.cols[i][0].Number != want {
			t.Errorf("column %d (%s) mis-partitioned: %+v", i, columnStates[i], msg.cols[i])
		}
		if msg.failed[i] {
			t.Errorf("column %d must not be marked unknown on a clean read", i)
		}
	}
}

// A whole-board read covers all three columns, so its failure leaves all three
// UNKNOWN — never a falsely calm board. update.go then keeps each column's
// last good cards (TestBoardMsgKeepsLastGoodOnTotalFailure).
func TestFetchBoardFailureMarksEveryColumnUnknown(t *testing.T) {
	for _, tc := range []struct {
		name string
		resp func(string, []string) (string, string, error)
		want string
	}{
		{"nonzero exit", func(string, []string) (string, string, error) {
			return "", "board: could not read open issues\n", errors.New("exit status 1")
		}, "could not read open issues"},
		{"0-exit garbage stdout", func(string, []string) (string, string, error) {
			return "npm WARN this is not json\n", "", nil
		}, "list --json"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			msg := fetchBoardCmd(Config{Board: "board"}, &fakeRunner{respond: tc.resp})().(boardMsg)
			if msg.failed != allColumnsUnknown {
				t.Errorf("every column must read as unknown, got %v", msg.failed)
			}
			for i := range msg.cols {
				if msg.cols[i] != nil {
					t.Errorf("a failed read must carry NO cards for column %d", i)
				}
			}
			if !strings.Contains(msg.err, tc.want) {
				t.Errorf("the failure must be surfaced (%q), got %q", tc.want, msg.err)
			}
		})
	}
}

func TestParseAgents(t *testing.T) {
	root := "/repo"
	out := snap(root, `
	  {"name":"w123-fix-the-flaky-test","agent_status":"working","pane_id":"p1","workspace_id":"wR","tokens":{"root":"w123-fix-the-flaky-test#cd34","parent":"o2208-herd-topology#ab12","depth":"1"}},
	  {"name":"gh-45","agent_status":"blocked","pane_id":"p2","workspace_id":"wR"},
	  {"name":"random-agent","agent_status":"working","pane_id":"p3","workspace_id":"wR"},
	  {"name":"r45-review-pass--2","agent_status":"idle","pane_id":"p4","workspace_id":"wR"},
	  {"name":null,"agent_status":"working","pane_id":"p5","workspace_id":"wR"}`)
	agents, err := parseAgents(out, root)
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
	// GH-2217: the C8 lineage tokens are read, never dropped on the floor —
	// and an agent with none keeps "" (absence, not "0").
	if a := byName["w123-fix-the-flaky-test"]; a.Parent != "o2208-herd-topology#ab12" || a.Depth != "1" {
		t.Errorf("lineage tokens not read: %+v", a)
	}
	if a := byName["gh-45"]; a.Parent != "" || a.Depth != "" {
		t.Errorf("absent lineage must stay empty, got %+v", a)
	}
	if a := byName["gh-45"]; a.Issue != 45 || a.Lane != "w" {
		t.Errorf("legacy gh-N parse wrong: %+v", a)
	}
	if a := byName["r45-review-pass--2"]; a.Issue != 45 || a.Lane != "r" {
		t.Errorf("generation-suffix parse wrong: %+v", a)
	}
}

// The envelope checks. Each of these decodes without error into a struct whose
// agents list is empty or nil — which the TUI would render as "no sessions
// running". A confident lie about a response we failed to parse is worse than
// the honest "herdr unreachable" the caller falls back to.
func TestParseAgentsRejectsBadEnvelopes(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"garbage", "not json"},
		{"no correlation id", `{"result":{"type":"session_snapshot","snapshot":{"agents":[]}}}`},
		{"wrong result type", `{"id":"x","result":{"type":"agent_list","snapshot":{"agents":[]}}}`},
		{"no result type", `{"id":"x","result":{"snapshot":{"agents":[]}}}`},
		{"snapshot with no agents key", `{"id":"x","result":{"type":"session_snapshot","snapshot":{"protocol":19,"workspaces":[],"panes":[]}}}`},
		{"snapshot with no workspaces key", `{"id":"x","result":{"type":"session_snapshot","snapshot":{"protocol":19,"agents":[],"panes":[]}}}`},
		{"snapshot with no panes key", `{"id":"x","result":{"type":"session_snapshot","snapshot":{"protocol":19,"agents":[],"workspaces":[]}}}`},
		{"snapshot with no protocol", `{"id":"x","result":{"type":"session_snapshot","snapshot":{"agents":[],"workspaces":[],"panes":[]}}}`},
		{"snapshot below the protocol floor", `{"id":"x","result":{"type":"session_snapshot","snapshot":{"protocol":18,"agents":[],"workspaces":[],"panes":[]}}}`},
	} {
		if _, err := parseAgents(tc.body, "/repo"); err == nil {
			t.Errorf("%s must error, not read as an empty herd", tc.name)
		}
	}
}

// GH-1829: `version` is server chrome the cockpit never reads, but typing it
// `*int` bound the whole parse to the server's choice of scalar — herdr 0.8.0
// sends `"0.8.0"`, unmarshal failed on the entire document, and fetchAgentsCmd
// mapped that to herdrOK:false. The overlay just turned off, silently. Both
// shapes (and an absent field) must parse; `protocol` is the only version gate.
func TestParseAgentsIgnoresSnapshotVersionShape(t *testing.T) {
	body := func(version string) string {
		return `{"id":"x","result":{"type":"session_snapshot","snapshot":{` + version + `
		  "protocol":19,"tabs":[],"layouts":[],
		  "workspaces":[{"workspace_id":"wR","worktree":{"repo_root":"/ours","checkout_path":"/ours"}}],
		  "panes":[],
		  "agents":[{"name":"w1-x","agent_status":"working","pane_id":"p1","workspace_id":"wR"}]}}}`
	}
	for _, tc := range []struct{ name, version string }{
		{"herdr 0.8.0 string version", `"version":"0.8.0",`},
		{"legacy int version", `"version":1,`},
		{"no version at all", ``},
	} {
		agents, err := parseAgents(body(tc.version), "/ours")
		if err != nil {
			t.Errorf("%s must parse, got %v", tc.name, err)
			continue
		}
		if len(agents) != 1 {
			t.Errorf("%s: want our 1 agent, got %+v", tc.name, agents)
		}
	}
}

// One herdr session, two repositories. Both number issues from 1, so both
// produce `w42-fix` — the collision is structural, not unlucky, and a name
// match alone would put their agent's status chip on our card.
func TestParseAgentsScopesToRepository(t *testing.T) {
	out := `{"id":"cli:api:snapshot","result":{"type":"session_snapshot","snapshot":{
	  "version":1,"protocol":19,"tabs":[],"layouts":[],
	  "workspaces":[
	    {"workspace_id":"wR","worktree":{"repo_root":"/ours","checkout_path":"/ours"}},
	    {"workspace_id":"wF","worktree":{"repo_root":"/theirs","checkout_path":"/theirs"}}],
	  "panes":[],
	  "agents":[
	    {"name":"w42-fix","agent_status":"working","pane_id":"p1","workspace_id":"wR"},
	    {"name":"w42-fix","agent_status":"blocked","pane_id":"p2","workspace_id":"wF"},
	    {"name":"w99-theirs","agent_status":"working","pane_id":"p3","workspace_id":"wF"}]}}}`
	agents, err := parseAgents(out, "/ours")
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 1 {
		t.Fatalf("want exactly our 1 agent, got %d: %+v", len(agents), agents)
	}
	if agents[0].Status != "working" {
		t.Errorf("got the FOREIGN same-named agent's status: %+v", agents[0])
	}
}

// Provenance outranks a runtime cwd, and the cwd tier is reachable only when a
// workspace has no provenance at all. Otherwise an agent that merely cd'd into
// our tree would join our herd.
func TestParseAgentsProvenanceBeatsCwd(t *testing.T) {
	foreignWorkspaceOurCwd := `{"id":"x","result":{"type":"session_snapshot","snapshot":{
	  "version":1,"protocol":19,"tabs":[],"layouts":[],
	  "workspaces":[{"workspace_id":"wF","worktree":{"repo_root":"/theirs","checkout_path":"/theirs"}}],
	  "panes":[{"pane_id":"pF","cwd":"/ours"}],
	  "agents":[{"name":"w7-sneaky","agent_status":"working","pane_id":"pF","workspace_id":"wF","cwd":"/ours"}]}}}`
	agents, err := parseAgents(foreignWorkspaceOurCwd, "/ours")
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 0 {
		t.Errorf("a foreign worktree must beat a matching cwd, got %+v", agents)
	}

	noProvenance := `{"id":"x","result":{"type":"session_snapshot","snapshot":{
	  "version":1,"protocol":19,"tabs":[],"layouts":[],
	  "workspaces":[{"workspace_id":"wR"}],
	  "panes":[{"pane_id":"pR","cwd":"/ours"}],
	  "agents":[{"name":"w8-rooted","agent_status":"working","pane_id":"pR","workspace_id":"wR"}]}}}`
	agents, err = parseAgents(noProvenance, "/ours")
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 1 {
		t.Errorf("a workspace with no provenance should resolve via the pane cwd, got %+v", agents)
	}
}

// The cwd tier matches a root or anything beneath it, on a separator boundary.
// A worker that cd'd into a subdirectory is still ours; a sibling sharing a
// path prefix never is. Mirrors the scope.sh cases.
func TestParseAgentsCwdBoundary(t *testing.T) {
	snapCwd := func(cwd string) string {
		return `{"id":"x","result":{"type":"session_snapshot","snapshot":{
		  "version":1,"protocol":19,"tabs":[],"layouts":[],
		  "workspaces":[{"workspace_id":"wR"}],
		  "panes":[{"pane_id":"pR","cwd":"` + cwd + `"}],
		  "agents":[{"name":"w8-deep","agent_status":"working","pane_id":"pR","workspace_id":"wR"}]}}}`
	}
	agents, err := parseAgents(snapCwd("/ours/src"), "/ours")
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 1 {
		t.Errorf("a pane cwd beneath the root should resolve to us, got %+v", agents)
	}
	agents, err = parseAgents(snapCwd("/ours-other"), "/ours")
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 0 {
		t.Errorf("a prefix-sharing sibling must not resolve to us, got %+v", agents)
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

// ── installed-plugin board discovery (tier 3, GH-1761) ──────────────────────
// Mirrors lib.sh installed_board_cli(): rank by the VERSION component, never
// the whole path, and never fall back for an explicit-but-broken path.

func mkBoard(t *testing.T, home, namespace, version string, executable bool) string {
	t.Helper()
	dir := filepath.Join(home, ".claude", "plugins", "cache", namespace, "ralph", version, "scripts")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "board")
	mode := os.FileMode(0o644)
	if executable {
		mode = 0o755
	}
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"), mode); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestCompareVersionsNumericPerComponent(t *testing.T) {
	// 0.10.0 > 0.9.0 is the case a lexical sort gets wrong.
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"0.10.0", "0.9.0", 1},
		{"0.9.0", "0.10.0", -1},
		{"1.2.3", "1.2.3", 0},
		{"1.2", "1.2.0", 0},
		{"2.0.0", "1.99.99", 1},
		{"0.1.94", "0.1.9", 1},
		{"1.0.0-rc", "1.0.0", 1}, // non-numeric component: string compare
	} {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q,%q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestInstalledBoardCLIPicksNewestVersionNotNewestPath(t *testing.T) {
	home := t.TempDir()
	// "aaa" namespace holds the NEWER version: a whole-path sort would pick
	// zzz/0.9.0 — the exact trap the awk/sort -V in lib.sh avoids.
	want := mkBoard(t, home, "aaa-marketplace", "0.10.0", true)
	mkBoard(t, home, "zzz-marketplace", "0.9.0", true)
	if got := installedBoardCLI(home); got != want {
		t.Errorf("installedBoardCLI = %q, want %q", got, want)
	}
}

func TestInstalledBoardCLISkipsNonExecutableAndEmptyHome(t *testing.T) {
	home := t.TempDir()
	mkBoard(t, home, "ns", "9.9.9", false) // newest but not executable
	want := mkBoard(t, home, "ns", "0.1.0", true)
	if got := installedBoardCLI(home); got != want {
		t.Errorf("non-executable newest should be skipped: got %q, want %q", got, want)
	}
	if got := installedBoardCLI(""); got != "" {
		t.Errorf("empty HOME must not glob: got %q", got)
	}
	if got := installedBoardCLI(t.TempDir()); got != "" {
		t.Errorf("no cache dir must yield empty: got %q", got)
	}
}

func TestResolveConfigFallsBackToInstalledPluginButNotForExplicitPaths(t *testing.T) {
	home := t.TempDir()
	installed := mkBoard(t, home, "ns", "1.0.0", true)
	repo := t.TempDir() // no ralph/scripts/board inside
	env := func(k string) string {
		switch k {
		case "HOME":
			return home
		case "RALPH_HERDR_REPO":
			return repo
		}
		return ""
	}
	cfg, err := resolveConfig(nil, env)
	if err != nil {
		t.Fatalf("expected tier-3 fallback, got error: %v", err)
	}
	if cfg.Board != installed {
		t.Errorf("Board = %q, want installed %q", cfg.Board, installed)
	}
	// An explicit path that is not executable must FAIL, never silently fall
	// back to the installed copy — the operator named a specific board.
	if _, err := resolveConfig([]string{filepath.Join(repo, "nope")}, env); err == nil {
		t.Error("explicit broken argv[1] must error, not fall back")
	}
	envBad := func(k string) string {
		if k == "RALPH_HERDR_BOARD" {
			return filepath.Join(repo, "nope")
		}
		return env(k)
	}
	if _, err := resolveConfig(nil, envBad); err == nil {
		t.Error("explicit broken RALPH_HERDR_BOARD must error, not fall back")
	}
}

// ── installed copy: the registry, not the cache glob (GH-1865) ──────────────

// mkRegistry writes an installed_plugins.json recording `entries` as
// "<version>: <installPath>" pairs under the ralph@<namespace> key.
func mkRegistry(t *testing.T, dir string, entries map[string]string) string {
	t.Helper()
	var vals []string
	for ver, path := range entries {
		vals = append(vals, fmt.Sprintf(`{"installPath":%q,"version":%q}`, path, ver))
	}
	body := fmt.Sprintf(`{"plugins":{"ralph@ralph-hero":[%s],"other@m":[{"installPath":"/nope","version":"9.9.9"}]}}`,
		strings.Join(vals, ","))
	p := filepath.Join(dir, "installed_plugins.json")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRegistryBeatsCacheGlobEvenWhenGlobHasNewerVersions(t *testing.T) {
	home := t.TempDir()
	// The recorded install is the OLDER directory. The glob would pick 9.9.9 —
	// a path that exists but is not the copy Claude Code runs.
	recorded := mkBoard(t, home, "ns", "0.1.0", true)
	glob := mkBoard(t, home, "ns", "9.9.9", true)
	reg := mkRegistry(t, t.TempDir(), map[string]string{"0.1.0": filepath.Dir(filepath.Dir(recorded))})
	if got := registryBoardCLI(reg); got != recorded {
		t.Errorf("registryBoardCLI = %q, want recorded %q", got, recorded)
	}
	if got := installedBoardCLI(home); got != glob {
		t.Errorf("glob fallback should still rank by version: got %q, want %q", got, glob)
	}
	repo := t.TempDir()
	env := func(k string) string {
		switch k {
		case "HOME":
			return home
		case "RALPH_HERDR_REPO":
			return repo
		case "RALPH_INSTALLED_PLUGINS_FILE":
			return reg
		}
		return ""
	}
	cfg, err := resolveConfig(nil, env)
	if err != nil {
		t.Fatalf("resolveConfig: %v", err)
	}
	if cfg.Board != recorded {
		t.Errorf("resolveConfig Board = %q, want the recorded copy %q", cfg.Board, recorded)
	}
}

func TestRegistryUnreadableFallsBackToGlobRatherThanFailing(t *testing.T) {
	home := t.TempDir()
	glob := mkBoard(t, home, "ns", "1.2.3", true)
	repo := t.TempDir()
	bad := filepath.Join(t.TempDir(), "installed_plugins.json")
	if err := os.WriteFile(bad, []byte("not json {"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{bad, filepath.Join(t.TempDir(), "absent.json")} {
		env := func(k string) string {
			switch k {
			case "HOME":
				return home
			case "RALPH_HERDR_REPO":
				return repo
			case "RALPH_INSTALLED_PLUGINS_FILE":
				return file
			}
			return ""
		}
		cfg, err := resolveConfig(nil, env)
		if err != nil || cfg.Board != glob {
			t.Errorf("registry %q: Board = %q err = %v, want glob fallback %q", file, cfg.Board, err, glob)
		}
	}
}

func TestRegistrySkipsRecordedCopiesThatAreGone(t *testing.T) {
	// A registry entry whose tree was deleted must not win — and must not
	// suppress the glob, which may still hold a usable copy.
	home := t.TempDir()
	glob := mkBoard(t, home, "ns", "1.0.0", true)
	reg := mkRegistry(t, t.TempDir(), map[string]string{"5.0.0": filepath.Join(home, "gone")})
	if got := registryBoardCLI(reg); got != "" {
		t.Errorf("missing recorded copy must not resolve, got %q", got)
	}
	env := func(k string) string {
		switch k {
		case "HOME":
			return home
		case "RALPH_HERDR_REPO":
			return t.TempDir()
		case "RALPH_INSTALLED_PLUGINS_FILE":
			return reg
		}
		return ""
	}
	cfg, err := resolveConfig(nil, env)
	if err != nil || cfg.Board != glob {
		t.Errorf("Board = %q err = %v, want glob fallback %q", cfg.Board, err, glob)
	}
}

func TestInstalledPluginsFileHonoursConfigDir(t *testing.T) {
	if got := installedPluginsFile("/h", "/cfg", ""); got != "/cfg/plugins/installed_plugins.json" {
		t.Errorf("CLAUDE_CONFIG_DIR ignored: %q", got)
	}
	if got := installedPluginsFile("/h", "", ""); got != "/h/.claude/plugins/installed_plugins.json" {
		t.Errorf("default path wrong: %q", got)
	}
	if got := installedPluginsFile("", "", ""); got != "" {
		t.Errorf("no HOME must not root at /: %q", got)
	}
	if got := installedPluginsFile("/h", "/cfg", "/x.json"); got != "/x.json" {
		t.Errorf("override ignored: %q", got)
	}
}

// ── read-failure classification (GH-1787) ───────────────────────────────────

func TestArgsRateLimitIsRestNotGraphQL(t *testing.T) {
	got := argsRateLimit()
	if !reflect.DeepEqual(got, []string{"api", "rate_limit"}) {
		t.Fatalf("rate probe must be the REST endpoint, got %q", got)
	}
}

func TestBoardDeadlineNeverTighterThanPollInterval(t *testing.T) {
	if d := boardDeadline(Config{Interval: 10 * time.Second}); d != boardTimeout {
		t.Errorf("fast cadence must keep the cold-start floor, got %s", d)
	}
	if d := boardDeadline(Config{Interval: 60 * time.Second}); d != 60*time.Second {
		t.Errorf("a 60s cadence must not be guarded by a 25s deadline, got %s", d)
	}
}

func TestParseRateLimit(t *testing.T) {
	st := parseRateLimit(`{"resources":{"graphql":{"limit":5000,"remaining":0,"reset":1700000000}}}`)
	if !st.known || st.limit != 5000 || st.remaining != 0 || st.reset.Unix() != 1700000000 {
		t.Fatalf("rate limit mis-parsed: %+v", st)
	}
	if parseRateLimit("not json").known {
		t.Error("garbage must be unknown, not a zero budget")
	}
	if parseRateLimit(`{"resources":{}}`).known {
		t.Error("absent graphql resource must be unknown, not a zero budget")
	}

	// reset:0 = "no reset known". time.Unix(0,0) is a real instant and would
	// render a confident, wrong "resets 01:00 (in 0m)".
	z := parseRateLimit(`{"resources":{"graphql":{"limit":5000,"remaining":42,"reset":0}}}`)
	if !z.known || z.remaining != 42 {
		t.Fatalf("a budget with no reset is still a known budget: %+v", z)
	}
	if !z.reset.IsZero() {
		t.Errorf("missing reset must stay the zero time, got %v", z.reset)
	}
	if got := describeRateLimit(z, time.Unix(1700000000, 0)); strings.Contains(got, "resets") {
		t.Errorf("no reset known — must omit the resets clause, got %q", got)
	}
}

func TestDescribeRateLimitNamesResetTime(t *testing.T) {
	now := time.Unix(1700000000, 0)
	st := rateLimitState{known: true, limit: 5000, remaining: 0, reset: now.Add(41 * time.Minute)}
	got := describeRateLimit(st, now)
	if !strings.Contains(got, "exhausted (0/5000)") || !strings.Contains(got, "in 41m") {
		t.Fatalf("must name budget and reset, got %q", got)
	}
	if describeRateLimit(rateLimitState{}, now) != "" {
		t.Error("unknown budget must say nothing rather than guess")
	}
}

func TestExplainReadFailure(t *testing.T) {
	exhausted := func(prog string, args []string) (string, string, error) {
		return `{"resources":{"graphql":{"limit":5000,"remaining":0,"reset":9999999999}}}`, "", nil
	}
	healthy := func(prog string, args []string) (string, string, error) {
		return `{"resources":{"graphql":{"limit":5000,"remaining":4900,"reset":9999999999}}}`, "", nil
	}
	cfg := Config{Gh: "gh"}

	// 1. Deadline miss names the deadline — and never probes.
	fr := &fakeRunner{respond: exhausted}
	got := explainReadFailure(&rateProbe{cfg: cfg, r: fr}, 30*time.Second, true, "signal: killed", errors.New("signal: killed"))
	if !strings.Contains(got, "timed out after 30s") {
		t.Errorf("deadline miss must name the deadline, got %q", got)
	}
	if len(fr.calls) != 0 {
		t.Errorf("a fired deadline needs no rate probe, got %d calls", len(fr.calls))
	}

	// 2. Masked failure + exhausted budget → renamed with the reset.
	got = explainReadFailure(&rateProbe{cfg: cfg, r: &fakeRunner{respond: exhausted}},
		30*time.Second, false, "gh api graphql failed (exit 1)", errors.New("exit status 1"))
	if !strings.Contains(got, "exhausted (0/5000)") {
		t.Errorf("exhausted budget must be named, got %q", got)
	}

	// 3. Genuine failure with a healthy budget stays verbatim.
	got = explainReadFailure(&rateProbe{cfg: cfg, r: &fakeRunner{respond: healthy}},
		30*time.Second, false, "board: not authenticated (gh auth login)", errors.New("exit status 1"))
	if got != "board: not authenticated (gh auth login)" {
		t.Errorf("healthy budget must leave the message verbatim, got %q", got)
	}

	// 4. `signal: killed` never reaches the operator as-is.
	got = explainReadFailure(&rateProbe{cfg: cfg, r: &fakeRunner{respond: healthy}},
		30*time.Second, false, "signal: killed", errors.New("signal: killed"))
	if strings.Contains(got, "signal: killed") {
		t.Errorf("raw signal text must be scrubbed, got %q", got)
	}
}

func TestRateProbeConsultsAtMostOncePerPass(t *testing.T) {
	fr := &fakeRunner{respond: func(prog string, args []string) (string, string, error) {
		return `{"resources":{"graphql":{"limit":5000,"remaining":10,"reset":1}}}`, "", nil
	}}
	p := &rateProbe{cfg: Config{Gh: "gh"}, r: fr}
	for i := 0; i < 3; i++ {
		p.get()
	}
	if len(fr.calls) != 1 {
		t.Fatalf("rate probe must run once per pass, ran %d times", len(fr.calls))
	}
}

func TestLooksRateLimited(t *testing.T) {
	for _, s := range []string{"API rate limit exceeded", "RATE_LIMITED", "was submitted too quickly"} {
		if !looksRateLimited(s) {
			t.Errorf("%q must match the rate-limit markers", s)
		}
	}
	if looksRateLimited("board: item is archived") {
		t.Error("unrelated failure must not be read as a rate limit")
	}
}
