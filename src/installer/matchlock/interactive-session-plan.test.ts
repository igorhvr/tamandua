/**
 * interactive-session-plan.test.ts — MTLK-INTERACTIVE (US-004).
 *
 * Serial lane: the tested module reaches the child_process-owning swap-probe
 * module, so the classification guard requires serial registration. Every test
 * injects the swap probe and the admission seam; no real matchlock, VM or RPC
 * is ever touched.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MATCHLOCK_EXPLICIT_IMAGE_MISSING_CODE,
  MATCHLOCK_STANDARD_IMAGE_MISSING_CODE,
  INTERACTIVE_SESSION_TTY_REQUIRED_CODE,
  INTERACTIVE_IDENTITY_UNAVAILABLE_CODE,
  InteractiveSessionPlanError,
  planInteractiveSession,
  type AdmitInteractiveSession,
  type PlanInteractiveSessionOptions,
} from "../../../dist/installer/matchlock/interactive-session-plan.js";
import {
  MatchlockAdmissionError,
  type MatchlockAdmissionOptions,
  type MatchlockAdmissionResult,
} from "../../../dist/installer/matchlock/admission.js";
import {
  MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG,
  MatchlockRootUsageError,
} from "../../../dist/installer/matchlock/root-gate.js";
import { MATCHLOCK_SWAP_UNSUPPORTED_CODE } from "../../../dist/installer/matchlock/swap-support.js";
import { STANDARD_MATCHLOCK_IMAGE } from "../../../dist/installer/matchlock/standard-image.js";
import { MATCHLOCK_POLICY_VERSION, type ExecutionIsolation } from "../../../dist/installer/matchlock/policy.js";
import { writeFakeRpcDriver, tempTranscriptPath } from "../../../dist/installer/matchlock/fake-rpc-driver.js";
import {
  INTERACTIVE_HERMES_CONFIG_UNAVAILABLE_CODE,
  INTERACTIVE_HERMES_EXTERNAL_DEPENDENCY_UNSUPPORTED_CODE,
  InteractiveHermesSelectionError,
  type InteractiveHermesAdapterSource,
} from "../../../dist/installer/matchlock/interactive-hermes-selection.js";
import { buildInteractiveSessionCreateConfig } from "../../../dist/installer/matchlock/mount-plan.js";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import type { InteractiveSessionArgs } from "../../../dist/cli/matchlock-interactive-args.js";

const FAKE_POLICY = {
  requestedImage: STANDARD_MATCHLOCK_IMAGE,
  requestedImageSource: "standard",
  rootUsageConsent: false,
  harness: "pi",
  workingDirectory: "/home/tester/project",
  workPathMode: "host-absolute",
  workMounts: [],
  originalRepositoryRoot: null,
  gitMetadataRoots: [],
  resourceLimits: { cpus: 4, memoryMB: 8192, diskSizeMB: 20480, swapMB: 8192 },
} as unknown as ExecutionIsolation;

const FAKE_IDENTITY = {
  digest: "sha256:abc",
  config_digest: "sha256:def",
  tag: STANDARD_MATCHLOCK_IMAGE,
};

/**
 * US-007: a deterministic Hermes adapter plan so the admission-wiring tests do
 * not need a real on-disk Hermes home. The default-adapter path is covered by
 * the dedicated `interactive-hermes-selection` suite.
 */
const FAKE_HERMES_PLAN: InteractiveHermesAdapterSource = {
  profile: {
    profile: "default",
    isNamedProfile: false,
    hostEffectiveDir: "/home/tester/.hermes",
    guestHermesHome: "/workspace/config/hermes",
    guestProfilesRoot: "/workspace/config/hermes/profiles",
    externalDependencies: [],
    outsideScope: false,
    outsideScopeReason: null,
    refused: false,
    refusedReason: null,
  },
  capturedIdentity: { hostEffectiveDir: "/home/tester/.hermes" },
  selectionRefused: false,
  launchAdmission: { ok: true, code: null, reason: null },
};

function baseArgs(overrides: Partial<InteractiveSessionArgs> = {}): InteractiveSessionArgs {
  return {
    subcommand: "pi",
    harness: "pi",
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
    ...overrides,
  };
}

function baseOptions(
  overrides: Partial<PlanInteractiveSessionOptions> = {},
): PlanInteractiveSessionOptions {
  return {
    env: {},
    euid: 1000,
    uid: 1000,
    gid: 1000,
    homeDir: "/home/tester",
    stdinIsTty: true,
    stdoutIsTty: true,
    swapSupportProbe: async (bin: string) => ({ supported: true, binaryPath: bin }),
    ...overrides,
  };
}

function makeAdmitter(
  result: MatchlockAdmissionResult = { policy: FAKE_POLICY, identity: FAKE_IDENTITY },
): { admit: AdmitInteractiveSession; calls: MatchlockAdmissionOptions[] } {
  const calls: MatchlockAdmissionOptions[] = [];
  const admit: AdmitInteractiveSession = async (opts) => {
    calls.push(opts);
    return result;
  };
  return { admit, calls };
}

function throwingAdmitter(err: unknown): AdmitInteractiveSession {
  return async () => {
    throw err;
  };
}

describe("US-004 planInteractiveSession admission", () => {
  it("admits pi through the admitMatchlockRun seam with direct workspace mode", async () => {
    const args = baseArgs();
    const { admit, calls } = makeAdmitter();
    const plan = await planInteractiveSession(args, baseOptions({ admit }));

    assert.equal(plan.policy, FAKE_POLICY);
    assert.equal(plan.pinnedIdentity, FAKE_IDENTITY);
    assert.equal(plan.harness, "pi");
    assert.equal(plan.shell, false);
    assert.equal(plan.image, STANDARD_MATCHLOCK_IMAGE);
    assert.equal(plan.imageSource, "standard");
    assert.deepEqual(plan.identity, {
      uid: 1000,
      gid: 1000,
      homeDir: "/home/tester",
      cwd: "/home/tester/project",
    });
    assert.equal(typeof plan.configSelection.piConfigRoot, "string");
    assert.equal(plan.configSelection.piConfigProfile, "settings.json");
    assert.equal(plan.configSelection.hermesHomeEnv, undefined);

    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c.workspaceMode, "direct");
    assert.equal(c.workingDirectory, "/home/tester/project");
    assert.equal(c.requestedImage, STANDARD_MATCHLOCK_IMAGE);
    assert.equal(c.imageSource, "standard");
    assert.equal(c.rootUsageConsent, false);
    assert.equal(c.harness, "pi");
    assert.equal(c.submission, undefined);
    assert.deepEqual(c.resourceLimits, {
      cpus: 4,
      memoryMB: 8192,
      diskSizeMB: 20480,
      swapMB: 8192,
    });
    assert.deepEqual(c.allowPrivate, []);
    assert.equal(typeof c.rpcBinaryPath, "string");
  });

  it("admits hermes with the frozen submission snapshot", async () => {
    const args = baseArgs({ subcommand: "hermes", harness: "hermes" });
    const { admit, calls } = makeAdmitter();
    const plan = await planInteractiveSession(
      args,
      baseOptions({
        admit,
        hermesHomeEnv: "/home/tester/.hermes",
        hermesAdapterPlan: FAKE_HERMES_PLAN,
        hermesIsDirectory: () => true,
      }),
    );

    assert.equal(plan.configSelection.hermesHomeEnv, "/home/tester/.hermes");
    assert.equal(plan.configSelection.piConfigRoot, undefined);
    // US-007: the resolved Hermes selection is surfaced on the plan.
    assert.equal(plan.hermesSelection?.profile, "default");
    assert.equal(plan.hermesSelection?.hostEffectiveDir, "/home/tester/.hermes");
    assert.equal(plan.hermesSelection?.guestHermesHome, "/workspace/config/hermes");
    const c = calls[0];
    assert.equal(c.harness, "hermes");
    assert.deepEqual(c.submission, {
      homeDir: "/home/tester",
      cwd: "/home/tester/project",
      hermesHomeEnv: "/home/tester/.hermes",
    });
  });

  it("captures an unset HERMES_HOME as null", async () => {
    const args = baseArgs({ subcommand: "hermes-shell", harness: "hermes", shell: true });
    const { admit, calls } = makeAdmitter();
    const plan = await planInteractiveSession(
      args,
      baseOptions({
        admit,
        hermesAdapterPlan: FAKE_HERMES_PLAN,
        hermesIsDirectory: () => true,
      }),
    );

    assert.equal(plan.shell, true);
    assert.equal(plan.configSelection.hermesHomeEnv, null);
    assert.equal(plan.hermesSelection?.hermesHomeEnv, null);
    assert.deepEqual(calls[0].submission, {
      homeDir: "/home/tester",
      cwd: "/home/tester/project",
      hermesHomeEnv: null,
    });
  });

  it("admits shell variants against the same guest selection", async () => {
    const args = baseArgs({ subcommand: "pi-shell", shell: true });
    const { admit, calls } = makeAdmitter();
    const plan = await planInteractiveSession(args, baseOptions({ admit }));
    assert.equal(plan.subcommand, "pi-shell");
    assert.equal(plan.shell, true);
    assert.equal(calls[0].workspaceMode, "direct");
    assert.equal(calls[0].harness, "pi");
  });
});

describe("US-007 interactive Hermes selection wiring", () => {
  it("refuses a missing effective Hermes configuration directory before any image resolve or admission", async () => {
    let imageResolved = 0;
    let admitted = 0;
    const missingRoot = tamanduaTempDir("mtlk-hermes-missing-");
    const missing = path.join(missingRoot, "profiles", "ghost");
    try {
      await assert.rejects(
        () =>
          planInteractiveSession(
            baseArgs({ subcommand: "hermes", harness: "hermes" }),
            baseOptions({
              hermesHomeEnv: missing,
              resolveImage: () => {
                imageResolved++;
                return { image: STANDARD_MATCHLOCK_IMAGE, source: "standard" };
              },
              admit: async () => {
                admitted++;
                return { policy: FAKE_POLICY, identity: FAKE_IDENTITY };
              },
            }),
          ),
        (err: unknown) =>
          err instanceof InteractiveHermesSelectionError &&
          err.code === INTERACTIVE_HERMES_CONFIG_UNAVAILABLE_CODE,
      );
    } finally {
      fs.rmSync(missingRoot, { recursive: true, force: true });
    }
    assert.equal(imageResolved, 0);
    assert.equal(admitted, 0);
  });

  it("refuses a required external dependency before any admission", async () => {
    let admitted = 0;
    const plan: InteractiveHermesAdapterSource = {
      ...FAKE_HERMES_PLAN,
      profile: {
        ...FAKE_HERMES_PLAN.profile,
        externalDependencies: [
          {
            kind: "root-store",
            name: "state.db",
            hostPath: "/home/tester/.hermes/state.db",
            required: true,
          },
        ],
      },
    };
    await assert.rejects(
      () =>
        planInteractiveSession(
          baseArgs({ subcommand: "hermes-shell", harness: "hermes", shell: true }),
          baseOptions({
            hermesAdapterPlan: plan,
            hermesIsDirectory: () => true,
            admit: async () => {
              admitted++;
              return { policy: FAKE_POLICY, identity: FAKE_IDENTITY };
            },
          }),
        ),
      (err: unknown) =>
        err instanceof InteractiveHermesSelectionError &&
        err.code === INTERACTIVE_HERMES_EXTERNAL_DEPENDENCY_UNSUPPORTED_CODE,
    );
    assert.equal(admitted, 0);
  });

  it("evaluates the root gate before resolving the Hermes selection", async () => {
    let probed = 0;
    await assert.rejects(
      () =>
        planInteractiveSession(
          baseArgs({ subcommand: "hermes", harness: "hermes", rootUsageOverride: false }),
          baseOptions({
            euid: 0,
            hermesAdapterPlan: FAKE_HERMES_PLAN,
            hermesIsDirectory: () => {
              probed++;
              return true;
            },
          }),
        ),
      (err: unknown) => err instanceof MatchlockRootUsageError,
    );
    assert.equal(probed, 0);
  });

  it("leaves pi plans without a hermes selection", async () => {
    const { admit } = makeAdmitter();
    const plan = await planInteractiveSession(baseArgs(), baseOptions({ admit }));
    assert.equal(plan.hermesSelection, undefined);
  });
});

describe("US-004 provenance-aware missing-image refusal", () => {
  it("names tamandua matchlock setup for a missing standard image", async () => {
    await assert.rejects(
      () =>
        planInteractiveSession(
          baseArgs(),
          baseOptions({
            admit: throwingAdmitter(new MatchlockAdmissionError("image_unusable", "no such image")),
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof InteractiveSessionPlanError);
        assert.equal(err.code, MATCHLOCK_STANDARD_IMAGE_MISSING_CODE);
        assert.match(err.message, /tamandua matchlock setup/);
        assert.match(err.message, /never falls back to host execution/);
        return true;
      },
    );
  });

  it("requires operator provisioning for a missing explicit image", async () => {
    await assert.rejects(
      () =>
        planInteractiveSession(
          baseArgs({ image: "ghcr.io/acme/custom:1", imageSource: "explicit" }),
          baseOptions({
            admit: throwingAdmitter(new MatchlockAdmissionError("image_unusable", "not imported")),
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof InteractiveSessionPlanError);
        assert.equal(err.code, MATCHLOCK_EXPLICIT_IMAGE_MISSING_CODE);
        assert.match(err.message, /Operator provisioning/);
        return true;
      },
    );
  });

  it("propagates non-image admission failures unchanged", async () => {
    await assert.rejects(
      () =>
        planInteractiveSession(
          baseArgs(),
          baseOptions({
            admit: throwingAdmitter(
              new MatchlockAdmissionError("mount_policy_rejected", "broad source"),
            ),
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof MatchlockAdmissionError);
        assert.equal(err.code, "mount_policy_rejected");
        return true;
      },
    );
  });
});

describe("US-004 root-gate ordering", () => {
  it("evaluates the root gate before any probe, image resolve or admission", async () => {
    let swapCalls = 0;
    let imageCalls = 0;
    let admitCalls = 0;
    await assert.rejects(
      () =>
        planInteractiveSession(
          baseArgs(),
          baseOptions({
            euid: 0,
            rootUsageOverride: false,
            swapSupportProbe: async (bin) => {
              swapCalls++;
              return { supported: true, binaryPath: bin };
            },
            resolveImage: (opts) => {
              imageCalls++;
              return { image: opts.explicitImage ?? STANDARD_MATCHLOCK_IMAGE, source: "standard" };
            },
            admit: async () => {
              admitCalls++;
              return { policy: FAKE_POLICY, identity: FAKE_IDENTITY };
            },
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof MatchlockRootUsageError);
        assert.equal(err.code, "matchlock_root_usage_refused");
        return true;
      },
    );
    assert.equal(swapCalls, 0);
    assert.equal(imageCalls, 0);
    assert.equal(admitCalls, 0);
  });

  it("runs the root gate before the TTY check", async () => {
    await assert.rejects(
      () =>
        planInteractiveSession(
          baseArgs(),
          baseOptions({ euid: 0, rootUsageOverride: false, stdinIsTty: false }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof MatchlockRootUsageError);
        return true;
      },
    );
  });

  it("proceeds under the override and returns the shared warning", async () => {
    const { admit, calls } = makeAdmitter();
    const plan = await planInteractiveSession(
      baseArgs({ rootUsageOverride: true }),
      baseOptions({ euid: 0, admit }),
    );
    assert.equal(typeof plan.rootUsageWarning, "string");
    assert.match(plan.rootUsageWarning ?? "", new RegExp(MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")));
    assert.equal(calls[0].rootUsageConsent, true);
  });
});

describe("US-004 TTY precondition", () => {
  it("refuses a missing stdin terminal before admission", async () => {
    let admitted = 0;
    await assert.rejects(
      () =>
        planInteractiveSession(
          baseArgs(),
          baseOptions({
            stdinIsTty: false,
            admit: async () => {
              admitted++;
              return { policy: FAKE_POLICY, identity: FAKE_IDENTITY };
            },
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof InteractiveSessionPlanError);
        assert.equal(err.code, INTERACTIVE_SESSION_TTY_REQUIRED_CODE);
        assert.match(err.message, /stdin/);
        return true;
      },
    );
    assert.equal(admitted, 0);
  });

  it("refuses a missing stdout terminal", async () => {
    await assert.rejects(
      () => planInteractiveSession(baseArgs(), baseOptions({ stdoutIsTty: false })),
      (err: unknown) => {
        assert.ok(err instanceof InteractiveSessionPlanError);
        assert.equal(err.code, INTERACTIVE_SESSION_TTY_REQUIRED_CODE);
        assert.match(err.message, /stdout/);
        return true;
      },
    );
  });

  it("names both streams when neither is a terminal", async () => {
    await assert.rejects(
      () =>
        planInteractiveSession(
          baseArgs(),
          baseOptions({ stdinIsTty: false, stdoutIsTty: false }),
        ),
      (err: unknown) => {
        assert.match((err as Error).message, /stdin and stdout/);
        return true;
      },
    );
  });
});

describe("US-004 swap-capability handshake", () => {
  it("refuses when swap support cannot be confirmed", async () => {
    let admitted = 0;
    await assert.rejects(
      () =>
        planInteractiveSession(
          baseArgs(),
          baseOptions({
            swapSupportProbe: async (bin) => ({
              supported: false,
              binaryPath: bin,
              reasonCode: "unsupported",
              reason: "does not list --swap",
            }),
            admit: async () => {
              admitted++;
              return { policy: FAKE_POLICY, identity: FAKE_IDENTITY };
            },
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof InteractiveSessionPlanError);
        assert.equal(err.code, MATCHLOCK_SWAP_UNSUPPORTED_CODE);
        assert.match(err.message, /swap capability/);
        assert.match(err.message, /tamandua matchlock setup/);
        return true;
      },
    );
    assert.equal(admitted, 0);
  });

  it("refuses when the swap probe itself fails", async () => {
    await assert.rejects(
      () =>
        planInteractiveSession(
          baseArgs(),
          baseOptions({
            swapSupportProbe: async () => {
              throw new Error("probe exploded");
            },
          }),
        ),
      (err: unknown) => {
        assert.equal((err as InteractiveSessionPlanError).code, MATCHLOCK_SWAP_UNSUPPORTED_CODE);
        assert.match((err as Error).message, /probe exploded/);
        return true;
      },
    );
  });

  it("probes even when swap is disabled and proceeds on support", async () => {
    const probed: string[] = [];
    const { admit, calls } = makeAdmitter();
    const args = baseArgs();
    args.resourceLimits = { ...args.resourceLimits, swapMB: 0 };
    const plan = await planInteractiveSession(
      args,
      baseOptions({
        admit,
        rpcBinaryPath: "/opt/fake/matchlock",
        swapSupportProbe: async (bin) => {
          probed.push(bin);
          return { supported: true, binaryPath: bin };
        },
      }),
    );
    assert.deepEqual(probed, ["/opt/fake/matchlock"]);
    assert.equal(plan.resourceLimits.swapMB, 0);
    assert.equal(calls[0].rpcBinaryPath, "/opt/fake/matchlock");
  });

  it("forwards the allow-private list and the injected support probes to admission", async () => {
    const allowPrivateSupportProbe = async () => ({
      supported: true,
      binaryPath: "matchlock",
    });
    const swapSupportProbe = async (bin: string) => ({ supported: true, binaryPath: bin });
    const { admit, calls } = makeAdmitter();
    const plan = await planInteractiveSession(
      baseArgs({ allowPrivate: ["10.0.0.1", "192.168.1.0/24"] }),
      baseOptions({ admit, allowPrivateSupportProbe, swapSupportProbe }),
    );
    assert.deepEqual(plan.allowPrivate, ["10.0.0.1", "192.168.1.0/24"]);
    assert.deepEqual(calls[0].allowPrivate, ["10.0.0.1", "192.168.1.0/24"]);
    assert.equal(calls[0].allowPrivateSupportProbe, allowPrivateSupportProbe);
    // MTLK integration regression: the reconciled admission re-runs the swap
    // handshake for the v3 policy, so the plan must forward the same injected
    // probe it already used rather than let admission re-probe the real binary.
    assert.equal(calls[0].swapSupportProbe, swapSupportProbe);
  });
});

describe("US-004 image resolution and identity capture", () => {
  it("honors the standard env override", async () => {
    const { admit, calls } = makeAdmitter();
    const plan = await planInteractiveSession(
      baseArgs(),
      baseOptions({ admit, env: { TAMANDUA_MATCHLOCK_IMAGE: "registry.local/tamandua" } }),
    );
    assert.equal(plan.image, "registry.local/tamandua");
    assert.equal(plan.imageSource, "standard");
    assert.equal(calls[0].requestedImage, "registry.local/tamandua");
  });

  it("lets an explicit image win over the environment", async () => {
    const { admit, calls } = makeAdmitter();
    const plan = await planInteractiveSession(
      baseArgs({ image: "ghcr.io/acme/custom:1", imageSource: "explicit" }),
      baseOptions({ admit, env: { TAMANDUA_MATCHLOCK_IMAGE: "registry.local/tamandua" } }),
    );
    assert.equal(plan.image, "ghcr.io/acme/custom:1");
    assert.equal(plan.imageSource, "explicit");
    assert.equal(calls[0].imageSource, "explicit");
  });

  it("refuses a blank HOME rather than guessing the guest home", async () => {
    await assert.rejects(
      () => planInteractiveSession(baseArgs(), baseOptions({ homeDir: "   " })),
      (err: unknown) => {
        assert.ok(err instanceof InteractiveSessionPlanError);
        assert.equal(err.code, INTERACTIVE_IDENTITY_UNAVAILABLE_CODE);
        return true;
      },
    );
  });
});

describe("US-004 real admission seam through the fake RPC driver", () => {
  let tmpRoot: string;
  let fakeDriver: string;
  let configRoot: string;
  let workDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".mtlk-plan-test-"));
    fakeDriver = writeFakeRpcDriver({ dir: path.join(tmpRoot, "driver") });
    configRoot = path.join(tmpRoot, "pi-agent");
    fs.mkdirSync(configRoot, { recursive: true });
    workDir = path.join(tmpRoot, "work");
    fs.mkdirSync(workDir, { recursive: true });
    for (const key of [
      "PI_CODING_AGENT_DIR",
      "FAKE_IMAGE_TAG",
      "FAKE_IMAGE_DIGEST",
      "FAKE_IMAGE_CONFIG_DIGEST",
      "FAKE_TRANSCRIPT_FILE",
      "FAKE_RESOLVE_MISSING",
    ]) {
      savedEnv[key] = process.env[key];
    }
  });

  after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("admits pi and returns a v3 policy plus pinned identity via admitMatchlockRun", async () => {
    const transcript = tempTranscriptPath();
    process.env.PI_CODING_AGENT_DIR = configRoot;
    process.env.FAKE_IMAGE_TAG = "vic/ml:latest";
    process.env.FAKE_IMAGE_DIGEST = "sha256:fakedigest";
    process.env.FAKE_IMAGE_CONFIG_DIGEST = "sha256:fakeconfigdigest";
    process.env.FAKE_TRANSCRIPT_FILE = transcript;
    delete process.env.FAKE_RESOLVE_MISSING;

    const args = baseArgs({
      image: "vic/ml:latest",
      imageSource: "explicit",
      workingDirectory: workDir,
    });
    const plan = await planInteractiveSession(
      args,
      baseOptions({
        // Explicit image source ignores env; admission still reads the ambient
        // PI_CODING_AGENT_DIR set above (never pass the ambient env wholesale).
        env: {},
        rpcBinaryPath: process.execPath,
        rpcArgs: [fakeDriver],
        admission: { home: os.homedir() },
      }),
    );

    assert.equal(plan.policy.version, MATCHLOCK_POLICY_VERSION);
    assert.equal(plan.policy.requestedImage, "vic/ml:latest");
    assert.equal(plan.policy.requestedImageSource, "explicit");
    assert.equal(plan.policy.resolvedImageDigest, "sha256:fakedigest");
    assert.equal(plan.policy.configurationRoot, configRoot);
    assert.equal(plan.policy.workingDirectory, workDir);
    assert.equal(plan.pinnedIdentity.digest, "sha256:fakedigest");

    const frames = fs
      .readFileSync(transcript, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const methods = frames
      .map((frame) => frame.method)
      .filter((method): method is string => typeof method === "string");
    assert.ok(methods.includes("resolve_image"));
    assert.ok(!methods.includes("create"));
  });

  it("US-007: mounts the whole effective Hermes config dir RW at the approved guest HERMES_HOME and keeps the shell cwd identical", async () => {
    const transcript = tempTranscriptPath();
    process.env.FAKE_IMAGE_TAG = "vic/ml:latest";
    process.env.FAKE_IMAGE_DIGEST = "sha256:fakedigesthermes";
    process.env.FAKE_IMAGE_CONFIG_DIGEST = "sha256:fakeconfigdigesthermes";
    process.env.FAKE_TRANSCRIPT_FILE = transcript;
    delete process.env.FAKE_RESOLVE_MISSING;

    // Real effective Hermes home under the temp root; a genuinely absent
    // config.yaml under a valid directory is the built-in local default.
    const hermesHome = path.join(tmpRoot, "hermes-home");
    fs.mkdirSync(hermesHome, { recursive: true });
    const options = baseOptions({
      // Explicit image source ignores env; admission reads the fake-driver env.
      env: {},
      homeDir: path.join(tmpRoot, "submitter-home"),
      hermesHomeEnv: hermesHome,
      hermesIsDirectory: (p) => p === hermesHome,
      rpcBinaryPath: process.execPath,
      rpcArgs: [fakeDriver],
      admission: { home: os.homedir() },
    });

    const direct = await planInteractiveSession(
      baseArgs({
        subcommand: "hermes",
        harness: "hermes",
        image: "vic/ml:latest",
        imageSource: "explicit",
        workingDirectory: workDir,
      }),
      options,
    );

    assert.equal(direct.hermesSelection?.hostEffectiveDir, hermesHome);
    assert.equal(direct.hermesSelection?.guestHermesHome, "/workspace/config/hermes");
    assert.equal(direct.policy.harness, "hermes");
    assert.equal(direct.policy.configurationRoot, hermesHome);
    assert.equal(direct.policy.guestConfigurationRoot, "/workspace/config/hermes");

    const directConfig = buildInteractiveSessionCreateConfig(
      direct.policy,
      direct.pinnedIdentity,
      { ownerUid: 1000, ownerGid: 1000 },
    );
    // D5: the interactive mount is the IDENTICAL absolute host path.
    assert.equal(directConfig.env?.HERMES_HOME, hermesHome);
    assert.equal(directConfig.env?.PI_CODING_AGENT_DIR, undefined);
    const configMount = directConfig.vfs?.mounts?.[hermesHome];
    assert.equal(configMount?.type, "host_fs");
    assert.equal(configMount?.host_path, hermesHome);
    assert.equal(configMount?.readonly, false);
    assert.equal(configMount?.owner_uid, 1000);
    assert.equal(configMount?.owner_gid, 1000);
    assert.equal(directConfig.vfs?.mounts?.["/workspace/config/hermes"], undefined);
    // The whole config directory is mounted: no host HOME/state broad source.
    assert.equal(
      Object.values(directConfig.vfs?.mounts ?? {}).some(
        (mount) => mount.host_path === os.homedir(),
      ),
      false,
    );

    // The shell variant starts in the same guest working directory and carries
    // the same approved HERMES_HOME mapping.
    const shell = await planInteractiveSession(
      baseArgs({
        subcommand: "hermes-shell",
        harness: "hermes",
        shell: true,
        image: "vic/ml:latest",
        imageSource: "explicit",
        workingDirectory: workDir,
      }),
      options,
    );
    assert.equal(shell.workingDirectory, direct.workingDirectory);
    assert.equal(shell.hermesSelection?.guestHermesHome, "/workspace/config/hermes");
    const shellConfig = buildInteractiveSessionCreateConfig(
      shell.policy,
      shell.pinnedIdentity,
      { ownerUid: 1000, ownerGid: 1000 },
    );
    assert.equal(shellConfig.env?.HERMES_HOME, hermesHome);
    // Guest path is the mount key; direct-mode work mounts keep host === guest.
    assert.equal(shellConfig.vfs?.mounts?.[workDir]?.host_path, workDir);
    assert.equal(shellConfig.vfs?.mounts?.[workDir]?.readonly, false);

    const frames = fs
      .readFileSync(transcript, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const methods = frames
      .map((frame) => frame.method)
      .filter((method): method is string => typeof method === "string");
    assert.ok(methods.includes("resolve_image"));
    assert.ok(!methods.includes("create"));
  });
});

