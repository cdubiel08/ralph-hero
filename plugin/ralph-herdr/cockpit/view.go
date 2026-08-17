// view.go — lipgloss rendering: three board columns (state names verbatim),
// a narrow-width single-column fallback, peek/dag overlays, the reply/answer
// input line, and a status bar with the key legend. Layout metrics are shared
// with hitTest so mouse selection and rendering can never drift.
package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

const (
	headerRows = 2 // title line + banner/blank line above the columns
	// cardRows is load-bearing: hitTest maps clicks through it as a fixed
	// stride, so the constant and the card geometry MUST move together.
	// 3 content lines + 1 separator rule.
	cardRows        = 4
	colHeaderRows   = 2 // column title + rule
	statusRows      = 2 // legend + status line
	narrowThreshold = 90
)

var (
	styleTitle   = lipgloss.NewStyle().Bold(true)
	styleBanner  = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))
	styleDim     = lipgloss.NewStyle().Faint(true)
	styleErr     = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	styleOverlay = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).Padding(0, 1)

	// ── card ink ────────────────────────────────────────────────────────────
	// Selection changes INK, never geometry: a card that reflowed under j/k
	// would move the grid beneath the cursor and invalidate the fixed stride.
	styleNum      = lipgloss.NewStyle().Foreground(lipgloss.Color("15")) // white, NOT bold
	styleNumSel   = lipgloss.NewStyle().Foreground(lipgloss.Color("15")).Bold(true)
	styleCardText = lipgloss.NewStyle().Foreground(lipgloss.Color("15"))
	styleBranch   = lipgloss.NewStyle().Foreground(lipgloss.Color("240"))
	styleMeta     = lipgloss.NewStyle().Foreground(lipgloss.Color("240"))
	styleRule     = lipgloss.NewStyle().Foreground(lipgloss.Color("236"))
	styleQuestion = lipgloss.NewStyle().Italic(true).Foreground(lipgloss.Color("214"))
	styleEpic     = lipgloss.NewStyle().Italic(true).Foreground(lipgloss.Color("60"))
	styleTimer    = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))
	styleGutter   = lipgloss.NewStyle().Foreground(lipgloss.Color("237"))
	styleGutterS  = lipgloss.NewStyle().Foreground(lipgloss.Color("15")).Bold(true)

	// Status dot — herdr's own vocabulary, joined with the C8 state token.
	dotWorking   = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))  // yellow
	dotReporting = lipgloss.NewStyle().Foreground(lipgloss.Color("75"))  // blue
	dotBlocked   = lipgloss.NewStyle().Foreground(lipgloss.Color("203")) // red — needs a human
	dotIdle      = lipgloss.NewStyle().Foreground(lipgloss.Color("114")) // green, HOLLOW
	dotStarting  = lipgloss.NewStyle().Foreground(lipgloss.Color("244")) // small grey
	dotNone      = lipgloss.NewStyle().Foreground(lipgloss.Color("237"))

	// Priority. Colour is reserved for the two that mean "now": red alert at
	// P0, yellow at P1. P2/P3 are white fill over a dimmed remainder.
	prioP0   = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
	prioFill = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))
	prioWhit = lipgloss.NewStyle().Foreground(lipgloss.Color("15"))
	prioEmpt = lipgloss.NewStyle().Foreground(lipgloss.Color("238"))

	// Worktree diff.
	diffAdd    = lipgloss.NewStyle().Foreground(lipgloss.Color("114"))
	diffDel    = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
	diffSep    = lipgloss.NewStyle().Foreground(lipgloss.Color("238"))
	diffUnread = lipgloss.NewStyle().Foreground(lipgloss.Color("242"))

	// PR chip (GH-2062). One ink per fate, and `prUnread` is the SAME grey the
	// diff chip's ±? uses — across the card, "we could not read this" has one
	// colour, and it is never a colour that also means a state.
	prReady   = lipgloss.NewStyle().Foreground(lipgloss.Color("114")) // green — checks green, no conflict
	prPending = lipgloss.NewStyle().Foreground(lipgloss.Color("214")) // amber — running, failing, or conflicted
	prMerged  = lipgloss.NewStyle().Foreground(lipgloss.Color("141")) // purple — landed
	prClosed  = lipgloss.NewStyle().Foreground(lipgloss.Color("203")) // red — closed unmerged
	prUnread  = lipgloss.NewStyle().Foreground(lipgloss.Color("242"))

	// Epic rollup: the done/total takes the SAME purple merged PRs use —
	// both mean "landed".
	styleRollup = lipgloss.NewStyle().Foreground(lipgloss.Color("141"))

	// Column headers: the count carries the column's colour, the NAME goes
	// bold white only where the cursor is.
	colCount = [3]lipgloss.Style{
		lipgloss.NewStyle().Foreground(lipgloss.Color("220")).Bold(true), // In Progress — yellow
		lipgloss.NewStyle().Foreground(lipgloss.Color("208")).Bold(true), // In Review — orange
		lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Bold(true), // Human Needed — red
	}
	styleColHead    = lipgloss.NewStyle().Foreground(lipgloss.Color("250"))
	styleColHeadSel = lipgloss.NewStyle().Foreground(lipgloss.Color("15")).Bold(true)
)

func viewModel(m Model) string {
	var b strings.Builder

	// Header + banner.
	title := "ralph cockpit"
	if m.cfg.Repo != "" {
		title += " — " + baseName(m.cfg.Repo)
	}
	if !m.lastPoll.IsZero() {
		// The cadence is shown beside the timestamp because it is adaptive: on a
		// quiet board the gap grows to minutes, and an operator who cannot see
		// the current cadence reads that silence as a hung cockpit.
		title += styleDim.Render(fmt.Sprintf("  polled %s · every %s",
			m.lastPoll.Format("15:04:05"), m.pollEvery.Round(time.Second)))
	}
	b.WriteString(truncate(styleTitle.Render(title), m.width))
	b.WriteString("\n")
	// Both facts must survive on the one banner line: a board read failure
	// is NEVER shadowed by the no-multiplexer banner (on a herdr-less host a
	// failed read would otherwise render as a calm empty board), and the
	// failure outranks the chrome note when width forces a cut.
	// Priority order, joined so a narrow terminal cuts the CHROME and keeps the
	// failure. The markings failure is third: the grey `?` chips already say it
	// per card, but a board with no In Review card has no chip to say it on.
	var banner []string
	if m.boardErr != "" {
		banner = append(banner, styleErr.Render("board read failed: "+m.boardErr))
	}
	if !m.signalsOK && m.signalsErr != "" {
		banner = append(banner, styleErr.Render("card markings unread: "+m.signalsErr))
	}
	// A failed REFRESH over a non-empty Done list is the nastiest of these: the
	// in-column message only speaks when the list is empty, so the last good
	// cards and their count would sit there looking current while the window
	// they claim to cover has moved on. Same treatment the board columns get —
	// keep the cards, name the failure — and only while the column is up.
	if m.showDone && !m.doneOK && m.doneErr != "" {
		banner = append(banner, styleErr.Render(m.doneTitle()+" stale: "+m.doneErr))
	}
	if !m.herdrOK {
		banner = append(banner, styleBanner.Render(noMuxBanner))
	}
	b.WriteString(truncate(strings.Join(banner, styleDim.Render(" · ")), m.width))
	b.WriteString("\n")

	// Body: overlay modes replace the columns; browse/input modes show them.
	bodyHeight := bodyHeightOf(m)
	switch m.mode {
	case ModePeek:
		b.WriteString(renderOverlay(m, "peek — "+m.peekWho+"  (tail, no focus steal)", m.peekText, bodyHeight))
	case ModeDag:
		b.WriteString(renderOverlay(m, "frontier DAG — eligible & blocked", m.dagText, bodyHeight))
	default:
		b.WriteString(renderColumns(m, bodyHeight))
	}
	b.WriteString("\n")

	// Input line (reply/answer) or the legend+status pair.
	switch m.mode {
	case ModeReply, ModeAnswer:
		b.WriteString(renderInput(m))
	default:
		b.WriteString(truncate(styleDim.Render(legend(m)), m.width))
		b.WriteString("\n")
		b.WriteString(truncate(m.status, m.width))
	}
	return b.String()
}

func legend(m Model) string {
	if m.mode == ModePeek || m.mode == ModeDag {
		return "esc close"
	}
	return "h/l col · j/k card · ⏎ observe · ␣/o peek · r reply · a answer · s spawn · f fork · v dag · d diff · D done⇄human · g browser · q quit"
}

// bodyHeightOf mirrors viewModel's body sizing — shared with hitTest so the
// scroll window can never drift between rendering and mouse mapping.
func bodyHeightOf(m Model) int {
	h := m.height - headerRows - statusRows
	if h < cardRows+colHeaderRows {
		h = cardRows + colHeaderRows
	}
	return h
}

// visibleCards is how many full cards fit in a column body.
func visibleCards(bodyHeight int) int {
	v := (bodyHeight - colHeaderRows) / cardRows
	if v < 1 {
		v = 1
	}
	return v
}

// colWindow is the half-open rendered range [start, end) of column idx's
// cards. The window FOLLOWS the cursor in the cursor's column — every verb
// acts on the selected card, so the selected card must always be on screen —
// and stays at the top elsewhere. Shared by renderColumn and hitTest.
func colWindow(m Model, idx, bodyHeight int) (start, end int) {
	cards := m.columnCards(idx)
	visible := visibleCards(bodyHeight)
	if idx == m.col && m.row >= visible {
		start = m.row - visible + 1
	}
	if start > len(cards)-visible {
		start = len(cards) - visible
	}
	if start < 0 {
		start = 0
	}
	end = start + visible
	if end > len(cards) {
		end = len(cards)
	}
	return start, end
}

// renderColumns lays out the three columns (or one, when narrow).
func renderColumns(m Model, bodyHeight int) string {
	if m.width < narrowThreshold {
		return renderColumn(m, m.col, m.width, bodyHeight, true)
	}
	gap := 1
	colW := (m.width - 2*gap) / 3
	if colW < 20 {
		colW = 20
	}
	cols := make([]string, 0, 3)
	for i := range columnStates {
		cols = append(cols, renderColumn(m, i, colW, bodyHeight, false))
		if i < 2 {
			cols = append(cols, strings.Repeat(" ", gap))
		}
	}
	return lipgloss.JoinHorizontal(lipgloss.Top, cols...)
}

func renderColumn(m Model, idx, width, bodyHeight int, narrow bool) string {
	cards := m.columnCards(idx)
	// Header: name left, count RIGHT-justified with no parens, the count in
	// the column's own colour and the name bold white only under the cursor —
	// so "where am I" and "how much is here" are two separate reads.
	name := m.columnTitle(idx) // board state name VERBATIM (or the Done window)
	if narrow {
		name = fmt.Sprintf("◀ %s (%d/3) ▶", name, idx+1)
	}
	nameStyle := styleColHead
	if idx == m.col {
		nameStyle = styleColHeadSel
	}
	count := fmt.Sprintf("%d", len(cards))
	pad := width - lipgloss.Width(name) - lipgloss.Width(count) - 2
	if pad < 1 {
		pad = 1
	}
	var b strings.Builder
	b.WriteString(truncate(nameStyle.Render(name)+strings.Repeat(" ", pad)+colCount[idx].Render(count), width))
	b.WriteString("\n")
	b.WriteString(truncate(styleRule.Render(strings.Repeat("━", max(1, min(width-2, 60)))), width))
	b.WriteString("\n")

	if len(cards) == 0 {
		// Four facts that must never read alike: an empty column, a Done
		// window still being read, a Done read that FAILED, and a window with
		// genuinely nothing closed in it. The third is the one that matters —
		// "the read broke" rendered as "nothing shipped in 14 days" is a
		// confident lie about the busiest column on the board.
		empty, style := "  (none)", styleDim
		if idx == 2 && m.showDone {
			switch {
			case !m.doneOK && m.doneErr != "":
				empty, style = "  (closed-issue read failed: "+m.doneErr+")", styleErr
			case !m.doneOK:
				empty = "  (reading the last " + fmt.Sprintf("%dd", m.doneWindowDays) + "…)"
			default:
				empty = "  (nothing closed in the window)"
			}
		}
		b.WriteString(truncate(style.Render(empty), width))
		b.WriteString("\n")
		return lipgloss.NewStyle().Width(width).Render(b.String())
	}
	// The window follows the cursor (colWindow) — j/k can never move the
	// selection off screen, where every verb would act on an invisible card.
	start, end := colWindow(m, idx, bodyHeight)
	for i := start; i < end; i++ {
		b.WriteString(renderCard(m, idx, i, cards[i], width))
	}
	if start > 0 || end < len(cards) {
		parts := make([]string, 0, 2)
		if start > 0 {
			parts = append(parts, fmt.Sprintf("↑%d above", start))
		}
		if end < len(cards) {
			parts = append(parts, fmt.Sprintf("+%d more", len(cards)-end))
		}
		b.WriteString(truncate(styleDim.Render("  "+strings.Join(parts, " · ")), width))
	}
	return lipgloss.NewStyle().Width(width).Render(b.String())
}

// renderCard emits exactly cardRows lines — three content lines under a
// gutter column, then a dim separator rule. UNIFORM IN EVERY STATE: selection
// changes ink only, because hitTest maps clicks through cardRows as a fixed
// stride and a card that grew or shrank under the cursor would silently move
// every card below it out from under the mouse.
//
// Gutter: the status dot rides line 1; lines 2-3 carry a bar, bold white on
// the selected card. No boxes and no per-card borders — a border is two more
// rows of chrome per card in a column that is already three cards deep.
func renderCard(m Model, colIdx, rowIdx int, card Card, width int) string {
	selected := m.mode != ModePeek && m.mode != ModeDag && colIdx == m.col && rowIdx == m.row
	g := m.glyphSet()
	inner := width - 2 // gutter char + one space
	if inner < 1 {
		inner = 1
	}

	bar, barStyle := "│", styleGutter
	if selected {
		bar, barStyle = "▌", styleGutterS
	}
	gutterTop := statusDot(m, card, g)
	gutterRest := barStyle.Render(bar)

	numStyle, textStyle := styleNum, styleCardText
	if selected {
		numStyle, textStyle = styleNumSel, styleNumSel
	}

	// ── line 1: #num · agent count · branch (dim) · right slot.
	left := numStyle.Render(fmt.Sprintf("#%d", card.Number))
	if n := len(m.agents[card.Number]); n > 1 {
		// The lane letter is deliberately gone: with a fleet, HOW MANY is the
		// operative fact and the lane is one keypress away through peek.
		left += " " + dotWorking.Render(fmt.Sprintf("%s%d", g.agents, n))
	}
	// The right slot carries ONE fact, so it can never argue with itself: the
	// worktree diff while the work is IN the worktree, the PR's fate once it
	// has left. The two are mutually exclusive by column, which is why one
	// slot suffices.
	chip := ""
	switch card.State {
	case columnStates[0]:
		chip = diffChip(m, card)
	case columnStates[1]:
		chip = prChip(m, card, g)
	}
	avail := inner - lipgloss.Width(left) - 2
	if chip != "" {
		avail -= lipgloss.Width(chip) + 2
	}
	line1 := left
	if br := m.cardBranch(card.Number); br != "" && avail > 3 {
		if g.branch != "" {
			br = g.branch + " " + br
		}
		// Truncated ONLY when the right slot is competing for the row; a card
		// with no chip gives the branch the full width.
		line1 += "  " + styleBranch.Render(trimTo(br, avail))
	}
	if chip != "" {
		line1 = pad(line1, inner-lipgloss.Width(chip)) + chip
	}

	// ── line 2: title.
	line2 := textStyle.Render(trimTo(card.Title, inner))

	// ── line 3: priority · estimate · epic · agent age (right-justified).
	var line3 string
	switch {
	case card.State == doneState:
		// A closed card from the window read has no priority and no estimate —
		// they were never fetched. Falling through to the meter would draw the
		// empty-priority glyph, which on a live card is a real defect and here
		// would be a lie about a card nobody can fix. What a closed card has
		// is when it closed.
		line3 = styleMeta.Render(trimTo(closedLabel(card, time.Now()), inner))
	case card.State == "Human Needed":
		// The phone-answerable contract: the question line, verbatim, and it
		// owns the whole row — a timer beside a question the human is meant to
		// answer is noise competing with the one thing that matters.
		q := card.Question
		if q == "" {
			q = "(question unavailable — a still answers via the board)"
		}
		line3 = styleQuestion.Render(trimTo("? "+q, inner))
	default:
		lead := priorityGlyph(card.Priority)
		if card.Estimate != "" {
			lead += " " + styleMeta.Render("["+card.Estimate+"]")
		}
		// The epic chip is the only variable-length thing on this row, so it —
		// not the timer — absorbs the width. Budgeted BEFORE it is built: the
		// timer is right-justified by `pad`, which cannot push back, so an
		// over-long epic name would simply run into it and both would be
		// unreadable. Two spaces of separator on each side.
		timer := ageChip(m, card, g)
		if epic := epicChip(m, card, g, inner-lipgloss.Width(lead)-lipgloss.Width(timer)-4); epic != "" {
			lead += "  " + epic
		}
		line3 = pad(lead, inner-lipgloss.Width(timer)) + timer
	}

	rule := styleRule.Render("  " + strings.Repeat("─", max(1, width-4)))
	return truncate(gutterTop+" "+line1, width) + "\n" +
		truncate(gutterRest+" "+line2, width) + "\n" +
		truncate(gutterRest+" "+line3, width) + "\n" +
		truncate(rule, width) + "\n"
}

// statusDot renders the joined vocabulary: yellow working, blue reporting, red
// blocked (a human is needed), green HOLLOW idle, small grey starting. Hollow
// for idle because it is the one state that means "nothing is happening" — a
// filled dot of any colour reads as activity across a column of them.
func statusDot(m Model, card Card, g glyphSet) string {
	state, ok := m.cardState(card.Number)
	if !ok {
		return dotNone.Render(g.dotSmall)
	}
	switch state {
	case stateWorking:
		return dotWorking.Render(g.dotFull)
	case stateReporting:
		return dotReporting.Render(g.dotFull)
	case stateBlocked:
		return dotBlocked.Render(g.dotFull)
	case stateIdle:
		return dotIdle.Render(g.dotHollow)
	case stateStarting:
		return dotStarting.Render(g.dotSmall)
	default:
		return dotNone.Render(g.dotSmall)
	}
}

// diffChip — "+123/-45" from the agent's own worktree, green over red. Three
// cases that must not look alike: no live agent renders NOTHING (there is no
// worktree to measure), an unreadable or not-yet-measured git renders a dim
// "±?", and a real measurement renders its numbers — including a genuine
// +0/-0, which is a worktree sitting at its base.
func diffChip(m Model, card Card) string {
	st, live := m.cardDiff(card.Number)
	if !live {
		return ""
	}
	if !st.Known {
		return diffUnread.Render("±?")
	}
	return diffAdd.Render(fmt.Sprintf("+%d", st.Add)) +
		diffSep.Render("/") +
		diffDel.Render(fmt.Sprintf("-%d", st.Del))
}

// prChip — the In Review right slot (GH-2062). Five outcomes, and the two that
// mean "nothing to show" are deliberately different ink:
//
//   - UNREAD (the signals read failed, has not landed, or did not cover this
//     issue) → a grey `⇅ ?`. It is the loudest case here: a chip that rendered
//     blank on a failed read would say "this issue has no PR", which is the
//     exact green-because-nobody-looked failure GH-1971 fixed on the merge side.
//   - read, no linked PR → NOTHING. An In Review item with no PR is a real,
//     ordinary state (a rollup-advanced epic parent, a human-placed item), and
//     a chip for it would be noise on every card in that class.
//
// The remaining three are the PR's fate: green ready, amber pending, purple
// merged, red closed-unmerged. "Ready" is checks-green-and-unconflicted, never
// a merge-gate verdict — see prFate.
func prChip(m Model, card Card, g glyphSet) string {
	label := strings.TrimSpace(g.pr + " ")
	mark, ok := m.cardPR(card.Number)
	if !ok {
		return prUnread.Render(label + "?")
	}
	num := fmt.Sprintf("%s#%d", label, mark.Number)
	switch mark.Fate {
	case PRFateReady:
		return prReady.Render(num)
	case PRFatePending:
		return prPending.Render(num)
	case PRFateMerged:
		return prMerged.Render(num)
	case PRFateClosed:
		return prClosed.Render(num)
	}
	return "" // PRFateNone — read, and there is genuinely no PR
}

// epicChip — the line-3 parent marking. Caret white, the parent's identity in
// the comment ink and italic, the done/total in the purple merged PRs use
// (both mean "landed").
//
// Degrades one step at a time rather than all at once: with no rollup read it
// is the bare `❯ #1994` the Model already held, which is strictly what GH-2061
// shipped. A TRUNCATED child list renders `2/50+` — the rollup is a floor, not
// a total, and a bare 2/50 off a truncated read is a number nobody can trust.
//
// `budget` is the cells this chip may occupy, and it is spent in order of what
// the operator can act on: the parent NUMBER (which `v` and `g` resolve), then
// the TALLY (the fact the rollup exists for), then the name, which is the only
// part that trims. A budget too small even for the number drops the chip
// entirely — the alternative is a fragment that reads as a different issue.
func epicChip(m Model, card Card, g glyphSet, budget int) string {
	if card.ParentNumber == 0 {
		return ""
	}
	head := styleCardText.Render(g.chevron) + " " +
		styleEpic.Render(fmt.Sprintf("#%d", card.ParentNumber))
	if lipgloss.Width(head) > budget {
		return ""
	}
	e, ok := m.cardEpic(card.ParentNumber)
	if !ok {
		return head
	}
	tally := fmt.Sprintf("%d/%d", e.Done, e.Total)
	if e.Truncated {
		tally += "+"
	}
	rest := budget - lipgloss.Width(head) - lipgloss.Width(tally) - 1
	if rest < 0 {
		return head
	}
	if e.Title != "" && rest > 4 {
		head += " " + styleEpic.Render(trimTo(e.Title, rest-1))
	}
	return head + " " + styleRollup.Render(tally)
}

// closedLabel is a Done card's line 3: when it closed, at the same minute
// precision the age chip uses. An unparseable stamp says so rather than
// rendering an age computed from a zero time.
func closedLabel(card Card, now time.Time) string {
	at, err := time.Parse(time.RFC3339, card.ClosedAt)
	if err != nil {
		return "closed (time unreadable)"
	}
	return "closed " + formatAge(now.Sub(at)) + " ago"
}

// priorityGlyph — P0 is an alert, P1-P3 a three-bar meter: P1 fills all three
// in yellow, P2 two, P3 one, white over a dimmed remainder.
//
// Two limits stated rather than hidden: P2 and P3 differ only in fill count,
// and P1 differs from them only in colour, so a monochrome terminal collapses
// the three into a bar chart. An UNSET priority renders as an empty meter
// rather than as blank — a null priority sinks an item below stale backlog in
// `board next`, so it is a real defect and should look like one.
func priorityGlyph(p string) string {
	if p == "P0" {
		return prioP0.Render("[!]")
	}
	n := 0
	switch p {
	case "P1":
		n = 3
	case "P2":
		n = 2
	case "P3":
		n = 1
	}
	fill := prioWhit
	if n == 3 {
		fill = prioFill
	}
	out := ""
	for i, mark := range []string{"▁", "▃", "▅"} {
		if i < n {
			out += fill.Render(mark)
		} else {
			out += prioEmpt.Render(mark)
		}
	}
	return out
}

// ageChip — the LIVE agent's age since spawn, at minute precision so the
// existing adaptive poll can drive it without a 1 Hz repaint.
//
// No ledger record is a dash, never 0m: an agent nobody spawned through the
// sanctioned path, or one spawned on another host, is not an agent that is
// zero minutes old.
func ageChip(m Model, card Card, g glyphSet) string {
	label := "—"
	if age, ok := m.cardAge(card.Number, time.Now()); ok {
		label = formatAge(age)
	}
	return styleTimer.Render(strings.TrimSpace(g.clock+" ") + label)
}

// renderOverlay draws the peek/dag pane: bordered, clipped to the body area.
func renderOverlay(m Model, title, text string, bodyHeight int) string {
	innerW := m.width - 6
	if innerW < 20 {
		innerW = 20
	}
	maxLines := bodyHeight - 4
	if maxLines < 3 {
		maxLines = 3
	}
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	if len(lines) > maxLines {
		lines = append(lines[len(lines)-maxLines:], styleDim.Render("(clipped to the last lines)"))
	}
	for i := range lines {
		lines[i] = truncate(lines[i], innerW)
	}
	content := styleTitle.Render(truncate(title, innerW)) + "\n" + strings.Join(lines, "\n")
	return styleOverlay.Width(innerW + 2).Render(content)
}

// renderInput draws the reply/answer input line + any preserved-text error.
func renderInput(m Model) string {
	var label string
	if m.mode == ModeAnswer {
		label = fmt.Sprintf("answer #%d (board answer first, then nudge)", m.inputFor)
	} else {
		label = fmt.Sprintf("reply → %s", m.inputWho)
	}
	state := "⏎ send · esc back · text is kept on failure"
	if m.sending {
		state = "sending… (waiting for herdr's confirmation)"
	}
	line1 := styleTitle.Render(label) + "  " + styleDim.Render(state)
	line2 := "> " + m.input
	if !m.sending {
		line2 += "█"
	}
	out := truncate(line1, m.width) + "\n" + truncate(line2, m.width)
	if m.inputErr != "" {
		out += "\n" + truncate(styleErr.Render(m.inputErr), m.width)
	}
	return out
}

// hitTest maps a mouse position to (column, card row). Must mirror the
// renderColumns/renderCard geometry exactly — including the scroll window:
// clicks map through colWindow, and the "+N more"/"↑N above" line (and
// anything below the rendered cards) maps to nothing, never to a hidden card.
func hitTest(m Model, x, y int) (col, row int, ok bool) {
	top := headerRows + colHeaderRows
	if y < top {
		return 0, 0, false
	}
	line := (y - top) / cardRows
	if m.width < narrowThreshold {
		col = m.col // single-column fallback: clicks stay in the shown column
	} else {
		gap := 1
		colW := (m.width-2*gap)/3 + gap
		if colW < 1 {
			return 0, 0, false
		}
		col = x / colW
	}
	if col < 0 || col > 2 {
		return 0, 0, false
	}
	start, end := colWindow(m, col, bodyHeightOf(m))
	if line < 0 || line >= end-start {
		return 0, 0, false
	}
	return col, start + line, true
}

// ── tiny text helpers ───────────────────────────────────────────────────────

// truncate clips a possibly-styled line to width terminal cells. ANSI-aware
// (x/ansi, the parser lipgloss itself measures with): escape sequences are
// never cut mid-sequence, so a clipped styled string can never leave a
// dangling partial CSI to eat the next line's bytes.
func truncate(s string, width int) string {
	if width <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= width {
		return s
	}
	return ansi.Truncate(s, width, "")
}

// pad right-fills a possibly-styled string to `to` terminal cells, so a
// right-justified chip lands at the same column on every card.
func pad(s string, to int) string {
	if d := to - lipgloss.Width(s); d > 0 {
		return s + strings.Repeat(" ", d)
	}
	return s
}

// trimTo clips to n cells with an ellipsis. Rune-based, so a multi-byte title
// is never cut mid-character.
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

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func baseName(p string) string {
	p = strings.TrimRight(p, "/")
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}
