package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// GH-2482: exercise the entire path from inbox JSON through the selected
// row's g key to the browser process, in both inbox presentations.
func TestInboxBrowserNavigation(t *testing.T) {
	cards, _, _, err := parseInbox(`{"tier1":{
		"decisions":[{"number":6,"repo":"o/r","queue":"decision","verb":"board answer 6"}],
		"awaitingApproval":[
			{"number":7,"repo":"o/r","pr":70},
			{"number":8,"repo":"o/r","pr":null},
			{"number":9,"repo":null,"pr":90}
		]
	}}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) != 4 {
		t.Fatalf("got %d inbox cards, want 4", len(cards))
	}
	for _, view := range []string{"column", "full view"} {
		for row, tc := range []struct {
			name string
			url  string
		}{
			{"decision opens issue", "https://github.com/o/r/issues/6"},
			{"approval opens PR", "https://github.com/o/r/pull/70"},
			{"missing PR falls back to issue", "https://github.com/o/r/issues/8"},
			{"missing repo refuses", ""},
		} {
			t.Run(view+"/"+tc.name, func(t *testing.T) {
				dir := t.TempDir()
				capture := filepath.Join(dir, "browser-args")
				t.Setenv("BROWSER_CAPTURE", capture)
				// Replace both supported platform openers. An isolated PATH
				// ensures this test cannot launch the user's real browser.
				t.Setenv("PATH", dir)
				for _, opener := range []string{"open", "xdg-open"} {
					if err := os.WriteFile(filepath.Join(dir, opener), []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$BROWSER_CAPTURE\"\n"), 0o755); err != nil {
						t.Fatal(err)
					}
				}
				m := testModel(&fakeRunner{})
				m.inboxCards, m.inboxOK = cards, true
				if view == "column" {
					m.showInbox = true
					m.col, m.row = 2, row
				} else {
					m.mode, m.inboxRow = ModeInbox, row
				}
				_, cmd := updateKey(m, keyMsg("g"))
				if cmd == nil {
					t.Fatal("g did not return a browser command")
				}
				msg, ok := cmd().(statusMsg)
				if !ok {
					t.Fatal("browser command did not return a status")
				}
				if tc.url == "" {
					if msg.kind != statusRefuse || !strings.Contains(msg.text, "PR #90") {
						t.Errorf("status = %+v, want refusal naming PR #90", msg)
					}
					if _, err := os.Stat(capture); !os.IsNotExist(err) {
						t.Fatalf("browser must not run without a repo; capture stat: %v", err)
					}
					return
				}
				got, err := os.ReadFile(capture)
				if err != nil {
					t.Fatalf("browser args: %v (status: %+v)", err, msg)
				}
				if string(got) != tc.url+"\n" {
					t.Errorf("browser args = %q, want %q", got, tc.url+"\n")
				}
				if msg.text != "opened "+tc.url {
					t.Errorf("status = %+v, want opened %s", msg, tc.url)
				}
			})
		}
	}
}
