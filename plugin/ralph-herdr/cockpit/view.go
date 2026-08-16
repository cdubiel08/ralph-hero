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
	headerRows      = 2 // title line + banner/blank line above the columns
	cardRows        = 3 // every card renders exactly this many lines
	colHeaderRows   = 2 // column title + rule
	statusRows      = 2 // legend + status line
	narrowThreshold = 90
)

var (
	styleTitle    = lipgloss.NewStyle().Bold(true)
	styleBanner   = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))
	styleDim      = lipgloss.NewStyle().Faint(true)
	styleColHead  = lipgloss.NewStyle().Bold(true).Underline(true)
	styleSelected = lipgloss.NewStyle().Reverse(true)
	styleWorking  = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	styleBlocked  = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	styleIdle     = lipgloss.NewStyle().Foreground(lipgloss.Color("12"))
	styleErr      = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	styleOverlay  = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).Padding(0, 1)
	styleQuestion = lipgloss.NewStyle().Italic(true)
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
	switch {
	case m.boardErr != "" && !m.herdrOK:
		b.WriteString(truncate(
			styleErr.Render("board read failed: "+m.boardErr)+styleBanner.Render(" · "+noMuxBanner), m.width))
	case m.boardErr != "":
		b.WriteString(truncate(styleErr.Render("board read failed: "+m.boardErr), m.width))
	case !m.herdrOK:
		b.WriteString(truncate(styleBanner.Render(noMuxBanner), m.width))
	}
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
	return "h/l col · j/k card · ⏎ observe · ␣/o peek · r reply · a answer · s spawn · f fork · v dag · d diff · g browser · q quit"
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
	cards := m.cols[idx]
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
	cards := m.cols[idx]
	head := columnStates[idx] // board state name VERBATIM
	if narrow {
		head = fmt.Sprintf("◀ %s (%d/3) ▶", head, idx+1)
	}
	head = fmt.Sprintf("%s (%d)", head, len(cards))
	var b strings.Builder
	b.WriteString(truncate(styleColHead.Render(head), width))
	b.WriteString("\n")
	b.WriteString(truncate(styleDim.Render(strings.Repeat("─", min(width, 40))), width))
	b.WriteString("\n")

	if len(cards) == 0 {
		b.WriteString(truncate(styleDim.Render("  (none)"), width))
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

// renderCard emits exactly cardRows lines (hitTest depends on it).
func renderCard(m Model, colIdx, rowIdx int, card Card, width int) string {
	selected := m.mode != ModePeek && m.mode != ModeDag && colIdx == m.col && rowIdx == m.row

	cursor := "  "
	if selected {
		cursor = "▸ "
	}
	glyph := " "
	who := ""
	if status, ok := m.glyphStatus(card.Number); ok {
		switch status {
		case "working":
			glyph = styleWorking.Render("●")
		case "blocked":
			glyph = styleBlocked.Render("●")
		case "idle", "done":
			glyph = styleIdle.Render("●")
		default:
			glyph = styleDim.Render("●")
		}
		if a, ok := m.agentFor(card.Number); ok {
			who = " " + styleDim.Render(a.Name)
		}
	}
	line1 := fmt.Sprintf("%s#%d %s%s", cursor, card.Number, glyph, who)

	title := card.Title
	if selected {
		title = styleSelected.Render(title)
	}
	line2 := "  " + title

	var line3 string
	if card.State == "Human Needed" {
		// The phone-answerable contract: the question line, verbatim.
		q := card.Question
		if q == "" {
			q = "(question unavailable — a still answers via the board)"
		}
		line3 = "  " + styleQuestion.Render("? "+q)
	} else {
		meta := []string{}
		if card.Priority != "" {
			meta = append(meta, "["+card.Priority+"]")
		}
		if card.Estimate != "" {
			meta = append(meta, "["+card.Estimate+"]")
		}
		if card.ParentNumber != 0 {
			meta = append(meta, fmt.Sprintf("via #%d", card.ParentNumber))
		}
		line3 = "  " + styleDim.Render(strings.Join(meta, " "))
	}

	return truncate(line1, width) + "\n" + truncate(line2, width) + "\n" + truncate(line3, width) + "\n"
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

func baseName(p string) string {
	p = strings.TrimRight(p, "/")
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}
