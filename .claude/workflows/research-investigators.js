// GH-1474 prototype — ralph research Step 3 investigator fan-out as a Dynamic Workflow.
// Dispatched by ralph/skills/research/SKILL.md Step 3 ONLY when RALPH_USE_WORKFLOWS=true
// (default-off; the inline Agent() dispatch is the untouched default path).
export const meta = {
  name: 'research-investigators',
  description: 'ralph research Step 3: parallel investigator fan-out via ralph agentType workers (GH-1474 prototype)',
  whenToUse: 'Only via the RALPH_USE_WORKFLOWS=true branch of /ralph:research Step 3. args: { question, repoDirs?, includeWeb? }',
  phases: [{ title: 'Investigate' }],
}

// args may arrive as a JSON-encoded string depending on the dispatch surface — normalize.
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch (e) {
    input = { question: input }
  }
}
const question = input && input.question
if (!question) throw new Error('research-investigators requires args.question (the research question)')

const repoNote =
  input && Array.isArray(input.repoDirs) && input.repoDirs.length
    ? `\nAdditional repo directories in scope: ${input.repoDirs.join(', ')}.`
    : ''
const documentarian =
  'You are a documentarian: report what IS, not what SHOULD BE. No improvement suggestions, no root-cause speculation.'

phase('Investigate')

const thunks = [
  () =>
    agent(
      `Research question: ${question}${repoNote}\n\nFind WHERE the relevant code lives: files, directories, and components, grouped by purpose, with paths. ${documentarian}`,
      { agentType: 'ralph:codebase-locator', label: 'codebase-locator' },
    ),
  () =>
    agent(
      `Research question: ${question}${repoNote}\n\nExplain HOW the relevant components work: trace implementation, data flow, and call paths with precise file:line references. ${documentarian}`,
      { agentType: 'ralph:codebase-analyzer', label: 'codebase-analyzer' },
    ),
  () =>
    agent(
      `Research question: ${question}${repoNote}\n\nFind existing patterns or prior implementations to model after, with concrete snippets and file:line references. ${documentarian}`,
      { agentType: 'ralph:codebase-pattern-finder', label: 'codebase-pattern-finder' },
    ),
  // thoughts-analyzer depends on thoughts-locator's hits, so the pair runs as a chain
  // inside one parallel slot rather than as a barrier between all investigators.
  () =>
    agent(
      `Research question: ${question}\n\nFind prior context in the thoughts/ corpus: research docs, plans, reviews, ideas. Return the most relevant document paths with one-line hooks. ${documentarian}`,
      { agentType: 'ralph:thoughts-locator', label: 'thoughts-locator' },
    ).then((hits) =>
      hits
        ? agent(
            `Research question: ${question}\n\nA locator pass surfaced these thoughts/ documents:\n\n${hits}\n\nRead the top 3-5 and distill key decisions, constraints, and actionable insights relevant to the question, citing each document path. ${documentarian}`,
            { agentType: 'ralph:thoughts-analyzer', label: 'thoughts-analyzer' },
          ).then((analysis) => ({ hits, analysis }))
        : null,
    ),
]

if (input && input.includeWeb === true) {
  thunks.push(() =>
    agent(
      `Research question: ${question}\n\nResearch the public web for accurate, current information bearing on this question. Cite sources with URLs. ${documentarian}`,
      { agentType: 'ralph:web-search-researcher', label: 'web-search-researcher' },
    ),
  )
}

const results = await parallel(thunks)
const [codebaseLocator, codebaseAnalyzer, patternFinder, thoughts] = results
const webResearch = input && input.includeWeb === true ? results[4] : null

log('investigator fan-out complete')

return {
  question,
  findings: { codebaseLocator, codebaseAnalyzer, patternFinder, thoughts, webResearch },
}
