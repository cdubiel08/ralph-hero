@replay
Feature: A blocked agent escalates once per transition
  watch-event.sh turns a pane.agent_status_changed event into one ledger
  state event and — only for blocked — one notification carrying the pane
  title and state labels. Statuses without an honest lifecycle claim (idle)
  are ledgered but push no state token and raise no toast; blocked routes
  attention, never board writes.

  Scenario: One blocked transition yields one state event and one notification
    Given a replay world with a board-scoped repo
    And a ledgered agent "w123-fix" with epoch "aaaa" on pane "p1" for issue 123
    When the watcher receives agent status "blocked" for "w123-fix" on pane "p1" titled "Fix the flaky test" with blocked label "needs a decision"
    Then the hook exits 0
    And the ledger holds exactly 1 state event recording status "blocked" for "w123-fix#aaaa"
    And the state token "blocked" was pushed onto pane "p1" exactly once
    And exactly 1 notification was shown, carrying the title and the blocked label

  Scenario: A working transition escalates nothing
    Given a replay world with a board-scoped repo
    And a ledgered agent "w123-fix" with epoch "aaaa" on pane "p1" for issue 123
    When the watcher receives agent status "working" for "w123-fix" on pane "p1"
    Then the hook exits 0
    And the ledger holds exactly 1 state event recording status "working" for "w123-fix#aaaa"
    And the state token "working" was pushed onto pane "p1" exactly once
    And no notification was shown

  Scenario: An idle transition is ledgered but never escalated
    Given a replay world with a board-scoped repo
    And a ledgered agent "w123-fix" with epoch "aaaa" on pane "p1" for issue 123
    When the watcher receives agent status "idle" for "w123-fix" on pane "p1"
    Then the hook exits 0
    And the ledger holds exactly 1 state event recording status "idle" for "w123-fix#aaaa"
    And no state token and no notification went out

  Scenario: A status event whose herd disagrees writes nothing durable
    Herdr documents no ordering, deduplication or replay for plugin events, so
    a payload can describe a state the agent has already left. The durable
    write is taken from the snapshot; the stale payload only routes attention.
    Given a replay world with a board-scoped repo
    And a ledgered agent "w123-fix" with epoch "aaaa" on pane "p1" for issue 123
    And the live herd reports "w123-fix" as "working" on pane "p1"
    When the watcher receives a stale agent status "done" for "w123-fix" on pane "p1"
    Then the hook exits 0
    And the ledger holds exactly 1 state event recording status "working" for "w123-fix#aaaa"
    And the ledger holds no state event recording status "done" for "w123-fix#aaaa"
