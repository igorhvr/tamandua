/**
 * US-003 (OVERLAY-CONTINUATION) — every real-VM dsh gate is wired to the
 * INVOCATION-scoped dsh profile-overlay API.
 *
 * The product change (OVERLAY-INV-SCOPED) bound the overlay root to the
 * controller's own host-generated invocation id:
 *
 *   prepareDshProfileOverlay(runId, invocationId, liveStateRoot, hostHome)
 *   dshProfileOverlayRoot(runId, invocationId, liveStateRoot)
 *   cleanupDshProfileOverlay(runId, invocationId, liveStateRoot)
 *   dshProfileInvocationGroupRoot(runId, liveStateRoot)   // the group dir
 *
 * The e2e gate files load these through `any`-typed dynamic imports, so a
 * legacy call shape is invisible to `tsc`: the pre-change gates called the
 * 3/2/2-arg forms and would therefore pass a `liveStateRoot` in the
 * `invocationId` slot on cleanup (deleting the wrong tree, or throwing). This
 * file is the fast structural pin that keeps that regression out.
 *
 * It proves, WITHOUT booting a VM (real-VM overlap gates cannot run in-guest;
 * they remain host/coordinator steps):
 *
 *   1. the exported arities are exactly 4 / 3 / 3 and
 *      `dshProfileInvocationGroupRoot` is exported;
 *   2. no file under `e2e-tests/` calls any of the three functions with a
 *      legacy argument count (the call sites are arity-checked by scanning the
 *      real sources, so a renamed parameter cannot sneak a legacy shape by);
 *   3. no gate file carries one of the exact forbidden legacy call patterns;
 *   4. every gate that observes a LIVE overlay watches the per-run grouping
 *      dir (`dshProfileInvocationGroupRoot`) with
 *      `DshOverlayObserver(..., { invocationGroupDir: true })` instead of
 *      predicting an invocation leaf.
 *
 * Everything here is a SIMULATED/structural control: no child process, no
 * daemon, no dsh, no VM. Pure fs reads + one dist import -> parallel lane, so
 * this file needs no `tests/serial-files.txt` entry.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const distOverlayModule = path.join(
  repoRoot,
  "dist",
  "installer",
  "matchlock",
  "dsh-profile-overlay.js",
);

/** The five real-VM dsh gate files this story ports. */
const GATE_FILES = [
  {
    file: "e2e-tests/matchlock-dsh-gate.test.ts",
    observesLiveOverlay: true,
  },
  {
    file: "e2e-tests/matchlock-dsh-real-boot-gate.test.ts",
    observesLiveOverlay: true,
  },
  {
    file: "e2e-tests/matchlock-dsh-merge-worktree-gate.test.ts",
    observesLiveOverlay: true,
  },
  {
    file: "e2e-tests/matchlock-dsh-fsync-diagnosis.test.ts",
    // No live observer: this gate only runs the plan reconciliation
    // prepare/cleanup probe, which now names a deterministic stand-in id.
    observesLiveOverlay: false,
  },
  {
    file: "e2e-tests/matchlock-dsh-profile-overlay-gate.test.ts",
    observesLiveOverlay: true,
  },
] as const;

/** Exact legacy call shapes the port removed (arity-invisible to tsc). */
const FORBIDDEN_LEGACY_PATTERNS = [
  "prepareDshProfileOverlay(runId, liveStateRoot",
  "dshProfileOverlayRoot(runId, liveStateRoot",
  "cleanupDshProfileOverlay(runId, liveStateRoot",
  "dshProfileOverlayRoot(runId, tamanduaDir)",
] as const;

/** Required (arity, module export) of the invocation-scoped API. */
const REQUIRED_ARITIES: ReadonlyArray<{ name: string; arity: number }> = [
  { name: "prepareDshProfileOverlay", arity: 4 },
  { name: "dshProfileOverlayRoot", arity: 3 },
  { name: "cleanupDshProfileOverlay", arity: 3 },
];

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf-8");
}

/**
 * Walk `e2e-tests/**` and return every file that mentions one of the three
 * overlay function names, with its source.
 */
function readE2eSourcesMentioningOverlayApi(): Array<{ rel: string; source: string }> {
  const out: Array<{ rel: string; source: string }> = [];
  const walk = (absDir: string): void => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && abs.endsWith(".ts")) {
        const source = fs.readFileSync(abs, "utf-8");
        if (
          source.includes("prepareDshProfileOverlay") ||
          source.includes("dshProfileOverlayRoot") ||
          source.includes("cleanupDshProfileOverlay")
        ) {
          out.push({ rel: path.relative(repoRoot, abs), source });
        }
      }
    }
  };
  walk(path.join(repoRoot, "e2e-tests"));
  return out;
}

interface ExtractedCall {
  /** 1-based line of the function name. */
  line: number;
  /** Number of top-level arguments in the call's parenthesised list. */
  argCount: number;
  /** The call's raw argument text (trimmed, single-line collapsed). */
  argsText: string;
}

/**
 * Extract every `<fnName>(...)` call from `source`, honouring nesting, string
 * literals and line comments so a nested call or a comma inside a string never
 * changes the top-level argument count. Also matches member calls
 * (`mod.prepareDshProfileOverlay(`) because the scan is keyed on the name
 * immediately followed by `(`.
 */
function extractCalls(source: string, fnName: string): ExtractedCall[] {
  const calls: ExtractedCall[] = [];
  const needle = `${fnName}(`;
  let from = 0;
  for (;;) {
    const start = source.indexOf(needle, from);
    if (start === -1) break;
    // Reject `fooBarBaz(` style suffixes (e.g. a different identifier ending
    // in the same characters) — the char before must not be an identifier char.
    const before = start === 0 ? "" : source[start - 1];
    if (/[A-Za-z0-9_$]/.test(before)) {
      from = start + needle.length;
      continue;
    }
    const openParen = start + needle.length - 1;
    let depth = 0;
    let quote: string | null = null;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;
    let close = -1;
    for (let i = openParen; i < source.length; i += 1) {
      const ch = source[i];
      const next = i + 1 < source.length ? source[i + 1] : "";
      if (inLineComment) {
        if (ch === "\n") inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i += 1;
        }
        continue;
      }
      if (quote !== null) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "/" && next === "/") {
        inLineComment = true;
        i += 1;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        depth += 1;
        continue;
      }
      if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0 && ch === ")") {
          close = i;
          break;
        }
        continue;
      }
    }
    if (close === -1) {
      throw new Error(`unbalanced call for ${fnName} at offset ${start}`);
    }
    const argsText = source.slice(openParen + 1, close);
    calls.push({
      line: source.slice(0, start).split("\n").length,
      argCount: countTopLevelArgs(argsText),
      argsText: argsText.replace(/\s+/g, " ").trim(),
    });
    from = close + 1;
  }
  return calls;
}

/** Count top-level comma-separated arguments in an argument-list body. */
function countTopLevelArgs(argsText: string): number {
  if (argsText.trim().length === 0) return 0;
  let depth = 0;
  let quote: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  let count = 1;
  let lastTopLevelComma = -1;
  for (let i = 0; i < argsText.length; i += 1) {
    const ch = argsText[i];
    const next = i + 1 < argsText.length ? argsText[i + 1] : "";
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      continue;
    }
    if (ch === "," && depth === 0) {
      count += 1;
      lastTopLevelComma = i;
    }
  }
  // A trailing comma (prettier-multiline call) is not an extra argument.
  const tail = argsText.slice(lastTopLevelComma + 1).trim();
  if (lastTopLevelComma !== -1 && tail.length === 0) count -= 1;
  return count;
}

describe("matchlock dsh overlay gate wiring (US-003, invocation-scoped API)", () => {
  it("exports the invocation-scoped overlay API with arities 4 / 3 / 3", async () => {
    assert.ok(
      fs.existsSync(distOverlayModule),
      `the built overlay module must exist (run \`npm run build\`): ${distOverlayModule}`,
    );
    const mod = (await import(distOverlayModule)) as Record<string, unknown>;
    for (const { name, arity } of REQUIRED_ARITIES) {
      const fn = mod[name];
      assert.equal(typeof fn, "function", `${name} must be an exported function`);
      assert.equal(
        (fn as (...args: unknown[]) => unknown).length,
        arity,
        `${name} must take ${arity} argument(s) — a legacy arity here silently shifts ` +
          `liveStateRoot into the invocationId slot at the \`any\`-typed gate call sites`,
      );
    }
    assert.equal(
      typeof mod.dshProfileInvocationGroupRoot,
      "function",
      "dshProfileInvocationGroupRoot must be exported (the per-run grouping dir live gates observe)",
    );
    assert.equal(
      (mod.dshProfileInvocationGroupRoot as (...args: unknown[]) => unknown).length,
      2,
      "dshProfileInvocationGroupRoot(runId, liveStateRoot) takes 2 arguments",
    );
  });

  it("has no legacy-arity call site for the three overlay functions anywhere under e2e-tests/", () => {
    const sources = readE2eSourcesMentioningOverlayApi();
    assert.ok(
      sources.length >= GATE_FILES.length,
      `expected at least the ${GATE_FILES.length} dsh gate files to mention the overlay API, got ${sources.length}`,
    );
    const expectedArity = new Map(REQUIRED_ARITIES.map((e) => [e.name, e.arity]));
    const violations: string[] = [];
    for (const { rel, source } of sources) {
      for (const [name, arity] of expectedArity) {
        for (const call of extractCalls(source, name)) {
          if (call.argCount !== arity) {
            violations.push(
              `${rel}:${call.line} ${name}(${call.argsText}) has ${call.argCount} argument(s), ` +
                `expected ${arity} (invocation-scoped API)`,
            );
          }
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `legacy overlay call arity in e2e-tests:\n${violations.join("\n")}`,
    );
  });

  it("carries none of the forbidden legacy call patterns on the five dsh gates", () => {
    const violations: string[] = [];
    for (const { file } of GATE_FILES) {
      const source = readRepoFile(file);
      for (const forbidden of FORBIDDEN_LEGACY_PATTERNS) {
        if (source.includes(forbidden)) {
          violations.push(`${file}: ${forbidden}`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `forbidden legacy overlay call shape(s):\n${violations.join("\n")}`,
    );
  });

  it("observes the per-run grouping dir with invocationGroupDir on every live-overlay gate", () => {
    const violations: string[] = [];
    for (const { file, observesLiveOverlay } of GATE_FILES) {
      const source = readRepoFile(file);
      if (!observesLiveOverlay) continue;
      if (!source.includes("dshProfileInvocationGroupRoot")) {
        violations.push(`${file}: must derive the observed dir via dshProfileInvocationGroupRoot`);
      }
      if (!source.includes("invocationGroupDir: true")) {
        violations.push(`${file}: must observe with DshOverlayObserver(..., { invocationGroupDir: true })`);
      }
    }
    assert.deepEqual(violations, [], violations.join("\n"));
  });

  it("never pre-prepares a predicted invocation leaf in the real-boot gate", () => {
    const source = readRepoFile("e2e-tests/matchlock-dsh-real-boot-gate.test.ts");
    assert.equal(
      /prepare\(\s*runId\s*,\s*tamanduaDir/.test(source),
      false,
      "the real-boot gate must not pre-prepare a predicted invocation leaf " +
        "(exclusive allocation means the runner's controller would refuse to adopt it)",
    );
    // The grouping dir must come from the production derivation, not a hand
    // built literal that could drift from the controller's layout.
    assert.equal(
      /"dsh-profile-invocations",\s*\n?\s*runId/.test(source),
      false,
      "the observed grouping dir must come from dshProfileInvocationGroupRoot, not a hand-built literal",
    );
  });

  it("keeps the hermetic pre-seeds on an explicit deterministic stand-in identity", () => {
    for (const file of [
      "e2e-tests/matchlock-dsh-gate.test.ts",
      "e2e-tests/matchlock-dsh-real-boot-gate.test.ts",
      "e2e-tests/matchlock-dsh-fsync-diagnosis.test.ts",
    ]) {
      const source = readRepoFile(file);
      assert.ok(
        source.includes("deterministicInvocationId"),
        `${file}: a host pre-seed must use an explicit stand-in invocation identity`,
      );
      assert.ok(
        source.includes("host-random"),
        `${file}: the stand-in must be documented as NOT the live (host-random) controller id`,
      );
    }
  });

  it("wires the cross-invocation overlap arm in both teardown orders, with real artifact-survival assertions", () => {
    // US-006 (OVERLAY-CONTINUATION): the decisive acceptance arm of the
    // OVERLAY-INV-SCOPED repair. It is REAL-RUNNER-WHEN-RUN (two fresh VMs) and
    // therefore cannot execute in-guest, so this fast structural pin keeps the
    // arm's coverage from silently rotting: the assertions below are checked as
    // source, and the arm itself stays the FINAL test in the gate file.
    const source = readRepoFile("e2e-tests/matchlock-dsh-profile-overlay-gate.test.ts");

    // (a) one overlap test covering BOTH teardown orders.
    const armTitle = "keeps a live invocation across the peer's cleanup and publishes BOTH invocations' REAL new artifacts (both teardown orders)";
    assert.ok(source.includes(armTitle), `the gate must carry the overlap arm titled: ${armTitle}`);
    assert.match(
      source,
      /\{\s*name:\s*"successor-waits",\s*waitingRole:\s*"successor"\s*\}/,
      "the overlap arm must cover the successor-waits order",
    );
    assert.match(
      source,
      /\{\s*name:\s*"predecessor-waits",\s*waitingRole:\s*"predecessor"\s*\}/,
      "the overlap arm must cover the predecessor-waits order",
    );
    // A fresh runId + fresh group root + fresh sync dir per arm.
    assert.match(
      source,
      /const runId = randomUUID\(\);\s*\n\s*const groupRoot = invocationGroupRootForRun\(runId, tamanduaDir\);/,
      "each overlap arm must use its own runId-derived invocation grouping dir",
    );
    assert.match(
      source,
      /const syncDir = path\.join\(wd, "\.overlap-sync", runId\);/,
      "each overlap arm must use its own host sync dir",
    );

    // (b) the fixture markers the arm depends on (US-004 wait-then-chat + the
    // plain-chat peer prompt).
    assert.match(
      source,
      /promptText: `SYNTHETIC-DSH-WAIT-THEN-CHAT:\$\{readyPath\}:\$\{releasePath\}:\$\{OVERLAP_WAIT_MS\}`/,
      "the waiting invocation must drive the US-004 wait-then-chat marker with ready/release/bounded-timeout",
    );
    assert.ok(
      source.includes('promptText: "SYNTHETIC-DSH-OVERLAP-PEER-CHAT"'),
      "the peer invocation must run the plain-chat peer prompt",
    );

    // (c) the waiting root survives the peer's confirmed close and is the ONLY
    // remaining invocation root (criteria 2 and 3).
    assert.ok(
      source.includes("the live invocation root must survive the peer's cleanup"),
      "the arm must assert the waiting invocation root survives the peer cleanup",
    );
    assert.match(
      source,
      /remaining\.length,\s*\n\s*1,/,
      "the arm must assert exactly one invocation root remains after the peer cleanup",
    );
    assert.match(
      source,
      /assert\.equal\(remaining\[0\], waitingRoot\);/,
      "the surviving root must be the waiting invocation's own root",
    );
    // The waiting invocation is released only AFTER that check, and performs
    // its real new writes afterwards.
    const releaseIdx = source.indexOf('fs.writeFileSync(releasePath, "release\\n", "utf-8");');
    const surviveIdx = source.indexOf("the live invocation root must survive the peer's cleanup");
    assert.ok(releaseIdx > 0, "the arm must release the waiting invocation via the host release file");
    assert.ok(
      surviveIdx > 0 && releaseIdx > surviveIdx,
      "the release must happen ONLY after the waiting root is proven to have survived the peer cleanup",
    );

    // (d) distinct session ids and a surviving artifact for EACH invocation.
    assert.match(
      source,
      /const peerSession = chatSessionId\(peerRecord\);[\s\S]*const waitingSession = chatSessionId\(waitingRecord\);/,
      "the arm must read both invocations' chat session ids",
    );
    assert.match(
      source,
      /assert\.notEqual\(peerSession, waitingSession,/,
      "the arm must assert the two invocations report DISTINCT session ids",
    );
    assert.match(
      source,
      /sessionArtifactsForId\(synthHome, peerSession as string\)\.length > 0/,
      "the arm must assert the peer's session artifact survives on the host",
    );
    assert.match(
      source,
      /sessionArtifactsForId\(synthHome, waitingSession as string\)\.length > 0/,
      "the arm must assert the waiting invocation's session artifact survives on the host",
    );

    // (e) host farm + host profiles/ byte-identity before AND after, and every
    // invocation root removed once both VMs closed (criterion 4).
    assert.ok(
      source.includes("const baselineFarm = snapshotDshInstallDerivedFarms(synthHome, layout.installDerivedDirs);"),
      "the arm must snapshot the host install-derived farm before the overlap",
    );
    assert.ok(
      source.includes("const baselineProfiles = snapshotDshProfilesInvariance(synthHome);"),
      "the arm must snapshot the host profiles/ tree before the overlap",
    );
    assert.ok(
      source.includes('assert.equal(invocationRoots(groupRoot).length, 0, `${arm.name}: all invocation roots removed`);'),
      "the arm must assert every invocation root is removed once both VMs closed",
    );
    assert.match(
      source,
      /the HOST farm must stay byte-identical after both teardowns/,
      "the arm must assert host farm byte-identity after both teardowns",
    );
    assert.match(
      source,
      /the HOST profiles\/ tree must stay byte-identical after both teardowns/,
      "the arm must assert host profiles/ byte-identity after both teardowns",
    );

    // (f) overlap evidence goes through the gate's existing writeEvidence path.
    assert.match(
      source,
      /writeEvidence\(\s*\n?\s*"profile-overlay-overlap\.json",/,
      "the arm must write its overlap evidence via writeEvidence",
    );
    assert.match(
      source,
      /overlapEvidence\.push\(\{[\s\S]*?arm: arm\.name,[\s\S]*?waitingRootSurvivedPeerCleanup: true,[\s\S]*?bothArtifactsSurvived: true,/,
      "per-arm evidence must record the arm name, survival booleans and the VM/session ids",
    );

    // (g) event-loop safety: the host-side wait path yields; the guest fixture
    // is the only place a synchronous bound is allowed (separate process).
    assert.equal(
      source.includes("Atomics.wait"),
      false,
      "the overlap arm's host-side wait path must never use a synchronous Atomics.wait",
    );
    assert.match(source, /await waitForPath\(readyPath,/, "the mandatory ready marker wait must be awaited");
    assert.match(
      source,
      /const waitingRoot = await waitForInvocationRoot\(groupRoot, OVERLAP_WAIT_MS\);/,
      "the invocation-root wait must be awaited",
    );

    // (h) honesty: the arm states it is real-runner-when-run and was NOT run in
    // the delivering run (a nested VM cannot boot in-guest).
    assert.ok(
      source.includes("REAL-RUNNER-WHEN-RUN") && source.includes("NOT RUN IN THIS DELIVERING RUN"),
      "the overlap arm must disclose that it is real-runner-when-run and was not executed in the delivering run",
    );

    // (i) the arm is the FINAL test in the gate file (no later test is added
    // without revisiting its coverage).
    const armIdx = source.indexOf(armTitle);
    assert.ok(armIdx > 0, "the overlap arm title must be present");
    assert.equal(
      /\n    it\(/.test(source.slice(armIdx)),
      false,
      "the overlap arm must stay the FINAL test in the gate file",
    );
  });
});
