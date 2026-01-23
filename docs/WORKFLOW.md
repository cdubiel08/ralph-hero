# Ralph Hero Workflow Guide

Comprehensive guide to how Ralph Hero processes tickets through the development lifecycle.

## Overview

Ralph Hero implements an autonomous development workflow with four main phases:

```
Backlog → Triage → Research → Planning → Implementation → PR
```

Each phase is handled by a dedicated command that processes one ticket (or ticket group) at a time.

## Ticket Lifecycle

### State Flow Diagram

```
                    ┌─────────────┐
                    │   Backlog   │
                    └──────┬──────┘
                           │ /ralph:triage
                           ▼
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
    ┌─────────┐     ┌─────────────┐    ┌─────────┐
    │  Done   │     │  Research   │    │  Human  │
    │(closed) │     │   Needed    │    │ Needed  │
    └─────────┘     └──────┬──────┘    └─────────┘
                           │ /ralph:research
                           ▼
                    ┌─────────────┐
                    │ Research in │
                    │  Progress   │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  Ready for  │
                    │    Plan     │
                    └──────┬──────┘
                           │ /ralph:plan
                           ▼
                    ┌─────────────┐
                    │   Plan in   │
                    │  Progress   │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   Plan in   │
                    │   Review    │
                    └──────┬──────┘
                           │ Human approval
                           ▼
                    ┌─────────────┐
                    │    Todo     │
                    └──────┬──────┘
                           │ /ralph:impl
                           ▼
                    ┌─────────────┐
                    │ In Progress │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  In Review  │◄─── PR Created
                    └──────┬──────┘
                           │ Human merge
                           ▼
                    ┌─────────────┐
                    │    Done     │
                    └─────────────┘
```

## Commands

### /ralph:triage

**Purpose**: Assess backlog tickets for validity and route them appropriately.

**Input**: Tickets in "Backlog" state without `ralph-triage` label

**Actions**:
- **CLOSE**: Feature exists, duplicate, or obsolete
- **SPLIT**: Ticket too large, creates sub-tickets
- **RE-ESTIMATE**: Adjust ticket size estimate
- **RESEARCH**: Valid but needs investigation → "Research Needed"
- **KEEP**: Valid as-is, stays in Backlog

**Output**: Ticket labeled `ralph-triage`, routed to appropriate state

**Usage**:
```bash
/ralph:triage                    # Process oldest untriaged ticket
/ralph:triage ENG-123           # Triage specific ticket
```

### /ralph:research

**Purpose**: Investigate tickets to understand requirements and technical approach.

**Input**: XS/Small tickets in "Research Needed" state

**Actions**:
1. Spawn codebase exploration agents
2. Analyze existing patterns and dependencies
3. Create research document
4. Push document to git
5. Link document to ticket

**Output**: Research document in configured `researchDir`, ticket moved to "Ready for Plan"

**Usage**:
```bash
/ralph:research                  # Process highest-priority research ticket
/ralph:research ENG-123         # Research specific ticket
```

### /ralph:plan

**Purpose**: Create detailed implementation plans from research findings.

**Input**: XS/Small tickets in "Ready for Plan" state

**Actions**:
1. Gather context from ticket and research document
2. Analyze codebase for patterns
3. Create phased implementation plan
4. Push plan to git
5. Link plan to ticket

**Output**: Implementation plan in configured `plansDir`, ticket moved to "Plan in Review"

**Usage**:
```bash
/ralph:plan                      # Plan highest-priority ready ticket
/ralph:plan ENG-123             # Plan specific ticket
```

### /ralph:impl

**Purpose**: Execute implementation plans one phase at a time.

**Input**: XS/Small tickets in "Todo" or "In Progress" state with linked plan

**Actions**:
1. Create or reuse git worktree
2. Implement ONE phase from plan
3. Run automated verification
4. Commit and push changes
5. Create PR when all phases complete

**Output**: Code changes, PR created on final phase

**Usage**:
```bash
/ralph:impl                      # Implement next phase of highest-priority ticket
/ralph:impl ENG-123             # Continue implementing specific ticket
```

### /ralph:linear

**Purpose**: Manage Linear tickets and documents.

**Usage**:
```bash
/ralph:linear create <doc>       # Create ticket from document
/ralph:linear update <ticket>    # Update ticket from linked doc
/ralph:linear link <ticket> <doc> # Link ticket to document
/ralph:linear comment <ticket> <msg> # Add comment
/ralph:linear status             # Show linked documents
/ralph:linear fetch <ticket>     # Download ticket to local file
/ralph:linear pick <status>      # Pick ticket by status
```

### /ralph:setup

**Purpose**: Configure Ralph for your project.

**Usage**:
```bash
/ralph:setup                     # Run setup wizard
/ralph:setup --reconfigure       # Reconfigure existing setup
```

## Ticket Groups

Related tickets can be grouped for atomic implementation:

### How Groups Form

1. **Same parent ticket**: Sub-issues of a parent are grouped
2. **Blocking relationships**: Tickets connected via `blocks`/`blockedBy` are grouped

### Group Processing

- **Research**: Each ticket researched individually, but group progress tracked
- **Planning**: Single plan created covering all group tickets (each as a phase)
- **Implementation**: All phases in one PR, one git worktree

### Group States

A group is only processed when:
- All tickets in same state (e.g., all "Ready for Plan")
- No external blockers (only within-group blocking allowed)
- All tickets are XS/Small

## Constraints

### Size Limits

Ralph only processes XS/Small tickets:
- **XS**: Estimate value 1
- **Small**: Estimate value 2

Larger tickets must be split before processing.

### Time Limits

Default timeouts per command (configurable via environment):
- Triage: 10 minutes
- Research: 15 minutes
- Planning: 15 minutes
- Implementation: 15 minutes per phase

### Safety Rails

- **No merge**: PRs created but not merged (human review required)
- **Worktree isolation**: Changes don't affect main branch
- **Human Needed state**: Escalation path for uncertainty
- **Max iterations**: Loop stops after configurable iterations

## Escalation

When Ralph encounters uncertainty, it escalates:

1. Moves ticket to "Human Needed" state
2. Adds comment with @mention explaining the issue
3. Stops processing

### Escalation Triggers

- Ambiguous requirements
- Multiple valid approaches
- Scope larger than estimated
- External dependencies
- Conflicting information
- Tests failing unexpectedly

## Running the Loop

### Full Autonomous Loop

```bash
./scripts/ralph-loop.sh
```

This runs all phases in sequence, repeating until queues are empty or max iterations reached.

### Phase-Specific Loops

```bash
./scripts/ralph-loop.sh --triage-only     # Only triage
./scripts/ralph-loop.sh --research-only   # Only research
./scripts/ralph-loop.sh --plan-only       # Only planning
./scripts/ralph-loop.sh --impl-only       # Only implementation
```

### Configuration

```bash
MAX_ITERATIONS=5 TIMEOUT=20m ./scripts/ralph-loop.sh
```

## Documents

### Research Documents

Location: `[researchDir]/YYYY-MM-DD-ENG-XXX-description.md`

Contents:
- Problem statement
- Current state analysis
- Key discoveries with file:line references
- Potential approaches
- Risks and considerations
- Recommended next steps

### Implementation Plans

Location: `[plansDir]/YYYY-MM-DD-ENG-XXX-description.md`

Contents:
- Overview
- Current state analysis
- Desired end state
- What we're NOT doing
- Implementation approach
- Phase details with specific changes
- Success criteria (automated + manual)
- Testing strategy

### Ticket Snapshots

Location: `[ticketsDir]/ENG-XXX.md`

Local cache of ticket details for offline reference.

## Best Practices

### Ticket Sizing

- XS: < 1 hour of work
- Small: 1-4 hours of work
- If larger, split before triaging

### Clear Requirements

- Specific, testable acceptance criteria
- Referenced code locations when possible
- Links to relevant documentation

### Plan Approval

Review plans before moving to "Todo":
- Verify approach is correct
- Check success criteria are complete
- Ensure scope is appropriate

### PR Review

Human review is essential:
- Verify code quality
- Check for edge cases
- Ensure tests are adequate
- Validate against plan
