// proto — throwaway render harness for the card-markings design (not shipped).
//
// Uniform card height in every mode: selection changes ink, never geometry, so
// j/k never reflows a column and hitTest's fixed stride stays valid.
//
//	go run ./proto -w 180 -h 44                 # nerd glyphs (your Ghostty fallback font)
//	go run ./proto -w 180 -glyphs ascii         # the host-repo fallback
//	go run ./proto -w 180 -done                 # third column swapped to Done · 14d (key: D)
package main

import (
	"flag"
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

const cardRows = 4 // 3 content lines + 1 separator rule

// ── palette ─────────────────────────────────────────────────────────────────
var (
	cWhite   = lipgloss.NewStyle().Foreground(lipgloss.Color("15"))
	cWhiteB  = lipgloss.NewStyle().Foreground(lipgloss.Color("15")).Bold(true)
	cNum     = lipgloss.NewStyle().Foreground(lipgloss.Color("15"))  // white, NOT bold
	cBranch  = lipgloss.NewStyle().Foreground(lipgloss.Color("240")) // dimmed
	cMeta    = lipgloss.NewStyle().Foreground(lipgloss.Color("240"))
	cRule    = lipgloss.NewStyle().Foreground(lipgloss.Color("236"))
	cQ       = lipgloss.NewStyle().Italic(true).Foreground(lipgloss.Color("214"))
	// Parent: the theme's COMMENT ink, italic — an epic is context, not content.
	cEpic = lipgloss.NewStyle().Italic(true).Foreground(lipgloss.Color("60"))
	// Child rollup: purple, the same ink merged PRs use — both mean "landed".
	cRollup = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("141"))
	cTimer   = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))
	cGutter  = lipgloss.NewStyle().Foreground(lipgloss.Color("237"))
	cGutterS = lipgloss.NewStyle().Foreground(lipgloss.Color("15")).Bold(true) // selection: bold white

	// herdr's own status vocabulary.
	dotWorking   = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))  // yellow
	dotReporting = lipgloss.NewStyle().Foreground(lipgloss.Color("75"))  // blue
	dotBlocked   = lipgloss.NewStyle().Foreground(lipgloss.Color("203")) // red — user dialog
	dotIdle      = lipgloss.NewStyle().Foreground(lipgloss.Color("114")) // green, hollow
	dotStarting  = lipgloss.NewStyle().Foreground(lipgloss.Color("244")) // small dot
	dotNone      = lipgloss.NewStyle().Foreground(lipgloss.Color("237"))

	// PR fate.
	prOpenReady = lipgloss.NewStyle().Foreground(lipgloss.Color("114")) // green
	prPending   = lipgloss.NewStyle().Foreground(lipgloss.Color("179")) // amber
	prMerged    = lipgloss.NewStyle().Foreground(lipgloss.Color("141")) // purple
	prClosed    = lipgloss.NewStyle().Foreground(lipgloss.Color("203")) // red
	prUnread    = lipgloss.NewStyle().Foreground(lipgloss.Color("242")) // grey ? — read FAILED
	prNone      = lipgloss.NewStyle().Foreground(lipgloss.Color("237")) // no PR at all

	// Priority: red alert at P0, yellow only at P1. P2/P3 are white-filled over
	// a dimmed remainder — colour is reserved for the two that mean "now".
	pP0   = lipgloss.NewStyle().Foreground(lipgloss.Color("203")) // red [!]
	pBarF = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))  // yellow — P1 only
	pBarW = lipgloss.NewStyle().Foreground(lipgloss.Color("15"))  // white — P2/P3 filled
	pBarE = lipgloss.NewStyle().Foreground(lipgloss.Color("238")) // dimmed — unfilled

	// Worktree diff.
	diffAdd    = lipgloss.NewStyle().Foreground(lipgloss.Color("114")) // green
	diffDel    = lipgloss.NewStyle().Foreground(lipgloss.Color("203")) // red
	diffSep    = lipgloss.NewStyle().Foreground(lipgloss.Color("238"))
	diffUnread = lipgloss.NewStyle().Foreground(lipgloss.Color("242"))

	// Column counts.
	cntProgress = lipgloss.NewStyle().Foreground(lipgloss.Color("220")).Bold(true) // yellow
	cntReview   = lipgloss.NewStyle().Foreground(lipgloss.Color("208")).Bold(true) // orange
	cntHuman    = lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Bold(true) // red
	cHead       = lipgloss.NewStyle().Foreground(lipgloss.Color("250"))
	cHeadSel    = lipgloss.NewStyle().Foreground(lipgloss.Color("15")).Bold(true)
)

// ── glyphs ──────────────────────────────────────────────────────────────────
// Every codepoint below was verified present in JetBrainsMonoNerdFont-Regular.
// The Octicon PR-closed (U+F9D5) is NOT in this font — the Codicon (U+EBDA) is.
type glyphSet struct {
	branch, prOpen, prMerged, prClosed, clock, chevron, agents string
	dotFull, dotHollow, dotSmall                               string
}

var nerd = glyphSet{
	branch: "", prOpen: "", prMerged: "", prClosed: "",
	clock: "", chevron: "❯", agents: "",
	dotFull: "●", dotHollow: "○", dotSmall: "·",
}

var ascii = glyphSet{
	branch: "", prOpen: "PR", prMerged: "M", prClosed: "X",
	clock: "", chevron: ">", agents: "x",
	dotFull: "●", dotHollow: "○", dotSmall: "·",
}

var g = nerd

// ── dummy data ──────────────────────────────────────────────────────────────

type card struct {
	num    int
	title  string
	agents int
	// herdrState is the joined vocabulary: herdr's own agent_status, overridden
	// by the C8 `state` token where agent_status cannot express it (reporting,
	// spawned). Both arrive in ONE `herdr agent list` call.
	herdrState string // working|reporting|blocked|idle|done|spawned|""
	branch     string
	pr         string // ready|pending|merged|closed|unread|none
	prNum      int
	priority   string
	estimate   string
	parent     int
	parentName string
	childDone  int
	childTotal int
	// age is the AGENT's age since spawn, from ~/.ralph/<owner>/<repo>/ledger.jsonl
	// (ev:spawn ts). "" = no ledger row: an agent nobody spawned through the
	// sanctioned path. Renders as a dash, NEVER as zero.
	age      string
	question string
	// diff — lines added/removed in the agent's own worktree, measured against
	// the merge-base with origin/main. The checkout path comes from the same
	// ledger row the age does, so this costs one local `git diff --shortstat`
	// (~90 ms) and no network. diffKnown=false means the read FAILED or there
	// is no worktree to read; it is never rendered as +0/-0.
	diffAdd, diffDel int
	diffKnown        bool
}

var colsInProgress = []card{
	{1988, "Cockpit agent-issue card markings", 2, "working", "feat/1988-cockpit-card-markings", "none", 0, "P1", "M", 1930, "Cockpit legibility", 1, 4, "2d 14h 15m", "", 1233, 1234, true},
	{2057, "The merge gate passes over advisory findings", 1, "reporting", "feat/2057-the-merge-gate-passes", "none", 0, "P2", "S", 0, "", 0, 0, "3h 41m", "", 412, 88, true},
	{2061, "Board volume advisory undercounts drafts", 1, "blocked", "fix/2061-board-volume-advisory", "none", 0, "P0", "XS", 2048, "Board volume", 2, 3, "1h 07m", "", 27, 4, true},
	{2064, "Prune predicate misses apply twins", 0, "", "feat/2064-prune-predicate", "none", 0, "P2", "M", 0, "", 0, 0, "", "", 0, 0, false},
	{2071, "Doctor smell thresholds are unreadable", 1, "spawned", "feat/2071-doctor-smell-thresholds", "none", 0, "P3", "S", 0, "", 0, 0, "0h 02m", "", 0, 0, true},
}

var colsInReview = []card{
	{1994, "Release version computed from main tip", 1, "idle", "fix/1994-release-version-from-tip", "ready", 1994, "P1", "M", 0, "", 0, 0, "1d 03h 22m", "", 0, 0, false},
	{2048, "board pr-orphans selector", 1, "working", "feat/2048-board-pr-orphans", "pending", 2049, "P2", "L", 0, "", 0, 0, "6h 18m", "", 0, 0, false},
	{2050, "sweep-non-issues verb", 0, "", "feat/2050-sweep-non-issues", "closed", 2051, "P2", "M", 0, "", 0, 0, "", "", 0, 0, false},
	{2053, "Drop Node 20 from the test matrix", 1, "done", "ci/2053-drop-node-20", "unread", 2055, "P3", "XS", 0, "", 0, 0, "22m", "", 0, 0, false},
}

var colsHuman = []card{
	{1930, "Force-push funnel redirect", 1, "blocked", "feat/1930-funnel-push", "ready", 1931, "P0", "M", 0, "", 0, 0, "4d 02h 11m", "Should the rail fail open when gh cannot read PR state?", 0, 0, false},
	{2039, "Apply evidence ancestry check", 1, "blocked", "feat/2039-apply-evidence", "unread", 0, "P1", "L", 1961, "Apply gates", 3, 5, "2d 19h 44m", "Which merge do we treat as the fix when the twin has two?", 0, 0, false},
}

var colsDone = []card{
	{2050, "sweep-non-issues verb", 0, "", "feat/2050-sweep-non-issues", "merged", 2051, "P2", "M", 0, "", 0, 0, "", "", 0, 0, false},
	{2040, "Board volume prune predicate", 0, "", "feat/2040-prune", "merged", 2041, "P1", "L", 2048, "Board volume", 2, 3, "", "", 0, 0, false},
	{1996, "Merged-PR search replaces the refs read", 0, "", "fix/1996-merged-pr-search", "merged", 1997, "P0", "M", 0, "", 0, 0, "", "", 0, 0, false},
}

func main() {
	w := flag.Int("w", 180, "terminal width")
	h := flag.Int("h", 44, "terminal height")
	glyphs := flag.String("glyphs", "nerd", "nerd|ascii")
	done := flag.Bool("done", false, "swap the third column to Done · 14d (the D key)")
	flag.Parse()
	if *glyphs == "ascii" {
		g = ascii
	}

	cols := [3][]card{colsInProgress, colsInReview, colsHuman}
	names := [3]string{"In Progress", "In Review", "Human Needed"}
	counts := [3]lipgloss.Style{cntProgress, cntReview, cntHuman}
	if *done {
		cols[2] = colsDone
		names[2] = "Done · 14d"
	}

	selCol, selRow := 0, 1
	fmt.Println(board(cols, names, counts, *w, *h, selCol, selRow))
	fmt.Println()
	legend := "h/l col · j/k card · ⏎ observe · ␣/o peek · r reply · a answer · s spawn · f fork · v dag · d diff · D done⇄human · g browser · q quit"
	fmt.Println(cMeta.Render(trunc(legend, *w)))
}

func board(cols [3][]card, names [3]string, counts [3]lipgloss.Style, width, height, selCol, selRow int) string {
	gap := 2
	colW := (width - 2*gap) / 3
	visible := (height - 4) / cardRows
	if visible < 1 {
		visible = 1
	}
	out := make([]string, 0, 5)
	for i := range cols {
		out = append(out, column(cols[i], names[i], counts[i], i, colW, visible, selCol, selRow))
		if i < 2 {
			out = append(out, strings.Repeat(" ", gap))
		}
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, out...)
}

func column(cards []card, name string, cnt lipgloss.Style, idx, width, visible, selCol, selRow int) string {
	var b strings.Builder
	// Header: name left, count RIGHT-justified, no parens, colour per column,
	// name bold white only when the cursor is in this column.
	hs := cHead
	if idx == selCol {
		hs = cHeadSel
	}
	n := fmt.Sprintf("%d", len(cards))
	padTo := width - lipgloss.Width(name) - lipgloss.Width(n) - 2
	if padTo < 1 {
		padTo = 1
	}
	b.WriteString(hs.Render(name) + strings.Repeat(" ", padTo) + cnt.Render(n) + "\n")
	b.WriteString(cRule.Render(strings.Repeat("━", max(1, width-2))) + "\n")

	for i, c := range cards {
		if i >= visible {
			b.WriteString(cMeta.Render(fmt.Sprintf("  +%d more", len(cards)-i)))
			break
		}
		b.WriteString(renderCard(c, width, idx == selCol && i == selRow, idx == 0))
	}
	return lipgloss.NewStyle().Width(width).Render(b.String())
}

// renderCard emits exactly cardRows lines whether selected or not.
func renderCard(c card, width int, sel, wantDiff bool) string {
	inner := width - 2 // gutter char + one space

	// ── gutter: the status dot rides the TOP line, the bar carries the rest.
	bar, barStyle := "│", cGutter
	if sel {
		bar, barStyle = "▌", cGutterS
	}
	g1 := statusDot(c)
	g23 := barStyle.Render(bar)

	// ── line 1: #num · branch · PR chip (chip right-aligned).
	numS, titleS := cNum, cWhite
	if sel {
		numS, titleS = cWhiteB, cWhiteB
	}
	num := numS.Render(fmt.Sprintf("#%d", c.num))
	agents := ""
	if c.agents > 1 {
		agents = " " + dotWorking.Render(fmt.Sprintf("%s%d", g.agents, c.agents))
	}
	// The right slot on line 1 carries ONE fact: the diff while the work is in
	// the worktree, the PR's fate once it has left. An In Progress card that
	// already has a PR shows the diff — the PR chip is In Review's signal.
	chip := prChip(c)
	if wantDiff {
		// In Progress measures the WORKTREE; the PR chip is In Review's signal,
		// so the slot never carries both and never argues with itself.
		chip = diffChip(c)
	}
	left := num + agents
	// The branch is truncated ONLY when a PR chip is competing for the row.
	avail := inner - lipgloss.Width(left) - 2
	if chip != "" {
		avail -= lipgloss.Width(chip) + 2
	}
	br := c.branch
	if g.branch != "" {
		br = g.branch + " " + br
	}
	if lipgloss.Width(br) > avail && avail > 3 {
		br = trimTo(br, avail)
	}
	l1 := left + "  " + cBranch.Render(br)
	if chip != "" {
		l1 = fill(l1, inner-lipgloss.Width(chip)) + chip
	}

	// ── line 2: title.
	l2 := titleS.Render(trimTo(c.title, inner))

	// ── line 3: priority glyph + estimate · epic rollup · timer (right).
	var l3 string
	if c.question != "" {
		l3 = cQ.Render(trimTo("? "+c.question, inner))
	} else {
		lead := priorityGlyph(c.priority)
		if c.estimate != "" {
			lead += " " + cMeta.Render("["+c.estimate+"]")
		}
		if c.parent != 0 {
			lead += "  " + epicLine(c)
		}
		timer := ageChip(c)
		l3 = fill(lead, inner-lipgloss.Width(timer)) + timer
	}

	sep := cRule.Render("  " + strings.Repeat("─", max(1, width-4)))
	return trunc(g1+" "+l1, width) + "\n" +
		trunc(g23+" "+l2, width) + "\n" +
		trunc(g23+" "+l3, width) + "\n" +
		trunc(sep, width) + "\n"
}

// statusDot renders herdr's own vocabulary: yellow working, blue reporting,
// red user-dialog/blocked, green HOLLOW idle+done, small grey dot starting.
func statusDot(c card) string {
	switch c.herdrState {
	case "working":
		return dotWorking.Render(g.dotFull)
	case "reporting":
		return dotReporting.Render(g.dotFull)
	case "blocked":
		return dotBlocked.Render(g.dotFull)
	case "idle", "done":
		return dotIdle.Render(g.dotHollow)
	case "spawned", "briefed":
		return dotStarting.Render(g.dotSmall)
	default:
		return dotNone.Render(g.dotSmall)
	}
}

// prChip — colour carries the PR's fate. Grey "?" is a read that FAILED and is
// deliberately not the ink used for "this issue has no PR".
func prChip(c card) string {
	switch c.pr {
	case "ready":
		return prOpenReady.Render(fmt.Sprintf("%s #%d", g.prOpen, c.prNum))
	case "pending":
		return prPending.Render(fmt.Sprintf("%s #%d", g.prOpen, c.prNum))
	case "merged":
		return prMerged.Render(fmt.Sprintf("%s #%d", g.prMerged, c.prNum))
	case "closed":
		return prClosed.Render(fmt.Sprintf("%s #%d", g.prClosed, c.prNum))
	case "unread":
		return prUnread.Render("? unread")
	default:
		return ""
	}
}

// diffChip — "+1233/-1234" from the agent's worktree, green over red. Silent
// when there is no worktree to read (no live agent), and an unreadable git is
// a dim "±?" rather than a zero: a repo we could not measure is not a repo
// with no changes.
func diffChip(c card) string {
	if c.herdrState == "" {
		return "" // no live agent — no worktree to measure, so say nothing
	}
	if !c.diffKnown {
		return diffUnread.Render("±?")
	}
	return diffAdd.Render(fmt.Sprintf("+%d", c.diffAdd)) +
		diffSep.Render("/") +
		diffDel.Render(fmt.Sprintf("-%d", c.diffDel))
}

// priorityGlyph — P0 is an alert, P1-P3 a three-bar meter. P1 fills all three
// in yellow; P2 two; P3 one. An unset priority renders as an empty meter, not
// as blank: null priority is a real board defect and should look like one.
func priorityGlyph(p string) string {
	bars := func(n int) string {
		marks := []string{"▁", "▃", "▅"}
		fillStyle := pBarW
		if n == 3 { // P1
			fillStyle = pBarF
		}
		out := ""
		for i, m := range marks {
			if i < n {
				out += fillStyle.Render(m)
			} else {
				out += pBarE.Render(m)
			}
		}
		return out
	}
	switch p {
	case "P0":
		return pP0.Render("[!]")
	case "P1":
		return bars(3)
	case "P2":
		return bars(2)
	case "P3":
		return bars(1)
	default:
		return bars(0)
	}
}

// epicLine — "❯ #1994 Epic: name 2/4": caret white, name brown italic, the
// done/total white bold.
func epicLine(c card) string {
	s := cWhite.Render(g.chevron) + " " + cEpic.Render(fmt.Sprintf("#%d %s", c.parent, trimTo(c.parentName, 22)))
	if c.childTotal > 0 {
		s += " " + cRollup.Render(fmt.Sprintf("%d/%d", c.childDone, c.childTotal))
	}
	return s
}

// ageChip — the AGENT's age since spawn (ledger ev:spawn ts). No ledger row =
// a dash: an agent that was never spawned through the sanctioned path is not
// an agent that is zero minutes old.
func ageChip(c card) string {
	if c.age == "" {
		return cTimer.Render(strings.TrimSpace(g.clock + " —"))
	}
	return cTimer.Render(strings.TrimSpace(g.clock+" ") + c.age)
}

// ── helpers ─────────────────────────────────────────────────────────────────

func fill(s string, to int) string {
	if d := to - lipgloss.Width(s); d > 0 {
		return s + strings.Repeat(" ", d)
	}
	return s
}

func trimTo(s string, n int) string {
	if n <= 1 || lipgloss.Width(s) <= n {
		return s
	}
	r := []rune(s)
	if len(r) > n-1 {
		r = r[:n-1]
	}
	return string(r) + "…"
}

func trunc(s string, w int) string {
	if lipgloss.Width(s) <= w {
		return s
	}
	return lipgloss.NewStyle().MaxWidth(w).Render(s)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
