// usage_test.go — the transcript join (GH-2378). The theme is the one every
// marking here keeps: "could not read" and "nothing there" and "measured"
// must render as three different things, and a number is never invented.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// A transcript row as the harness writes it: several rows per message id
// while streaming, input-side counts agreeing, output growing.
func usageRow(id, model, ts string, input, w5, w1, wtotal, read, out int) string {
	creation := ""
	if w5 != 0 || w1 != 0 {
		creation = fmt.Sprintf(`,"cache_creation":{"ephemeral_5m_input_tokens":%d,"ephemeral_1h_input_tokens":%d}`, w5, w1)
	}
	return fmt.Sprintf(`{"type":"assistant","timestamp":%q,"message":{"id":%q,"model":%q,"usage":{"input_tokens":%d,"cache_creation_input_tokens":%d,"cache_read_input_tokens":%d,"output_tokens":%d%s}}}`,
		ts, id, model, input, wtotal, read, out, creation)
}

func writeTranscript(t *testing.T, dir, sid string, rows ...string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, sid+".jsonl")
	if err := os.WriteFile(p, []byte(strings.Join(rows, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// The Go table IS ledger.sh's table. Two spellings of the same rates held
// apart by a comment is the GH-1843 drift shape; this pins byte parity.
func TestUsagePricesMatchLedgerSh(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "scripts", "ledger.sh"))
	if err != nil {
		t.Skip("ledger.sh not beside the cockpit:", err)
	}
	src := string(raw)
	const marker = "_RALPH_USAGE_PRICES='"
	i := strings.Index(src, marker)
	if i < 0 {
		t.Fatal("ledger.sh no longer carries _RALPH_USAGE_PRICES")
	}
	body := src[i+len(marker):]
	body = body[:strings.Index(body, "'")]
	var shell map[string][5]float64
	if err := json.Unmarshal([]byte(body), &shell); err != nil {
		t.Fatalf("ledger.sh price table is not JSON: %v", err)
	}
	if len(shell) != len(usagePrices) {
		t.Errorf("ledger.sh has %d rows, cockpit has %d", len(shell), len(usagePrices))
	}
	for model, row := range shell {
		got, ok := usagePrices[model]
		if !ok {
			t.Errorf("ledger.sh prices %s, the cockpit does not", model)
			continue
		}
		if want := (priceRow{row[0], row[1], row[2], row[3], row[4]}); got != want {
			t.Errorf("%s: cockpit %+v, ledger.sh %+v", model, got, want)
		}
	}
	stamp := "RALPH_USAGE_PRICE_TABLE=\"" + usagePriceTable + "\""
	if !strings.Contains(src, stamp) {
		t.Errorf("ledger.sh price table stamp differs from the cockpit's %q", usagePriceTable)
	}
	// Prefix match, longest row wins: a dated snapshot shares its family's
	// row, and claude-fable-5 must not swallow claude-fable-5-1.
	if p, ok := priceFor("claude-haiku-4-5-20251001"); !ok || p != usagePrices["claude-haiku-4-5"] {
		t.Errorf("dated haiku = %+v ok=%v", p, ok)
	}
	if p, _ := priceFor("claude-fable-5-1"); p.read != 0.25 {
		t.Errorf("fable-5-1 read = %v, want its own 0.25 row, not fable-5's", p.read)
	}
	if _, ok := priceFor("gpt-9"); ok {
		t.Error("an unknown model must not price")
	}
}

func TestReadTranscriptUsageDedupesByMessageID(t *testing.T) {
	dir := t.TempDir()
	// One message streamed as three rows (output grows 10 → 40 → 176), then
	// a second call, then a torn last line. Pre-TTL-split block on the
	// second call: total only, charged at the 1h rate.
	p := writeTranscript(t, dir, "s1",
		usageRow("msg_a", "claude-sonnet-5", "2026-09-02T10:00:00.000Z", 2, 0, 23430, 23430, 0, 10),
		usageRow("msg_a", "claude-sonnet-5", "2026-09-02T10:00:00.000Z", 2, 0, 23430, 23430, 0, 40),
		`{"type":"user","message":{"role":"user","content":"assistant said hi"}}`,
		usageRow("msg_a", "claude-sonnet-5", "2026-09-02T10:00:00.000Z", 2, 0, 23430, 23430, 0, 176),
		usageRow("msg_b", "claude-sonnet-5", "2026-09-02T10:05:00.000Z", 5, 0, 0, 1000, 23430, 100),
		`{"type":"assistant","message":{"id":"msg_c","model":"claude-son`,
	)
	u := readTranscriptUsage(p)
	if !u.Read || len(u.Calls) != 2 {
		t.Fatalf("calls = %d read=%v, want 2 deduped calls", len(u.Calls), u.Read)
	}
	// msg_a at sonnet-5 rates: 2×2 + 23430×4 + 176×10 per MTok.
	wantA := (2*2 + 23430*4 + 176*10) / 1e6
	if d := u.Calls[0].USD - wantA; d > 1e-9 || d < -1e-9 {
		t.Errorf("msg_a = %.6f, want %.6f (max output, not the sum of the stream)", u.Calls[0].USD, wantA)
	}
	if u.Calls[0].Tokens != 2+23430+176 {
		t.Errorf("msg_a tokens = %d", u.Calls[0].Tokens)
	}
	// msg_b: the unsplit 1000 cache-write tokens price at the 1h rate.
	wantB := (5*2 + 1000*4 + 23430*0.2 + 100*10) / 1e6
	if d := u.Calls[1].USD - wantB; d > 1e-9 || d < -1e-9 {
		t.Errorf("msg_b = %.6f, want %.6f", u.Calls[1].USD, wantB)
	}
	if u.LastContext != 5+23430+1000 {
		t.Errorf("last context = %d, want the LAST call's input+read+write", u.LastContext)
	}
	if u.Unpriced != 0 || u.Tokens != u.Calls[0].Tokens+u.Calls[1].Tokens {
		t.Errorf("unpriced=%d tokens=%d", u.Unpriced, u.Tokens)
	}
	if !u.Calls[1].At.Equal(time.Date(2026, 9, 2, 10, 5, 0, 0, time.UTC)) {
		t.Errorf("call time = %v", u.Calls[1].At)
	}

	// An unknown model is counted, never silently folded into a number that
	// reads complete; a transcript with no model call is NOT read.
	p2 := writeTranscript(t, dir, "s2", usageRow("m", "claude-next-9", "2026-09-02T10:00:00Z", 1, 0, 0, 0, 0, 1))
	if u2 := readTranscriptUsage(p2); !u2.Read || u2.Unpriced != 1 || u2.USD != 0 {
		t.Errorf("unknown model: %+v", u2)
	}
	p3 := writeTranscript(t, dir, "s3", `{"type":"user","message":{}}`)
	if u3 := readTranscriptUsage(p3); u3.Read {
		t.Error("a transcript with no model call must not read as measured")
	}
	if u4 := readTranscriptUsage(filepath.Join(dir, "missing.jsonl")); u4.Read {
		t.Error("a missing transcript must not read as measured")
	}
}

func TestTranscriptPathDerivesTheSlugThenGlobs(t *testing.T) {
	root := t.TempDir()
	checkout := "/Users/x/.herdr/worktrees/r/feat-1"
	derived := filepath.Join(root, transcriptSlug(checkout))
	if transcriptSlug(checkout) != "-Users-x--herdr-worktrees-r-feat-1" {
		t.Errorf("slug = %q", transcriptSlug(checkout))
	}
	writeTranscript(t, derived, "aaaa-1111", usageRow("m", "claude-sonnet-5", "2026-09-02T10:00:00Z", 1, 0, 0, 0, 0, 1))
	writeTranscript(t, filepath.Join(root, "elsewhere"), "bbbb-2222", usageRow("m", "claude-sonnet-5", "2026-09-02T10:00:00Z", 1, 0, 0, 0, 0, 1))
	if got := transcriptPath(root, checkout, "aaaa-1111"); got != filepath.Join(derived, "aaaa-1111.jsonl") {
		t.Errorf("derived path = %q", got)
	}
	if got := transcriptPath(root, checkout, "bbbb-2222"); got != filepath.Join(root, "elsewhere", "bbbb-2222.jsonl") {
		t.Errorf("glob fallback = %q", got)
	}
	if got := transcriptPath(root, "", "cccc-3333"); got != "" {
		t.Errorf("absent transcript = %q, want none", got)
	}
	// A session id that is not one never reaches the filesystem.
	for _, bad := range []string{"", "../etc", "a b", "*"} {
		if got := transcriptPath(root, checkout, bad); got != "" {
			t.Errorf("transcriptPath(%q) = %q, want refused", bad, got)
		}
	}
}

func TestReadSessionUsageReusesAnUnmovedFile(t *testing.T) {
	root := t.TempDir()
	p := writeTranscript(t, filepath.Join(root, "proj"), "sid-1", usageRow("m", "claude-sonnet-5", "2026-09-02T10:00:00Z", 1, 0, 0, 0, 0, 1))
	first := readSessionUsage(root, "", "sid-1", nil)
	if !first.Usage.Read || first.Path != p {
		t.Fatalf("first read: %+v", first)
	}
	// Same size and mtime: the cached entry comes back, not a re-parse.
	first.Usage.USD = 99 // a tracer only a cache hit would preserve
	prev := map[string]usageEntry{"sid-1": first}
	if again := readSessionUsage(root, "", "sid-1", prev); again.Usage.USD != 99 {
		t.Error("an unmoved transcript was re-parsed")
	}
	// The file grew: re-parsed, tracer gone.
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o644)
	fmt.Fprintln(f, usageRow("m2", "claude-sonnet-5", "2026-09-02T10:01:00Z", 1, 0, 0, 0, 0, 1))
	f.Close()
	if again := readSessionUsage(root, "", "sid-1", prev); again.Usage.USD == 99 || len(again.Usage.Calls) != 2 {
		t.Errorf("a grown transcript was served from cache: %+v", again.Usage)
	}
	// Gone: not the cached value — Read=false, the unread chip.
	os.Remove(p)
	if gone := readSessionUsage(root, "", "sid-1", prev); gone.Usage.Read {
		t.Error("a deleted transcript kept pricing from the cache")
	}
}

// The trio on the card: no session → nothing; session known, transcript
// unreadable → `$—`; measured → the number. Plus the join order: the live
// agent's own session first, the ledger's durable copy for an exited one.
func TestCostChipTrioAndTheSessionJoin(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.ledger = Ledger{Read: true,
		ByRef:    map[string]LedgerSpawn{"w10-ten#a": {Ref: "w10-ten#a", Issue: 10, Checkout: "/wt/10"}, "w30-x#d": {Ref: "w30-x#d", Issue: 30}},
		ByIssue:  map[int]LedgerSpawn{10: {Ref: "w10-ten#a", Issue: 10, Checkout: "/wt/10"}, 30: {Ref: "w30-x#d", Issue: 30}},
		Usage:    map[string]LedgerUsage{},
		Sessions: map[string]string{"w30-x#d": "sid-30-exited"},
	}
	m.agents = setAgents([]Agent{
		{Name: "w10-ten", Status: "working", Issue: 10, Lane: "w", Root: "w10-ten#a", Session: "sid-10"},
		{Name: "w11-x", Status: "working", Issue: 11, Lane: "w", Session: "sid-11"},
		{Name: "w12-x", Status: "working", Issue: 12, Lane: "w"},
	})
	m.usage = map[string]usageEntry{
		"sid-10":        {Usage: SessionUsage{Read: true, USD: 2.414, LastContext: 98_000}},
		"sid-11":        {}, // known, unreadable
		"sid-30-exited": {Usage: SessionUsage{Read: true, USD: 0.5}},
	}
	g := m.glyphSet()
	if got := costChip(m, Card{Number: 10}, g); !strings.Contains(got, "$2.41") {
		t.Errorf("measured = %q", got)
	}
	if got := costChip(m, Card{Number: 11}, g); !strings.Contains(got, "$—") {
		t.Errorf("unread = %q, want $—", got)
	}
	// A transcript that READ but carries a call with no price row is not
	// measured: `$—`, and it counts for nothing in the column total.
	m.usage["sid-10"] = usageEntry{Usage: SessionUsage{Read: true, USD: 2.414, Unpriced: 1}}
	if got := costChip(m, Card{Number: 10}, g); !strings.Contains(got, "$—") {
		t.Errorf("unpriced model = %q, want $—", got)
	}
	if _, ok := m.columnSpend([]Card{{Number: 10}}); ok {
		t.Error("an unpriced session contributed to a column total")
	}
	m.usage["sid-10"] = usageEntry{Usage: SessionUsage{Read: true, USD: 2.414, LastContext: 98_000}}
	if got := costChip(m, Card{Number: 12}, g); got != "" {
		t.Errorf("no session = %q, want nothing", got)
	}
	// The exited unit resolves through the ledger's claude_session.
	if got := costChip(m, Card{Number: 30}, g); !strings.Contains(got, "$0.50") {
		t.Errorf("exited unit via ledger session = %q", got)
	}
	// The three renders are pairwise distinct as strings, not only as facts.
	a, b, c := costChip(m, Card{Number: 10}, g), costChip(m, Card{Number: 11}, g), costChip(m, Card{Number: 12}, g)
	if a == b || b == c || a == c {
		t.Errorf("trio collapsed: %q %q %q", a, b, c)
	}
	// Targets: the two live sessions plus the exited one on a card; #12 has
	// none; the live agent's checkout names the transcript dir.
	targets := m.usageTargets()
	if len(targets) != 3 || targets[0].Session != "sid-10" || targets[0].Checkout != "/wt/10" {
		t.Errorf("targets = %+v", targets)
	}
	// A Done card prices when its transcript exists — right of the label —
	// and an unsessioned close draws nothing at all.
	m.showDone = true
	m.doneCards = []Card{{Number: 30, State: doneState, Title: "shipped", ClosedAt: time.Now().Add(-3 * time.Hour).UTC().Format(time.RFC3339)}}
	line3 := strings.Split(renderCard(m, 2, 0, m.doneCards[0], 60), "\n")[2]
	if !strings.Contains(line3, "closed") || !strings.Contains(line3, "$0.50") {
		t.Errorf("done line 3 = %q, want closed label + cost", line3)
	}
	line3 = strings.Split(renderCard(m, 2, 0, Card{Number: 77, State: doneState, Title: "old", ClosedAt: "2026-09-01T00:00:00Z"}, 60), "\n")[2]
	if strings.Contains(line3, "$") {
		t.Errorf("unsessioned done card = %q, want no chip", line3)
	}
	// The Human Needed card keeps the question on line 3 and carries the
	// cost on line 1's right slot.
	m.usage["sid-30-exited"] = usageEntry{Usage: SessionUsage{Read: true, USD: 5.22}}
	rows := strings.Split(renderCard(m, 2, 0, Card{Number: 30, State: "Human Needed", Title: "q", Question: "which?"}, 60), "\n")
	if !strings.Contains(rows[0], "$5.22") || strings.Contains(rows[2], "$") || !strings.Contains(rows[2], "which?") {
		t.Errorf("HN card: line1=%q line3=%q", rows[0], rows[2])
	}
}

func TestContextAlertIsGatedAt120kAndTurnsRedAt160k(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.agents = setAgents([]Agent{{Name: "w10-ten", Status: "working", Issue: 10, Lane: "w", Session: "sid-10"}})
	g := m.glyphSet()
	set := func(ctx int) {
		m.usage = map[string]usageEntry{"sid-10": {Usage: SessionUsage{Read: true, USD: 1, LastContext: ctx}}}
	}
	set(119_999)
	if got := ctxChip(m, Card{Number: 10}, g); got != "" {
		t.Errorf("below the gate = %q, want nothing", got)
	}
	set(120_000)
	amber := ctxChip(m, Card{Number: 10}, g)
	if !strings.Contains(amber, g.ctx+"120k") {
		t.Errorf("at the gate = %q, want %s120k", amber, g.ctx)
	}
	set(151_400)
	if got := ctxChip(m, Card{Number: 10}, g); !strings.Contains(got, "151k") {
		t.Errorf("151k = %q", got)
	}
	set(160_000)
	red := ctxChip(m, Card{Number: 10}, g)
	if !strings.Contains(red, "160k") {
		t.Errorf("at hot = %q", red)
	}
	// The test binary renders without a colour profile, so the ink is
	// asserted on the style the chip picks, not on the escape it emits.
	if ctxInk(120_000).GetForeground() == ctxInk(160_000).GetForeground() || ctxInk(159_999).GetForeground() != ctxInk(120_000).GetForeground() {
		t.Error("amber and red must be two inks with the line at 160k")
	}
	// Unread context is not drawn — the `$—` beside it carries the fact.
	m.usage = map[string]usageEntry{"sid-10": {}}
	if got := ctxChip(m, Card{Number: 10}, g); got != "" {
		t.Errorf("unread context = %q, want nothing", got)
	}
	// On the card: cost, then alert, then age, in that order.
	set(151_400)
	line3 := strings.Split(renderCard(m, 0, 0, Card{Number: 10, State: "In Progress", Title: "t", Priority: "P1", Estimate: "S"}, 70), "\n")[2]
	i, j := strings.Index(line3, "$1.00"), strings.Index(line3, "151k")
	if i < 0 || j < 0 || i > j {
		t.Errorf("line 3 = %q, want $1.00 left of 151k", line3)
	}
}

func TestColumnHeaderCarriesTheMeasuredTotal(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.agents = setAgents([]Agent{
		{Name: "w10-ten", Status: "working", Issue: 10, Lane: "w", Session: "s10"},
		{Name: "w11-x", Status: "working", Issue: 11, Lane: "w", Session: "s11"},
	})
	m.usage = map[string]usageEntry{
		"s10": {Usage: SessionUsage{Read: true, USD: 1.25}},
		"s11": {}, // unread — contributes nothing, its own card says $—
	}
	head := strings.Split(renderColumn(m, 0, 60, 30, false), "\n")[0]
	if !strings.Contains(head, "$1.25") {
		t.Errorf("In Progress header = %q, want $1.25 left of the count", head)
	}
	if i, j := strings.Index(head, "$1.25"), strings.LastIndex(head, "3"); i > j {
		t.Errorf("total must sit LEFT of the count: %q", head)
	}
	// A column with nothing measured draws no total — never $0.00.
	m.usage = map[string]usageEntry{}
	if head := strings.Split(renderColumn(m, 0, 60, 30, false), "\n")[0]; strings.Contains(head, "$") {
		t.Errorf("unpriced column header = %q, want no total", head)
	}
}

func TestHeaderStatsCutFromTheRight(t *testing.T) {
	m := testModel(&fakeRunner{})
	now := time.Date(2026, 9, 2, 15, 0, 0, 0, time.Local)
	m.usage = map[string]usageEntry{
		"s10": {Usage: SessionUsage{Read: true, Calls: []CallUsage{
			{At: now.Add(-30 * time.Minute), USD: 1.5, Tokens: 2_000_000},
			{At: now.Add(-3 * time.Hour), USD: 2.0, Tokens: 1_100_000},
			{At: now.Add(-30 * time.Hour), USD: 40, Tokens: 9_000_000}, // yesterday
		}}},
		"s11": {}, // unread: nothing to add
	}
	m.gql, m.gqlOK = 3812, true
	m.width = 200
	line := headerLine(m, "ralph cockpit — r", now)
	for _, want := range []string{"$3.50 today", "3.1M", "$1.50/h", "gql 3,812", "● 1", "● 1"} {
		if !strings.Contains(line, want) {
			t.Errorf("wide header = %q, missing %q", line, want)
		}
	}
	if lipgloss.Width(line) != 200 {
		t.Errorf("header width = %d, want right-justified to 200", lipgloss.Width(line))
	}
	// Narrower: the GraphQL weight goes first, then the burn rate — the
	// title and the fleet dots survive longest.
	m.width = 60
	line = headerLine(m, "ralph cockpit — r", now)
	if strings.Contains(line, "gql") || !strings.HasPrefix(line, "ralph cockpit — r") {
		t.Errorf("w=60 header = %q, want gql cut and the title intact", line)
	}
	if lipgloss.Width(line) > 60 {
		t.Errorf("w=60 header overflows: %d", lipgloss.Width(line))
	}
	m.width = 20
	if line = headerLine(m, "ralph cockpit — r", now); line != "ralph cockpit — r" {
		t.Errorf("w=20 header = %q, want the bare title", line)
	}
	m.width = 10
	if line = headerLine(m, "ralph cockpit — r", now); lipgloss.Width(line) > 10 {
		t.Errorf("w=10 header = %q, must truncate", line)
	}
	// An unreadable spend log draws no gql at all — not 0.
	m.width, m.gqlOK = 200, false
	if line = headerLine(m, "t", now); strings.Contains(line, "gql") {
		t.Errorf("unreadable budget rendered: %q", line)
	}
	// No transcript read at all: no dollar stats either.
	m.usage = nil
	if line = headerLine(m, "t", now); strings.Contains(line, "today") {
		t.Errorf("no usage rendered dollars: %q", line)
	}
	m.usage = map[string]usageEntry{"a": {}, "b": {Usage: SessionUsage{Read: true, Unpriced: 2, USD: 1}}}
	if line = headerLine(m, "t", now); strings.Contains(line, "today") {
		t.Errorf("all-unreadable usage rendered dollars as $0.00: %q", line)
	}
	if groupThousands(0) != "0" || groupThousands(999) != "999" || groupThousands(1000) != "1,000" || groupThousands(1234567) != "1,234,567" {
		t.Errorf("groupThousands: %s %s %s", groupThousands(999), groupThousands(1000), groupThousands(1234567))
	}
}

// Two passes in flight over different target sets: the one landing last
// must not erase what the other priced, and a session no card names any
// more is dropped.
func TestUsagePassesMergeAndPruneRatherThanReplace(t *testing.T) {
	m := testModel(&fakeRunner{})
	m.agents = setAgents([]Agent{
		{Name: "w10-ten", Status: "working", Issue: 10, Lane: "w", Session: "s10"},
		{Name: "w11-x", Status: "working", Issue: 11, Lane: "w", Session: "s11"},
	})
	priced := func(usd float64) usageEntry { return usageEntry{Usage: SessionUsage{Read: true, USD: usd}} }
	// The agents pass priced both; a board pass dispatched for #11 alone
	// lands after it.
	m.mergeUsage(map[string]usageEntry{"s10": priced(1), "s11": priced(2)})
	m.mergeUsage(map[string]usageEntry{"s11": priced(2.5), "s99": priced(9)})
	if m.usage["s10"].Usage.USD != 1 || m.usage["s11"].Usage.USD != 2.5 {
		t.Errorf("merge lost a session: %+v", m.usage)
	}
	if _, stale := m.usage["s99"]; stale {
		t.Error("a session no card names survived the prune")
	}
	// #11's agent exits: its entry goes on the next merge, whatever landed.
	m.agents = setAgents([]Agent{{Name: "w10-ten", Status: "working", Issue: 10, Lane: "w", Session: "s10"}})
	m.mergeUsage(map[string]usageEntry{})
	if _, stale := m.usage["s11"]; stale || m.usage["s10"].Usage.USD != 1 {
		t.Errorf("exited session kept pricing: %+v", m.usage)
	}
}

func TestReadBudgetSpendWindowsTheTail(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "budget.jsonl")
	now := time.Date(2026, 9, 2, 15, 0, 0, 0, time.UTC)
	line := func(ago time.Duration, pts int) string {
		return fmt.Sprintf(`{"at":%q,"cmd":"list","calls":1,"points":%d}`, now.Add(-ago).Format(time.RFC3339Nano), pts)
	}
	os.WriteFile(p, []byte(strings.Join([]string{line(2*time.Hour, 500), line(59*time.Minute, 13), "garbage", line(1*time.Minute, 1)}, "\n")+"\n"), 0o644)
	if got, ok := readBudgetSpend(p, now.Add(-time.Hour)); !ok || got != 14 {
		t.Errorf("spend = %d ok=%v, want 14", got, ok)
	}
	if _, ok := readBudgetSpend(filepath.Join(dir, "nope"), now); ok {
		t.Error("a missing log read as ok")
	}
	if _, ok := readBudgetSpend("", now); ok {
		t.Error("no path read as ok")
	}
	// A log past the tail bound: the torn head line is dropped, the rest
	// counted.
	var b strings.Builder
	for i := 0; i < 20000; i++ {
		b.WriteString(line(30*time.Minute, 1))
		b.WriteByte('\n')
	}
	os.WriteFile(p, []byte(b.String()), 0o644)
	got, ok := readBudgetSpend(p, now.Add(-time.Hour))
	if !ok || got == 0 || got >= 20000 {
		t.Errorf("tailed spend = %d ok=%v, want a bounded positive count", got, ok)
	}
}

func TestParseAgentsCarriesTheClaudeSession(t *testing.T) {
	agents, err := parseAgents(snap("/repo", `{"name":"w10-ten","agent_status":"working","workspace_id":"wR","pane_id":"p1",
	  "agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"7f9e2f19-5766-4fe8-8728-6a72a057584c"},"tokens":{}},
	  {"name":"w11-x","agent_status":"working","workspace_id":"wR","pane_id":"p2","agent_session":{"value":7},"tokens":{}},
	  {"name":"w12-x","agent_status":"idle","workspace_id":"wR","pane_id":"p3"}`), "/repo")
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 3 || agents[0].Session != "7f9e2f19-5766-4fe8-8728-6a72a057584c" {
		t.Errorf("agents = %+v", agents)
	}
	// A non-string value and an absent object are both "" — chrome lost,
	// overlay kept.
	if agents[1].Session != "" || agents[2].Session != "" {
		t.Errorf("loose session values: %q %q", agents[1].Session, agents[2].Session)
	}
}

func TestReadLedgerKeepsTheClaudeSessionPerRef(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "ledger.jsonl")
	os.WriteFile(p, []byte(strings.Join([]string{
		`{"ts":"2026-09-02T10:00:00Z","ev":"spawn","agent_ref":"w30-x#d","lineage":{"issue":30,"spawned_at":"2026-09-02T10:00:00Z"},"tokens":{}}`,
		`{"ts":"2026-09-02T10:01:00Z","ev":"state","agent_ref":"w30-x#d","claude_session":"sid-30"}`,
		`{"ts":"2026-09-02T10:02:00Z","ev":"state","agent_ref":"w30-x#d"}`,
		`{"ts":"2026-09-02T11:00:00Z","ev":"exit","agent_ref":"w30-x#d","claude_session":""}`,
	}, "\n")+"\n"), 0o644)
	l := readLedger(p)
	if !l.Read || l.Sessions["w30-x#d"] != "sid-30" {
		t.Errorf("sessions = %+v read=%v, want last-non-empty sid-30", l.Sessions, l.Read)
	}
}
