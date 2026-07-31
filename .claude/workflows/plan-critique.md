# plan-critique — adversarial frontier critique of a draft plan

Optional equipment for /ralph:work; the frontier bookend for feature/epic planning. args: { planPath: string }

```js
export const meta = {
  name: 'plan-critique',
  description: 'Two adversarial critics try to break a draft plan; verdict + required fixes',
  phases: [{ title: 'Critique' }],
}
const VERDICT = {
  type: 'object',
  properties: {
    holes: { type: 'string', description: 'Concrete failure scenarios this plan permits, worst first' },
    verdict: { type: 'string', enum: ['sound', 'needs-fixes'] },
  },
  required: ['holes', 'verdict'],
}
phase('Critique')
const lenses = [
  'correctness: what breaks, races, or corrupts state if this plan is followed exactly',
  'operability: day-2 reality — migration, rollback, debugging when a step half-lands',
]
const results = await parallel(lenses.map((l, i) => () =>
  agent(`Read ${args && args.planPath} fully, then attack it through this lens: ${l}. ` +
    `Try to REFUTE the plan's soundness with concrete scenarios; do not pad with praise.`,
    { label: `critic-${i}`, model: 'fable', effort: 'high', schema: VERDICT })
))
return results.filter(Boolean)
```
