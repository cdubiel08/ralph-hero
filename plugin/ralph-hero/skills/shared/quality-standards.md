# Quality Standards

Canonical quality criteria referenced by ralph-plan, ralph-review, and ralph-research.

## Plan Quality Dimensions

Plans are evaluated on four dimensions (matching ralph-review AUTO critique):

1. **Completeness** — All phases defined with specific file changes and clear descriptions
2. **Feasibility** — Referenced files exist; patterns are valid and follow existing codebase conventions
3. **Clarity** — Success criteria are specific and testable (`- [ ] Automated:` / `- [ ] Manual:` format)
4. **Scope** — "What we're NOT doing" section is explicit and well-bounded

### Group-Specific Requirements

For multi-issue group plans, also verify:
- Phase dependencies are explicit (each phase states what it creates for the next)
- Integration testing section covers cross-phase interactions

### Plan Anti-Patterns

Avoid:
- Vague descriptions like "update the code"
- Missing or untestable success criteria
- Unbounded scope without explicit exclusions
- Ignoring existing patterns in the codebase
- For groups: unclear phase ordering or missing dependencies

## Research Quality Dimensions

Research documents are evaluated on:

1. **Depth** — Problem understood from user perspective with root cause analysis
2. **Feasibility** — Existing codebase patterns identified to leverage
3. **Risk** — Edge cases and failure modes identified
4. **Actionability** — Recommendations are concrete with file:line references

### Research Anti-Patterns

Avoid:
- Premature solutioning before understanding the problem
- Over-engineering suggestions beyond issue scope
- Ignoring existing patterns in the codebase
- Vague findings without concrete file references

## Review Anti-Patterns

When reviewing plans or research, avoid:
- Rubber-stamping without analysis
- Over-critiquing minor style issues
- Blocking on subjective preferences
- Creating critique without actionable feedback
