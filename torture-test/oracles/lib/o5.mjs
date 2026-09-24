#!/usr/bin/env node
// o5.mjs — O5 process & port hygiene (post-batch) evaluator.
//
// spec 03 "O5 — Process & port hygiene (post-batch)" + the read-only slice
// rules of STORM-HYGIENE: this evaluator performs a MECHANICAL post-batch
// census reconciliation over the COMPLETE independently admitted
// campaign/run/process/listener scope carried by the post-batch hygiene
// sidecar (see POST-BATCH-CONTRACT.md). It NEVER kills, reaps, cleans or
// mutates anything: the input recorders gather bounded read-only OS snapshots
// inside the explicitly admitted scope; this checker only reconciles the
// snapshots against the admissions and reports.
//
// Evidence layers (spec 03):
//   1. scope       — kernel-owned containment (systemd user scopes). On a host
//                    with the scope layer, the TT daemon starts inside a
//                    dedicated systemd-run --user --scope unit; every start AND
//                    restart goes through the controller wrapper which
//                    re-asserts scope membership (scope.daemon_restarts[].scope_
//                    membership_observed + the recorded scope_members census).
//                    A NEW pid after a restart does NOT inherit the cgroup by
//                    assumption: restart provenance is a FACT the sidecar
//                    records and this checker verifies.
//   2. pgid-ancestry — claim_pgid + current process birth/ancestry
//                    corroboration (the relevant worker identity; claim_pid is
//                    the DAEMON, not the harness).
//   3. path-fd      — admitted path / cwd / lsof evidence.
//   4. start-window — start-time window with an allowlist for legitimate
//                    shared daemons (<=1 survivor per explicitly declared
//                    toolchain at W6), listed for disposition.
//
// Honesty rules encoded here (never relaxed):
//   * PID reuse, EPERM, missing sampler spans, observation timeouts,
//     malformed/incomplete inventories and absent tools are NOT proof of
//     process death or port release — an admission whose death/release cannot
//     be certified by the layers it requires stays UNRESOLVED, and an
//     unresolved admission (with no failing finding) makes the result
//     NOT_EVALUABLE, never PASS.
//   * Darwin has no env inspection and (typically) no scope layer: the weaker
//     layers 2-4 are recorded honestly; coverage.scope must be
//     'not_applicable' when the host profile says scope_layer 'none' — a
//     fabricated layer-1 claim is itself a finding (O5_FALSE_SCOPE_CLAIM).
//   * No credentials and no environment text are ever read; cmdline fields are
//     bounded and redacted by the recorder, never treated as secrets here.
//   * A process under an explicitly shared original repository/config path is
//     not automatically foreign: host-admitted scope/expected mappings
//     (scope.host_admitted_paths) decide, not substring guesses.
//   * Scope census rows carry no cwd, so scope-member containment is decided by
//     ADMITTED NUMERIC ANCHOR (pid/pgid against admissions, restarts and
//     declared shared toolchains) — a scope member matching no anchor is a
//     foreign process inside the campaign's own kernel containment
//     (O5_FOREIGN_RUN_CONTAINMENT), never guessed from a path.
//   * Honesty is enforced from the DATA, not producer discipline: a layer whose
//     underpinning inventory tool failed or is capped is downgraded
//     (unavailable/partial) regardless of the coverage claim or census.complete
//     (effective_layer_profile in the summary).
//   * A declared alive_current survivor that is not observed is informational
//     ONLY under a COMPLETE census; under an incomplete census it is UNRESOLVED
//     (census-incomplete) — an incomplete census can never certify 'stopped'.
//
// Result vocabulary: PASS | FAIL | NOT_EVALUABLE | ERROR (ERROR is raised by
// the wrapper when the sidecar fails to load/validate). A FAIL finding beats
// NOT_EVALUABLE; NOT_EVALUABLE beats PASS. Informational (non_failing)
// findings ride PASS ONLY — every addInfo emission is gated on the final
// result (a NOT_EVALUABLE result may not carry findings), and the shared
// wrapper strips any stray non_failing finding before response validation.

import { FindingCollector } from './findings.mjs';
import { writeEvidenceJson } from './evidence.mjs';
import { HYGIENE_SIDECAR_SCHEMA_VERSION } from './hygiene-sidecar.mjs';

const ADMISSION_KIND_DAEMON = 'daemon';
const ADMISSION_KIND_WORKER = 'run-worker';
const ADMISSION_KIND_LISTENER = 'listener';
const ADMISSION_KIND_TOOLCHAIN = 'toolchain';

// ── path helpers ─────────────────────────────────────────────────────────

function cwdUnder(cwd, root) {
  if (typeof cwd !== 'string' || cwd.length === 0 || typeof root !== 'string' || root.length === 0) return false;
  if (cwd === root) return true;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return cwd.startsWith(prefix);
}

function sameNumericAnchor(admission, row) {
  if (admission.pid !== null && row.pid === admission.pid) return true;
  if (admission.pgid !== null && admission.pgid === row.pgid && row.pgid !== null) return true;
  return false;
}

// tri-state admission<->row identity match: 'match' | 'mismatch' | 'unverifiable'
function matchAdmissionRow(admission, row) {
  if (!sameNumericAnchor(admission, row)) return 'mismatch';
  if (admission.start_identity === null) return 'match';
  if (row.start_identity === null) return 'unverifiable'; // identity source failed (EPERM / ps absent) — never a match verdict
  return row.start_identity === admission.start_identity ? 'match' : 'mismatch';
}

function admissionSubject(admission) {
  const bits = [admission.kind, admission.id];
  if (admission.run_id !== null) bits.push(admission.run_id);
  return bits.join('/');
}

// Layer availability against the recorded host/coverage profile.
function layerState(layer, coverage, host) {
  const status = coverage[layer]?.status ?? 'unavailable';
  if (status === 'not_applicable') {
    return host.scope_layer === 'none' ? 'not-applicable-honest' : 'false-scope-claim';
  }
  if (status === 'available' && layer === 'scope' && host.scope_layer !== 'systemd-user-scope') {
    return 'false-scope-claim';
  }
  return status;
}

// ── data-driven layer integrity (never trust producer discipline) ────────
// A layer is only as strong as the census data that underpins it. Independent
// of the producer's coverage claim, a failed inventory tool (exit != 0) makes
// the layer unavailable and a capped (sampled) inventory makes it partial —
// absence from a failed or capped census is never proof of death/release, so
// the evaluator enforces the honesty rules from the recorded data itself.
const LAYER_ORDER = Object.freeze({ available: 0, partial: 1, unavailable: 2, 'not-applicable-honest': 3, 'false-scope-claim': 4 });

function worstLayer(...states) {
  return states.reduce((worst, state) => ((LAYER_ORDER[state] ?? 0) > (LAYER_ORDER[worst] ?? 0) ? state : worst), 'available');
}

function inventoryDegrade(inventory) {
  if (inventory.tool.exit_code !== 0) return 'unavailable';
  if (inventory.capped === true) return 'partial';
  return 'available';
}

// effectiveLayerState: the layer's strength AFTER data-driven cross-checks.
//   * scope         underpinned by the scope_members census;
//   * pgid-ancestry underpinned by the processes census;
//   * path-fd       underpinned by the processes census and, when the
//                   admission declares listen specs, by the listeners census
//                   (a failed lsof cannot certify port release).
// start-window has no separate inventory: a missing sampler span is a census
// completeness fact (recorded in census.complete / notes), not an inventory
// row, so its coverage claim is used as recorded.
function effectiveLayerState(layer, coverage, host, observations, hasListenSpecs) {
  const base = layerState(layer, coverage, host);
  if (base === 'not-applicable-honest' || base === 'false-scope-claim') return base;
  const underpin = [];
  if (layer === 'scope') underpin.push(observations.scope_members);
  else if (layer === 'pgid-ancestry') underpin.push(observations.processes);
  else if (layer === 'path-fd') {
    underpin.push(observations.processes);
    if (hasListenSpecs) underpin.push(observations.listeners);
  } else {
    return base; // start-window: coverage-driven (see above)
  }
  let effective = base;
  for (const inventory of underpin) effective = worstLayer(effective, inventoryDegrade(inventory));
  return effective;
}

// ── per-admission disposition ────────────────────────────────────────────

// dispositionOf returns { disposition: 'leftover'|'zombie'|'dead'|'alive'|
// 'missing-survivor'|'unresolved', rows: [], reasons: [] }.
// layerResolver(layer) -> effective layer state for THIS admission (its
// listen_specs decide whether the listeners census underpins path-fd).
function dispositionOf(admission, allRows, layerResolver, census) {
  const live = [];
  const zombies = [];
  const unverifiable = [];
  const reuse = [];
  for (const row of allRows) {
    const verdict = matchAdmissionRow(admission, row);
    if (verdict === 'match') {
      if (row.state === 'Z') zombies.push(row);
      else live.push(row);
      continue;
    }
    if (verdict === 'unverifiable') {
      if (sameNumericAnchor(admission, row)) unverifiable.push(row);
      continue;
    }
    if (sameNumericAnchor(admission, row)) reuse.push(row); // same pid/pgid, DIFFERENT start identity — ABA reuse suspicion
  }
  if (admission.expect === 'alive_current') {
    if (live.length > 0) return { disposition: 'alive', rows: live, reasons: [] };
    if (unverifiable.length > 0) {
      return { disposition: 'unresolved', rows: [], reasons: ['identity evidence unreadable for the declared current survivor'] };
    }
    if (reuse.length > 0) {
      return { disposition: 'unresolved', rows: [], reasons: [`pid/pgid reuse suspected: same numeric id observed with a different start identity (${reuse.length} row(s))`] };
    }
    if (!census.complete) {
      // An incomplete census can never certify that a declared alive_current
      // survivor stopped: the recorder may simply have failed to observe it
      // (sampler gap / EPERM / capped census). UNRESOLVED, never a positive
      // 'it has stopped' statement.
      return { disposition: 'unresolved', rows: [], reasons: ['process census is incomplete (recorder warnings/tool failures); a declared current survivor not observed under an incomplete census is UNRESOLVED'] };
    }
    return { disposition: 'missing-survivor', rows: [], reasons: [] };
  }
  // expect 'gone'
  if (live.length > 0) return { disposition: 'leftover', rows: live, reasons: [] };
  if (zombies.length > 0) return { disposition: 'zombie', rows: zombies, reasons: [] };
  const reasons = [];
  if (!census.complete) reasons.push('process census is incomplete (recorder warnings/tool failures)');
  if (reuse.length > 0) reasons.push(`pid/pgid reuse suspected: same numeric id observed with a different start identity (${reuse.length} row(s))`);
  if (unverifiable.length > 0) reasons.push('identity evidence for the recorded pid/pgid was unreadable (never proof of death)');
  const missingLayers = [];
  for (const layer of admission.required_layers) {
    const state = layerResolver(layer);
    if (state === 'available') continue;
    if (state === 'not-applicable-honest') continue;
    missingLayers.push(`${layer}:${state}`);
  }
  if (missingLayers.length > 0) reasons.push(`required evidence layer(s) not available: ${missingLayers.join(', ')}`);
  if (reasons.length === 0) return { disposition: 'dead', rows: [], reasons: [] };
  return { disposition: 'unresolved', rows: [], reasons };
}

// ── top-level evaluation ─────────────────────────────────────────────────

export function evaluateO5(invocation) {
  const { sidecar, evidenceDir } = invocation;
  const sidecarO5 = sidecar.o5;
  const campaign = sidecar.campaign;
  const host = campaign.host;
  const findings = new FindingCollector();
  const failures = [];

  const addFailure = (id, summary, details = {}) => {
    findings.add(id, summary, details);
    failures.push(id);
  };

  // Content-level inventory integrity: duplicated admission ids.
  const seenIds = new Set();
  for (const admission of sidecarO5.admissions) {
    if (seenIds.has(admission.id)) {
      addFailure(
        'O5_INVENTORY_DUPLICATE_ADMISSION',
        `census admissions carry a duplicated id ${admission.id}; the independently admitted scope is ambiguous`,
        { admission_id: admission.id },
      );
    }
    seenIds.add(admission.id);
  }

  // ── honest layer profile (no fabricated scope on procfs-less hosts) ───
  const layerProfile = {};
  for (const layer of ['scope', 'pgid-ancestry', 'path-fd', 'start-window']) {
    layerProfile[layer] = layerState(layer, sidecarO5.coverage, host);
    if (layerProfile[layer] === 'false-scope-claim') {
      addFailure(
        'O5_FALSE_SCOPE_CLAIM',
        `host profile has no scope layer (${host.scope_layer}) but coverage.${layer} claims a kernel containment census; a false scope claim is a finding`,
        { layer },
      );
    }
  }
  // Restart provenance: every daemon start/restart on a scope-layer host must
  // have its membership re-asserted (scope_membership_observed) — a restart
  // whose new pid is assumed in-scope without reassertion is a false claim.
  const scopeAvailable = host.scope_layer === 'systemd-user-scope';
  const restartByInstance = new Map();
  for (const restart of sidecarO5.scope.daemon_restarts) {
    restartByInstance.set(restart.instance, restart);
    if (scopeAvailable && restart.scope_membership_observed !== true) {
      addFailure(
        'O5_FALSE_SCOPE_CLAIM',
        `daemon restart ${restart.instance} (pid ${restart.pid}) was not re-asserted into the systemd scope (scope_membership_observed false); the new pid's containment is unproven`,
        { instance: restart.instance, pid: restart.pid },
      );
    }
  }
  // Scope census rows are the kernel layer's corroboration. Rows are judged in
  // the containment pass below (a pid observed in the campaign scope must
  // belong to an admitted entity/restart/declared toolchain — otherwise a
  // foreign process lives inside the campaign's containment). The scope rows
  // carry no cwd, so they are excluded from the path-based pass and are judged
  // here by ADMITTED NUMERIC ANCHOR, not by substring guessing.

  // ── dispositions per admission ────────────────────────────────────────
  const allRows = [
    ...sidecarO5.observations.scope_members.rows.map((row) => ({ ...row, cwd: null, cmdline: null, _layer: 'scope' })),
    ...sidecarO5.observations.processes.rows.map((row) => ({ ...row, _layer: 'processes' })),
  ];
  const dispositions = [];
  const matchedRowKeys = new Set();
  const layerResolverFor = (admission) => (layer) => effectiveLayerState(layer, sidecarO5.coverage, host, sidecarO5.observations, admission.listen_specs !== null);
  for (const admission of sidecarO5.admissions) {
    const disposition = dispositionOf(admission, allRows, layerResolverFor(admission), sidecarO5.census);
    disposition.subject = admissionSubject(admission);
    disposition.admission = admission;
    for (const row of disposition.rows) matchedRowKeys.add(`${row.pid}:${row.start_identity ?? ''}:${row.ts}`);
    dispositions.push(disposition);
    if (disposition.disposition === 'leftover') {
      const id = admission.kind === ADMISSION_KIND_DAEMON ? 'O5_DAEMON_LEFT_RUNNING' : 'O5_LEFTOVER_PROCESS';
      addFailure(id, `${admission.kind} ${admission.id} is still alive after the batch (expected gone; ${disposition.rows.length} matching live row(s))`, {
        subject: disposition.subject,
        rows: disposition.rows.map((row) => ({ pid: row.pid, start_identity: row.start_identity, layer: row._layer })),
      });
    } else if (disposition.disposition === 'zombie') {
      addFailure('O5_ZOMBIE_LEFTOVER', `${admission.kind} ${admission.id} lingers as an unreaped zombie (state Z, ${disposition.rows.length} row(s))`, {
        subject: disposition.subject,
      });
    }
  }

  // ── shared-toolchain allowance bookkeeping ─────────────────────────────
  const declaredToolchains = new Map(); // name -> {allowed, admissions:[]}
  for (const admission of sidecarO5.admissions) {
    if (admission.kind !== ADMISSION_KIND_TOOLCHAIN) continue;
    if (admission.toolchain === null) continue;
    const existing = declaredToolchains.get(admission.toolchain) ?? { allowed: 0, alive: 0, admissions: [] };
    if (admission.expect === 'alive_current') existing.allowed += 1;
    existing.admissions.push(admission.id);
    declaredToolchains.set(admission.toolchain, existing);
  }
  const observedPerToolchain = new Map();
  for (const row of sidecarO5.observations.shared_toolchain.rows) {
    const bucket = observedPerToolchain.get(row.toolchain) ?? [];
    bucket.push(row);
    observedPerToolchain.set(row.toolchain, bucket);
  }
  for (const [toolchain, bucket] of observedPerToolchain) {
    const declared = declaredToolchains.get(toolchain);
    if (declared === undefined) {
      addFailure('O5_UNDECLARED_TOOLCHAIN_DAEMON', `observed shared-toolchain survivor ${toolchain} (${bucket.length}) is not declared in the admissions`, { toolchain });
      continue;
    }
    if (bucket.length > 1) {
      addFailure('O5_TOOLCHAIN_SURVIVOR_LIMIT', `declared shared toolchain ${toolchain} has ${bucket.length} survivors; the W6 allowance is <=1 per explicitly declared toolchain`, { toolchain, observed: bucket.length });
    }
  }
  // alive_current admission not observed alive while the census is complete:
  // informational riders are emitted in the PASS post-pass below (a
  // NOT_EVALUABLE result may not carry findings — output contract).
  const missingSurvivors = [];
  for (const disposition of dispositions) {
    if (disposition.disposition === 'missing-survivor') missingSurvivors.push(disposition.subject);
  }

  // ── containment: foreign-run / project-containment violations ──────────
  // A numeric-anchor holder is campaign-covered: the pid OR pgid appears in an
  // admission (any kind, incl. declared toolchains), in a daemon restart's
  // provenance, or in the observed shared-toolchain census. Rows that match an
  // anchor but carry a DIFFERENT start identity are ABA reuse suspicions —
  // they are owned by the disposition machinery (which makes the admission
  // unresolved), never clean foreign-run containment. Only a scope member with
  // NO admitted anchor at all is a foreign process inside the campaign's own
  // containment.
  const scopeRowCoveredByAnchor = (row) => {
    for (const admission of sidecarO5.admissions) {
      if (admission.pid !== null && admission.pid === row.pid) return true;
      if (admission.pgid !== null && admission.pgid === row.pgid) return true;
    }
    for (const restart of sidecarO5.scope.daemon_restarts) {
      if (restart.pid === row.pid) return true;
      if (restart.pgid === row.pgid) return true;
    }
    for (const toolchainRow of sidecarO5.observations.shared_toolchain.rows) {
      if (toolchainRow.pid === row.pid) return true;
    }
    return false;
  };
  const campaignPaths = [...(sidecarO5.scope.contained_paths ?? [])];
  for (const admission of sidecarO5.admissions) {
    if (admission.cwd_prefix !== null && !campaignPaths.some((entry) => entry === admission.cwd_prefix)) {
      campaignPaths.push(admission.cwd_prefix);
    }
  }
  const sharedPaths = (sidecarO5.scope.host_admitted_paths ?? [])
    .filter((entry) => entry.admitted === true)
    .map((entry) => entry.path);
  let foreignCount = 0;
  let unrelatedCount = 0;
  let sharedSurvivorCount = 0;
  let scopeForeignCount = 0;
  for (const row of sidecarO5.observations.processes.rows) {
    if (row.state === 'Z') continue; // zombies judged via admission matches only
    if (typeof row.cwd !== 'string' || row.cwd.length === 0) continue; // no path evidence — never guess
    // Already accounted for as an admission match (leftover/zombie/alive)?
    let matched = false;
    for (const disposition of dispositions) {
      if (disposition.rows.some((drow) => drow.pid === row.pid && drow.ts === row.ts)) { matched = true; break; }
    }
    if (matched) continue;
    const underShared = sharedPaths.some((entry) => cwdUnder(row.cwd, entry));
    if (underShared) {
      sharedSurvivorCount += 1;
      continue; // explicitly shared original repo/config path — host-admitted, not foreign
    }
    const underCampaign = campaignPaths.some((entry) => cwdUnder(row.cwd, entry));
    if (underCampaign) {
      foreignCount += 1;
      addFailure(
        'O5_FOREIGN_RUN_CONTAINMENT',
        `process ${row.pid} (cwd ${row.cwd}) lives under an admitted campaign path but matches no admitted campaign identity and no host-admitted shared mapping`,
        { pid: row.pid, cwd: row.cwd },
      );
    } else {
      unrelatedCount += 1; // unrelated operator process — listed, never a finding
    }
  }
  // Scope census rows (the strongest layer) carry no cwd, so containment for
  // them is decided by admitted anchors — never by path substring guesses. A
  // scope member matching NO admitted pid/pgid anchor, restart provenance or
  // declared shared-toolchain pid is a FOREIGN process inside the campaign's
  // own kernel containment (the layer-1 census observed it in-scope).
  for (const row of sidecarO5.observations.scope_members.rows) {
    if (scopeRowCoveredByAnchor(row)) continue;
    scopeForeignCount += 1;
    addFailure(
      'O5_FOREIGN_RUN_CONTAINMENT',
      `process ${row.pid} is a member of the campaign's own scope census but matches no admitted campaign identity, restart provenance or declared shared toolchain`,
      { pid: row.pid, start_identity: row.start_identity ?? null, cgroup: row.cgroup },
    );
  }

  // ── listener reconciliation ─────────────────────────────────────────────
  // Admitted listen specs come from ANY admission that declared listeners
  // (the campaign daemon admission carries the daemon's ports; a dedicated
  // listener admission is also allowed) — the port's ownership is then judged
  // against the campaign identity set below.
  const admittedListeners = [];
  for (const admission of sidecarO5.admissions) {
    if (admission.listen_specs === null) continue;
    for (const spec of admission.listen_specs) {
      admittedListeners.push({ admission, spec });
    }
  }
  // identity set that legitimately owns campaign listeners: admitted entities
  // + scope census members (identity corroborated).
  const campaignOwnerKeys = new Set();
  for (const admission of sidecarO5.admissions) {
    if (admission.pid !== null) campaignOwnerKeys.add(`pid:${admission.pid}`);
    if (admission.pgid !== null) campaignOwnerKeys.add(`pgid:${admission.pgid}`);
  }
  for (const row of sidecarO5.observations.scope_members.rows) {
    campaignOwnerKeys.add(`pid:${row.pid}`);
    if (row.pgid !== null) campaignOwnerKeys.add(`pgid:${row.pgid}`);
  }
  for (const restart of sidecarO5.scope.daemon_restarts) {
    campaignOwnerKeys.add(`pid:${restart.pid}`);
    campaignOwnerKeys.add(`pgid:${restart.pgid}`);
  }
  const reportedListenerSubjects = new Set();
  for (const row of sidecarO5.observations.listeners.rows) {
    const specHits = admittedListeners.filter(({ spec }) => spec.protocol === row.protocol && spec.address === row.local_address && spec.port === row.local_port);
    const campaignOwned = campaignOwnerKeys.has(`pid:${row.pid}`) || (row.pgid !== null && campaignOwnerKeys.has(`pgid:${row.pgid}`));
    const key = `${row.protocol}:${row.local_address}:${row.local_port}`;
    if (specHits.length > 0) {
      if (reportedListenerSubjects.has(key)) continue;
      reportedListenerSubjects.add(key);
      if (campaignOwned) {
        // The port belongs to the campaign's own admitted identity and is
        // still listening after the batch — a campaign leftover listener.
        addFailure('O5_LEFTOVER_LISTENER', `admitted listener ${key} is still listening after the batch (pid ${row.pid})`, {
          listener: key,
          pid: row.pid,
        });
      } else {
        // The port is an admitted campaign port but its current owner is NOT a
        // campaign identity: whoever holds it is foreign to the admitted scope.
        addFailure('O5_LISTENER_OWNER_MISMATCH', `listener ${key} occupies an admitted campaign port but its owner (pid ${row.pid}) is not a campaign identity`, {
          listener: key,
          pid: row.pid,
        });
      }
      continue;
    }
    if (campaignOwned) {
      addFailure('O5_UNLISTED_LISTENER', `campaign-owned listener ${key} (pid ${row.pid}) is not among the admitted listen specs`, {
        listener: key,
        pid: row.pid,
      });
    }
    // an unrelated host listener is an operator process — recorded, not a finding
  }

  // ── result resolution ──────────────────────────────────────────────────
  const unresolved = dispositions.filter((disposition) => disposition.disposition === 'unresolved');
  // Global coverage gap uses the DATA-DRIVEN effective layer states (inventory
  // tool failures / capped censuses downgrade the layer regardless of the
  // producer's coverage claim). path-fd is evaluated at its most degraded —
  // both with and without a listener census — because port-release coverage
  // cannot be certified when either underpinning census is weak.
  const effectiveProfile = {};
  for (const layer of ['scope', 'pgid-ancestry', 'path-fd', 'start-window']) {
    effectiveProfile[layer] = worstLayer(
      effectiveLayerState(layer, sidecarO5.coverage, host, sidecarO5.observations, false),
      effectiveLayerState(layer, sidecarO5.coverage, host, sidecarO5.observations, true),
    );
  }
  const globalGap = !sidecarO5.census.complete
    || Object.values(effectiveProfile).some((state) => state === 'unavailable' || state === 'partial');

  let result;
  let classification;
  if (failures.length > 0) {
    result = 'FAIL';
  } else if (unresolved.length > 0 || globalGap) {
    // NOT_EVALUABLE may not carry findings (output contract), so unresolved
    // admissions are recorded in the summary evidence only; the classification
    // names the ambiguity category for the total-outcome classifier.
    result = 'NOT_EVALUABLE';
    const category = unresolved.some((disposition) => disposition.reasons.some((reason) => reason.includes('reuse')))
      ? 'pid-reuse'
      : 'census-incomplete';
    classification = { ambiguous: { category } };
  } else {
    result = 'PASS';
  }

  // Informational summary riders (allowed on PASS only — a NOT_EVALUABLE result
  // may not carry findings, so every addInfo emission is gated on the final
  // result computed above).
  if (result === 'PASS') {
    const survivorLines = [];
    for (const [toolchain, bucket] of observedPerToolchain) {
      survivorLines.push(`${toolchain}:${bucket.length}`);
    }
    for (const disposition of dispositions) {
      if (disposition.disposition === 'alive') {
        survivorLines.push(`admitted-current:${disposition.subject}`);
      }
    }
    if (survivorLines.length > 0) {
      findings.addInfo('O5_SURVIVOR_INVENTORY', `expected survivors listed for disposition (<=1 per declared toolchain at W6): ${survivorLines.join(', ')}`);
    }
    for (const subject of missingSurvivors) {
      // Only reachable when the census is complete (dispositionOf makes an
      // unobserved alive_current UNRESOLVED under an incomplete census), so
      // 'it has stopped' is a complete-census statement.
      findings.addInfo(
        'O5_DECLARED_SURVIVOR_UNOBSERVED',
        `declared current survivor ${subject} was not observed in the complete census (it has stopped — not a leak, recorded for provenance)`,
      );
    }
    if (unrelatedCount > 0) {
      findings.addInfo('O5_UNRELATED_PROCESSES', `${unrelatedCount} unrelated operator process(es) observed outside admitted campaign scope; listed, not findings`);
    }
    if (host.platform !== 'linux') {
      findings.addInfo('O5_HOST_WEAKER_GUARANTEE', `host profile platform ${host.platform}: no env inspection; kernel containment layer recorded ${effectiveProfile.scope}; layers 2-4 carry the weaker guarantee`);
    }
  }

  // ── verdict summary evidence (exclusive create; original captures untouched)
  const summary = {
    schema_version: HYGIENE_SIDECAR_SCHEMA_VERSION,
    oracle_id: 'O5',
    produced_at: new Date().toISOString(),
    campaign_id: campaign.id,
    result,
    admission_count: sidecarO5.admissions.length,
    dispositions: dispositions.map((disposition) => ({
      subject: disposition.subject,
      kind: disposition.admission.kind,
      expect: disposition.admission.expect,
      disposition: disposition.disposition,
      reasons: disposition.reasons,
      rows: disposition.rows.map((row) => ({ pid: row.pid, state: row.state ?? null, start_identity: row.start_identity ?? null, layer: row._layer })),
    })),
    layer_profile: layerProfile,
    effective_layer_profile: effectiveProfile,
    foreign_containment: { process_path_based: foreignCount, scope_member_anchor_based: scopeForeignCount },
    census: {
      complete: sidecarO5.census.complete,
      notes: sidecarO5.census.notes,
      inventory_counts: Object.fromEntries(
        ['scope_members', 'processes', 'listeners', 'shared_toolchain'].map((name) => [
          name,
          { exact_count: sidecarO5.observations[name].exact_count, inline_rows: sidecarO5.observations[name].rows.length, capped: sidecarO5.observations[name].capped, tool_exit: sidecarO5.observations[name].tool.exit_code },
        ]),
      ),
    },
    shared_survivors: [...observedPerToolchain.entries()].map(([toolchain, rows]) => ({ toolchain, observed: rows.length })),
    unrelated_processes: unrelatedCount,
    diagnostics: sidecar.diagnostics,
  };
  const evidence = [];
  if (typeof evidenceDir === 'string' && evidenceDir.length > 0) {
    const reference = writeEvidenceJson(invocation, 'o5-summary.json', summary, 'o5-process-port-hygiene-summary');
    evidence.push(reference);
  }

  return {
    result,
    findings: findings.toJSON(),
    evidence,
    ...(classification !== undefined ? { classification } : {}),
  };
}
