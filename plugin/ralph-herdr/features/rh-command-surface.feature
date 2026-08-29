@rh-command-surface
Feature: Ralph Hero command surface
  Background:
    Given a replay world with a board-scoped repo
    And the rh server is initially down

  Scenario: Home and dispatch status are read-only
    When the operator runs naked rh
    Then rh reports attention
    And no mutating board or Herdr command ran
    When the operator runs rh dispatch
    Then rh reports attention
    And no mutating board or Herdr command ran

  Scenario: Dispatch up ensures only dispatch prerequisites
    When the operator runs rh dispatch up
    Then rh succeeds
    And the Herdr server was started once
    And dispatch was ensured once
    And no team or cockpit command ran

  Scenario: Naked day creates no never-before-existing team
    When the operator runs naked rh day
    Then rh succeeds
    And no work-team command ran
    And cockpit and inbox followed healthy dispatch

  Scenario: A ledger-proven dead team resumes exactly once
    Given team 2208 has one scoped historical lead record and no live lead
    When the operator runs naked rh day
    And resumed lead for 2208 becomes live
    And the operator runs naked rh day again
    Then team 2208 was resumed exactly once
    And no other team was attempted

  Scenario: A live team is never doubled
    Given team 2208 has one scoped historical lead record and a live lead
    When the operator runs naked rh day
    Then no agent start for team 2208 ran

  Scenario: Ambiguous resume evidence launches nothing
    Given team 2208 has contradictory checkout evidence
    When the operator runs naked rh day
    Then rh reports attention
    And no agent start for team 2208 ran

  Scenario: Explicit teams are exact and repeatable flags deduplicate
    When the operator runs rh day with teams 2208, 2208, and 2176
    Then only teams 2208 and 2176 were attempted once

  Scenario: Dispatch failure prevents dependent phases
    Given dispatch up will fail
    When the operator runs naked rh day
    Then rh fails
    And reconcile, teams, cockpit, and inbox did not run
