#!/usr/bin/env node
'use strict';

const { graphql } = require('@octokit/graphql');
const yaml = require('yaml');
const fs = require('fs');

// ---------------------------------------------------------------------------
// 1. Read environment variables (set by route-issues.yml workflow from #169)
// ---------------------------------------------------------------------------

const {
  ROUTING_PAT,
  GH_OWNER,
  GH_REPO,
  ITEM_NUMBER,
  ITEM_LABELS,           // JSON string: [{ name, color, ... }]
  EVENT_NAME,            // "issues" or "pull_request"
  RALPH_ROUTING_CONFIG = '.ralph-routing.yml',
  RALPH_PROJECT_NUMBER,  // Optional: default project number (from workflow_call input)
  RALPH_PROJECT_OWNER,   // Optional: default project owner (from workflow_call input)
} = process.env;

// Validate and initialize auth only when running as a script (not when imported for tests)
let graphqlWithAuth;
if (require.main === module) {
  if (!ROUTING_PAT) {
    console.error('::error::ROUTING_PAT is not set. Cannot write to Projects V2.');
    process.exit(1);
  }
  graphqlWithAuth = graphql.defaults({
    headers: { authorization: `token ${ROUTING_PAT}` },
  });
}

// ---------------------------------------------------------------------------
// 2. Retry helper (#173 — exponential backoff on transient errors)
// ---------------------------------------------------------------------------

async function withRetry(fn, maxRetries = 3, baseDelayMs = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status ?? err.response?.status;
      const isTransient = status === 429 || (status >= 500 && status < 600);
      if (!isTransient || attempt === maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`API error ${status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Config loader (stub — TODO: replace with import from #168 config loader)
// ---------------------------------------------------------------------------

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) return { rules: [] };
  const raw = fs.readFileSync(configPath, 'utf-8');
  return yaml.parse(raw) ?? { rules: [] };
}

// ---------------------------------------------------------------------------
// 4. Rule evaluator (stub — TODO: replace with import from #167 matching engine)
// ---------------------------------------------------------------------------

function evaluateRules(rules, issueContext) {
  return rules.filter(rule => {
    if (!rule.match) return false;
    if (rule.match.labels) {
      return rule.match.labels.some(l => issueContext.labels.includes(l));
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// 5. GraphQL helpers
// ---------------------------------------------------------------------------

async function fetchContentNodeId(gql, owner, repo, number, eventName) {
  const field = eventName === 'pull_request' ? 'pullRequest' : 'issue';
  const result = await gql(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        item: ${field}(number: $number) { id }
      }
    }`,
    { owner, repo, number },
  );
  if (!result.repository || !result.repository.item || !result.repository.item.id) {
    throw new Error(`#${number} not found in ${owner}/${repo}`);
  }
  return result.repository.item.id;
}

async function fetchProjectMeta(gql, owner, projectNumber) {
  // Try both user and organization owner types (same pattern as MCP server)
  for (const ownerType of ['user', 'organization']) {
    try {
      const result = await gql(
        `query($owner: String!, $number: Int!) {
          ${ownerType}(login: $owner) {
            projectV2(number: $number) {
              id
              fields(first: 20) {
                nodes {
                  ... on ProjectV2SingleSelectField {
                    id name
                    options { id name }
                  }
                }
              }
            }
          }
        }`,
        { owner, number: projectNumber },
      );
      const project = result[ownerType] && result[ownerType].projectV2;
      if (project) {
        const fields = {};
        for (const f of project.fields.nodes) {
          if (f.name) fields[f.name] = { id: f.id, options: f.options || [] };
        }
        return { projectId: project.id, fields };
      }
    } catch {
      // Try next owner type
    }
  }
  throw new Error(`Project #${projectNumber} not found for owner "${owner}"`);
}

async function addToProject(gql, projectId, contentId) {
  const result = await gql(
    `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }`,
    { projectId, contentId },
  );
  return result.addProjectV2ItemById.item.id;
}

async function setField(gql, projectId, itemId, fields, fieldName, optionName) {
  const field = fields[fieldName];
  if (!field) {
    console.warn(`Field "${fieldName}" not found in project — skipping`);
    return;
  }
  const option = field.options.find(o => o.name === optionName);
  if (!option) {
    console.warn(`Option "${optionName}" not valid for field "${fieldName}" — skipping`);
    return;
  }

  await withRetry(() => gql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId: field.id, optionId: option.id },
  ));
}

// ---------------------------------------------------------------------------
// 6. Audit trail and idempotency (#173)
// ---------------------------------------------------------------------------

async function hasExistingAuditComment(gql, owner, repo, number, eventName) {
  const field = eventName === 'pull_request' ? 'pullRequest' : 'issue';
  const result = await withRetry(() => gql(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        item: ${field}(number: $number) {
          comments(last: 20) { nodes { body } }
        }
      }
    }`,
    { owner, repo, number },
  ));
  const comments = result.repository?.item?.comments?.nodes ?? [];
  return comments.some(c => c.body.startsWith('<!-- routing-audit -->'));
}

async function addAuditComment(gql, contentId, matchedRules) {
  const lines = matchedRules.map(r => {
    const fields = [];
    if (r.action.workflowState) fields.push(`Workflow State: ${r.action.workflowState}`);
    if (r.action.priority) fields.push(`Priority: ${r.action.priority}`);
    if (r.action.estimate) fields.push(`Estimate: ${r.action.estimate}`);
    const fieldStr = fields.length ? ` | ${fields.join(' | ')}` : '';
    return `- Project #${r.action.projectNumber}${fieldStr}`;
  });
  const body = `<!-- routing-audit -->\n**Routing applied** by \`.ralph-routing.yml\`:\n${lines.join('\n')}`;

  await withRetry(() => gql(
    `mutation($subjectId: ID!, $body: String!) {
      addComment(input: { subjectId: $subjectId, body: $body }) {
        commentEdge { node { id } }
      }
    }`,
    { subjectId: contentId, body },
  ));
}

// ---------------------------------------------------------------------------
// 7. Fallback routing (#173)
// ---------------------------------------------------------------------------

async function handleNoRulesMatch(gql, contentId, context) {
  const defaultProjectNum = parseInt(process.env.ROUTING_DEFAULT_PROJECT ?? '', 10);
  if (!defaultProjectNum || isNaN(defaultProjectNum)) {
    console.log('No default project configured. Skipping fallback routing.');
    return;
  }
  const { projectId } = await fetchProjectMeta(gql, GH_OWNER, defaultProjectNum);
  await withRetry(() => addToProject(gql, projectId, contentId));
  console.log(`Fallback: routed #${context.number} to default project #${defaultProjectNum}`);
}

// ---------------------------------------------------------------------------
// 8. Actions step summary (#173)
// ---------------------------------------------------------------------------

function writeStepSummary(itemNumber, matchedRules) {
  const summary = matchedRules.map(r =>
    `- Routed to project #${r.action.projectNumber}` +
    (r.action.workflowState ? ` (Workflow State: ${r.action.workflowState})` : '') +
    (r.action.priority ? ` (Priority: ${r.action.priority})` : '')
  ).join('\n');

  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY || '/dev/null',
    `## Routing Results for #${itemNumber}\n${summary || 'No rules matched.'}\n`,
  );
}

// ---------------------------------------------------------------------------
// 9. Main
// ---------------------------------------------------------------------------

async function main() {
  // Load routing config
  const config = loadConfig(RALPH_ROUTING_CONFIG);

  // Build issue context from env
  const labels = JSON.parse(ITEM_LABELS || '[]').map(l => l.name);
  const itemNumber = parseInt(ITEM_NUMBER, 10);
  const issueContext = {
    number: itemNumber,
    labels,
    repo: GH_REPO,
    owner: GH_OWNER,
    eventName: EVENT_NAME,
  };

  // Evaluate rules (returns empty array if no rules configured)
  const matchedRules = config.rules?.length
    ? evaluateRules(config.rules, issueContext)
    : [];

  // Fetch content ID early — needed for both routing and fallback
  const contentId = await withRetry(() =>
    fetchContentNodeId(graphqlWithAuth, GH_OWNER, GH_REPO, itemNumber, EVENT_NAME),
  );

  // Idempotency: skip if already routed
  const alreadyRouted = await hasExistingAuditComment(
    graphqlWithAuth, GH_OWNER, GH_REPO, itemNumber, EVENT_NAME,
  );
  if (alreadyRouted) {
    console.log(`#${itemNumber} already has a routing audit comment. Skipping.`);
    return;
  }

  // Fallback when no rules match
  if (!matchedRules.length) {
    console.log(`No routing rules matched for #${itemNumber}.`);
    await handleNoRulesMatch(graphqlWithAuth, contentId, { number: itemNumber });
    return;
  }

  // For each matched rule: add to project + set fields
  for (const rule of matchedRules) {
    const projectNumber = rule.action.projectNumber
      || (RALPH_PROJECT_NUMBER ? parseInt(RALPH_PROJECT_NUMBER, 10) : null);
    if (!projectNumber) {
      console.warn(`Rule matched but no projectNumber specified and no RALPH_PROJECT_NUMBER default — skipping`);
      continue;
    }
    const projectOwner = rule.action.projectOwner || RALPH_PROJECT_OWNER || GH_OWNER;

    console.log(`Routing #${itemNumber} to project #${projectNumber}...`);

    // Resolve project ID and field IDs
    const { projectId, fields } = await withRetry(() =>
      fetchProjectMeta(graphqlWithAuth, projectOwner, projectNumber),
    );

    // Add item to project (idempotent — re-adding returns existing item)
    const projectItemId = await withRetry(() =>
      addToProject(graphqlWithAuth, projectId, contentId),
    );

    // Set field values from rule action
    if (rule.action.workflowState) {
      await setField(graphqlWithAuth, projectId, projectItemId, fields, 'Workflow State', rule.action.workflowState);
    }
    if (rule.action.priority) {
      await setField(graphqlWithAuth, projectId, projectItemId, fields, 'Priority', rule.action.priority);
    }
    if (rule.action.estimate) {
      await setField(graphqlWithAuth, projectId, projectItemId, fields, 'Estimate', rule.action.estimate);
    }

    console.log(`Routed #${itemNumber} to project #${projectNumber}`);
  }

  // Audit comment after all mutations succeed
  await addAuditComment(graphqlWithAuth, contentId, matchedRules);

  // Actions step summary
  writeStepSummary(itemNumber, matchedRules);
}

// ---------------------------------------------------------------------------
// Entry point — only run main() when executed directly (not imported)
// ---------------------------------------------------------------------------

if (require.main === module) {
  main().catch(err => {
    console.error('::error::Routing failed:', err.message);
    process.exit(1);
  });
}

// Export functions for testing (#173)
module.exports = {
  withRetry,
  hasExistingAuditComment,
  addAuditComment,
  handleNoRulesMatch,
  writeStepSummary,
};
