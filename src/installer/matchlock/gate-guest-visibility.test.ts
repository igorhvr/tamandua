/**
 * gate-guest-visibility tests (G8 ADMISSION-INTEGRATION US-010, bead
 * tamandua-7p5.1.8).
 *
 * The production module (`src/installer/matchlock/gate-guest-visibility.ts`,
 * imported from `dist/`) is driven through its INJECTED seams — the guest exec
 * is a plain function, so the whole path is exercised with no VM, no RPC child
 * and no daemon.
 *
 * What is pinned:
 *
 *  - the probe measures a guest-visible journal mode per store with perspective
 *    `guest`; a garbage line, a non-zero exit, a rejected (timeout) exec, a
 *    missing seam or a missing store line records `unmeasured` — never a
 *    fabricated `delete` and never a fabricated `wal`;
 *  - the exec argv carries the packed helper path plus the JSON request, and the
 *    managed-layer override is forwarded ONLY when a caller sets one (the
 *    production guest resolves its own managed layer, which is the fact under
 *    measurement);
 *  - host store identities translate to guest spellings through the whole-dir
 *    mount, and a store outside the mount has no guest spelling (honest
 *    unmeasured entry, never a guessed path);
 *  - `attachGuestVisibility` returns a NEW record with the per-store entries,
 *    sets `discrepancy` only for a MEASURED disagreement, leaves an unmeasured
 *    entry as the shared sentinel, and never touches the verdict;
 *  - the after-boot capture is TOTAL: a probe failure, a record-write failure or
 *    a missing binding degrades to a result + a logged line and never throws, so
 *    the evidence path can never refuse a launch the gate allowed;
 *  - structural pins: no child_process / no exit ownership in the module, the
 *    hermes runner calls the capture exactly once between `prepareAndCreate` and
 *    the harness exec (and only for a gated invocation), the pi runner carries
 *    NO guest probe at all, and the packed helper is a guest-pack walk root.
 *
 * LANE. `node:fs`/`node:path` only — no process spawn — so this file belongs to
 * the PARALLEL lane; its last test asserts it is not registered in
 * `tests/serial-files.txt`. (The helper's own host-side fixture run, which
 * executes it with `node`, lives in `gate-config-probe-fixture.test.ts` and is
 * serial.)
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripComments } from "../../../dist/lib/comment-blind.js";
import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import { GATE_RECEIPT_UNREADABLE } from "../../../dist/installer/matchlock/gate-receipt.js";
import {
  attachGuestVisibility,
  buildGuestConfigProbeArgv,
  computeGuestVisibilityDiscrepancy,
  probeGuestVisibleConfig,
  readQualificationRecord,
  recordGuestVisibilityAfterBoot,
  translateGuestStorePaths,
} from "../../../dist/installer/matchlock/gate-guest-visibility.js";
import type {
  GuestConfigObservation,
  GuestConfigProbeExecSeam,
} from "../../../dist/installer/matchlock/gate-guest-visibility.js";
import {
  captureQualificationRecord,
  resolveQualificationRecordPath,
  serializeQualificationRecord,
} from "../../../dist/installer/matchlock/gate-qualification.js";
import type { QualificationRecord } from "../../../dist/installer/matchlock/gate-qualification.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const MODULE_SOURCE = path.join(REPO_ROOT, "src", "installer", "matchlock", "gate-guest-visibility.ts");
const PI_RUNNER_SOURCE = path.join(REPO_ROOT, "src", "installer", "matchlock", "pi-invocation-runner.ts");
const HERMES_RUNNER_SOURCE = path.join(
  REPO_ROOT,
  "src",
  "installer",
  "matchlock",
  "hermes-invocation-runner.ts",
);
const PACK_BUILDER_SOURCE = path.join(REPO_ROOT, "src", "installer", "matchlock", "guest-pack-builder.ts");
const SERIAL_FILES = path.join(REPO_ROOT, "tests", "serial-files.txt");

const HOST_HOME = "/home/dev/.hermes";
const GUEST_HOME = "/workspace/config/hermes";
const GUEST_STORE = `${GUEST_HOME}/state.db`;
const HOST_STORE = `${HOST_HOME}/state.db`;
const HELPER = "/workspace/runtime/lib/installer/matchlock/gate-config-probe.js";
const RECEIPT = "/var/state/matchlock/gate/run-abc_round-job-1_dispatch.json";

const roots: string[] = [];

function makeRoot(): string {
  const dir = tamanduaShortTempDir("gate-guest-vis-");
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function readSource(file: string): string {
  return stripComments(fs.readFileSync(file, "utf8"));
}

/** A quiet capture baseline: no digests, no dist stamp, no source identity. */
function quietDeps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sha256File: () => null,
    readDistVersionStamp: () => null,
    ...overrides,
  };
}

/** The gate's ALLOW binding for one invocation (the caller's, never invented). */
function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    invocationId: "run:abc:round:job-1:dispatch",
    kind: "scheduled-dispatch",
    storeSetKey: "sha256:store-set-key",
    receiptPath: RECEIPT,
    decidedAt: "2026-10-24T00:00:00.000Z",
    stores: [
      { canonicalPath: HOST_STORE, dev: "2049", ino: "99" },
    ],
    configJournalMode: "delete",
    configSource: `host-observed: user config ${HOST_HOME}/config.yaml`,
    ...overrides,
  };
}

/** One probe JSON line, exactly as the packed helper emits it. */
function probeLine(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    store: GUEST_STORE,
    journalMode: "delete",
    source: `guest-observed: user config ${GUEST_HOME}/config.yaml`,
    readable: true,
    ...overrides,
  });
}

/** An exec seam that records the request it was given and returns one result. */
function seamWith(
  result: { exitCode: number | null; stdout: string; failure?: string } | Error,
): { seam: GuestConfigProbeExecSeam; calls: Array<{ argv: string[]; timeoutMs: number }> } {
  const calls: Array<{ argv: string[]; timeoutMs: number }> = [];
  return {
    calls,
    seam: {
      exec: async (request) => {
        calls.push({ argv: [...request.argv], timeoutMs: request.timeoutMs });
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

function observation(overrides: Partial<GuestConfigObservation> = {}): GuestConfigObservation {
  return {
    storePath: GUEST_STORE,
    journalMode: "delete",
    source: `guest-observed: user config ${GUEST_HOME}/config.yaml`,
    readable: true,
    perspective: "guest",
    provenance: "measured",
    ...overrides,
  };
}

describe("guest config probe (injected exec seam)", () => {
  it("measures the guest-visible mode per store with perspective 'guest'", async () => {
    const secondStore = `${GUEST_HOME}/alt/state.db`;
    const { seam, calls } = seamWith({
      exitCode: 0,
      stdout:
        `${probeLine()}\n` +
        `${probeLine({ store: secondStore, journalMode: "wal", readable: true })}\n`,
    });

    const observations = await probeGuestVisibleConfig(seam, {
      stores: [GUEST_STORE, secondStore],
      guestHermesHome: GUEST_HOME,
      helperGuestPath: HELPER,
    });

    assert.equal(observations.length, 2);
    assert.equal(observations[0].storePath, GUEST_STORE);
    assert.equal(observations[0].perspective, "guest");
    assert.equal(observations[0].provenance, "measured");
    assert.equal(observations[0].journalMode, "delete");
    assert.equal(observations[0].readable, true);
    assert.equal(observations[1].journalMode, "wal");
    // ONE bounded exec for the whole store set, not one per store.
    assert.equal(calls.length, 1);
  });

  it("a garbage line, a non-zero exit, a rejected exec, a missing seam or a missing store line is unmeasured — never 'delete'", async () => {
    const cases: Array<{
      label: string;
      seam: GuestConfigProbeExecSeam | null;
    }> = [
      { label: "garbage", seam: seamWith({ exitCode: 0, stdout: "not json at all\n" }).seam },
      {
        label: "wrong shape",
        seam: seamWith({ exitCode: 0, stdout: `${JSON.stringify({ store: GUEST_STORE, journalMode: "delete" })}\n` }).seam,
      },
      { label: "non-zero exit", seam: seamWith({ exitCode: 3, stdout: probeLine() }).seam },
      { label: "no exit status", seam: seamWith({ exitCode: null, stdout: probeLine() }).seam },
      { label: "throwing exec", seam: seamWith(new Error("timeout after 30000ms")).seam },
      { label: "no seam", seam: null },
    ];

    for (const testCase of cases) {
      const observations = await probeGuestVisibleConfig(testCase.seam, {
        stores: [GUEST_STORE],
        guestHermesHome: GUEST_HOME,
        helperGuestPath: HELPER,
      });
      assert.equal(observations.length, 1, testCase.label);
      assert.equal(observations[0].provenance, "unmeasured", testCase.label);
      assert.equal(observations[0].journalMode, null, testCase.label);
      assert.equal(observations[0].readable, null, testCase.label);
      assert.equal(observations[0].perspective, "guest", testCase.label);
      assert.equal(
        String(observations[0].source).includes("delete"),
        false,
        `${testCase.label}: an unmeasured entry can never spell a mode`,
      );
    }
  });

  it("one store without a line leaves the others measured", async () => {
    const secondStore = `${GUEST_HOME}/alt/state.db`;
    const { seam } = seamWith({ exitCode: 0, stdout: `${probeLine()}\n` });

    const observations = await probeGuestVisibleConfig(seam, {
      stores: [GUEST_STORE, secondStore],
      guestHermesHome: GUEST_HOME,
      helperGuestPath: HELPER,
    });

    assert.equal(observations[0].provenance, "measured");
    assert.equal(observations[1].provenance, "unmeasured");
    assert.equal(observations[1].storePath, secondStore);
  });

  it("the argv carries the packed helper path and the JSON request; no managed override by default", () => {
    const argv = buildGuestConfigProbeArgv({
      stores: [GUEST_STORE],
      guestHermesHome: GUEST_HOME,
      helperGuestPath: HELPER,
    });

    assert.deepEqual(argv.slice(0, 3), ["node", HELPER, "--"]);
    const request = JSON.parse(argv[argv.length - 1]) as Record<string, unknown>;
    assert.equal(request.hermesHome, GUEST_HOME);
    assert.deepEqual(request.stores, [GUEST_STORE]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(request, "managedDir"),
      false,
      "the production guest resolves its own managed layer",
    );

    const disabled = buildGuestConfigProbeArgv({
      stores: [GUEST_STORE],
      guestHermesHome: GUEST_HOME,
      helperGuestPath: HELPER,
      managedDir: null,
    });
    const disabledRequest = JSON.parse(disabled[disabled.length - 1]) as Record<string, unknown>;
    assert.equal(disabledRequest.managedDir, null, "an explicit override is forwarded verbatim");
  });
});

describe("host → guest store-path translation", () => {
  it("maps stores inside the mounted config dir and refuses to guess for others", () => {
    const mapped = translateGuestStorePaths(
      [
        { canonicalPath: HOST_STORE },
        { canonicalPath: `${HOST_HOME}/profiles/named/state.db` },
        { canonicalPath: "/var/lib/other/state.db" },
        { canonicalPath: HOST_HOME },
        { canonicalPath: "" },
      ],
      HOST_HOME,
      GUEST_HOME,
    );

    assert.equal(mapped[0].guestStorePath, GUEST_STORE);
    assert.equal(mapped[1].guestStorePath, `${GUEST_HOME}/profiles/named/state.db`);
    assert.equal(mapped[2].guestStorePath, null, "outside the mount ⇒ no guest spelling");
    assert.equal(mapped[3].guestStorePath, null, "the mount root itself is not a store path");
    assert.equal(mapped[4].guestStorePath, null);
  });

  it("returns null spellings when either root is unusable", () => {
    assert.equal(translateGuestStorePaths([{ canonicalPath: HOST_STORE }], "", GUEST_HOME)[0].guestStorePath, null);
    assert.equal(translateGuestStorePaths([{ canonicalPath: HOST_STORE }], HOST_HOME, "")[0].guestStorePath, null);
    assert.deepEqual(translateGuestStorePaths(null, HOST_HOME, GUEST_HOME), []);
  });
});

describe("attachGuestVisibility", () => {
  function baseRecord(): QualificationRecord {
    return captureQualificationRecord(
      { action: "allow", binding: binding() } as never,
      { matchlock: { path: "/opt/bin/matchlock", sha256: "a".repeat(64) } },
      quietDeps() as never,
    );
  }

  it("writes measured entries with perspective 'guest' and no discrepancy when the modes agree", () => {
    const record = baseRecord();
    const attached = attachGuestVisibility(record, [observation()], { hostJournalMode: "delete" });

    assert.ok(attached !== null);
    assert.equal(attached.guestVisibility.length, 1);
    assert.deepEqual(Object.keys(attached.guestVisibility[0]), [
      "storePath",
      "journalMode",
      "source",
      "readable",
      "perspective",
      "provenance",
    ]);
    assert.equal(attached.guestVisibility[0].perspective, "guest");
    assert.equal(attached.guestVisibility[0].provenance, "measured");
    assert.equal(attached.guestVisibility[0].journalMode, "delete");
    assert.equal(attached.discrepancy, false);
    // The verdict and the rest of the record are carried through untouched.
    assert.equal(attached.receipt.verdict, "allow");
    assert.equal(attached.receipt.path, RECEIPT);
    assert.equal(attached.invocation.kind, "scheduled-dispatch");
    // The input record is never mutated.
    assert.deepEqual(record.guestVisibility, []);
    assert.equal(record.discrepancy, false);
  });

  it("sets the discrepancy flag for a MEASURED disagreement and never rewrites the verdict", () => {
    const attached = attachGuestVisibility(baseRecord(), [observation({ journalMode: "wal" })], {
      hostJournalMode: "delete",
    });

    assert.ok(attached !== null);
    assert.equal(attached.discrepancy, true);
    assert.equal(attached.guestVisibility[0].journalMode, "wal");
    assert.equal(attached.receipt.verdict, "allow", "evidence never rewrites the decision");
  });

  it("never fabricates a disagreement from missing evidence", () => {
    const unmeasuredEntry = observation({
      journalMode: null,
      readable: null,
      provenance: "unmeasured",
      source: "guest-unmeasured: guest probe exited 3",
    });
    assert.equal(computeGuestVisibilityDiscrepancy([unmeasuredEntry], "delete"), false);
    assert.equal(computeGuestVisibilityDiscrepancy([observation()], "unreadable"), false);
    assert.equal(computeGuestVisibilityDiscrepancy([observation()], null), false);
    assert.equal(computeGuestVisibilityDiscrepancy([], "delete"), false);

    const attached = attachGuestVisibility(baseRecord(), [unmeasuredEntry], { hostJournalMode: "delete" });
    assert.ok(attached !== null);
    assert.equal(attached.discrepancy, false);
    assert.equal(attached.guestVisibility[0].provenance, "unmeasured");
    assert.equal(attached.guestVisibility[0].journalMode, GATE_RECEIPT_UNREADABLE);
    assert.equal(attached.guestVisibility[0].readable, GATE_RECEIPT_UNREADABLE);
    assert.equal(
      String(attached.guestVisibility[0].journalMode) === "delete",
      false,
      "an unmeasured entry is never recorded as delete",
    );
  });

  it("keeps the existing entries and flag when nothing was measured in this pass", () => {
    const record = baseRecord();
    const withEntry = attachGuestVisibility(record, [observation()], { hostJournalMode: "delete" });
    assert.ok(withEntry !== null);

    const unchanged = attachGuestVisibility(withEntry, [], { hostJournalMode: "delete" });
    assert.ok(unchanged !== null);
    assert.deepEqual(unchanged.guestVisibility, withEntry.guestVisibility);
    assert.equal(unchanged.discrepancy, false);
    assert.equal(attachGuestVisibility(null, [observation()]), null);
  });

  it("serializes the flag strictly as a boolean and drops a hand-edited truthy value", () => {
    const attached = attachGuestVisibility(baseRecord(), [observation()], { hostJournalMode: "delete" });
    assert.ok(attached !== null);
    const parsed = JSON.parse(serializeQualificationRecord(attached)) as Record<string, unknown>;
    assert.equal(parsed.discrepancy, false);

    const polluted = { ...attached, discrepancy: "yes" } as unknown as QualificationRecord;
    const pollutedParsed = JSON.parse(serializeQualificationRecord(polluted)) as Record<string, unknown>;
    assert.equal(pollutedParsed.discrepancy, false, "only a real boolean can claim a disagreement");
  });
});

describe("recordGuestVisibilityAfterBoot (the runner's after-boot capture)", () => {
  it("probes, attaches and writes the record next to the receipt — measured, verdict unchanged", async () => {
    const { seam, calls } = seamWith({ exitCode: 0, stdout: `${probeLine()}\n` });
    const written: Array<{ record: QualificationRecord; path: string }> = [];
    const logs: Array<{ level: string; message: string }> = [];

    const result = await recordGuestVisibilityAfterBoot(
      {
        binding: binding() as never,
        hostConfigDir: HOST_HOME,
        guestConfigDir: GUEST_HOME,
        helperGuestPath: HELPER,
        runId: "run-abc",
        roundId: "job-1",
        qualification: { matchlock: { path: "/opt/bin/matchlock", sha256: "b".repeat(64) } },
      },
      {
        exec: seam,
        capture: (decision, inputs) => captureQualificationRecord(decision, inputs, quietDeps() as never),
        writeRecord: (record) => {
          written.push({ record, path: record.receipt.path as string });
          return { ok: true, path: resolveQualificationRecordPath(record.receipt.path as string) };
        },
        log: (level, message) => {
          logs.push({ level, message });
        },
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].argv[calls[0].argv.length - 1]).hermesHome, GUEST_HOME);
    assert.equal(result.observations.length, 1);
    assert.equal(result.written, true);
    assert.equal(result.discrepancy, false);
    assert.equal(result.recordPath, resolveQualificationRecordPath(RECEIPT));
    assert.equal(result.writeFailure, undefined);

    const record = result.record as QualificationRecord;
    assert.equal(record.receipt.verdict, "allow");
    assert.equal(record.receipt.path, RECEIPT);
    assert.equal(record.receipt.storeSetKey, "sha256:store-set-key");
    assert.equal(record.invocation.invocationId, "run:abc:round:job-1:dispatch");
    assert.equal(record.invocation.kind, "scheduled-dispatch");
    assert.equal(record.invocation.runId, "run-abc");
    assert.equal(record.invocation.roundId, "job-1");
    assert.equal(record.profiles.hostEffectiveDir, HOST_HOME);
    assert.equal(record.profiles.guestHermesHome, GUEST_HOME);
    assert.equal(record.guestVisibility.length, 1);
    assert.equal(record.guestVisibility[0].storePath, GUEST_STORE);
    assert.equal(record.guestVisibility[0].perspective, "guest");
    assert.equal(record.guestVisibility[0].provenance, "measured");
    assert.equal(record.guestVisibility[0].journalMode, "delete");
    assert.equal(record.discrepancy, false);
    assert.equal(written.length, 1);
    assert.equal(written[0].path, RECEIPT);
    // Agreement is not a warning.
    assert.equal(logs.filter((line) => line.level === "warn").length, 0);
  });

  it("records the disagreement, logs it once and keeps the verdict (host wal vs guest delete)", async () => {
    const { seam } = seamWith({ exitCode: 0, stdout: `${probeLine()}\n` });
    const logs: Array<{ level: string; message: string }> = [];

    const result = await recordGuestVisibilityAfterBoot(
      {
        binding: binding({ configJournalMode: "wal" }) as never,
        hostConfigDir: HOST_HOME,
        guestConfigDir: GUEST_HOME,
        helperGuestPath: HELPER,
      },
      {
        exec: seam,
        capture: (decision, inputs) => captureQualificationRecord(decision, inputs, quietDeps() as never),
        writeRecord: () => ({ ok: true, path: resolveQualificationRecordPath(RECEIPT) }),
        log: (level, message) => {
          logs.push({ level, message });
        },
      },
    );

    assert.equal(result.discrepancy, true);
    assert.equal(result.record?.discrepancy, true);
    assert.equal(result.record?.receipt.verdict, "allow");
    const warnings = logs.filter((line) => line.level === "warn");
    assert.equal(warnings.length, 1, `exactly one discrepancy warning; got ${JSON.stringify(logs)}`);
    assert.match(warnings[0].message, /differs from the host observation/);
    assert.match(warnings[0].message, /database\.journal_mode \(delete\)/);
  });

  it("a failing probe records 'unmeasured' and still writes the record — never refuses, never 'delete'", async () => {
    const { seam } = seamWith(new Error("exec timed out after 30000ms"));
    let wrote = 0;

    const result = await recordGuestVisibilityAfterBoot(
      {
        binding: binding() as never,
        hostConfigDir: HOST_HOME,
        guestConfigDir: GUEST_HOME,
        helperGuestPath: HELPER,
      },
      {
        exec: seam,
        capture: (decision, inputs) => captureQualificationRecord(decision, inputs, quietDeps() as never),
        writeRecord: () => {
          wrote += 1;
          return { ok: true, path: resolveQualificationRecordPath(RECEIPT) };
        },
        log: () => {},
      },
    );

    assert.equal(wrote, 1, "the unmeasured observation is still recorded");
    assert.equal(result.written, true);
    assert.equal(result.observations[0].provenance, "unmeasured");
    assert.equal(result.observations[0].journalMode, null);
    assert.equal(result.record?.guestVisibility[0].journalMode, GATE_RECEIPT_UNREADABLE);
    assert.equal(result.record?.guestVisibility[0].provenance, "unmeasured");
    assert.equal(result.record?.receipt.verdict, "allow");
    assert.equal(result.discrepancy, false);
  });

  it("a record-write failure is reported, not thrown", async () => {
    const { seam } = seamWith({ exitCode: 0, stdout: `${probeLine()}\n` });
    const logs: Array<{ level: string; message: string }> = [];

    const result = await recordGuestVisibilityAfterBoot(
      {
        binding: binding() as never,
        hostConfigDir: HOST_HOME,
        guestConfigDir: GUEST_HOME,
        helperGuestPath: HELPER,
      },
      {
        exec: seam,
        capture: (decision, inputs) => captureQualificationRecord(decision, inputs, quietDeps() as never),
        writeRecord: () => ({
          ok: false,
          code: "qualification-write-failed",
          path: resolveQualificationRecordPath(RECEIPT),
          detail: "EACCES: permission denied",
        }),
        log: (level, message) => {
          logs.push({ level, message });
        },
      },
    );

    assert.equal(result.written, false);
    assert.match(String(result.writeFailure), /EACCES/);
    assert.equal(result.record?.guestVisibility.length, 1, "the record is still returned");
    assert.ok(logs.some((line) => line.level === "warn" && /could not be written/.test(line.message)));
  });

  it("attaches to the record already on disk (a gate-written base record is preserved)", async () => {
    const existing = captureQualificationRecord(
      { action: "allow", binding: binding() } as never,
      { tamandua: { commit: "c".repeat(40), tree: "d".repeat(40) }, receipt: { path: RECEIPT } },
      quietDeps() as never,
    );
    const { seam } = seamWith({ exitCode: 0, stdout: `${probeLine()}\n` });
    const readPaths: string[] = [];

    const result = await recordGuestVisibilityAfterBoot(
      {
        binding: binding() as never,
        hostConfigDir: HOST_HOME,
        guestConfigDir: GUEST_HOME,
        helperGuestPath: HELPER,
      },
      {
        exec: seam,
        readRecord: (filePath) => {
          readPaths.push(filePath);
          return existing;
        },
        // A base record exists, so capture must NOT run.
        capture: () => {
          throw new Error("capture must not run when a base record exists");
        },
        writeRecord: () => ({ ok: true, path: resolveQualificationRecordPath(RECEIPT) }),
        log: () => {},
      },
    );

    assert.deepEqual(readPaths, [resolveQualificationRecordPath(RECEIPT)]);
    assert.equal(result.record?.tamandua.commit, "c".repeat(40), "the base record's fields survive");
    assert.equal(result.record?.guestVisibility.length, 1);
    assert.equal(result.written, true);
  });

  it("a store outside the config mount is recorded unmeasured with its host spelling", async () => {
    const { seam, calls } = seamWith({ exitCode: 0, stdout: `${probeLine()}\n` });

    const result = await recordGuestVisibilityAfterBoot(
      {
        binding: binding({
          stores: [
            { canonicalPath: HOST_STORE, dev: "1", ino: "2" },
            { canonicalPath: "/var/lib/other/state.db", dev: "3", ino: "4" },
          ],
        }) as never,
        hostConfigDir: HOST_HOME,
        guestConfigDir: GUEST_HOME,
        helperGuestPath: HELPER,
      },
      {
        exec: seam,
        capture: (decision, inputs) => captureQualificationRecord(decision, inputs, quietDeps() as never),
        writeRecord: () => ({ ok: true, path: resolveQualificationRecordPath(RECEIPT) }),
        log: () => {},
      },
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].argv[calls[0].argv.length - 1]).stores, [GUEST_STORE]);
    assert.equal(result.observations.length, 2);
    assert.equal(result.observations[0].provenance, "measured");
    assert.equal(result.observations[1].provenance, "unmeasured");
    assert.equal(result.observations[1].storePath, "/var/lib/other/state.db");
  });

  it("degrades to a result (no throw) when no binding was supplied", async () => {
    const result = await recordGuestVisibilityAfterBoot(
      { binding: null as never, hostConfigDir: HOST_HOME, guestConfigDir: GUEST_HOME, helperGuestPath: HELPER },
      { log: () => {} },
    );

    assert.equal(result.written, false);
    assert.equal(result.record, null);
    assert.match(String(result.captureFailure), /no launch-gate binding/);
  });

  it("readQualificationRecord ignores absent, foreign and malformed files", () => {
    const root = makeRoot();
    assert.equal(readQualificationRecord(path.join(root, "absent.json")), null);

    const foreign = path.join(root, "foreign.json");
    fs.writeFileSync(foreign, JSON.stringify({ recordKind: "something-else" }), "utf8");
    assert.equal(readQualificationRecord(foreign), null);

    const malformed = path.join(root, "malformed.json");
    fs.writeFileSync(malformed, "{not json", "utf8");
    assert.equal(readQualificationRecord(malformed), null);

    const valid = path.join(root, "valid.json");
    fs.writeFileSync(
      valid,
      serializeQualificationRecord(
        captureQualificationRecord(null, null, quietDeps() as never),
      ),
      "utf8",
    );
    const read = readQualificationRecord(valid);
    assert.equal(read?.recordKind, "matchlock-gate-qualification");
  });
});

describe("structural pins", () => {
  it("the module owns no process status and spawns nothing", () => {
    const source = readSource(MODULE_SOURCE);
    assert.equal(source.includes("node:child_process"), false);
    assert.equal(/process\.exit(Code)?\b/.test(source), false);
    assert.equal(source.includes("gate-exit-code"), false, "evidence module never owns an exit status");
    assert.equal(/\bexecSync\b|\bspawnSync\b|\bspawn\(/.test(source), false);
  });

  it("the pi runner carries NO guest probe at all", () => {
    const source = readSource(PI_RUNNER_SOURCE);
    for (const symbol of [
      "recordGuestVisibilityAfterBoot",
      "probeGuestVisibleConfig",
      "attachGuestVisibility",
      "gate-guest-visibility",
      "gate-config-probe",
    ]) {
      assert.equal(
        source.includes(symbol),
        false,
        `the pi harness path must invoke no guest probe (found ${symbol})`,
      );
    }
  });

  it("the hermes runner calls the capture ONCE, after create and before the harness exec, only for a gated invocation", () => {
    const source = readSource(HERMES_RUNNER_SOURCE);
    const calls = source.split("recordGuestVisibilityAfterBoot(").length - 1;
    assert.equal(calls, 1, "exactly one capture call site");

    const createIndex = source.indexOf("controller.prepareAndCreate(pin)");
    const captureIndex = source.indexOf("recordGuestVisibilityAfterBoot(");
    const harnessIndex = source.indexOf("const harnessHandle = controller.execPipe(");
    assert.ok(createIndex > 0 && captureIndex > 0 && harnessIndex > 0);
    assert.ok(createIndex < captureIndex, "the probe runs AFTER boot");
    assert.ok(captureIndex < harnessIndex, "the probe runs BEFORE the harness exec");

    // The capture is guarded by THIS invocation's allow binding: an ungated
    // path performs no probe and stays byte-identical.
    const guardIndex = source.lastIndexOf("if (opts.launchGate !== undefined) {", captureIndex);
    assert.ok(guardIndex > 0 && guardIndex < captureIndex, "the capture is gated on opts.launchGate");
    assert.ok(guardIndex > createIndex, "the guard wraps the probe, not the create");
  });

  it("the packed probe helper is a guest-pack closure root", () => {
    const source = readSource(PACK_BUILDER_SOURCE);
    assert.ok(
      source.includes('"installer/matchlock/gate-config-probe.js"'),
      "the helper must ship in the read-only pack (WALK_ROOTS)",
    );
  });

  it("this file stays in the parallel lane", () => {
    const serial = fs
      .readFileSync(SERIAL_FILES, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    assert.equal(
      serial.includes("src/installer/matchlock/gate-guest-visibility.test.ts"),
      false,
      "no spawn in this file: it belongs to the parallel lane",
    );
  });
});
