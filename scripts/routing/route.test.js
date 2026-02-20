#!/usr/bin/env node
'use strict';

const { describe, it, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  withRetry,
  hasExistingAuditComment,
  addAuditComment,
  handleNoRulesMatch,
  writeStepSummary,
} = require('./route.js');

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe('withRetry', () => {
  it('succeeds on first attempt', async () => {
    const result = await withRetry(() => Promise.resolve('ok'));
    assert.equal(result, 'ok');
  });

  it('retries on 429 and succeeds', async () => {
    let attempt = 0;
    const result = await withRetry(() => {
      attempt++;
      if (attempt === 1) {
        const err = new Error('rate limited');
        err.status = 429;
        throw err;
      }
      return Promise.resolve('recovered');
    }, 3, 1); // 1ms base delay for fast tests
    assert.equal(result, 'recovered');
    assert.equal(attempt, 2);
  });

  it('retries on 5xx and succeeds', async () => {
    let attempt = 0;
    const result = await withRetry(() => {
      attempt++;
      if (attempt === 1) {
        const err = new Error('server error');
        err.status = 503;
        throw err;
      }
      return Promise.resolve('recovered');
    }, 3, 1);
    assert.equal(result, 'recovered');
    assert.equal(attempt, 2);
  });

  it('throws after maxRetries exhausted', async () => {
    let attempt = 0;
    await assert.rejects(
      () => withRetry(() => {
        attempt++;
        const err = new Error('always fails');
        err.status = 429;
        throw err;
      }, 2, 1),
      { message: 'always fails' },
    );
    assert.equal(attempt, 3); // initial + 2 retries
  });

  it('does not retry on 4xx non-transient errors', async () => {
    let attempt = 0;
    await assert.rejects(
      () => withRetry(() => {
        attempt++;
        const err = new Error('not found');
        err.status = 404;
        throw err;
      }, 3, 1),
      { message: 'not found' },
    );
    assert.equal(attempt, 1);
  });

  it('does not retry on non-HTTP errors', async () => {
    let attempt = 0;
    await assert.rejects(
      () => withRetry(() => {
        attempt++;
        throw new Error('network failure');
      }, 3, 1),
      { message: 'network failure' },
    );
    assert.equal(attempt, 1);
  });
});

// ---------------------------------------------------------------------------
// hasExistingAuditComment
// ---------------------------------------------------------------------------

describe('hasExistingAuditComment', () => {
  it('returns true when audit comment exists', async () => {
    const mockGql = async () => ({
      repository: {
        item: {
          comments: {
            nodes: [
              { body: 'some other comment' },
              { body: '<!-- routing-audit -->\n**Routing applied**...' },
            ],
          },
        },
      },
    });
    const result = await hasExistingAuditComment(mockGql, 'owner', 'repo', 1, 'issues');
    assert.equal(result, true);
  });

  it('returns false when no audit comment present', async () => {
    const mockGql = async () => ({
      repository: {
        item: {
          comments: {
            nodes: [
              { body: 'just a regular comment' },
            ],
          },
        },
      },
    });
    const result = await hasExistingAuditComment(mockGql, 'owner', 'repo', 1, 'issues');
    assert.equal(result, false);
  });

  it('returns false when no comments exist', async () => {
    const mockGql = async () => ({
      repository: {
        item: {
          comments: { nodes: [] },
        },
      },
    });
    const result = await hasExistingAuditComment(mockGql, 'owner', 'repo', 1, 'issues');
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// addAuditComment
// ---------------------------------------------------------------------------

describe('addAuditComment', () => {
  it('generates correct comment body with marker', async () => {
    let capturedBody = '';
    const mockGql = async (_query, vars) => {
      capturedBody = vars.body;
      return { addComment: { commentEdge: { node: { id: '1' } } } };
    };
    const rules = [
      { action: { projectNumber: 3, workflowState: 'Backlog' } },
    ];
    await addAuditComment(mockGql, 'node-id', rules);
    assert.ok(capturedBody.startsWith('<!-- routing-audit -->'));
    assert.ok(capturedBody.includes('Project #3'));
    assert.ok(capturedBody.includes('Workflow State: Backlog'));
  });

  it('includes all set fields in comment', async () => {
    let capturedBody = '';
    const mockGql = async (_query, vars) => {
      capturedBody = vars.body;
      return { addComment: { commentEdge: { node: { id: '1' } } } };
    };
    const rules = [
      { action: { projectNumber: 5, workflowState: 'Todo', priority: 'P1', estimate: 'XS' } },
    ];
    await addAuditComment(mockGql, 'node-id', rules);
    assert.ok(capturedBody.includes('Workflow State: Todo'));
    assert.ok(capturedBody.includes('Priority: P1'));
    assert.ok(capturedBody.includes('Estimate: XS'));
  });
});

// ---------------------------------------------------------------------------
// handleNoRulesMatch
// ---------------------------------------------------------------------------

describe('handleNoRulesMatch', () => {
  const originalEnv = process.env.ROUTING_DEFAULT_PROJECT;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ROUTING_DEFAULT_PROJECT;
    } else {
      process.env.ROUTING_DEFAULT_PROJECT = originalEnv;
    }
  });

  it('skips when ROUTING_DEFAULT_PROJECT is not set', async () => {
    delete process.env.ROUTING_DEFAULT_PROJECT;
    let called = false;
    const mockGql = async () => { called = true; };
    await handleNoRulesMatch(mockGql, 'content-id', { number: 1 });
    assert.equal(called, false);
  });

  it('skips when ROUTING_DEFAULT_PROJECT is invalid', async () => {
    process.env.ROUTING_DEFAULT_PROJECT = 'not-a-number';
    let called = false;
    const mockGql = async () => { called = true; };
    await handleNoRulesMatch(mockGql, 'content-id', { number: 1 });
    assert.equal(called, false);
  });
});

// ---------------------------------------------------------------------------
// writeStepSummary
// ---------------------------------------------------------------------------

describe('writeStepSummary', () => {
  const originalSummary = process.env.GITHUB_STEP_SUMMARY;

  afterEach(() => {
    if (originalSummary === undefined) {
      delete process.env.GITHUB_STEP_SUMMARY;
    } else {
      process.env.GITHUB_STEP_SUMMARY = originalSummary;
    }
  });

  it('writes markdown to GITHUB_STEP_SUMMARY', () => {
    const tmpFile = '/tmp/test-step-summary-' + Date.now() + '.md';
    process.env.GITHUB_STEP_SUMMARY = tmpFile;

    const rules = [
      { action: { projectNumber: 3, workflowState: 'Backlog' } },
    ];
    writeStepSummary(42, rules);

    const content = fs.readFileSync(tmpFile, 'utf-8');
    assert.ok(content.includes('## Routing Results for #42'));
    assert.ok(content.includes('Routed to project #3'));
    assert.ok(content.includes('Workflow State: Backlog'));

    fs.unlinkSync(tmpFile);
  });

  it('writes fallback message when no rules matched', () => {
    const tmpFile = '/tmp/test-step-summary-empty-' + Date.now() + '.md';
    process.env.GITHUB_STEP_SUMMARY = tmpFile;

    writeStepSummary(42, []);

    const content = fs.readFileSync(tmpFile, 'utf-8');
    assert.ok(content.includes('No rules matched.'));

    fs.unlinkSync(tmpFile);
  });
});
