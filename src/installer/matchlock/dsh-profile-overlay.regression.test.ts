/**
 * dsh-profile-overlay.regression.test.ts — OVERLAY-CONTINUATION US-007.
 *
 * PRE-FIX REGRESSION CONTROL for the OVERLAY-INV-SCOPED defect
 * (bead tamandua-7j6 / MTLK-OVERLAY-RACE, run #113).
 *
 * WHY THIS FILE EXISTS
 * A test that passes both before AND after a fix proves nothing. This file
 * therefore models the PRE-FIX implementation in-process and runs the SAME
 * invariant assertions against both implementations:
 *
 *   - the PRE-FIX arm must VIOLATE the invariant (the defect reproduces), and
 *   - the SHIPPED arm must SATISFY it.
 *
 * Each arm asserts exactly one of those two outcomes (`expectViolation(...)`
 * for the pre-fix shape, a returned observation plus explicit assertions for
 * the shipped shape), so the control cannot silently pass vacuously: if a
 * helper ever stopped asserting, `expectViolation` would fail with its
 * `assert.fail` message; if the shipped implementation regressed to the
 * pre-fix shape, the shipped arm would throw the same model violation.
 *
 * THE TWO PRE-FIX BEHAVIOURS MODELLED
 *   A. LIFETIME — ONE run-scoped root
 *      `<liveStateRoot>/matchlock/dsh-profile-overlays/<bareRunId>` is adopted
 *      by every invocation of a run (`mkdirSync(..., {recursive:true})`, never
 *      exclusive), and teardown is an unconditional `fs.rmSync(root,
 *      {recursive:true})` that attests nothing about which invocation owns it.
 *      A successor invocation staging into the shared root is destroyed by the
 *      predecessor's cleanup.
 *   B. PUBLICATION — unconditional overwrite
 *      Publish walks the effective home and calls `fs.copyFileSync(src, dst)`
 *      on every file with no inode / byte-identity / prepare-time-provenance
 *      check, so an independently changed host destination is silently
 *      replaced by the invocation's losing copy.
 *
 * THIS IS NOT VM EXECUTION. No Matchlock VM, guest, harness, provider or
 * network is involved: both arms are pure host-side fs modelling, and the
 * shipped arm calls the real exported functions. The real Matchlock overlap
 * gate (`e2e-tests/matchlock-dsh-profile-overlay-gate.test.ts`) was NOT run in
 * this delivering run — a nested VM cannot boot inside a worker round — so
 * nothing here proves anything about a guest.
 *
 * Lane: PARALLEL. This file imports only `node:` core modules, the temp-dir
 * fixture helper and `dist/installer/matchlock/dsh-profile-overlay.js` (itself
 * Node-core only, no `node:child_process`), so it spawns no OS process.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import {
  DSH_PROFILES_DIR_NAME,
  DshProfileOverlayError,
  MATCHLOCK_DIR_NAME,
  MATCHLOCK_DSH_INVOCATION_PARENT_DIR_NAME,
  MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME,
  assertDshOverlayRunId,
  cleanupDshProfileOverlay,
  dshProfileInvocationGroupRoot,
  dshProfileOverlayRoot,
  prepareDshProfileOverlay,
  publishDshHomeOverlayToHost,
} from "../../../dist/installer/matchlock/dsh-profile-overlay.js";

const RUN_ID = "11111111-2222-3333-4444-555555555555";
const INV_A = "inv-aaaaaaaa-11111111";
const INV_B = "inv-bbbbbbbb-22222222";

/** Independent host bytes written AFTER prepare at the conflicted destination. */
const HOST_BYTES = "from-host\n";
/** The invocation's staged (losing) bytes at the same destination. */
const INVOCATION_BYTES = "from-invocation\n";
/** Host home-relative destination both writers target. */
const CONFLICT_REL = path.join("sessions", "conflict", "x.jsonl");

let tmpRoot: string | undefined;

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot!, prefix));
  return dir;
}

/** Minimal operator dsh home: one durable file plus the empty sessions dir. */
function makeHostHome(): string {
  const home = mkTmp("dsh-overlay-regression-home-");
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(home, ".credentials.yaml"), "refs: [host]\n", "utf8");
  return home;
}

/**
 * Write one guest-side session artifact under an invocation's effective home
 * (the guest's `sessions/` is a real directory in both implementations).
 * Returns the artifact's absolute path.
 */
function stageSessionArtifact(root: string, invocationId: string, tag: string): string {
  const dir = path.join(root, "sessions", "regression", tag);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${invocationId}.jsonl`);
  fs.writeFileSync(file, `${invocationId}\n`, "utf8");
  return file;
}

/** Real immediate subdirectories of the run's grouping dir (no manifest files). */
function listInvocationRoots(liveStateRoot: string, runId: string): string[] {
  const groupRoot = dshProfileInvocationGroupRoot(runId, liveStateRoot);
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(groupRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents
    .filter((d) => d.isDirectory())
    .map((d) => path.join(groupRoot, d.name))
    .sort();
}

/**
 * A model invariant violation raised by the shared helpers below. Distinct
 * class (and a `code`) so an arm can assert WHICH precondition failed rather
 * than just "something threw".
 */
class DshOverlayInvariantViolation extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "DshOverlayInvariantViolation";
    this.code = code;
    this.details = details;
  }
}

/** The overlay implementation surface both arms are driven through. */
interface OverlayUnderTest {
  /** Human label used in failure messages. */
  readonly label: string;
  /** The root this implementation allocates for one invocation. */
  root(runId: string, invocationId: string, liveStateRoot: string): string;
  /** Stage one invocation's private effective home; returns its root. */
  prepare(
    runId: string,
    invocationId: string,
    liveStateRoot: string,
    hostHome: string,
  ): string;
  /** Merge the invocation's guest-written durable entries back to the host. */
  publish(
    runId: string,
    invocationId: string,
    liveStateRoot: string,
    hostHome: string,
  ): void;
  /** Tear the invocation's effective home down. */
  cleanup(runId: string, invocationId: string, liveStateRoot: string): void;
}

// ── Pre-fix model (the defect shape) ───────────────────────────────

/**
 * PRE-FIX root: ONE run-scoped directory shared by EVERY invocation of the
 * run. No invocation identity is part of the path, so two invocations can
 * never be isolated from each other.
 */
function preFixRunScopedRoot(runId: string, liveStateRoot: string): string {
  return path.join(
    path.resolve(liveStateRoot),
    MATCHLOCK_DIR_NAME,
    MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME,
    assertDshOverlayRunId(runId),
  );
}

/**
 * PRE-FIX publish: recursive walk with an UNCONDITIONAL `copyFileSync`. No
 * inode check, no byte comparison, no prepare-time provenance — the host
 * destination is whatever the invocation last wrote.
 */
function preFixPublishUnconditional(root: string, hostHome: string): void {
  const walk = (from: string, to: string): void => {
    for (const dirent of fs.readdirSync(from, { withFileTypes: true })) {
      if (dirent.name === DSH_PROFILES_DIR_NAME) continue; // never published
      const src = path.join(from, dirent.name);
      const dst = path.join(to, dirent.name);
      if (dirent.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        walk(src, dst);
      } else if (dirent.isFile()) {
        fs.copyFileSync(src, dst); // the defect: overwrite, unconditionally
      }
    }
  };
  walk(root, hostHome);
}

const PRE_FIX: OverlayUnderTest = {
  label: "pre-fix (shared run-scoped root + unconditional publish)",
  root: (runId, _invocationId, liveStateRoot) =>
    preFixRunScopedRoot(runId, liveStateRoot),
  prepare: (runId, _invocationId, liveStateRoot) => {
    // ADOPTS a preexisting run-scoped root (no exclusive allocation) and has
    // no per-invocation identity: this is the lifetime defect.
    const root = preFixRunScopedRoot(runId, liveStateRoot);
    fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
    return root;
  },
  publish: (runId, _invocationId, liveStateRoot, hostHome) => {
    preFixPublishUnconditional(preFixRunScopedRoot(runId, liveStateRoot), hostHome);
  },
  cleanup: (runId, _invocationId, liveStateRoot) => {
    // Unconditional recursive removal of the SHARED root: it attests nothing
    // about which invocation owns it, so it takes every peer artifact with it.
    fs.rmSync(preFixRunScopedRoot(runId, liveStateRoot), {
      recursive: true,
      force: true,
    });
  },
};

// ── Shipped implementation (the real exported functions) ────────────

const SHIPPED: OverlayUnderTest = {
  label: "shipped (per-invocation namespace + retained publish conflicts)",
  root: (runId, invocationId, liveStateRoot) =>
    dshProfileOverlayRoot(runId, invocationId, liveStateRoot),
  prepare: (runId, invocationId, liveStateRoot, hostHome) =>
    prepareDshProfileOverlay(runId, invocationId, liveStateRoot, hostHome).overlayRoot,
  publish: (runId, invocationId, liveStateRoot, hostHome) =>
    publishDshHomeOverlayToHost(runId, invocationId, liveStateRoot, hostHome),
  cleanup: (runId, invocationId, liveStateRoot) =>
    cleanupDshProfileOverlay(runId, invocationId, liveStateRoot),
};

// ── Shared invariant helpers ────────────────────────────────────────

interface LifetimeObservation {
  rootA: string;
  rootB: string;
  peerArtifactSurvived: boolean;
  peerRootAcceptedNewWrite: boolean;
  remainingInvocationRoots: string[];
}

/**
 * THE LIFETIME INVARIANT (shared by both arms):
 *
 *   An invocation's teardown must never destroy another live invocation's
 *   staged artifact or root, and the surviving invocation's root must still
 *   accept NEW writes afterwards.
 *
 * The checks are ordered so that the DESTRUCTION check fires first for the
 * pre-fix shape (`peer_artifact_destroyed`, the `fs.existsSync(artifactB)`
 * check immediately after A's teardown) rather than a derived symptom.
 */
function assertLifetimeInvariants(impl: OverlayUnderTest): LifetimeObservation {
  const live = mkTmp("dsh-overlay-regression-live-");
  const hostHome = makeHostHome();
  try {
    // Invocation A starts and stages a session artifact into its root.
    const rootA = impl.prepare(RUN_ID, INV_A, live, hostHome);
    const artifactA = stageSessionArtifact(rootA, INV_A, "a");

    // Invocation B comes up WHILE A's artifacts are still present (the real
    // overlap: a successor starts before the predecessor's teardown).
    const rootB = impl.prepare(RUN_ID, INV_B, live, hostHome);
    const artifactB = stageSessionArtifact(rootB, INV_B, "b");

    // A's teardown must not reach B.
    impl.cleanup(RUN_ID, INV_A, live);

    // ── INVARIANT 1: B's staged artifact survives A's teardown.
    if (!fs.existsSync(artifactB)) {
      throw new DshOverlayInvariantViolation(
        "peer_artifact_destroyed",
        `cleanup of invocation ${INV_A} destroyed invocation ${INV_B}'s staged artifact ` +
          `${artifactB} (rootA=${rootA}, rootB=${rootB})`,
        {
          runId: RUN_ID,
          cleanedUpInvocation: INV_A,
          peerInvocation: INV_B,
          rootA,
          rootB,
          peerArtifact: artifactB,
          peerArtifactSurvived: false,
        },
      );
    }
    if (path.resolve(rootA) === path.resolve(rootB)) {
      throw new DshOverlayInvariantViolation(
        "invocation_roots_shared",
        `invocations ${INV_A} and ${INV_B} were allocated the SAME root ${rootA}: ` +
          `a peer teardown can reach every other invocation's artifacts`,
        { runId: RUN_ID, rootA, rootB },
      );
    }
    if (!fs.existsSync(rootB)) {
      throw new DshOverlayInvariantViolation(
        "peer_root_destroyed",
        `cleanup of invocation ${INV_A} destroyed invocation ${INV_B}'s root ${rootB}`,
        { runId: RUN_ID, rootA, rootB },
      );
    }
    // A's own root was created and survived B's prepare (isolation), and A's
    // teardown removed only A.
    if (fs.existsSync(rootA)) {
      throw new DshOverlayInvariantViolation(
        "own_root_not_removed",
        `cleanup of invocation ${INV_A} left its own root ${rootA} behind`,
        { runId: RUN_ID, rootA, rootB },
      );
    }
    // A's OWN artifact must be gone with A's own root: this guards a helper
    // that deletes nothing at all (and would otherwise look green above).
    if (fs.existsSync(artifactA)) {
      throw new DshOverlayInvariantViolation(
        "own_artifact_not_removed",
        `cleanup of invocation ${INV_A} left its own artifact ${artifactA} behind`,
        { runId: RUN_ID, rootA, ownArtifact: artifactA },
      );
    }

    // ── INVARIANT 2: the surviving root still accepts NEW writes.
    const artifactB2 = stageSessionArtifact(rootB, INV_B, "after-peer-teardown");
    const peerRootAcceptedNewWrite =
      fs.existsSync(artifactB2) &&
      fs.readFileSync(artifactB2, "utf8") === `${INV_B}\n`;
    if (!peerRootAcceptedNewWrite) {
      throw new DshOverlayInvariantViolation(
        "peer_root_not_writable",
        `invocation ${INV_B}'s root ${rootB} did not accept a new write after ` +
          `invocation ${INV_A}'s teardown`,
        { runId: RUN_ID, rootB, newArtifact: artifactB2 },
      );
    }

    // ── INVARIANT 3: B's own teardown leaves no invocation root behind.
    impl.cleanup(RUN_ID, INV_B, live);
    const remainingInvocationRoots = listInvocationRoots(live, RUN_ID);
    if (remainingInvocationRoots.length !== 0) {
      throw new DshOverlayInvariantViolation(
        "invocation_root_leaked",
        `after both teardowns the grouping dir still holds invocation roots: ` +
          JSON.stringify(remainingInvocationRoots),
        { runId: RUN_ID, remainingInvocationRoots },
      );
    }

    return {
      rootA,
      rootB,
      peerArtifactSurvived: true,
      peerRootAcceptedNewWrite,
      remainingInvocationRoots,
    };
  } finally {
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
}

interface PublishObservation {
  refused: boolean;
  errorCode: string | null;
  hostBytes: string;
  losingCopyRetained: boolean;
}

/**
 * THE PUBLICATION INVARIANT (shared by both arms):
 *
 *   An independently changed host destination must be RETAINED byte-for-byte,
 *   the publish must REFUSE with the typed
 *   `dsh_profile_overlay_publish_conflict`, and the invocation's losing copy
 *   must stay in the invocation root.
 *
 * For the pre-fix shape the first check (`hostBytes !== HOST_BYTES`) fires as
 * `independent_host_destination_overwritten`, and its `details.hostBytes` is
 * the invocation's losing copy — i.e. the independently written host content
 * is LOST.
 */
function assertPublishInvariants(impl: OverlayUnderTest): PublishObservation {
  const live = mkTmp("dsh-overlay-regression-publish-");
  const hostHome = makeHostHome();
  try {
    const root = impl.prepare(RUN_ID, INV_B, live, hostHome);
    const staged = path.join(root, CONFLICT_REL);
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(staged, INVOCATION_BYTES, "utf8");

    // An INDEPENDENT actor writes the host destination AFTER prepare. Its
    // bytes must never be replaced by this invocation's copy.
    const hostFile = path.join(hostHome, CONFLICT_REL);
    fs.mkdirSync(path.dirname(hostFile), { recursive: true });
    fs.writeFileSync(hostFile, HOST_BYTES, "utf8");

    let refused = false;
    let errorCode: string | null = null;
    try {
      impl.publish(RUN_ID, INV_B, live, hostHome);
    } catch (err) {
      refused = true;
      errorCode =
        err instanceof DshProfileOverlayError
          ? err.code
          : `untyped: ${(err as Error)?.message ?? String(err)}`;
    }

    const hostBytes = fs.readFileSync(hostFile, "utf8");
    // ── INVARIANT 1: the independent host bytes are retained.
    if (hostBytes !== HOST_BYTES) {
      throw new DshOverlayInvariantViolation(
        "independent_host_destination_overwritten",
        `publish overwrote the independently changed host destination ${hostFile}: ` +
          `expected ${JSON.stringify(HOST_BYTES)}, observed ${JSON.stringify(hostBytes)} ` +
          `(refused=${refused}, code=${errorCode}) — the host content is LOST`,
        {
          hostFile,
          relPath: CONFLICT_REL,
          expectedHostBytes: HOST_BYTES,
          hostBytes,
          lostHostBytes: true,
          refused,
          errorCode,
        },
      );
    }
    // ── INVARIANT 2: the publish refused.
    if (!refused) {
      throw new DshOverlayInvariantViolation(
        "publish_conflict_not_refused",
        `publish succeeded even though ${hostFile} changed independently since prepare`,
        { hostFile, hostBytes, refused, errorCode },
      );
    }
    // ── INVARIANT 3: the refusal is TYPED.
    if (errorCode !== "dsh_profile_overlay_publish_conflict") {
      throw new DshOverlayInvariantViolation(
        "publish_conflict_not_typed",
        `publish refused with ${JSON.stringify(errorCode)} instead of the typed ` +
          `dsh_profile_overlay_publish_conflict`,
        { hostFile, refused, errorCode },
      );
    }
    // ── INVARIANT 4: the losing copy is RETAINED in the invocation root.
    const losingCopyRetained =
      fs.existsSync(staged) && fs.readFileSync(staged, "utf8") === INVOCATION_BYTES;
    if (!losingCopyRetained) {
      throw new DshOverlayInvariantViolation(
        "losing_copy_not_retained",
        `the invocation's losing copy ${staged} was removed by the refused publish`,
        { root, staged, refused, errorCode },
      );
    }

    return { refused, errorCode, hostBytes, losingCopyRetained };
  } finally {
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
  }
}

/**
 * Run a helper expected to FAIL for the pre-fix shape and return the violation
 * it raised. `assert.fail` (not a plain throw) keeps the non-vacuity contract
 * explicit: if the model stops reproducing the defect, this control fails
 * loudly instead of passing.
 */
function expectViolation(fn: () => unknown, what: string): DshOverlayInvariantViolation {
  try {
    fn();
  } catch (err) {
    assert.ok(
      err instanceof DshOverlayInvariantViolation,
      `${what}: expected a DshOverlayInvariantViolation, got ` +
        `${(err as Error)?.name ?? "unknown"}: ${(err as Error)?.message ?? String(err)}`,
    );
    return err;
  }
  assert.fail(
    `${what}: the pre-fix shape SATISFIED the invariant, so this regression ` +
      `control proves nothing (the helper's assertions are vacuous)`,
  );
}

// ── Arms ────────────────────────────────────────────────────────────

describe("dsh profile overlay regression control (pre-fix vs shipped)", () => {
  before(() => {
    tmpRoot = tamanduaTempDir("tamandua-dsh-overlay-regression-");
  });
  after(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── Arm A (lifetime) — pre-fix must reproduce the defect ────────
  it("pre-fix lifetime arm: the shared run-scoped root teardown destroys the peer invocation's staged artifact", () => {
    const violation = expectViolation(
      () => assertLifetimeInvariants(PRE_FIX),
      "pre-fix lifetime",
    );

    // The concrete failure: A's recursive teardown removed B's staged session
    // artifact, because both invocations shared one run-scoped root.
    assert.equal(violation.code, "peer_artifact_destroyed");
    assert.equal(violation.details.cleanedUpInvocation, INV_A);
    assert.equal(violation.details.peerInvocation, INV_B);
    assert.equal(violation.details.peerArtifactSurvived, false);

    const rootA = String(violation.details.rootA);
    const rootB = String(violation.details.rootB);
    assert.equal(rootA, rootB, "the pre-fix model must share ONE root across invocations");
    // The shared root really is the LEGACY run-scoped namespace (the defect's
    // documented shape), not a per-invocation one.
    assert.equal(
      path.basename(path.dirname(rootA)),
      MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME,
      `expected the pre-fix root ${rootA} under ${MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME}/`,
    );
    assert.equal(path.basename(rootA), assertDshOverlayRunId(RUN_ID));
  });

  // ── Arm A (lifetime) — shipped must satisfy it ───────────────────
  it("shipped lifetime arm: two distinct invocation roots survive the peer's cleanup and still accept new writes", () => {
    const obs = assertLifetimeInvariants(SHIPPED);

    assert.notEqual(obs.rootA, obs.rootB, "each invocation owns its own root");
    assert.equal(obs.peerArtifactSurvived, true);
    assert.equal(obs.peerRootAcceptedNewWrite, true);
    assert.deepEqual(obs.remainingInvocationRoots, []);
    // Both roots are real per-invocation roots under the versioned namespace.
    for (const root of [obs.rootA, obs.rootB]) {
      assert.equal(
        path.basename(path.dirname(root)),
        assertDshOverlayRunId(RUN_ID),
        `expected ${root} under a per-run grouping dir`,
      );
      assert.equal(
        path.basename(path.dirname(path.dirname(root))),
        MATCHLOCK_DSH_INVOCATION_PARENT_DIR_NAME,
        `expected ${root} under ${MATCHLOCK_DSH_INVOCATION_PARENT_DIR_NAME}/`,
      );
    }
  });

  // ── Arm B (publication) — pre-fix must reproduce the data loss ──
  it("pre-fix publication arm: the unconditional copy publishes the invocation's losing copy over the independently changed host destination", () => {
    const violation = expectViolation(
      () => assertPublishInvariants(PRE_FIX),
      "pre-fix publication",
    );

    assert.equal(violation.code, "independent_host_destination_overwritten");
    assert.equal(violation.details.expectedHostBytes, HOST_BYTES);
    // The host now holds the INVOCATION's bytes: the independently written
    // content is gone.
    assert.equal(violation.details.hostBytes, INVOCATION_BYTES);
    assert.equal(violation.details.lostHostBytes, true);
    assert.equal(violation.details.refused, false);
    assert.equal(violation.details.errorCode, null);
  });

  // ── Arm B (publication) — shipped must satisfy it ────────────────
  it("shipped publication arm: the typed dsh_profile_overlay_publish_conflict retains the independently changed host bytes and the losing copy", () => {
    const obs = assertPublishInvariants(SHIPPED);

    assert.equal(obs.refused, true);
    assert.equal(obs.errorCode, "dsh_profile_overlay_publish_conflict");
    assert.equal(obs.hostBytes, HOST_BYTES, "the independent host bytes are byte-unchanged");
    assert.equal(obs.losingCopyRetained, true, "the invocation root keeps the losing copy");
  });

  // ── Non-vacuity: the model really is the two documented defect shapes ──
  it("models the documented pre-fix shapes and differs from the shipped allocation", () => {
    const live = mkTmp("dsh-overlay-regression-shape-");
    try {
      const preA = PRE_FIX.root(RUN_ID, INV_A, live);
      const preB = PRE_FIX.root(RUN_ID, INV_B, live);
      assert.equal(
        preA,
        preB,
        "the pre-fix model must allocate ONE run-scoped root for every invocation",
      );
      assert.equal(
        path.dirname(preA),
        path.join(
          path.resolve(live),
          MATCHLOCK_DIR_NAME,
          MATCHLOCK_DSH_OVERLAY_PARENT_DIR_NAME,
        ),
      );
      assert.equal(path.basename(preA), assertDshOverlayRunId(RUN_ID));

      const shipA = SHIPPED.root(RUN_ID, INV_A, live);
      const shipB = SHIPPED.root(RUN_ID, INV_B, live);
      assert.notEqual(
        shipA,
        shipB,
        "the shipped implementation must allocate a distinct root per invocation",
      );
      assert.equal(
        path.dirname(shipA),
        path.join(
          path.resolve(live),
          MATCHLOCK_DIR_NAME,
          MATCHLOCK_DSH_INVOCATION_PARENT_DIR_NAME,
          assertDshOverlayRunId(RUN_ID),
        ),
      );
      // The namespaces are DISJOINT, so a legacy recursive remove of the
      // run-scoped root can never reach a live invocation root.
      assert.ok(
        !shipA.startsWith(preA + path.sep),
        `invocation root ${shipA} must not live inside the legacy root ${preA}`,
      );
    } finally {
      fs.rmSync(live, { recursive: true, force: true });
    }
  });
});
