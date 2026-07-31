# research-panel — parallel investigators over one question

Optional equipment for /ralph:work. args: { question: string, angles?: string[] }

```js
export const meta = {
  name: 'research-panel',
  description: 'Fan N read-only investigators over one question, synthesize',
  phases: [{ title: 'Investigate' }],
}
const REPORT = { type: 'object', properties: { report: { type: 'string' } }, required: ['report'] }
phase('Investigate')
const angles = (args && args.angles) || [
  'where the relevant code lives (files, entry points, call paths)',
  'prior art in thoughts/ — decisions, plans, postmortems that touched this',
  'constraints and failure modes — tests, invariants, gotchas that bound a change',
]
const results = await parallel(angles.map((a, i) => () =>
  agent(`Question: ${args && args.question}\nYour angle: ${a}\nReturn dense findings with file:line evidence.`,
    { label: `angle-${i}`, agentType: 'ralph:investigator', schema: REPORT })
))
return results.filter(Boolean).map((r, i) => `## ${angles[i]}\n${r.report}`).join('\n\n')
```
