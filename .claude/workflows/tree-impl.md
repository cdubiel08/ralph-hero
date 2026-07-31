# tree-impl — implement a sub-issue tree, worktree per child

Optional equipment for /ralph:work on decomposed units. args: { children: number[], planPath?: string }

```js
export const meta = {
  name: 'tree-impl',
  description: 'One sonnet worker per child issue, each in its own git worktree',
  phases: [{ title: 'Implement' }],
}
const RESULT = {
  type: 'object',
  properties: {
    issue: { type: 'number' },
    outcome: { type: 'string', enum: ['review', 'blocked', 'released'] },
    detail: { type: 'string' },
  },
  required: ['issue', 'outcome', 'detail'],
}
phase('Implement')
const results = await parallel(((args && args.children) || []).map((n) => () =>
  agent(
    `Drive issue #${n} to a mergeable PR. Claim it first (ralph/scripts/board claim ${n}); ` +
    `work ONLY in a fresh worktree (git worktree add .claude/worktrees/GH-${n} origin/main); ` +
    `branch feature/GH-${n}; commits reference GH-${n}. ` +
    (args && args.planPath ? `The plan at ${args.planPath} governs scope. ` : '') +
    `Follow the /ralph:work contract: board truthful, findings recorded, gates run not predicted. ` +
    `Blocked → board move ${n} human-needed --why "<decision needed>" and report blocked.`,
    { label: `GH-${n}`, isolation: 'worktree', schema: RESULT })
))
return results.filter(Boolean)
```
