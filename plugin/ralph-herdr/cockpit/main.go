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
package main

import (
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
	p := tea.NewProgram(newModel(cfg, execRunner{}), tea.WithAltScreen(), tea.WithMouseCellMotion())
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
		} else if p := installedBoardCLI(getenv("HOME")); p != "" {
			// Tier 3, GH-1761: a herdr pane inherits the SERVER's env, so a
			// cockpit opened outside a ralph checkout has no vendored board.
			// Order mirrors lib.sh installed_board_cli() and
			// herdr-setup.sh's board check — change all three together.
			cfg.Board = p
		}
	}
	if cfg.Board == "" {
		return cfg, fmt.Errorf("no board CLI — tried argv[1] (unset), RALPH_HERDR_BOARD (unset), %s, and ~/.claude/plugins/cache/*/ralph/*/scripts/board (is the ralph Claude Code plugin installed?)",
			filepath.Join(cfg.Repo, "ralph", "scripts", "board"))
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

// installedBoardCLI returns the newest executable board CLI from the installed
// ralph plugin cache, or "" when none is usable. Ranking is by the VERSION path
// component (…/ralph/<version>/scripts/board), NOT the whole path — a full-path
// sort would rank the marketplace namespace above the version, exactly the trap
// lib.sh's `awk -F/ '{print $(NF-2)}' | sort -V` avoids. Callers must only reach
// this after an explicit path was absent: an explicit-but-broken path is an
// error, never a reason to fall back.
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
