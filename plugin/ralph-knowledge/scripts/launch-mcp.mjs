#!/usr/bin/env node
// MCP launcher for ralph-knowledge.
//
// Runs the vendored copy inside the plugin directory instead of
// `npx -y ralph-hero-knowledge-index@<version>`. The npx form created a fresh
// ~500MB-1GB cache dir under ~/.npm/_npx for every released version pin, and
// npx never evicts — one machine accumulated 20GB across 33 releases.
//
// WHY NODE AND NOT BASH (GH-1851). The predecessor was a shell script, invoked
// as `bash ${CLAUDE_PLUGIN_ROOT}/scripts/launch-mcp.sh` because Windows launches
// an MCP `command` as an executable and can neither run a `.sh` nor honour its
// shebang. That form needs `bash` on PATH, which is guaranteed on macOS and
// Linux but only conventional on Windows. `node` is guaranteed here by
// construction: this launches a Node MCP server, so if node cannot run, nothing
// downstream can either.
//
// First run bootstraps: npm ci, build, then prune dev deps and the
// onnxruntime-web wasm binaries (lazy-loaded, unused under Node). All
// bootstrap output goes to stderr — stdout is the MCP stdio channel.
//
// The bootstrap does NOT happen at the plugin root. It happens in a tree keyed
// by the RUNTIME IDENTITY that will serve from it (GH-1844) — see runtimeKey()
// below. One plugin cache can be reached by two Node identities (arm64 native
// beside x64 under Rosetta) or by two machines on a shared network home, and a
// single shared tree meant one of them could run a destructive `npm ci` over
// node_modules another was still serving from. Per-identity trees remove the
// sharing rather than guarding it: nothing is shared, so nothing has to be
// reasoned about across identities or hosts.
//
// Bootstrap is guarded two ways, because several Claude Code sessions can
// launch this script at the same instant:
//   * a completion MARKER holding a fingerprint of package.json +
//     package-lock.json + the Node ABI identity. It is deleted before the
//     install and written only after every step succeeds, so an interrupted
//     or half-updated tree re-bootstraps instead of serving a stale build.
//   * an inter-process mkdir LOCK, so exactly one process runs the
//     destructive `npm ci` while the others wait and then re-check. The lock is
//     never taken from its holder — see the note on reclamation below.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(SCRIPT_DIR, '..');
// The server's cwd stays the PLUGIN ROOT even though it is built and served out
// of a runtime subtree: hooks/disk-guard.sh identifies an in-use plugin version
// by the cwd of running processes, so moving it would make every live server
// read as idle and reclaimable.
process.chdir(PLUGIN_ROOT);

// Resolved from the script's own directory, not PLUGIN_ROOT: the two differ when
// CLAUDE_PLUGIN_ROOT is set, and the checker ships beside this launcher.
const CHECK_DEPS = path.join(SCRIPT_DIR, 'deps-complete.cjs');

const LOCK_WAIT_SEC = Number(process.env.RALPH_KNOWLEDGE_BOOTSTRAP_WAIT_SEC || 900);

const log = (msg) => process.stderr.write(`[ralph-knowledge] ${msg}\n`);

// --- identity ---------------------------------------------------------------

// The Node identity the built tree is bound to.
//
// NOT the full version string (codex P2, PR #1755). Hashing `node --version`
// invalidated the marker on every Node patch bump, and each invalidation costs a
// destructive `npm ci` + rebuild: multi-minute startup at best, and at worst a
// working offline install taken down because the registry is unreachable.
//
// The real boundary is the native ABI *on this platform*. better-sqlite3,
// onnxruntime-node, and the platform-specific sqlite-vec package ship compiled
// binaries keyed to NODE_MODULE_VERSION, which is stable across every minor and
// patch and changes exactly when a rebuild IS required. Platform and arch are
// part of it too: the ABI is identical for an arm64 and an x64 Node of the same
// major while the binaries are architecture-bound (codex P2, PR #1755).
//
// The bash predecessor needed three fallbacks here and a never-matching sentinel
// for the case where `node` could not be asked at all. Running INSIDE node
// deletes that whole ladder: these three values are always present, so the
// identity can never be unknown and "unknown must never read as a match" has
// nothing left to guard.
//
// RALPH_KNOWLEDGE_NODE_ID overrides it. That seam exists so per-identity
// isolation can be exercised without a second architecture on hand; setting it
// by hand to a value two different runtimes share is the one way to recreate
// the shared-tree hazard this layout removes.
function nodeId() {
  const override = process.env.RALPH_KNOWLEDGE_NODE_ID;
  if (override) return override;
  return `${process.platform}-${process.arch}-abi${process.versions.modules}`;
}

// A stable identifier for THIS MACHINE.
//
// `os.hostname()` first, because it is what an operator recognises in a refusal
// message. The fallbacks exist because an empty hostname used to collapse to a
// shared `unknown-host` sentinel, and two machines that both failed to name
// themselves compared EQUAL — so a cross-host check passed them as same-host
// (codex, PR #1755). Since the host is part of the tree key, a collision is no
// longer a guard that fails open but a tree that is genuinely shared, so the
// collision is removed at the source instead of guarded downstream.
//
// The last resort is a uuid persisted under the temp dir, which is machine-local
// on every real system even when the home directory is not. Losing it costs one
// extra tree; it can never produce a wrong match.
function machineId() {
  const override = process.env.RALPH_KNOWLEDGE_MACHINE_ID;
  if (override) return override;

  try {
    const h = os.hostname();
    if (h) return h.split('.')[0];
  } catch { /* fall through */ }

  try {
    const id = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    if (id) return `mid-${id.slice(0, 12)}`;
  } catch { /* fall through */ }

  if (process.platform === 'darwin') {
    const r = spawnSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
    const m = /"IOPlatformUUID" = "([^"]*)"/.exec(r.stdout || '');
    if (m && m[1]) return `uuid-${m[1].slice(0, 12)}`;
  }

  const idFile = path.join(os.tmpdir(), '.ralph-knowledge-machine-id');
  try {
    const id = fs.readFileSync(idFile, 'utf8').trim();
    if (id) return id;
  } catch { /* fall through */ }
  const fresh = `local-${randomUUID()}`;
  try { fs.writeFileSync(idFile, `${fresh}\n`); } catch { /* best effort */ }
  return fresh;
}

// Filesystem-safe: the key becomes a directory name, and platform strings and
// hostnames are not guaranteed to be.
const sanitizeKey = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');

const THIS_HOST = machineId();
// The directory key for this runtime's tree: native ABI boundary + machine. It
// must be STABLE, or per-identity trees become one tree per launch — the
// npx-cache-bloat failure this launcher exists to end.
const RUNTIME_KEY = sanitizeKey(`${nodeId()}-${THIS_HOST}`);
const RUNTIME_ROOT = path.join(PLUGIN_ROOT, '.runtimes', RUNTIME_KEY);

const MARKER = path.join(RUNTIME_ROOT, '.bootstrap-complete');
// Which Node identity built the tree. Kept beside the marker (which is an
// opaque hash) so a refusal can name the runtime that owns the tree. With
// per-identity trees this is provenance, no longer a guard input: a tree inside
// RUNTIME_ROOT was built by RUNTIME_KEY by construction.
const IDENTITY_FILE = path.join(RUNTIME_ROOT, '.bootstrap-identity');
// The lock lives INSIDE the runtime tree, so two identities bootstrapping at
// once do not serialize against each other — they have nothing in common to
// protect.
const LOCK = path.join(RUNTIME_ROOT, '.bootstrap.lock');
const ENTRY = path.join(RUNTIME_ROOT, 'dist', 'index.js');

// --- completeness ------------------------------------------------------------

// The fingerprint is taken from the PLUGIN ROOT's manifests, which are the
// source of truth the runtime tree's copies were made from — so an upstream
// change invalidates the tree even though its own copies still agree with its
// node_modules.
//
// sha256 unconditionally. The bash predecessor walked shasum -> sha256sum ->
// cksum -> a deliberately never-matching sentinel, because a host can lack every
// hasher; node ships crypto, so the ladder and its "cannot describe the tree"
// branch are both gone.
function fingerprint() {
  const h = createHash('sha256');
  h.update(`node-${nodeId()}\n`);
  for (const f of ['package.json', 'package-lock.json']) {
    try { h.update(fs.readFileSync(path.join(PLUGIN_ROOT, f))); } catch { h.update(`<missing:${f}>`); }
  }
  return h.digest('hex');
}

// True when the installed tree can actually run the server.
//
// The rules live in scripts/deps-complete.cjs, which documents each one and is
// tested against this package's REAL node_modules (GH-1846) — every version of
// this check validated against fixtures instead shipped a false positive, and a
// false "missing" forces a destructive `npm ci` + rebuild on every launch.
//
// Required set and install paths come from package-lock.json, so the walk
// reaches transitive and platform packages: one removed beneath its wrapper
// (sqlite-vec-<platform>-<arch>, onnxruntime-node under
// @huggingface/transformers) left the wrapper intact and the marker trusted,
// and the server then died resolving a binary instead of repairing the tree.
//
// Fails closed: a checker that is missing or that cannot run re-bootstraps
// rather than claiming the tree is healthy.
//
// Evaluated INSIDE the runtime tree (GH-1844): its package-lock.json is the copy
// this tree was installed from, and its node_modules is the only one the served
// dist can resolve against. A runtime root that does not exist yet cannot be
// entered and reads as incomplete, which is correct — there is nothing to serve.
function depsComplete() {
  if (!fs.existsSync(RUNTIME_ROOT)) return false;
  const r = spawnSync(process.execPath, [CHECK_DEPS], {
    cwd: RUNTIME_ROOT,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

function bootstrapNeeded() {
  if (!fs.existsSync(ENTRY)) return true;
  if (!depsComplete()) return true;
  let marker;
  try { marker = fs.readFileSync(MARKER, 'utf8').trim(); } catch { return true; }
  return marker !== fingerprint();
}

// --- the in-use probe --------------------------------------------------------

// True when a running MCP SERVER is serving out of the runtime tree.
//
// Identified by ARGV, not by cwd. The launcher chdir's to the plugin root and
// runs the server from there, so every process involved — servers and waiting
// launchers alike — shares that cwd, and a cwd test cannot tell them apart. The
// absolute path of the served entry point can: no waiter carries it, and it
// names one runtime tree rather than the plugin as a whole. That precision is
// what per-identity trees need — a server of a DIFFERENT identity is not a
// reason to refuse a rebuild of this one.
//
// Best-effort by nature: /proc on Linux, `ps` elsewhere. It can only speak for
// THIS machine, which per-identity trees make sufficient — the machine is part
// of the tree key, so a tree built elsewhere is a different tree. Callers ask
// probeAvailable() first, so that unknown never reads as "nobody is there".
const IS_WINDOWS = process.platform === 'win32';

// Windows has no `ps` and no /proc. `tasklist` lists processes but not their
// arguments, and the argument is the whole signal here — the entry path is what
// separates a server from a launcher. CIM/WMI is the only listing that carries
// a command line, so that is what the probe asks for.
const PS_LIST = IS_WINDOWS
  ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }']]
  : ['ps', ['-eo', 'pid=,args=']];

// The process listing, or NULL when it could not be taken.
//
// One read answers both questions the rebuild path asks — "can this host be
// probed at all" and "is anything serving from this tree" — because splitting
// them is how a fail-open hole appears: a probe-availability check that merely
// proves the *lister* runs will pass while the listing itself returns nothing,
// and an empty listing is then indistinguishable from a proven-idle tree
// (codex P2, this PR — reachable on Windows where PowerShell starts but CIM is
// unavailable, and on any host where `ps` is present but refuses). Null is the
// only honest answer to a failed read, and every caller must handle it.
//
// An EMPTY successful listing is also null: a process table that contains not
// even this process was not read.
function readProcessList() {
  if (fs.existsSync('/proc')) {
    let pids;
    try { pids = fs.readdirSync('/proc'); } catch { return null; }
    const out = [];
    for (const pid of pids) {
      if (!/^\d+$/.test(pid)) continue;
      try { out.push({ pid: Number(pid), cmd: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') }); } catch { /* exited */ }
    }
    return out.length ? out : null;
  }

  // Captured in full before matching. The bash predecessor had to say this out
  // loud — piping `ps` into an early-exiting matcher loses a positive detection
  // to SIGPIPE under `pipefail`, and it fails in the direction that calls an
  // in-use tree safe to rebuild. spawnSync captures by construction, so the
  // hazard is structurally absent rather than avoided by care.
  const r = spawnSync(PS_LIST[0], PS_LIST[1], { encoding: 'utf8' });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), cmd: m[2] });
  }
  return out.length ? out : null;
}

function serverRunningIn(procs, dir) {
  // TWO spellings, because argv carries the path as the launcher wrote it while
  // a realpath resolves symlinks — on macOS /var is a symlink to /private/var,
  // so a physical-only match misses every server started through the ordinary
  // path and the probe reports an in-use tree as idle.
  // Windows paths are case-insensitive, and a command line may spell the drive
  // or a directory differently from the launcher that wrote it.
  const norm = (s) => (IS_WINDOWS ? s.toLowerCase() : s);
  const entries = new Set([norm(path.join(dir, 'dist', 'index.js'))]);
  try { entries.add(norm(path.join(fs.realpathSync(dir), 'dist', 'index.js'))); } catch { /* dir may not exist */ }

  const hit = (cmd) => {
    const c = norm(cmd);
    for (const e of entries) if (c.includes(e)) return true;
    return false;
  };

  for (const p of procs) {
    if (p.pid === process.pid) continue;
    if (hit(p.cmd)) return true;
  }
  return false;
}

// --- the lock ----------------------------------------------------------------

// NOTE ON RECLAMATION — deliberately absent (codex P2 x6, PR #1755).
//
// Earlier revisions tried to detect and delete an abandoned lock. Four designs
// were written and MEASURED, and each one failed or spawned the next:
//
//   rm by name                — 30 waiters all pass the same check, then all
//                               delete; whoever already reclaimed loses its
//                               fresh lock. 4 concurrent installs.
//   an external reap lock     — moved the same race onto clearing a STALE reap
//                               lock.
//   capture by rename(2)      — instance-bound, but leaves the lock absent
//                               while inspected; a slow box fills that window.
//                               3 concurrent installs on CI's 2-core runner.
//   a marker inside the lock  — closed that, then deadlocked the tree when a
//                               reaper was SIGKILLed holding it; and recovering
//                               THAT marker is check-then-delete again.
//
// The recursion is the finding: reclamation is check-then-delete on a shared
// pathname, and every serialization layer needs its own reclamation, which
// needs its own serialization. There is exactly one atomic primitive here —
// directory creation — and it can create, never safely destroy someone else's.
//
// So this launcher NEVER deletes a lock it does not own. `mkdirSync` alone
// decides who bootstraps, which is airtight, and a lock is released only by the
// process that took it: normally, or via its INT/TERM handlers. Nothing else can
// manufacture a second holder, because nothing else removes the directory.
//
// The cost is stated rather than engineered around: a bootstrap killed with
// SIGKILL (or a machine that dies mid-install) leaves the lock behind, and the
// next launch waits out LOCK_WAIT_SEC and then FAILS with the directory to
// remove. That is a one-line manual recovery in a rare case, traded for the
// removal of an entire class of concurrent-destructive-install bugs. An
// ordinary kill needs no recovery at all — the handlers release the lock.
//
// The owner record is kept, but purely so that message can say WHO holds it.
// Nothing reads it to decide anything.
function writeLockOwner() {
  try {
    fs.writeFileSync(path.join(LOCK, 'owner'), `${process.pid} ${THIS_HOST} ${Math.floor(Date.now() / 1000)}\n`);
  } catch { /* best effort */ }
}

let holdingLock = false;
let activeChild = null;

function releaseLock() {
  if (!holdingLock) return;
  holdingLock = false;
  try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* best effort */ }
}

// A signal handler must RELEASE and STOP. The bash predecessor needed this said
// twice — bash runs a TERM/INT trap and then RESUMES the script, so a
// cleanup-only handler dropped the lock and carried on bootstrapping, letting
// another launcher run a second destructive `npm ci` on the same tree; and the
// handler had to disarm the EXIT trap first or `exit` removed the pathname a
// second time, deleting whatever waiter acquired it in between.
//
// Node's shape makes both structural rather than remembered. `holdingLock` is
// the disarm: releaseLock() is idempotent, so the exit hook cannot remove a
// second time. And process.exit() in the handler does not resume — but that only
// holds because the bootstrap below AWAITS its children instead of blocking the
// thread with spawnSync. A synchronous bootstrap would defer every handler until
// after the last step, which is precisely the "interrupted bootstrap claims
// completion" state the marker exists to prevent.
//
// The lock is released only once the bootstrap child is GONE (codex P2, this
// PR). Killing is asynchronous: releasing immediately hands the lock to a
// relaunch while `npm ci` — or a grandchild such as `tsc`, which was never
// signalled directly — is still mutating the same tree, which is the concurrent
// destructive install the lock exists to prevent.
//
// So the whole process GROUP is signalled (bootstrap children are spawned
// detached for exactly this reason; Windows has no group to signal, so the
// child alone is), and the handler then awaits the child's exit before letting
// go. A second signal during that wait exits at once — an operator pressing
// Ctrl-C twice means it, and by then the lock is the smaller problem.
let signalled = false;
function onFatalSignal(sig, code) {
  process.on(sig, async () => {
    if (signalled) process.exit(code);
    signalled = true;

    const child = activeChild;
    if (child) {
      try {
        if (IS_WINDOWS || child.pid === undefined) child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch { /* already gone */ }
      await new Promise((r) => (child.exitCode === null && child.signalCode === null
        ? child.once('close', r)
        : r()));
    }
    releaseLock();
    process.exit(code);
  });
}

// --- bootstrap ---------------------------------------------------------------

// `shell: true` on Windows only, and only ever with literal arguments: npm ships
// as `npm.cmd` there, and since Node 20 spawn refuses to resolve a `.cmd`
// without a shell. Nothing user-supplied reaches this call, so there is nothing
// for the shell to reinterpret.
//
// `detached` on POSIX puts each bootstrap step in its own process group, so the
// signal handler above can reach the grandchildren npm spawns (`tsc` under
// `npm run build`) rather than orphaning them onto the tree it is abandoning.
function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd, stdio: ['ignore', 2, 2], shell: IS_WINDOWS, detached: !IS_WINDOWS,
    });
    activeChild = child;
    child.on('error', (e) => { activeChild = null; reject(e); });
    child.on('close', (code, signal) => {
      activeChild = null;
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}

async function runBootstrap() {
  // Measured, not guessed: ~4.5s on a cold npm cache and ~3.6s warm (macOS,
  // 155MB fetched). For comparison the `npx -y ralph-hero-knowledge-index@X`
  // wiring this replaces took 7.7s cold and fetched 596MB. On a slow link the
  // download can still dominate; see the follow-up issue on decoupling it from
  // the handshake.
  log(`first run for runtime '${RUNTIME_KEY}': installing and building (one-time, usually a few seconds)...`);
  // Drop the marker first: if we are interrupted below, the next launch must
  // see an incomplete tree rather than a stale "complete" claim.
  fs.rmSync(MARKER, { force: true });
  fs.rmSync(IDENTITY_FILE, { force: true });

  // Materialize the runtime tree. The manifests are COPIED, not symlinked:
  // `npm prune` can rewrite a lockfile, and writing through a symlink would
  // edit the plugin's own source of truth. `src` is SYMLINKED, so a developer
  // editing the plugin sources is not silently served a stale snapshot —
  // verified that tsc compiles a symlinked rootDir, maps outDir correctly, and
  // resolves bare imports against this tree's node_modules rather than the
  // plugin root's.
  for (const f of ['package.json', 'package-lock.json', 'tsconfig.json']) {
    fs.copyFileSync(path.join(PLUGIN_ROOT, f), path.join(RUNTIME_ROOT, f));
  }
  //
  // A JUNCTION on Windows, a symlink elsewhere. Creating a directory symlink on
  // Windows needs elevation or developer mode; a junction is the same
  // indirection with no privilege at all, and tsc follows both. Without this
  // the first launch dies at EPERM on exactly the platform this launcher was
  // rewritten for.
  fs.rmSync(path.join(RUNTIME_ROOT, 'src'), { recursive: true, force: true });
  fs.symlinkSync(path.join(PLUGIN_ROOT, 'src'), path.join(RUNTIME_ROOT, 'src'),
    IS_WINDOWS ? 'junction' : undefined);

  // --include=dev is NOT redundant (codex P2, PR #1755). `tsc` is declared only
  // in devDependencies and the very next line runs it. If the environment says
  // to omit dev — Claude Code inheriting NODE_ENV=production, or a user's own
  // npm config — this install silently skips typescript and the build then
  // fails on every first launch, before the completion marker is written.
  // Verified: `NODE_ENV=production npm config get omit` reports `dev`, and
  // --include overrides it. The dev deps are pruned again two lines down, so
  // this costs nothing on disk.
  await run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], RUNTIME_ROOT);
  await run('npm', ['run', 'build'], RUNTIME_ROOT);
  await run('npm', ['prune', '--omit=dev', '--no-audit', '--no-fund'], RUNTIME_ROOT);

  // onnxruntime-web must remain importable (transformers.js imports it
  // statically) but its wasm payloads are never loaded under Node. A missing
  // directory is fine (layout change / already pruned); a failure to delete an
  // existing payload is not, and must not be reported as a clean bootstrap.
  const onnx = path.join(RUNTIME_ROOT, 'node_modules', 'onnxruntime-web');
  if (fs.existsSync(onnx)) {
    for (const f of fs.readdirSync(onnx, { recursive: true, withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith('.wasm')) fs.rmSync(path.join(f.parentPath ?? f.path, f.name));
    }
  }

  // Identity BEFORE the marker (codex P2, PR #1755). The marker is the
  // completion signal, so anything that survives with a marker must already
  // carry its provenance — publishing them the other way round leaves a window
  // where a complete-looking tree has no identity at all.
  // The HOST is recorded too: a local process probe can only speak for this
  // machine, so a tree built elsewhere on a shared home must not be judged idle
  // from here.
  fs.writeFileSync(IDENTITY_FILE, `node-${nodeId()} ${THIS_HOST}\n`);
  fs.writeFileSync(MARKER, fingerprint());
  log('bootstrap complete.');
}

// --- main --------------------------------------------------------------------

async function maybeBootstrap() {
  if (!bootstrapNeeded()) return;

  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });

  let waited = 0;
  let acquired = false;
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }

    // The holder may have finished while we were queued. Once the tree is
    // complete we need nothing from the lock, so leave immediately rather than
    // waiting a turn (codex P2, PR #1755) — otherwise a cold start with N
    // sessions costs roughly one polling interval PER session, each waking,
    // taking a lock it does not need, and dropping it again.
    if (!bootstrapNeeded()) return;

    if (waited >= LOCK_WAIT_SEC) {
      let owner = 'unknown (no owner recorded)';
      try { owner = fs.readFileSync(path.join(LOCK, 'owner'), 'utf8').trim() || owner; } catch { /* keep default */ }
      log(`timed out after ${LOCK_WAIT_SEC}s waiting for another process to bootstrap (${LOCK})`);
      log(`held by: ${owner}`);
      log(`if that process is gone, remove ${LOCK} and relaunch`);
      process.exit(1);
    }
    if (waited === 0) log('another process is bootstrapping; waiting...');
    await new Promise((r) => setTimeout(r, 2000));
    waited += 2;
  }

  if (!acquired) return;

  holdingLock = true;
  process.on('exit', releaseLock);
  onFatalSignal('SIGINT', 130);
  onFatalSignal('SIGTERM', 143);

  // Recorded only so a timed-out waiter can name who holds the lock. Nothing
  // reads it to make a decision — see the note on reclamation above.
  writeLockOwner();

  try {
    // Re-check under the lock: the process we waited on may have finished the
    // work, in which case we must not repeat the destructive `npm ci`.
    if (bootstrapNeeded()) {
      // Everything below is scoped to THIS runtime tree. A server of another
      // identity, or on another machine, is serving out of a different
      // directory entirely (GH-1844) and is neither disturbed by this rebuild
      // nor a reason to refuse it — which is the whole point of the layout.
      let builtHost = '';
      try { builtHost = (fs.readFileSync(IDENTITY_FILE, 'utf8').trim().split(/\s+/)[1] || ''); } catch { /* none */ }

      // Is there an existing built tree at all? A genuinely empty runtime root
      // has nothing to protect, so a first install is never blocked.
      const treeExists = fs.existsSync(MARKER) || fs.existsSync(path.join(RUNTIME_ROOT, 'node_modules'));

      // A LIVE SERVER on this tree blocks the rebuild (codex P2, PR #1755).
      // Per-identity trees remove the CROSS-identity case, not this one: a
      // same-identity rebuild is just as destructive, and a damaged marker, a
      // changed lockfile, or a missing entry point all reach `npm ci` while a
      // server is still resolving lazy imports out of node_modules. Failing
      // loudly here beats the silent alternative, where that server dies later
      // with nothing to connect it to this rebuild.
      const procs = readProcessList();

      if (treeExists && procs && serverRunningIn(procs, RUNTIME_ROOT)) {
        log(`refusing to rebuild: a server is still running out of ${RUNTIME_ROOT}.`);
        log('Rebuilding would replace node_modules underneath it.');
        log('close every session using this runtime, then relaunch.');
        log(`once they are closed, removing ${RUNTIME_ROOT} forces a clean rebuild.`);
        process.exit(1);
      }

      // Unknown must not read as "safe": where the process table cannot be read
      // at all we cannot prove the tree is idle, so an EXISTING tree is refused
      // there too and the operator is told why.
      if (treeExists && !procs) {
        log('refusing to rebuild: this host cannot be probed for running');
        log(`processes, so a server serving out of ${RUNTIME_ROOT} cannot be`);
        log('ruled out, and rebuilding would replace node_modules underneath it.');
        log('close every session using this runtime, then relaunch.');
        log(`once they are closed, removing ${RUNTIME_ROOT} forces a clean rebuild.`);
        process.exit(1);
      }

      // Residual assertion, not a guard that should ever fire: the machine is
      // part of the tree key, so a tree in this directory was built here. If it
      // was not, the machine id is not as stable as it claims and the local
      // process probe above cannot speak for whoever built it — refuse rather
      // than treat an unprovable case as idle (codex, PR #1755).
      if (treeExists && builtHost && builtHost !== THIS_HOST) {
        log(`refusing to rebuild: this tree records host '${builtHost}'`);
        log(`but this machine identifies as '${THIS_HOST}', so the local process`);
        log('table cannot say whether a server there is still serving from it.');
        log('close every session using this runtime, then relaunch.');
        log(`once they are closed, removing ${RUNTIME_ROOT} forces a clean rebuild.`);
        process.exit(1);
      }

      // A tree left at the plugin root by a pre-GH-1844 launcher is dead weight
      // once this runtime tree exists, and it is large. It is NOT swept: a
      // session started before the upgrade may still be serving out of it, and
      // deleting it would break exactly the process the guards above protect.
      // Named once, at the only moment we are already talking to the operator.
      if (fs.existsSync(path.join(PLUGIN_ROOT, 'node_modules'))) {
        log('note: a pre-per-runtime install is still present at');
        log(`${path.join(PLUGIN_ROOT, 'node_modules')} and is no longer used. Once every session`);
        log('started before this upgrade is closed, it can be removed.');
      }

      await runBootstrap();
    }
  } finally {
    releaseLock();
  }
}

// cwd stays the plugin root (see the top of this file); the entry point is
// addressed absolutely so it resolves node_modules inside its own runtime tree
// and so the process probe above can recognise it.
//
// process.execPath, not a PATH lookup: this process IS the Node the tree was
// keyed to, so serving through anything else could load arch-bound binaries
// under the wrong runtime.
//
// The bash predecessor `exec`'d and left no parent behind. Node has no execve,
// so the launcher stays as a thin parent that forwards signals and exits with
// the server's own status. That costs one idle process per server; it buys an
// argv the in-use probe above can still recognise, which an in-process
// `import()` of the entry point would have destroyed — the launcher and the
// server would then be indistinguishable, and a merely-waiting launcher would
// block every rebuild.
function serve() {
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');

  const child = spawn(process.execPath, [ENTRY, ...process.argv.slice(2)], { stdio: 'inherit' });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
  }
  child.on('error', (e) => {
    log(`failed to start the server: ${e.message}`);
    process.exit(1);
  });
  child.on('close', (code, signal) => {
    process.exit(signal ? 128 + (os.constants.signals[signal] || 0) : (code ?? 1));
  });
}

try {
  await maybeBootstrap();
} catch (e) {
  releaseLock();
  log(`bootstrap failed: ${e.message}`);
  process.exit(1);
}
serve();
