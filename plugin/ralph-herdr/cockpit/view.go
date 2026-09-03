// view.go — lipgloss rendering: three board columns (state names verbatim),
// a narrow-width single-column fallback, peek/dag overlays, the reply/answer
// input line, and a status bar with the key legend. Layout metrics are shared
// with hitTest so mouse selection and rendering can never drift.
package main

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/muesli/termenv"
)

const (
	headerRows = 2 // title line + banner/blank line above the columns
	// cardRows is load-bearing: hitTest maps clicks through it as a fixed
	// stride, so the constant and the card geometry MUST move together.
	// 3 content lines + 1 separator rule.
	cardRows        = 4
	colHeaderRows   = 2 // column title + rule
	statusRows      = 2 // input line pair (reply/answer) — the browse footer is legendRows+1
	maxLegendRows   = 4 // a legend wrapped past this is clipped, not allowed to eat the body
	narrowThreshold = 90
	// minCardWidth is the narrowest a card is ever drawn at: the board's
	// columns floor at it, and the epic popover drops to one column rather
	// than draw a card below it.
	minCardWidth = 20
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
	// The age and the [est] are the two inks the v2 spec moved (244/240 →
	// 246); everything else on the card keeps its ink.
	styleTimer  = lipgloss.NewStyle().Foreground(lipgloss.Color("246"))
	styleEst    = lipgloss.NewStyle().Foreground(lipgloss.Color("246"))
	styleGutter = lipgloss.NewStyle().Foreground(lipgloss.Color("237"))
	// Cost and context (spec §5, GH-2378). Cash is a faded green italic —
	// the same ink on the card, the column header and the frame header, so
	// one colour means "dollars" everywhere. `$—` (session known, transcript
	// unreadable) takes the card's one unread grey. The context alert is
	// amber to 160k and red past it; below 120k nothing is drawn. The coin
	// (tokens) is a separate ink so a count never reads as money.
	styleCost       = lipgloss.NewStyle().Italic(true).Foreground(lipgloss.Color("65"))
	styleCostUnread = lipgloss.NewStyle().Foreground(lipgloss.Color("242"))
	styleCtxWarn    = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	styleCtxHot     = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
	styleToken      = lipgloss.NewStyle().Foreground(lipgloss.Color("180"))
	styleGql        = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
	styleGutterS    = lipgloss.NewStyle().Foreground(lipgloss.Color("15")).Bold(true)

	// Status dot — herdr's own vocabulary, joined with the C8 state token.
	dotWorking   = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))  // yellow
	dotReporting = lipgloss.NewStyle().Foreground(lipgloss.Color("75"))  // blue
	dotBlocked   = lipgloss.NewStyle().Foreground(lipgloss.Color("203")) // red — needs a human
	dotIdle      = lipgloss.NewStyle().Foreground(lipgloss.Color("114")) // green, HOLLOW
	dotDone      = lipgloss.NewStyle().Foreground(lipgloss.Color("114")) // green, FILLED — over, cleanly
	dotStarting  = lipgloss.NewStyle().Foreground(lipgloss.Color("246")) // dotted grey
	dotNone      = lipgloss.NewStyle().Foreground(lipgloss.Color("237"))

	// Priority (spec §3). P0 is the bang glyph in bold red; P1 orange, P2
	// yellow, P3 white. An unset one shares P0's red, because a null priority
	// is a defect the operator must fix now.
	prioP0    = lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Bold(true)
	prioUnset = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
	prioP1    = lipgloss.NewStyle().Foreground(lipgloss.Color("208"))
	prioP2    = lipgloss.NewStyle().Foreground(lipgloss.Color("220"))
	prioP3    = lipgloss.NewStyle().Foreground(lipgloss.Color("15"))

	// Worktree diff.
	diffAdd    = lipgloss.NewStyle().Foreground(lipgloss.Color("114"))
	diffDel    = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
	diffSep    = lipgloss.NewStyle().Foreground(lipgloss.Color("238"))
	diffUnread = lipgloss.NewStyle().Foreground(lipgloss.Color("242"))

	// PR chip (GH-2062). One ink per fate, and `prUnread` is the SAME grey the
	// diff chip's ±? uses — across the card, "we could not read this" has one
	// colour, and it is never a colour that also means a state.
	prReady    = lipgloss.NewStyle().Foreground(lipgloss.Color("114")) // green — checks green, no conflict
	prPending  = lipgloss.NewStyle().Foreground(lipgloss.Color("214")) // amber — running or failing
	prConflict = lipgloss.NewStyle().Foreground(lipgloss.Color("205")) // magenta — merge conflict, rebase needed
	prMerged   = lipgloss.NewStyle().Foreground(lipgloss.Color("141")) // purple — landed
	prClosed   = lipgloss.NewStyle().Foreground(lipgloss.Color("203")) // red — closed unmerged
	prUnread   = lipgloss.NewStyle().Foreground(lipgloss.Color("242"))

	// Epic rollup: the caret and the done/total take the SAME purple merged
	// PRs use — both mean "landed".
	styleRollup = lipgloss.NewStyle().Foreground(lipgloss.Color("141"))
	// The epic popover's state tally (spec §11) — a shade above meta so it
	// reads beside the bold title without competing with it.
	styleTally = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))

	// Column headers: the count carries the column's colour, the NAME goes
	// bold white only where the cursor is.
	colCount = [3]lipgloss.Style{
		lipgloss.NewStyle().Foreground(lipgloss.Color("220")).Bold(true), // In Progress — yellow
		lipgloss.NewStyle().Foreground(lipgloss.Color("208")).Bold(true), // In Review — orange
		lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Bold(true), // Human Needed — red
	}
	styleColHead    = lipgloss.NewStyle().Foreground(lipgloss.Color("250"))
	styleColHeadSel = lipgloss.NewStyle().Foreground(lipgloss.Color("15")).Bold(true)

	// Liveness (spec §6) and the in-flight column headers (§10): the spinner
	// is green while polls land, amber `stale Nm` when they do not. The
	// column spinner is meta-grey — a read being out is not an alert.
	styleLive      = lipgloss.NewStyle().Foreground(lipgloss.Color("114"))
	styleStale     = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	styleColFlight = lipgloss.NewStyle().Foreground(lipgloss.Color("240"))

	// Status line (spec §10) — one glyph ink per kind.
	statusInk = map[statusKind]lipgloss.Style{
		statusFlight: lipgloss.NewStyle().Foreground(lipgloss.Color("11")),
		statusOK:     lipgloss.NewStyle().Foreground(lipgloss.Color("114")),
		statusRefuse: lipgloss.NewStyle().Foreground(lipgloss.Color("203")),
		statusNudge:  lipgloss.NewStyle().Foreground(lipgloss.Color("214")),
		statusView:   lipgloss.NewStyle().Foreground(lipgloss.Color("240")),
	}
	styleViewText = lipgloss.NewStyle().Foreground(lipgloss.Color("246"))

	// Legend (spec §9): keys bold white; the primary verb's label bold white
	// too, the rest 250; the separator and the `on #N` subject in meta grey.
	styleKey      = lipgloss.NewStyle().Foreground(lipgloss.Color("15")).Bold(true)
	styleVerbPrim = lipgloss.NewStyle().Foreground(lipgloss.Color("15")).Bold(true)
	styleVerb     = lipgloss.NewStyle().Foreground(lipgloss.Color("250"))
)

func viewModel(m Model) string {
	var b strings.Builder

	// Header + banner.
	title := "ralph cockpit"
	if m.cfg.Repo != "" {
		title += " — " + baseName(m.cfg.Repo)
	}
	// The right-hand stats (spec §6) are laid out by headerLine, which cuts
	// from the right; the liveness spinner is part of the title and never
	// yields to a stat.
	b.WriteString(headerLine(m, styleTitle.Render(title)+"  "+liveness(m, time.Now()), time.Now()))
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
	// Same shape for the Inbox view: a failed REFRESH over a non-empty list
	// must not leave stale decisions looking current.
	if m.showInbox && !m.inboxOK && m.inboxErr != "" {
		banner = append(banner, styleErr.Render("Inbox stale: "+m.inboxErr))
	}
	// And the epic popover: a failed refresh keeps the children on screen
	// under this line, the same rule.
	if m.mode == ModeEpic && !m.epicOK && m.epicErr != "" {
		banner = append(banner, styleErr.Render(fmt.Sprintf("epic #%d stale: %s", m.epicFor, m.epicErr)))
	}
	if !m.herdrOK {
		banner = append(banner, styleBanner.Render(noMuxBanner))
	}
	b.WriteString(truncate(strings.Join(banner, styleDim.Render(" · ")), m.width))
	b.WriteString("\n")

	// Body: overlay modes replace the columns; browse/input modes show them.
	bodyHeight := bodyHeightOf(m)
	var body string
	switch m.mode {
	case ModePeek:
		// The C8 lineage rides the header (GH-2217): who spawned this session
		// and how deep it sits — the detail view is where detail belongs.
		peekTitle := "peek — " + m.peekWho
		if lin := m.agentLineage(m.peekWho); lin != "" {
			peekTitle += "  (" + lin + ")"
		}
		body = renderOverlay(m, peekTitle+"  (tail, no focus steal)", m.peekText, bodyHeight)
	case ModeDag:
		body = renderOverlay(m, "frontier DAG — eligible & blocked", m.dagText, bodyHeight)
	case ModeTopology:
		body = renderTopology(m, bodyHeight)
	case ModeEpic:
		body = renderEpic(m, bodyHeight)
	default:
		if m.inboxViewUp() {
			// The inbox view stays behind the answer input it launched, so
			// the human types against the decision text they are answering.
			body = renderInbox(m, bodyHeight)
		} else {
			body = renderColumns(m, bodyHeight)
		}
	}
	// The footer is PINNED to the last rows of the pane (spec §9): the body
	// is padded to exactly its budget, so a short column never lets the
	// legend float up under it. Padding only — the budget is the body's to
	// keep, and an overrun stays visible rather than silently clipped.
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")
	for len(lines) < bodyHeight {
		lines = append(lines, "")
	}
	b.WriteString(strings.Join(lines, "\n"))
	b.WriteString("\n")

	// Input line (reply/answer) or the legend, its last row carrying the
	// status while one is up. Right-aligned (GH-2405).
	switch m.mode {
	case ModeReply, ModeAnswer:
		b.WriteString(renderInput(m))
	default:
		lines := legendLines(m)
		for i, line := range lines {
			b.WriteString(alignRight(truncate(line, m.width), m.width))
			if i < len(lines)-1 {
				b.WriteString("\n")
			}
		}
	}
	return b.String()
}

// liveness is the header's "is it alive" signal (spec §6): the spinner
// while polls land on cadence, amber `stale Nm` — the age of the last whole
// poll — once one fails or falls overdue. It replaces the cadence text; the
// poll time and the current gap are not shown because neither says whether
// the NEXT poll is coming, which is the only question the operator has.
func liveness(m Model, now time.Time) string {
	g := m.glyphSet()
	stale, age, known := m.pollStale(now)
	if !stale {
		return styleLive.Render(m.spinner())
	}
	if !known {
		return styleStale.Render(g.stalled + " stale · no poll has landed")
	}
	return styleStale.Render(g.stalled + " stale " + formatAge(age))
}

// statusLine renders the typed status (spec §10): a leading glyph says what
// the message is before it is read. An untyped status (the initial empty
// line) renders bare.
func statusLine(m Model) string {
	if m.statusKind == statusNone {
		return m.status
	}
	g := m.glyphSet()
	var glyph string
	switch m.statusKind {
	case statusFlight:
		glyph = m.spinner()
	case statusOK:
		glyph = g.ok
	case statusRefuse:
		glyph = g.err
	case statusNudge:
		glyph = glyphDotFilled
	case statusView:
		glyph = "·"
	}
	text := m.status
	if m.statusKind == statusView {
		text = styleViewText.Render(text)
	}
	return statusInk[m.statusKind].Render(glyph) + " " + text
}

// verbHint is one legend entry: the key and what it does.
type verbHint struct{ key, label string }

// navHints is legend row 2 — constant in browse (spec §9).
var navHints = []verbHint{{"h/l j/k", "move"}, {"v", "dag"}, {"T", "topology"}, {"i", "inbox"}, {"D", "done"}, {"I", "inbox-col"}, {"q", "quit"}}

// legendTable is the spec §9 table: the verbs a selection OFFERS, in the
// order the spec lists them, keyed on the card's state and its live-agent
// count. It is the curation; cardVerbs filters it through the verbs' own
// predicates, so a row can only ever be a subset of what is listed here.
func legendTable(m Model, card Card) []verbHint {
	live := len(m.agents[card.Number])
	switch {
	case card.State == inboxState && card.Queue == "decision":
		return []verbHint{{"a", "answer"}, {"g", "browser"}}
	case card.State == inboxState:
		return []verbHint{{"g", "browser"}}
	case card.State == doneState:
		return []verbHint{{"g", "browser"}, {"d", "diff"}, {"D", "back to Human Needed"}}
	case card.State == columnStates[2] && live > 0:
		return []verbHint{{"a", "answer"}, {"r", "reply"}, {"⏎", "observe"}, {"␣", "peek"}, {"e", "epic"}, {"g", "browser"}}
	case card.State == columnStates[2]:
		return []verbHint{{"a", "answer"}, {"e", "epic"}, {"g", "browser"}}
	case live >= 2:
		return []verbHint{{"⏎", "observe w-lane"}, {"␣", "peek"}, {"r", "reply"}, {"d", "diff"}, {"e", "epic"}, {"g", "browser"}}
	case live == 1:
		return []verbHint{{"⏎", "observe"}, {"␣", "peek"}, {"r", "reply"}, {"f", "fork"}, {"d", "diff"}, {"e", "epic"}, {"g", "browser"}}
	case card.State == columnStates[1]:
		return []verbHint{{"d", "diff"}, {"s", "spawn"}, {"e", "epic"}, {"g", "browser"}}
	}
	return []verbHint{{"s", "spawn"}, {"d", "diff"}, {"e", "epic"}, {"g", "browser"}}
}

// cardVerbs is legend row 1 for the selected card: the spec table, minus
// every verb whose own predicate would refuse it (option A — hidden, never
// struck through). `d`, `g` and `D` need only a card. Unavailable is decided
// by the SAME function the keypress runs, which is what makes the legend
// unable to disagree with the refusal it would otherwise promise past.
func cardVerbs(m Model, card Card) []verbHint {
	var out []verbHint
	for _, h := range legendTable(m, card) {
		kind := statusNone
		switch h.key {
		case "⏎":
			kind, _ = refuseObserve(m, card)
		case "␣":
			kind, _ = refusePeek(m, card)
		case "r":
			kind, _ = refuseReply(m, card)
		case "f":
			kind, _ = refuseFork(m, card)
		case "s":
			kind, _ = refuseSpawn(m, card)
		case "a":
			kind, _ = refuseAnswer(card)
		case "e":
			kind, _ = refuseEpic(card)
		}
		if kind == statusNone {
			out = append(out, h)
		}
	}
	return out
}

// legendRows are the footer's legend rows before wrapping, each a list of
// already-styled hints joined by legendSep. Overlays and the inbox view keep
// their one-row legends; browse gets the contextual row 1 over the constant
// navigation row 2 (spec §9).
func legendRows(m Model) [][]string {
	switch m.mode {
	case ModePeek, ModeDag, ModeTopology:
		return [][]string{{styleDim.Render("esc close")}}
	case ModeInbox:
		return [][]string{dimHints("j/k row", "a/⏎ answer decision", "g browser", "i/esc close")}
	case ModeEpic:
		return [][]string{dimHints("esc close", "j/k child", "⏎ observe", "␣ peek", "g browser")}
	}
	row1 := []string{}
	card, ok := m.selectedCard()
	if !ok {
		row1 = append(row1, styleMeta.Render("(no card — views only)"))
	} else {
		subject := styleMeta.Render(fmt.Sprintf("on #%d", card.Number))
		for i, h := range cardVerbs(m, card) {
			label := styleVerb.Render(h.label)
			if i == 0 {
				label = styleVerbPrim.Render(h.label)
			}
			hint := styleKey.Render(h.key) + " " + label
			if i == 0 {
				hint = subject + "  " + hint
			}
			row1 = append(row1, hint)
		}
		if len(row1) == 0 {
			row1 = append(row1, subject+"  "+styleMeta.Render("(no verbs here)"))
		}
	}
	row2 := make([]string, 0, len(navHints))
	for _, h := range navHints {
		row2 = append(row2, styleDim.Render(h.key+" "+h.label))
	}
	return [][]string{row1, row2}
}

func dimHints(hints ...string) []string {
	out := make([]string, 0, len(hints))
	for _, h := range hints {
		out = append(out, styleDim.Render(h))
	}
	return out
}

// legendSep separates hints; legendLines wraps at hint boundaries and
// nowhere else, so a hint like "h/l j/k move" is never split across rows.
const legendSep = " · "

// legendLines wraps each legend row to the pane width, one whole hint at a
// time, so a narrow pane shows every verb on a further row instead of
// cutting the line at whatever hint happened to land on the edge. Capped at
// maxLegendRows in total — the last row is then marked — so a pane too
// narrow for even the wrapped form still leaves room for a body.
//
// The status line does not get a row of its own (GH-2405): while a message
// is up it OVERWRITES the last legend row — the navigation row in browse,
// the least important hotkeys — and the row returns when the message clears
// (the next key, or statusTTL). The footer never grows for feedback.
func legendLines(m Model) []string {
	var out []string
	for _, row := range legendRows(m) {
		out = append(out, wrapHints(row, m.width)...)
	}
	if len(out) > maxLegendRows {
		// Dropped hints must not vanish silently: the last kept row says so.
		out = out[:maxLegendRows]
		last := out[maxLegendRows-1]
		if lipgloss.Width(last)+2 > m.width {
			last = truncate(last, m.width-2)
		}
		out[maxLegendRows-1] = last + " …"
	}
	if st := statusLine(m); st != "" && len(out) > 0 {
		out[len(out)-1] = st
	}
	return out
}

// alignRight pads a footer row out to the pane width so the hotbar sits
// flush right (GH-2405); a row already at or past the width is untouched.
func alignRight(s string, width int) string {
	if w := lipgloss.Width(s); w < width {
		return strings.Repeat(" ", width-w) + s
	}
	return s
}

func wrapHints(hints []string, width int) []string {
	sep := styleMeta.Render(legendSep)
	var out []string
	cur := ""
	for _, hint := range hints {
		switch {
		case cur == "":
			cur = hint
		case width < 1 || lipgloss.Width(cur+legendSep+hint) <= width:
			cur += sep + hint
		default:
			out = append(out, cur)
			cur = hint
		}
	}
	return append(out, cur)
}

// footerRowsOf is how many rows the footer takes below the body: the input
// pair in reply/answer, else the (possibly wrapped) legend — the status line
// rides its last row rather than adding one. Shared by bodyHeightOf so the
// body shrinks exactly as the legend grows.
func footerRowsOf(m Model) int {
	if m.mode == ModeReply || m.mode == ModeAnswer {
		return statusRows
	}
	return len(legendLines(m))
}

// bodyHeightOf mirrors viewModel's body sizing — shared with hitTest so the
// scroll window can never drift between rendering and mouse mapping.
func bodyHeightOf(m Model) int {
	h := m.height - headerRows - footerRowsOf(m)
	if h < cardRows+colHeaderRows+bodyOverheadRows {
		h = cardRows + colHeaderRows + bodyOverheadRows
	}
	return h
}

// bodyOverheadRows are the rows a column body spends OUTSIDE the card stride:
// the "↑N above · +N more" line renderColumn writes when the window hides
// cards, and the blank separator viewModel writes between body and footer.
// Both are reserved up front (GH-2319/#2329): budgeting only the cards let
// them ride the rounding slack of the division below, so the frame fit or
// overran the terminal by two rows depending on the terminal's height parity.
const bodyOverheadRows = 2

// visibleCards is how many full cards fit in a column body.
func visibleCards(bodyHeight int) int {
	v := (bodyHeight - colHeaderRows - bodyOverheadRows) / cardRows
	if v < 1 {
		v = 1
	}
	return v
}

// withheldRows is the one extra row the In Review column spends on its
// "withheld: …" footer while the inbox view holds rows back; every column
// pays it, since JoinHorizontal levels the three to the tallest.
func withheldRows(m Model) int {
	if m.showInbox && m.inboxOK && m.inboxWithheld != "" {
		return 1
	}
	return 0
}

// colWindow is the half-open rendered range [start, end) of column idx's
// cards. The window FOLLOWS the cursor in the cursor's column — every verb
// acts on the selected card, so the selected card must always be on screen —
// and stays at the top elsewhere. Shared by renderColumn and hitTest.
func colWindow(m Model, idx, bodyHeight int) (start, end int) {
	cards := m.columnCards(idx)
	visible := visibleCards(bodyHeight - withheldRows(m))
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
	if colW < minCardWidth {
		colW = minCardWidth
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
	right := colCount[idx].Render(count)
	// The column's spend sits left of the count in the cash ink (spec §5):
	// the sum of the MEASURED chips — an unpriced column draws no total,
	// and a card's `$—` is where its own unread fact lives.
	if total, ok := m.columnSpend(cards); ok {
		right = styleCost.Render(fmt.Sprintf("%s%.2f", m.glyphSet().usd, total)) + "  " + right
	}
	// Left of both (spec §10): a spinner while this column's read is out,
	// amber `stale Nm` when its last read failed and the cards shown are
	// the last good ones.
	if note := columnFlight(m, idx, time.Now()); note != "" {
		right = note + "  " + right
	}
	pad := width - lipgloss.Width(name) - lipgloss.Width(right) - 2
	if pad < 1 {
		pad = 1
	}
	var b strings.Builder
	b.WriteString(truncate(nameStyle.Render(name)+strings.Repeat(" ", pad)+right, width))
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
		if idx == 2 && m.showInbox {
			// The same three-way honesty split as Done: unread, failed, and
			// genuinely empty must never render alike.
			switch {
			case !m.inboxOK && m.inboxErr != "":
				empty, style = "  (inbox read failed: "+m.inboxErr+")", styleErr
			case !m.inboxOK:
				empty = "  (reading the inbox…)"
			default:
				empty = "  (inbox empty — no decisions waiting)"
			}
		} else if idx == 2 && m.showDone {
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
		if idx == 2 && m.showInbox && m.inboxOK && m.inboxWithheld != "" {
			// GH-2108's rule carried through: rows the classifier held back
			// are counted here, so an empty inbox over withheld rows cannot
			// read as "nothing is waiting anywhere".
			b.WriteString(truncate(styleDim.Render("  withheld: "+m.inboxWithheld+" (self-clearing)"), width))
			b.WriteString("\n")
		}
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
		b.WriteString("\n")
	}
	if idx == 2 && m.showInbox && m.inboxOK && m.inboxWithheld != "" {
		// After the cards (and past hitTest's card stride, so it can never
		// shift a click): the held-back count, same honesty rule as above.
		b.WriteString(truncate(styleDim.Render("  withheld: "+m.inboxWithheld+" (self-clearing)"), width))
	}
	return lipgloss.NewStyle().Width(width).Render(b.String())
}

// columnFlight is column idx's own read state for its header: the spinner
// while a read is out (a read being out outranks a stale verdict — the cure
// is in flight), `stale Nm` once the last read failed, "" when the cards are
// current. The third column answers for whichever read it is showing.
func columnFlight(m Model, idx int, now time.Time) string {
	inFlight, failed, goodAt := m.pollInFlight, m.colFailed[idx], m.colGoodAt[idx]
	switch {
	case idx == 2 && m.showInbox:
		inFlight, failed, goodAt = m.inboxInFlight, !m.inboxOK && m.inboxErr != "", m.inboxGoodAt
	case idx == 2 && m.showDone:
		inFlight, failed, goodAt = m.doneInFlight, !m.doneOK && m.doneErr != "", m.doneGoodAt
	}
	switch {
	case inFlight:
		return styleColFlight.Render(m.spinner())
	case failed && goodAt.IsZero():
		return styleStale.Render("stale")
	case failed:
		return styleStale.Render("stale " + formatAge(now.Sub(goodAt)))
	}
	return ""
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
	selected := m.mode != ModePeek && m.mode != ModeDag && m.mode != ModeTopology && m.mode != ModeInbox && m.mode != ModeEpic && colIdx == m.col && rowIdx == m.row
	return renderCardFace(m, card, width, selected, false)
}

// renderCardFace is the card itself, selection decided by the caller. The
// board columns and the epic popover (GH-2381) draw the SAME face, so the
// geometry, the dot vocabulary and the selection ink cannot drift between
// them. `overlay` is the popover's three differences, all from spec §11:
// line 1's right slot is the child's board STATE (no column carries it in
// there); a child outside the four column states (Backlog, Intake, …) draws
// no branch, no age and no cost — there is no session to measure; and a Done
// child's merge chip moves to line 3,
// beside its cost, since the state took its slot. No epic chip either: every
// child has the same parent, and it is the title row.
func renderCardFace(m Model, card Card, width int, selected, overlay bool) string {
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
	switch {
	case overlay:
		chip = stateTag(card)
	case card.State == columnStates[0]:
		chip = diffChip(m, card)
	case card.State == columnStates[1]:
		chip = prChip(m, card, g)
	case card.State == doneState:
		chip = mergeChip(card, g)
	case card.State == columnStates[2]:
		// The question owns line 3 on a Human Needed card (the approved
		// mock), so the cost rides the one slot the card leaves empty: line
		// 1's right. Nothing else competes for it on this state.
		chip = costChip(m, card, g)
	case card.State == inboxState:
		// The right slot's one fact for an inbox card is WHICH human queue
		// admitted it — the section header the CLI prints, carried per card
		// because the column interleaves four queues.
		if card.Queue != "" {
			chip = styleMeta.Render(card.Queue)
		}
	}
	avail := inner - lipgloss.Width(left) - 2
	if chip != "" {
		avail -= lipgloss.Width(chip) + 2
	}
	// A popover child outside the four column states — Backlog, Intake,
	// Canceled, off-board, unread — has no session to measure: no branch,
	// no age, no cost, the lead alone on line 3.
	parked := overlay && card.State != columnStates[0] && card.State != columnStates[1] &&
		card.State != columnStates[2] && card.State != doneState
	line1 := left
	if br := m.cardBranch(card.Number); br != "" && avail > 3 && !parked {
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

	// ── line 2: the issue title. GH-2210/D6.2 put the herd address here and
	// GH-2235 shortened it to the display suffix — which at card width is
	// `w2260-the-cockpit` directly under `feat/2260-the-cockpit`: the same
	// number and slug twice, and the one line that said what the unit is
	// ABOUT gone (GH-2320). Everything the address carried is already on the
	// card — line 1 names the unit, line 3's epic chip names the team — and
	// the full address is one keypress away in the topology view, so the card
	// is the surface where D6.2 yields to the title.
	line2 := textStyle.Render(trimTo(card.Title, inner))

	// ── line 3: priority · estimate · epic · agent age (right-justified).
	var line3 string
	switch {
	case card.State == doneState:
		closed := closedLabel(card, time.Now())
		if !overlay {
			// The same shape as every other column (GH-2405): priority and
			// estimate on the left — `board closed --fields` carries them —
			// and on the right the cost, then the age since the close in the
			// timer slot. An UNSET priority on a closed card is not the red
			// `P?` a live card earns (nobody can fix a closed card's ranking):
			// each field is drawn only when present, so a pre-`--fields`
			// board CLI leaves the left bare rather than lying.
			lead := ""
			if card.Priority != "" {
				lead = priorityGlyph(card.Priority, g)
			}
			if card.Estimate != "" {
				if lead != "" {
					lead += " "
				}
				lead += styleEst.Render("[" + card.Estimate + "]")
			}
			timer := styleTimer.Render(closedAge(card, time.Now()))
			if cost := costChip(m, card, g); cost != "" {
				timer = cost + "  " + timer
			}
			if lipgloss.Width(lead)+lipgloss.Width(timer)+2 > inner {
				lead = ""
			}
			line3 = pad(lead, inner-lipgloss.Width(timer)) + timer
			break
		}
		// The right slot sheds from the outside in when the card is too
		// narrow for all of it — the cost first, then the merge chip — so a
		// clip never eats a chip that was drawn: a partial `⌥#23` is a wrong
		// PR number, and no chip is the honest form of "no room".
		merge, cost := mergeChip(card, g), costChip(m, card, g)
		const minLabel = 8 // "closed …" — the label is never squeezed below this
		right := merge
		if cost != "" {
			if right != "" {
				right += "  "
			}
			right += cost
		}
		if lipgloss.Width(right)+2+minLabel > inner {
			right = merge
		}
		if lipgloss.Width(right)+2+minLabel > inner {
			right = ""
		}
		if right == "" {
			line3 = styleMeta.Render(trimTo(closed, inner))
			break
		}
		// Trimmed on the PLAIN text, with the ellipsis: a chopped `closed 43m ag`
		// at card width reads as a typo, and trimming a styled string would
		// cut inside its escape codes.
		line3 = pad(styleMeta.Render(trimTo(closed, inner-lipgloss.Width(right)-2)), inner-lipgloss.Width(right)) + right
	case card.State == inboxState && card.Queue == "decision":
		// A decision row IS a Human Needed item: same phone-answerable
		// contract, same rendering — the why-line owns the row, because the
		// disposing verb is already the cockpit's own `a` on this card.
		q := card.Question
		if q == "" {
			q = "(decision text unavailable — see the issue's Decision needed comment)"
		}
		line3 = styleQuestion.Render(trimTo("? "+q, inner))
	case card.State == inboxState:
		// Every other inbox row leads with its disposition: Tier 1's
		// admission invariant is that the verb exists, so the card shows it.
		line3 = styleMeta.Render(trimTo("→ "+card.Verb, inner))
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
		lead := priorityGlyph(card.Priority, g)
		if card.Estimate != "" {
			lead += " " + styleEst.Render("["+card.Estimate+"]")
		}
		// The epic chip is the only variable-length thing on this row, so it —
		// not the timer — absorbs the width. Budgeted BEFORE it is built: the
		// timer is right-justified by `pad`, which cannot push back, so an
		// over-long epic name would simply run into it and both would be
		// unreadable. Two spaces of separator on each side.
		// The cost chip and the context alert sit beside the timer on the
		// right — cost, then alert, then age — all fixed-width, so the epic
		// chip's budget can be computed before it is built.
		if parked {
			line3 = truncate(lead, inner)
			break
		}
		timer := ageChip(m, card)
		if ctx := ctxChip(m, card, g); ctx != "" {
			timer = ctx + "  " + timer
		}
		if cost := costChip(m, card, g); cost != "" {
			timer = cost + "  " + timer
		}
		if !overlay {
			if epic := epicChip(m, card, g, inner-lipgloss.Width(lead)-lipgloss.Width(timer)-4); epic != "" {
				lead += "  " + epic
			}
		}
		line3 = pad(lead, inner-lipgloss.Width(timer)) + timer
	}

	rule := styleRule.Render("  " + strings.Repeat("─", max(1, width-4)))
	rows := [3]string{
		truncate(gutterTop+" "+line1, width),
		truncate(gutterRest+" "+line2, width),
		truncate(gutterRest+" "+line3, width),
	}
	if selected && m.washEnabled() {
		// The wash rides the three CONTENT rows only — the rule stays
		// unpainted so the card's bottom edge reads as a gap, not a box.
		for i := range rows {
			rows[i] = washRow(rows[i], width)
		}
	}
	return rows[0] + "\n" + rows[1] + "\n" + rows[2] + "\n" + truncate(rule, width) + "\n"
}

// selectionWash is the SGR that paints the selected card's background (spec
// §7): #111629, the Tokyo Night Clear ground #0b1020 lifted +6 per channel —
// a lift, not a colour, so it sits under any theme's ink without arguing
// with the priority and state inks drawn over it. Emitted as a raw 24-bit
// sequence rather than a lipgloss style because the wash has to be re-opened
// after every reset the row's own styles emit, which a style wrapping the
// row cannot do.
const selectionWash = "\x1b[48;2;17;22;41m"

// washEnabled is the true-colour gate: BOTH the terminal's own claim
// (COLORTERM, read once at startup) and lipgloss's detected profile must say
// 24-bit. Either alone is not enough — a profile forced up by CLICOLOR_FORCE
// on a 256-colour terminal quantises #111629 to a grey slab on navy, and a
// COLORTERM inherited into a pipe would paint sequences nobody renders. Below
// the gate the selection is the bar and bold ink, exactly as before.
func (m Model) washEnabled() bool {
	return m.cfg.Truecolor && lipgloss.ColorProfile() == termenv.TrueColor
}

// washRow paints one already-truncated row edge to edge: pad to the card
// width so the wash spans the whole row, then re-open the background after
// every `ESC[0m` the row's foreground styles emit (the mock's reset-reopen
// trick) so their inks survive intact and the wash never gaps mid-row. The
// row's visible width is unchanged — padding to width is what the column's
// own Width style would have done — and nothing about the card's geometry
// moves, so hitTest is untouched.
func washRow(row string, width int) string {
	const reset = "\x1b[0m"
	row = pad(row, width)
	return selectionWash + strings.ReplaceAll(row, reset, reset+selectionWash) + reset
}

// statusDot renders the joined vocabulary (spec §2): yellow working, blue
// reporting, red blocked (a human is needed), green HOLLOW idle, green FILLED
// done, dotted grey starting, small dark none. Hollow for idle because it is
// the one state that means "nothing is happening"; done and working are both
// filled and differ by colour only — deliberate.
//
// A Done-column card ALWAYS draws the done dot: the column is the fact, and a
// live session still reporting on a closed unit is the exception the peek
// view carries, not the gutter.
func statusDot(m Model, card Card, g glyphSet) string {
	if card.State == doneState {
		return dotFor(stateDone, g)
	}
	state, ok := m.cardState(card.Number)
	if !ok {
		return dotNone.Render(glyphDotNone)
	}
	return dotFor(state, g)
}

// dotFor renders one joined state as its dot — the card strip and the
// topology tree draw from the same vocabulary, so the inks cannot drift. The
// glyphs are tier-independent (signals.go); the tier is taken so a future
// tier-specific dot has one place to land.
func dotFor(state string, _ glyphSet) string {
	switch state {
	case stateWorking:
		return dotWorking.Render(glyphDotFilled)
	case stateReporting:
		return dotReporting.Render(glyphDotReporting)
	case stateBlocked:
		return dotBlocked.Render(glyphDotFilled)
	case stateIdle:
		return dotIdle.Render(glyphDotHollow)
	case stateDone:
		return dotDone.Render(glyphDotFilled)
	case stateStarting:
		return dotStarting.Render(glyphDotStarting)
	default:
		return dotNone.Render(glyphDotNone)
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
// The remaining four are the PR's fate: green ready, amber pending, magenta
// conflicted, purple merged, red closed-unmerged. "Ready" is checks-green-and-
// unconflicted, never a merge-gate verdict — see prFate.
//
// Conflict carries a trailing `!` as well as its own ink (GH-2321): it is the
// one open-PR fate whose next action is a human's, and a monochrome terminal
// collapses ink alone. The mark is on the chip, not the glyph, so `⇅#N` still
// scans as "the PR" on every card.
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
	case PRFateConflict:
		return prConflict.Render(num + "!")
	case PRFateMerged:
		return prMerged.Render(num)
	case PRFateClosed:
		return prClosed.Render(num)
	}
	return "" // PRFateNone — read, and there is genuinely no PR
}

// mergeChip — the Done right slot (GH-2377, spec §8): the purple merge glyph
// and the PR that closed the issue, from `closedByPullRequestsReferences` —
// the field the Done gate and the tend audit read. Three outcomes, and the two
// that show nothing green are deliberately different ink:
//
//   - UNREAD (the closed read carried no linkage for this row) → a grey `⌥?`,
//     the same grey the PR and diff chips use for "we could not read this".
//   - read, no merged closing PR → NOTHING. That is exactly the
//     no-closing-keyword population the Done audit exists for, and a chip on
//     every such card would be noise on a real, ordinary state.
//   - a merged closing PR → `⌥#N` in the purple merged PRs already use.
func mergeChip(card Card, g glyphSet) string {
	label := strings.TrimSpace(g.merge + " ")
	if !card.ClosingPRsRead {
		return prUnread.Render(label + "?")
	}
	if card.MergedPR == 0 {
		return ""
	}
	return prMerged.Render(fmt.Sprintf("%s#%d", label, card.MergedPR))
}

// epicChip — the line-3 parent marking. Caret and tally in the purple merged
// PRs use (both mean "landed"), the parent's identity in the comment ink and
// italic.
//
// Degrades one step at a time rather than all at once: with no rollup read it
// is the bare `❯ #1994` the Model already held, which is strictly what GH-2061
// shipped. A TRUNCATED child list renders `2/50+` — the rollup is a floor, not
// a total, and a bare 2/50 off a truncated read is a number nobody can trust.
//
// `budget` is the cells this chip may occupy, and it is spent in order of what
// the operator can act on: the parent NUMBER (which `v` and `g` resolve), then
// the TALLY (the fact the rollup exists for), then the name. The name is
// ALL-OR-NOTHING (spec §4): drawn only when the whole title fits, never
// trimmed — `worke…` reads as a different issue. A budget too small even for
// the number drops the chip entirely, for the same reason.
func epicChip(m Model, card Card, g glyphSet, budget int) string {
	if card.ParentNumber == 0 {
		return ""
	}
	head := styleRollup.Render(g.chevron) + " " +
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
	if e.Title != "" && lipgloss.Width(e.Title) <= rest-1 {
		head += " " + styleEpic.Render(e.Title)
	}
	return head + " " + styleRollup.Render(tally)
}

// closedLabel is a Done card's line 3 in the epic popover: when it closed,
// at the same minute precision the age chip uses. An unparseable stamp
// says so rather than rendering an age computed from a zero time.
func closedLabel(card Card, now time.Time) string {
	at, err := time.Parse(time.RFC3339, card.ClosedAt)
	if err != nil {
		return "closed (time unreadable)"
	}
	return "closed " + formatAge(now.Sub(at)) + " ago"
}

// closedAge is the column form of the same fact: the bare age in the timer
// slot every other column's card carries on line 3 (GH-2405). Unreadable
// is a dash, the age chip's own spelling.
func closedAge(card Card, now time.Time) string {
	at, err := time.Parse(time.RFC3339, card.ClosedAt)
	if err != nil {
		return "—"
	}
	return formatAge(now.Sub(at))
}

// priorityGlyph — P0 as the tier's bang glyph in bold red, padded to the two
// cells its siblings take; P1..P3 as their own two-letter names (orange,
// yellow, white). The three-bar meter this replaced (GH-2321) was read by an
// operator as a broken PR-state glyph beside the estimate: P2 and P3 differed
// only in fill count and P1 only in colour, so it carried less than the two
// characters it stood in for.
//
// An UNSET priority renders as a red `P?` rather than as blank — a null
// priority sinks an item below stale backlog in `board next`, so it is a real
// defect and takes the alert ink P0 uses. Fixed width, so line 3 aligns.
func priorityGlyph(p string, g glyphSet) string {
	switch p {
	case "P0":
		return pad(prioP0.Render(g.bang), 2)
	case "P1":
		return prioP1.Render("P1")
	case "P2":
		return prioP2.Render("P2")
	case "P3":
		return prioP3.Render("P3")
	}
	return prioUnset.Render("P?")
}

// ageChip — the LIVE agent's age since spawn, at minute precision so the
// existing adaptive poll can drive it without a 1 Hz repaint. No clock glyph
// in any tier (spec §1): a right-justified `1h 12m` on line 3 has meant "age"
// since GH-2061.
//
// No ledger record is a dash, never 0m: an agent nobody spawned through the
// sanctioned path, or one spawned on another host, is not an agent that is
// zero minutes old.
func ageChip(m Model, card Card) string {
	label := "—"
	if age, ok := m.cardAge(card.Number, time.Now()); ok {
		label = formatAge(age)
	}
	return styleTimer.Render(label)
}

// costChip — "$2.41": the session's list-equivalent spend from its own
// transcript (GH-2378), a meter rather than a bill. Three renders that must
// never look alike: no session draws NOTHING (there is nothing to price), a
// session whose transcript could not be read draws `$—` in the unread grey,
// and a measured one draws the number in cash green.
func costChip(m Model, card Card, g glyphSet) string {
	u, st := m.cardUsage(card.Number)
	switch st {
	case costMeasured:
		return styleCost.Render(fmt.Sprintf("%s%.2f", g.usd, u.USD))
	case costUnread:
		return styleCostUnread.Render(g.usd + "—")
	}
	return ""
}

// ctxAlertFrac is the fraction of the model's context window below which
// the context chip is not drawn: a healthy context is not a fact the
// operator acts on. ctxHotFrac is where amber turns red. Fractions, not
// token counts (GH-2405): the old 120k/160k were these same 60%/80% of a
// 200k window, and the fleet now runs 1M-window models.
const (
	ctxAlertFrac = 0.6
	ctxHotFrac   = 0.8
)

// ctxThresholds are the alert and hot lines, in tokens, for one model.
func ctxThresholds(model string) (alert, hot int) {
	w := contextWindow(model)
	return int(float64(w) * ctxAlertFrac), int(float64(w) * ctxHotFrac)
}

// ctxChip — "⛶651k": the LAST call's prompt size, drawn only past the alert
// gate for the model that call ran on. Unread context is deliberately not
// distinguishable from healthy — the `$—` beside it carries the unread
// fact, and a second grey glyph on every unread card would say the same
// thing twice.
func ctxChip(m Model, card Card, g glyphSet) string {
	u, st := m.cardUsage(card.Number)
	if st != costMeasured {
		return ""
	}
	alert, hot := ctxThresholds(u.LastModel)
	if u.LastContext < alert {
		return ""
	}
	return ctxInk(u.LastContext, hot).Render(g.ctx + formatTokens(u.LastContext))
}

// ctxInk — amber from the gate, red from the hot line.
func ctxInk(n, hot int) lipgloss.Style {
	if n >= hot {
		return styleCtxHot
	}
	return styleCtxWarn
}

// formatTokens — "274k" at thousand precision, "3.1M" past a million, the
// unit every cost surface prints; below a thousand the bare count.
func formatTokens(n int) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1000:
		return fmt.Sprintf("%dk", (n+500)/1000)
	}
	return fmt.Sprintf("%d", n)
}

// headerLine lays the frame header out (spec §6): the title left, and
// right-justified the fleet by state in each state's ink, today's spend, the
// token coin, the burn rate and the GraphQL weight. Width cuts from the
// RIGHT — each stat is dropped whole, last first, until the row fits beside
// the title, and the title itself is only ever truncated once every stat is
// gone. A stat that cannot be read is absent, never 0.
func headerLine(m Model, title string, now time.Time) string {
	stats := headerStats(m, now)
	for len(stats) > 0 {
		right := strings.Join(stats, "  ")
		if lipgloss.Width(title)+2+lipgloss.Width(right) <= m.width {
			return pad(title, m.width-lipgloss.Width(right)) + right
		}
		stats = stats[:len(stats)-1]
	}
	return truncate(title, m.width)
}

// headerStats builds the right-hand run, in the order the width cuts it:
// fleet dots first (the cheapest fact and the one that says who is alive),
// then dollars, tokens, burn, GraphQL.
func headerStats(m Model, now time.Time) []string {
	g := m.glyphSet()
	var out []string
	var fleet []string
	for _, fc := range m.fleetTally() {
		fleet = append(fleet, dotFor(fc.State, g)+" "+fmt.Sprintf("%d", fc.N))
	}
	if len(fleet) > 0 {
		out = append(out, strings.Join(fleet, "  "))
	}
	if today, tokens, hour, ok := m.fleetSpend(now); ok {
		// A `+` says the day's fleet outgrew the usage cap and this is a
		// floor, never the day (PR #2406 review): the sessions on screen are
		// priced first, so what is missing is the oldest of today's refs.
		plus := ""
		if _, capped := m.usageTargetsCapped(); capped {
			plus = "+"
		}
		out = append(out,
			styleCost.Render(fmt.Sprintf("%s%.2f%s today", g.usd, today, plus)),
			styleToken.Render(g.token+" "+formatTokens(tokens)),
			styleCost.Render(fmt.Sprintf("%s%.2f/h", g.usd, hour)))
	}
	if m.gqlOK {
		out = append(out, styleGql.Render("gql "+groupThousands(m.gql)))
	}
	return out
}

// groupThousands — "3,812", the header's GraphQL weight.
func groupThousands(n int) string {
	s := fmt.Sprintf("%d", n)
	if n < 0 {
		return s
	}
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	return b.String()
}

// stateTag is the popover child's line-1 right slot: its board state, with
// the two not-a-state cases kept apart — off the board (no project item) and
// unread (its field-value page truncated, GH-2381), the latter in the same
// grey every other "could not read" chip uses.
func stateTag(card Card) string {
	switch {
	case card.StateUnread:
		return prUnread.Render("state ?")
	case card.State == "":
		return styleMeta.Render("off board")
	}
	return styleMeta.Render(card.State)
}

// renderEpic draws the `e` popover (GH-2381, spec §11): the epic's title row —
// number, title, closed/total, spend, state tally — over its children as
// board cards in two columns, row-major in board order. Its own renderer,
// like the topology tree: the clip keeps the FIRST rows and the window
// follows the selected child, the way colWindow follows the cursor, so j/k
// can never move the selection off screen.
func renderEpic(m Model, bodyHeight int) string {
	innerW := m.width - 6
	if innerW < 20 {
		innerW = 20
	}
	maxLines := bodyHeight - 4
	if maxLines < cardRows {
		maxLines = cardRows
	}
	e := m.epic
	kids := m.epicChildren()

	tally := fmt.Sprintf("%d/%d", e.Closed, len(kids))
	if e.Truncated {
		tally += "+"
	}
	title := styleTitle.Render(fmt.Sprintf("epic #%d — %s", e.Number, e.Title)) +
		"  " + styleRollup.Render(tally+" done")
	if spend, ok := m.epicSpend(kids); ok {
		title += "  " + styleCost.Render(fmt.Sprintf("$%.2f", spend))
	}
	if t := epicTally(kids); t != "" {
		title += "  " + styleTally.Render(t)
	}
	lines := []string{truncate(title, innerW)}

	if len(kids) == 0 {
		lines = append(lines, styleDim.Render("(no children)"))
		return styleOverlay.Width(innerW + 2).Render(strings.Join(lines, "\n"))
	}

	// Two columns at the board's own minimum card width, else ONE — the
	// narrow mode renderColumns already has, so a card is never squeezed
	// below the width its chips were budgeted for.
	perRow, colW := 2, (innerW-1)/2
	if colW < minCardWidth {
		perRow, colW = 1, innerW
	}
	rows := (len(kids) + perRow - 1) / perRow
	visible := maxLines / cardRows
	if rows > visible {
		// One row is spent on the "↑N above · +N more" line, as the columns do.
		visible = (maxLines - 1) / cardRows
	}
	if visible < 1 {
		visible = 1
	}
	start := 0
	if sel := m.epicRow / perRow; sel >= visible {
		start = sel - visible + 1
	}
	if start > rows-visible {
		start = rows - visible
	}
	if start < 0 {
		start = 0
	}
	end := start + visible
	if end > rows {
		end = rows
	}
	blank := strings.TrimRight(strings.Repeat(strings.Repeat(" ", colW)+"\n", cardRows), "\n")
	for r := start; r < end; r++ {
		cells := make([]string, 0, 2*perRow)
		for c := 0; c < perRow; c++ {
			i := r*perRow + c
			cell := blank
			if i < len(kids) {
				cell = strings.TrimRight(renderCardFace(m, kids[i], colW, i == m.epicRow, true), "\n")
			}
			if c > 0 {
				cells = append(cells, " ")
			}
			cells = append(cells, cell)
		}
		lines = append(lines, lipgloss.JoinHorizontal(lipgloss.Top, cells...))
	}
	above, below := start*perRow, len(kids)-end*perRow
	if below < 0 {
		below = 0
	}
	if above > 0 || below > 0 {
		parts := make([]string, 0, 2)
		if above > 0 {
			parts = append(parts, fmt.Sprintf("↑%d above", above))
		}
		if below > 0 {
			parts = append(parts, fmt.Sprintf("+%d more", below))
		}
		lines = append(lines, truncate(styleDim.Render("  "+strings.Join(parts, " · ")), innerW))
	}
	return styleOverlay.Width(innerW + 2).Render(strings.Join(lines, "\n"))
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

// renderTopology draws the roster tree (GH-2219, D6.1): dispatch → teams →
// leads → workers, liveness dots from the same joined vocabulary the cards
// use, escalation counts joined per rung. Its own renderer rather than
// renderOverlay for two reasons: a tree reads top-down, so the clip keeps the
// FIRST lines (renderOverlay keeps the last), and the dots need per-line ink.
func renderTopology(m Model, bodyHeight int) string {
	g := m.glyphSet()
	innerW := m.width - 6
	if innerW < 20 {
		innerW = 20
	}

	// Escalation joins. A worker joins on its issue; a lead on its name; a
	// null lead is attributed to NO row (the header totals still carry it).
	escByIssue := map[int]TopoEsc{}
	pendingByLead := map[string]int{}
	var withLeads, withHuman, answered int
	for _, e := range m.topoEscs {
		escByIssue[e.Number] = e
		if e.Answered {
			answered++
			continue
		}
		if e.Route == "lead" && e.Disposition == "pending" {
			withLeads++
			if e.Lead != "" {
				pendingByLead[e.Lead]++
			}
			continue
		}
		// route "human", promoted, auto-promoted — the human tier.
		withHuman++
	}

	var lines []string
	// Escalation summary — "unreadable" and "none" must never render alike.
	switch {
	case m.topoEscErr != "":
		lines = append(lines, styleErr.Render(truncate("escalations NOT COUNTED — "+m.topoEscErr, innerW)))
	case len(m.topoEscs) == 0:
		lines = append(lines, styleDim.Render("no live escalations"))
	default:
		parts := []string{}
		if withLeads > 0 {
			parts = append(parts, fmt.Sprintf("%d with leads", withLeads))
		}
		if withHuman > 0 {
			parts = append(parts, fmt.Sprintf("%d with human", withHuman))
		}
		if answered > 0 {
			parts = append(parts, fmt.Sprintf("%d answered · resume pending", answered))
		}
		lines = append(lines, styleQuestion.Render("escalations: "+strings.Join(parts, " · ")))
	}
	if m.topoAgentsNote != "" {
		// An unreadable herd is NOT an empty fleet — the tree below may be
		// lease-only, and this line says why.
		lines = append(lines, styleErr.Render(truncate("herd agents not read: "+m.topoAgentsNote, innerW)))
	}
	lines = append(lines, "")

	// Dispatch is the root rung. Its escalation count is the human tier —
	// dispatch reads the inbox like the human does (D5.2).
	inboxChip := ""
	if m.topoEscErr == "" && withHuman > 0 {
		inboxChip = "  " + styleQuestion.Render(fmt.Sprintf("%d in inbox", withHuman))
	}
	dispatchSeen := false
	for _, r := range m.topoRows {
		if !r.Dispatch {
			continue
		}
		dispatchSeen = true
		label := r.Address
		if label == "" {
			label = r.Name
		}
		lines = append(lines, truncate(dotFor(joinAgentState(r.Status, r.TokenState), g)+" "+
			styleCardText.Render(label)+"  "+styleMeta.Render("dispatch")+inboxChip, innerW))
	}
	if !dispatchSeen {
		lines = append(lines, truncate(styleDim.Render("dispatch — no live binding")+inboxChip, innerW))
	}

	// Teams, then the flat bucket — board.ts renderRepo's own ordering:
	// leads (lane o) first inside a team, then workers by issue.
	byTeam := map[string][]TopoRow{}
	var teams []string
	for _, r := range m.topoRows {
		if r.Dispatch {
			continue
		}
		if _, ok := byTeam[r.Team]; !ok && r.Team != "" {
			teams = append(teams, r.Team)
		}
		byTeam[r.Team] = append(byTeam[r.Team], r)
	}
	sort.Strings(teams)
	renderBucket := func(rows []TopoRow, indent string) {
		sort.SliceStable(rows, func(i, j int) bool {
			oi, oj := 0, 0
			if rows[i].Lane != "o" {
				oi = 1
			}
			if rows[j].Lane != "o" {
				oj = 1
			}
			if oi != oj {
				return oi < oj
			}
			if rows[i].Issue != rows[j].Issue {
				return rows[i].Issue < rows[j].Issue
			}
			return rows[i].Name < rows[j].Name
		})
		for _, r := range rows {
			name := r.Name
			if name == "" {
				name = "(unnamed)"
			}
			line := indent + dotFor(joinAgentState(r.Status, r.TokenState), g) + " " + styleCardText.Render(name)
			if r.Lane == "o" {
				line += "  " + styleMeta.Render("lead")
			}
			if r.Issue != 0 {
				line += "  " + styleNum.Render(fmt.Sprintf("#%d", r.Issue))
			}
			if st := joinAgentState(r.Status, r.TokenState); st != "" {
				line += "  " + styleMeta.Render(st)
			}
			if r.HasLease && r.LeaseStale {
				line += "  " + styleErr.Render("lease STALE")
			}
			if m.topoEscErr == "" {
				if n := pendingByLead[r.Name]; n > 0 && r.Name != "" {
					line += "  " + styleQuestion.Render(fmt.Sprintf("%d decision(s) pending", n))
				}
				if e, ok := escByIssue[r.Issue]; ok && r.Issue != 0 {
					line += "  " + styleQuestion.Render("⚠ "+escLabel(e))
				}
			}
			if r.Note != "" {
				line += "  " + styleDim.Render("["+r.Note+"]")
			}
			lines = append(lines, truncate(line, innerW))
		}
	}
	for _, t := range teams {
		lines = append(lines, truncate(styleEpic.Render(t+"/"), innerW))
		renderBucket(byTeam[t], "  ")
	}
	if flat := byTeam[""]; len(flat) > 0 {
		lines = append(lines, truncate(styleDim.Render("flat/"), innerW))
		renderBucket(flat, "  ")
	}
	if len(m.topoRows) == 0 {
		lines = append(lines, styleDim.Render("(no live agents on this machine)"))
	}
	if m.topoWithheld != "" {
		// GH-2108: held-back rows are counted, never dropped silently.
		lines = append(lines, truncate(styleDim.Render("withheld: "+m.topoWithheld+" — board roster --all shows everything"), innerW))
	}

	// Head-clip: a tree reads top-down, so the FIRST lines survive.
	maxLines := bodyHeight - 4
	if maxLines < 3 {
		maxLines = 3
	}
	if len(lines) > maxLines {
		clipped := len(lines) - maxLines
		lines = append(lines[:maxLines], styleDim.Render(fmt.Sprintf("(+%d more — board roster shows all)", clipped)))
	}

	title := "topology — " + m.topoRepo + "  (machine-local; board claims not read)"
	content := styleTitle.Render(truncate(title, innerW)) + "\n" + strings.Join(lines, "\n")
	return styleOverlay.Width(innerW + 2).Render(content)
}

// ── inbox view (GH-2318) ────────────────────────────────────────────────────

// inboxDetailMaxLines caps how much of one row's detail the view wraps. The
// point of the view is to READ the decision text the card truncates to one
// line, so the cap is generous; past it the row says the issue has more.
const inboxDetailMaxLines = 8

// renderInbox draws the queue-level inbox surface: every Tier 1 row at full
// width, the decision text wrapped rather than clipped, the disposition verb
// under it, and a cursor. The three empty states stay apart exactly as the
// I column keeps them (unread / read failed / empty), and the two GH-2108
// honesty lines — withheld and with-leads — render as footers: rows the
// reader held back are counted, never dropped.
func renderInbox(m Model, bodyHeight int) string {
	innerW := m.width - 6
	if innerW < 20 {
		innerW = 20
	}
	maxLines := bodyHeight - 4
	if maxLines < 3 {
		maxLines = 3
	}

	title := "inbox — Tier 1"
	if m.cfg.Repo != "" {
		title = "inbox — " + baseName(m.cfg.Repo) + "  (Tier 1)"
	}
	switch {
	case m.inboxInFlight && m.lastInbox.IsZero():
		title += "  " + styleDim.Render("reading…")
	case !m.lastInbox.IsZero():
		title += "  " + styleDim.Render("read "+m.lastInbox.Format("15:04:05"))
		if m.inboxInFlight {
			title += styleDim.Render(" · refreshing…")
		}
	}

	var head []string
	switch {
	case !m.inboxOK && m.inboxErr != "":
		head = append(head, styleErr.Render("inbox read failed: "+m.inboxErr))
		if len(m.inboxCards) > 0 {
			head = append(head, styleErr.Render(fmt.Sprintf("showing the last good read (%d rows) — these may be stale", len(m.inboxCards))))
		}
	case !m.inboxOK:
		head = append(head, styleDim.Render("(reading the inbox…)"))
	case len(m.inboxCards) == 0:
		head = append(head, styleDim.Render("(inbox empty — no decisions waiting)"))
	default:
		head = append(head, styleQuestion.Render(inboxCountLine(m.inboxCards)))
	}

	var foot []string
	if m.inboxOK && m.inboxWithheld != "" {
		foot = append(foot, styleDim.Render("withheld: "+m.inboxWithheld+" (self-clearing)"))
	}
	if m.inboxOK && m.inboxLeads != "" {
		foot = append(foot, styleDim.Render("with leads: "+m.inboxLeads+" — a promotion (the lead's or the TTL's) admits them"))
	}

	// Rows → line blocks. Built in full first so the scroll window can be
	// computed over real heights: rows are variable-height by design.
	blocks := make([][]string, 0, len(m.inboxCards))
	for i, c := range m.inboxCards {
		blocks = append(blocks, inboxRowLines(m, c, i == m.inboxRow, innerW))
	}

	avail := maxLines - len(head) - len(foot)
	if avail < 2 {
		avail = 2
	}
	lines := append([]string{}, head...)
	if len(blocks) > 0 {
		top := inboxWindowTop(blocks, m.inboxRow, avail)
		used := 0
		// Reserve one line for each of the two scroll markers only when it
		// is needed, so a short list never spends rows on chrome.
		if top > 0 {
			lines = append(lines, styleDim.Render(fmt.Sprintf("(↑ %d above — k scrolls)", top)))
			used++
		}
		shown := 0
		for i := top; i < len(blocks); i++ {
			block := blocks[i]
			need := len(block)
			// The "below" marker needs a line if anything will be left over.
			reserve := 0
			if i < len(blocks)-1 {
				reserve = 1
			}
			if used+need+reserve > avail {
				if i != m.inboxRow {
					break
				}
				// The selected row alone outgrows the budget (a long decision
				// in a short terminal). It still renders — it is what the
				// cursor is on — but CLIPPED to the budget, so the footers,
				// legend, status and an active answer input stay on screen.
				// The row says so, and names the way to read the rest.
				room := avail - used - reserve
				if room < 2 {
					room = 2
				}
				if room < need {
					block = append(append([]string{}, block[:room-1]...),
						styleDim.Render("      (row clipped to the screen — g opens the issue)"))
					need = len(block)
				}
			}
			lines = append(lines, block...)
			used += need
			shown++
		}
		if rest := len(blocks) - top - shown; rest > 0 {
			lines = append(lines, styleDim.Render(fmt.Sprintf("(+%d more below — j scrolls)", rest)))
		}
	}
	lines = append(lines, foot...)
	for i := range lines {
		lines[i] = truncate(lines[i], innerW)
	}
	content := styleTitle.Render(truncate(title, innerW)) + "\n" + strings.Join(lines, "\n")
	return styleOverlay.Width(innerW + 2).Render(content)
}

// inboxCountLine is the CLI's own summary line, per queue, so the view and
// `board inbox` agree about what is waiting.
func inboxCountLine(cards []Card) string {
	n := map[string]int{}
	for _, c := range cards {
		n[c.Queue]++
	}
	return fmt.Sprintf("%d waiting — %d decisions, %d proposals, %d approvals, %d deliver-blocked",
		len(cards), n["decision"], n["proposal"], n["approval"], n["deliver-blocked"])
}

// inboxRowLines renders one row as a block: the head line (cursor gutter,
// number, queue, priority/estimate, title), the wrapped detail, and the
// disposition verb. Selection changes INK and the gutter glyph, never the
// block's height — the scroll window is computed over these heights.
func inboxRowLines(m Model, c Card, selected bool, width int) []string {
	bar, barStyle := "│", styleGutter
	numStyle, textStyle := styleNum, styleCardText
	if selected {
		bar, barStyle = "▌", styleGutterS
		numStyle, textStyle = styleNumSel, styleNumSel
	}
	gutter := barStyle.Render(bar) + " "
	indent := barStyle.Render(bar) + "    "
	inner := width - 2
	if inner < 10 {
		inner = 10
	}

	head := numStyle.Render(fmt.Sprintf("#%d", c.Number))
	if c.Queue != "" {
		head += "  " + styleMeta.Render(c.Queue)
	}
	if c.Priority != "" {
		head += "  " + priorityGlyph(c.Priority, m.glyphSet())
	}
	if c.Estimate != "" {
		head += " " + styleMeta.Render("["+c.Estimate+"]")
	}
	if n := len(m.agents[c.Number]); n > 0 {
		head += "  " + dotWorking.Render(fmt.Sprintf("%s%d", m.glyphSet().agents, n))
	}
	titleW := inner - lipgloss.Width(head) - 2
	if titleW > 3 {
		head += "  " + textStyle.Render(trimTo(c.Title, titleW))
	}
	lines := []string{gutter + head}

	detailW := inner - 4
	if detailW < 10 {
		detailW = 10
	}
	switch {
	case c.Queue == "decision":
		// The phone-answerable line, in full: this is the one thing the
		// card could not show and the reason the view exists.
		q := c.Question
		if q == "" {
			q = "(decision text unavailable — see the issue's Decision needed comment; g opens it)"
		}
		for _, l := range wrapWords("? "+q, detailW, inboxDetailMaxLines) {
			lines = append(lines, indent+styleQuestion.Render(l))
		}
	case c.Question != "":
		// approval: the reject arm; deliver-blocked: the reason. Never the
		// question ink — these rows are not answered, they are disposed.
		for _, l := range wrapWords(c.Question, detailW, inboxDetailMaxLines) {
			lines = append(lines, indent+styleMeta.Render(l))
		}
	}
	if c.Verb != "" {
		lines = append(lines, indent+styleMeta.Render("→ "+c.Verb))
	}
	return lines
}

// inboxWindowTop picks the first block to draw so the selected block is fully
// visible inside avail lines: the smallest top such that top..selected fits.
// Stateless by design — the cursor, not a remembered offset, decides the
// window, so a list that shrank under a refresh cannot strand the scroll.
func inboxWindowTop(blocks [][]string, selected, avail int) int {
	if selected >= len(blocks) {
		selected = len(blocks) - 1
	}
	if selected < 0 {
		return 0
	}
	top := selected
	used := len(blocks[selected])
	for top > 0 {
		// One line is reserved for the "above" marker whenever top > 0.
		if used+len(blocks[top-1])+1 > avail {
			break
		}
		used += len(blocks[top-1])
		top--
	}
	return top
}

// wrapWords word-wraps s to width cells, at most maxLines lines; a clipped
// last line ends in an ellipsis. Rune-aware, and a single over-long word is
// hard-broken rather than overflowing the box. An empty s yields one empty
// line so a caller's loop still emits the row.
func wrapWords(s string, width, maxLines int) []string {
	if width < 1 {
		width = 1
	}
	var out []string
	var cur []rune
	flush := func() {
		out = append(out, string(cur))
		cur = cur[:0]
	}
	for _, word := range strings.Fields(s) {
		w := []rune(word)
		for len(w) > width {
			if len(cur) > 0 {
				flush()
			}
			out = append(out, string(w[:width]))
			w = w[width:]
		}
		switch {
		case len(cur) == 0:
			cur = append(cur, w...)
		case len(cur)+1+len(w) <= width:
			cur = append(cur, ' ')
			cur = append(cur, w...)
		default:
			flush()
			cur = append(cur, w...)
		}
	}
	if len(cur) > 0 || len(out) == 0 {
		flush()
	}
	if maxLines > 0 && len(out) > maxLines {
		out = out[:maxLines]
		last := []rune(out[maxLines-1])
		if len(last) >= width {
			last = last[:width-1]
		}
		out[maxLines-1] = string(last) + "…"
	}
	return out
}

// escLabel names a live escalation's audience — where the decision sits now.
func escLabel(e TopoEsc) string {
	if e.Answered {
		return "answered — resume pending"
	}
	switch {
	case e.Route == "lead" && e.Disposition == "pending":
		return "decision → lead"
	case e.Disposition == "auto-promoted":
		return "decision → inbox (TTL)"
	case e.Disposition == "promoted":
		return "decision → inbox"
	default:
		return "decision → human"
	}
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
