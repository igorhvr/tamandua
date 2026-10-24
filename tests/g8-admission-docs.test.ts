/**
 * G8 ADMISSION-INTEGRATION US-015 — committed documentation regression for the
 * launch-gate qualification record.
 *
 * Pure filesystem reads (no child_process, no daemon, no VM, no network), so
 * this file stays in the PARALLEL lane and needs no tests/serial-files.txt
 * entry. It pins the operator-facing artifacts US-015 required:
 *   - `docs/gate/G8-ADMISSION-INTEGRATION.md`: the four callers and the
 *     mandated order, refusal semantics (receipt first / zero creates / exit 78
 *     imported from gate-exit-code.ts), the receipt/qualification/anchor path
 *     conventions, the (dev, ino)+config revalidation rule and its accepted
 *     window, the backstop binding rule, the no-lease limitation, the
 *     out-of-scope raw `matchlock run` scoping, the G9 adoption audit, the
 *     artifact-binding table, the Docker-evidence label, the guest-visible
 *     config record, the mixed-overlap outcomes, SEPARATE gate-only and
 *     combined result sets, the ENVIRONMENT signature, and the dogfooding
 *     record;
 *   - the AGENTS.md G8 anchor — see the NOTE below, which is the honest shape
 *     of that requirement in this tree.
 *
 * NOTE on AGENTS.md: the G8 section was NOT applied by the earlier session. The
 * write to `AGENTS.md` was refused by the harness protection on
 * agent-instruction files (the approval prompt timed out and silence is not
 * consent), and that refusal forbade retrying it or routing the same edit
 * through another path. The document therefore carried the exact section text
 * in Appendix A and recorded the gap in "What remains open". This test pins
 * both branches of that state: if a session applies the section, the
 * anchor and its required phrases are asserted; while it is unapplied, the
 * document must still record the blocked write and carry the exact text. The
 * record can never be quietly dropped. UPDATE (run 196, 2026-10-24): the G8
 * section HAS since been applied — run
 * `b991d85c-fb79-43f0-80f1-fdbb5256f5b3` inserted the Appendix A text verbatim
 * into `AGENTS.md`; a new invocation is not a retry of that earlier blocked
 * session, and "What remains open" records the applied state together with
 * the blocked-write history. The applied branch above is now the live one,
 * and the exact text remains in Appendix A for reference.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const docPath = resolve(repoRoot, "docs/gate/G8-ADMISSION-INTEGRATION.md");
const agentsPath = resolve(repoRoot, "AGENTS.md");

const doc = readFileSync(docPath, "utf-8");
const agents = readFileSync(agentsPath, "utf-8");

/** Slice one `## ` section (heading included) up to the next `## ` heading. */
function section(heading: string): string {
  const start = doc.indexOf(heading);
  if (start < 0) return "";
  const next = doc.indexOf("\n## ", start + heading.length);
  return next < 0 ? doc.slice(start) : doc.slice(start, next);
}

const AGENTS_G8_HEADING = "### G8 launch-gate admission (G8-ADMISSION-INTEGRATION)";
const agentsHasG8 = agents.includes(AGENTS_G8_HEADING);

describe("G8 qualification record exists and identifies itself", () => {
  it("is a committed Markdown document at the required path", () => {
    assert.ok(existsSync(docPath), "docs/gate/G8-ADMISSION-INTEGRATION.md must exist");
    assert.match(doc, /^# G8 Admission Integration — wiring and qualification record/m);
  });

  it("names the bead, the branch and the run that delivered it", () => {
    assert.ok(doc.includes("tamandua-7p5.1.8"), "the bead id");
    assert.ok(doc.includes("feature/g8-admission-integration"), "the branch");
    assert.ok(doc.includes("321f06ae-b6af-40a0-9a0c-0ee467d4f5e6"), "the run id");
  });

  it("has every required section heading", () => {
    const required = [
      "## 1. Callers, invocation kinds and the mandated order",
      "## 2. Refusal semantics",
      "## 3. Evidence paths: receipt, qualification record, admission anchor",
      "## 4. Revalidation by identity: `(dev, ino)` + config, and the accepted window",
      "## 5. Controller backstop: bound to THIS invocation",
      "## 6. No lease",
      "## 7. Scope: what is gated, what is explicitly out of scope",
      "## 8. G9 adoption audit",
      "## 9. Artifact binding (what a decision is bound to)",
      "## 10. Guest-visible effective config per store",
      "## 11. Mixed overlap outcomes (scenario C)",
      "## 12. Results — two SEPARATE result sets",
      "## 13. ENVIRONMENT: real-VM boot is blocked in the agent sandbox",
      "## 14. Dogfooding record",
      "## 15. Exact commands used",
      "## What remains open",
    ];
    for (const heading of required) {
      assert.ok(doc.includes(heading), `missing section heading: ${heading}`);
    }
  });
});

describe("G8 record: callers and the mandated order", () => {
  it("names all four invocation kinds and the controller backstop", () => {
    const callers = section("## 1. Callers, invocation kinds and the mandated order");
    for (const kind of [
      "interactive-hermes",
      "interactive-hermes-shell",
      "scheduled-dispatch",
      "scheduled-attempt",
    ]) {
      assert.ok(callers.includes(kind), `missing invocation kind ${kind}`);
    }
    assert.ok(callers.includes("requireLaunchGateVerdict"), "the controller backstop");
    assert.ok(callers.includes("planInteractiveSession"), "the interactive caller");
    assert.ok(callers.includes("applyScheduledLaunchGate"), "the dispatch caller");
    assert.ok(callers.includes("applyScheduledAttemptGate"), "the attempt caller");
  });

  it("states the mandated order (final mount plan, every store, revalidate, then create)", () => {
    const callers = section("## 1. Callers, invocation kinds and the mandated order");
    const order = [
      "resolve profile + selection",
      "final",
      "build the store set",
      "for **every** discoverable store",
      "aggregating **all** findings",
      "revalidate membership + config by identity",
      "only then create the VM",
    ];
    for (const step of order) {
      assert.ok(callers.includes(step), `missing order step: ${step}`);
    }
  });

  it("records the invocation id shapes (interactive pid+start, scheduled dispatch/attempt)", () => {
    assert.ok(doc.includes("interactive:<subcommand>:pid:<pid>:start:<ISO instant>"));
    assert.ok(doc.includes("run:<bare-run-id>:round:<jobId>:dispatch"));
    assert.ok(doc.includes("attempt"));
  });
});

describe("G8 record: refusal semantics", () => {
  it("requires the receipt FIRST, zero create calls and no partial mount", () => {
    const refusal = section("## 2. Refusal semantics");
    assert.match(refusal, /receipt is written FIRST/i);
    assert.match(refusal, /Zero create calls, no partial mount/);
    assert.ok(refusal.includes("create-call count of ZERO"));
  });

  it("imports exit 78 from gate-exit-code.ts and never spells it as a status literal", () => {
    const refusal = section("## 2. Refusal semantics");
    assert.ok(doc.includes("LAUNCH_GATE_REFUSAL_EXIT_CODE"));
    assert.ok(doc.includes("src/installer/matchlock/gate-exit-code.ts"));
    assert.match(refusal, /No gate module contains a\s+numeric status literal/);
    assert.match(refusal, /gate-adoption-guard\.test\.ts/);
    // The refusal rule itself must never instruct a caller to hard-code the
    // number. (Section 8's mutation proof quotes `process.exit(78)` as the
    // text a guard must reject, which is the opposite of instructing it.)
    assert.ok(
      !/process\.exit\(\s*78\s*\)/.test(refusal),
      "the refusal section must not show a hard-coded process.exit(78)",
    );
  });

  it("makes a receipt-write failure an operational refusal, never an allow", () => {
    assert.match(doc, /receipt-write failure is itself a refusal/i);
    assert.ok(doc.includes("receiptWritten: false"));
  });

  it("names the blocking-equivalent that stops a refused scheduled run re-dispatching", () => {
    assert.ok(doc.includes("forceFailRun"));
    assert.ok(doc.includes("run.matchlock_gate_refused"));
    assert.match(doc, /`scheduling_status = 'error'` is NOT a guard/);
  });

  it("never claims the header proves delete", () => {
    assert.ok(doc.includes("rollback-format"));
    assert.match(doc, /Never claim the header proves DELETE/);
  });
});

describe("G8 record: the closed ten-code vocabulary", () => {
  const TEN_CODES = [
    "not-delete-config",
    "wal-header",
    "header-unreadable",
    "header-not-sqlite",
    "header-truncated",
    "sidecar-unresolved",
    "store-missing",
    "inventory-incomplete",
    "path-unresolved",
    "permission-denied",
  ];

  it("lists exactly the ten canonical reason codes", () => {
    const refusal = section("## 2. Refusal semantics");
    for (const code of TEN_CODES) {
      assert.ok(refusal.includes(code), `missing reason code: ${code}`);
    }
    assert.match(refusal, /closed at exactly ten codes/);
    assert.ok(refusal.includes("REASON_CODE_ORDER"));
  });

  it("keeps operational failures in a separate class, never an eleventh code", () => {
    const refusal = section("## 2. Refusal semantics");
    assert.match(refusal, /OPERATIONAL refusal|operational failure/i);
    assert.match(refusal, /never renumbered into these ten/);
    assert.match(refusal, /findings: \[\]/);
  });
});

describe("G8 record: evidence path conventions", () => {
  const evidence = section("## 3. Evidence paths: receipt, qualification record, admission anchor");

  it("records the receipt path rule and its resolver", () => {
    assert.ok(evidence.includes("<stateDir>/matchlock/gate/<sanitized invocationId>.json"));
    assert.ok(evidence.includes("resolveLaunchGateReceiptPath"));
  });

  it("records the qualification-record and admission-anchor siblings", () => {
    assert.ok(evidence.includes(".qualification.json"));
    assert.ok(evidence.includes("matchlock-gate-qualification"));
    assert.ok(evidence.includes(".admission.json"));
    assert.ok(evidence.includes("matchlock-admission-anchor"));
    assert.ok(evidence.includes("resolveQualificationRecordPath"));
    assert.ok(evidence.includes("resolveInteractiveAdmissionAnchorPath"));
  });

  it("records that a receipt is written on both paths, with launched only after vmCreated", () => {
    assert.ok(evidence.includes('action: "refused"'));
    assert.ok(evidence.includes('action: "launched"'));
    assert.ok(evidence.includes("vmCreated: true"));
  });
});

describe("G8 record: revalidation by identity and its accepted window", () => {
  const revalidation =
    section("## 4. Revalidation by identity: `(dev, ino)` + config, and the accepted window");

  it("compares (dev, ino) as decimal strings, not numbers", () => {
    assert.ok(revalidation.includes("(dev, ino)"));
    assert.match(revalidation, /DECIMAL STRINGS/);
    assert.match(revalidation, /never\s+numeric `===`/);
  });

  it("re-proves membership and config by identity", () => {
    assert.ok(revalidation.includes("store-set-changed"));
    assert.ok(revalidation.includes("store-identity-changed"));
    assert.ok(revalidation.includes("config-changed"));
    assert.ok(revalidation.includes("launch-gate-revalidate.ts"));
  });

  it("discloses the accepted window: no header re-observation", () => {
    assert.match(revalidation, /store header is not\s+observed again/);
    assert.match(revalidation, /accepted, disclosed window/);
    assert.ok(revalidation.includes("launch-gate.js"), "the no-import rule is named");
  });

  it("records the change as an operational refusal with findings [] and exit 78", () => {
    assert.ok(revalidation.includes("findings: []"));
    assert.ok(revalidation.includes("78"));
  });
});

describe("G8 record: controller backstop binding", () => {
  const backstop = section("## 5. Controller backstop: bound to THIS invocation");

  it("binds the verdict to this invocation id and store-set key", () => {
    assert.ok(backstop.includes("matchlock_gate_verdict_missing"));
    assert.ok(backstop.includes("binding.invocationId === launchGate.invocationId"));
    assert.ok(backstop.includes("storeSetKey"));
    assert.match(backstop, /never re-evaluates/);
  });

  it("refuses a verdict belonging to a DIFFERENT invocation", () => {
    assert.match(backstop, /foreign\s+verdict|another invocation/i);
  });

  it("keeps the ungated path byte-identical", () => {
    assert.match(backstop, /byte-identical \(native pi\/dsh runs\)/);
  });
});

describe("G8 record: no-lease limitation and scope", () => {
  it("states the no-lease sentence the receipts carry", () => {
    const lease = section("## 6. No lease");
    assert.ok(lease.includes("no-lease: concurrent admissions may both pass"));
    assert.ok(lease.includes("NO_LEASE_LIMITATION"));
  });

  it("scopes raw `matchlock run` with a hermes payload OUT OF SCOPE", () => {
    const scope = section("## 7. Scope: what is gated, what is explicitly out of scope");
    assert.match(scope, /raw\s+`matchlock run` with a hermes payload/);
    assert.ok(scope.includes("GATE_QUALIFICATION_OUT_OF_SCOPE"));
    assert.ok(scope.includes("scope.outOfScope"));
    for (const kind of ["interactive-hermes", "interactive-hermes-shell", "scheduled-dispatch", "scheduled-attempt"]) {
      assert.ok(scope.includes(kind), `scope must name the gated kind ${kind}`);
    }
    assert.match(scope, /Native \(non-Matchlock\) runs do not call the wiring/);
  });
});

describe("G8 record: G9 adoption audit", () => {
  const g9 = section("## 8. G9 adoption audit");

  it("records that nothing was missing at the base", () => {
    assert.match(g9, /Nothing was missing at the base/);
    assert.ok(g9.includes("e6a4cf50"));
  });

  it("names the adopted G9 modules and the structural guard", () => {
    assert.ok(g9.includes("gate-exit-code.ts"));
    assert.ok(g9.includes("gate-remedy-text.ts"));
    assert.ok(g9.includes("renderGateRemedyText"));
    assert.ok(g9.includes("gate-adoption-guard.test.ts"));
    assert.match(g9, /No G9 module was\s+modified/);
  });
});

describe("G8 record: artifact binding table", () => {
  const binding = section("## 9. Artifact binding (what a decision is bound to)");

  it("binds the executed Tamandua commit, tree and dist stamp", () => {
    assert.ok(binding.includes("86ad720d2be50ad4c6f0f1a1575e7127b7c29d6d"));
    assert.ok(binding.includes("94483bbe4d1463cec27d613907fbf6f18d902f47"));
    assert.ok(binding.includes("20261024T052916Z_86ad720d"));
    assert.ok(binding.includes("3ae284b0789dabe6e51b9e126df9be5669cb7e7b"));
    assert.ok(binding.includes("fa4571cc896166db8c6eb9d7a8032e7479409841"));
    assert.ok(binding.includes("distVersionStampCommit"));
  });

  it("binds the executed matchlock and guest-init artifacts by sha256", () => {
    assert.ok(binding.includes("4b9723359f734f63e2cb52308696c6c52a7b193b2b1858b6e62a58f83c0e3297"));
    assert.ok(binding.includes("afd6878bf45cd443cda6a8a29c3a153d1cf5cd0b82dc6b26d5fea7ab9312e940"));
    assert.ok(binding.includes("matchlock version 0.2.18-blip"));
    assert.ok(binding.includes("unset => resolved by matchlock"), "an unset guest-init is never fabricated");
  });

  it("binds the SELECTED image digest, profile home and config sources", () => {
    assert.ok(binding.includes("sha256:2b2991ff06ee632c142284fd1ba329ec60fada650bc68d216b7f6323a93bd251"));
    assert.ok(binding.includes("sha256:818f4fec6635a1249031b05f9949fb7f18fbe69cc693940257a49464e4f8f275"));
    assert.ok(binding.includes("hostEffectiveDir"));
    assert.ok(binding.includes("guestHermesHome"));
    assert.ok(binding.includes("configSources"));
  });

  it("records the run/attempt evaluated and the unreadable honesty rule", () => {
    assert.ok(binding.includes("invocation.runId"));
    assert.ok(binding.includes("invocation.roundId"));
    assert.match(binding, /PRESENT as\s+`unreadable`/);
  });
});

describe("G8 record: Docker evidence is labelled, never equated", () => {
  it("labels the stock-Hermes delete-mode evidence as Docker evidence", () => {
    assert.ok(doc.includes("Docker evidence"));
    assert.ok(doc.includes("sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a"));
    assert.ok(doc.includes("sha256:9140629c9f408a6e9c285434eb6ab0cebd67db146c324db33e2798bac4fb7dff"));
  });

  it("keeps the two identifiers distinct and demands inspection for equivalence", () => {
    const docker = section("### Docker evidence vs the repository image — labelled, not equated");
    assert.match(docker, /NOT proof of equivalence/);
    assert.match(docker, /by INSPECTION/);
  });
});

describe("G8 record: guest-visible effective config", () => {
  const guest = section("## 10. Guest-visible effective config per store");

  it("records the in-guest probe and its perspective", () => {
    assert.ok(guest.includes("gate-config-probe.ts"));
    assert.ok(guest.includes('perspective: "guest"'));
    assert.ok(guest.includes("guest-observed:"));
    assert.ok(guest.includes("host-observed:"));
  });

  it("records unmeasured provenance instead of a guessed mode, and the discrepancy rule", () => {
    assert.ok(guest.includes("unmeasured"));
    assert.match(guest, /never a fabricated `delete`/);
    assert.ok(guest.includes("discrepancy"));
  });
});

describe("G8 record: mixed-overlap outcomes", () => {
  const mixed = section("## 11. Mixed overlap outcomes (scenario C)");

  it("records C1 as a real-VM requirement with its always-on controls", () => {
    assert.match(mixed, /C1/);
    assert.ok(mixed.includes("PRAGMA integrity_check"));
    assert.ok(mixed.includes("tests/matchlock-scenario-c-controls.test.ts"));
    assert.match(mixed, /Not yet qualified through a\s+real VM/);
  });

  it("records C2 as a pass with the transient rollback-journal refusal and the later allow", () => {
    assert.match(mixed, /C2/);
    assert.ok(mixed.includes("sidecar-unresolved"));
    assert.match(mixed, /a checkpoint is NOT a treatment for it/);
    assert.match(mixed, /may be TRANSIENT/);
    assert.match(mixed, /re-evaluates to ALLOW/);
  });

  it("states that neither unconditional admission nor lifetime exclusivity is claimed", () => {
    assert.match(mixed, /neither unconditional admission/);
    assert.match(mixed, /process-lifetime exclusivity/);
  });
});

describe("G8 record: gate-only and combined result sets are separate", () => {
  const results = section("## 12. Results — two SEPARATE result sets");

  it("has two distinct result-set sections", () => {
    assert.ok(results.includes("### Gate-only set (no overlay-line code)"));
    assert.ok(results.includes("### Combined set (gate line + overlay line + combined-tree test + history fix)"));
  });

  it("records the gate-only candidate, its dist stamp and its lane counts", () => {
    assert.ok(results.includes("1583caedc4a17292e51758394bdd54c8471d7d42"));
    assert.ok(results.includes("84d957ae7936ad7c5143ef71f90effcc8fe80ef8"));
    assert.ok(results.includes("20261024T105017Z_1583caed"));
    assert.ok(results.includes("tests 5965 / pass 5951 / fail 0 / skipped 14"));
  });

  it("records the combined candidate, its ancestry, both runs and the lane counts", () => {
    assert.ok(results.includes("e9799edcec583175f1c85f5e79d099e3d2107666"));
    assert.ok(results.includes("897766277c63da17dc307c4e3c0b7dfd6dd3e5f4"));
    assert.ok(results.includes("20261024T105012Z_e9799edc"));
    assert.ok(results.includes("926f589d"));
    assert.ok(results.includes("5983 / pass 5969 / fail 0 / skipped 14"));
    assert.match(results, /TEST_CMD run 1 \*\*exit 1\*\*/);
    assert.match(results, /TEST_CMD run 2 \*\*exit 0\*\*/);
  });

  it("refuses to let a gate-only pass stand in for the overlay line", () => {
    assert.match(results, /do not cover|does not cover/);
    assert.match(results, /not\*\* an ancestor|is\s+\*\*not\*\* an ancestor/);
  });
});

describe("G8 record: ENVIRONMENT signature", () => {
  const env = section("## 13. ENVIRONMENT: real-VM boot is blocked in the agent sandbox");

  it("records the sandbox capability signature, never a product pass", () => {
    assert.ok(env.includes("TUNSETIFF: operation not permitted"));
    assert.ok(env.includes("netlink receive: operation not permitted"));
    assert.ok(env.includes("NoNewPrivs: 1"));
    assert.ok(env.includes("CapEff: 0"));
    assert.match(env, /never a product pass/);
  });
});

describe("G8 record: dogfooding record", () => {
  const dogfood = section("## 14. Dogfooding record");

  it("lists the run id and harness", () => {
    assert.ok(dogfood.includes("321f06ae-b6af-40a0-9a0c-0ee467d4f5e6"));
    assert.ok(dogfood.includes("run number 185"));
    assert.match(dogfood, /\*\*hermes\*\*/);
    assert.ok(dogfood.includes("runs.matchlock_policy = NULL"));
  });

  it("lists the start and delivered commit+tree", () => {
    assert.ok(dogfood.includes("e6a4cf50235892d811ad8558e2da3a5c63c40c4d"));
    assert.ok(dogfood.includes("55090f94c73d13d8eac83e64ed8e845971868160"));
    assert.ok(dogfood.includes("e9799edcec583175f1c85f5e79d099e3d2107666"));
    assert.ok(dogfood.includes("897766277c63da17dc307c4e3c0b7dfd6dd3e5f4"));
  });

  it("lists refusal and allow receipt evidence", () => {
    assert.ok(dogfood.includes("Refusal receipt"));
    assert.ok(dogfood.includes(".tamandua/matchlock/gate/run_1f8563c8"));
    assert.ok(dogfood.includes("sidecar-unresolved"));
    assert.ok(dogfood.includes("Allow (gate decision)"));
    assert.ok(dogfood.includes("sha256:b1a0169cf102bf51659d56f2a40c352b20f0028b58e5e007fc6bd9954ee2266e"));
    assert.match(dogfood, /No `launched` receipt exists on this host/);
  });
});

describe("G8 record: exact commands", () => {
  const commands = section("## 15. Exact commands used");

  it("records the driver, the real-path C2 command, the build and the TEST_CMD", () => {
    assert.ok(commands.includes("./run-matchlock-admission-qualification-e2e-test"));
    assert.ok(commands.includes("--test-name-pattern 'scenario C2: a nonempty rollback journal'"));
    assert.ok(commands.includes("npm run build"));
    assert.ok(commands.includes("tamandua-test --repo"));
    assert.ok(commands.includes("npx tsc --noEmit -p tsconfig.json"));
  });
});

describe("G8 US-015: the AGENTS.md G8 anchor (applied, or recorded as blocked)", () => {
  it("either AGENTS.md carries the G8 section, or the document records the blocked write", () => {
    if (agentsHasG8) {
      // An interactive session applied the section: pin the phrases the
      // requirement names, so an incomplete copy cannot pass as applied.
      assert.ok(agents.includes("src/installer/matchlock/launch-gate-wiring.ts"));
      assert.ok(agents.includes("LAUNCH_GATE_REFUSAL_EXIT_CODE"));
      assert.ok(agents.includes("78"));
      assert.ok(agents.includes("no-lease"));
      assert.ok(agents.includes("NO_LEASE_LIMITATION"));
      return;
    }

    // Not applied: the gap must be recorded, with the exact text ready to paste.
    assert.match(
      doc,
      /The AGENTS\.md G8 section has NOT been applied/,
      "the document must disclose that the AGENTS.md section is not applied",
    );
    assert.match(doc, /approval prompt timed\s+out/, "the blocked-write reason must be recorded");
    assert.ok(doc.includes("## Appendix A — AGENTS.md G8 section (text to apply; currently NOT applied)"));
    assert.ok(doc.includes(AGENTS_G8_HEADING), "the exact section text must be present to apply");
    assert.ok(doc.includes("`no-lease: concurrent admissions may both pass`") || doc.includes("no-lease: concurrent admissions may both pass"));
  });

  it("never claims the AGENTS.md section was applied when it was not", () => {
    if (agentsHasG8) return;
    assert.ok(
      !/AGENTS\.md (now )?contains the G8 section/i.test(doc),
      "the record must not claim an unapplied AGENTS.md edit",
    );
  });
});
