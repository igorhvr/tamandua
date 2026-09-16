/**
 * US-002 recording-binding regression for the invocation-ownership cleanup
 * decision (tests/helpers/invocation-owned-cleanup.ts).
 *
 * The old after hooks in tests/mcp-lifecycle.test.ts and
 * tests/get-ready-dashboard-port.test.ts selected leaked daemon/MCP
 * survivors by a shared HOME/log-path PREFIX, which also selected the
 * survivors of an unrelated concurrent invocation B that merely shared the
 * prefix with invocation A (synthetic-after-hook proof, US-002).
 *
 * This gate evaluates the ACTUAL decision callbacks
 * (cleanupInvocationOwnedSurvivors) with recording bindings only — zero real
 * process selectors, zero real signals — for BOTH platform observation
 * paths (linux /proc-environ HOME semantics and darwin lsof open-file-path
 * semantics, fed through the real parsers as recording fakes). It proves:
 *
 *  - invocation A's own survivor is selected and signalled;
 *  - unrelated B (same prefix, different root), prefix-neighbor and
 *    similar-prefix strings are refused (exact path boundaries only);
 *  - stale/PID-reuse identity and unavailable identity are refused;
 *  - a persisted legacy (`ps:`/`proc:`) or non-comparable (`v2u:`) recorded
 *    identity is refused as `identity-unknown-format`, never string-compared;
 *  - unreadable evidence is refused (never an empty proof);
 *  - evidence and identity are re-verified immediately before each signal,
 *    and evidence/identity mutated between decision and signal (including
 *    process exit) suppresses the signal.
 *
 * The file is pure (parallel lane): it imports no node:child_process, no
 * src/dist module, spawns nothing and signals nothing — every operation goes
 * through the recording bindings below.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupInvocationOwnedSurvivors,
  evidencePathOwned,
  parseDarwinLsofPaths,
  parseLinuxEnvironHome,
  type OwnershipObservation,
  type SurvivorDisposition,
} from "./invocation-owned-cleanup.ts";

// Synthetic roots/evidence (deliberately NOT under the OS temp root so the
// pure file never touches real directories; only string matching matters).
const ROOT_A = "/synthetic/tamandua-mcp-lifecycle-A1B2C3";
const ROOT_B = "/synthetic/tamandua-mcp-lifecycle-D4E5F6";
const HOME_A = `${ROOT_A}/home`;
const HOME_B = `${ROOT_B}/home`;

// ── Recording bindings ───────────────────────────────────────────────

type JournalEvent =
  | { op: "observe"; pid: number; result: OwnershipObservation }
  | { op: "identity"; pid: number; result: string | null }
  | { op: "signal"; pid: number };

/**
 * Recording observer with a per-pid queue plan: a queue with one entry is a
 * stable observation (returned on every call); a longer queue is consumed
 * one entry per call (used to mutate evidence between decision and signal).
 * Pids with no plan entry observe as unreadable.
 */
function recordingObserver(
  plan: Map<number, OwnershipObservation[]>,
  journal: JournalEvent[],
): (pid: number) => OwnershipObservation {
  return (pid: number) => {
    const queue = plan.get(pid);
    let result: OwnershipObservation;
    if (queue === undefined || queue.length === 0) {
      result = { kind: "unreadable" };
    } else if (queue.length > 1) {
      result = queue.shift()!;
    } else {
      result = queue[0];
    }
    journal.push({ op: "observe", pid, result });
    return result;
  };
}

/** Same queue semantics for identities (single string or string|null). */
function recordingIdentity(
  plan: Map<number, Array<string | null>>,
  journal: JournalEvent[],
): (pid: number) => string | null {
  return (pid: number) => {
    const queue = plan.get(pid);
    let result: string | null;
    if (queue === undefined || queue.length === 0) {
      result = null;
    } else if (queue.length > 1) {
      result = queue.shift()!;
    } else {
      result = queue[0];
    }
    journal.push({ op: "identity", pid, result });
    return result;
  };
}

/**
 * Recording signal binding that ITSELF asserts the recheck-before-signal
 * contract: before every signal the helper must have re-observed the current
 * evidence and re-verified the identity, with the recheck immediately
 * preceding the signal.
 */
function recordingSignal(
  journal: JournalEvent[],
  signalled: number[],
): (pid: number) => void {
  return (pid: number) => {
    const prior = journal.filter((e) => e.pid === pid);
    const observeCount = prior.filter((e) => e.op === "observe").length;
    const identityCount = prior.filter((e) => e.op === "identity").length;
    assert.ok(
      observeCount >= 2,
      `pid ${pid}: evidence must be re-observed before each signal`,
    );
    assert.ok(
      identityCount >= 2,
      `pid ${pid}: identity must be re-verified before each signal`,
    );
    assert.equal(
      prior[prior.length - 1]?.op,
      "identity",
      `pid ${pid}: the recheck must immediately precede the signal`,
    );
    journal.push({ op: "signal", pid });
    signalled.push(pid);
  };
}

/** Recording observer that feeds canned linux environ text through the real parser. */
function linuxEnvironObserver(
  environs: Map<number, string>,
  journal: JournalEvent[],
): (pid: number) => OwnershipObservation {
  return (pid: number) => {
    const raw = environs.get(pid);
    let result: OwnershipObservation;
    if (raw === undefined) {
      result = { kind: "unreadable" };
    } else {
      const home = parseLinuxEnvironHome(raw);
      result = { kind: "ok", paths: home === null ? [] : [home] };
    }
    journal.push({ op: "observe", pid, result });
    return result;
  };
}

/** Recording observer that feeds canned `lsof -p <pid> -Fn` text through the real parser. */
function darwinLsofObserver(
  lsofTexts: Map<number, string>,
  journal: JournalEvent[],
): (pid: number) => OwnershipObservation {
  return (pid: number) => {
    const raw = lsofTexts.get(pid);
    let result: OwnershipObservation;
    if (raw === undefined) {
      result = { kind: "unreadable" };
    } else {
      result = { kind: "ok", paths: parseDarwinLsofPaths(raw) };
    }
    journal.push({ op: "observe", pid, result });
    return result;
  };
}

function dispositionFor(
  dispositions: SurvivorDisposition[],
  pid: number,
): SurvivorDisposition | undefined {
  return dispositions.find((d) => d.pid === pid);
}

function eventsFor(journal: JournalEvent[], pid: number): JournalEvent[] {
  return journal.filter((e) => e.pid === pid);
}

/** Default per-pid identity plan helper: one stable identity per pid. */
function stableIdentities(
  entries: Array<[number, string | null]>,
): Map<number, Array<string | null>> {
  return new Map(entries.map(([pid, id]) => [pid, [id]]));
}

// ── Pure parser unit tests ───────────────────────────────────────────

describe("parseLinuxEnvironHome", () => {
  it("extracts HOME from NUL-separated environ text", () => {
    const raw = `PATH=/usr/bin\0HOME=${HOME_A}\0LANG=C.UTF-8\0`;
    assert.equal(parseLinuxEnvironHome(raw), HOME_A);
  });

  it("returns null when no HOME entry exists", () => {
    assert.equal(parseLinuxEnvironHome(`PATH=/usr/bin\0LANG=C\0`), null);
    assert.equal(parseLinuxEnvironHome(""), null);
  });
});

describe("parseDarwinLsofPaths", () => {
  it("collects only the n-prefixed file name lines", () => {
    const raw = [
      "p200001",
      "f1",
      `n${HOME_A}/.tamandua/mcp.log`,
      "n/usr/lib/dyld",
      "cnode",
      `n${ROOT_A}/home/.tamandua/port`,
      "",
    ].join("\n");
    assert.deepEqual(parseDarwinLsofPaths(raw), [
      `${HOME_A}/.tamandua/mcp.log`,
      "/usr/lib/dyld",
      `${ROOT_A}/home/.tamandua/port`,
    ]);
  });

  it("strips the lsof ' (deleted)' marker and ignores empty names", () => {
    const raw = [`p200001`, `n${HOME_A}/.tamandua/mcp.log (deleted)`, "n", "n   "].join("\n");
    assert.deepEqual(parseDarwinLsofPaths(raw), [`${HOME_A}/.tamandua/mcp.log`]);
  });

  it("returns [] for text with no name lines", () => {
    assert.deepEqual(parseDarwinLsofPaths("p200001\nf1\ncnode\n"), []);
  });
});

// ── Exact path boundaries (pure) ─────────────────────────────────────

describe("evidencePathOwned — exact path boundaries", () => {
  it("accepts the owned root itself and descendants below a path.sep", () => {
    assert.equal(evidencePathOwned(ROOT_A, [ROOT_A]), true);
    assert.equal(evidencePathOwned(HOME_A, [ROOT_A]), true);
    assert.equal(evidencePathOwned(`${HOME_A}/.tamandua/mcp.log`, [ROOT_A]), true);
    // Trailing separators normalize to the same root.
    assert.equal(evidencePathOwned(`${ROOT_A}/`, [ROOT_A]), true);
  });

  it("refuses a different root that merely shares the prefix", () => {
    // ROOT_B shares the "tamandua-mcp-lifecycle-" prefix with ROOT_A but is a
    // separate root — the bug the old prefix check had.
    assert.equal(evidencePathOwned(HOME_B, [ROOT_A]), false);
    assert.equal(evidencePathOwned(ROOT_B, [ROOT_A]), false);
  });

  it("refuses prefix-neighbor and similar-prefix strings (no loose match)", () => {
    // Longer random part, same char prefix: ...-A1B2C3-neighbor vs ...-A1B2C3
    assert.equal(evidencePathOwned(`${ROOT_A}-neighbor/home`, [ROOT_A]), false);
    // The owned root as a bare substring of a sibling root must not match.
    assert.equal(evidencePathOwned(`${ROOT_A}2/home`, [ROOT_A]), false);
    assert.equal(evidencePathOwned(`/synthetic/tamandua-mcp-lifecycle-A1B2C3X/home`, [ROOT_A]), false);
    // Evidence equal to another owned root in the set is still accepted.
    assert.equal(evidencePathOwned(HOME_B, [ROOT_A, ROOT_B]), true);
  });

  it("refuses unrelated paths and empty evidence", () => {
    assert.equal(evidencePathOwned("/synthetic/unrelated/home", [ROOT_A]), false);
    assert.equal(evidencePathOwned("", [ROOT_A]), false);
    assert.equal(evidencePathOwned(HOME_A, []), false);
  });
});

// ── Linux /proc-environ semantics (recording) ────────────────────────

describe("cleanupInvocationOwnedSurvivors — linux /proc-environ semantics", () => {
  it("selects own survivor A and refuses unrelated B that shares the prefix", () => {
    const journal: JournalEvent[] = [];
    const signalled: number[] = [];
    const pidA = 200001;
    const pidB = 200002;

    const environs = new Map<number, string>([
      [pidA, `PATH=/usr/bin\0HOME=${HOME_A}\0LANG=C.UTF-8\0`],
      [pidB, `PATH=/usr/bin\0HOME=${HOME_B}\0LANG=C.UTF-8\0`],
    ]);
    const identities = stableIdentities([
      [pidA, "v2:200001:1000000"],
      [pidB, "v2:200002:2000000"],
    ]);

    const dispositions = cleanupInvocationOwnedSurvivors([pidA, pidB], {
      ownedRoots: [ROOT_A],
      observe: linuxEnvironObserver(environs, journal),
      identityOf: recordingIdentity(identities, journal),
      signal: recordingSignal(journal, signalled),
    });

    // A (HOME exactly under owned ROOT_A) is cleaned...
    assert.deepEqual(signalled, [pidA], "only invocation A's survivor is signalled");
    assert.deepEqual(dispositionFor(dispositions, pidA), {
      pid: pidA,
      outcome: "signalled",
    });
    // ...B (same prefix, different root) is refused with no signal.
    assert.deepEqual(dispositionFor(dispositions, pidB), {
      pid: pidB,
      outcome: "skipped",
      reason: "not-owned",
    });
  });

  it("refuses a process whose HOME env is absent (empty readable evidence)", () => {
    const journal: JournalEvent[] = [];
    const signalled: number[] = [];
    const pid = 200003;
    const environs = new Map<number, string>([[pid, "PATH=/usr/bin\0LANG=C\0"]]);
    const identities = stableIdentities([[pid, "v2:200003:3000000"]]);

    const dispositions = cleanupInvocationOwnedSurvivors([pid], {
      ownedRoots: [ROOT_A],
      observe: linuxEnvironObserver(environs, journal),
      identityOf: recordingIdentity(identities, journal),
      signal: recordingSignal(journal, signalled),
    });

    assert.deepEqual(signalled, []);
    assert.deepEqual(dispositionFor(dispositions, pid), {
      pid,
      outcome: "skipped",
      reason: "not-owned",
    });
  });
});

// ── Darwin lsof semantics (recording) ────────────────────────────────

describe("cleanupInvocationOwnedSurvivors — darwin lsof semantics", () => {
  it("selects own survivor A via its open log fd and refuses B", () => {
    const journal: JournalEvent[] = [];
    const signalled: number[] = [];
    const pidA = 300001;
    const pidB = 300002;

    // A keeps its log fd open under ROOT_A; B under ROOT_B. Both also have
    // unrelated system files open — only the owned path may decide.
    const lsofA = ["p300001", "f1", "n/usr/lib/dyld", `n${ROOT_A}/home/.tamandua/mcp.log`].join("\n");
    const lsofB = ["p300002", "f1", "n/usr/lib/dyld", `n${ROOT_B}/home/.tamandua/mcp.log`].join("\n");
    const identities = stableIdentities([
      [pidA, "v2:300001:1000000"],
      [pidB, "v2:300002:2000000"],
    ]);

    const dispositions = cleanupInvocationOwnedSurvivors([pidA, pidB], {
      ownedRoots: [ROOT_A],
      observe: darwinLsofObserver(new Map([[pidA, lsofA], [pidB, lsofB]]), journal),
      identityOf: recordingIdentity(identities, journal),
      signal: recordingSignal(journal, signalled),
    });

    assert.deepEqual(signalled, [pidA]);
    assert.deepEqual(dispositionFor(dispositions, pidA), {
      pid: pidA,
      outcome: "signalled",
    });
    assert.deepEqual(dispositionFor(dispositions, pidB), {
      pid: pidB,
      outcome: "skipped",
      reason: "not-owned",
    });
  });

  it("refuses a darwin process whose open files do not include any owned path", () => {
    const journal: JournalEvent[] = [];
    const signalled: number[] = [];
    const pid = 300003;
    const lsof = ["p300003", "f1", "n/usr/lib/dyld", "n/var/log/system.log"].join("\n");
    const identities = stableIdentities([[pid, "v2:300003:3000000"]]);

    const dispositions = cleanupInvocationOwnedSurvivors([pid], {
      ownedRoots: [ROOT_A],
      observe: darwinLsofObserver(new Map([[pid, lsof]]), journal),
      identityOf: recordingIdentity(identities, journal),
      signal: recordingSignal(journal, signalled),
    });

    assert.deepEqual(signalled, []);
    assert.deepEqual(dispositionFor(dispositions, pid), {
      pid,
      outcome: "skipped",
      reason: "not-owned",
    });
  });
});

// ── Refusal matrix (recording) ───────────────────────────────────────

describe("cleanupInvocationOwnedSurvivors — refusals", () => {
  function sweepSingle(
    observeResult: OwnershipObservation,
    identityResult: string | null,
    recorded?: string,
  ): { dispositions: SurvivorDisposition[]; signalled: number[]; journal: JournalEvent[] } {
    const journal: JournalEvent[] = [];
    const signalled: number[] = [];
    const pid = 400001;
    const observe = recordingObserver(new Map([[pid, [observeResult]]]), journal);
    const identity = recordingIdentity(stableIdentities([[pid, identityResult]]), journal);
    const dispositions = cleanupInvocationOwnedSurvivors([pid], {
      ownedRoots: [ROOT_A],
      observe,
      identityOf: identity,
      recordedIdentityOf: recorded === undefined ? undefined : () => recorded,
      signal: recordingSignal(journal, signalled),
    });
    return { dispositions, signalled, journal };
  }

  it("refuses unreadable evidence (never an empty proof)", () => {
    const { dispositions, signalled } = sweepSingle({ kind: "unreadable" }, "v2:400001:1000000");
    assert.deepEqual(signalled, []);
    assert.deepEqual(dispositionFor(dispositions, 400001), {
      pid: 400001,
      outcome: "skipped",
      reason: "unreadable-evidence",
    });
  });

  it("refuses a process that is already gone", () => {
    const { dispositions, signalled } = sweepSingle({ kind: "gone" }, "v2:400001:1000000");
    assert.deepEqual(signalled, []);
    assert.deepEqual(dispositionFor(dispositions, 400001), {
      pid: 400001,
      outcome: "skipped",
      reason: "gone",
    });
  });

  it("refuses stale / PID-reuse identity (recorded identity no longer matches)", () => {
    // Recorded at spawn/PID-file-read time: v2:400001:1000000. Current
    // identity: v2:400001:9000000 — the same pid was recycled into a new
    // incarnation beyond the documented tolerance, so no signal.
    const { dispositions, signalled } = sweepSingle(
      { kind: "ok", paths: [HOME_A] },
      "v2:400001:9000000",
      "v2:400001:1000000",
    );
    assert.deepEqual(signalled, []);
    assert.deepEqual(dispositionFor(dispositions, 400001), {
      pid: 400001,
      outcome: "skipped",
      reason: "identity-mismatch",
    });
  });

  it("refuses when a recorded identity exists but the current identity is unavailable", () => {
    const { dispositions, signalled } = sweepSingle(
      { kind: "ok", paths: [HOME_A] },
      null,
      "v2:400001:1000000",
    );
    assert.deepEqual(signalled, []);
    assert.deepEqual(dispositionFor(dispositions, 400001), {
      pid: 400001,
      outcome: "skipped",
      reason: "identity-unavailable",
    });
  });

  it("accepts an owned survivor when the recorded identity matches", () => {
    const { dispositions, signalled } = sweepSingle(
      { kind: "ok", paths: [HOME_A] },
      "v2:400001:1000000",
      "v2:400001:1000000",
    );
    assert.deepEqual(signalled, [400001]);
    assert.deepEqual(dispositionFor(dispositions, 400001), {
      pid: 400001,
      outcome: "signalled",
    });
  });

  it("refuses a persisted legacy ps: recorded identity (unknown format, never signalled)", () => {
    // Upgrade path: an older build recorded a TZ-dependent ps lstart string.
    // The current process is a valid v2 incarnation, but the recorded value is
    // not comparable — it must be classified 'unknown', NOT 'different' and
    // NOT string-compared, so nothing is signalled.
    const { dispositions, signalled } = sweepSingle(
      { kind: "ok", paths: [HOME_A] },
      "v2:400001:1000000",
      "ps:Sun Sep  6 00:26:59 2026",
    );
    assert.deepEqual(signalled, [], "legacy ps: recorded identity must never be signalled");
    assert.deepEqual(dispositionFor(dispositions, 400001), {
      pid: 400001,
      outcome: "skipped",
      reason: "identity-unknown-format",
    });
  });

  it("refuses a persisted legacy proc: recorded identity (unknown format, never signalled)", () => {
    const { dispositions, signalled } = sweepSingle(
      { kind: "ok", paths: [HOME_A] },
      "v2:400001:1000000",
      "proc:442043503",
    );
    assert.deepEqual(signalled, [], "legacy proc: recorded identity must never be signalled");
    assert.deepEqual(dispositionFor(dispositions, 400001), {
      pid: 400001,
      outcome: "skipped",
      reason: "identity-unknown-format",
    });
  });

  it("refuses a legacy-format CURRENT identity even when the record is v2", () => {
    // The reverse direction: a v2 record compared against a legacy/unreadable
    // current value can never prove ownership.
    const { dispositions, signalled } = sweepSingle(
      { kind: "ok", paths: [HOME_A] },
      "ps:Sat Sep  5 21:26:59 2026",
      "v2:400001:1000000",
    );
    assert.deepEqual(signalled, []);
    assert.deepEqual(dispositionFor(dispositions, 400001), {
      pid: 400001,
      outcome: "skipped",
      reason: "identity-unknown-format",
    });
  });

  it("refuses a non-comparable v2u: recorded identity (unknown format)", () => {
    const { dispositions, signalled } = sweepSingle(
      { kind: "ok", paths: [HOME_A] },
      "v2:400001:1000000",
      "v2u:400001",
    );
    assert.deepEqual(signalled, []);
    assert.deepEqual(dispositionFor(dispositions, 400001), {
      pid: 400001,
      outcome: "skipped",
      reason: "identity-unknown-format",
    });
  });

  it("ignores invalid pids (never signalled, never journaled)", () => {
    const journal: JournalEvent[] = [];
    const signalled: number[] = [];
    const pid = 400002;
    const observe = recordingObserver(new Map([[pid, [{ kind: "ok", paths: [HOME_A] }]]]), journal);
    const identity = recordingIdentity(stableIdentities([[pid, "v2:400002:1000000"]]), journal);

    const dispositions = cleanupInvocationOwnedSurvivors([0, -5, 1.5, NaN, pid], {
      ownedRoots: [ROOT_A],
      observe,
      identityOf: identity,
      signal: recordingSignal(journal, signalled),
    });

    assert.deepEqual(signalled, [pid]);
    assert.deepEqual(dispositions, [{ pid, outcome: "signalled" }]);
    assert.ok(journal.every((e) => e.pid === pid), "invalid pids must not be observed");
  });

  it("refuses prefix-neighbor and similar-prefix evidence at the decision (exact boundaries)", () => {
    // The same decision callback must accept only evidence EXACTLY at/under
    // ROOT_A: a neighbor root that shares the ROOT_A string as a prefix but
    // is not separated by path.sep is refused.
    const cases: Array<{ paths: string[]; expected: "signalled" | "not-owned" }> = [
      { paths: [HOME_A], expected: "signalled" },
      { paths: [`${ROOT_A}/home/.tamandua/mcp.log`], expected: "signalled" },
      // Prefix-neighbor: same chars plus a suffix, no path.sep boundary.
      { paths: [`${ROOT_A}-neighbor/home`], expected: "not-owned" },
      { paths: [`${ROOT_A}2/home`], expected: "not-owned" },
      // Bare substring of the owned root inside a sibling root name.
      { paths: ["/synthetic/tamandua-mcp-lifecycle-A1B2C3X/home"], expected: "not-owned" },
    ];

    for (const { paths, expected } of cases) {
      const journal: JournalEvent[] = [];
      const signalled: number[] = [];
      const pid = 400003;
      const dispositions = cleanupInvocationOwnedSurvivors([pid], {
        ownedRoots: [ROOT_A],
        observe: recordingObserver(new Map([[pid, [{ kind: "ok", paths }]]]), journal),
        identityOf: recordingIdentity(stableIdentities([[pid, "v2:400003:1000000"]]), journal),
        signal: recordingSignal(journal, signalled),
      });

      if (expected === "signalled") {
        assert.deepEqual(
          signalled,
          [pid],
          `evidence ${JSON.stringify(paths)} must be signalled`,
        );
        assert.deepEqual(dispositionFor(dispositions, pid), { pid, outcome: "signalled" });
      } else {
        assert.deepEqual(signalled, [], `evidence ${JSON.stringify(paths)} must NOT be signalled`);
        assert.deepEqual(dispositionFor(dispositions, pid), {
          pid,
          outcome: "skipped",
          reason: "not-owned",
        });
      }
    }
  });
});

// ── Recheck immediately before each signal (recording) ───────────────

describe("cleanupInvocationOwnedSurvivors — recheck before each signal", () => {
  it("re-verifies evidence and identity immediately before the signal", () => {
    const journal: JournalEvent[] = [];
    const signalled: number[] = [];
    const pid = 500001;

    const dispositions = cleanupInvocationOwnedSurvivors([pid], {
      ownedRoots: [ROOT_A],
      observe: recordingObserver(new Map([[pid, [{ kind: "ok", paths: [HOME_A] }]]]), journal),
      identityOf: recordingIdentity(stableIdentities([[pid, "v2:500001:1000000"]]), journal),
      signal: recordingSignal(journal, signalled),
    });

    assert.deepEqual(signalled, [pid]);
    assert.deepEqual(dispositionFor(dispositions, pid), { pid, outcome: "signalled" });
    // Exact journal: decision observe+identity, recheck observe+identity,
    // then the signal — the recording signal binding already asserted the
    // recheck preceded it; pin the full sequence here.
    assert.deepEqual(
      eventsFor(journal, pid).map((e) => e.op),
      ["observe", "identity", "observe", "identity", "signal"],
    );
  });

  it("suppresses the signal when evidence mutated between decision and signal", () => {
    const journal: JournalEvent[] = [];
    const signalled: number[] = [];
    const pid = 500002;

    // First observe proves ownership; the recheck observe points outside the
    // owned root (evidence changed) — no signal.
    const dispositions = cleanupInvocationOwnedSurvivors([pid], {
      ownedRoots: [ROOT_A],
      observe: recordingObserver(
        new Map([[pid, [{ kind: "ok", paths: [HOME_A] }, { kind: "ok", paths: [HOME_B] }]]]),
        journal,
      ),
      identityOf: recordingIdentity(stableIdentities([[pid, "v2:500002:1000000"]]), journal),
      signal: recordingSignal(journal, signalled),
    });

    assert.deepEqual(signalled, []);
    assert.deepEqual(dispositionFor(dispositions, pid), {
      pid,
      outcome: "skipped",
      reason: "evidence-changed-before-signal",
    });
    assert.deepEqual(
      eventsFor(journal, pid).map((e) => e.op),
      ["observe", "identity", "observe"],
    );
  });

  it("suppresses the signal when the recheck evidence is unreadable", () => {
    const journal: JournalEvent[] = [];
    const signalled: number[] = [];
    const pid = 500003;

    const dispositions = cleanupInvocationOwnedSurvivors([pid], {
      ownedRoots: [ROOT_A],
      observe: recordingObserver(
        new Map([[pid, [{ kind: "ok", paths: [HOME_A] }, { kind: "unreadable" }]]]),
        journal,
      ),
      identityOf: recordingIdentity(stableIdentities([[pid, "v2:500003:1000000"]]), journal),
      signal: recordingSignal(journal, signalled),
    });

    assert.deepEqual(signalled, []);
    assert.deepEqual(dispositionFor(dispositions, pid), {
      pid,
      outcome: "skipped",
      reason: "evidence-changed-before-signal",
    });
  });

  it("suppresses the signal when the process exited between decision and signal", () => {
    const journal: JournalEvent[] = [];
    const signalled: number[] = [];
    const pid = 500004;

    const dispositions = cleanupInvocationOwnedSurvivors([pid], {
      ownedRoots: [ROOT_A],
      observe: recordingObserver(
        new Map([[pid, [{ kind: "ok", paths: [HOME_A] }, { kind: "gone" }]]]),
        journal,
      ),
      identityOf: recordingIdentity(stableIdentities([[pid, "v2:500004:1000000"]]), journal),
      signal: recordingSignal(journal, signalled),
    });

    assert.deepEqual(signalled, []);
    assert.deepEqual(dispositionFor(dispositions, pid), {
      pid,
      outcome: "skipped",
      reason: "exited-before-signal",
    });
  });

  it("suppresses the signal when the identity changed between decision and signal", () => {
    const journal: JournalEvent[] = [];
    const signalled: number[] = [];
    const pid = 500005;

    const dispositions = cleanupInvocationOwnedSurvivors([pid], {
      ownedRoots: [ROOT_A],
      observe: recordingObserver(new Map([[pid, [{ kind: "ok", paths: [HOME_A] }]]]), journal),
      identityOf: recordingIdentity(
        new Map([[pid, ["v2:500005:1000000", "v2:500005:9000000"]]]),
        journal,
      ),
      signal: recordingSignal(journal, signalled),
    });

    assert.deepEqual(signalled, []);
    assert.deepEqual(dispositionFor(dispositions, pid), {
      pid,
      outcome: "skipped",
      reason: "identity-changed-before-signal",
    });
  });

  it("rechecks before EACH signal when several owned survivors are swept", () => {
    const journal: JournalEvent[] = [];
    const signalled: number[] = [];
    const pidA = 500101;
    const pidB = 500102;
    const rootC = "/synthetic/tamandua-mcp-lifecycle-C9F8E7";

    // Two owned survivors under two different owned roots; both must be
    // signalled and each signal must be preceded by its own recheck (the
    // recording signal binding asserts that per signal).
    const dispositions = cleanupInvocationOwnedSurvivors([pidA, pidB], {
      ownedRoots: [ROOT_A, rootC],
      observe: recordingObserver(
        new Map([
          [pidA, [{ kind: "ok", paths: [`${ROOT_A}/home`] }]],
          [pidB, [{ kind: "ok", paths: [`${rootC}/home`] }]],
        ]),
        journal,
      ),
      identityOf: recordingIdentity(
        stableIdentities([[pidA, "v2:500101:1000000"], [pidB, "v2:500102:2000000"]]),
        journal,
      ),
      signal: recordingSignal(journal, signalled),
    });

    assert.deepEqual(signalled, [pidA, pidB]);
    assert.deepEqual(dispositionFor(dispositions, pidA), { pid: pidA, outcome: "signalled" });
    assert.deepEqual(dispositionFor(dispositions, pidB), { pid: pidB, outcome: "signalled" });
    for (const pid of [pidA, pidB]) {
      assert.deepEqual(
        eventsFor(journal, pid).map((e) => e.op),
        ["observe", "identity", "observe", "identity", "signal"],
      );
    }
  });
});
