// ralph-cockpit — rung 1 of the ralph-herdr degradation ladder: a Go TUI over
// the board CLI (authoritative) with a herdr agent-state overlay (decoration).
// Poll-only is the shipped mode; a herdr [[events]] push channel is Phase-6+.
// Every rung below this one loses chrome, never a verb: cockpit-fzf.sh,
// dashboard.sh, then board/gh standalone.
//
// Usage: ralph-cockpit [BOARD_CLI_PATH]
//
// Knobs:
//
//	RALPH_HERDR_BOARD       board CLI path (argv[1] wins over this)
//	HERDR_BIN_PATH          herdr binary (falls back to PATH; absent = the
//	                        overlay is off and observe/peek/reply degrade)
//	RALPH_HERDR_REPO        repo to operate on (default: cwd)
//	RALPH_HERDR_SCRIPTS     plugin scripts/ dir for the sanctioned spawn path
//	                        (default: <executable>/../../scripts)
//	RALPH_COCKPIT_INTERVAL  tick + board-poll FLOOR seconds (default 30, min 10)
//	RALPH_COCKPIT_INTERVAL_MAX
//	                        hard staleness bound on the adaptive board cadence
//	                        (default 300; below the floor = backoff off)
//	RALPH_COCKPIT_SIGNAL_INTERVAL
//	                        seconds between board-sourced card-marking reads —
//	                        the PR chip, the epic rollup, and (only while it is
//	                        on screen) the Done window. Default 120, floored at
//	                        RALPH_COCKPIT_INTERVAL
//	RALPH_COCKPIT_GLYPHS    "nerd" opts in to Nerd Font card glyphs; anything
//	                        else (default) uses ASCII — a host without the font
//	                        renders tofu at the wrong width and shears the
//	                        fixed-stride card grid the mouse maps through
//	RALPH_HERDR_LEDGER      pin the spawn ledger file (default: the board
//	                        scope's ~/.ralph/<owner>/<repo>/ledger.jsonl)
//	RALPH_HERDR_LEDGER_ROOT ledger root dir (default ~/.ralph)
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	cfg, err := resolveConfig(os.Args[1:], os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "ralph-cockpit:", err)
		os.Exit(2)
	}
	// WithReportFocus asks the terminal for DECSET 1004 focus reporting — the
	// third cadence input (GH-1876). Probed against a real herdr pane
	// 2026-08-14: herdr forwards \e[I / \e[O on pane switches. A host that
	// does not support it simply never sends the events, and the cadence is
	// exactly what GH-1805 shipped.
	p := tea.NewProgram(newModel(cfg, execRunner{}), tea.WithAltScreen(), tea.WithMouseCellMotion(), tea.WithReportFocus())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "ralph-cockpit:", err)
		os.Exit(1)
	}
}

// resolveConfig builds the Config from argv + env. Pure over its inputs
// (getenv injected) except for the executable-path and PATH probes.
func resolveConfig(args []string, getenv func(string) string) (Config, error) {
	cfg := Config{}

	// Repo: env else cwd — matches lib.sh's RALPH_HERDR_REPO contract.
	cfg.Repo = getenv("RALPH_HERDR_REPO")
	if cfg.Repo == "" {
		if wd, err := os.Getwd(); err == nil {
			cfg.Repo = wd
		}
	}

	// Board CLI: argv[1] > RALPH_HERDR_BOARD > the vendored-checkout layout.
	switch {
	case len(args) > 0 && args[0] != "":
		cfg.Board = args[0]
	case getenv("RALPH_HERDR_BOARD") != "":
		cfg.Board = getenv("RALPH_HERDR_BOARD")
	default:
		candidate := filepath.Join(cfg.Repo, "ralph", "scripts", "board")
		if isExecutable(candidate) {
			cfg.Board = candidate
		} else if p := registryBoardCLI(installedPluginsFile(
			getenv("HOME"), getenv("CLAUDE_CONFIG_DIR"), getenv("RALPH_INSTALLED_PLUGINS_FILE"))); p != "" {
			// Tier 3, GH-1761/GH-1865: a herdr pane inherits the SERVER's env,
			// so a cockpit opened outside a ralph checkout has no vendored
			// board. Order mirrors lib.sh installed_board_cli_tagged() and
			// herdr-setup.sh's board check — change all three together.
			cfg.Board = p
		} else if p := installedBoardCLI(getenv("HOME")); p != "" {
			cfg.Board = p
		}
	}
	if cfg.Board == "" {
		return cfg, fmt.Errorf("no board CLI — tried argv[1] (unset), RALPH_HERDR_BOARD (unset), %s, %s, and ~/.claude/plugins/cache/*/ralph/*/scripts/board (is the ralph Claude Code plugin installed?)",
			filepath.Join(cfg.Repo, "ralph", "scripts", "board"),
			installedPluginsFile(getenv("HOME"), getenv("CLAUDE_CONFIG_DIR"), getenv("RALPH_INSTALLED_PLUGINS_FILE")))
	}
	if !isExecutable(cfg.Board) {
		return cfg, fmt.Errorf("board CLI %q is not executable", cfg.Board)
	}

	// herdr: HERDR_BIN_PATH else PATH. Absent is a supported degradation,
	// never an error — the banner names it.
	if p := getenv("HERDR_BIN_PATH"); p != "" && isExecutable(p) {
		cfg.Herdr = p
	} else if p, err := exec.LookPath("herdr"); err == nil {
		cfg.Herdr = p
	}

	// gh: chrome only (Human Needed question lines, diff hints).
	if p, err := exec.LookPath("gh"); err == nil {
		cfg.Gh = p
	}

	// Scripts dir for the sanctioned spawn path: env else sibling of the
	// cockpit binary (cockpit/ sits beside scripts/ in the plugin tree).
	if d := getenv("RALPH_HERDR_SCRIPTS"); d != "" {
		cfg.ScriptsDir = d
	} else if exe, err := os.Executable(); err == nil {
		cfg.ScriptsDir = filepath.Join(filepath.Dir(exe), "..", "scripts")
	}

	cfg.Interval = pollInterval(getenv("RALPH_COCKPIT_INTERVAL"))
	cfg.MaxInterval = maxPollInterval(getenv("RALPH_COCKPIT_INTERVAL_MAX"), cfg.Interval)
	cfg.SignalInterval = signalInterval(getenv("RALPH_COCKPIT_SIGNAL_INTERVAL"), cfg.Interval)

	// Machine-local markings. Both are chrome and neither can fail startup:
	// no discoverable board scope costs the age chip, and an unset glyph knob
	// takes the ASCII set.
	cfg.LedgerPath = ledgerPath(cfg.Repo, getenv)
	cfg.Glyphs = resolveGlyphs(getenv("RALPH_COCKPIT_GLYPHS"))
	// The local write stamp watch (audit A6) and the liveness heartbeat
	// (audit D6d) — both machine-local, both optional, neither fails startup.
	cfg.MarksGlob = marksGlob(getenv)
	cfg.HeartbeatPath = heartbeatPath(getenv)
	return cfg, nil
}

// pollInterval parses RALPH_COCKPIT_INTERVAL: default 30s, floor 10s (the
// floor guards the GitHub API from a hot loop), garbage takes the default.
func pollInterval(raw string) time.Duration {
	const def = 30 * time.Second
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return def
	}
	if n < 10 {
		n = 10
	}
	return time.Duration(n) * time.Second
}

// maxPollInterval parses RALPH_COCKPIT_INTERVAL_MAX — the hard staleness bound
// on the adaptive board cadence (GH-1805): default 300s, garbage takes the
// default, and a value below the floor collapses TO the floor, which is the
// honest way to turn the backoff off (a constant cadence) rather than a
// configuration that cannot be satisfied.
func maxPollInterval(raw string, floor time.Duration) time.Duration {
	const def = 300 * time.Second
	max := def
	if raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			max = time.Duration(n) * time.Second
		}
	}
	if max < floor {
		return floor
	}
	return max
}

// signalInterval parses RALPH_COCKPIT_SIGNAL_INTERVAL — the second cadence
// (GH-2062): default 120s, garbage takes the default, and a value below the
// board floor collapses TO the floor. Slower than the board poll by default
// because these reads cost more per pass and go stale more slowly: a PR's fate
// changes on someone else's clock, not on the board's.
func signalInterval(raw string, floor time.Duration) time.Duration {
	const def = 120 * time.Second
	d := def
	if raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			d = time.Duration(n) * time.Second
		}
	}
	if d < floor {
		return floor
	}
	return d
}

// installedPluginsFile resolves Claude Code's install registry, honouring
// $CLAUDE_CONFIG_DIR. Empty when there is no HOME to root it in.
func installedPluginsFile(home, configDir, override string) string {
	if override != "" {
		return override
	}
	if configDir == "" {
		if home == "" {
			return ""
		}
		configDir = filepath.Join(home, ".claude")
	}
	return filepath.Join(configDir, "plugins", "installed_plugins.json")
}

// registryBoardCLI returns the board CLI of the ralph copy Claude Code has
// RECORDED as installed, or "" when the registry cannot answer. This is the
// authority (GH-1865): the cache glob below only finds the highest-versioned
// directory that exists, and the two coincide only while the newest install is
// also the newest directory — a downgrade, a second marketplace, or a
// project-scoped install breaks that and the glob then names a plausible path
// nobody runs. The recorded version is a tie-break between several registered
// copies, never the reason to prefer the registry — being recorded is.
func registryBoardCLI(file string) string {
	if file == "" {
		return ""
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	var reg struct {
		Plugins map[string][]struct {
			InstallPath string `json:"installPath"`
			Version     string `json:"version"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &reg); err != nil {
		return ""
	}
	best, bestVer := "", ""
	for key, entries := range reg.Plugins {
		if strings.SplitN(key, "@", 2)[0] != "ralph" { // keys are "<name>@<marketplace>"
			continue
		}
		for _, e := range entries {
			if e.InstallPath == "" {
				continue
			}
			p := filepath.Join(e.InstallPath, "scripts", "board")
			if !isExecutable(p) {
				continue
			}
			if best == "" || compareVersions(e.Version, bestVer) > 0 {
				best, bestVer = p, e.Version
			}
		}
	}
	return best
}

// installedBoardCLI returns the newest executable board CLI found by globbing
// the plugin cache, or "" when none is usable. LAST RESORT only — it answers
// when the registry cannot (absent, unreadable, no ralph entry), and its answer
// is a guess, which every caller that reports a path must say. Ranking is by
// the VERSION path component (…/ralph/<version>/scripts/board), NOT the whole
// path — a full-path sort would rank the marketplace namespace above the
// version, exactly the trap lib.sh's `awk -F/ '{print $(NF-2)}' | sort -V`
// avoids. Callers must only reach this after an explicit path was absent: an
// explicit-but-broken path is an error, never a reason to fall back.
func installedBoardCLI(home string) string {
	if home == "" {
		return ""
	}
	matches, err := filepath.Glob(filepath.Join(home, ".claude", "plugins", "cache", "*", "ralph", "*", "scripts", "board"))
	if err != nil || len(matches) == 0 {
		return ""
	}
	best, bestVer := "", ""
	for _, m := range matches {
		if !isExecutable(m) {
			continue
		}
		// …/ralph/<version>/scripts/board — version is 3 elements up.
		parts := strings.Split(filepath.ToSlash(m), "/")
		if len(parts) < 4 {
			continue
		}
		ver := parts[len(parts)-3]
		if best == "" || compareVersions(ver, bestVer) > 0 {
			best, bestVer = m, ver
		}
	}
	return best
}

// compareVersions orders dotted version strings numerically per component
// (so 0.10.0 > 0.9.0, which a lexical compare gets wrong), falling back to a
// string compare for non-numeric components.
func compareVersions(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		// A missing component is zero, so 1.2 == 1.2.0 rather than sorting
		// below it (an empty string would otherwise fall to string compare).
		ap, bp := "0", "0"
		if i < len(as) && as[i] != "" {
			ap = as[i]
		}
		if i < len(bs) && bs[i] != "" {
			bp = bs[i]
		}
		ai, aerr := strconv.Atoi(ap)
		bi, berr := strconv.Atoi(bp)
		if aerr == nil && berr == nil {
			if ai != bi {
				if ai > bi {
					return 1
				}
				return -1
			}
			continue
		}
		if ap != bp {
			if ap > bp {
				return 1
			}
			return -1
		}
	}
	return 0
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode()&0o111 != 0
}
