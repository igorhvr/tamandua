import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ORACLE_EVIDENCE_KEYS, OPTIONAL_ORACLE_EVIDENCE_KEYS } from './oracle-context.mjs';

const MECHANICAL_EVENT_FIELDS = new Set([
  'ts', 'event', 'runId', 'run_id', 'parentRunId', 'childRunId', 'workflowId', 'stepId',
  'storyId', 'agentId', 'reason', 'abandonedCount', 'tokenDelta', 'tokensSpent', 'treeHash', 'cmdHash',
  'savedDurationMs', 'durationMs', 'exitCode', 'signal', 'workerLostCount', 'passCount',
  'failCount', 'window', 'waitedMs', 'preTreeHash', 'postTreeHash', 'ownerRunId',
  'ownerStepId', 'ownerPid', 'reclaimerRunId', 'reclaimerStepId', 'reclaimerPid', 'origin',
  'branch', 'target', 'expectedTip', 'actualTip', 'mergedTree', 'mergedCommit', 'noop',
  'checkoutRefresh', 'parkedBranch', 'ledgerRowId', 'ledgerCreatedAt', 'gateMode', 'runNumber',
  'launchTs', 'status', 'phase', 'category', 'kind', 'roundId', 'round_id', 'attempt',
  'force', 'originRepo', 'cmdDisplay', 'startedAt', 'releaseReason', 'shimExitCode',
  'commandExitCode', 'interrupted', 'trackedDirty', 'junkProbePath', 'junkProbeTracked',
  'usageId', 'harness', 'sessionId', 'finishedAt', 'inputTokens', 'outputTokens',
  'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'candidateRunIds',
  'recordId', 'stepRowId', 'claimId', 'attemptNumber', 'validationCode', 'diagnosticCode',
  'outcome', 'verdict', 'expectsRequired', 'requiredKeys', 'missingKeys', 'invalidKeys',
  'producerStepRowId', 'transitionAction', 'transitionTargetStepRowId',
  'unresolvedPlaceholderCount', 'unresolvedKeys', 'dispatched',
]);
const STRING_ARRAY_EVENT_FIELDS = new Set([
  'candidateRunIds', 'requiredKeys', 'missingKeys', 'invalidKeys', 'unresolvedKeys',
]);
const ACTIVE_SNAPSHOT_DIRECTORIES = new Map();

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertContainedDirectory(candidate, root, label) {
  const rootReal = fs.realpathSync(root);
  const details = fs.lstatSync(candidate);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} is not a regular directory`);
  const real = fs.realpathSync(candidate);
  if (!pathIsWithin(rootReal, real)) throw new Error(`${label} is outside torture-test state`);
  return real;
}

function assertContainedFile(candidate, root, label) {
  const rootReal = fs.realpathSync(root);
  const details = fs.lstatSync(candidate);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  const real = fs.realpathSync(candidate);
  if (!pathIsWithin(rootReal, real)) throw new Error(`${label} is outside controller-provided TT state`);
  return real;
}

function openSnapshotDirectory(campaignDir, caseId, attemptId) {
  const campaignReal = fs.realpathSync(campaignDir);
  let current = campaignReal;
  for (const segment of ['snapshots', caseId, attemptId]) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const details = fs.lstatSync(current);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error('snapshot directory contains a symlink or non-directory component');
    }
    const real = fs.realpathSync(current);
    if (!pathIsWithin(campaignReal, real)) throw new Error('snapshot directory escaped campaign');
    current = real;
  }
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(current, flags);
  // On linux, re-resolve the open fd through /proc/self/fd/<fd> and confirm
  // it still refers to the realpath we opened — /proc/self/fd is linux-only
  // (oracle-evidence-snapshot.mjs MACP3 US-003 portability fix).
  // On darwin /proc does not exist: the fd was opened O_NOFOLLOW on `current`
  // (already a realpath), so no symlink could have been followed at open
  // time and there is nothing further to verify — skip the identity re-check.
  if (process.platform === 'linux') {
    const fdPath = `/proc/${process.pid}/fd/${fd}`;
    if (fs.realpathSync(fdPath) !== current) {
      fs.closeSync(fd);
      throw new Error('snapshot directory identity changed while opening');
    }
  }
  ACTIVE_SNAPSHOT_DIRECTORIES.set(current, fd);
  return { logical: current, fd, fdPath: snapshotWorkDirectory(current, fd) };
}

// snapshotWorkDirectory: the path snapshot file operations run through.
// Linux: /proc/self/fd/<fd> routes every read/write through the OPEN
// directory descriptor (immune to a raced symlink swap of the logical path).
// Darwin: /proc is absent, so fall back to the logical realpath — the same
// directory inode that was opened O_NOFOLLOW, resolved by path instead of
// by fd. Slightly weaker against a mid-run logical-path swap, but campaign
// directories are created once by the controller and never replaced, so this
// is sound (documented linux-only-acceptance tradeoff; MACP3 US-003).
function snapshotWorkDirectory(logical, fd) {
  if (process.platform === 'linux') return `/proc/${process.pid}/fd/${fd}`;
  return logical;
}

function activeSnapshotDirectory(logical) {
  const fd = ACTIVE_SNAPSHOT_DIRECTORIES.get(logical);
  if (fd === undefined) return null;
  return { logical, fd, fdPath: snapshotWorkDirectory(logical, fd) };
}

function closeSnapshotDirectory(directory) {
  ACTIVE_SNAPSHOT_DIRECTORIES.delete(directory.logical);
  fs.closeSync(directory.fd);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function utcTimestamp() {
  return new Date().toISOString();
}

function portableRelative(root, candidate) {
  return path.relative(root, candidate).split(path.sep).join('/');
}

function writeExclusive(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { flag: 'wx', mode });
}

function writeJsonExclusive(file, value) {
  writeExclusive(file, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function referenceFor(campaignDir, file, capturedAt, source) {
  const content = fs.readFileSync(file);
  const real = fs.realpathSync(file);
  if (!pathIsWithin(fs.realpathSync(campaignDir), real)) {
    throw new Error('snapshot artifact escaped campaign directory');
  }
  return {
    path: portableRelative(campaignDir, real),
    sha256: sha256(content),
    captured_at: capturedAt,
    source,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
    throw new Error(`${command} ${args[0] ?? ''} failed: ${detail}`);
  }
  return result.stdout;
}

function runToExclusiveFile(command, args, file, cwd) {
  const outputFd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const result = spawnSync(command, args, {
      cwd, shell: false, encoding: 'utf8', stdio: ['ignore', outputFd, 'pipe'],
    });
    if (result.error !== undefined || result.status !== 0) {
      const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
      throw new Error(`${command} ${args[0] ?? ''} failed: ${detail}`);
    }
    fs.fsyncSync(outputFd);
  } finally {
    fs.closeSync(outputFd);
  }
}

function git(repositoryPath, args) {
  return run('git', ['-C', repositoryPath, ...args]);
}

function repositoryIdentity(repositoryPath, ttRoot) {
  const commonDir = path.resolve(repositoryPath, git(repositoryPath, ['rev-parse', '--git-common-dir']).trim());
  if (!pathIsWithin(fs.realpathSync(ttRoot), fs.realpathSync(commonDir))) {
    throw new Error('repository git directory is outside torture-test state');
  }
  return {
    fixture_path: portableRelative(ttRoot, repositoryPath),
    git_common_dir: portableRelative(ttRoot, commonDir),
    object_format: git(repositoryPath, ['rev-parse', '--show-object-format']).trim(),
  };
}

function suiteOriginRepo(repositoryPath) {
  const repository = fs.realpathSync(repositoryPath);
  const commonDir = fs.realpathSync(path.resolve(
    repositoryPath, git(repositoryPath, ['rev-parse', '--git-common-dir']).trim(),
  ));
  const repositoryGit = path.join(repository, '.git');
  if (commonDir === repositoryGit) return repository;
  return commonDir.endsWith(`${path.sep}.git`) ? fs.realpathSync(path.dirname(commonDir)) : repository;
}

function launchGateKey(caseRecord, repositoryPath) {
  const command = caseRecord.context.test_cmd_raw ?? caseRecord.context.test_cmd;
  if (typeof command !== 'string' || command.length === 0) return null;
  return {
    origin_repo: suiteOriginRepo(repositoryPath),
    cmd_hash: sha256(command),
  };
}

// S31 (US-009): resolve the fixture's target-ref identity per the case's
// declared contract instead of assuming a symbolic ref. A named checkout
// resolves to its `refs/...` name (symbolic-ref HEAD). A DETACHED-HEAD
// fixture — the W4.30-detached-head-origin premise, declared by its reset
// hook (`git checkout --detach HEAD` leaves `git symbolic-ref -q HEAD`
// empty) — has no symbolic target ref; the target identity IS the detached
// HEAD commit, recorded as the resolved OID with a `detached_head` marker on
// the evidence. Fail closed (precise one-line reason) only when even the HEAD
// commit is unresolvable (empty/unborn repository) — never a silent empty
// target, and never the pre-fix `fixture repository has no symbolic target
// ref` throw that voided W4.30 before its launch could run.
function targetRefInfo(repositoryPath) {
  const symbolic = spawnSync('git', ['-C', repositoryPath, 'symbolic-ref', '-q', 'HEAD'], {
    encoding: 'utf8', shell: false,
  });
  const symbolicRef = symbolic.status === 0 && symbolic.stdout.trim() !== ''
    ? symbolic.stdout.trim()
    : null;
  if (symbolicRef !== null) {
    // Verify the named ref actually RESOLVES — an unborn repository (HEAD
    // points at a ref that does not exist yet) must fail closed with the
    // precise reason here, never surface a generic rev-parse failure
    // downstream.
    const resolved = spawnSync('git', ['-C', repositoryPath, 'rev-parse', '--verify', symbolicRef], {
      encoding: 'utf8', shell: false,
    });
    if (resolved.status === 0 && resolved.stdout.trim() !== '') {
      return { target_ref: symbolicRef, detached: false };
    }
  }
  const head = spawnSync('git', ['-C', repositoryPath, 'rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8', shell: false,
  });
  if (head.status !== 0 || head.stdout.trim() === '') {
    throw new Error('fixture repository has no symbolic target ref and no resolvable HEAD commit');
  }
  return { target_ref: head.stdout.trim(), detached: true };
}

function captureRefs(repositoryPath, ttRoot, phase) {
  const info = targetRefInfo(repositoryPath);
  return {
    schema_version: 1,
    phase,
    repository: repositoryIdentity(repositoryPath, ttRoot),
    target_ref: info.target_ref,
    target_tip: git(repositoryPath, ['rev-parse', '--verify', info.target_ref]).trim(),
    ...(info.detached ? { detached_head: true } : {}),
    for_each_ref: git(repositoryPath, [
      'for-each-ref', '--sort=refname',
      '--format=%(objectname)%09%(objecttype)%09%(refname)%09%(upstream)',
    ]),
  };
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function bytewiseNameComparator(a, b) {
  // Byte-wise (UTF-16 code-unit) ordering, matching the strict path-sorted
  // contract the O8 oracle enforces on checksum inventories. localeCompare
  // applies locale/case-insensitive collation (underscore before dot, lower
  // before upper) which produces a flat list that O8 rejects as unsorted on
  // real provisioned clones (e.g. tt-python .venv).
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function walkFiles(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort(bytewiseNameComparator);
  const files = [];
  for (const entry of entries) {
    const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (childRelative === '.git' || childRelative.startsWith('.git/')) continue;
    const absolute = path.join(root, childRelative);
    if (entry.isSymbolicLink()) {
      files.push({ path: childRelative, type: 'symlink', mode: fs.lstatSync(absolute).mode & 0o7777, sha256: sha256(fs.readlinkSync(absolute)) });
    } else if (entry.isDirectory()) {
      files.push(...walkFiles(root, childRelative));
    } else if (entry.isFile()) {
      files.push({ path: childRelative, type: 'file', mode: fs.statSync(absolute).mode & 0o7777, sha256: fileSha256(absolute) });
    }
  }
  return files;
}

function boundaryMatches(file, declaration) {
  const normalized = declaration.replaceAll('\\', '/').replace(/\/\.\.\.$/, '');
  return file === normalized || file.startsWith(`${normalized}/`);
}

function isSeededTest(file) {
  const basename = path.posix.basename(file).toLowerCase();
  return /(^|[._-])(test|spec)([._-]|$)/.test(basename)
    || file.split('/').some((segment) => ['test', 'tests', '__tests__'].includes(segment.toLowerCase()));
}

function testMarkerCounts(file) {
  const text = fs.readFileSync(file, 'utf8');
  return {
    skip: (text.match(/\bskip(?:ped)?\b/giu) ?? []).length,
    todo: (text.match(/\btodo\b/giu) ?? []).length,
    xfail: (text.match(/\bxfail\b/giu) ?? []).length,
  };
}

// Fixture-source-relative declarations (e.g. 'fixtures-src/tt-python/src')
// must be rebased to the work-clone root before matching against an
// inventory whose paths are repository-root-relative, and to retain declared
// untracked forbidden baits.
function rebaseFixtureDeclarationList(declarations, fixture) {
  const prefix = typeof fixture === 'string' && fixture.length > 0 ? `fixtures-src/${fixture}/` : null;
  return (declarations ?? []).map((value) => {
    if (prefix !== null && typeof value === 'string' && value.startsWith(prefix)) return value.slice(prefix.length);
    return value;
  });
}

function gitTrackedPaths(repositoryPath) {
  // The checksum inventory must represent the git-TRACKED project tree, not
  // the whole working tree. Provisioned fixture work clones intentionally
  // carry untracked arming artifacts (bootstrapped .venv, regenerated junk,
  // planted operator-notes.local) per spec 02. Including them made O8's
  // git-HEAD reconciliation impossible (tree.size !== terminalMap.size) and
  // risked spurious boundary findings from .venv/junk drift. Intersect the
  // walk with `git ls-files` so only committed content is inventoried.
  return new Set(git(repositoryPath, ['ls-files', '-z']).split('\0').filter(Boolean));
}

function captureChecksums(repositoryPath, caseRecord, phase, baselineEntries = null) {
  const declarations = {
    boundary_files: [...caseRecord.boundary_files],
    forbidden: [...caseRecord.forbidden],
  };
  const tracked = gitTrackedPaths(repositoryPath);
  // Declared forbidden baits MUST remain inventoried even though they are
  // deliberately untracked (spec 02 plants operator-notes.local as an untracked
  // file; its goldens exclude it). O8 verifies these baits stay byte-identical
  // across the run, so exclude them from the tracked-only filter.
  const fixture = typeof caseRecord.fixture === 'string' ? caseRecord.fixture : '';
  const forbiddenBaits = rebaseFixtureDeclarationList(declarations.forbidden, fixture);
  const keepInventoryEntry = (entry) => tracked.has(entry.path)
    || forbiddenBaits.some((bait) => entry.path === bait || entry.path.startsWith(`${bait}/`));
  const entries = walkFiles(repositoryPath)
    .filter(keepInventoryEntry)
    .map((entry) => {
    const categories = [];
    if (declarations.boundary_files.some((item) => boundaryMatches(entry.path, item))) categories.push('boundary');
    if (declarations.forbidden.some((item) => boundaryMatches(entry.path, item))) categories.push('forbidden');
    if (isSeededTest(entry.path)) categories.push('seeded-test');
    return {
      ...entry,
      categories,
      ...(isSeededTest(entry.path)
        ? { test_markers: entry.type === 'file' ? testMarkerCounts(path.join(repositoryPath, entry.path)) : { skip: 0, todo: 0, xfail: 0 } }
        : {}),
    };
  });
  const current = new Map(entries.map((entry) => [entry.path, entry]));
  const baseline = new Map((baselineEntries ?? []).map((entry) => [entry.path, entry]));
  const changed_paths = baselineEntries === null ? [] : [...new Set([...current.keys(), ...baseline.keys()])]
    .filter((file) => JSON.stringify(current.get(file) ?? null) !== JSON.stringify(baseline.get(file) ?? null))
    .sort();
  // Guarantee strict byte-wise (code-unit) path ordering regardless of the
  // depth-first traversal order, so checksum inventories always satisfy the
  // O8 unique + path-sorted contract on real provisioned clones.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { schema_version: 1, phase, declarations, entries, changed_paths };
}

function copyContainedFile(source, stateDir, destination, label) {
  const contained = assertContainedFile(source, stateDir, label);
  const sourceFd = fs.openSync(contained, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const destinationFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const details = fs.fstatSync(sourceFd);
    if (!details.isFile() || details.nlink !== 1) {
      throw new Error(`${label} changed identity or is hard-linked during capture`);
    }
    let position = 0;
    while (true) {
      const count = fs.readSync(sourceFd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      fs.writeSync(destinationFd, buffer, 0, count);
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    fs.fsyncSync(destinationFd);
    return { size: position, sha256: hash.digest('hex') };
  } finally {
    fs.closeSync(destinationFd);
    fs.closeSync(sourceFd);
  }
}

function stableDatabaseCopy(databasePath, stateDir, snapshotDirectoryPath, phase) {
  const staging = path.join(snapshotDirectoryPath, `${phase}-sqlite-source`);
  fs.mkdirSync(staging, { mode: 0o700 });
  const sourceNames = [
    [databasePath, 'source.sqlite', 'database source'],
    [`${databasePath}-wal`, 'source.sqlite-wal', 'database sidecar -wal'],
    [`${databasePath}-shm`, 'source.sqlite-shm', 'database sidecar -shm'],
  ];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const name of fs.readdirSync(staging)) fs.rmSync(path.join(staging, name), { force: true });
    const copied = [];
    for (const [source, name, label] of sourceNames) {
      try {
        copied.push({ source, name, fingerprint: copyContainedFile(source, stateDir, path.join(staging, name), label) });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    let stable = true;
    for (const item of copied) {
      const verification = path.join(staging, `${item.name}.verify`);
      const current = copyContainedFile(item.source, stateDir, verification, `verification for ${item.name}`);
      fs.rmSync(verification);
      if (JSON.stringify(current) !== JSON.stringify(item.fingerprint)) stable = false;
    }
    const copiedSources = new Set(copied.map((item) => item.source));
    for (const [source] of sourceNames) {
      if (!copiedSources.has(source) && fs.existsSync(source)) stable = false;
    }
    if (stable) return { staging, databasePath: path.join(staging, 'source.sqlite') };
  }
  fs.rmSync(staging, { recursive: true, force: true });
  throw new Error('SQLite source changed while taking a read-only byte snapshot');
}

function sqliteRows(databasePath, sql) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

function tableExists(databasePath, table) {
  return sqliteRows(databasePath,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table.replaceAll("'", "''")}'`).length === 1;
}

function systemTokens(databasePath) {
  if (!tableExists(databasePath, 'tamandua_stats')) return { value: null, table_present: false };
  const rows = sqliteRows(databasePath, 'SELECT system_tokens_spent FROM tamandua_stats ORDER BY rowid');
  return {
    table_present: true,
    rows: rows.map((row) => ({ system_tokens_spent: row.system_tokens_spent })),
    value: rows.reduce((sum, row) => sum + Number(row.system_tokens_spent ?? 0), 0),
  };
}

function readEvents(stateDir, runIds) {
  const eventsDir = path.join(stateDir, 'events');
  if (!fs.existsSync(eventsDir)) return [];
  const paths = fs.readdirSync(eventsDir).filter((name) => /^all\.jsonl(?:\.[1-3])?$/.test(name)).sort();
  const selected = [];
  for (const name of paths) {
    const file = path.join(eventsDir, name);
    assertContainedFile(file, stateDir, 'event source');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.trim() === '') return;
      let event;
      try { event = JSON.parse(line); } catch (error) {
        throw new Error(`event source ${name}:${index + 1} contains malformed JSON: ${error.message}`);
      }
      const identifiers = [event.runId, event.run_id, event.parentRunId, event.childRunId, ...(event.candidateRunIds ?? [])]
        .filter((value) => typeof value === 'string')
        .map((value) => value.startsWith('run-') ? value : `run-${value}`);
      if (!identifiers.some((value) => runIds.has(value))) return;
      const projected = Object.fromEntries(Object.entries(event)
        .filter(([key, value]) => MECHANICAL_EVENT_FIELDS.has(key)
          && (value === null || ['string', 'number', 'boolean'].includes(typeof value)
            || (STRING_ARRAY_EVENT_FIELDS.has(key) && Array.isArray(value)
              && value.every((item) => typeof item === 'string')))));
      selected.push({ archive: name, line: index + 1, event: projected });
    });
  }
  return selected;
}

function eventsMatching(events, predicate) {
  return events.filter((row) => predicate(String(row.event.event ?? row.event.type ?? '')));
}

function requiredEventString(event, key, label) {
  if (typeof event[key] !== 'string' || event[key].length === 0) throw new Error(`${label}.${key} must be nonempty`);
  return event[key];
}

function requiredEventStringArray(event, key, label) {
  if (!Array.isArray(event[key]) || event[key].some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error(`${label}.${key} must be an array of nonempty strings`);
  }
  return event[key];
}

// S22B (US-002): submit rejections and expects validations derive attempt
// numbers from ONE shared per-claim counter that spans BOTH event streams in
// chronological order. The previous code kept an independent per-stream
// counter, so on any rejected->accepted->rejected sequence the same physical
// attempt received different attempt numbers in submit_rejections vs
// expects_validations (one physical event double-flagged as
// O11_REJECTION_VALIDATION_MISMATCH / O11_REJECTION_WITHOUT_VALIDATION).
//
// Counting model (one physical attempt = one submission):
//   - a `step.submit.rejected` event STARTS a new attempt (counter + 1);
//   - the `step.expects.validated` (outcome 'rejected') event that the
//     submit-time validator emits immediately after a rejection COMPLETES
//     that same attempt and shares its attempt number (the two events are
//     consecutive in the same code path, so pairing by "next validation after
//     a rejection for the same claim" is exact);
//   - an `step.expects.validated` (outcome 'accepted') event starts AND
//     completes a new attempt (counter + 1).
// An explicit event.attemptNumber still wins when present (and re-seeds the
// shared counter so subsequent synthesized attempts stay consistent).
function projectSubmissionAttempts(events) {
  const attempts = new Map();
  const awaitingRejectedValidation = new Set();
  const rejections = [];
  const validations = [];
  for (const wrapper of events) {
    const event = wrapper.event;
    const name = String(event.event ?? event.type ?? '');
    if (name === 'step.submit.rejected') {
      const label = `step.submit.rejected ${wrapper.archive}:${wrapper.line}`;
      const attemptNumber = event.attemptNumber ?? ((attempts.get(event.claimId) ?? 0) + 1);
      if (!Number.isSafeInteger(attemptNumber) || attemptNumber <= 0) throw new Error(`${label}.attemptNumber must be positive`);
      attempts.set(event.claimId, attemptNumber);
      awaitingRejectedValidation.add(event.claimId);
      rejections.push({
        id: requiredEventString(event, 'recordId', label), observed_at: requiredEventString(event, 'ts', label),
        run_id: requiredEventString(event, 'runId', label), step_row_id: requiredEventString(event, 'stepRowId', label),
        step_id: requiredEventString(event, 'stepId', label), claim_id: requiredEventString(event, 'claimId', label),
        attempt_number: attemptNumber, validation_code: requiredEventString(event, 'validationCode', label),
        missing_keys: requiredEventStringArray(event, 'missingKeys', label),
        invalid_keys: requiredEventStringArray(event, 'invalidKeys', label),
        diagnostic_code: requiredEventString(event, 'diagnosticCode', label),
      });
    } else if (name === 'step.expects.validated') {
      const label = `step.expects.validated ${wrapper.archive}:${wrapper.line}`;
      let attemptNumber;
      if (event.attemptNumber != null) {
        attemptNumber = event.attemptNumber;
        attempts.set(event.claimId, attemptNumber);
        awaitingRejectedValidation.delete(event.claimId);
      } else if (event.outcome === 'rejected' && awaitingRejectedValidation.has(event.claimId)) {
        // Completes the attempt started by the immediately-preceding submit
        // rejection for this claim: the SAME physical attempt, so the SAME
        // attempt number in both artifacts.
        attemptNumber = attempts.get(event.claimId);
        awaitingRejectedValidation.delete(event.claimId);
      } else {
        attemptNumber = (attempts.get(event.claimId) ?? 0) + 1;
        attempts.set(event.claimId, attemptNumber);
        awaitingRejectedValidation.delete(event.claimId);
      }
      if (!Number.isSafeInteger(attemptNumber) || attemptNumber <= 0) throw new Error(`${label}.attemptNumber must be positive`);
      if (typeof event.expectsRequired !== 'boolean') throw new Error(`${label}.expectsRequired must be boolean`);
      const missingKeys = requiredEventStringArray(event, 'missingKeys', label);
      const producer = event.producerStepRowId === null ? null : requiredEventString(event, 'producerStepRowId', label);
      validations.push({
        id: requiredEventString(event, 'recordId', label), observed_at: requiredEventString(event, 'ts', label),
        run_id: requiredEventString(event, 'runId', label), step_row_id: requiredEventString(event, 'stepRowId', label),
        step_id: requiredEventString(event, 'stepId', label), claim_id: requiredEventString(event, 'claimId', label),
        attempt_number: attemptNumber, outcome: requiredEventString(event, 'outcome', label),
        verdict: event.verdict === null ? null : requiredEventString(event, 'verdict', label),
        expects_required: event.expectsRequired, required_keys: requiredEventStringArray(event, 'requiredKeys', label),
        missing_keys: missingKeys, invalid_keys: requiredEventStringArray(event, 'invalidKeys', label),
        key_sources: missingKeys.map((key) => ({ key, producer_step_row_id: producer })),
        diagnostic_code: requiredEventString(event, 'diagnosticCode', label),
        transition: {
          action: requiredEventString(event, 'transitionAction', label),
          target_step_row_id: requiredEventString(event, 'transitionTargetStepRowId', label),
        },
      });
    }
  }
  return { rejections, validations };
}

export function projectSubmitRejections(events) {
  return projectSubmissionAttempts(events).rejections;
}

export function projectExpectsValidations(events) {
  return projectSubmissionAttempts(events).validations;
}

export function projectDispatchRenderings(events) {
  return eventsMatching(events, (name) => name === 'dispatch.render.validated' || name === 'dispatch.keys.rejected').map((wrapper) => {
    const event = wrapper.event;
    const label = `${event.event} ${wrapper.archive}:${wrapper.line}`;
    if (!Number.isSafeInteger(event.unresolvedPlaceholderCount) || event.unresolvedPlaceholderCount < 0) throw new Error(`${label}.unresolvedPlaceholderCount must be non-negative`);
    return {
      id: requiredEventString(event, 'recordId', label), observed_at: requiredEventString(event, 'ts', label),
      run_id: requiredEventString(event, 'runId', label), step_row_id: requiredEventString(event, 'stepRowId', label),
      step_id: requiredEventString(event, 'stepId', label), claim_id: requiredEventString(event, 'claimId', label),
      required_keys: requiredEventStringArray(event, 'requiredKeys', label),
      unresolved_placeholder_count: event.unresolvedPlaceholderCount,
      unresolved_keys: requiredEventStringArray(event, 'unresolvedKeys', label),
      dispatched: event.dispatched !== false,
      producer_step_row_id: event.producerStepRowId ?? null,
      transition: event.transitionAction === undefined ? null : {
        action: requiredEventString(event, 'transitionAction', label),
        target_step_row_id: requiredEventString(event, 'transitionTargetStepRowId', label),
      },
    };
  });
}

// S20 (US-001): target-ref reflog lines are parsed with an OPTIONAL
// \t<message> tail. The landing update-ref writes message-less entries
// ("<old> <new> <identity> <ts> <tz>"), which the previous regex rejected
// because it required the tab-terminated message segment — every real
// landing transition was then archived raw-only and O2_REF_TRANSITION_COUNT
// could never see it. The before/after OIDs, identity, timestamp and
// timezone are all present in a message-less line and parse exactly as
// before; only the message tail is absent (action stays absent for such
// lines, empty for a trailing-tab line). Truly unparseable lines are still
// archived as { raw: <line> }.
export function parseTargetReflogLine(line) {
  const match = /^(\S+) (\S+) (.+?) (\d+) ([+-]\d{4})(?:\t(.*))?$/.exec(line);
  if (match === null) return { raw: line };
  return {
    old_oid: match[1],
    new_oid: match[2],
    actor: match[3],
    timestamp: Number(match[4]),
    timezone: match[5],
    ...(match[6] === undefined ? {} : { action: match[6] }),
    raw: line,
  };
}

function projectRoundUsage(input, events) {
  const rows = eventsMatching(events, (name) => name === 'harness.usage.captured').map((wrapper) => {
    const event = wrapper.event;
    const harness = event.harness;
    const formulaInputs = harness === 'hermes' ? {
      input: event.inputTokens,
      output: event.outputTokens,
      cache_read: event.cacheReadTokens,
      cache_write: event.cacheWriteTokens,
      reasoning: event.reasoningTokens,
    } : harness === 'scripted' ? {
      synthetic_tokens: event.totalTokens,
    } : {
      input: event.inputTokens,
      output: event.outputTokens,
      cache_read: event.cacheReadTokens,
      cache_write: event.cacheWriteTokens,
      total: event.totalTokens ?? null,
    };
    return {
      id: event.usageId,
      run_id: event.runId ?? event.run_id ?? null,
      step_id: event.stepId ?? null,
      round_id: event.roundId ?? event.round_id ?? null,
      harness,
      session_id: event.sessionId ?? null,
      started_at: event.startedAt,
      finished_at: event.finishedAt,
      candidate_run_ids: event.candidateRunIds ?? [],
      formula_inputs: formulaInputs,
    };
  });
  const declared = input.caseRecord.chaos?.synthetic_token_ledger;
  const syntheticLedger = Array.isArray(declared) ? declared.map((row) => ({
    run_id: row.run_id,
    expected_tokens: row.expected_tokens,
  })) : [];
  return { rows, synthetic_ledger: syntheticLedger };
}

function validateJunkProbePath(repositoryPath, probePath) {
  if (typeof probePath !== 'string' || probePath.length === 0 || path.posix.isAbsolute(probePath)
    || probePath.includes('\\') || probePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('special-exit junk probe path must be a safe repository-relative POSIX path');
  }
  const absolute = path.resolve(repositoryPath, probePath);
  if (!pathIsWithin(fs.realpathSync(repositoryPath), absolute)) throw new Error('special-exit junk probe escaped fixture repository');
  const details = fs.lstatSync(absolute);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('special-exit junk probe must be a regular non-symlink file');
}

function suiteObservationKey(input, suiteRows, event) {
  if (typeof event.originRepo === 'string' && typeof event.cmdHash === 'string'
      && typeof event.treeHash === 'string') {
    const mechanicalMatches = suiteRows.filter((row) => row.origin_repo === event.originRepo
      && row.cmd_hash === event.cmdHash && typeof row.tree_hash === 'string'
      && row.tree_hash.startsWith(event.treeHash));
    if (mechanicalMatches.length > 0) {
      const row = mechanicalMatches.toSorted((left, right) =>
        String(right.created_at).localeCompare(String(left.created_at)) || Number(right.id) - Number(left.id))[0];
      return { origin_repo: row.origin_repo, tree_hash: row.tree_hash, cmd_hash: row.cmd_hash };
    }
  }
  const gateKey = launchGateKey(input.caseRecord, input.repositoryPath);
  if (gateKey === null) return null;
  const prefix = typeof event.treeHash === 'string' ? event.treeHash : '';
  const candidates = suiteRows.filter((row) => row.origin_repo === gateKey.origin_repo
    && row.cmd_hash === gateKey.cmd_hash
    && typeof row.tree_hash === 'string' && row.tree_hash.startsWith(prefix));
  const treeHash = candidates.length > 0
    ? candidates.toSorted((left, right) => String(right.created_at).localeCompare(String(left.created_at)) || Number(right.id) - Number(left.id))[0].tree_hash
    : git(input.repositoryPath, ['rev-parse', 'HEAD^{tree}']).trim();
  return { origin_repo: gateKey.origin_repo, tree_hash: treeHash, cmd_hash: gateKey.cmd_hash };
}

function projectSuiteObservations(input, suiteRows, events) {
  const rows = [];
  const append = (invocationId, phase, observedAt, key, extra = {}) => rows.push({
    id: `suite-observation-${rows.length + 1}`,
    invocation_id: invocationId,
    sequence: rows.length + 1,
    phase,
    observed_at: observedAt,
    ...key,
    force: extra.force ?? false,
    run_id: extra.run_id ?? null,
    step_id: extra.step_id ?? null,
    ...extra,
  });
  for (const wrapper of eventsMatching(events, (name) => name === 'suite.cache_hit' || name === 'suite.executed')) {
    const event = wrapper.event;
    if (typeof event.ts !== 'string') continue;
    const key = suiteObservationKey(input, suiteRows, event);
    if (key === null) continue;
    const eventRunId = typeof event.runId === 'string' ? event.runId : null;
    const eventStepId = typeof event.stepId === 'string' ? event.stepId : null;
    const invocationId = `${wrapper.archive}:${wrapper.line}`;
    if (event.event === 'suite.cache_hit') {
      const candidates = suiteRows.filter((row) => row.origin_repo === key.origin_repo
        && row.tree_hash === key.tree_hash && row.cmd_hash === key.cmd_hash && row.exit_code === 0
        && String(row.created_at) <= event.ts
        && (typeof event.savedDurationMs !== 'number' || row.duration_ms === event.savedDurationMs));
      const prior = candidates.toSorted((left, right) => String(right.created_at).localeCompare(String(left.created_at)) || Number(right.id) - Number(left.id))[0];
      append(invocationId, 'lookup', event.ts, key, {
        run_id: eventRunId, step_id: eventStepId, force: event.force === true,
        latest_row_id: prior?.id ?? null,
      });
      append(invocationId, 'replay', event.ts, key, {
        run_id: eventRunId, step_id: eventStepId, force: event.force === true,
        ledger_row_id: prior?.id ?? null,
        marker: 'TAMANDUA-TEST CACHED', exit_code: 0, committed_tree_hash: key.tree_hash,
      });
      continue;
    }
    const recorded = suiteRows.find((row) => row.origin_repo === key.origin_repo
      && row.tree_hash === key.tree_hash && row.cmd_hash === key.cmd_hash
      && row.run_id === eventRunId && row.step_id === eventStepId && row.created_at === event.ts
      && row.duration_ms === event.durationMs && row.exit_code === event.exitCode);
    if (recorded === undefined || !Number.isSafeInteger(event.durationMs) || !Number.isSafeInteger(event.exitCode)) continue;
    const startedAt = new Date(new Date(event.ts).valueOf() - event.durationMs).toISOString();
    const prior = suiteRows.filter((row) => row.origin_repo === key.origin_repo
      && row.tree_hash === key.tree_hash && row.cmd_hash === key.cmd_hash && row.created_at < startedAt)
      .toSorted((left, right) => String(right.created_at).localeCompare(String(left.created_at)) || Number(right.id) - Number(left.id))[0];
    append(invocationId, 'lookup', startedAt, key, {
      run_id: eventRunId, step_id: eventStepId, force: event.force === true,
      latest_row_id: prior?.id ?? null,
    });
    append(invocationId, 'execute', event.ts, key, {
      run_id: eventRunId, step_id: eventStepId, force: event.force === true, started_at: startedAt,
      pre_tree_hash: key.tree_hash, post_tree_hash: key.tree_hash, exit_code: event.exitCode,
    });
    append(invocationId, 'record', event.ts, key, {
      run_id: eventRunId, step_id: eventStepId, force: event.force === true,
      ledger_row_id: recorded.id, exit_code: event.exitCode,
    });
  }
  const identityRows = [...new Set([
    ...suiteRows.map((row) => row.origin_repo),
    ...events.map((wrapper) => wrapper.event.originRepo),
  ].filter((origin) => typeof origin === 'string' && origin.length > 0))]
    .sort().map((origin) => ({ origin_repo: origin, normalized_origin_repo: path.normalize(origin) }));
  const eventKey = (event) => {
    if (typeof event.originRepo === 'string' && typeof event.treeHash === 'string' && typeof event.cmdHash === 'string') {
      const treeMatches = suiteRows.filter((row) => row.origin_repo === event.originRepo && row.cmd_hash === event.cmdHash && row.tree_hash.startsWith(event.treeHash));
      if (treeMatches.length === 1) return { origin_repo: event.originRepo, tree_hash: treeMatches[0].tree_hash, cmd_hash: event.cmdHash };
    }
    return suiteObservationKey(input, suiteRows, event);
  };
  const eventInvocation = (event) => `${String(event.runId ?? '')}:${String(event.stepId ?? '')}`;
  const eventTime = (wrapper) => new Date(String(wrapper.event.ts)).valueOf();
  const waits = eventsMatching(events, (name) => name === 'suite.claim_wait' || name === 'suite.singleflight_wait');
  const grants = eventsMatching(events, (name) => name === 'suite.claim_granted');
  const reclaims = eventsMatching(events, (name) => name === 'suite.claim_dead_owner_reclaimed');
  const releases = eventsMatching(events, (name) => name === 'suite.claim_owner_released');
  const executionStarts = eventsMatching(events, (name) => name === 'suite.execute_started');
  const singleflightObservations = [];
  for (const [index, grantWrapper] of grants.entries()) {
    const grant = grantWrapper.event;
    const key = eventKey(grant);
    const ownerId = `${String(grant.ownerRunId ?? grant.runId ?? '')}:${String(grant.ownerStepId ?? grant.stepId ?? '')}`;
    if (key === null || ownerId === ':') continue;
    const sameKey = (wrapper) => JSON.stringify(eventKey(wrapper.event)) === JSON.stringify(key);
    let ownedWaits = waits.filter((wrapper) => sameKey(wrapper)
      && eventTime(wrapper) >= eventTime(grantWrapper)
      && (wrapper.event.ownerRunId === undefined || `${String(wrapper.event.ownerRunId)}:${String(wrapper.event.ownerStepId ?? '')}` === ownerId));
    if (ownedWaits.length === 0) {
      const immediateReclaim = reclaims.find((wrapper) => sameKey(wrapper)
        && eventTime(wrapper) >= eventTime(grantWrapper)
        && `${String(wrapper.event.ownerRunId ?? '')}:${String(wrapper.event.ownerStepId ?? '')}` === ownerId
        && eventInvocation({
          runId: wrapper.event.reclaimerRunId ?? wrapper.event.runId,
          stepId: wrapper.event.reclaimerStepId ?? wrapper.event.stepId,
        }) !== ':');
      if (immediateReclaim !== undefined) {
        ownedWaits = [{
          ...immediateReclaim,
          event: {
            ...immediateReclaim.event,
            runId: immediateReclaim.event.reclaimerRunId ?? immediateReclaim.event.runId,
            stepId: immediateReclaim.event.reclaimerStepId ?? immediateReclaim.event.stepId,
          },
        }];
      }
    }
    if (ownedWaits.length === 0) continue;
    const waiterIds = [...new Set(ownedWaits.map((wrapper) => eventInvocation(wrapper.event)).filter((id) => id !== ':'))];
    if (waiterIds.length === 0) continue;
    const ownerStart = executionStarts.find((wrapper) => sameKey(wrapper)
      && eventInvocation(wrapper.event) === ownerId && eventTime(wrapper) >= eventTime(grantWrapper));
    if (ownerStart === undefined) throw new Error(`single-flight owner ${ownerId} lacks a mechanically captured suite.execute_started event`);
    const lastWaitTime = Math.max(...ownedWaits.map(eventTime));
    const reclaimWrapper = reclaims.find((wrapper) => sameKey(wrapper) && eventTime(wrapper) >= lastWaitTime
      && String(wrapper.event.ownerRunId ?? '') === String(grant.ownerRunId ?? grant.runId ?? ''));
    const releaseWrapper = releases.find((wrapper) => sameKey(wrapper) && eventTime(wrapper) >= lastWaitTime
      && String(wrapper.event.ownerRunId ?? '') === String(grant.ownerRunId ?? grant.runId ?? ''));
    const recovery = reclaimWrapper !== undefined ? 'dead_owner' : releaseWrapper !== undefined ? 'stop_cancel' : null;
    const timeline = [{
      type: 'execute_started', observed_at: ownerStart.event.startedAt ?? ownerStart.event.ts,
      invocation_id: ownerId, owner_pid: grant.ownerPid,
    }];
    for (const wrapper of ownedWaits) timeline.push({ type: 'wait', observed_at: wrapper.event.ts, invocation_id: eventInvocation(wrapper.event) });
    if (reclaimWrapper) timeline.push({
      type: 'dead_owner_reclaimed', observed_at: reclaimWrapper.event.ts,
      invocation_id: eventInvocation(reclaimWrapper.event), owner_pid: reclaimWrapper.event.ownerPid,
      reclaimer_pid: reclaimWrapper.event.reclaimerPid,
    });
    if (releaseWrapper) timeline.push({
      type: 'owner_released', observed_at: releaseWrapper.event.ts, invocation_id: ownerId,
      reason: releaseWrapper.event.releaseReason,
    });
    const ownerRecord = events.find((wrapper) => wrapper.event.event === 'suite.executed' && sameKey(wrapper)
      && eventInvocation(wrapper.event) === ownerId && Number.isSafeInteger(wrapper.event.ledgerRowId));
    if (ownerRecord) timeline.push({
      type: 'record', observed_at: ownerRecord.event.ts, invocation_id: ownerId,
      ledger_row_id: ownerRecord.event.ledgerRowId,
    });
    for (const waiterId of waiterIds) {
      const waitTime = eventTime(ownedWaits.find((wrapper) => eventInvocation(wrapper.event) === waiterId));
      const replay = events.find((wrapper) => wrapper.event.event === 'suite.cache_hit' && sameKey(wrapper)
        && eventInvocation(wrapper.event) === waiterId && eventTime(wrapper) >= waitTime && Number.isSafeInteger(wrapper.event.ledgerRowId));
      const execute = executionStarts.find((wrapper) => sameKey(wrapper)
        && eventInvocation(wrapper.event) === waiterId && eventTime(wrapper) >= waitTime);
      if (replay) timeline.push({ type: 'replay', observed_at: replay.event.ts, invocation_id: waiterId, ledger_row_id: replay.event.ledgerRowId });
      else if (execute) timeline.push({ type: 'execute_started', observed_at: execute.event.startedAt ?? execute.event.ts, invocation_id: waiterId });
    }
    timeline.sort((left, right) => new Date(left.observed_at).valueOf() - new Date(right.observed_at).valueOf());
    singleflightObservations.push({
      id: `singleflight-${index + 1}`, key, owner_invocation_id: ownerId,
      waiter_invocation_ids: waiterIds, configured_recovery_bound_ms: 30 * 60 * 1000,
      recovery, events: timeline,
    });
  }
  const specialExitObservations = [];
  for (const wrapper of eventsMatching(events, (name) => name === 'suite.special_exit_observed')) {
    const event = wrapper.event;
    if (typeof event.originRepo !== 'string' || typeof event.treeHash !== 'string'
      || typeof event.cmdHash !== 'string' || typeof event.preTreeHash !== 'string'
      || typeof event.postTreeHash !== 'string' || ![86, 87, 88].includes(event.shimExitCode)
      || (event.commandExitCode !== null && !Number.isSafeInteger(event.commandExitCode))
      || (event.ledgerRowId !== null && !Number.isSafeInteger(event.ledgerRowId))
      || typeof event.interrupted !== 'boolean' || typeof event.trackedDirty !== 'boolean'
      || typeof event.junkProbeTracked !== 'boolean') {
      throw new Error('suite.special_exit_observed lacks complete mechanical process/tree evidence');
    }
    validateJunkProbePath(input.repositoryPath, event.junkProbePath);
    specialExitObservations.push({
      invocation_id: eventInvocation(event), origin_repo: event.originRepo, tree_hash: event.treeHash,
      cmd_hash: event.cmdHash, observed_at: event.ts, shim_exit_code: event.shimExitCode,
      command_exit_code: event.commandExitCode, pre_tree_hash: event.preTreeHash,
      post_tree_hash: event.postTreeHash, ledger_row_id: event.ledgerRowId,
      interrupted: event.interrupted, tracked_dirty: event.trackedDirty,
      junk_probe_path: event.junkProbePath, junk_probe_tracked: event.junkProbeTracked,
    });
  }
  return {
    schema_version: 1, captured_at: utcTimestamp(), ttl_green_ms: 24 * 60 * 60 * 1000, rows,
    singleflight_observations: singleflightObservations,
    special_exit_observations: specialExitObservations,
    origin_identities: identityRows,
  };
}

function safeContextPolicy(caseRecord) {
  return {
    merge_gate: Object.hasOwn(caseRecord.context, 'merge_gate') ? caseRecord.context.merge_gate : null,
    fail_missing: Object.hasOwn(caseRecord.context, 'fail_missing') ? caseRecord.context.fail_missing : null,
    execution_mode: Object.hasOwn(caseRecord.context, 'execution_mode') ? caseRecord.context.execution_mode : null,
  };
}

function projectLaunchArgv(argv) {
  const projected = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    projected.push(argument);
    if (argument !== '--context' || index + 1 >= argv.length) continue;
    const contextArgument = argv[index + 1];
    const separator = contextArgument.indexOf('=');
    const key = separator < 0 ? contextArgument : contextArgument.slice(0, separator);
    const value = separator < 0 ? '' : contextArgument.slice(separator + 1);
    projected.push(['merge_gate', 'fail_missing'].includes(key)
      ? contextArgument
      : `${key}=sha256:${sha256(value)}`);
    index += 1;
  }
  return {
    argv: projected,
    argv_sha256: sha256(JSON.stringify(argv)),
  };
}

function snapshotDirectory(input) {
  return path.join(input.campaignDir, 'snapshots', input.caseRecord.id, input.attempt.id);
}

function validateInput(input) {
  const ttRoot = fs.realpathSync(input.ttRoot);
  const campaignDir = assertContainedDirectory(input.campaignDir, ttRoot, 'campaign directory');
  const stateDir = assertContainedDirectory(input.stateDir, ttRoot, 'controller-provided TT state');
  const databasePath = assertContainedFile(input.databasePath, stateDir, 'database source');
  for (const suffix of ['-wal', '-shm']) {
    try {
      assertContainedFile(`${databasePath}${suffix}`, stateDir, `database sidecar ${suffix}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const repositoryPath = assertContainedDirectory(input.repositoryPath, ttRoot, 'fixture repository');
  git(repositoryPath, ['rev-parse', '--git-dir']);
  return { ...input, ttRoot, campaignDir, stateDir, databasePath, repositoryPath };
}

function immutable(file) {
  fs.chmodSync(file, 0o400);
}

function markInfrastructure(ledgerPath, ledger, message) {
  const failed = { ...ledger, status: 'TEST_INFRA', failed_at: utcTimestamp(), error: message };
  replaceJson(ledgerPath, failed);
  immutable(ledgerPath);
  return failed;
}

export function beginOracleEvidenceSnapshot(rawInput) {
  const input = validateInput(rawInput);
  const snapshot = openSnapshotDirectory(input.campaignDir, input.caseRecord.id, input.attempt.id);
  const directory = snapshot.fdPath;
  const ledgerPath = path.join(directory, 'snapshot.json');
  if (fs.existsSync(ledgerPath)) {
    const prior = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (prior.status !== 'COMPLETE') {
      if ((fs.statSync(ledgerPath).mode & 0o200) === 0) fs.chmodSync(ledgerPath, 0o600);
      markInfrastructure(ledgerPath, prior, 'interrupted or partial snapshot cannot be resumed');
      closeSnapshotDirectory(snapshot);
      throw new Error('interrupted snapshot classified TEST_INFRA');
    }
    closeSnapshotDirectory(snapshot);
    throw new Error('oracle evidence snapshot already exists');
  }
  const capturedAt = utcTimestamp();
  const ledger = {
    schema_version: 1,
    status: 'RUNNING',
    case_id: input.caseRecord.id,
    attempt_id: input.attempt.id,
    run_id: input.attempt.run_id ?? null,
    started_at: capturedAt,
    files: {},
  };
  writeJsonExclusive(ledgerPath, ledger);
  try {
    const launchIntentPath = path.join(directory, 'launch-intent.json');
    const launchArgv = projectLaunchArgv(input.launchArgv);
    writeJsonExclusive(launchIntentPath, {
      schema_version: 1,
      captured_at: capturedAt,
      case_id: input.caseRecord.id,
      workflow: input.caseRecord.workflow,
      fixture: input.caseRecord.fixture,
      harness: input.caseRecord.harness,
      execution_mode: input.attempt.execution_mode,
      repository: repositoryIdentity(input.repositoryPath, input.ttRoot),
      policy: safeContextPolicy(input.caseRecord),
      gate_key: launchGateKey(input.caseRecord, input.repositoryPath),
      ...launchArgv,
      launch_intent_at: input.attempt.launch_intent_at,
    });
    const refsBeforePath = path.join(directory, 'refs-before.json');
    writeJsonExclusive(refsBeforePath, captureRefs(input.repositoryPath, input.ttRoot, 'before'));
    const checksumBaselinePath = path.join(directory, 'checksum-baseline.json');
    writeJsonExclusive(checksumBaselinePath, captureChecksums(input.repositoryPath, input.caseRecord, 'baseline'));
    const systemBeforePath = path.join(directory, 'system-tokens-before.json');
    const baselineDatabase = stableDatabaseCopy(input.databasePath, input.stateDir, directory, 'baseline');
    writeJsonExclusive(systemBeforePath, {
      schema_version: 1, captured_at: capturedAt, ...systemTokens(baselineDatabase.databasePath),
    });
    fs.rmSync(baselineDatabase.staging, { recursive: true, force: true });

    const references = {
      launch_intent: referenceFor(input.campaignDir, launchIntentPath, capturedAt, 'controller-launch-intent'),
      refs_before: referenceFor(input.campaignDir, refsBeforePath, capturedAt, 'git-plumbing-before'),
      checksum_baseline: referenceFor(input.campaignDir, checksumBaselinePath, capturedAt, 'filesystem-baseline'),
      system_tokens_before: referenceFor(input.campaignDir, systemBeforePath, capturedAt, 'sqlite-readonly-before'),
    };
    for (const file of [launchIntentPath, refsBeforePath, checksumBaselinePath, systemBeforePath]) immutable(file);
    const complete = { ...ledger, status: 'BASELINE_CAPTURED', baseline_captured_at: capturedAt, files: references };
    replaceJson(ledgerPath, complete);
    return {
      status: complete.status,
      ledger_path: portableRelative(input.campaignDir, fs.realpathSync(ledgerPath)),
      references,
    };
  } catch (error) {
    markInfrastructure(ledgerPath, ledger, error.message);
    closeSnapshotDirectory(snapshot);
    throw error;
  }
}

export function completeOracleEvidenceSnapshot(rawInput, baseline) {
  const input = validateInput(rawInput);
  const logicalDirectory = snapshotDirectory(input);
  const snapshot = activeSnapshotDirectory(logicalDirectory);
  const persistedLedgerPath = path.join(input.campaignDir, baseline.ledger_path);
  assertContainedFile(persistedLedgerPath, input.campaignDir, 'snapshot ledger');
  if (snapshot === null) {
    let interrupted = JSON.parse(fs.readFileSync(persistedLedgerPath, 'utf8'));
    if ((fs.statSync(persistedLedgerPath).mode & 0o200) === 0) fs.chmodSync(persistedLedgerPath, 0o600);
    interrupted = markInfrastructure(
      persistedLedgerPath, interrupted, 'controller interruption invalidated the open snapshot transaction',
    );
    throw new Error(`interrupted snapshot is ${interrupted.status} and cannot produce PASS`);
  }
  const directory = snapshot.fdPath;
  const ledgerPath = path.join(directory, 'snapshot.json');
  if (fs.realpathSync(ledgerPath) !== fs.realpathSync(persistedLedgerPath)) {
    closeSnapshotDirectory(snapshot);
    throw new Error('snapshot ledger identity changed before completion');
  }
  let ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  if (baseline.status !== 'BASELINE_CAPTURED' || ledger.status !== 'BASELINE_CAPTURED') {
    if ((fs.statSync(ledgerPath).mode & 0o200) === 0) fs.chmodSync(ledgerPath, 0o600);
    markInfrastructure(ledgerPath, ledger, 'interrupted or partial snapshot cannot produce a verdict');
    closeSnapshotDirectory(snapshot);
    throw new Error('interrupted snapshot classified TEST_INFRA and cannot produce PASS');
  }
  const capturedAt = utcTimestamp();
  ledger = { ...ledger, status: 'RUNNING', terminal_capture_started_at: capturedAt };
  replaceJson(ledgerPath, ledger);
  try {
    const files = {};
    const emitJson = (key, filename, value, source) => {
      const file = path.join(directory, filename);
      writeJsonExclusive(file, value);
      files[key] = referenceFor(input.campaignDir, file, capturedAt, source);
      immutable(file);
    };

    const terminalDatabase = stableDatabaseCopy(input.databasePath, input.stateDir, directory, 'terminal');
    const stagedDatabaseSnapshot = path.join(terminalDatabase.staging, 'snapshot.sqlite');
    const databaseSnapshot = path.join(directory, 'database.sqlite');
    run('sqlite3', ['-readonly', terminalDatabase.databasePath, `.backup '${stagedDatabaseSnapshot.replaceAll("'", "''")}'`], {
      cwd: input.ttRoot,
    });
    fs.renameSync(stagedDatabaseSnapshot, databaseSnapshot);
    fs.rmSync(terminalDatabase.staging, { recursive: true, force: true });
    files.database_snapshot = referenceFor(input.campaignDir, databaseSnapshot, capturedAt, 'sqlite3-readonly-backup');
    immutable(databaseSnapshot);

    const runIds = new Set([input.attempt.run_id, ...(input.discoveredRuns ?? []).map((run) => run.run_id)].filter(Boolean));
    // E3.C US-011: a multi-run probe attempt's per-run run ids live in the
    // probe-evidence artifact (W3.20's two runs, W3.22's three) — include them
    // so the event slice covers EVERY probed run (O16's cancel/restart
    // judgments read per-run events; without this only the primary run's
    // events land and the other runs' terminal events are invisible).
    try {
      const probeEvidence = JSON.parse(fs.readFileSync(
        path.join(input.campaignDir, 'evidence', input.caseRecord.id, input.attempt.id, 'probe-evidence.json'),
        'utf8',
      ));
      if (probeEvidence && typeof probeEvidence.run_id === 'string') runIds.add(probeEvidence.run_id);
      for (const run of probeEvidence?.runs ?? []) {
        if (run && typeof run.run_id === 'string') runIds.add(run.run_id);
      }
    } catch {
      // absent/unreadable probe evidence: fall back to attempt + discovered runs
    }
    const events = readEvents(input.stateDir, runIds);
    emitJson('run_events', 'run-events.json', { schema_version: 1, captured_at: capturedAt, run_ids: [...runIds].sort(), rows: events }, 'controller-event-slice');
    emitJson('workflow_status', 'workflow-status.json', {
      schema_version: 1, captured_at: capturedAt,
      root: {
        run_id: input.attempt.run_id ?? null,
        terminal_status: input.attempt.terminal_status ?? null,
        tokens_observed: input.attempt.tokens_observed ?? 0,
        steps_snapshot: input.attempt.steps_snapshot ?? null,
      },
      discovered_runs: (input.discoveredRuns ?? []).map((run) => ({
        run_id: run.run_id, parent_run_id: run.parent_run_id, terminal_status: run.terminal_status,
        tokens_observed: run.tokens_observed ?? 0, steps_snapshot: run.steps_snapshot ?? null,
      })),
    }, 'controller-workflow-status');

    const commonDir = path.resolve(
      input.repositoryPath,
      git(input.repositoryPath, ['rev-parse', '--git-common-dir']).trim(),
    );
    assertContainedDirectory(commonDir, input.ttRoot, 'repository git common directory');
    const gitSnapshotPath = path.join(directory, 'repository.git.tar');
    runToExclusiveFile('tar', ['-C', commonDir, '-cf', '-', '.'], gitSnapshotPath, input.ttRoot);
    files.git_bundle = referenceFor(
      input.campaignDir, gitSnapshotPath, capturedAt, 'git-common-dir-tar',
    );
    immutable(gitSnapshotPath);
    emitJson('refs_after', 'refs-after.json', captureRefs(input.repositoryPath, input.ttRoot, 'after'), 'git-plumbing-after');
    const refInfo = targetRefInfo(input.repositoryPath);
    const ref = refInfo.target_ref;
    // S31 (US-009): a detached-HEAD fixture's reflog lives at logs/HEAD (no
    // symbolic ref to name); the captured target identity stays the resolved
    // detached commit so refs_before/refs_after/target_reflog agree.
    const reflogRef = refInfo.detached ? 'HEAD' : ref;
    const gitDir = path.resolve(input.repositoryPath, git(input.repositoryPath, ['rev-parse', '--git-dir']).trim());
    const rawReflogPath = path.join(gitDir, 'logs', ...reflogRef.split('/'));
    let raw = '';
    if (fs.existsSync(rawReflogPath)) raw = fs.readFileSync(assertContainedFile(rawReflogPath, input.ttRoot, 'target reflog'), 'utf8');
    const entries = raw.split(/\r?\n/).filter(Boolean).map(parseTargetReflogLine);
    emitJson('target_reflog', 'target-reflog.json', {
      schema_version: 1, captured_at: capturedAt, repository: repositoryIdentity(input.repositoryPath, input.ttRoot),
      target_ref: ref, ...(refInfo.detached ? { detached_head: true } : {}), entries,
    }, 'git-raw-target-reflog');

    const baselinePath = path.join(input.campaignDir, baseline.references.checksum_baseline.path);
    const baselineChecksums = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    emitJson('checksum_terminal', 'checksum-terminal.json',
      captureChecksums(input.repositoryPath, input.caseRecord, 'terminal', baselineChecksums.entries),
      'filesystem-terminal');

    const allSuiteRows = tableExists(databaseSnapshot, 'suite_results')
      ? sqliteRows(databaseSnapshot, 'SELECT * FROM suite_results ORDER BY created_at, rowid') : [];
    const capturedGateKey = launchGateKey(input.caseRecord, input.repositoryPath);
    const suiteOrigins = new Set([
      ...(capturedGateKey === null ? [] : [capturedGateKey.origin_repo]),
      ...events.map((wrapper) => wrapper.event.originRepo).filter((origin) => typeof origin === 'string'),
    ]);
    const suiteRows = allSuiteRows.filter((row) => suiteOrigins.has(row.origin_repo));
    emitJson('suite_ledger', 'suite-ledger.json', { schema_version: 1, captured_at: capturedAt, rows: suiteRows }, 'sqlite-readonly-suite-ledger');
    emitJson('suite_observations', 'suite-observations.json', {
      ...projectSuiteObservations(input, suiteRows, events), captured_at: capturedAt,
    }, 'controller-suite-state-machine');
    emitJson('token_deltas', 'token-deltas.json', {
      schema_version: 1, captured_at: capturedAt, rows: eventsMatching(events, (name) => name === 'run.tokens.updated'),
    }, 'controller-token-events');
    emitJson('round_usage', 'round-usage.json', {
      schema_version: 1, captured_at: capturedAt,
      ...projectRoundUsage(input, events),
    }, 'controller-round-usage-events');
    emitJson('system_tokens_after', 'system-tokens-after.json', {
      schema_version: 1, captured_at: capturedAt, ...systemTokens(databaseSnapshot),
    }, 'sqlite-readonly-after');
    emitJson('submit_rejections', 'submit-rejections.json', {
      schema_version: 1, captured_at: capturedAt,
      rows: projectSubmitRejections(events),
    }, 'controller-submit-validation-events');
    emitJson('expects_validations', 'expects-validations.json', {
      schema_version: 1, captured_at: capturedAt,
      rows: projectExpectsValidations(events),
    }, 'controller-expects-events');
    emitJson('dispatch_renderings', 'dispatch-renderings.json', {
      schema_version: 1, captured_at: capturedAt,
      rows: projectDispatchRenderings(events),
    }, 'controller-dispatch-render-events');

    // E3.C optional lifecycle evidence (US-003): the probe sequencer writes a
    // per-attempt probe-evidence JSON artifact into the controller's per-attempt
    // evidence dir, and tt-chaos appends structured entries to
    // var/chaos/chaos.log. Both are copied into the immutable snapshot when
    // present; absent artifacts leave the reference null (optional for oracles
    // that do not require them, required for O4's chaos_log; O16 answers
    // NOT_EVALUABLE on a case without probe_evidence per S25).
    const captureOptionalCopy = (key, filename, sourcePath, containingRoot, source, label) => {
      if (!fs.existsSync(sourcePath)) return;
      const file = path.join(directory, filename);
      copyContainedFile(sourcePath, containingRoot, file, label);
      files[key] = referenceFor(input.campaignDir, file, capturedAt, source);
      immutable(file);
    };
    captureOptionalCopy(
      'probe_evidence', 'probe-evidence.json',
      path.join(input.campaignDir, 'evidence', input.caseRecord.id, input.attempt.id, 'probe-evidence.json'),
      input.campaignDir, 'controller-probe-sequence', 'probe evidence artifact',
    );
    const defaultChaosLogPath = path.join(input.ttRoot, 'var', 'chaos', 'chaos.log');
    const chaosLogPath = input.chaosLogPath ?? defaultChaosLogPath;
    // US-010 (O4): recorder/proc samples ride inside the chaos_log evidence
    // bundle (spec 03 O4 — the process recorder's 5s sampler is the liveness
    // provenance O4 cross-references with the chaos entries). When the recorder
    // sampled the campaign's own var/ (the chaos log sits at the DEFAULT
    // location under ttRoot — the controller pins that same path, so gate on
    // path-equality with the derivation, not on undefined-ness; a hermetic
    // chaosLogPath override elsewhere stays byte-exact), append the recorder
    // sample files to the captured chaos.log after a section marker. Both are
    // JSONL; O4 classifies lines by shape (action/outcome = chaos entry,
    // integer pid + ts = recorder sample) and skips non-JSON markers.
    const chaosLogCaptured = path.join(directory, 'chaos.log');
    if (fs.existsSync(chaosLogPath)) {
      copyContainedFile(chaosLogPath, input.ttRoot, chaosLogCaptured, 'chaos log');
      if (path.resolve(chaosLogPath) === path.resolve(defaultChaosLogPath)) {
        const recorderDir = path.join(input.ttRoot, 'var', 'recorder');
        if (fs.existsSync(recorderDir)) {
          const sampleFiles = fs.readdirSync(recorderDir)
            .filter((name) => /^samples-.+\.jsonl$/.test(name))
            .map((name) => path.join(recorderDir, name))
            .sort((left, right) => fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs);
          if (sampleFiles.length > 0) {
            const append = [
              '# recorder-samples',
              ...sampleFiles.flatMap((file) => {
                const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
                return lines.filter((line) => line.trim() !== '');
              }),
              '',
            ].join('\n');
            fs.appendFileSync(chaosLogCaptured, append);
          }
        }
      }
      files.chaos_log = referenceFor(input.campaignDir, chaosLogCaptured, capturedAt, 'tt-chaos-log');
      immutable(chaosLogCaptured);
    }

    const references = Object.fromEntries(ORACLE_EVIDENCE_KEYS.map((key) => [
      key, baseline.references[key] ?? files[key] ?? null,
    ]));
    const missing = ORACLE_EVIDENCE_KEYS.filter((key) => references[key] === null
      && !OPTIONAL_ORACLE_EVIDENCE_KEYS.includes(key));
    if (missing.length > 0) throw new Error(`partial evidence snapshot omitted: ${missing.join(', ')}`);
    const complete = {
      ...ledger,
      status: 'COMPLETE',
      completed_at: utcTimestamp(),
      files: references,
    };
    replaceJson(ledgerPath, complete);
    immutable(ledgerPath);
    const result = {
      schema_version: 1,
      status: 'COMPLETE',
      references,
      provenance: referenceFor(input.campaignDir, ledgerPath, complete.completed_at, 'controller-snapshot-ledger'),
    };
    closeSnapshotDirectory(snapshot);
    return result;
  } catch (error) {
    markInfrastructure(ledgerPath, ledger, error.message);
    closeSnapshotDirectory(snapshot);
    throw error;
  }
}
