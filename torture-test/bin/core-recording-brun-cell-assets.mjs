// core-recording-brun-cell-assets.mjs — CORE-CELLS US-003: sanitized portable
// BRUN specimen assets (pure data; no private-source dependency).
//
// Beads tamandua-6sy.7 / tamandua-6sy.7.4 (authorized torture-only CORE-CELLS
// slice, story US-003 = original CORE US-005 "BRUN launch-probe versus
// probe-passing mid-run instant-fail dsh path").
//
// This module is the SHIPPED sanitized source for the historical
// W4.dsh-do-now missing-credential specimen. Every public field below was read
// from the coordinator's retained source-review artifacts under
//   torture-test/var/review-logs/core-recording-source-ZFANtD/
// (brun-native-error-inspector.txt, brun-native-error-source.jsonl,
//  brun-retained-log-and-db.jsonl, brun-retained-session-count.jsonl,
//  brun-retained-session-inspector.txt, brun-round-identity-correlation.jsonl,
//  brun-adjacent-round-shape.jsonl).
//
// HONESTY / PORTABILITY CONTRACT:
//  * Nothing here reads, imports or otherwise DEPENDS on the private absolute
//    source directory (the /home/... prefix is never embedded). Locators name
//    the review artifacts relative to torture-test/var/review-logs/ and are
//    provenance labels, not loadable paths.
//  * Only PUBLIC fields are shipped: the run id, error code
//    MISSING_CREDENTIAL, exit/duration/byte-count facts, retained session
//    count/hashes, archived DB row, per-line sha256 of the retained round
//    shape. No credentials, no hidden reasoning, no full credential-bearing
//    prompts, no operator configuration.
//  * Every field is labeled by classification: "source-backed" (verbatim from
//    the review artifacts), "derived" (sha256 recomputed over a public string
//    in this module — deterministic), "adapted" (a present-day sanitized
//    representation), "synthetic" (an explicit present-day reproduction that
//    is NOT the captured historical byte) or "unknown" (explicitly absent,
//    with reason).
//  * THE EXACT SINGLE STDOUT BYTE OF THE HISTORICAL RUN IS NOT RETAINED:
//    it is recorded here as UNKNOWN with the precise reason, and the newline
//    used by the fresh corridor shim is an EXPLICITLY DECLARED SYNTHETIC
//    ADAPTATION — it is never presented as the captured historical byte.
//    (The retained note says "newline identity is prior diagnosis, not a byte
//    capture in this projection".)
//  * The historical round is a PRE-IFLB launch-broken dsh shape. Current
//    product behavior (launch-time harness probe + K6/N20 instant-fail
//    policy) differs from the historical 21-round MISSING_CREDENTIAL
//    loop; the corridor declarations below map the recorded facts onto the
//    CURRENT two corridors and are NOT a claim that the historical run took
//    them.
//  * No real credentials/provider/network are ever exercised; the fresh
//    shims are zero-token synthetic producers.
//
// Synthetic private-value sentinels are used wherever a private value would
// otherwise be needed; shipped tests must never depend on the private source
// tree.

import { createHash } from "node:crypto";

/** sha256 hex of a UTF-8 string. */
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Canonical stable string (sorted keys) for deterministic digests. */
function stableString(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableString(value[k])}`)
    .join(",")}}`;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * A source locator naming one retained review artifact (provenance label only).
 * `relativePath` is relative to torture-test/var/review-logs/ and never an
 * absolute operator path; shipped assets never load these.
 */
function locator(locatorId, relativePath, detail) {
  return { locatorId, relativePath, detail };
}

const SOURCE_DIR_LABEL = "torture-test/var/review-logs/core-recording-source-ZFANtD/";

/**
 * The BRUN specimen + current-corridor declarations.
 *
 * historical: source-backed/derived/unknown facts of W4.dsh-do-now run
 *   ba584b54-fbb3-40b4-a7cc-34f5d6843a2d.
 * corridors: the two CURRENT product corridors this cell drives through a real
 *   plain-stdout dsh path, each labeled with its recorded-fact mapping and any
 *   bounded per-test override (never production-default proof).
 */
export const BRUN_ASSET = {
  caseId: "W4.dsh-do-now-missing-credential",
  sourceIdentity: {
    kind: "dsh",
    runId: "ba584b54-fbb3-40b4-a7cc-34f5d6843a2d", // classification: source-backed (provenance, NEVER a fresh-run id)
    sessionRef: "session-897962e8-badc-4441-ab52-34768572cfda", // first retained round (source-backed)
    classification: "source-backed",
  },
  historical: {
    // The launch round shape of the FIRST retained dsh round (adjacent log
    // lines 7371-7378 of the retained pre-IFLB daemon log).
    roundShape: {
      exitCode: 1, // source-backed (log line "dsh execution failed", exitCode 1)
      signal: null, // source-backed
      durationMs: 762, // source-backed (dsh execution failed durationMs 762)
      stdoutBytes: 1, // source-backed ("dsh completed" stdoutBytes 1)
      stdoutTrimmedBytes: 0, // source-backed (stdoutPreview bytes 0 / trimmed empty)
      stderrBytes: 234, // source-backed
      stderrHasMissingCredential: true, // source-backed (stderrPreview.has_missing_credential true)
      emptyTrimmedOutput: true, // source-backed (Work round complete outcome empty_output / outputBytes 0)
      outcome: "empty_output", // source-backed
      // exact stdout byte value: UNKNOWN — see unknown[] below.
    },
    exactStdoutByte: {
      value: "UNKNOWN",
      reason:
        "the actual single stdout byte of run ba584b54 is NOT retained in the reviewed artifacts: brun-adjacent-round-shape.jsonl records stdoutBytes=1 with an empty stdout preview (bytes 0 / trimmed_bytes 0), so the byte identity cannot be reconstructed from source. Newline identity is prior diagnosis, not a byte capture in this projection.",
      classification: "unknown",
    },
    newlineAdaptation: {
      implemented: true,
      note:
        "the fresh corridor-A shim reproduces the recorded stdoutBytes=1 shape by writing exactly ONE newline byte (0x0A) to stdout. This newline is an EXPLICITLY DECLARED SYNTHETIC ADAPTATION and is NEVER presented as the captured historical byte (which remains UNKNOWN).",
      classification: "synthetic",
    },
    missingCredentialCode: {
      code: "MISSING_CREDENTIAL", // source-backed (exact_code true in both native terminal fields)
      valueBytes: 18, // source-backed
      terminalCodeCounts: { MISSING_CREDENTIAL: 21 }, // source-backed (brun-retained-session-count.jsonl)
      classification: "source-backed",
    },
    retainedSessions: {
      directoriesConsidered: 21, // source-backed
      matchedRunIdInNativePayload: 21, // source-backed
      unmatchedPayloads: 0, // source-backed
      firstTerminal: "2026-08-27T08:23:34.456Z", // source-backed
      lastTerminal: "2026-08-27T08:28:34.221Z", // source-backed
      sortedMatchingSessionHashIndexSha256:
        "5413ccedba7530164adcb36b2546ac5bd0028818081f3037bbf7a884e8844806", // source-backed
      classification: "source-backed",
    },
    nativeErrorSource: {
      // First retained round's native session payload digest (public only).
      compressedSha256: "c218219fffd70999ace464a15b9552b27c2889fc8709313a41b396ed4dea4333", // source-backed
      decodedSha256: "e46f56de95688a805362ca111561e66fb33f6ade45d51f9365b54fe37c9c3da1", // source-backed
      decodedBytes: 48873, // source-backed
      jsonlLines: 16, // source-backed
      line14Sha256: "7d4a333da5c8bd5b429ece21b431de0e8257889f16a4746084109e0546021d53", // assistant/chunk MISSING_CREDENTIAL (source-backed)
      line16Sha256: "c5fb5ecbc57b763cb0ab95b077f38d591b42f36f7bc27eb2806650d16c333610", // turn/end MISSING_CREDENTIAL (source-backed)
      classification: "source-backed",
    },
    archivedDb: {
      // Archived campaign DB snapshot of the run (retained read-only copy).
      databaseSha256: "e7f70e85b66f09d9b71850dcad845bbe619a96aab536da97c4eb7755ce507055", // source-backed
      declaredSha256: "e7f70e85b66f09d9b71850dcad845bbe619a96aab536da97c4eb7755ce507055", // source-backed
      runRow: { status: "canceled", tokensSpent: 0, instantFailCount: 0 }, // source-backed
      classification: "source-backed",
    },
    retainedLog: {
      // Retained pre-IFLB daemon log (read-only metadata only).
      logSha256: "0a06d49aa9799d69e9f45c32e3bd36660d2ed9b66d274b9bf26b2e8f38c4cc05", // source-backed
      rotatedLogSha256: "ec797ee9e5ff8d4aa1962fc5b9554081321a277f2e2d83c69681cb25b531d3f0", // source-backed
      rotatedLogExactRunPrefixHits: 67, // source-backed
      line7374Sha256: "31e2e364ee739e3e209e7bcc0bf2c038f52cb43d1eddf1c5ca7a6bac2dd3b94d", // dsh execution failed (source-backed)
      line7376Sha256: "9384a2cfe458d9974484d4faffbfc403e381b6eaf51b30d48d113c6f42d9115a", // dsh completed stdoutBytes=1 (source-backed)
      line7377Sha256: "b1712599926dec7a160f115239c4a3597b18301410147350872400f9d2084842", // Work round complete empty_output (source-backed)
      classification: "source-backed",
    },
    roundIdentity: {
      sameWorkdir: true, // source-backed
      pidMatches: true, // source-backed
      pid: 625829, // source-backed public field
      rawLogExists: true, // source-backed
      classification: "source-backed",
    },
    interpretation:
      "historical fact: W4.dsh-do-now (run ba584b54) was a launch-broken dsh producer that exited 1 fast with MISSING_CREDENTIAL on every retained round (21/21). It predates the current launch-time harness probe and the K6/N20 instant-fail policy; current behavior differs, which is exactly what the two corridors below exercise.",
  },
  corridors: {
    // Corridor A — first-dispatch REAL launch-probe failure (the CURRENT
    // handling of the historical launch-broken MISSING_CREDENTIAL shape:
    // the probe fails fast at the run's first dispatch and the run is
    // force-failed — no 21-round loop, no work round, zero tokens).
    a_first_dispatch_probe_failure: {
      recordedShape: "W4.dsh-do-now missing-credential producer shape",
      freshShim:
        "plain dsh stand-in that exits 1 fast on ANY prompt (including the launch probe), writes exactly ONE synthetic stdout byte (a declared-synthetic newline) and MISSING_CREDENTIAL to stderr; no provider/credential/network anywhere",
      expected: {
        probeStatus: "failed",
        runStatus: "failed",
        probeOkCount: 0,
        probeFailedCount: 1,
        instantFailLoopCount: 0,
        workRoundCount: 0,
        tokens: 0,
        stepNeverCompleted: true,
      },
      productDefaultNote: "production defaults untouched (probe enabled; K6/N20 not overridden in this corridor)",
    },
    // Corridor B — probe-passing mid-run instant-fail loop: the dsh harness
    // ANSWERS the launch probe correctly (plain-stdout PATH reply) then
    // instant-fails (fast exit 1, zero output, no claim) on every work round;
    // the CURRENT motor relaunches after the escalating backoff window and
    // force-fails at N consecutive instant-fail rounds with a distinct
    // run.instant_fail_loop event.
    b_probe_passing_mid_run_instant_fail: {
      recordedShape: "producer exits 1 fast with empty trimmed output (the recorded MISSING_CREDENTIAL empty-output byte shape is reproduced with zero stdout bytes here)",
      freshRuntime:
        "suite-owned plain-stdout dsh frozen runtime (torture-test/scripted-runtimes/runtime-dsh.mjs) answering the launch probe, mode die-before-claim exit 1 for every work round",
      // ── BOUNDED PER-TEST OVERRIDES (explicitly labeled separately) ──
      // These are NOT production-default proof: they only bound this
      // deterministic test. The product defaults K=6 / N=20 (and the 2s wall
      // threshold / 30s base) are asserted unchanged from the built product
      // module inside the regression file.
      testOnlyOverrides: {
        K: 2,
        N: 4,
        backoffBaseMs: 3000,
        wallMs: 20000,
        note: "test-only bounded overrides to keep the corridor deterministic and fast; production defaults K6/N20 remain and are asserted separately",
      },
      expected: {
        probeStatus: "ok",
        runStatus: "failed",
        probeOkCount: 1,
        probeFailedCount: 0,
        instantFailLoopCount: 1,
        instantFailCount: 4, // N consecutive instant-fail rounds
        tokens: 0,
        stepNeverCompleted: true,
        relaunchAfterBackoff: true, // no previous_round_in_flight stranding after a backoff-gated tick
      },
    },
  },
  sourceRefs: [
    locator("L1", SOURCE_DIR_LABEL + "brun-native-error-inspector.txt", "inspector script (read-only native error-code/source-locator projection)"),
    locator("L2", SOURCE_DIR_LABEL + "brun-native-error-source.jsonl", "first retained session: MISSING_CREDENTIAL exact at data.chunk.reason.failure.code / data.reason.error.code; compressed/decoded sha256"),
    locator("L3", SOURCE_DIR_LABEL + "brun-retained-log-and-db.jsonl", "retained pre-IFLB daemon log scan + archived DB run row (canceled / tokens 0 / instant_fail_count 0)"),
    locator("L4", SOURCE_DIR_LABEL + "brun-retained-session-count.jsonl", "21/21 retained sessions terminal MISSING_CREDENTIAL; first/last terminal; index sha256"),
    locator("L5", SOURCE_DIR_LABEL + "brun-retained-session-inspector.txt", "inspector script that produced L4"),
    locator("L6", SOURCE_DIR_LABEL + "brun-round-identity-correlation.jsonl", "first retained round identity: same workdir, pid match, session ref"),
    locator("L7", SOURCE_DIR_LABEL + "brun-adjacent-round-shape.jsonl", "round shape lines 7371-7378 incl. exitCode 1 / durationMs 762 / stdoutBytes 1 / empty trimmed output / MISSING_CREDENTIAL stderr"),
  ],
  unknown: [
    {
      fact: "exact value of the historical single stdout byte (stdoutBytes=1)",
      reason:
        "not retained in the reviewed artifacts (brun-adjacent-round-shape.jsonl stdoutPreview is empty; no raw stdout capture exists); recorded UNKNOWN, never invented",
    },
    {
      fact: "full historical stderr text (234 bytes) beyond the MISSING_CREDENTIAL code presence",
      reason: "only a bounded preview with has_missing_credential=true is retained; the code string itself is exact",
    },
  ],
  sourceSha256: null,
};

/** Deterministic sha256 over the sorted-key canonical form of the public payload. */
export function brunSpecimenSourceSha256() {
  const { sourceSha256: _digest, ...payload } = BRUN_ASSET;
  return sha256(stableString(payload));
}

BRUN_ASSET.sourceSha256 = brunSpecimenSourceSha256();
Object.freeze(BRUN_ASSET.sourceRefs);
// Freeze the whole tree AFTER the digest is filled (mirrors the TCMD assets:
// the shipped accessor returns a deep-frozen asset whose digest is stable).
deepFreeze(BRUN_ASSET);

/** Deep-frozen asset accessor. */
export function loadBrunAsset() {
  return BRUN_ASSET;
}

/** Assert an exported asset payload never carries private-location strings. */
export function assertNoPrivateSourceDependency(text) {
  const privateMarkers = [
    "/home/igorhvr", // operator absolute prefix
    "core-recording-source-ZFANtD/../", // no upward references
    "file:///home",
    "/var/home/.dsh/sessions/", // native session absolute roots
    "/var/home/.tamandua.", // retained state absolute roots
    "/var/results/campaign-", // archived campaign absolute roots
    "/var/fixtures/work/",
  ];
  for (const marker of privateMarkers) {
    if (typeof text === "string" && text.includes(marker)) {
      return { ok: false, marker };
    }
  }
  return { ok: true };
}
