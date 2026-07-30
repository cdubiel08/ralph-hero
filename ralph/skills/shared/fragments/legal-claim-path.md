## Legal claim path

Shared pre-lock procedure for claiming the `Plan in Progress` lock
(`command: "plan"`, semantic intent `__LOCK__` → `Plan in Progress`) on an
issue whose current workflow state has not already been checked against the
server's transition table (`workflow-states.ts` `ALLOWED_TRANSITIONS`,
GH-1615). Consult this fragment instead of writing `__LOCK__` directly
whenever the calling flow has no prior state precondition on the issue —
`save_issue` validates transition legality from the issue's LIVE current
state, and `Backlog`/`Plan in Review`/etc. do not transition directly to
`Plan in Progress`.

1. Read the issue's current workflow state (`get_issue` — reuse a fetch
   already made this session where possible).
2. **Already `Plan in Progress`** — idempotent re-claim; proceed directly to
   the work that follows, no further `save_issue` call needed here.
3. **`Ready for Plan`** (the lock's legal direct predecessor) — claim
   directly: `save_issue(workflowState: "__LOCK__", command: "plan")`.
4. **`Backlog`, `Research Needed`, `Plan in Review`, or `Human Needed`**
   (earlier queue states, or the post-NEEDS_ITERATION return state) — first
   `save_issue(workflowState: "Ready for Plan")` (command-less; legal from
   all four), THEN `save_issue(workflowState: "__LOCK__", command: "plan")`.
5. **`In Progress`, `In Review`, `Done`, or `Canceled`** — there is no legal
   claim path. STOP and report it: planning an issue that is already being
   implemented, already shipped, or already closed is a real mistake, not a
   gap in the transition table that a detour or `force` should paper over.

Any `save_issue` call above that still comes back as a `toolError` (a race
with another claimant, for example) surfaces the server's refusal text
verbatim — it already names the legal next states from the issue's actual
current state, so there is nothing further to compute here.
