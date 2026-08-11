@replay
Feature: Lineage survives a server restart
  The events ledger is append-only JSONL on disk, outside any repo. A herdr
  server restart loses panes and metadata, never the ledger: the startup
  reconcile pass re-reads it, marks agents with no live counterpart lost,
  discovers live agents no ledger holds open, and re-pushes tokens — all
  without rewriting a single existing line.

  Scenario: Reconcile discovers and loses correctly without rewriting history
    Given a replay world with a board-scoped repo
    And the ledger records spawns for "w123-fix#aaaa" on pane "p1" and "w9-gone#ffff" on pane "p9"
    And the live herd answers "w123-fix" on pane "p1" and an unledgered "w5-alpha" on pane "p5" whose pane cwd is the scoped repo
    When the reconcile pass runs
    Then reconcile completes its single pass
    And the pre-restart ledger lines are still byte-identical on disk
    And "w9-gone#ffff" was marked lost via reconcile
    And a discover record minted a fresh ref for "w5-alpha" bound to pane "p5"
    And "w123-fix#aaaa" replayed its spawn tokens onto pane "p1"
    And the open set is exactly "w123-fix" and "w5-alpha"

  @chaos
  Scenario: A sick server never marks the herd lost
    Given a replay world with a board-scoped repo
    And the ledger records spawns for "w123-fix#aaaa" on pane "p1" and "w9-gone#ffff" on pane "p9"
    And the herdr server refuses every read
    When the reconcile pass runs
    Then reconcile declines the pass loudly
    And the ledger is untouched
