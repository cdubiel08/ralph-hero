// marks_test.go — the write-stamp watch (audit A6) and the heartbeat (D6d).
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLatestMarksTime(t *testing.T) {
	dir := t.TempDir()
	glob := filepath.Join(dir, "items-marks-*.json")

	if got := latestMarksTime(""); !got.IsZero() {
		t.Fatalf("empty glob must read zero, got %v", got)
	}
	if got := latestMarksTime(glob); !got.IsZero() {
		t.Fatalf("no files must read zero (absence asserts nothing), got %v", got)
	}

	older := filepath.Join(dir, "items-marks-a.json")
	newer := filepath.Join(dir, "items-marks-b.json")
	if err := os.WriteFile(older, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newer, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	tOld := time.Now().Add(-2 * time.Hour)
	tNew := time.Now().Add(-1 * time.Minute)
	if err := os.Chtimes(older, tOld, tOld); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(newer, tNew, tNew); err != nil {
		t.Fatal(err)
	}
	got := latestMarksTime(glob)
	if got.Sub(tNew).Abs() > time.Second {
		t.Fatalf("latestMarksTime = %v, want ~%v (the NEWEST file wins)", got, tNew)
	}
}

// The three-state contract: zero asserts nothing, the first read seeds, a
// later mtime snaps the cadence to the floor and refetches immediately.
func TestMarksMsgTriggersImmediateRefetch(t *testing.T) {
	f := &fakeRunner{}
	m := testModel(f)
	m.pollEvery = 300 * time.Second // deep in backoff
	base := time.Now()

	// Zero: a failed read leaves everything as it was.
	m2, cmd := updateModel(m, marksMsg{})
	if cmd != nil || !m2.lastMarkSeen.IsZero() || m2.pollEvery != 300*time.Second {
		t.Fatalf("a zero marks read must assert nothing (cmd=%v seen=%v every=%v)", cmd, m2.lastMarkSeen, m2.pollEvery)
	}

	// First observation: baseline only — Init already fetched the board.
	m2, cmd = updateModel(m, marksMsg{at: base})
	if cmd != nil {
		t.Fatalf("the seeding observation must not refetch")
	}
	if !m2.lastMarkSeen.Equal(base) {
		t.Fatalf("seed not recorded")
	}
	if m2.pollEvery != 300*time.Second {
		t.Fatalf("the seed must not touch the cadence")
	}

	// Same mtime again: no write happened, nothing moves.
	m3, cmd := updateModel(m2, marksMsg{at: base})
	if cmd != nil || m3.pollEvery != 300*time.Second {
		t.Fatalf("an unchanged stamp must not refetch or snap")
	}

	// A LATER stamp: a verified local write — snap and refetch now.
	m4, cmd := updateModel(m2, marksMsg{at: base.Add(5 * time.Second)})
	if cmd == nil {
		t.Fatalf("a newer stamp must dispatch an immediate board fetch")
	}
	if !m4.pollInFlight {
		t.Fatalf("the immediate fetch must be marked in flight")
	}
	if m4.pollEvery != m4.cfg.Interval {
		t.Fatalf("a newer stamp must snap the cadence to the floor, got %v", m4.pollEvery)
	}

	// A newer stamp while a poll is already in flight: recorded, no second fetch.
	m5 := m4
	m6, cmd := updateModel(m5, marksMsg{at: base.Add(10 * time.Second)})
	if cmd != nil {
		t.Fatalf("an in-flight poll already carries the write — no second fetch")
	}
	if !m6.lastMarkSeen.Equal(base.Add(10 * time.Second)) {
		t.Fatalf("the stamp must still advance while a poll is in flight")
	}
}

func TestWriteHeartbeat(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "cockpit.heartbeat.json")
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	writeHeartbeat(path, "/repo", 4242, now)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("heartbeat not written: %v", err)
	}
	var hb heartbeat
	if err := json.Unmarshal(raw, &hb); err != nil {
		t.Fatalf("heartbeat not JSON: %v", err)
	}
	if hb.Pid != 4242 || hb.Repo != "/repo" || hb.At != "2026-08-19T12:00:00Z" {
		t.Fatalf("heartbeat fields wrong: %+v", hb)
	}
	// Best-effort contract: an unwritable path must not panic or error out.
	writeHeartbeat(filepath.Join(dir, "sub", "cockpit.heartbeat.json", "impossible", "x.json"), "/repo", 1, now)
	writeHeartbeat("", "/repo", 1, now)
}

func TestMarksAndHeartbeatResolution(t *testing.T) {
	env := map[string]string{"HOME": "/home/u"}
	getenv := func(k string) string { return env[k] }
	if got := marksGlob(getenv); got != filepath.Join("/home/u", ".ralph", "cache", "items-marks-*.json") {
		t.Fatalf("marksGlob default wrong: %q", got)
	}
	if got := heartbeatPath(getenv); got != filepath.Join("/home/u", ".ralph", "cockpit.heartbeat.json") {
		t.Fatalf("heartbeatPath default wrong: %q", got)
	}
	env["RALPH_HOME"] = "/elsewhere/.r"
	if got := marksGlob(getenv); got != filepath.Join("/elsewhere/.r", "cache", "items-marks-*.json") {
		t.Fatalf("marksGlob must honour RALPH_HOME: %q", got)
	}
	env["RALPH_HERDR_MARKS_GLOB"] = "/tmp/x-*.json"
	env["RALPH_HERDR_HEARTBEAT_FILE"] = "/tmp/hb.json"
	if got := marksGlob(getenv); got != "/tmp/x-*.json" {
		t.Fatalf("marksGlob override lost: %q", got)
	}
	if got := heartbeatPath(getenv); got != "/tmp/hb.json" {
		t.Fatalf("heartbeatPath override lost: %q", got)
	}
	noHome := func(string) string { return "" }
	if marksGlob(noHome) != "" || heartbeatPath(noHome) != "" {
		t.Fatalf("no HOME must disable both channels, never guess a path")
	}
}
