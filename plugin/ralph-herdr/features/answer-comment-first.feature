@replay
Feature: Answer flows comment-first
  ralph-answer.sh walks Human Needed and answers ONE item. The durable half
  — the **Answer** issue comment via `board answer` — lands BEFORE any state
  write or decorative nudge (board.ts owns that ordering). Only after the
  durable half does a live session get nudged, with delivery reported
  honestly; with no live session the answer is complete comment-only.

  Background:
    Given a replay world with a board-scoped repo
    And Human Needed holds issue 123 titled "Choose the path"

  Scenario: A live session is nudged only after the durable comment
    Given an agent named "w123-fix" is already live on pane "p1"
    When the operator answers item 1 with "Use the blue path."
    Then the answer run exits 0
    And the board answer verb carried the message for issue 123
    And the board answer preceded the agent nudge in the combined log
    And the board answer even preceded the herd read
    And the nudge waited for delivery with a bounded timeout
    And delivery was reported as nudged

  Scenario: No live session — the answer completes comment-only
    Given the herd is empty
    When the operator answers item 1 with "Go with option B."
    Then the answer run exits 0
    And the board answer verb carried the message for issue 123
    And no agent prompt was ever attempted
    And the output names the missing session for issue 123

  Scenario: A board CLI predating the answer verb keeps the same ordering by hand
    Given the herd is empty
    And the board CLI predates the answer verb
    When the operator answers item 1 with "Fallback ordering."
    Then the answer run exits 0
    And the missing verb was never called
    And the gh comment preceded the board move in the combined log
