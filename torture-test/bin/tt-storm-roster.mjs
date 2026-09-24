// tt-storm-roster.mjs — W5 storm roster derivation (shared, pure-ish).
//
// The storm's queue math must NEVER hardcode a historical timer count
// (spec 09's "44" and the manifest's "3x6 + 2x6 + 7 + 4 + 3 = 44" were
// themselves corrections of an even earlier wrong draft; the actual current
// catalog can and did drift again — fdmw7/bfmw8/security8/quarantine4/
// drdv3/do-now1 making 52 for the S1-S8 active roster). Every timer number
// this tool prints or acts on is DERIVED at decision time from the actual
// workflow registrations the storm daemon will run, and every derived number
// is emitted with its source/catalog provenance so a reviewer can reproduce
// it (spec 09 "Timer math (corrected...)" + STORM-W5 requirement 2).
//
// Derivation contract:
//   * A workflow's timer demand is COUNT(DISTINCT agent_id) over its steps
//     (the scheduler owns one dispatch timer per (runId, agentId) that owns a
//     step). Both declared agents (front-matter `agents:`) and steps' `agent:`
//     values are read; the timer count is the distinct set of agents that own
//     at least one step, and the declared count is recorded alongside. If the
//     two disagree the difference is recorded — never silently resolved.
//   * Workflow YAMLs are located under a catalog root (the installed catalog
//     a storm daemon would actually run, e.g. <TT_HOME>/.tamandua/workflows)
//     and fall back to the bundled catalog (<repo>/workflows) only when the
//     installed root is absent/unreadable; the resolution and every source
//     path + sha256 are part of the provenance.
//   * The Round A active roster (S1-S8) timer cap is the SUM of the roster's
//     per-workflow timer demands; S9/S10 are launched with the same cap in
//     force so their admission is decided by real free capacity at decision
//     time (recorded per admission attempt, never assumed).
//
// Safety: pure functions; filesystem access goes through an injected
// fs adapter so the recording gate can exercise derivation against
// synthetic catalogs with zero real reads.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Real-fs adapter used by the operator CLI. The recording gate injects its
// own synthetic fs (an in-memory map), so real reads happen only on real
// operator paths.
export const REAL_FS = {
  readFile: (p) => fs.promises.readFile(p, 'utf8'),
  readFileSync: (p) => fs.readFileSync(p, 'utf8'),
  writeFileSync: (p, data) => fs.writeFileSync(p, data),
  appendFileSync: (p, data) => fs.appendFileSync(p, data),
  mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
  renameSync: (a, b) => fs.renameSync(a, b),
  existsSync: (p) => fs.existsSync(p),
  readdirSync: (p) => fs.readdirSync(p),
  statSync: (p) => fs.statSync(p),
  lstatSync: (p) => fs.lstatSync(p),
  realpathSync: (p) => fs.realpathSync(p),
  rmSync: (p, opts) => fs.rmSync(p, opts),
  resolve: (p) => path.resolve(p),
};

// Null adapter: every access fails closed (recording gate can layer over it).
export const NULL_FS = {
  readFile: async () => { throw new Error('NULL_FS read'); },
  readFileSync: () => { throw new Error('NULL_FS read'); },
  existsSync: () => false,
  readdirSync: () => { throw new Error('NULL_FS readdir'); },
  statSync: () => { throw new Error('NULL_FS stat'); },
  resolve: (p) => p,
};

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Roster identity (canonical assignments — spec 09 table + W5 briefing).
// Timers are NOT here; they are derived per workflow at prepare/decision
// time. round "A" runs S1..S10 (S9/S10 queued), round "B" runs B1..B5.
// `taskArea` is the fixture task-area identity owned by the orchestrator
// (spec 09 roster tables; the run task file is provisioned from that area in
// the fixture's seed/storm ref — see the remaining-dependency note in the
// impl doc, task-file CONTENT provisioning is the rehearsal gate's job, the
// area identity itself is recorded here). `context` carries the run-level
// `--context key=value` flags the real launch argv must include (S7
// quarantine launches with `--context branch=broken-tests` so it lands on
// `broken-tests`, never main).
export const ROUND_A_ROSTER = [
  { id: 'S1', run: 'storm-fdmw-1',   workflow: 'feature-dev-merge-worktree',            harness: 'pi',     round: 'A', taskArea: 'go/ worker-pool feature (POLY-BUG-R lane)', context: [] },
  { id: 'S2', run: 'storm-fdmw-2',   workflow: 'feature-dev-merge-worktree',            harness: 'hermes', round: 'A', taskArea: 'java/ ledger feature', context: [] },
  { id: 'S3', run: 'storm-fdmw-3',   workflow: 'feature-dev-merge-worktree',            harness: 'pi',     round: 'A', taskArea: 'python/ scheduling feature', context: [] },
  { id: 'S4', run: 'storm-bfmw-1',   workflow: 'bug-fix-merge-worktree',                harness: 'pi',     round: 'A', taskArea: 'rust/ POLY-BUG-R', context: [] },
  { id: 'S5', run: 'storm-bfmw-2',   workflow: 'bug-fix-merge-worktree',                harness: 'hermes', round: 'A', taskArea: 'ts/src/store.ts (overlap pair A)', context: [] },
  { id: 'S6', run: 'storm-sec',      workflow: 'security-audit-merge-worktree',         harness: 'pi',     round: 'A', taskArea: 'repo-wide audit (POLY-VULNs)', context: [] },
  { id: 'S7', run: 'storm-quar',     workflow: 'quarantine-broken-tests-merge-worktree', harness: 'pi',    round: 'A', taskArea: 'POLY-BRK tests', context: ['branch=broken-tests'] },
  { id: 'S8', run: 'storm-drdv',     workflow: 'do-review-do-verify',                   harness: 'hermes', round: 'A', taskArea: 'docs+code consistency task', context: [] },
  { id: 'S9', run: 'storm-fdmw-4',   workflow: 'feature-dev-merge-worktree',            harness: 'pi',     round: 'A', queued: true, taskArea: 'ts/src/store.ts (overlap pair B)', context: [] },
  { id: 'S10', run: 'storm-donow',   workflow: 'do-now',                                harness: 'pi',     round: 'A', queued: true, taskArea: 'trivial task (queue-drain canary)', context: [] },
];

export const ROUND_B_ROSTER = [
  { id: 'B1', run: 'storm-b1-fdmw',    workflow: 'feature-dev-merge-worktree',             harness: 'pi',     round: 'B', taskArea: 'go/ worker-pool feature', context: [] },
  { id: 'B2', run: 'storm-b2-fdmw',    workflow: 'feature-dev-merge-worktree',             harness: 'hermes', round: 'B', taskArea: 'java/ ledger feature', context: [] },
  { id: 'B3', run: 'storm-b3-bfmw',    workflow: 'bug-fix-merge-worktree',                 harness: 'pi',     round: 'B', taskArea: 'rust/ POLY-BUG-R', context: [] },
  { id: 'B4', run: 'storm-b4-bfmw-red', workflow: 'bug-fix-merge-worktree',                harness: 'pi',     round: 'B', red_bait: true, taskArea: 'union-red bait bfmw (W4.39 scenario)', context: [] },
  { id: 'B5', run: 'storm-b5-donow',   workflow: 'do-now',                                 harness: 'pi',     round: 'B', taskArea: 'do-now agitator', context: [] },
];

export const STORM_WORKFLOW_IDS = [...new Set([
  ...ROUND_A_ROSTER.map((r) => r.workflow),
  ...ROUND_B_ROSTER.map((r) => r.workflow),
])];

// Round A launch cadence (spec 09 / W5 briefing, preserved): S1..S8 are
// launched with a 90s stagger; S9/S10 are launched immediately after S8's
// registration with a 30s stagger between them (before early completions can
// free timer capacity). S8 is the 8th non-queued entry → its slot is
// (activeCount-1)*90s = 7*90s = 630s; S9's slot is S8+30s = 660s and S10's
// is S9+30s = 690s (NOT 8*90+30=750 — that would put a 120s gap after S8 and
// weaken the pre-completion queue probe). Timings are EARLIEST offsets; the
// scheduler may wait longer when phase evidence requires it.
export const ROUND_A_STAGGER_MS = 90_000;
export const ROUND_A_QUEUED_STAGGER_MS = 30_000;
export const SAMPLER_INTERVAL_MS = 15_000;

// Read-path pounding cadence + latency bound (spec 09 Round B table: 30s
// between pounding rounds; first-byte latency bound < 2s; no 5xx).
export const POUND_INTERVAL_MS = 30_000;
export const POUND_LATENCY_BOUND_MS = 2_000;

// Parse a workflow.yml text and return { workflowId, stepAgents (distinct,
// ordered), declaredAgents (distinct, ordered), usedStepAgents }.
// Tolerant mini-parser: reads (1) the top-level `agents:` block entries
// (`- id: x`) and (2) every step's `agent:` value under any steps array.
// Comments and quoted values are handled defensively.
export function parseWorkflowAgents(yamlText, workflowId = 'unknown') {
  const declared = [];
  const used = [];
  const lines = String(yamlText).split(/\r?\n/);
  let inTopAgents = false;
  let topAgentsDepth = -1;
  const stepAgentRe = /^\s*-\s*id:\s*(\S+)/;
  const agentKeyRe = /^\s*agent:\s*(\S+)/;
  let seenStepAgentBlock = false;
  // US-005 (SF-2 containment): the top-level `run.workspace` mode decides
  // whether a launch needs the owned worktree origin + ref. Derive it from the
  // real workflow.yml text (never hardcode which roster workflows are worktree);
  // absent run/workspace is the product default "direct".
  let workspaceMode = 'direct';
  let inRunBlock = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (/^\s*$/.test(line)) continue;
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();

    // Track the top-level `run:` mapping so a nested `workspace:` is read only
    // from that block (agent workspaces also carry a `workspace:` key).
    if (indent === 0) {
      inRunBlock = /^run:\s*$/.test(trimmed);
    } else if (inRunBlock) {
      const wm = trimmed.match(/^workspace:\s*(\S+)/);
      if (wm) workspaceMode = wm[1].replace(/["']/g, '');
    }

    if (!seenStepAgentBlock && /^agents:\s*$/.test(trimmed) && indent === 0) {
      inTopAgents = true;
      topAgentsDepth = indent;
      continue;
    }
    if (inTopAgents) {
      const m = trimmed.match(stepAgentRe);
      if (m && indent > topAgentsDepth) {
        declared.push(m[1]);
        continue;
      }
      // Leaving the agents block: a new top-level key at depth 0.
      if (indent <= topAgentsDepth && /^[a-zA-Z_]/.test(trimmed)) {
        inTopAgents = false;
        if (/^steps:\s*$/.test(trimmed)) seenStepAgentBlock = true;
        continue;
      }
      continue;
    }
    if (/^steps:\s*$/.test(trimmed)) {
      seenStepAgentBlock = true;
      continue;
    }
    if (seenStepAgentBlock) {
      const m = trimmed.match(agentKeyRe);
      if (m) used.push(m[1]);
    }
  }

  const stepAgents = [...new Set(used)];
  const declaredAgents = [...new Set(declared)];
  return { workflowId, stepAgents, declaredAgents, workspaceMode };
}

// Given a catalog root (a fs adapter + path), read every storm workflow's
// workflow.yml and derive per-workflow timer counts.
export async function deriveTimerCounts({ fs = NULL_FS, catalogRoot, workflowIds = STORM_WORKFLOW_IDS, bundledRoot = null }) {
  const out = {};
  for (const wf of workflowIds) {
    const entry = await deriveOneWorkflow({ fs, catalogRoot, bundledRoot, workflowId: wf });
    out[wf] = entry;
  }
  return out;
}

export async function deriveOneWorkflow({ fs = NULL_FS, catalogRoot, bundledRoot = null, workflowId }) {
  const candidates = [];
  if (catalogRoot) candidates.push({ kind: 'catalog', root: catalogRoot });
  if (bundledRoot && bundledRoot !== catalogRoot) candidates.push({ kind: 'bundled', root: bundledRoot });
  for (const cand of candidates) {
    const p = `${cand.root}/${workflowId}/workflow.yml`;
    let text = null;
    try {
      text = await fs.readFile(p);
    } catch {
      text = null;
    }
    if (typeof text === 'string' && text.length > 0) {
      const parsed = parseWorkflowAgents(text, workflowId);
      return {
        workflowId,
        source: { kind: cand.kind, root: cand.root, path: p, sha256: sha256(text) },
        distinctStepAgents: parsed.stepAgents.length,
        stepAgents: parsed.stepAgents,
        declaredAgentsCount: parsed.declaredAgents.length,
        declaredAgents: parsed.declaredAgents,
        declaredVsStepsAgree: parsed.stepAgents.length === parsed.declaredAgents.length,
        // US-005: the workflow's real run.workspace mode (product default
        // "direct") so the launch plan can require the owned worktree origin
        // for exactly the worktree family.
        workspaceMode: parsed.workspaceMode,
      };
    }
  }
  return {
    workflowId,
    source: null,
    distinctStepAgents: null,
    stepAgents: [],
    declaredAgentsCount: null,
    declaredAgents: [],
    declaredVsStepsAgree: null,
    workspaceMode: null,
  };
}

// Compute the Round A active-roster timer cap from derived counts.
// Active roster = S1..S8 (S9/S10 are the queue probes). Missing derivation
// for any active member is a hard error — a cap built on unknown demand
// silently relaxes the queue assertion.
export function computeActiveTimerCap(counts, active = ROUND_A_ROSTER.filter((r) => !r.queued)) {
  const perRun = active.map((r) => {
    const c = counts[r.workflow];
    if (!c || c.distinctStepAgents == null) {
      throw new Error(
        `cannot derive timer cap: no workflow registration derived for ${r.workflow} (roster ${r.id}/${r.run})`,
      );
    }
    return { rosterId: r.id, run: r.run, workflow: r.workflow, timers: c.distinctStepAgents };
  });
  const total = perRun.reduce((n, x) => n + x.timers, 0);
  return { perRun, total };
}

// ─────────────────────────────────────────────────────────────────────
// Roster identity for the report (STORM-REAL US-007).
//
// The full storm roster is the default; the capacity-scaled `--scale lite`
// pilot (US-008) records its own roster id/scale in the campaign state. The
// report headline must NAME the roster that ran (full vs lite, by roster id),
// so this reader is the ONE place the persisted identity is resolved. It
// never guesses: an absent/unrecognized persisted value falls back to the
// full default, and the actual launched run count is derived separately from
// the campaign's own run records (see the engine report builder).
// ─────────────────────────────────────────────────────────────────────
export const FULL_ROSTER_ID = 'full';
export const FULL_ROSTER_LABEL = 'full storm roster';

// The persisted roster identity for a campaign state, or the full default.
// Reads the documented persisted keys (roster_id takes precedence over a bare
// scale) at both the rehearsal and plan levels so a future writer cannot drift.
export function rosterIdentityFromState(state) {
  const source = [
    state?.rehearsal?.roster_id,
    state?.rehearsal?.scale,
    state?.rehearsal?.resource_plan?.roster_id,
    state?.rehearsal?.resource_plan?.scale,
    state?.plan?.roster_id,
    state?.plan?.scale,
  ].find((v) => typeof v === 'string' && v.trim() !== '');
  const id = source ? source.trim() : FULL_ROSTER_ID;
  const full = id === FULL_ROSTER_ID;
  return {
    id,
    scale: id,
    full,
    label: full ? FULL_ROSTER_LABEL : `${id} roster`,
  };
}

// Resolve which catalog root is authoritative: prefer an installed catalog
// root (the one a storm daemon actually runs), else the bundled root.
export function resolveCatalogRoot({ fs = NULL_FS, installedRoot, bundledRoot }) {
  const tries = [];
  if (installedRoot) tries.push({ kind: 'installed', root: installedRoot });
  if (bundledRoot) tries.push({ kind: 'bundled', root: bundledRoot });
  for (const t of tries) {
    try {
      if (fs.existsSync(t.root) && fs.statSync(t.root).isDirectory?.() !== false) {
        return { kind: t.kind, root: t.root };
      }
    } catch {
      // fall through
    }
  }
  return { kind: null, root: null };
}
