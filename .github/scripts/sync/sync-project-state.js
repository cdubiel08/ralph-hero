#!/usr/bin/env node
'use strict';

const { graphql } = require('@octokit/graphql');

// ---------------------------------------------------------------------------
// 1. Read and validate environment variables
// ---------------------------------------------------------------------------

const {
  SYNC_PAT,
  CONTENT_NODE_ID,
  WORKFLOW_STATE,
  ORIGINATING_PROJECT_NUMBER = '0',
  SYNC_PROJECT_FILTER,
} = process.env;

if (!SYNC_PAT) {
  console.error('::error::SYNC_PAT (ROUTING_PAT secret) is not set.');
  process.exit(1);
}
if (!CONTENT_NODE_ID) {
  console.error('::error::CONTENT_NODE_ID is required.');
  process.exit(1);
}
if (!WORKFLOW_STATE) {
  console.error('::error::WORKFLOW_STATE is required.');
  process.exit(1);
}

const graphqlWithAuth = graphql.defaults({
  headers: { authorization: `token ${SYNC_PAT}` },
});

const originatingProjectNumber = parseInt(ORIGINATING_PROJECT_NUMBER, 10) || 0;
const projectFilter = SYNC_PROJECT_FILTER
  ? SYNC_PROJECT_FILTER.split(',').map(n => parseInt(n.trim(), 10)).filter(n => n > 0)
  : null;

// ---------------------------------------------------------------------------
// 2. GraphQL helpers
// ---------------------------------------------------------------------------

/**
 * Fetch field metadata for a specific project.
 * Returns SingleSelectField entries with id, name, and options.
 */
async function fetchProjectFieldMeta(gql, projectId) {
  const result = await gql(
    `query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
            }
          }
        }
      }
    }`,
    { projectId },
  );
  return (result.node && result.node.fields && result.node.fields.nodes || [])
    .filter(f => f.id && f.options);
}

// ---------------------------------------------------------------------------
// 3. Audit trail helpers (#199)
// ---------------------------------------------------------------------------

const SYNC_AUDIT_MARKER = '<!-- cross-project-sync-audit -->';

/**
 * Build the audit comment body for a cross-project sync operation.
 */
function buildSyncAuditBody(workflowState, syncedProjects) {
  const lines = syncedProjects.map(
    p => `- Project #${p.projectNumber} (${p.previousState || 'none'} -> ${workflowState})`
  );
  return (
    `${SYNC_AUDIT_MARKER}\n` +
    `**Cross-project sync** \u2014 Workflow State synced to **${workflowState}** across ${syncedProjects.length} project(s):\n` +
    lines.join('\n')
  );
}

/**
 * Check if an issue already has a sync audit comment.
 */
async function hasExistingSyncAuditComment(gql, contentNodeId) {
  const result = await gql(
    `query($issueId: ID!) {
      node(id: $issueId) {
        ... on Issue {
          comments(last: 20) { nodes { body } }
        }
      }
    }`,
    { issueId: contentNodeId },
  );
  const comments = (result.node && result.node.comments && result.node.comments.nodes) || [];
  return comments.some(c => c.body.startsWith(SYNC_AUDIT_MARKER));
}

// ---------------------------------------------------------------------------
// 4. Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Syncing Workflow State "${WORKFLOW_STATE}" for node ${CONTENT_NODE_ID}`);
  if (originatingProjectNumber > 0) {
    console.log(`Skipping originating project #${originatingProjectNumber} (loop prevention)`);
  }
  if (projectFilter) {
    console.log(`Project filter active: ${projectFilter.join(', ')}`);
  }

  // Discover all project memberships with current Workflow State
  const projectItemsResult = await graphqlWithAuth(
    `query($nodeId: ID!) {
      node(id: $nodeId) {
        ... on Issue {
          projectItems(first: 20) {
            nodes {
              id
              project { id number }
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    __typename
                    name
                    field { ... on ProjectV2FieldCommon { name } }
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { nodeId: CONTENT_NODE_ID },
  );

  const projectItems =
    (projectItemsResult.node &&
      projectItemsResult.node.projectItems &&
      projectItemsResult.node.projectItems.nodes) || [];

  if (!projectItems.length) {
    console.log('Issue is not a member of any GitHub Project. Nothing to sync.');
    return;
  }

  let syncedCount = 0;
  let skippedCount = 0;
  const syncedProjects = [];

  for (const item of projectItems) {
    const projectId = item.project.id;
    const projectNumber = item.project.number;

    // Loop prevention layer 2: skip originating project
    if (projectNumber === originatingProjectNumber) {
      console.log(`  Project #${projectNumber}: skipped (originating project)`);
      skippedCount++;
      continue;
    }

    // Project filter: skip projects not in the allow-list
    if (projectFilter && !projectFilter.includes(projectNumber)) {
      console.log(`  Project #${projectNumber}: skipped (not in SYNC_PROJECT_FILTER)`);
      skippedCount++;
      continue;
    }

    // Extract current Workflow State from fieldValues
    const currentState = (item.fieldValues.nodes || []).find(
      fv => fv.__typename === 'ProjectV2ItemFieldSingleSelectValue' &&
            fv.field && fv.field.name === 'Workflow State'
    );
    const currentStateName = currentState ? currentState.name : null;

    // Idempotency: skip if already at target state
    if (currentStateName === WORKFLOW_STATE) {
      console.log(`  Project #${projectNumber}: skipped (already at "${WORKFLOW_STATE}")`);
      skippedCount++;
      continue;
    }

    // Fetch field metadata for this project
    const fieldMeta = await fetchProjectFieldMeta(graphqlWithAuth, projectId);
    const wfField = fieldMeta.find(f => f.name === 'Workflow State');

    if (!wfField) {
      console.log(`  Project #${projectNumber}: skipped (no Workflow State field)`);
      skippedCount++;
      continue;
    }

    const targetOption = wfField.options.find(o => o.name === WORKFLOW_STATE);
    if (!targetOption) {
      const validOptions = wfField.options.map(o => o.name).join(', ');
      console.log(`  Project #${projectNumber}: skipped ("${WORKFLOW_STATE}" not found. Valid: ${validOptions})`);
      skippedCount++;
      continue;
    }

    // Apply the update
    await graphqlWithAuth(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { singleSelectOptionId: $optionId }
        }) {
          projectV2Item { id }
        }
      }`,
      {
        projectId,
        itemId: item.id,
        fieldId: wfField.id,
        optionId: targetOption.id,
      },
    );

    console.log(`  Project #${projectNumber}: synced ("${currentStateName || 'none'}" -> "${WORKFLOW_STATE}")`);
    syncedProjects.push({ projectNumber, previousState: currentStateName });
    syncedCount++;
  }

  // Audit trail: add comment documenting the sync (#199)
  if (syncedCount > 0) {
    const alreadyAudited = await hasExistingSyncAuditComment(graphqlWithAuth, CONTENT_NODE_ID);
    if (!alreadyAudited) {
      const body = buildSyncAuditBody(WORKFLOW_STATE, syncedProjects);
      await graphqlWithAuth(
        `mutation($subjectId: ID!, $body: String!) {
          addComment(input: { subjectId: $subjectId, body: $body }) {
            commentEdge { node { id } }
          }
        }`,
        { subjectId: CONTENT_NODE_ID, body },
      );
      console.log('Audit comment added.');
    } else {
      console.log('Audit comment already exists. Skipping.');
    }
  }

  console.log(`\nSync complete. Synced: ${syncedCount}, Skipped: ${skippedCount}`);
}

main().catch(err => {
  console.error(`::error::Sync failed: ${err.message}`);
  process.exit(1);
});
