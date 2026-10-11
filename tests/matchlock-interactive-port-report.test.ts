/**
 * MTLK-INTERACTIVE-SUITE US-013 — committed PORT-REPORT.md contract.
 *
 * Pins the traceability report for the in-repo port of the M0–M7 interactive
 * Matchlock acceptance semantics:
 *
 *   - the report exists and carries every required section heading;
 *   - it cites the reference sources tarball, driver, self-test and W2 toolset
 *     shas;
 *   - every ADDITION is present in the ADDITIONS section;
 *   - every case M0–M7 carries a protective `Assertion preserved:` note and the
 *     report explicitly confirms no protected assertion was weakened;
 *   - every deviation is recorded with a justification, the not-ported material
 *     is named, and the requested-vs-observed matrix, exact commands and
 *     recorded shas are present.
 *
 * Pure filesystem reads (no child_process, no dist import, no daemon, no VM, no
 * network), so this file stays in the parallel lane and needs no
 * tests/serial-files.txt entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const reportPath = resolve(
  repoRoot,
  "scripts",
  "tests",
  "matchlock",
  "PORT-REPORT.md",
);

const report = readFileSync(reportPath, "utf-8");

/** Required top-level section headings, verbatim. */
const REQUIRED_HEADINGS = [
  "## 1. Reference materials and shas",
  "## 2. Per-case port status (M0–M7)",
  "## 3. Changes vs the reference (with justification)",
  "## 4. ADDITIONS",
  "## 5. Protected assertions preserved",
  "## 6. Not ported (and why)",
  "## 7. Requested vs observed tier matrix",
  "## 8. Exact commands run",
  "## 9. Recorded shas",
  "## 10. Residual risks",
  "## 11. README / AGENTS.md additions",
] as const;

/** Reference shas the report must cite. */
const REFERENCE_SHAS = {
  sourcesTarball:
    "8c1101da1ef394ed1d6fd782a17330f5555ec44cd7aa151fa29e46ed35404782",
  driver: "75667065ab885728365e985141345055fae2360d9978163479c4c1ad3f3a382d",
  selftest: "2315ed7a50cd94260c427c0c86e3b15e779242f3585493c0bd0a0ea7decd80f8",
  w2Toolset: "c9e93c41aef78f75b7df864858203a4762ad3ef0b4f40079840693c12ed456c8",
} as const;

/** Distinctive names of every ADDITION; each must appear in the ADITIONS section. */
const ADDITIONS = [
  "tamandua-sus stopped-VM accounting fix",
  "capability probe (fail-closed)",
  "tier-aware validator",
  "requested manifest",
  "model-endpoint configuration",
  "T3 credential gate + token-spend disclosure",
  "private image-store seeding",
  "single-layer gate-lock handshake",
  "observed-rounds guard wiring",
  "one-command entrypoint",
  "T1 no-VM runner",
  "port-report test",
] as const;

/** Recorded host/suite shas the report must cite. */
const RECORDED_SHAS = [
  "556d5f6e2594a3a8e768af40136b8ffbc6ce7abfd41455fc836ee86658cbaa21", // lib/common.sh
  "a995fbdfbe3d0a04da19d429bc1bb0bd89fa66e9118a18708109db159ea0428d", // runner/m7-spot-run.sh
  "aca99c3c9e10b3942933a96cdb1a3ba4febf428f1bf0dc89c7eb7c083d3d0456", // tamandua (PATH)
  "94ae192cc669412ea0d24b4da5370224bc2f4d05d1b35948964833b96c5d7083", // /usr/local/bin/matchlock
  "07826705e0abf015ac20ee38aff23dde794eb48a518a9e9be4f7e33d518ea72d", // /usr/local/bin/guest-init
  "sha256:145fe73eeefadf0a5350febadbab3f9dc2af06335a07d6e36c7f6dbfe036c622", // image digest
] as const;

/** Material the report must state was NOT ported, with a reason. */
const NOT_PORTED = [
  "w2-run.sh",
  "w2-reattach.sh",
  "w2-signoff.sh",
  "w2-cleanup.sh",
  "w2-chain2.sh",
  "warmplan.py",
  "M5b.json",
  "M6b.json",
  "M6c.json",
  "SPK-PI-V1.json",
  "SPK-HERMES-V1.json",
  "SPK-SHELL-V1.json",
] as const;

/** Extract the `## 4. ADDITIONS` section body. */
function sectionBody(heading: string): string {
  const start = report.indexOf(heading);
  assert.ok(start >= 0, `report must carry the heading ${heading}`);
  const rest = report.slice(start);
  const next = rest.search(/\n## /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

/** Extract each `### M<n>` case section body, keyed by `M<n>`. */
function caseSections(): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current !== null) sections.set(current, buffer.join("\n"));
    buffer = [];
  };
  for (const line of report.split(/\r?\n/)) {
    const sub = line.match(/^### /);
    if (sub) {
      flush();
      const id = line.match(/^### (M[0-7])\b/);
      current = id ? id[1] : null;
      continue;
    }
    if (/^## /.test(line)) {
      flush();
      current = null;
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  return sections;
}

describe("Matchlock interactive PORT-REPORT.md (MTLK-INTERACTIVE-SUITE US-013)", () => {
  it("exists as a committed report with every required section heading", () => {
    assert.ok(existsSync(reportPath), `PORT-REPORT.md is missing at ${reportPath}`);
    for (const heading of REQUIRED_HEADINGS) {
      assert.ok(
        report.includes(heading),
        `PORT-REPORT.md must carry the section heading \`${heading}\``,
      );
    }
  });

  it("cites the sources, driver, selftest and W2 toolset reference shas", () => {
    for (const [name, sha] of Object.entries(REFERENCE_SHAS)) {
      assert.ok(
        report.includes(sha),
        `PORT-REPORT.md must cite the ${name} sha ${sha}`,
      );
    }
  });

  it("records every ADDITION in the ADDITIONS section", () => {
    const additions = sectionBody("## 4. ADDITIONS");
    for (const addition of ADDITIONS) {
      assert.ok(
        additions.includes(addition),
        `ADDITIONS section must name the addition \`${addition}\``,
      );
    }
  });

  it("carries a protective assertion-preserved note for every case M0–M7", () => {
    const sections = caseSections();
    for (let i = 0; i <= 7; i += 1) {
      const id = `M${i}`;
      const body = sections.get(id);
      assert.ok(body !== undefined, `report must carry a \`### ${id}\` case section`);
      assert.match(
        body as string,
        /Assertion preserved:/,
        `case ${id} must record an \`Assertion preserved:\` note`,
      );
    }
  });

  it("explicitly confirms no protected assertion was weakened", () => {
    assert.match(report, /No protected assertion was weakened/);
    assert.match(report, /assertions were not weakened/i);
  });

  it("records every deviation with a justification and the corrected VM registry", () => {
    for (let i = 1; i <= 14; i += 1) {
      assert.ok(
        report.includes(`| C${i} |`),
        `deviation table must carry row C${i}`,
      );
    }
    assert.match(report, /justification/i);
    assert.ok(
      report.includes("~/.matchlock/state.db"),
      "report must name the corrected VM registry",
    );
    assert.match(
      report,
      /never the image-store cache's `state\.db`/i,
      "report must explicitly reject the image-store cache path as the VM registry",
    );
  });

  it("records what was not ported and why", () => {
    const notPorted = sectionBody("## 6. Not ported (and why)");
    for (const name of NOT_PORTED) {
      assert.ok(
        notPorted.includes(name),
        `not-ported section must name \`${name}\``,
      );
    }
    assert.match(notPorted, /campaign orchestration/i);
  });

  it("records the requested-vs-observed tier matrix, exact commands and shas", () => {
    const matrix = sectionBody("## 7. Requested vs observed tier matrix");
    assert.match(matrix, /Requested/);
    assert.match(matrix, /Observed result/);
    assert.match(matrix, /UNEXECUTED/);
    for (const tier of ["t1", "t2", "t3", "t4"]) {
      assert.ok(matrix.includes(`\`${tier}\``), `matrix must cover tier ${tier}`);
    }

    const commands = sectionBody("## 8. Exact commands run");
    assert.match(commands, /run-interactive-suite\.sh --tier t1/);
    assert.match(commands, /--expect-digest/);

    for (const sha of RECORDED_SHAS) {
      assert.ok(
        report.includes(sha),
        `PORT-REPORT.md must record the sha ${sha}`,
      );
    }
  });
});
