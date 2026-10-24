/**
 * launch-gate interactive adapter tests (G8 ADMISSION-INTEGRATION US-003, bead
 * tamandua-7p5.1.8).
 *
 * These tests drive the PRODUCTION adapter
 * (`src/installer/matchlock/launch-gate-interactive.ts` through its compiled
 * module in `dist/`) and the interactive plan / orchestration / CLI seams it is
 * wired into. Fixtures are REAL filesystem objects: a disposable Hermes profile
 * holding a genuine delete-mode SQLite store, and a byte-exact write-ahead-log
 * header for the store that must be refused. No VM is created, no model runs
 * and no real Matchlock binary is executed: the admission, controller and
 * runtime seams are injected.
 *
 * What is pinned:
 *
 *  - `matchlock hermes` and `matchlock hermes-shell` produce DISTINCT
 *    invocation kinds, in the plan's binding, in the gate receipt and in the
 *    admission anchor;
 *  - an allowed plan carries the identity-bound binding, and NO gate receipt is
 *    written before the VM exists;
 *  - a WAL store refuses with the G9 exit status (78), a written receipt, and
 *    ZERO runtime-builder / controller (VM create) calls;
 *  - the refusal carries a receipt naming the invocation kind and an admission
 *    anchor naming the image digest admission pinned;
 *  - an anchor that cannot be recorded refuses operationally (never an allow);
 *  - the CLI maps `LaunchGateRefusalError` onto the injected exit seam with
 *    exactly 78 and prints G9's remedy text plus the receipt path — never raw
 *    argv;
 *  - a pi plan is not gate-evaluated at all.
 *
 * SERIAL LANE: the adapter imports the production holder probe
 * (`store-holder-detect-runner.ts` -> bounded `lsof` / procfs), so this file
 * carries the serial classification and is registered in
 * `tests/serial-files.txt`. Its last test asserts both facts.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import type { InteractiveSessionArgs } from "../../../dist/cli/matchlock-interactive-args.js";
import {
  LAUNCH_GATE_REFUSAL_EXIT_CODE,
} from "../../../dist/installer/matchlock/gate-exit-code.js";
import { parseReceipt } from "../../../dist/installer/matchlock/gate-receipt.js";
import {
  evaluateInteractiveLaunchGate,
  interactiveLaunchGateInvocationId,
  interactiveLaunchGateKind,
  renderInteractiveLaunchGateRefusal,
  resolveInteractiveAdmissionAnchorPath,
  type InteractiveAdmissionAnchor,
} from "../../../dist/installer/matchlock/launch-gate-interactive.js";
import {
  LaunchGateRefusalError,
  type LaunchGateDecision,
} from "../../../dist/installer/matchlock/launch-gate-wiring.js";
import {
  planInteractiveSession,
  type AdmitInteractiveSession,
  type PlanInteractiveSessionOptions,
} from "../../../dist/installer/matchlock/interactive-session-plan.js";
import { runInteractiveSession } from "../../../dist/installer/matchlock/interactive-session-orchestration.js";
import { handleMatchlock } from "../../../dist/cli/commands/matchlock.js";
import type {
  InteractiveHermesAdapterSource,
} from "../../../dist/installer/matchlock/interactive-hermes-selection.js";
import {
  type MatchlockAdmissionOptions,
  type MatchlockAdmissionResult,
} from "../../../dist/installer/matchlock/admission.js";
import { STANDARD_MATCHLOCK_IMAGE } from "../../../dist/installer/matchlock/standard-image.js";
import {
  MATCHLOCK_POLICY_VERSION,
  type ExecutionIsolation,
} from "../../../dist/installer/matchlock/policy.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const MODULE_PATH = path.join(HERE, "launch-gate-interactive.ts");
const WIRING_PATH = path.join(HERE, "launch-gate-wiring.ts");
const SERIAL_FILES_PATH = path.join(REPO_ROOT, "tests", "serial-files.txt");

const THIS_FILE = "src/installer/matchlock/launch-gate-interactive.test.ts";

/** Every temp dir this file creates, removed in `after`. */
const temporaryDirectories: string[] = [];

function track(directory: string): string {
  temporaryDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function newStateDir(): string {
  return track(tamanduaShortTempDir("tamandua-ig-state-"));
}

/**
 * A disposable Hermes profile home holding a REAL rollback-format SQLite store
 * and a `config.yaml` that requests the delete journal mode.
 */
function newProfileHome(journalMode: "delete" | "wal" = "delete"): string {
  const home = track(tamanduaShortTempDir("tamandua-ig-home-"));
  fs.writeFileSync(
    path.join(home, "config.yaml"),
    `database:\n  journal_mode: ${journalMode}\n`,
  );
  const database = new DatabaseSync(path.join(home, "state.db"));
  database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)");
  database.exec("INSERT INTO t (value) VALUES ('row')");
  database.close();
  return home;
}

/** A byte-exact write-ahead-log store (SQLite magic, version pair (2,2)). */
function writeWalStore(home: string, name = "verification_evidence.db"): string {
  const file = path.join(home, name);
  const header = Buffer.alloc(4096);
  Buffer.from("SQLite format 3\u0000", "latin1").copy(header, 0);
  header[18] = 2;
  header[19] = 2;
  fs.writeFileSync(file, header);
  return file;
}

/** A deterministic Hermes adapter plan pointing at a disposable profile home. */
function adapterPlanFor(hostEffectiveDir: string): InteractiveHermesAdapterSource {
  return {
    profile: {
      profile: "default",
      isNamedProfile: false,
      hostEffectiveDir,
      guestHermesHome: "/workspace/config/hermes",
      guestProfilesRoot: "/workspace/config/hermes/profiles",
      externalDependencies: [],
      outsideScope: false,
      outsideScopeReason: null,
      refused: false,
      refusedReason: null,
    },
    capturedIdentity: { hostEffectiveDir },
    selectionRefused: false,
    launchAdmission: { ok: true, code: null, reason: null },
  };
}

const FAKE_POLICY = {
  version: MATCHLOCK_POLICY_VERSION,
  requestedImage: STANDARD_MATCHLOCK_IMAGE,
  requestedImageSource: "standard",
  rootUsageConsent: false,
  harness: "hermes",
  workingDirectory: "/home/tester/project",
  workPathMode: "host-absolute",
  workMounts: [],
  originalRepositoryRoot: null,
  gitMetadataRoots: [],
  resourceLimits: { cpus: 4, memoryMB: 8192, diskSizeMB: 20480, swapMB: 8192 },
} as unknown as ExecutionIsolation;

/** The pinned identity admission returns; its digest is what the anchor records. */
const ADMITTED_IDENTITY = {
  digest: "sha256:admitted-image-digest",
  config_digest: "sha256:admitted-config-digest",
  tag: STANDARD_MATCHLOCK_IMAGE,
};

function baseArgs(overrides: Partial<InteractiveSessionArgs> = {}): InteractiveSessionArgs {
  return {
    subcommand: "hermes",
    harness: "hermes",
    shell: false,
    workingDirectory: "/home/tester/project",
    image: STANDARD_MATCHLOCK_IMAGE,
    imageSource: "standard",
    resourceLimits: {
      cpus: 4,
      memoryMB: 8192,
      diskSizeMB: 20480,
      swapMB: 8192,
      sources: {
        cpus: "default",
        memoryMB: "default",
        diskSizeMB: "default",
        swapMB: "default",
      },
    },
    rootUsageOverride: false,
    allowPrivate: [],
    matchlockPrivileged: { privileged: true, source: "default" },
    matchlockDnsPriority: { priority: "ipv4", source: "default" },
    ...overrides,
  };
}

function makeAdmitter(
  result: MatchlockAdmissionResult = { policy: FAKE_POLICY, identity: ADMITTED_IDENTITY },
): { admit: AdmitInteractiveSession; calls: MatchlockAdmissionOptions[] } {
  const calls: MatchlockAdmissionOptions[] = [];
  const admit: AdmitInteractiveSession = async (opts) => {
    calls.push(opts);
    return result;
  };
  return { admit, calls };
}

/**
 * Interactive plan options for one disposable profile. Everything that would
 * spawn or reach a real host is injected; the launch gate is the PRODUCTION
 * adapter (it is the code under test) with a private state dir, no managed
 * config scope and an empty holder probe.
 */
function planOptionsFor(
  home: string,
  overrides: Partial<PlanInteractiveSessionOptions> = {},
): PlanInteractiveSessionOptions & { stateDir: string } {
  const stateDir = newStateDir();
  const { admit } = makeAdmitter();
  return {
    stateDir,
    env: {},
    euid: 1000,
    uid: 1000,
    gid: 1000,
    homeDir: "/home/tester",
    stdinIsTty: true,
    stdoutIsTty: true,
    swapSupportProbe: async (bin: string) => ({ supported: true, binaryPath: bin }),
    admit,
    hermesHomeEnv: home,
    hermesAdapterPlan: adapterPlanFor(home),
    hermesIsDirectory: (p) => p === home,
    launchGateInvocationId: "interactive:hermes:pid:4242:start:2026-01-02T03:04:05.000Z",
    launchGateDeps: {
      stateDir,
      configOptions: { managedDir: null, env: {} },
      holderProbe: () => [],
    },
    ...overrides,
  };
}

/** Read the admission anchor written next to a receipt path. */
function readAnchor(receiptPath: string): InteractiveAdmissionAnchor {
  return JSON.parse(
    fs.readFileSync(resolveInteractiveAdmissionAnchorPath(receiptPath), "utf8"),
  ) as InteractiveAdmissionAnchor;
}

/** Capture the refusal the production adapter throws for a WAL store. */
async function refusalErrorFor(
  args: InteractiveSessionArgs,
  overrides: Partial<PlanInteractiveSessionOptions> = {},
): Promise<LaunchGateRefusalError> {
  const home = newProfileHome();
  writeWalStore(home);
  try {
    await planInteractiveSession(args, planOptionsFor(home, overrides));
  } catch (error) {
    if (error instanceof LaunchGateRefusalError) return error;
    throw error;
  }
  throw new Error("expected the launch gate to refuse");
}

describe("G8 interactive launch gate (US-003)", () => {
  it("allows a compliant profile and binds the plan to kind 'interactive-hermes' and the admitted image", async () => {
    const home = newProfileHome();
    const options = planOptionsFor(home);

    const plan = await planInteractiveSession(baseArgs(), options);

    assert.ok(plan.launchGate, "an allowed hermes plan carries a gate binding");
    const binding = plan.launchGate!;
    assert.equal(binding.kind, "interactive-hermes");
    assert.equal(binding.invocationId, options.launchGateInvocationId);
    assert.match(binding.storeSetKey, /^sha256:[0-9a-f]{64}$/);
    assert.equal(binding.configJournalMode, "delete");
    // Only the PRESENT store is identity-bound, by (path, dev, ino).
    assert.equal(binding.stores.length, 1);
    assert.equal(binding.stores[0].canonicalPath, path.join(home, "state.db"));
    assert.match(binding.stores[0].dev, /^\d+$/);
    assert.match(binding.stores[0].ino, /^\d+$/);

    // NO receipt before the VM exists: an allow writes only the admission
    // anchor (what admission pinned), never a launch record.
    assert.equal(fs.existsSync(binding.receiptPath), false);

    const anchor = readAnchor(binding.receiptPath);
    assert.equal(anchor.schemaVersion, 1);
    assert.equal(anchor.recordKind, "matchlock-admission-anchor");
    assert.equal(anchor.invocationId, binding.invocationId);
    assert.equal(anchor.kind, "interactive-hermes");
    assert.equal(anchor.subcommand, "hermes");
    assert.equal(anchor.shell, false);
    assert.equal(anchor.harness, "hermes");
    assert.equal(anchor.image.reference, STANDARD_MATCHLOCK_IMAGE);
    assert.equal(anchor.image.source, "standard");
    assert.equal(anchor.image.digest, ADMITTED_IDENTITY.digest);
    assert.equal(anchor.image.configDigest, ADMITTED_IDENTITY.config_digest);
    assert.equal(anchor.image.tag, ADMITTED_IDENTITY.tag);
    assert.equal(anchor.profile.hostEffectiveDir, home);
    assert.equal(anchor.profile.guestHermesHome, "/workspace/config/hermes");
    assert.equal(anchor.receiptPath, binding.receiptPath);
  });

  it("records the shell variant as its own kind 'interactive-hermes-shell'", async () => {
    const home = newProfileHome();
    const options = planOptionsFor(home);

    const plan = await planInteractiveSession(
      baseArgs({ subcommand: "hermes-shell", harness: "hermes", shell: true }),
      options,
    );

    assert.equal(plan.launchGate?.kind, "interactive-hermes-shell");
    const anchor = readAnchor(plan.launchGate!.receiptPath);
    assert.equal(anchor.kind, "interactive-hermes-shell");
    assert.equal(anchor.subcommand, "hermes-shell");
    assert.equal(anchor.shell, true);
  });

  it("refuses a WAL store with exit 78, a written receipt, and ZERO runtime/controller (VM create) calls", async () => {
    const home = newProfileHome();
    writeWalStore(home);
    const options = planOptionsFor(home);
    const { admit, calls: admissionCalls } = makeAdmitter();

    let runtimeCalls = 0;
    let controllerCalls = 0;

    let caught: unknown;
    try {
      await runInteractiveSession(baseArgs(), {
        planOptions: { ...options, admit },
        buildRuntime: () => {
          runtimeCalls += 1;
          throw new Error("no runtime may be built after a gate refusal");
        },
        createController: () => {
          controllerCalls += 1;
          throw new Error("no controller may be created after a gate refusal");
        },
      });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof LaunchGateRefusalError);
    const refusal = caught as LaunchGateRefusalError;
    assert.equal(refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.equal(refusal.refusal.kind, "verdict");
    assert.equal(refusal.refusal.receiptWritten, true);

    // Admission (resolve/pin) runs BEFORE the gate; it creates no VM.
    assert.equal(admissionCalls.length, 1);
    assert.equal(runtimeCalls, 0);
    assert.equal(controllerCalls, 0);

    const receipt = parseReceipt(fs.readFileSync(refusal.refusal.receiptPath, "utf8").trimEnd());
    assert.equal(receipt.action, "refused");
    assert.equal(receipt.verdict, "refuse");
    assert.equal(receipt.invocation.kind, "interactive-hermes");
    assert.equal(receipt.invocation.profile, "default");
    assert.ok(
      receipt.findings.some((finding) => finding.code === "wal-header"),
      `expected a wal-header finding, got ${receipt.findings.map((f) => f.code).join(", ")}`,
    );

    // The refusal names the admitted image too: the anchor exists for it.
    const anchor = readAnchor(refusal.refusal.receiptPath);
    assert.equal(anchor.image.digest, ADMITTED_IDENTITY.digest);
    assert.equal(anchor.kind, "interactive-hermes");
  });

  it("records the shell variant's distinct kind in a refusal receipt too", async () => {
    const error = await refusalErrorFor(
      baseArgs({ subcommand: "hermes-shell", harness: "hermes", shell: true }),
    );
    const receipt = parseReceipt(fs.readFileSync(error.refusal.receiptPath, "utf8").trimEnd());
    assert.equal(receipt.invocation.kind, "interactive-hermes-shell");
    assert.equal(readAnchor(error.refusal.receiptPath).kind, "interactive-hermes-shell");
  });

  it("refuses operationally when the admission anchor cannot be recorded", async () => {
    const home = newProfileHome();
    const options = planOptionsFor(home, {
      launchGateDeps: {
        stateDir: newStateDir(),
        configOptions: { managedDir: null, env: {} },
        holderProbe: () => [],
        writeAdmissionAnchor: () => ({
          ok: false,
          code: "anchor-write-failed",
          path: "/nonexistent-anchor",
          detail: "EACCES: permission denied",
        }),
      },
    });

    await assert.rejects(
      () => planInteractiveSession(baseArgs(), options),
      (error: unknown) => {
        assert.ok(error instanceof LaunchGateRefusalError);
        assert.equal(error.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
        assert.equal(error.refusal.kind, "operational");
        assert.equal(error.refusal.receiptWritten, false);
        assert.equal(error.refusal.verdict, null);
        assert.match(error.refusal.detail, /admission evidence could not be recorded/);
        return true;
      },
    );
  });

  it("prints the rendered remedy and the receipt path, exits 78 through the CLI seam, and never echoes raw argv", async () => {
    const error = await refusalErrorFor(baseArgs());
    let stderr = "";
    const exits: number[] = [];

    const handled = await handleMatchlock(
      "matchlock",
      ["matchlock", "hermes", "--matchlock-allow-private", "10.9.8.7/32"],
      {
        cwd: newStateDir(),
        env: {},
        hostProbe: { onlineCpus: () => 4, totalMemoryMB: () => 8192 },
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
        exit: (code) => {
          exits.push(code);
        },
        runSession: async () => {
          throw error;
        },
      },
    );

    assert.equal(handled, true);
    assert.deepEqual(exits, [LAUNCH_GATE_REFUSAL_EXIT_CODE]);
    // G9's remedy text for the recorded findings…
    assert.match(stderr, /MATCHLOCK LAUNCH GATE: LAUNCH REFUSED/);
    assert.match(stderr, /wal-header/);
    assert.match(stderr, /tamandua matchlock hermes/);
    // …then the refusal detail and the receipt path.
    assert.ok(stderr.includes(error.refusal.detail));
    assert.ok(stderr.includes(`RECEIPT: ${error.refusal.receiptPath}`));
    // Raw argv is never echoed (the value below was supplied on the command line).
    assert.equal(stderr.includes("10.9.8.7/32"), false);
  });

  it("names the guest-visible config directory (from the admission anchor) in a not-delete-config remedy", async () => {
    // A rollback-format store under a config that requests `wal`: the refusal is
    // about the CONFIGURATION, and the remedy must name the directory the guest
    // reads (identical absolute path), not the host's copy elsewhere.
    const home = newProfileHome("wal");
    let caught: unknown;
    try {
      await planInteractiveSession(baseArgs(), planOptionsFor(home));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof LaunchGateRefusalError);
    const refusal = (caught as LaunchGateRefusalError).refusal;
    assert.ok(
      refusal.findings.some((finding) => finding.code === "not-delete-config"),
      `expected not-delete-config, got ${refusal.findings.map((f) => f.code).join(", ")}`,
    );

    const text = renderInteractiveLaunchGateRefusal(refusal, {
      relaunchCommand: "tamandua matchlock hermes",
    });
    assert.match(text, /not-delete-config/);
    assert.ok(
      text.includes(home),
      `expected the guest-visible config directory ${home} in the remedy text`,
    );
  });

  it("does not gate a pi plan", async () => {
    const home = newProfileHome();
    writeWalStore(home);
    const gateCalls: string[] = [];
    const options = planOptionsFor(home, {
      launchGate: (_selection, args) => {
        gateCalls.push(args.subcommand);
        return { action: "allow" } as unknown as LaunchGateDecision;
      },
    });

    const plan = await planInteractiveSession(
      baseArgs({ subcommand: "pi", harness: "pi", shell: false }),
      options,
    );

    assert.equal(gateCalls.length, 0);
    assert.equal(plan.launchGate, undefined);
    // A pi plan is native: even a WAL store in HOME is irrelevant to it.
    assert.equal(plan.hermesSelection, undefined);
  });

  it("builds the invocation id from pid + start instant and maps the shell variant to its own kind", () => {
    const id = interactiveLaunchGateInvocationId({
      pid: 4242,
      startedAt: "2026-01-02T03:04:05.000Z",
      subcommand: "hermes-shell",
    });
    assert.equal(id, "interactive:hermes-shell:pid:4242:start:2026-01-02T03:04:05.000Z");
    assert.match(id, /^interactive:hermes-shell:pid:4242:start:\d{4}-\d{2}-\d{2}T/);

    assert.equal(interactiveLaunchGateKind({ harness: "hermes", shell: false }), "interactive-hermes");
    assert.equal(
      interactiveLaunchGateKind({ harness: "hermes", shell: true }),
      "interactive-hermes-shell",
    );
  });

  it("the adapter supplies the production holder probe and this file is serial-classified", () => {
    const source = fs.readFileSync(MODULE_PATH, "utf8");
    assert.ok(source.includes('from "./store-holder-detect-runner.js"'));
    assert.ok(source.includes("createDefaultHolderProbeDeps"));
    // The wiring core stays child_process-free: the probe lives in the adapter,
    // so the wiring never IMPORTS the spawn-capable runner.
    const wiring = fs.readFileSync(WIRING_PATH, "utf8");
    assert.equal(/from\s+["']node:child_process["']/.test(wiring), false);
    assert.equal(/from\s+["']\.\/store-holder-detect-runner\.js["']/.test(wiring), false);

    const serialEntries = fs
      .readFileSync(SERIAL_FILES_PATH, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    assert.ok(
      serialEntries.includes(THIS_FILE),
      `${THIS_FILE} must be registered in tests/serial-files.txt`,
    );
  });
});
