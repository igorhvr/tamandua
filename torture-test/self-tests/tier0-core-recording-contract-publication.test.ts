// tier0-core-recording-contract-publication.test.ts — CORE-CELLS US-008:
// CORE-CELLS completion-contract publication gate.
//
// Beads tamandua-6sy.7 / tamandua-6sy.7.4. The designated gate for the final
// wrap-up story: prove the published CORE-CELLS completion contract is valid
// JSON, carries every required field (all seven required stories with their
// source-backed / adapted / synthetic / UNKNOWN honesty fields, exact
// commits/tree, source sha256s, per-story producer exits + full logs +
// retained roots), records the core measured run membership/timing/results,
// the private-authority and child/listener closure proof, the regular battery
// tally with its actual exit, and the US-001 intermediate stage evidence —
// and that it explicitly keeps the parent CORE open with the remaining real
// echo/integration obligations listed.
//
// The published artifacts are RETAINED evidence under the git-ignored
// torture-test/var/review-logs/ tree (nothing is removed). This file is
// discovered by self-tests/run.sh's tier0 glob; it opens no listener, spawns
// nothing and touches no live state.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { test as nodeTest } from "node:test";

const repoRoot = process.cwd();
const REVIEW_LOGS = path.join(repoRoot, "torture-test", "var", "review-logs");

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const STORIES = ["US-001", "US-002", "US-003", "US-004", "US-005", "US-006", "US-007"];
const REQUIRED_TOP_LEVEL = [
  "contract",
  "version",
  "kind",
  "timestampUtc",
  "workflow",
  "parentCoreStatus",
  "repo",
  "commits",
  "sourceFiles",
  "requirements",
  "coreMeasuredRun",
  "privateAuthority",
  "childListenerClosure",
  "regularBattery",
  "us001IntermediateStageEvidence",
  "honestyContract",
  "remainingObligations",
  "publication",
];
const HONESTY_ARRAYS = {
  sourceBackedFields: "source-backed",
  adaptedFields: "adapted",
  syntheticFields: "synthetic",
  unknownFields: "UNKNOWN",
};

const sha256File = (p: string): string => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/** Locate the newest retained US-008 contract evidence root that carries both
 *  the completion contract and the US-001 intermediate stage evidence. */
function discoverContractRoot(): string | null {
  if (!fs.existsSync(REVIEW_LOGS)) return null;
  const candidates: string[] = [];
  for (const e of fs.readdirSync(REVIEW_LOGS, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith("core-cells-contract-")) continue;
    const dir = path.join(REVIEW_LOGS, e.name);
    if (
      fs.existsSync(path.join(dir, "core-cells-contract.json")) &&
      fs.existsSync(path.join(dir, "us001-intermediate-stage-evidence.json"))
    ) {
      candidates.push(dir);
    }
  }
  candidates.sort();
  return candidates.length ? candidates[candidates.length - 1] : null;
}

/** Pure required-field validator. Returns a list of human-readable errors;
 *  an empty list means the contract satisfies the publication contract. */
function validateContract(doc: unknown): string[] {
  const errors: string[] = [];
  const req = (cond: boolean, msg: string): void => {
    if (!cond) errors.push(msg);
  };
  if (typeof doc !== "object" || doc === null) return ["contract must be a JSON object"];
  const c = doc as Record<string, any>;
  for (const k of REQUIRED_TOP_LEVEL) req(k in c, `missing top-level key: ${k}`);
  req(c.contract === "core-cells-contract", "contract must be 'core-cells-contract'");
  req(c.version === 1, "version must be 1");
  req(typeof c.timestampUtc === "string" && c.timestampUtc.endsWith("Z"), "timestampUtc must be UTC-Z");

  // commits: all seven stories with exact commit + tree ids
  req(Array.isArray(c.commits) && c.commits.length === 7, "commits must have exactly 7 entries");
  if (Array.isArray(c.commits)) {
    for (const st of STORIES) {
      const row = c.commits.find((x: any) => x?.story === st);
      req(!!row, `commits missing ${st}`);
      if (row) {
        req(HEX40.test(row.commit ?? ""), `commits.${st}.commit must be a 40-hex id`);
        req(HEX40.test(row.tree ?? ""), `commits.${st}.tree must be a 40-hex id`);
      }
    }
  }

  // sourceFiles: 64-hex sha256 for every recorded source file
  req(typeof c.sourceFiles === "object" && c.sourceFiles !== null, "sourceFiles must be an object");
  if (c.sourceFiles && typeof c.sourceFiles === "object") {
    const paths = Object.keys(c.sourceFiles);
    req(paths.length >= 20, `sourceFiles must record the complete core authoring surface (got ${paths.length})`);
    for (const p of paths) {
      req(HEX64.test(c.sourceFiles[p]?.sha256 ?? ""), `sourceFiles.${p}.sha256 must be 64-hex`);
    }
  }

  // requirements: all seven stories with honesty classification fields
  req(Array.isArray(c.requirements) && c.requirements.length === 7, "requirements must have exactly 7 entries");
  if (Array.isArray(c.requirements)) {
    for (const st of STORIES) {
      const r = c.requirements.find((x: any) => x?.story === st);
      req(!!r, `requirements missing ${st}`);
      if (!r) continue;
      for (const k of ["originalRequirement", "title", "status", "designatedGate", "gateEvidence"]) {
        req(r[k] !== undefined, `${st} missing ${k}`);
      }
      for (const [arr, classification] of Object.entries(HONESTY_ARRAYS)) {
        req(Array.isArray(r[arr]), `${st}.${arr} must be an array`);
        for (const entry of Array.isArray(r[arr]) ? r[arr] : []) {
          req(
            entry?.classification === classification,
            `${st}.${arr} entry must be classified '${classification}' (got ${entry?.classification})`,
          );
          req(typeof entry?.detail === "string" && entry.detail.length > 0, `${st}.${arr} entry needs a detail`);
        }
      }
    }
  }

  // core measured run: accounting + timing + retained evidence root
  const run = c.coreMeasuredRun;
  req(typeof run === "object" && run !== null, "coreMeasuredRun must be an object");
  if (run) {
    req(run.exitCode === 0, "coreMeasuredRun.exitCode must be 0");
    req(typeof run.elapsedMs === "number" && run.elapsedMs > 0, "coreMeasuredRun.elapsedMs must be > 0");
    req(typeof run.timingUtcStart === "string" && run.timingUtcStart.endsWith("Z"), "measured run start must be UTC-Z");
    req(typeof run.timingUtcEnd === "string" && run.timingUtcEnd.endsWith("Z"), "measured run end must be UTC-Z");
    req(run.accounting?.green === run.accounting?.expectedProducers, "all expected producers must be green");
    req(run.accounting?.red === 0 && run.accounting?.missing === 0 && run.accounting?.interrupted === 0, "no red/missing/interrupted producers");
    req(
      run.recordedCellsAccounting?.green === run.recordedCellsAccounting?.expectedRecordedCells,
      "all expected recorded sub-cells must be green",
    );
    req(Array.isArray(run.recordedCells) && run.recordedCells.length === run.recordedCellsAccounting?.expectedRecordedCells,
      "recordedCells list must match the expected recorded-cell count");
    req(Array.isArray(run.producerExits) && run.producerExits.length === run.accounting?.expectedProducers,
      "producerExits must cover every expected producer");
    for (const p of Array.isArray(run.producerExits) ? run.producerExits : []) {
      req(p.exitCode === 0, `producer ${p.id} exit must be 0`);
      req(typeof p.fullLog === "string" && p.fullLog.length > 0, `producer ${p.id} must record its full log`);
    }
  }

  // private authority + child/listener closure
  req(typeof c.privateAuthority?.entrypointChildEnv?.guard === "string" &&
      c.privateAuthority.entrypointChildEnv.guard.includes("TAMANDUA_TEST_GUARD=1"),
    "privateAuthority must record the guard");
  req(Array.isArray(c.privateAuthority?.perProducerPrivateRoots) && c.privateAuthority.perProducerPrivateRoots.length >= 9,
    "privateAuthority must record one private root set per producer");
  req(Array.isArray(c.childListenerClosure?.motorGateCases) && c.childListenerClosure.motorGateCases.length >= 3,
    "childListenerClosure must record the motor-gate daemon cases");
  for (const kase of Array.isArray(c.childListenerClosure?.motorGateCases) ? c.childListenerClosure.motorGateCases : []) {
    req(kase?.daemonStop?.exitObserved === true, `case ${kase?.caseId} daemon exit must be observed`);
    req(kase?.daemonStop?.controlPortReleased === true, `case ${kase?.caseId} control port must be released`);
  }
  req(c.childListenerClosure?.pipeLifetime?.ok === true, "pipe-lifetime recording legs must all pass");
  req(c.childListenerClosure?.negativeLegClosure?.terminalSignalHandle?.actualOsSignals === 0,
    "terminal-signal handle must report zero actual OS signals");

  // regular battery tally
  const battery = c.regularBattery;
  req(typeof battery === "object" && battery !== null, "regularBattery must be an object");
  if (battery) {
    req(battery.finalRun?.exit_code === 0, "regular battery actual exit must be 0");
    req(battery.finalRun?.tally?.failed === 0, "regular battery must have zero failures");
    req(battery.finalRun?.tally?.passed > 0, "regular battery must report a positive pass tally");
    req(HEX64.test(battery.runShSha256 ?? ""), "regular battery must record the run.sh sha256");
    req(battery.heavyEscalationAdded === false, "no heavy/bare-tier escalation may be claimed");
    req(battery.vaivmBattery40Cited === false, "the vaivm battery #40 must not be cited as this run's evidence");
  }

  // US-001 intermediate stage evidence reference
  req(typeof c.us001IntermediateStageEvidence?.publishedFile === "string", "US-001 intermediate evidence file must be referenced");
  req(c.us001IntermediateStageEvidence?.status === "gate-pass", "US-001 intermediate evidence must be gate-pass");

  // honesty contract + remaining obligations + parent-open statement
  req(Array.isArray(c.honestyContract?.classifications) && c.honestyContract.classifications.includes("UNKNOWN"),
    "honestyContract must enumerate the UNKNOWN classification");
  req(Array.isArray(c.remainingObligations) && c.remainingObligations.length >= 4,
    "remaining real echo/integration obligations must be listed");
  const obligations = (c.remainingObligations ?? []).join("\n");
  req(/per-landing/i.test(obligations), "obligations must record the per-landing review runner dependency");
  req(c.parentCoreStatus?.complete === false, "parent CORE must NOT be marked complete");
  req(c.parentCoreStatus?.fullCampaignCertificationClaimed === false, "no full campaign certification may be claimed");
  req(/NOT marked complete/i.test(c.parentCoreStatus?.statement ?? ""), "parentCoreStatus must state the parent stays open");
  req(typeof c.parentCoreStatus?.bothHostPushRestriction === "string" && c.parentCoreStatus.bothHostPushRestriction.length > 0,
    "both-host push restriction must be visible");

  return errors;
}

/** Validate the US-001 intermediate stage evidence (root-probe cases rerun
 *  post-fix + clean commit/source hashes + retained roots). */
function validateUs001Stage(doc: unknown): string[] {
  const errors: string[] = [];
  const req = (cond: boolean, msg: string): void => {
    if (!cond) errors.push(msg);
  };
  if (typeof doc !== "object" || doc === null) return ["US-001 stage evidence must be an object"];
  const d = doc as Record<string, any>;
  req(HEX40.test(d.git?.head ?? ""), "US-001 stage evidence must record the clean commit");
  req(HEX40.test(d.git?.tree ?? ""), "US-001 stage evidence must record the clean tree");
  req(typeof d.sourceFileSha256 === "object" && Object.keys(d.sourceFileSha256).length > 0,
    "US-001 stage evidence must record source sha256s");
  req(typeof d.gateRun?.evidenceDir === "string" && d.gateRun.evidenceDir.length > 0,
    "US-001 stage evidence must record the gate retained root");
  req(d.gateRun?.failures === 0, "US-001 gate must have zero failures");
  const cases = d.rootProbeCasesRerunPostFix?.planCases;
  req(Array.isArray(cases), "US-001 stage evidence must record the root-probe cases rerun post-fix");
  if (Array.isArray(cases)) {
    const missing = cases.find((x: any) => x?.kind === "missing-preserved-claim-output");
    const nonstring = cases.find((x: any) => x?.kind === "nonstring-preserved-claim-output");
    const positive = cases.find((x: any) => x?.kind === "unchanged-positive");
    req(!!missing, "missing-preserved-claim-output case must be recorded");
    req(!!nonstring, "nonstring-preserved-claim-output case must be recorded");
    req(!!positive, "unchanged-positive case must be recorded");
    for (const kase of [missing, nonstring]) {
      if (!kase) continue;
      req(kase.refused === true, `${kase.kind} must refuse`);
      req(kase.executed === false, `${kase.kind} must not execute`);
      req(Array.isArray(kase.attemptedEffectCalls) && kase.attemptedEffectCalls.length === 0,
        `${kase.kind} must record ZERO effect calls`);
    }
    req(positive?.preflight?.ok === true, "unchanged-positive plan must preflight ok:true");
  }
  return errors;
}

const contractRoot = discoverContractRoot();
const contractPath = contractRoot ? path.join(contractRoot, "core-cells-contract.json") : null;
const us001Path = contractRoot ? path.join(contractRoot, "us001-intermediate-stage-evidence.json") : null;
const contract: any = contractPath ? JSON.parse(fs.readFileSync(contractPath, "utf8")) : null;

// Host-scope guard (torture-union US-005 integration fix). The CORE-CELLS
// completion contract + US-001 intermediate-stage evidence are RETAINED,
// git-ignored artifacts published by aasylum run #936 under its own
// torture-test/var/review-logs/. They are not part of the committed tree, so on
// a host that does not carry that run's retained evidence — the torture-union
// integration checkout, or any fresh battery host (e.g. run #40-shaped
// batteries) — this publication gate is not runnable. Skip it explicitly and
// honestly instead of hard-failing the battery for an absent out-of-band
// artifact; when the evidence IS present every assertion below still executes
// and enforces unchanged. This mirrors the suite's existing host-conditional
// skips (tier1-e26-real-launch-proof, tier1-real-case-proof,
// tier1-seed-schema).
const PUBLICATION_SKIP: string | false = contractRoot
  ? false
  : "CORE-CELLS publication evidence root (core-cells-contract-*/) is not retained on this host";

/** Register a publication assertion; skips the whole gate (honest SKIP, never
 *  a faked PASS) when this host does not carry the run's retained evidence. */
const test = (name: string, fn: () => unknown): void => {
  nodeTest(name, { skip: PUBLICATION_SKIP }, fn);
};

test("the US-008 contract evidence root is published with both required files", () => {
  assert.ok(contractRoot, "no core-cells-contract-* root with core-cells-contract.json + us001-intermediate-stage-evidence.json was found");
  assert.ok(fs.existsSync(contractPath!), `missing ${contractPath}`);
  assert.ok(fs.existsSync(us001Path!), `missing ${us001Path}`);
});

test("core-cells-contract.json is valid JSON and passes the required-field validator", () => {
  assert.ok(contract, "contract did not parse");
  const errors = validateContract(contract);
  assert.deepEqual(errors, [], `contract required-field errors:\n${errors.join("\n")}`);
});

test("validator red arm: a contract missing required fields is rejected", () => {
  const baseline = JSON.parse(JSON.stringify(contract));
  assert.deepEqual(validateContract(baseline), [], "baseline must be valid for the red arm to be meaningful");

  const noStories = JSON.parse(JSON.stringify(contract));
  noStories.requirements = noStories.requirements.filter((r: any) => r.story !== "US-004");
  assert.ok(validateContract(noStories).some((e) => e.includes("US-004")), "dropping a story must be rejected");

  const badHash = JSON.parse(JSON.stringify(contract));
  const firstSource = Object.keys(badHash.sourceFiles)[0];
  badHash.sourceFiles[firstSource].sha256 = "not-a-hash";
  assert.ok(validateContract(badHash).some((e) => e.includes("sha256")), "a malformed source sha256 must be rejected");

  const parentComplete = JSON.parse(JSON.stringify(contract));
  parentComplete.parentCoreStatus.complete = true;
  assert.ok(validateContract(parentComplete).some((e) => e.includes("parent CORE")), "marking the parent complete must be rejected");

  const noObligations = JSON.parse(JSON.stringify(contract));
  noObligations.remainingObligations = [];
  assert.ok(validateContract(noObligations).some((e) => e.includes("obligations")), "dropping obligations must be rejected");

  const wrongClass = JSON.parse(JSON.stringify(contract));
  wrongClass.requirements[0].sourceBackedFields[0].classification = "made-up";
  assert.ok(validateContract(wrongClass).some((e) => e.includes("source-backed")), "a misclassified honesty field must be rejected");
});

test("recorded source sha256s match the tracked final tree", () => {
  assert.ok(contract, "contract did not parse");
  const mismatches: string[] = [];
  for (const [rel, meta] of Object.entries(contract.sourceFiles as Record<string, any>)) {
    const absPath = path.join(repoRoot, rel);
    if (!fs.existsSync(absPath)) {
      mismatches.push(`${rel}: missing on disk`);
      continue;
    }
    const actual = sha256File(absPath);
    if (actual !== meta.sha256) mismatches.push(`${rel}: recorded ${meta.sha256} != actual ${actual}`);
  }
  assert.deepEqual(mismatches, [], `source sha256 mismatches:\n${mismatches.join("\n")}`);
});

test("core measured run membership/timing/results are internally consistent and retained", () => {
  assert.ok(contract, "contract did not parse");
  const run = contract.coreMeasuredRun;
  assert.equal(run.exitCode, 0);
  assert.equal(run.accounting.expectedProducers, 9);
  assert.equal(run.accounting.green, 9);
  assert.equal(run.recordedCellsAccounting.expectedRecordedCells, 10);
  assert.equal(run.recordedCellsAccounting.green, 10);
  assert.ok(run.elapsedMs > 0, "measured elapsedMs must be positive");
  assert.ok(run.timingUtcStart < run.timingUtcEnd, "start must precede end");
  const root = path.join(repoRoot, run.evidenceRoot);
  assert.ok(fs.existsSync(path.join(root, "cells-summary.json")), "measured run summary must be retained");
  assert.ok(fs.existsSync(path.join(root, "cells-run.log")), "measured run log must be retained");
  for (const p of run.producerExits) {
    assert.ok(fs.existsSync(path.join(repoRoot, p.fullLog)), `producer log missing: ${p.fullLog}`);
  }
});

test("private authority and child/listener closure proof are recorded", () => {
  assert.ok(contract, "contract did not parse");
  assert.match(contract.privateAuthority.entrypointChildEnv.guard, /TAMANDUA_TEST_GUARD=1/);
  assert.ok(contract.privateAuthority.perProducerPrivateRoots.length >= 9);
  const homes = contract.privateAuthority.perProducerPrivateRoots.map((r: any) => r.home);
  assert.equal(new Set(homes).size, homes.length, "each producer must get its own private HOME");
  const cases = contract.childListenerClosure.motorGateCases;
  assert.ok(cases.length >= 3);
  for (const k of cases) {
    assert.equal(k.daemonStop.exitObserved, true, `${k.caseId} daemon exit must be observed`);
    assert.equal(k.daemonStop.controlPortReleased, true, `${k.caseId} control port must be released`);
  }
  assert.equal(contract.childListenerClosure.pipeLifetime.ok, true);
  assert.equal(contract.childListenerClosure.negativeLegClosure.terminalSignalHandle.actualOsSignals, 0);
});

test("regular battery tally records the actual exit and no escalation", () => {
  assert.ok(contract, "contract did not parse");
  const b = contract.regularBattery;
  assert.equal(b.finalRun.exit_code, 0);
  assert.equal(b.finalRun.tally.failed, 0);
  assert.equal(b.finalRun.tally.passed, 192);
  assert.equal(b.finalRun.git_clean_before, true);
  assert.equal(b.finalRun.git_clean_after, true);
  assert.equal(b.heavyEscalationAdded, false);
  assert.equal(b.vaivmBattery40Cited, false);
  const log = path.join(repoRoot, b.finalRun.complete_log_path ?? path.join(b.finalRun.evidence_root, "battery.log"));
  assert.ok(fs.existsSync(log), `battery full log must be retained: ${log}`);
  assert.ok(fs.existsSync(path.join(repoRoot, b.finalRun.evidence_root, "exit_code.txt")), "battery exit_code.txt must be retained");
});

test("US-001 intermediate stage evidence is published and referenced", () => {
  assert.ok(contract, "contract did not parse");
  assert.ok(us001Path && fs.existsSync(us001Path), "US-001 intermediate stage evidence file must exist");
  const ref = contract.us001IntermediateStageEvidence;
  assert.equal(path.join(repoRoot, ref.publishedFile), us001Path);
  assert.equal(ref.status, "gate-pass");
  assert.equal(ref.cleanCommit, "203e9538361b60fee5562e877d1da075b50cbd9a");
  assert.ok(fs.existsSync(ref.gateRunRetainedRoot), "US-001 gate retained root must exist");
  assert.ok(fs.existsSync(ref.rootProbeCasesRerunPostFixLocator), "root-probe rerun JSON must exist");

  const stage = JSON.parse(fs.readFileSync(us001Path!, "utf8"));
  const errors = validateUs001Stage(stage);
  assert.deepEqual(errors, [], `US-001 stage-evidence errors:\n${errors.join("\n")}`);
});

test("parent CORE is not marked complete and obligations stay visible", () => {
  assert.ok(contract, "contract did not parse");
  assert.equal(contract.parentCoreStatus.complete, false);
  assert.equal(contract.parentCoreStatus.fullCampaignCertificationClaimed, false);
  assert.match(contract.parentCoreStatus.statement, /NOT marked complete/);
  assert.ok(contract.remainingObligations.length >= 4);
  assert.match(contract.remainingObligations.join("\n"), /per-landing/i);
  assert.match(contract.remainingObligations.join("\n"), /both-host|origin|main/i);
});

test("operator publication exists and is byte-identical to the checkout copy (when present on this host)", () => {
  assert.ok(contract, "contract did not parse");
  const checkoutCopy = path.join(repoRoot, contract.publication.checkoutCopyPath);
  assert.ok(fs.existsSync(checkoutCopy), `checkout contract copy missing: ${checkoutCopy}`);
  const operatorPath = contract.publication.operatorPath;
  if (fs.existsSync(operatorPath)) {
    assert.equal(
      fs.readFileSync(operatorPath, "utf8"),
      fs.readFileSync(checkoutCopy, "utf8"),
      "operator contract copy must be byte-identical to the checkout copy",
    );
  } else {
    // The operator path lives in a sibling operator checkout; on a host that
    // does not carry it the cross-checkout copy is simply not assertable.
    // The checkout copy (same-checkout retained evidence) is always asserted.
    assert.ok(typeof operatorPath === "string" && operatorPath.length > 0);
  }
});
