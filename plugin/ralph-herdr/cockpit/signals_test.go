// signals_test.go — the machine-local markings. The theme throughout is that
// every reader has to keep "I could not measure this" distinguishable from a
// value, because the whole point of a marking is that an operator trusts it.
package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestResolveGlyphsDefaultsToASCII(t *testing.T) {
	// Opting in to a font requirement must be deliberate: without the font the
	// glyphs render as tofu at the wrong advance width, which shears the
	// fixed-stride card grid the mouse maps through.
	for _, raw := range []string{"", "ascii", "yes", "NERDFONT", "true", " "} {
		if got := resolveGlyphs(raw); got.branch != "" {
			t.Errorf("resolveGlyphs(%q) opted into Nerd Font glyphs", raw)
		}
	}
	for _, raw := range []string{"nerd", "NERD", " nerd "} {
		if got := resolveGlyphs(raw); got.branch == "" {
			t.Errorf("resolveGlyphs(%q) should be the nerd set", raw)
		}
	}
	// The three dots are ordinary Unicode, not Nerd Font — the status dot must
	// survive on a host with no special font at all.
	if asciiGlyphs.dotFull == "" || asciiGlyphs.dotHollow == "" || asciiGlyphs.dotSmall == "" {
		t.Error("the status dots must never be gated behind the font knob")
	}
}

func TestLedgerPathMirrorsRalphLedgerPath(t *testing.T) {
	dir := t.TempDir()
	env := func(kv map[string]string) func(string) string {
		return func(k string) string { return kv[k] }
	}

	// The explicit override wins outright, no scope read at all.
	if got := ledgerPath(dir, env(map[string]string{"RALPH_HERDR_LEDGER": "/x/y.jsonl"})); got != "/x/y.jsonl" {
		t.Errorf("override ignored: %q", got)
	}

	// No scope config anywhere = no ledger, NOT a guessed path. A wrong path
	// would read as an empty ledger, i.e. every agent ageless, with no hint why.
	if got := ledgerPath(dir, env(map[string]string{"HOME": dir})); got != "" {
		t.Errorf("unscoped repo resolved to %q, want empty", got)
	}

	// .claude/settings.json's env block is the fallback source.
	os.MkdirAll(filepath.Join(dir, ".claude"), 0o755)
	os.WriteFile(filepath.Join(dir, ".claude", "settings.json"),
		[]byte(`{"env":{"RALPH_GH_OWNER":"cdubiel08","RALPH_GH_REPO":"ralph-hero"}}`), 0o644)
	want := filepath.Join(dir, "cdubiel08", "ralph-hero", "ledger.jsonl")
	if got := ledgerPath(dir, env(map[string]string{"RALPH_HERDR_LEDGER_ROOT": dir})); got != want {
		t.Errorf("settings.json scope = %q, want %q", got, want)
	}

	// .ralph.json wins over it, wholesale per file — never mixing fields
	// across the two, which is board.ts loadConfig's own rule.
	os.WriteFile(filepath.Join(dir, ".ralph.json"), []byte(`{"owner":"other","repo":"board"}`), 0o644)
	want = filepath.Join(dir, "other", "board", "ledger.jsonl")
	if got := ledgerPath(dir, env(map[string]string{"RALPH_HERDR_LEDGER_ROOT": dir})); got != want {
		t.Errorf(".ralph.json scope = %q, want %q", got, want)
	}
}

func TestLedgerSlugKeepsScopesInjective(t *testing.T) {
	// '-' is legal in both owner and repo names, so the ledger nests
	// <owner>/<repo> rather than joining them: foo-bar/baz and foo/bar-baz
	// would otherwise interleave into one file.
	if ledgerSlug("a/b") != "a-b" {
		t.Errorf("path separators must not survive slugging: %q", ledgerSlug("a/b"))
	}
	if ledgerSlug("..") != "_.." || ledgerSlug(".") != "_." {
		t.Error("dot entries must not resolve to the parent/current directory")
	}
	if ledgerSlug("ralph-hero") != "ralph-hero" {
		t.Error("ordinary names must pass through unchanged")
	}
}

const ledgerFixture = `{"ts":"2026-08-17T04:05:14Z","ev":"spawn","agent_ref":"w2061-cockpit#aaa","pane_id":"p1","checkout":"/wt/2061","lineage":{"issue":2061,"spawned_at":"2026-08-17T04:00:00Z"},"tokens":{"branch":"feat/2061-cockpit","state":"spawned"}}
not json at all
{"ts":"2026-08-16T17:16:26Z","ev":"spawn","agent_ref":"w2053-node#bbb","checkout":"/wt/2053","lineage":{"issue":2053,"spawned_at":"2026-08-16T17:16:26Z"},"tokens":{"branch":"ci/2053-node"}}
{"ts":"2026-08-16T23:22:06Z","ev":"exit","agent_ref":"w2053-node#bbb","reason":"pane_closed"}
{"ts":"2026-08-17T05:00:00Z","ev":"spawn","agent_ref":"w2053-node#ccc","checkout":"/wt/2053b","lineage":{"issue":2053,"spawned_at":"2026-08-17T05:00:00Z"},"tokens":{"branch":"ci/2053-node"}}
{"ts":"nonsense","ev":"spawn","agent_ref":"w9-bad#ddd","lineage":{"issue":9}}
`

func TestReadLedgerJoinsOnAgentRefNotName(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ledger.jsonl")
	if err := os.WriteFile(path, []byte(ledgerFixture), 0o644); err != nil {
		t.Fatal(err)
	}
	l := readLedger(path)
	if !l.Read {
		t.Fatal("a readable ledger must report Read")
	}
	// Two spawns of #2053 share a NAME and differ only by agent_ref. Both must
	// survive as separate records — collapsing them by name is how an age chip
	// silently reports a dead session's clock after a respawn.
	if len(l.ByRef) != 3 {
		t.Errorf("ByRef has %d records, want 3 (two of them same-named)", len(l.ByRef))
	}
	first, ok := l.ByRef["w2053-node#bbb"]
	if !ok || first.Checkout != "/wt/2053" {
		t.Errorf("the superseded spawn must remain addressable by its own ref: %+v", first)
	}

	// lineage.spawned_at is the spawner's stamp and wins over the ledger's own
	// write time — they differ by 5m14s in this fixture.
	sp := l.ByRef["w2061-cockpit#aaa"]
	if want := time.Date(2026, 8, 17, 4, 0, 0, 0, time.UTC); !sp.SpawnedAt.Equal(want) {
		t.Errorf("SpawnedAt = %v, want lineage.spawned_at %v", sp.SpawnedAt, want)
	}
	if sp.Branch != "feat/2061-cockpit" || sp.Checkout != "/wt/2061" {
		t.Errorf("spawn row lost its branch/checkout: %+v", sp)
	}

	// ByIssue keeps the NEWEST spawn — it answers "what branch is this unit
	// on", a fact that outlives the session that took it.
	if got := l.ByIssue[2053]; got.Ref != "w2053-node#ccc" {
		t.Errorf("ByIssue[2053] = %q, want the newest spawn", got.Ref)
	}
	// An unparseable timestamp is not a spawn we can age, so it is dropped
	// rather than admitted with a zero time that would render as decades old.
	if _, ok := l.ByRef["w9-bad#ddd"]; ok {
		t.Error("a row with an unparseable stamp must not become a datable spawn")
	}
	// A torn line in the middle must not cost the rows after it.
	if _, ok := l.ByRef["w2053-node#ccc"]; !ok {
		t.Error("a malformed line aborted the scan")
	}
}

func TestReadLedgerAbsentFileIsNotAnEmptyLedger(t *testing.T) {
	l := readLedger(filepath.Join(t.TempDir(), "nope.jsonl"))
	if l.Read {
		t.Error("an unreadable ledger must not report Read — the caller keeps its last good one")
	}
	if l.ByRef == nil || l.ByIssue == nil {
		t.Error("the maps must be usable even when the read failed")
	}
	if readLedger("").Read {
		t.Error("an unresolved path must not report Read")
	}
}

// diffRunner answers git calls from a table keyed on the subcommand.
type diffRunner struct {
	mergeBase map[string]string // ref → sha, absent = that ref fails
	shortstat string
	statErr   bool
	calls     [][]string
}

func (d *diffRunner) Run(_ context.Context, prog string, args ...string) (string, string, error) {
	d.calls = append(d.calls, append([]string{prog}, args...))
	for i, a := range args {
		if a == "merge-base" {
			ref := args[i+2]
			if sha, ok := d.mergeBase[ref]; ok {
				return sha + "\n", "", nil
			}
			return "", "unknown revision", errors.New("exit 128")
		}
		if a == "diff" {
			if d.statErr {
				return "", "not a git repository", errors.New("exit 128")
			}
			return d.shortstat, "", nil
		}
	}
	return "", "", nil
}

func TestWorktreeDiffDistinguishesUnreadableFromClean(t *testing.T) {
	ctx := context.Background()

	// A real measurement, including the empty shortstat that means "this
	// worktree sits at its base" — Known, with zeroes.
	clean := &diffRunner{mergeBase: map[string]string{"origin/HEAD": "abc"}, shortstat: ""}
	if st := worktreeDiff(ctx, clean, "/wt"); !st.Known || st.Add != 0 || st.Del != 0 {
		t.Errorf("an empty shortstat is a measurement, not a failure: %+v", st)
	}

	full := &diffRunner{
		mergeBase: map[string]string{"origin/HEAD": "abc"},
		shortstat: " 7 files changed, 1233 insertions(+), 1234 deletions(-)\n",
	}
	if st := worktreeDiff(ctx, full, "/wt"); !st.Known || st.Add != 1233 || st.Del != 1234 {
		t.Errorf("shortstat parse = %+v", st)
	}

	// No merge base at all — neither origin/HEAD nor origin/main resolves.
	// Unknown, so the chip renders ±? and never +0/-0.
	if st := worktreeDiff(ctx, &diffRunner{mergeBase: map[string]string{}}, "/wt"); st.Known {
		t.Error("an unresolvable merge base must not read as a measured worktree")
	}
	// A failing `git diff` is the same: not measured.
	fail := &diffRunner{mergeBase: map[string]string{"origin/HEAD": "abc"}, statErr: true}
	if st := worktreeDiff(ctx, fail, "/wt"); st.Known {
		t.Error("a failed diff must not read as a clean worktree")
	}
	// And no checkout to measure costs no git process at all.
	none := &diffRunner{}
	if st := worktreeDiff(ctx, none, ""); st.Known || len(none.calls) != 0 {
		t.Error("an empty checkout must be measured with zero processes")
	}
}

func TestWorktreeDiffFallsBackToOriginMain(t *testing.T) {
	// origin/HEAD is the right answer and is what a normal clone has; a
	// worktree created without it must fall back rather than reporting every
	// In Progress card unreadable.
	r := &diffRunner{
		mergeBase: map[string]string{"origin/main": "abc"},
		shortstat: " 1 file changed, 2 insertions(+)\n",
	}
	st := worktreeDiff(context.Background(), r, "/wt")
	if !st.Known || st.Add != 2 || st.Del != 0 {
		t.Errorf("fallback measurement = %+v", st)
	}
}

func TestParseShortstatSingularAndInsertOnly(t *testing.T) {
	// git says "1 insertion(+)" and drops the deletions clause entirely when
	// there are none — a regex demanding both, or plurals, silently reads zero.
	for _, tc := range []struct {
		in       string
		add, del int
	}{
		{" 1 file changed, 1 insertion(+)\n", 1, 0},
		{" 1 file changed, 1 deletion(-)\n", 0, 1},
		{" 3 files changed, 10 insertions(+), 4 deletions(-)\n", 10, 4},
		{" 2 files changed\n", 0, 0},
	} {
		got := parseShortstat(tc.in)
		if !got.Known || got.Add != tc.add || got.Del != tc.del {
			t.Errorf("parseShortstat(%q) = %+v, want +%d/-%d", tc.in, got, tc.add, tc.del)
		}
	}
}

func TestFormatAgeIsMinutePrecision(t *testing.T) {
	for _, tc := range []struct {
		d    time.Duration
		want string
	}{
		{0, "0m"},
		{90 * time.Second, "1m"},
		{41*time.Minute + 59*time.Second, "41m"},
		{3*time.Hour + 41*time.Minute, "3h 41m"},
		{2*24*time.Hour + 14*time.Hour + 15*time.Minute, "2d 14h 15m"},
		// A clock skew (or a ledger written on another host) renders as 0m,
		// not as a negative duration. "—" stays reserved for the stronger
		// fact that there is no record at all.
		{-5 * time.Minute, "0m"},
	} {
		if got := formatAge(tc.d); got != tc.want {
			t.Errorf("formatAge(%v) = %q, want %q", tc.d, got, tc.want)
		}
	}
}

// A present sqlite tape is served, full stop (GH-2311 phase D): the frozen
// JSONL beside it must never answer, or every spawn after the flip renders
// invisible to the cockpit.
func TestReadLedgerPrefersPresentSqliteTape(t *testing.T) {
	if _, err := exec.LookPath("sqlite3"); err != nil {
		t.Skip("sqlite3 not on PATH")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "ledger.jsonl")
	// The frozen JSONL names ONLY a stale spawn; the tape carries the fixture.
	stale := `{"ts":"2026-08-01T00:00:00Z","ev":"spawn","agent_ref":"w1-stale#zzz","lineage":{"issue":1,"spawned_at":"2026-08-01T00:00:00Z"}}` + "\n"
	if err := os.WriteFile(path, []byte(stale), 0o644); err != nil {
		t.Fatal(err)
	}
	db := filepath.Join(dir, "ledger.sqlite")
	ddl := `CREATE TABLE facts(seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, agent TEXT, unit INTEGER, reason TEXT, pane TEXT, payload TEXT NOT NULL, phash TEXT NOT NULL UNIQUE); PRAGMA user_version=1;`
	if out, err := exec.Command("sqlite3", db, ddl).CombinedOutput(); err != nil {
		t.Fatalf("ddl: %v %s", err, out)
	}
	row := `{"ts":"2026-08-17T04:05:14Z","ev":"spawn","agent_ref":"w2061-cockpit#aaa","lineage":{"issue":2061,"spawned_at":"2026-08-17T04:00:00Z"},"tokens":{"branch":"feat/2061-cockpit"}}`
	ins := `INSERT INTO facts(seq, ts, kind, agent, payload, phash) VALUES (1, 't', 'spawn', 'w2061-cockpit#aaa', '` + row + `', 'ph1');`
	if out, err := exec.Command("sqlite3", db, ins).CombinedOutput(); err != nil {
		t.Fatalf("insert: %v %s", err, out)
	}
	l := readLedger(path)
	if !l.Read {
		t.Fatal("a readable tape must report Read")
	}
	if _, ok := l.ByRef["w2061-cockpit#aaa"]; !ok {
		t.Error("the tape row must be served")
	}
	if _, ok := l.ByRef["w1-stale#zzz"]; ok {
		t.Error("the frozen JSONL must not be served while a tape is present")
	}

	// An unreadable present tape is "not read" — never the frozen JSONL.
	if err := os.WriteFile(db, []byte("not a database"), 0o644); err != nil {
		t.Fatal(err)
	}
	l = readLedger(path)
	if l.Read {
		t.Error("an unreadable present tape must not report Read")
	}
	if len(l.ByRef) != 0 {
		t.Error("an unreadable present tape must serve nothing, least of all the frozen JSONL")
	}
}

func TestReadLedgerKeepsTheLatestUsageFactPerRef(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ledger.jsonl")
	fixture := `{"ts":"2026-09-01T00:00:00Z","ev":"spawn","agent_ref":"w2347-usage#u1","lineage":{"issue":2347,"spawned_at":"2026-09-01T00:00:00Z"}}
{"ts":"2026-09-01T00:10:00Z","ev":"usage","agent_ref":"w2347-usage#u1","via":"event","usage":{"model":"claude-fable-5-1","calls":10,"list_usd":1.5,"max_context":100000}}
{"ts":"2026-09-01T00:20:00Z","ev":"usage","agent_ref":"w2347-usage#u1","via":"event","usage":{"model":"claude-fable-5-1","calls":37,"list_usd":7.999,"max_context":274076}}
{"ts":"2026-09-01T00:21:00Z","ev":"usage","agent_ref":"w9-nofact#u2","via":"event"}
{"ts":"not a time","ev":"usage","agent_ref":"w8-badts#u3","via":"event","usage":{"model":"x","calls":1,"list_usd":1,"max_context":1}}
`
	if err := os.WriteFile(path, []byte(fixture), 0o644); err != nil {
		t.Fatal(err)
	}
	l := readLedger(path)
	if !l.Read {
		t.Fatal("a readable ledger must report Read")
	}
	u, ok := l.Usage["w2347-usage#u1"]
	if !ok {
		t.Fatal("the usage fact must be served by agent_ref")
	}
	// Latest wins, never summed: each fact is the whole transcript re-read.
	if u.ListUSD != 7.999 || u.MaxContext != 274076 || u.Calls != 37 || u.Model != "claude-fable-5-1" {
		t.Errorf("usage = %+v, want the second (latest) fact", u)
	}
	if _, ok := l.Usage["w9-nofact#u2"]; ok {
		t.Error("a usage row with no usage object must not be served as a free session")
	}
	if _, ok := l.Usage["w8-badts#u3"]; ok {
		t.Error("a usage row with an unparseable stamp must be skipped")
	}
	// The spawn row still lands beside it — the usage arm must not eat spawns.
	if _, ok := l.ByRef["w2347-usage#u1"]; !ok {
		t.Error("the spawn row must still be served")
	}
}
