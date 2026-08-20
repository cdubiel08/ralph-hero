// marks.go — two small machine-local side channels (2026-08-19 audit):
//
// A6 consumer: board.ts advances a marks file under ~/.ralph/cache on every
// verified mutation (markLocalWrite → items-marks-*.json). Watching that
// file's mtime turns the fleet's dominant board cost from poll into event at
// zero API cost: a local write snaps the adaptive cadence (GH-1805) to the
// floor and refetches NOW, while the existing poll stays as the reconciler
// for web-UI and foreign edits the stamp cannot see. Advisory-freshness only,
// per GH-1806's rules — the stamp may only SHORTEN staleness (it triggers
// refetches), never extend one and never feed a write guard.
//
// D6d producer: the cockpit writes a heartbeat file every tick so "the
// cockpit died silently" (observed under GraphQL exhaustion — found only when
// the user asked) is a readable fact. herdr-setup.sh's cockpit-heartbeat note
// reads it: pid alive + fresh mtime = ok; anything else names the relaunch.
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// marksMsg carries the newest mtime across every items-marks file the glob
// matched. A zero time means "could not read" or "no file yet" — which
// asserts NOTHING (absence is never evidence of quiet), and the handler
// leaves the cadence exactly as it was.
type marksMsg struct{ at time.Time }

// latestMarksTime stats the marks files and returns the newest mtime. The
// glob spans every board's marks file rather than deriving the one exact name
// (host-owner-repo-project, which the cockpit does not resolve): a foreign
// board's write costs one extra poll at the floor — cheap — while a wrong
// derivation would watch a file that never moves and silently disable the
// whole channel.
func latestMarksTime(glob string) time.Time {
	var newest time.Time
	if glob == "" {
		return newest
	}
	matches, err := filepath.Glob(glob)
	if err != nil {
		return newest
	}
	for _, m := range matches {
		info, err := os.Stat(m)
		if err != nil {
			continue
		}
		if t := info.ModTime(); t.After(newest) {
			newest = t
		}
	}
	return newest
}

func checkMarksCmd(cfg Config) tea.Cmd {
	if cfg.MarksGlob == "" {
		return nil
	}
	return func() tea.Msg { return marksMsg{at: latestMarksTime(cfg.MarksGlob)} }
}

// heartbeat is what the file holds. Written whole each time (tmp+rename would
// be overkill for a liveness stamp — a torn read degrades to "unreadable",
// which the reader renders as not-evaluated, never as alive).
type heartbeat struct {
	Pid  int    `json:"pid"`
	At   string `json:"at"`
	Repo string `json:"repo"`
}

// writeHeartbeat is best-effort by contract: the heartbeat is telemetry about
// the cockpit, and a read-only ~/.ralph must never take the cockpit down.
func writeHeartbeat(path, repo string, pid int, now time.Time) {
	if path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	raw, err := json.Marshal(heartbeat{Pid: pid, At: now.UTC().Format(time.RFC3339), Repo: repo})
	if err != nil {
		return
	}
	_ = os.WriteFile(path, raw, 0o644)
}

func heartbeatCmd(cfg Config) tea.Cmd {
	if cfg.HeartbeatPath == "" {
		return nil
	}
	return func() tea.Msg {
		writeHeartbeat(cfg.HeartbeatPath, cfg.Repo, os.Getpid(), time.Now())
		return nil
	}
}

// marksGlob resolves the pattern for board.ts's items-marks files.
// board.ts writes them to ~/.ralph/cache/items-marks-<key>.json (see
// itemMarksPath); RALPH_HERDR_MARKS_GLOB overrides for tests.
func marksGlob(getenv func(string) string) string {
	if g := getenv("RALPH_HERDR_MARKS_GLOB"); g != "" {
		return g
	}
	root := getenv("RALPH_HOME")
	if root == "" {
		home := getenv("HOME")
		if home == "" {
			return ""
		}
		root = filepath.Join(home, ".ralph")
	}
	return filepath.Join(root, "cache", "items-marks-*.json")
}

// heartbeatPath resolves where the heartbeat lands; herdr-setup.sh's
// cockpit-heartbeat check reads the same default — change the two together.
func heartbeatPath(getenv func(string) string) string {
	if p := getenv("RALPH_HERDR_HEARTBEAT_FILE"); p != "" {
		return p
	}
	root := getenv("RALPH_HOME")
	if root == "" {
		home := getenv("HOME")
		if home == "" {
			return ""
		}
		root = filepath.Join(home, ".ralph")
	}
	return filepath.Join(root, "cockpit.heartbeat.json")
}
