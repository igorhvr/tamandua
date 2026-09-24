#!/usr/bin/env node
// generate-o5-fixtures.mjs — O5 calibration fixture generator.
//
// Writes one directory per fixture under a unique oracle-self-test.* workspace
// (beneath torture-test/var): sidecar.json (post-batch hygiene sidecar v1,
// see POST-BATCH-CONTRACT.md) + expectation.json. The o5.test.mjs file (and a
// serial runner) invokes the REAL oracles/O5 executable against each sidecar
// and asserts the result, exit code, finding ids and classification.
//
// Every fixture below pins one of the O5 honesty rules:
//   PASS:      clean linux census; shared toolchain <=1 at W6; shared original
//              repo path is host-admitted (never substring-guessed foreign);
//              Darwin synthetic weak layers 2-4 recorded honestly.
//   FAIL:      leftover worker / daemon; zombie; foreign-run containment;
//              listener owner mismatch; leftover listener; false scope claims
//              (darwin scope layer claim + un-reasserted restart); undeclared
//              toolchain daemon; >1 survivor per declared toolchain;
//              duplicated admission ids.
//   NE:        absent tool / EPERM / missing sampler span / PID reuse — never
//              proof of death, so never PASS.
//   ERROR:     malformed sidecar.
//
// This generator is read-only over nothing but its own fresh workspace: it
// never touches live processes, listeners or original state.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const workspace = path.resolve(process.argv[2] ?? '');
const varRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..', 'var');
if (workspace === varRoot || !workspace.startsWith(`${varRoot}${path.sep}`) || !path.basename(workspace).startsWith('oracle-self-test.')) {
  throw new Error('O5 fixture workspace must be a unique oracle-self-test.* directory beneath torture-test/var');
}

const NOW = '2026-08-01T12:00:00.000Z';
const WINDOW = { start_utc: '2026-08-01T00:00:00.000Z', end_utc: NOW };

const RUN_A = 'run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_B = 'run-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REPO_ROOT = '/repo/torture-test/var';
const REPO_ORIGIN = '/repo/tt-poly';
const SHARED_MAVEN = '/repo/shared-tools/maven';

function producer() {
  return { name: 'o5-fixture-generator', version: '1' };
}

function campaign(extra = {}) {
  return {
    id: 'campaign-o5-calibration',
    run_ids: [RUN_A, RUN_B],
    window: WINDOW,
    host: {
      platform: 'linux',
      scope_layer: 'systemd-user-scope',
      scope_pattern: 'user@1000.service/app.slice/tamandua-run-*.scope',
    },
    ...extra,
  };
}

function coverage(overrides = {}) {
  const base = {
    scope: { status: 'available', note: null },
    'pgid-ancestry': { status: 'available', note: null },
    'path-fd': { status: 'available', note: null },
    'start-window': { status: 'available', note: null },
  };
  for (const [layer, entry] of Object.entries(overrides)) {
    base[layer] = { status: entry.status ?? 'available', note: entry.note ?? null };
  }
  return base;
}

function inventory(rows, tool = { name: 'fixture-ps', exit_code: 0 }, extra = {}) {
  return {
    rows,
    exact_count: rows.length,
    capped: false,
    tool,
    spans: [{ start: WINDOW.start_utc, end: WINDOW.end_utc }],
    ...extra,
  };
}

function processRow(pid, pgid, opts = {}) {
  return {
    pid,
    pgid,
    ppid: opts.ppid ?? 1,
    state: opts.state ?? 'S',
    start_identity: opts.start_identity ?? `proc:${1000 + pid}`,
    cgroup: opts.cgroup ?? 'user@1000.service/app.slice/tamandua-run-1.scope',
    cwd: opts.cwd ?? `${REPO_ROOT}/runs/${RUN_A.slice(4)}`,
    cmdline: opts.cmdline ?? `node /repo/tt-harness --run ${RUN_A}`,
    ts: opts.ts ?? NOW,
  };
}

const DEFAULTS = {
  daemon: {
    id: 'daemon-real', kind: 'daemon', run_id: null, pid: 9001, pgid: 9001,
    start_identity: 'proc:9001001', cwd_prefix: REPO_ROOT, cmdline_prefix: null,
    toolchain: null, expect: 'gone',
    required_layers: ['scope', 'pgid-ancestry', 'path-fd', 'start-window'],
    listen_specs: [{ protocol: 'tcp', address: '127.0.0.1', port: 4334 }],
  },
  workerA: {
    id: 'worker-a', kind: 'run-worker', run_id: RUN_A, pid: null, pgid: 7001,
    start_identity: 'proc:7001001', cwd_prefix: `${REPO_ROOT}/runs/${RUN_A.slice(4)}`,
    cmdline_prefix: `node /repo/tt-harness --run ${RUN_A}`, toolchain: null, expect: 'gone',
    required_layers: ['pgid-ancestry', 'path-fd', 'start-window'],
    listen_specs: null,
  },
  workerB: {
    id: 'worker-b', kind: 'run-worker', run_id: RUN_B, pid: null, pgid: 8001,
    start_identity: 'proc:8001001', cwd_prefix: `${REPO_ROOT}/runs/${RUN_B.slice(4)}`,
    cmdline_prefix: `node /repo/tt-harness --run ${RUN_B}`, toolchain: null, expect: 'gone',
    required_layers: ['pgid-ancestry', 'path-fd', 'start-window'],
    listen_specs: null,
  },
};

function baseSidecar(extra) {
  const sidecar = {
    schema_version: 1,
    sidecar_kind: 'post-batch-hygiene',
    oracle_id: 'O5',
    produced_at: NOW,
    producer: producer(),
    campaign: campaign(),
    evidence_files: [],
    diagnostics: [],
    o5: {
      scope: {
        contained_paths: [REPO_ROOT],
        host_admitted_paths: [
          // Explicitly shared original repository/config roots: processes under
          // these are campaign-legitimate, never substring-guessed foreign.
          { path: REPO_ORIGIN, owner: 'shared-origin', admitted: true },
          { path: SHARED_MAVEN, owner: 'shared-origin', admitted: true },
          { path: `${REPO_ORIGIN}/.git`, owner: 'config', admitted: true },
        ],
        cgroup_pattern: 'user@1000.service/app.slice/tamandua-run-*.scope',
        daemon_restarts: [
          { instance: 'daemon-1', pid: 9001, pgid: 9001, start_identity: 'proc:9001001', started_at: '2026-08-01T00:00:05.000Z', scope_membership_observed: true },
        ],
      },
      admissions: [DEFAULTS.daemon, DEFAULTS.workerA, DEFAULTS.workerB],
      coverage: coverage(),
      observations: {
        scope_members: inventory([]),
        processes: inventory([]),
        listeners: inventory([]),
        shared_toolchain: inventory([]),
      },
      census: { complete: true, notes: [] },
    },
  };
  return mergeDeep(sidecar, extra ?? {});
}

function mergeDeep(target, extra) {
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
        && target[key] !== null && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      mergeDeep(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// ── fixture cases ─────────────────────────────────────────────────────────

const CASES = [
  {
    name: 'o5-green-clean-linux',
    expected: 'PASS',
    build() {
      const sidecar = baseSidecar({});
      // one unrelated operator process OUTSIDE the campaign scope — ignored.
      sidecar.o5.observations.processes = inventory([
        processRow(5555, 5555, { cwd: '/home/operator', cmdline: 'vim notes.txt', cgroup: 'user@1000.service/app.slice/other.scope' }),
      ]);
      // The daemon stopped at campaign end: the scope census is empty and no
      // process row matches any admission.
      sidecar.o5.observations.scope_members = inventory([]);
      return sidecar;
    },
  },
  {
    name: 'o5-green-shared-toolchain-w6',
    expected: 'PASS',
    infoFinding: 'O5_SURVIVOR_INVENTORY',
    build() {
      const sidecar = baseSidecar({});
      sidecar.o5.admissions.push({
        id: 'toolchain-maven', kind: 'toolchain', run_id: null, pid: null, pgid: 6001,
        start_identity: null, cwd_prefix: null, cmdline_prefix: null, toolchain: 'java+maven',
        expect: 'alive_current', required_layers: ['pgid-ancestry', 'path-fd'], listen_specs: null,
      });
      sidecar.o5.observations.shared_toolchain = inventory([
        { toolchain: 'java+maven', pid: 6001, start_identity: 'proc:6001001', state: 'S', ts: NOW },
      ]);
      sidecar.o5.observations.processes = inventory([
        processRow(6001, 6001, { cwd: SHARED_MAVEN, cmdline: 'java -jar maven-daemon.jar', start_identity: 'proc:6001001' }),
      ]);
      return sidecar;
    },
  },
  {
    name: 'o5-green-shared-repo-path-not-foreign',
    expected: 'PASS',
    build() {
      const sidecar = baseSidecar({});
      // A process whose cwd is the explicitly shared original repository path:
      // host-admitted, therefore NOT a foreign-run containment violation.
      sidecar.o5.observations.processes = inventory([
        processRow(6202, 6202, { cwd: REPO_ORIGIN, cmdline: 'git fetch origin', cgroup: 'user@1000.service/app.slice/tamandua-run-1.scope' }),
      ]);
      return sidecar;
    },
  },
  {
    name: 'o5-darwin-synthetic-weak-layers',
    expected: 'PASS',
    infoFinding: 'O5_HOST_WEAKER_GUARANTEE',
    build() {
      const sidecar = baseSidecar({
        campaign: campaign({ host: { platform: 'darwin', scope_layer: 'none', scope_pattern: null } }),
      });
      sidecar.o5.scope.cgroup_pattern = null;
      sidecar.o5.scope.daemon_restarts = [{
        instance: 'daemon-1', pid: 9001, pgid: 9001, start_identity: 'darwin:Sun Aug  2 00:00:05 2026', started_at: '2026-08-01T00:00:05.000Z', scope_membership_observed: false,
      }];
      sidecar.o5.admissions = sidecar.o5.admissions.map((admission) => ({
        ...admission,
        start_identity: admission.kind === 'daemon' ? 'darwin:Sun Aug  2 00:00:05 2026' : `darwin:Sun Aug  2 00:00:0${admission.pgid % 10} 2026`,
        required_layers: admission.required_layers.filter((layer) => layer !== 'scope'),
      }));
      sidecar.o5.coverage = coverage({
        scope: { status: 'not_applicable', note: 'no systemd user scopes on darwin; layer 1 not applicable, layers 2-4 carry the weaker guarantee' },
      });
      sidecar.o5.observations.processes = inventory([]);
      return sidecar;
    },
  },
  {
    name: 'o5-leftover-worker',
    expected: 'FAIL',
    finding: 'O5_LEFTOVER_PROCESS',
    build() {
      const sidecar = baseSidecar({});
      sidecar.o5.observations.processes = inventory([
        processRow(7001, 7001, { start_identity: 'proc:7001001', state: 'S' }),
      ]);
      return sidecar;
    },
  },
  {
    name: 'o5-leftover-daemon',
    expected: 'FAIL',
    finding: 'O5_DAEMON_LEFT_RUNNING',
    build() {
      const sidecar = baseSidecar({});
      sidecar.o5.observations.processes = inventory([
        processRow(9001, 9001, { start_identity: 'proc:9001001', state: 'S', cwd: REPO_ROOT, cmdline: 'node dist/cli/cli.js daemon' }),
      ]);
      sidecar.o5.observations.scope_members = inventory([
        { pid: 9001, pgid: 9001, start_identity: 'proc:9001001', cgroup: 'user@1000.service/app.slice/tamandua-run-1.scope', ts: NOW },
      ]);
      return sidecar;
    },
  },
  {
    name: 'o5-zombie-leftover',
    expected: 'FAIL',
    finding: 'O5_ZOMBIE_LEFTOVER',
    build() {
      const sidecar = baseSidecar({});
      sidecar.o5.observations.processes = inventory([
        processRow(7001, 7001, { start_identity: 'proc:7001001', state: 'Z' }),
      ]);
      return sidecar;
    },
  },
  {
    name: 'o5-foreign-run-containment',
    expected: 'FAIL',
    finding: 'O5_FOREIGN_RUN_CONTAINMENT',
    build() {
      const sidecar = baseSidecar({});
      // A process under an admitted campaign run directory that matches NO
      // admission identity and NO shared mapping — a foreign-run containment
      // violation (cwd belongs to another run's campaign path).
      sidecar.o5.observations.processes = inventory([
        processRow(7777, 7777, { cwd: `${REPO_ROOT}/runs/${RUN_A.slice(4)}`, cmdline: 'node foreign-harness --run other', start_identity: 'proc:7777001' }),
      ]);
      return sidecar;
    },
  },
  {
    name: 'o5-listener-leftover',
    expected: 'FAIL',
    finding: 'O5_LEFTOVER_LISTENER',
    build() {
      const sidecar = baseSidecar({});
      sidecar.o5.observations.listeners = inventory([
        { pid: 9001, pgid: 9001, start_identity: 'proc:9001001', protocol: 'tcp', local_address: '127.0.0.1', local_port: 4334, ts: NOW },
      ]);
      return sidecar;
    },
  },
  {
    name: 'o5-listener-owner-mismatch',
    expected: 'FAIL',
    finding: 'O5_LISTENER_OWNER_MISMATCH',
    build() {
      const sidecar = baseSidecar({});
      // The admitted daemon port is occupied by a pid that is NOT a campaign
      // identity and not in the scope census.
      sidecar.o5.observations.listeners = inventory([
        { pid: 31337, pgid: 31337, start_identity: 'proc:31337001', protocol: 'tcp', local_address: '127.0.0.1', local_port: 4334, ts: NOW },
      ]);
      sidecar.o5.observations.processes = inventory([
        processRow(31337, 31337, { cwd: '/opt/evil', cmdline: 'nc -l 4334', start_identity: 'proc:31337001', cgroup: 'user@1000.service/app.slice/other.scope' }),
      ]);
      return sidecar;
    },
  },
  {
    name: 'o5-false-scope-claim-darwin',
    expected: 'FAIL',
    finding: 'O5_FALSE_SCOPE_CLAIM',
    build() {
      const sidecar = baseSidecar({
        campaign: campaign({ host: { platform: 'darwin', scope_layer: 'none', scope_pattern: null } }),
      });
      sidecar.o5.scope.cgroup_pattern = null;
      // Darwin host claims an AVAILABLE scope census — a false scope claim.
      sidecar.o5.coverage = coverage({ scope: { status: 'available', note: null } });
      return sidecar;
    },
  },
  {
    name: 'o5-false-scope-claim-restart',
    expected: 'FAIL',
    finding: 'O5_FALSE_SCOPE_CLAIM',
    build() {
      const sidecar = baseSidecar({});
      // Daemon restart whose scope membership was NOT re-asserted: the new
      // pid's containment is unproven — a false scope claim.
      sidecar.o5.scope.daemon_restarts = [
        { instance: 'daemon-1', pid: 9001, pgid: 9001, start_identity: 'proc:9001001', started_at: '2026-08-01T00:00:05.000Z', scope_membership_observed: true },
        { instance: 'daemon-2', pid: 9002, pgid: 9002, start_identity: 'proc:9002001', started_at: '2026-08-01T06:00:05.000Z', scope_membership_observed: false },
      ];
      return sidecar;
    },
  },
  {
    name: 'o5-undeclared-toolchain-daemon',
    expected: 'FAIL',
    finding: 'O5_UNDECLARED_TOOLCHAIN_DAEMON',
    build() {
      const sidecar = baseSidecar({});
      sidecar.o5.observations.shared_toolchain = inventory([
        { toolchain: 'python3', pid: 6501, start_identity: 'proc:6501001', state: 'S', ts: NOW },
      ]);
      return sidecar;
    },
  },
  {
    name: 'o5-toolchain-survivor-limit',
    expected: 'FAIL',
    finding: 'O5_TOOLCHAIN_SURVIVOR_LIMIT',
    build() {
      const sidecar = baseSidecar({});
      sidecar.o5.admissions.push({
        id: 'toolchain-maven', kind: 'toolchain', run_id: null, pid: null, pgid: 6001,
        start_identity: null, cwd_prefix: null, cmdline_prefix: null, toolchain: 'java+maven',
        expect: 'alive_current', required_layers: ['pgid-ancestry', 'path-fd'], listen_specs: null,
      });
      // TWO survivors for one declared toolchain at W6 -> limit violation.
      sidecar.o5.observations.shared_toolchain = inventory([
        { toolchain: 'java+maven', pid: 6001, start_identity: 'proc:6001001', state: 'S', ts: NOW },
        { toolchain: 'java+maven', pid: 6002, start_identity: 'proc:6002001', state: 'S', ts: NOW },
      ]);
      sidecar.o5.observations.processes = inventory([
        processRow(6001, 6001, { cwd: SHARED_MAVEN, cmdline: 'java -jar maven-daemon.jar', start_identity: 'proc:6001001' }),
        processRow(6002, 6002, { cwd: SHARED_MAVEN, cmdline: 'java -jar maven-daemon.jar', start_identity: 'proc:6002001' }),
      ]);
      return sidecar;
    },
  },
  {
    name: 'o5-inventory-duplicate-admission',
    expected: 'FAIL',
    finding: 'O5_INVENTORY_DUPLICATE_ADMISSION',
    build() {
      const sidecar = baseSidecar({});
      sidecar.o5.admissions.push({ ...DEFAULTS.workerA }); // duplicated id worker-a
      return sidecar;
    },
  },
  {
    name: 'o5-absent-tool-census-incomplete',
    expected: 'NOT_EVALUABLE',
    build() {
      const sidecar = baseSidecar({});
      // lsof absent (exit 127): the listener/port layer could not run. Absence
      // of rows is NOT proof of port release -> NOT_EVALUABLE.
      sidecar.o5.coverage = coverage({ 'path-fd': { status: 'unavailable', note: 'lsof absent (exit 127)' } });
      sidecar.o5.observations.listeners = inventory([], { name: 'lsof', exit_code: 127 });
      sidecar.o5.census = { complete: false, notes: ['lsof unavailable; listener census did not run'] };
      sidecar.diagnostics = ['lsof absent (exit 127): port-release assertions are NOT_EVALUABLE'];
      return sidecar;
    },
  },
  {
    name: 'o5-eprem-identity-unreadable',
    expected: 'NOT_EVALUABLE',
    build() {
      const sidecar = baseSidecar({});
      // The recorder tried to read the worker's identity and hit EPERM: the row
      // is present but identity-unreadable. That is never proof of death.
      sidecar.o5.observations.processes = inventory([
        { pid: 7001, pgid: null, ppid: null, state: null, start_identity: null, cwd: null, cmdline: null, cgroup: null, ts: NOW },
      ]);
      sidecar.o5.census = { complete: false, notes: ['EPERM reading worker identity'] };
      sidecar.diagnostics = ['EPERM reading the procfs identity of pid 7001 — worker admission UNRESOLVED'];
      return sidecar;
    },
  },
  {
    name: 'o5-pid-reuse-window',
    expected: 'NOT_EVALUABLE',
    build() {
      const sidecar = baseSidecar({});
      // Same pgid observed AFTER the worker should be gone but with a DIFFERENT
      // start identity: kill-and-PID-reuse inside the window. Not a leftover
      // (identity mismatch), not proof of death -> NOT_EVALUABLE (pid-reuse).
      sidecar.o5.observations.processes = inventory([
        processRow(7001, 7001, { start_identity: 'proc:9999001', cwd: '/home/operator', cmdline: 'bash' }),
      ]);
      sidecar.o5.census = { complete: true, notes: [] };
      return sidecar;
    },
  },
  {
    name: 'o5-missing-sampler-span',
    expected: 'NOT_EVALUABLE',
    build() {
      const sidecar = baseSidecar({});
      // The process sampler has a gap covering the daemon's admitted window —
      // the census cannot certify what happened in the gap.
      sidecar.o5.coverage = coverage({ 'start-window': { status: 'partial', note: 'sampler span missing 04:00Z-05:00Z (daemon window)' } });
      sidecar.o5.census = { complete: false, notes: ['missing sampler span in daemon window'] };
      return sidecar;
    },
  },
  {
    name: 'o5-layer-missing-not-pass',
    expected: 'NOT_EVALUABLE',
    build() {
      const sidecar = baseSidecar({});
      // ps failed (exit 1): layer 2 (pgid-ancestry) unavailable. The workers'
      // death cannot be certified from the remaining layers alone.
      sidecar.o5.coverage = coverage({ 'pgid-ancestry': { status: 'unavailable', note: 'ps failed (exit 1)' } });
      sidecar.o5.census = { complete: false, notes: ['ps unavailable; pgid-ancestry layer did not run'] };
      return sidecar;
    },
  },
  {
    // A declared alive_current shared-toolchain survivor that stopped BEFORE
    // the census: under a COMPLETE census this is informational
    // (O5_DECLARED_SURVIVOR_UNOBSERVED — it has stopped, not a leak), never a
    // failing finding.
    name: 'o5-declared-survivor-stopped-complete-census',
    expected: 'PASS',
    infoFinding: 'O5_DECLARED_SURVIVOR_UNOBSERVED',
    build() {
      const sidecar = baseSidecar({});
      sidecar.o5.admissions.push({
        id: 'toolchain-maven', kind: 'toolchain', run_id: null, pid: null, pgid: 6001,
        start_identity: null, cwd_prefix: null, cmdline_prefix: null, toolchain: 'java+maven',
        expect: 'alive_current', required_layers: ['pgid-ancestry', 'path-fd'], listen_specs: null,
      });
      return sidecar; // census complete; no rows for the toolchain -> stopped
    },
  },
  {
    // A declared alive_current survivor NOT observed under an INCOMPLETE
    // census: the recorder may simply have failed to observe it (sampler gap /
    // EPERM / capped census) — UNRESOLVED (census-incomplete), NEVER a positive
    // 'it has stopped' statement, and no informational finding may ride the
    // NOT_EVALUABLE result (was ERROR before the fix).
    name: 'o5-declared-survivor-census-incomplete-ne',
    expected: 'NOT_EVALUABLE',
    build() {
      const sidecar = baseSidecar({});
      sidecar.o5.admissions.push({
        id: 'toolchain-maven', kind: 'toolchain', run_id: null, pid: null, pgid: 6001,
        start_identity: null, cwd_prefix: null, cmdline_prefix: null, toolchain: 'java+maven',
        expect: 'alive_current', required_layers: ['pgid-ancestry', 'path-fd'], listen_specs: null,
      });
      sidecar.o5.census = { complete: false, notes: ['sampler gap over the shared-toolchain census span; the toolchain survivor was not observed'] };
      sidecar.diagnostics = ['shared-toolchain census incomplete: absence of the declared survivor is UNRESOLVED, never proof it stopped'];
      return sidecar;
    },
  },
  {
    // The strongest layer must not fail open: a process that is a MEMBER of the
    // campaign's own scope census but matches NO admitted pid/pgid anchor,
    // restart provenance or declared shared toolchain is a foreign process
    // inside the campaign containment -> O5_FOREIGN_RUN_CONTAINMENT.
    name: 'o5-scope-member-foreign-containment',
    expected: 'FAIL',
    finding: 'O5_FOREIGN_RUN_CONTAINMENT',
    build() {
      const sidecar = baseSidecar({});
      sidecar.o5.observations.scope_members = inventory([
        { pid: 7777, pgid: 7777, start_identity: 'proc:7777001', cgroup: 'user@1000.service/app.slice/tamandua-run-1.scope', ts: NOW },
      ]);
      return sidecar;
    },
  },
  {
    // Producer-discipline hole: the producer claims coverage.path-fd available
    // AND census.complete true, but the lsof LISTENER census actually FAILED
    // (exit 127). The daemon admission declares a listener, so port release
    // cannot be certified — the evaluator downgrades the layer from the DATA
    // and returns NOT_EVALUABLE (never PASS).
    name: 'o5-listener-tool-failure-vs-coverage',
    expected: 'NOT_EVALUABLE',
    build() {
      const sidecar = baseSidecar({});
      sidecar.o5.observations.listeners = inventory([], { name: 'lsof', exit_code: 127 });
      sidecar.o5.observations.processes = inventory([], { name: 'ps', exit_code: 0 });
      // coverage + census stay producer-claimed healthy: the downgrade must
      // come from the recorded tool exit code.
      return sidecar;
    },
  },
  {
    // Producer-discipline hole: the processes census is CAPPED (sampled 1 of 5)
    // while the producer declares census.complete true. A gone worker absent
    // from the sample is not proof of death — the pgid-ancestry/path-fd layers
    // are partial from the DATA -> NOT_EVALUABLE (never PASS).
    name: 'o5-capped-processes-census',
    expected: 'NOT_EVALUABLE',
    build() {
      const sidecar = baseSidecar({});
      sidecar.o5.observations.processes = {
        rows: [processRow(5555, 5555, { cwd: '/home/operator', cmdline: 'vim notes.txt' })],
        exact_count: 5,
        capped: true,
        tool: { name: 'ps', exit_code: 0 },
        spans: [{ start: WINDOW.start_utc, end: WINDOW.end_utc }],
      };
      return sidecar;
    },
  },
  {
    name: 'o5-malformed-sidecar',
    expected: 'ERROR',
    build() {
      const sidecar = baseSidecar({});
      delete sidecar.o5.observations.processes; // shape violation
      return sidecar;
    },
  },
  {
    name: 'o5-admission-without-anchor',
    expected: 'ERROR',
    build() {
      const sidecar = baseSidecar({});
      sidecar.o5.admissions.push({
        id: 'no-anchor', kind: 'run-worker', run_id: RUN_A, pid: null, pgid: null,
        start_identity: null, cwd_prefix: REPO_ROOT, cmdline_prefix: null,
        toolchain: null, expect: 'gone', required_layers: [], listen_specs: null,
      });
      return sidecar;
    },
  },
];

// ── writer ────────────────────────────────────────────────────────────────

function writeFixture(fixture) {
  const dir = path.join(workspace, fixture.name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sidecar = fixture.build();
  const sidecarPath = path.join(dir, 'sidecar.json');
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, { mode: 0o400, flag: 'wx' });
  const expectation = {
    name: fixture.name,
    expected: fixture.expected,
    finding: fixture.finding ?? null,
    infoFinding: fixture.infoFinding ?? null,
    sidecar: sidecarPath,
    sidecar_sha256: sha256(JSON.stringify(sidecar) + '\n'),
  };
  fs.writeFileSync(path.join(dir, 'expectation.json'), `${JSON.stringify(expectation, null, 2)}\n`, { flag: 'wx' });
}

for (const fixture of CASES) {
  writeFixture(fixture);
}
process.stdout.write(`generated ${CASES.length} O5 fixtures in ${workspace}\n`);
