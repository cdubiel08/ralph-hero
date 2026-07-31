# adversarial-review — independent review before the merge attempt

Optional equipment for /ralph:work. Frontier on feature/epic units, sonnet on singles. args: { pr: number, frontier?: boolean }

```js
export const meta = {
  name: 'adversarial-review',
  description: 'Independent reviewers try to find real defects in a PR before merge',
  phases: [{ title: 'Review' }],
}
const FINDINGS = {
  type: 'object',
  properties: {
    defects: { type: 'string', description: 'Real defects with file:line and failure scenario; "none" if clean' },
    blocking: { type: 'boolean' },
  },
  required: ['defects', 'blocking'],
}
phase('Review')
const model = args && args.frontier ? 'fable' : undefined
const lenses = ['correctness and state-corruption', 'plan-vs-delivery: does the diff do what the issue/plan promised']
const results = await parallel(lenses.map((l, i) => () =>
  agent(`gh pr diff ${args && args.pr} and gh pr view ${args && args.pr}. Review through this lens: ${l}. ` +
    `Report only defects that survive your own attempt to refute them.`,
    { label: `review-${i}`, model, schema: FINDINGS })
))
return results.filter(Boolean)
```
