@replay @chaos
Feature: One failure does not strand the fleet
  work-fleet.sh spawns up to k frontier issues through the shared spawn
  path. A worktree that refuses to open costs exactly that one issue —
  noted and continued, never the rest of the fleet — and the watcher's
  reconcile pass keeps watching the survivors.

  Scenario: A worktree failure strands neither sibling spawn
    Given a replay world with a board-scoped repo
    And the herd is empty
    And the frontier offers issues 301 "Add refill support", 302 "Broken checkout", 303 "Third in line"
    And every worktree verb fails for branch "feat/302-fake-issue"
    When work-fleet runs with a fleet size of 3
    Then the fleet summary reports GH-302 failed and the other two spawned
    And agents "w301-add-refill-support" and "w303-third-in-line" were each started and prompted once
    And no agent was ever started for issue 302
    And the ledger holds spawn records for issues 301 and 303 only

  Scenario: Reconcile keeps watching the survivors
    Given a replay world with a board-scoped repo
    And the ledger records spawns for "w301-add-refill-support#aaaa" on pane "p1" and "w303-third-in-line#bbbb" on pane "p2"
    And the live herd answers "w301-add-refill-support" on pane "p1" and "w303-third-in-line" on pane "p2"
    When the reconcile pass runs
    Then reconcile completes its single pass
    And both survivors stay open in the ledger
    And each survivor's spawn tokens were re-pushed onto its pane
