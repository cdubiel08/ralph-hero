#!/usr/bin/env node
'use strict';

// render.js — capability-tier model config renderer/checker (GH-1593)
//
// Reads `.ralph-models.yml` and verifies (--check) or regenerates (--write)
// the `model:` frontmatter pins and `Agent(model="...")` dispatch literals
// across `ralph/skills/**` and `ralph/agents/**`.
//
// CommonJS with a require.main guard (mirrors scripts/routing/route.js) so
// render.test.js can import the pure functions directly via `node --test`.

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const TIER_NAMES = ['cheap', 'standard', 'capable', 'frontier'];
const SURFACES = ['skill', 'agent'];

// Boundary-aware model="..." matcher. `\b` requires a word/non-word
// transition immediately before "model" — there is NONE between `_` and
// `m` in `impl_model="..."`, so that assignment is correctly excluded
// without needing a negative lookbehind. This is the fix for the
// GH-1593 review's called-out false positive at hero/dispatch.md:38.
const DISPATCH_LITERAL_RE = /\bmodel="([a-z]+)"/g;

// Matches a frontmatter `model:` line anywhere a caller restricts search to
// (we scope callers to the leading `---...---` block via extractFrontmatter).
const FRONTMATTER_MODEL_LINE_RE = /^model:\s*(\S+)\s*$/m;

// ---------------------------------------------------------------------------
// Config loading + resolution
// ---------------------------------------------------------------------------

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${configPath}: did not parse to an object`);
  }
  return parsed;
}

function resolveTier(config, tier, harness, surface) {
  if (!TIER_NAMES.includes(tier)) {
    throw new Error(`Unknown tier "${tier}"`);
  }
  if (!SURFACES.includes(surface)) {
    throw new Error(`Unknown surface "${surface}"`);
  }
  const harnessTiers = config.harnesses && config.harnesses[harness];
  if (!harnessTiers) {
    throw new Error(`Unknown harness "${harness}" — not present in config.harnesses`);
  }
  const tierEntry = harnessTiers[tier];
  if (!tierEntry || !(surface in tierEntry)) {
    throw new Error(`Harness "${harness}" tier "${tier}" has no "${surface}" surface value`);
  }
  return tierEntry[surface];
}

// ---------------------------------------------------------------------------
// File-content extraction
// ---------------------------------------------------------------------------

/** Return the leading `---\n...\n---` frontmatter block, or '' if absent. */
function extractFrontmatterBlock(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : '';
}

/** Return the frontmatter `model:` value, or null if the file has none. */
function extractFrontmatterModel(text) {
  const block = extractFrontmatterBlock(text);
  if (!block) return null;
  const match = block.match(FRONTMATTER_MODEL_LINE_RE);
  return match ? match[1] : null;
}

/** Return a { value: count } multiset of every `model="..."` literal in the file body. */
function extractDispatchLiterals(text) {
  const counts = {};
  const re = new RegExp(DISPATCH_LITERAL_RE);
  let m;
  while ((m = re.exec(text)) !== null) {
    counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  return counts;
}

function walkMarkdownFiles(root, relDirs) {
  const results = [];
  for (const relDir of relDirs) {
    const absDir = path.join(root, relDir);
    if (!fs.existsSync(absDir)) continue;
    walk(absDir);
  }
  return results;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Expected-value computation
// ---------------------------------------------------------------------------

/**
 * Build, per relative path, the expected dispatch multiset ({value: count})
 * from `sites` (kind: dispatch, resolved via the agent surface — the
 * Agent() runtime `model` param never accepts `best`) plus `hardPins`
 * (kind: dispatch, literal value, never resolved).
 */
function buildExpectedDispatchMultisets(config, harness) {
  const byPath = new Map();

  for (const site of config.sites || []) {
    if (site.kind !== 'dispatch') continue;
    const value = resolveTier(config, site.tier, harness, 'agent');
    const count = site.count || 1;
    addExpected(site.path, value, count);
  }
  for (const pin of config.hardPins || []) {
    if (pin.kind !== 'dispatch') continue;
    addExpected(pin.path, pin.value, pin.count || 1);
  }

  return byPath;

  function addExpected(relPath, value, count) {
    if (!byPath.has(relPath)) byPath.set(relPath, {});
    const multiset = byPath.get(relPath);
    multiset[value] = (multiset[value] || 0) + count;
  }
}

/** Every (path -> expected literal) for kind: skill/agent sites + hardPins. */
function buildExpectedFrontmatter(config, harness) {
  const byPath = new Map();

  for (const site of config.sites || []) {
    if (site.kind !== 'skill' && site.kind !== 'agent') continue;
    byPath.set(site.path, {
      value: resolveTier(config, site.tier, harness, site.kind),
      source: 'site',
      tier: site.tier,
    });
  }
  for (const pin of config.hardPins || []) {
    if (pin.kind !== 'skill' && pin.kind !== 'agent') continue;
    byPath.set(pin.path, { value: pin.value, source: 'hardPin', reason: pin.reason });
  }

  return byPath;
}

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

function runCheck(root, config, harness) {
  const diagnostics = [];
  let ok = true;

  function fail(msg) {
    ok = false;
    diagnostics.push(`FAIL: ${msg}`);
  }
  function passMsg(msg) {
    diagnostics.push(`PASS: ${msg}`);
  }

  // 1. Frontmatter equality (skill + agent sites, and skill/agent hardPins).
  const expectedFrontmatter = buildExpectedFrontmatter(config, harness);
  for (const [relPath, expected] of expectedFrontmatter) {
    const absPath = path.join(root, relPath);
    if (!fs.existsSync(absPath)) {
      fail(`${relPath}: file not found (manifested in .ralph-models.yml)`);
      continue;
    }
    const text = fs.readFileSync(absPath, 'utf-8');
    const actual = extractFrontmatterModel(text);
    if (actual === null) {
      fail(`${relPath}: no frontmatter "model:" line found (expected "${expected.value}")`);
    } else if (actual !== expected.value) {
      fail(`${relPath}: frontmatter model "${actual}" !== expected "${expected.value}"`);
    } else {
      passMsg(`${relPath}: model: ${actual}`);
    }
  }

  // 2. Dispatch multiset equality (per file).
  const expectedDispatch = buildExpectedDispatchMultisets(config, harness);
  for (const [relPath, expectedMultiset] of expectedDispatch) {
    const absPath = path.join(root, relPath);
    if (!fs.existsSync(absPath)) {
      fail(`${relPath}: file not found (manifested dispatch site in .ralph-models.yml)`);
      continue;
    }
    const text = fs.readFileSync(absPath, 'utf-8');
    const actualMultiset = extractDispatchLiterals(text);
    const values = new Set([...Object.keys(expectedMultiset), ...Object.keys(actualMultiset)]);
    for (const value of values) {
      const expectedCount = expectedMultiset[value] || 0;
      const actualCount = actualMultiset[value] || 0;
      if (expectedCount !== actualCount) {
        fail(
          `${relPath}: model="${value}" count ${actualCount} !== expected ${expectedCount}`,
        );
      } else {
        passMsg(`${relPath}: model="${value}" x${actualCount}`);
      }
    }
  }

  // 3. Completeness sweep — every file under ralph/skills/** and
  // ralph/agents/** carrying a frontmatter model: line or a dispatch
  // model="..." literal must be covered by sites/hardPins.
  const allFiles = walkMarkdownFiles(root, ['ralph/skills', 'ralph/agents']);
  let sweptCount = 0;
  for (const absPath of allFiles) {
    const relPath = path.relative(root, absPath).split(path.sep).join('/');
    const text = fs.readFileSync(absPath, 'utf-8');

    const frontmatterModel = extractFrontmatterModel(text);
    if (frontmatterModel !== null && !expectedFrontmatter.has(relPath)) {
      fail(`${relPath}: frontmatter "model: ${frontmatterModel}" is unmanifested (no site/hardPin entry)`);
      continue;
    }

    const dispatchLiterals = extractDispatchLiterals(text);
    const totalDispatchOccurrences = Object.values(dispatchLiterals).reduce((a, b) => a + b, 0);
    if (totalDispatchOccurrences > 0 && !expectedDispatch.has(relPath)) {
      fail(
        `${relPath}: ${totalDispatchOccurrences} model="..." literal(s) unmanifested (no dispatch site/hardPin entry)`,
      );
      continue;
    }
    sweptCount++;
  }
  passMsg(`completeness sweep: ${sweptCount}/${allFiles.length} files clean`);

  return { ok, diagnostics };
}

// ---------------------------------------------------------------------------
// --write
// ---------------------------------------------------------------------------

/**
 * Regenerate frontmatter values in place (kind: skill/agent sites only —
 * hardPins are never rewritten). For dispatch literals, rewrite only when
 * the old->new substitution is unambiguous within the file (a single
 * expected non-hardPin tier value maps to exactly one old literal); refuse
 * (report, do not touch) otherwise so conditional dispatch prose is never
 * corrupted by a blind find-replace.
 */
function runWrite(root, config, harness) {
  const messages = [];
  const expectedFrontmatter = buildExpectedFrontmatter(config, harness);

  for (const [relPath, expected] of expectedFrontmatter) {
    if (expected.source === 'hardPin') continue; // never rewrite hard pins
    const absPath = path.join(root, relPath);
    if (!fs.existsSync(absPath)) {
      messages.push(`SKIP: ${relPath}: file not found`);
      continue;
    }
    const text = fs.readFileSync(absPath, 'utf-8');
    const block = extractFrontmatterBlock(text);
    if (!block.match(FRONTMATTER_MODEL_LINE_RE)) {
      messages.push(`SKIP: ${relPath}: no frontmatter "model:" line to rewrite`);
      continue;
    }
    const rewrittenBlock = block.replace(FRONTMATTER_MODEL_LINE_RE, `model: ${expected.value}`);
    if (rewrittenBlock === block) {
      messages.push(`OK: ${relPath}: already ${expected.value}`);
      continue;
    }
    const rewritten = text.replace(block, rewrittenBlock);
    fs.writeFileSync(absPath, rewritten, 'utf-8');
    messages.push(`WROTE: ${relPath}: -> model: ${expected.value}`);
  }

  const expectedDispatch = buildExpectedDispatchMultisets(config, harness);
  // hardPin-only values per path (never touched by --write).
  const hardPinValuesByPath = new Map();
  for (const pin of config.hardPins || []) {
    if (pin.kind !== 'dispatch') continue;
    if (!hardPinValuesByPath.has(pin.path)) hardPinValuesByPath.set(pin.path, new Set());
    hardPinValuesByPath.get(pin.path).add(pin.value);
  }

  for (const [relPath, expectedMultiset] of expectedDispatch) {
    const absPath = path.join(root, relPath);
    if (!fs.existsSync(absPath)) {
      messages.push(`SKIP: ${relPath}: file not found`);
      continue;
    }
    let text = fs.readFileSync(absPath, 'utf-8');
    const actualMultiset = extractDispatchLiterals(text);
    const hardValues = hardPinValuesByPath.get(relPath) || new Set();

    // Non-hardPin actual values present in the file today (candidates for
    // rewrite). Ambiguous when more than one non-hardPin literal value is
    // present alongside a change, or when the count math doesn't reduce to
    // an unambiguous single-value swap.
    const nonHardActualValues = Object.keys(actualMultiset).filter((v) => !hardValues.has(v));
    const nonHardExpectedValues = Object.keys(expectedMultiset).filter((v) => !hardValues.has(v));

    const sameAlready =
      nonHardActualValues.length === nonHardExpectedValues.length &&
      nonHardActualValues.every((v) => actualMultiset[v] === expectedMultiset[v]);
    if (sameAlready) {
      messages.push(`OK: ${relPath}: dispatch literals already match`);
      continue;
    }

    if (nonHardActualValues.length !== 1 || nonHardExpectedValues.length !== 1) {
      messages.push(
        `MANUAL EDIT REQUIRED: ${relPath}: ambiguous dispatch rewrite (actual=${JSON.stringify(
          actualMultiset,
        )}, expected=${JSON.stringify(expectedMultiset)}) — edit by hand, --write refuses to guess`,
      );
      continue;
    }

    const oldValue = nonHardActualValues[0];
    const newValue = nonHardExpectedValues[0];
    if (oldValue === newValue) {
      messages.push(`OK: ${relPath}: dispatch literal already ${newValue}`);
      continue;
    }
    text = text.split(`model="${oldValue}"`).join(`model="${newValue}"`);
    fs.writeFileSync(absPath, text, 'utf-8');
    messages.push(`WROTE: ${relPath}: model="${oldValue}" -> model="${newValue}"`);
  }

  return messages;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    mode: null,
    harness: null,
    config: '.ralph-models.yml',
    root: process.cwd(),
    surface: 'skill',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') args.mode = 'check';
    else if (arg === '--write') args.mode = 'write';
    else if (arg === '--print-tier-table') args.mode = 'print-tier-table';
    else if (arg === '--harness') args.harness = argv[++i];
    else if (arg === '--config') args.config = argv[++i];
    else if (arg === '--root') args.root = argv[++i];
    else if (arg === '--surface') args.surface = argv[++i];
  }
  return args;
}

/**
 * Print `tier:model` lines for every tier under one harness/surface — the
 * single source other checkers (e.g. check-model-tiers.sh's doc-table
 * section) should read instead of hand-duplicating the tier->model mapping
 * a third time (which would itself be exactly the "two parsers of one YAML"
 * drift risk this config exists to eliminate).
 */
function printTierTable(config, harness, surface) {
  return TIER_NAMES.map((tier) => `${tier}:${resolveTier(config, tier, harness, surface)}`);
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.mode) {
    console.error(
      'Usage: render.js --check|--write|--print-tier-table [--harness NAME] [--config PATH] [--root DIR] [--surface skill|agent]',
    );
    return 2;
  }

  const configPath = path.isAbsolute(args.config) ? args.config : path.join(args.root, args.config);
  const config = loadConfig(configPath);
  const harness = args.harness || config.defaultHarness;

  if (args.mode === 'check') {
    const { ok, diagnostics } = runCheck(args.root, config, harness);
    for (const line of diagnostics) console.log(line);
    console.log(ok ? 'All model-tier sites match the config.' : 'Model-tier drift detected.');
    return ok ? 0 : 1;
  }

  if (args.mode === 'print-tier-table') {
    for (const line of printTierTable(config, harness, args.surface)) console.log(line);
    return 0;
  }

  // --write
  const messages = runWrite(args.root, config, harness);
  for (const line of messages) console.log(line);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  loadConfig,
  resolveTier,
  extractFrontmatterBlock,
  extractFrontmatterModel,
  extractDispatchLiterals,
  walkMarkdownFiles,
  buildExpectedDispatchMultisets,
  buildExpectedFrontmatter,
  runCheck,
  runWrite,
  printTierTable,
  parseArgs,
  main,
};
