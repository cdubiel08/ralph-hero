@live
Feature: Live herdr smoke — named test session only
  These scenarios need a REAL herdr server. Safety contract (absolute):
  they run ONLY inside the named test session `ralph-bdd` — never the
  operator's default session — spawn ONLY plain shell panes (`herdr pane
  run`; no claude/codex agents, nothing that bills), and the session is
  stopped AND deleted afterwards even when a step fails. Doubly gated:
  `npm run test:bdd:live` refuses without RALPH_BDD_LIVE=1 and the steps
  re-check the same env before touching herdr.

  Scenario: A named test session serves pane JSON for a plain shell pane
    Given a live herdr test session named "ralph-bdd"
    And a workspace with a plain shell pane in the test session
    When the pane runs the shell command "echo ralph-bdd-live-probe"
    Then the pane's output contains "ralph-bdd-live-probe"
    And the pane answers a well-formed pane JSON envelope

  Scenario: Reconcile against a live empty herd is a no-op
    Given a live herdr test session named "ralph-bdd"
    And an empty temporary ledger root
    When the reconcile pass runs against the live test session
    Then reconcile completes its single pass
    And the temporary ledger root is still empty

  Scenario: rh observes and composes a named test session without coding agents
    Given an absent live herdr test session named "ralph-bdd"
    And safe rh live stubs for board, dispatch, resume, and cockpit
    When rh day starts the named test session
    Then rh reports a healthy dispatch and inbox
    And the named test session has no coding agents
    When rh day runs again in the named test session
    Then no second server or dispatch seat is created
