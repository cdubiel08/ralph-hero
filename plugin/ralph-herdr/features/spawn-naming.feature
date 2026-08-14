@replay
Feature: Spawn honors the naming grammar
  The single sanctioned spawn path (lib.sh spawn_work_session) derives the
  agent name from the board queue item's title under grammar B
  (w<issue>-<slug>), branches <kind>/N-<slug> — the board CLI's grammar, read
  from `board name` and never re-derived here (GH-1807) — from origin/main,
  and appends a
  C7 LineageRecord binding the durable agent ref (name#epoch) to the issue
  and its parent — validated by the real board CLI's contract validator.

  Scenario: A frontier issue spawns under grammar B with a validated lineage record
    Given a replay world with a board-scoped repo
    And the herd is empty
    And the queue offers issue 123 titled "Fix the flaky test" under parent 45
    When spawn_work_session runs for issue 123
    Then the spawn succeeds
    And the agent is named "w123-fix-the-flaky-test"
    And the worktree was created on branch "feat/123-fake-issue" from origin/main
    And the agent was prompted with "/ralph:work 123"
    And the ledger holds one spawn record binding the agent ref to issue 123 with parent 45
    And the spawn record's agent ref is the agent's name plus a 8-hex epoch
    And the spawn record's lineage validates against the ralph.lineage contract
    And the spawn tokens were pushed onto the pane

  Scenario: An already-live issue is skipped, never suffixed
    Given a replay world with a board-scoped repo
    And an agent named "w123-fix" is already live on pane "p1"
    And the queue offers issue 123 titled "Fix the flaky test" under parent 45
    When spawn_work_session runs for issue 123
    Then the spawn is skipped as already live
    And no worktree was created and no agent was started
    And no "--2" sibling name was ever attempted
    And the ledger stayed empty

  # GH-1926: `agent prompt` returning 0 says the text reached the pane's input
  # buffer, not that Enter landed. A live-but-idle agent holding an unsubmitted
  # prompt burns a fleet slot while the summary reports `failed: (none)`.
  Scenario: A prompt that was delivered but never submitted is not a spawn
    Given a replay world with a board-scoped repo
    And the herd is empty
    And the spawned agent never leaves idle after the prompt
    And the queue offers issue 123 titled "Fix the flaky test" under parent 45
    When spawn_work_session runs for issue 123
    Then the spawn fails as an unconfirmed turn
    And "w123-fix-the-flaky-test" was prompted once
