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
} = process.env;

if (!ROUTING_PAT) {
  console.error('::error::ROUTING_PAT is not set. Cannot write to Projects V2.');
  process.exit(1);
}

const graphqlWithAuth = graphql.defaults({
  headers: { authorization: `token ${ROUTING_PAT}` },
});

// ---------------------------------------------------------------------------
// 2. Config loader (stub — TODO: replace with import from #168 config loader)
// ---------------------------------------------------------------------------

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) return { rules: [] };
  const raw = fs.readFileSync(configPath, 'utf-8');
  return yaml.parse(raw) ?? { rules: [] };
}

// ---------------------------------------------------------------------------
// 3. Rule evaluator (stub — TODO: replace with import from #167 matching engine)
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
// 4. GraphQL helpers
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

  await gql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId: field.id, optionId: option.id },
  );
}

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------

async function main() {
  // Load routing config
  const config = loadConfig(RALPH_ROUTING_CONFIG);
  if (!config.rules || !config.rules.length) {
    console.log('No routing rules configured. Skipping.');
    return;
  }

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

  // Evaluate rules
  const matchedRules = evaluateRules(config.rules, issueContext);
  if (!matchedRules.length) {
    console.log(`No routing rules matched for #${itemNumber}.`);
    return;
  }

  // Fetch issue/PR node ID
  const contentId = await fetchContentNodeId(
    graphqlWithAuth, GH_OWNER, GH_REPO, itemNumber, EVENT_NAME,
  );

  // For each matched rule: add to project + set fields
  for (const rule of matchedRules) {
    const projectNumber = rule.action.projectNumber;
    const projectOwner = rule.action.projectOwner || GH_OWNER;

    console.log(`Routing #${itemNumber} to project #${projectNumber}...`);

    // Resolve project ID and field IDs
    const { projectId, fields } = await fetchProjectMeta(
      graphqlWithAuth, projectOwner, projectNumber,
    );

    // Add item to project (idempotent — re-adding returns existing item)
    const projectItemId = await addToProject(graphqlWithAuth, projectId, contentId);

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
}

main().catch(err => {
  console.error('::error::Routing failed:', err.message);
  process.exit(1);
});
