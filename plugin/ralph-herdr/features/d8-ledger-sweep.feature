@live
Feature: D8 — a foreign server does not sweep a populated ledger (GH-2018)
  The controlled re-test of the failure where the safety equipment did the
  damage. herdr fires the `[[startup]]` hook for EVERY server that starts, so
  an isolated probe server ran reconcile against the operator's real `~/.ralph`
  ledgers while answering about a herd it had never had — and phase A marked
  all five running workers `lost` in one pass, including the session writing
  the finding up (predecessor research 2026-08-13, finding D8).

  GH-1863 (pane-proved ownership), GH-1933 (session-proved) and GH-1905
  (refill's own gate) were written to close that. The replay suites already
  pin the gate's LOGIC — watcher.test.sh §6b/§6c, fleet.test.sh's foreign-refill
  row — but every one of them stubs the herdr server, which is the half that
  actually failed: D8 was not a wrong branch, it was a real server correctly
  answering "I have never heard of these agents" into phases that read absence
  as death. A fake that returns the same JSON cannot re-test that.

  So these scenarios reproduce D8 against a REAL isolated server, with a
  scratch victim instead of the operator's ledgers: a scratch ledger root whose
  open records name panes this server has never held, written by a session key
  that is not its own.

  WHY EACH REFUSAL IS PAIRED WITH A POSITIVE CONTROL. "Nothing was marked lost"
  is also what a reconcile that did nothing at all would produce — a broken
  harness, a pass that aborted on an unreadable snapshot, and a working gate are
  indistinguishable on that assertion alone. Each refusal scenario therefore has
  a twin that differs ONLY in the ownership proof and asserts the sweep DOES
  happen. A gate that stopped gating fails the first; a suite that stopped
  reaching the code fails the second.

  Safety contract, inherited from live-smoke.feature and tightened here: named
  test session only, plain shell panes only, session stopped and deleted in the
  After hook. Beyond that, nothing in this feature can reach the operator's
  world — every seeded record names a checkout that does not exist, so the
  claim-recovery phase can resolve no board even if its own guard failed, and
  the armed fleet below names a repo that does not exist, so the refill path
  disarms before any spawn even if the ownership gate failed. Those are blast
  bounds, not the assertions; the assertions are the gate lines themselves.

  Scenario: The D8 shape — a populated ledger this server has never seen
    Given a live herdr test session named "ralph-bdd"
    And a scratch ledger root holding two open records written by another session
    When the reconcile pass runs against the live test session
    Then reconcile completes its single pass
    And no record in the scratch ledger is marked lost
    And the scratch ledger is byte-identical to what was seeded
    And the pass declined the sweep out loud
    And both records are still open

  Scenario: The positive control — the same ledger, written by this server
    Given a live herdr test session named "ralph-bdd"
    And a scratch ledger root holding two open records written by this server
    When the reconcile pass runs against the live test session
    Then reconcile completes its single pass
    And both records are marked lost

  Scenario: A fleet armed by another session is not refilled (GH-1905)
    Given a live herdr test session named "ralph-bdd"
    And a scratch ledger root holding two open records written by another session
    And the scratch scope has an armed fleet from another session
    When the reconcile pass runs against the live test session
    Then reconcile completes its single pass
    And the pass declined the refill out loud
    And the refill never reached the spawn path
    And the live test session gained no agents
