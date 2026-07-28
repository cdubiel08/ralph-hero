# Project V2 fields + default views

> Consulted by `/ralph:setup` default mode Step 4 (custom fields) and Step 5 (views).

## Required custom fields

`setup_project` creates three single-select fields with the canonical option set:

| Field | Options | Notes |
|---|---|---|
| **Workflow State** | Backlog, Research Needed, Research in Progress, Ready for Plan, Plan in Progress, Plan in Review, In Progress, In Review, Done, Human Needed, Canceled | 11 states; drives every Ralph verb |
| **Priority** | P0 (Critical), P1 (High), P2 (Medium), P3 (Low) | 4 options; used by `next_actions` ranking |
| **Estimate** | XS(1), S(2), M(3), L(4), XL(5) | 5 options; split-gate uses M/L/XL to trigger decomposition |

The tool seeds each field with the right colors. If colors drift later, update via `gh api graphql` (`updateProjectV2FieldOptionValue` mutation) or the GitHub UI.

## Resume / extend semantics

When called with a project number that already exists:

- `health_check` with `includeFields: true` first to confirm access.
- `setup_project` runs in extend mode — it adds any missing fields, never destroys existing ones.
- If a field exists but with mismatched options (e.g., someone added/removed states), report the diff and stop. Do not silently mutate user configuration.

## Default views (created manually)

**GitHub's GraphQL API does not support creating views programmatically.** Print these step-by-step instructions for the user to follow in the GitHub Projects UI:

### Ralph Table

1. **New view** → Table
2. Name: `Ralph Table`
3. Group by → **Priority**
4. Kebab (⋯) → enable **Sub-issues**
5. Filter: `-has:parent-issue`
6. Save

### Ralph Kanban

1. **New view** → Board
2. Name: `Ralph Kanban`
3. Column field → **Workflow State**
4. Filter: `-workflow-state:Canceled,Done,"Research in Progress","Plan in Progress"`
   (Plan in Review stays VISIBLE — under decision-gated approval (GH-1544) a
   held plan waits there with a `## Decision Request` comment for the human;
   filtering it out would hide the pipeline's primary decision surface.)
5. Save

## Result

Two complementary views:
- **Ralph Table** — priority-grouped hierarchy of top-level issues with expandable sub-issues.
- **Ralph Kanban** — board with only the actionable workflow columns (Backlog, Research Needed, Ready for Plan, Plan in Review, In Progress, In Review, Human Needed). Plan in Review is included so decision-held plans (unanswered `## Decision Request`) surface next to Human Needed.
