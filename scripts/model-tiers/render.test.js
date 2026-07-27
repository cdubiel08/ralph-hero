#!/usr/bin/env node
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  resolveTier,
  extractFrontmatterModel,
  extractDispatchLiterals,
  walkMarkdownFiles,
  runCheck,
  runWrite,
  printTierTable,
  loadConfig,
  parseArgs,
  buildExpectedFrontmatter,
  buildExpectedDispatchMultisets,
} = require('./render.js');

const REPO_ROOT = path.join(__dirname, '..', '..');

function baseConfig() {
  return {
    version: 1,
    defaultHarness: 'claude-code',
    harnesses: {
      'claude-code': {
        cheap: { skill: 'haiku', agent: 'haiku' },
        standard: { skill: 'sonnet', agent: 'sonnet' },
        capable: { skill: 'best', agent: 'opus' },
        frontier: { skill: 'fable', agent: 'fable' },
      },
      'claude-code-opus': {
        cheap: { skill: 'haiku', agent: 'haiku' },
        standard: { skill: 'sonnet', agent: 'sonnet' },
        capable: { skill: 'best', agent: 'opus' },
        frontier: { skill: 'opus', agent: 'opus' },
      },
    },
    sites: [],
    hardPins: [],
  };
}

function mkTmpTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tiers-test-'));
  fs.mkdirSync(path.join(root, 'ralph', 'skills', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ralph', 'agents'), { recursive: true });
  return root;
}

// ---------------------------------------------------------------------------
// resolveTier
// ---------------------------------------------------------------------------

describe('resolveTier', () => {
  it('resolves every tier x surface for the default harness', () => {
    const config = baseConfig();
    assert.equal(resolveTier(config, 'cheap', 'claude-code', 'skill'), 'haiku');
    assert.equal(resolveTier(config, 'capable', 'claude-code', 'skill'), 'best');
    assert.equal(resolveTier(config, 'capable', 'claude-code', 'agent'), 'opus');
    assert.equal(resolveTier(config, 'frontier', 'claude-code', 'agent'), 'fable');
  });

  it('resolves a second harness independently (claude-code-opus)', () => {
    const config = baseConfig();
    assert.equal(resolveTier(config, 'frontier', 'claude-code-opus', 'skill'), 'opus');
    assert.equal(resolveTier(config, 'frontier', 'claude-code-opus', 'agent'), 'opus');
    // capable is unchanged across harnesses.
    assert.equal(resolveTier(config, 'capable', 'claude-code-opus', 'agent'), 'opus');
  });

  it('throws on an unknown harness', () => {
    const config = baseConfig();
    assert.throws(() => resolveTier(config, 'standard', 'nonexistent', 'skill'), /Unknown harness/);
  });
});

// ---------------------------------------------------------------------------
// extractFrontmatterModel
// ---------------------------------------------------------------------------

describe('extractFrontmatterModel', () => {
  it('extracts the model: value from a frontmatter block', () => {
    const text = '---\nname: demo\nmodel: sonnet\ndescription: x\n---\n\nBody text.\n';
    assert.equal(extractFrontmatterModel(text), 'sonnet');
  });

  it('returns null when there is no frontmatter block', () => {
    assert.equal(extractFrontmatterModel('# Just a doc\n\nSome prose about model="opus".\n'), null);
  });

  it('returns null when the frontmatter block has no model: line', () => {
    const text = '---\nname: demo\n---\n\nBody.\n';
    assert.equal(extractFrontmatterModel(text), null);
  });
});

// ---------------------------------------------------------------------------
// extractDispatchLiterals — the boundary-aware sweep pattern
// ---------------------------------------------------------------------------

describe('extractDispatchLiterals', () => {
  it('counts every model="..." literal', () => {
    const text = '`Agent(model="haiku")` then later `Agent(model="haiku")` and `model="opus"`.';
    assert.deepEqual(extractDispatchLiterals(text), { haiku: 2, opus: 1 });
  });

  it('does NOT match impl_model="..." (hero/dispatch.md:38 false-positive case)', () => {
    // This is the exact review-flagged line shape from
    // ralph/skills/hero/dispatch.md:38 — a naive `model="` grep would match
    // it; the boundary-aware \bmodel=" pattern must not.
    const text = 'impl_model="${RALPH_IMPL_MODEL:-sonnet}"';
    assert.deepEqual(extractDispatchLiterals(text), {});
  });

  it('does not confuse a shell variable assignment with a real dispatch literal even alongside real ones', () => {
    const text = [
      'impl_model="${RALPH_IMPL_MODEL:-sonnet}"',
      '`Agent(subagent_type="ralph:research-agent", model="fable", prompt="...")`',
    ].join('\n');
    assert.deepEqual(extractDispatchLiterals(text), { fable: 1 });
  });

  it('returns an empty object when there are no literals', () => {
    assert.deepEqual(extractDispatchLiterals('no dispatch literals here'), {});
  });
});

// ---------------------------------------------------------------------------
// runCheck — equality, multiset, completeness sweep
// ---------------------------------------------------------------------------

describe('runCheck', () => {
  it('passes when frontmatter and dispatch literals match the config', () => {
    const root = mkTmpTree();
    fs.writeFileSync(
      path.join(root, 'ralph', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\nmodel: sonnet\n---\n\nBody.\n',
    );
    fs.writeFileSync(
      path.join(root, 'ralph', 'agents', 'demo-agent.md'),
      '---\nname: demo-agent\nmodel: haiku\n---\n\nBody.\n',
    );
    const config = baseConfig();
    config.sites = [
      { path: 'ralph/skills/demo/SKILL.md', kind: 'skill', tier: 'standard' },
      { path: 'ralph/agents/demo-agent.md', kind: 'agent', tier: 'cheap' },
    ];
    const { ok, diagnostics } = runCheck(root, config, 'claude-code');
    assert.equal(ok, true, diagnostics.join('\n'));
  });

  it('fails on a frontmatter equality mismatch and names the site', () => {
    const root = mkTmpTree();
    fs.writeFileSync(
      path.join(root, 'ralph', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\nmodel: haiku\n---\n\nBody.\n', // hand-edited away from sonnet
    );
    const config = baseConfig();
    config.sites = [{ path: 'ralph/skills/demo/SKILL.md', kind: 'skill', tier: 'standard' }];
    const { ok, diagnostics } = runCheck(root, config, 'claude-code');
    assert.equal(ok, false);
    assert.ok(diagnostics.some((d) => d.includes('ralph/skills/demo/SKILL.md') && d.includes('FAIL')));
  });

  it('fails on a dispatch multiset mismatch', () => {
    const root = mkTmpTree();
    fs.writeFileSync(
      path.join(root, 'ralph', 'skills', 'demo', 'dispatch.md'),
      'Only one: `model="haiku"`.\n', // config expects 2
    );
    const config = baseConfig();
    config.sites = [{ path: 'ralph/skills/demo/dispatch.md', kind: 'dispatch', tier: 'cheap', count: 2 }];
    const { ok, diagnostics } = runCheck(root, config, 'claude-code');
    assert.equal(ok, false);
    assert.ok(diagnostics.some((d) => d.includes('count 1 !== expected 2')));
  });

  it('combines a dispatch site and a hardPin into one expected multiset for the same file', () => {
    const root = mkTmpTree();
    fs.writeFileSync(
      path.join(root, 'ralph', 'skills', 'demo', 'dispatch.md'),
      'Reviewer: `model="opus"`. Escalation: `model="opus"`.\n',
    );
    const config = baseConfig();
    config.sites = [{ path: 'ralph/skills/demo/dispatch.md', kind: 'dispatch', tier: 'capable', count: 1 }];
    config.hardPins = [
      { path: 'ralph/skills/demo/dispatch.md', kind: 'dispatch', value: 'opus', count: 1, reason: 'test hard pin' },
    ];
    const { ok, diagnostics } = runCheck(root, config, 'claude-code');
    assert.equal(ok, true, diagnostics.join('\n'));
  });

  it('completeness sweep fails on an unmanifested frontmatter pin', () => {
    const root = mkTmpTree();
    fs.writeFileSync(
      path.join(root, 'ralph', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\nmodel: sonnet\n---\n\nBody.\n',
    );
    const config = baseConfig(); // no sites at all
    const { ok, diagnostics } = runCheck(root, config, 'claude-code');
    assert.equal(ok, false);
    assert.ok(diagnostics.some((d) => d.includes('unmanifested')));
  });

  it('completeness sweep fails on an unmanifested dispatch literal', () => {
    const root = mkTmpTree();
    fs.writeFileSync(
      path.join(root, 'ralph', 'skills', 'demo', 'dispatch.md'),
      'New site nobody declared: `model="fable"`.\n',
    );
    const config = baseConfig();
    const { ok, diagnostics } = runCheck(root, config, 'claude-code');
    assert.equal(ok, false);
    assert.ok(diagnostics.some((d) => d.includes('unmanifested')));
  });

  it('completeness sweep does not false-flag an impl_model="..." shell assignment', () => {
    const root = mkTmpTree();
    fs.writeFileSync(
      path.join(root, 'ralph', 'skills', 'demo', 'dispatch.md'),
      '```bash\nimpl_model="${RALPH_IMPL_MODEL:-sonnet}"\n```\n',
    );
    const config = baseConfig(); // no sites — would fail if the sweep matched impl_model
    const { ok, diagnostics } = runCheck(root, config, 'claude-code');
    assert.equal(ok, true, diagnostics.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// runWrite — idempotence + ambiguity refusal
// ---------------------------------------------------------------------------

describe('runWrite', () => {
  it('is idempotent: running --write twice on an already-correct tree makes no further changes', () => {
    const root = mkTmpTree();
    const filePath = path.join(root, 'ralph', 'skills', 'demo', 'SKILL.md');
    fs.writeFileSync(filePath, '---\nname: demo\nmodel: haiku\n---\n\nBody.\n');
    const config = baseConfig();
    config.sites = [{ path: 'ralph/skills/demo/SKILL.md', kind: 'skill', tier: 'standard' }];

    runWrite(root, config, 'claude-code'); // haiku -> sonnet
    const afterFirst = fs.readFileSync(filePath, 'utf-8');
    assert.match(afterFirst, /model: sonnet/);

    const messagesSecond = runWrite(root, config, 'claude-code');
    const afterSecond = fs.readFileSync(filePath, 'utf-8');
    assert.equal(afterFirst, afterSecond);
    assert.ok(messagesSecond.some((m) => m.startsWith('OK:')));
  });

  it('never rewrites a hardPin frontmatter value', () => {
    const root = mkTmpTree();
    const filePath = path.join(root, 'ralph', 'skills', 'demo', 'SKILL.md');
    fs.writeFileSync(filePath, '---\nname: demo\nmodel: fable\n---\n\nBody.\n');
    const config = baseConfig();
    config.hardPins = [
      { path: 'ralph/skills/demo/SKILL.md', kind: 'skill', value: 'fable', reason: 'identity' },
    ];
    runWrite(root, config, 'claude-code');
    assert.match(fs.readFileSync(filePath, 'utf-8'), /model: fable/);
  });

  it('refuses an ambiguous dispatch rewrite and reports it instead of guessing', () => {
    const root = mkTmpTree();
    const filePath = path.join(root, 'ralph', 'skills', 'demo', 'dispatch.md');
    fs.writeFileSync(filePath, '`model="haiku"` and `model="opus"` both present, config expects only one value.\n');
    const config = baseConfig();
    config.sites = [{ path: 'ralph/skills/demo/dispatch.md', kind: 'dispatch', tier: 'capable', count: 1 }];
    const messages = runWrite(root, config, 'claude-code');
    assert.ok(messages.some((m) => m.startsWith('MANUAL EDIT REQUIRED')));
    // File must be untouched.
    assert.equal(
      fs.readFileSync(filePath, 'utf-8'),
      '`model="haiku"` and `model="opus"` both present, config expects only one value.\n',
    );
  });

  it('rewrites an unambiguous dispatch literal', () => {
    const root = mkTmpTree();
    const filePath = path.join(root, 'ralph', 'skills', 'demo', 'dispatch.md');
    fs.writeFileSync(filePath, 'Fork at `model="fable"`.\n');
    const config = baseConfig();
    config.sites = [{ path: 'ralph/skills/demo/dispatch.md', kind: 'dispatch', tier: 'frontier', count: 1 }];
    runWrite(root, config, 'claude-code-opus'); // frontier/agent -> opus under this harness
    assert.match(fs.readFileSync(filePath, 'utf-8'), /model="opus"/);
  });
});

// ---------------------------------------------------------------------------
// Second-mapping (claude-code-opus) diff shape — a lightweight precursor to
// the full Phase 3 fixture (which lands against the real ralph/ tree).
// ---------------------------------------------------------------------------

describe('cross-harness check binding', () => {
  it('a tree written under claude-code-opus fails --check under claude-code and passes under claude-code-opus', () => {
    const root = mkTmpTree();
    const filePath = path.join(root, 'ralph', 'agents', 'demo-agent.md');
    fs.writeFileSync(filePath, '---\nname: demo-agent\nmodel: fable\n---\n\nBody.\n');
    const config = baseConfig();
    config.sites = [{ path: 'ralph/agents/demo-agent.md', kind: 'agent', tier: 'frontier' }];

    runWrite(root, config, 'claude-code-opus'); // frontier/agent -> opus
    assert.match(fs.readFileSync(filePath, 'utf-8'), /model: opus/);

    const underOpus = runCheck(root, config, 'claude-code-opus');
    assert.equal(underOpus.ok, true, underOpus.diagnostics.join('\n'));

    const underDefault = runCheck(root, config, 'claude-code');
    assert.equal(underDefault.ok, false);
  });
});

// ---------------------------------------------------------------------------
// printTierTable — the single source docs/CI-table checks should read from,
// instead of hand-duplicating the tier->model mapping a third time.
// ---------------------------------------------------------------------------

describe('printTierTable', () => {
  it('prints tier:model for every tier on the skill surface', () => {
    const config = baseConfig();
    assert.deepEqual(printTierTable(config, 'claude-code', 'skill'), [
      'cheap:haiku',
      'standard:sonnet',
      'capable:best',
      'frontier:fable',
    ]);
  });

  it('prints tier:model for every tier on the agent surface', () => {
    const config = baseConfig();
    assert.deepEqual(printTierTable(config, 'claude-code', 'agent'), [
      'cheap:haiku',
      'standard:sonnet',
      'capable:opus',
      'frontier:fable',
    ]);
  });

  it('reflects the second harness (claude-code-opus) for frontier', () => {
    const config = baseConfig();
    assert.deepEqual(printTierTable(config, 'claude-code-opus', 'skill'), [
      'cheap:haiku',
      'standard:sonnet',
      'capable:best',
      'frontier:opus',
    ]);
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses --check with --harness/--config/--root overrides', () => {
    const args = parseArgs(['--check', '--harness', 'claude-code-opus', '--config', 'x.yml', '--root', '/tmp']);
    assert.equal(args.mode, 'check');
    assert.equal(args.harness, 'claude-code-opus');
    assert.equal(args.config, 'x.yml');
    assert.equal(args.root, '/tmp');
  });

  it('defaults config to .ralph-models.yml and root to cwd', () => {
    const args = parseArgs(['--write']);
    assert.equal(args.mode, 'write');
    assert.equal(args.config, '.ralph-models.yml');
    assert.equal(args.root, process.cwd());
  });
});

// ---------------------------------------------------------------------------
// Integration: the real repo-root .ralph-models.yml against the real tree
// ---------------------------------------------------------------------------

describe('integration — real repo tree', () => {
  it('the committed .ralph-models.yml passes --check against this worktree', () => {
    const configPath = path.join(REPO_ROOT, '.ralph-models.yml');
    const config = loadConfig(configPath);
    const { ok, diagnostics } = runCheck(REPO_ROOT, config, config.defaultHarness);
    assert.equal(ok, true, diagnostics.filter((d) => d.startsWith('FAIL')).join('\n'));
  });

  it('walkMarkdownFiles finds real skill and agent files', () => {
    const files = walkMarkdownFiles(REPO_ROOT, ['ralph/skills', 'ralph/agents']);
    assert.ok(files.length > 20);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — the second-mapping demonstration (GH-1593). This is the epic-
// facing payoff: proving the config, not the prose, decides the models, by
// switching harnesses against a COPY of the real ralph/ tree and showing
// the diff is exactly the frontier sites — nothing more, nothing less — and
// contrasting that with what the all-flattening `CLAUDE_CODE_SUBAGENT_MODEL`
// escape hatch would have done to the same tree.
// ---------------------------------------------------------------------------

describe('Phase 3 — claude-code-opus second mapping (real ralph/ tree)', () => {
  function copyRealRalphTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tiers-phase3-'));
    for (const relDir of ['ralph/skills', 'ralph/agents']) {
      fs.cpSync(path.join(REPO_ROOT, relDir), path.join(root, relDir), { recursive: true });
    }
    return root;
  }

  function snapshot(root) {
    const files = new Map();
    for (const absPath of walkMarkdownFiles(root, ['ralph/skills', 'ralph/agents'])) {
      files.set(path.relative(root, absPath).split(path.sep).join('/'), fs.readFileSync(absPath, 'utf-8'));
    }
    return files;
  }

  it('--write --harness claude-code-opus changes EXACTLY the 5 frontier sites (2 agent frontmatter + 3 dispatch literals) and nothing else', () => {
    const root = copyRealRalphTree();
    const config = loadConfig(path.join(REPO_ROOT, '.ralph-models.yml'));

    const before = snapshot(root);
    runWrite(root, config, 'claude-code-opus');
    const after = snapshot(root);

    assert.deepEqual([...before.keys()].sort(), [...after.keys()].sort(), 'file set must not change');

    const changed = [...before.keys()].filter((relPath) => before.get(relPath) !== after.get(relPath)).sort();

    const expectedChanged = [
      'ralph/agents/plan-agent.md',
      'ralph/agents/review-agent.md',
      'ralph/skills/hero/dispatch.md',
      'ralph/skills/review/SKILL.md',
      'ralph/skills/review/merge-gate.md',
    ].sort();

    assert.deepEqual(changed, expectedChanged);

    // Frontmatter sites: fable -> opus.
    assert.match(after.get('ralph/agents/plan-agent.md'), /^model: opus$/m);
    assert.match(after.get('ralph/agents/review-agent.md'), /^model: opus$/m);
    // Dispatch literals: fable -> opus, exactly one occurrence each.
    for (const relPath of ['ralph/skills/hero/dispatch.md', 'ralph/skills/review/SKILL.md', 'ralph/skills/review/merge-gate.md']) {
      assert.deepEqual(extractDispatchLiterals(after.get(relPath)), { opus: 1 });
      assert.deepEqual(extractDispatchLiterals(before.get(relPath)), { fable: 1 });
    }

    // Hard pins are untouched: hero-fable stays fable; the BLOCKED-escalation
    // opus literal in phase-execution.md is unaffected by this harness switch.
    assert.equal(before.get('ralph/skills/hero-fable/SKILL.md'), after.get('ralph/skills/hero-fable/SKILL.md'));
    assert.equal(before.get('ralph/skills/impl/phase-execution.md'), after.get('ralph/skills/impl/phase-execution.md'));
  });

  it('the rewritten tree passes --check under claude-code-opus and FAILS --check under the default claude-code harness', () => {
    const root = copyRealRalphTree();
    const config = loadConfig(path.join(REPO_ROOT, '.ralph-models.yml'));
    runWrite(root, config, 'claude-code-opus');

    const underOpus = runCheck(root, config, 'claude-code-opus');
    assert.equal(underOpus.ok, true, underOpus.diagnostics.filter((d) => d.startsWith('FAIL')).join('\n'));

    const underDefault = runCheck(root, config, 'claude-code');
    assert.equal(underDefault.ok, false);
    // Only the 5 frontier sites should be the ones failing under the default
    // harness — everything else in the rewritten tree still matches claude-code.
    const failingSites = underDefault.diagnostics
      .filter((d) => d.startsWith('FAIL'))
      .map((d) => d.replace(/^FAIL: /, '').split(':')[0]);
    const uniqueFailingFiles = [...new Set(failingSites)].sort();
    assert.deepEqual(uniqueFailingFiles, [
      'ralph/agents/plan-agent.md',
      'ralph/agents/review-agent.md',
      'ralph/skills/hero/dispatch.md',
      'ralph/skills/review/SKILL.md',
      'ralph/skills/review/merge-gate.md',
    ].sort());
  });

  it('the untouched real tree still passes --check under the default claude-code harness (second mapping ships dormant)', () => {
    const config = loadConfig(path.join(REPO_ROOT, '.ralph-models.yml'));
    const { ok, diagnostics } = runCheck(REPO_ROOT, config, config.defaultHarness);
    assert.equal(ok, true, diagnostics.filter((d) => d.startsWith('FAIL')).join('\n'));
    assert.equal(config.defaultHarness, 'claude-code');
  });

  it('PROOF: the profile switch retargets ONLY the frontier sites, while CLAUDE_CODE_SUBAGENT_MODEL=opus would flatten every agent-surface tier', () => {
    // This is the specific claim the epic cares about: `.ralph-models.yml`
    // replaces the blunt `CLAUDE_CODE_SUBAGENT_MODEL` hammer (which the
    // platform documents as top-precedence and uniform — it overrides
    // frontmatter AND every per-invocation `model=` param with no way to
    // scope it to one tier) with a config edit that moves ONLY the tier(s)
    // named in the mapping.
    const config = loadConfig(path.join(REPO_ROOT, '.ralph-models.yml'));

    // Every site that runs on the "agent surface" at runtime (agent
    // frontmatter pins AND Agent(model=...) dispatch literals) — this is
    // exactly the set CLAUDE_CODE_SUBAGENT_MODEL reaches, per
    // docs/model-tier-policy.md's precedence-chain step 1.
    const agentSurfaceSites = (config.sites || []).filter((s) => s.kind === 'agent' || s.kind === 'dispatch');
    assert.ok(agentSurfaceSites.length >= 20, `expected a substantial manifest, got ${agentSurfaceSites.length}`);

    // Sites whose EXPECTED VALUE actually changes when switching from
    // claude-code to claude-code-opus (the targeted config-driven path).
    const changedByProfileSwitch = agentSurfaceSites.filter(
      (s) => resolveTier(config, s.tier, 'claude-code', 'agent') !== resolveTier(config, s.tier, 'claude-code-opus', 'agent'),
    );
    assert.equal(changedByProfileSwitch.length, 5, 'profile switch must touch exactly the 5 frontier sites');
    assert.ok(changedByProfileSwitch.every((s) => s.tier === 'frontier'));

    // Sites whose RUNTIME MODEL would change if CLAUDE_CODE_SUBAGENT_MODEL=opus
    // were set instead — every site not ALREADY resolving to opus under the
    // default harness, since the env var forces literally every subagent
    // fork/frontmatter pin to opus regardless of its tier.
    const flattenedByEnvVar = agentSurfaceSites.filter(
      (s) => resolveTier(config, s.tier, 'claude-code', 'agent') !== 'opus',
    );
    assert.ok(
      flattenedByEnvVar.length > changedByProfileSwitch.length,
      `env var flattening (${flattenedByEnvVar.length} sites) must reach strictly more sites than the targeted profile switch (${changedByProfileSwitch.length} sites)`,
    );

    // Concretely: the env var also touches every cheap (haiku) and standard
    // (sonnet) agent-surface site — sites the profile switch leaves alone.
    const cheapOrStandardTouchedByEnvVar = flattenedByEnvVar.filter((s) => s.tier === 'cheap' || s.tier === 'standard');
    assert.ok(
      cheapOrStandardTouchedByEnvVar.length > 0,
      'the env var must reach cheap/standard-tier sites the profile switch does not touch',
    );
    for (const site of cheapOrStandardTouchedByEnvVar) {
      // Confirm the profile switch (claude-code -> claude-code-opus) leaves
      // this specific site's resolved value untouched...
      assert.equal(
        resolveTier(config, site.tier, 'claude-code', 'agent'),
        resolveTier(config, site.tier, 'claude-code-opus', 'agent'),
      );
      // ...while CLAUDE_CODE_SUBAGENT_MODEL=opus would override it to opus
      // regardless (a flat env var, not a per-tier config value — it has no
      // "which tier" input at all, unlike resolveTier).
      assert.notEqual(resolveTier(config, site.tier, 'claude-code', 'agent'), 'opus');
    }
  });
});
