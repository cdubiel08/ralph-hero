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
//	RALPH_COCKPIT_INTERVAL  board poll seconds (default 30, min 10)
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
		}
	}
	if cfg.Board == "" {
		return cfg, fmt.Errorf("no board CLI — pass its path as argv[1], set RALPH_HERDR_BOARD, or run from a repo with ralph/scripts/board")
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

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode()&0o111 != 0
}
