/**
 * admission.test.ts — MTLK-ADMIT (serial lane: spawns the owned fake
 * `matchlock rpc` driver process and real git for fixtures).
 *
 * Wire-journal semantics: admission may issue resolve_image ONLY — zero
 * create frames. The pin is returned for persistence before any runnable
 * registration exists (registration is the caller's job, tested in
 * run.test.ts / rugpull.test.ts).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  admitMatchlockRun,
  MatchlockAdmissionError,
  MATCHLOCK_RPC_BIN_ENV,
  MATCHLOCK_RPC_ARGS_ENV,
  MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG,
  matchlockRootUsageRefusalText,
  pinFromPolicy,
  type MatchlockAllowPrivateSupportProbe,
} from "../../../dist/installer/matchlock/admission.js";
import {
  MATCHLOCK_POLICY_VERSION,
  serializeMatchlockPolicy,
  parseMatchlockPolicy,
} from "../../../dist/installer/matchlock/policy.js";
import {
  MATCHLOCK_DEFAULT_SWAP_MB,
  MATCHLOCK_MAX_SWAP_MB,
} from "../../../dist/installer/matchlock/resource-limits.js";
import { buildMatchlockCreateConfig } from "../../../dist/installer/matchlock/mount-plan.js";
import { writeFakeRpcDriver, tempTranscriptPath } from "../../../dist/installer/matchlock/fake-rpc-driver.js";
import type { MatchlockSwapSupportProbe } from "../../../dist/installer/matchlock/swap-support.js";

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr?.trim() ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "--initial-branch=main"], dir);
  git(["config", "user.email", "admit@tamandua.test"], dir);
  git(["config", "user.name", "Admit Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n", "utf-8");
  git(["add", "README.md"], dir);
  git(["commit", "-m", "initial"], dir);
}

function readTranscript(p: string): Array<Record<string, unknown>> {
  try {
    const raw = fs.readFileSync(p, "utf-8").trim();
    if (!raw) return [];
    return raw.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * Fixtures must live at host paths that the exact-path guest mounts allow.
 * Guest /tmp is protected (a work mount at a /tmp host path would shadow the
 * guest's disposable /tmp), so the fixtures live under the real operator home
 * (narrow /root|/home/<user> descendants are supported work roots). Evaluated
 * at module load, before any test mutates HOME.
 */
const REAL_HOME: string = os.homedir();

describe("matchlock run-creation admission", () => {
  let tmpRoot: string;
  let fakeDriver: string;
  let transcript: string;
  let configRoot: string;
  let nonRepoDir: string;
  let repoDir: string;
  let repoSubdir: string;
  // US-008 exact linked-worktree + separate-git-dir fixtures.
  let linkedWorktree: string;
  let sgdCheckout: string;
  let sgdGitDir: string;
  // Saved env for restore.
  let savedEnv: Record<string, string | undefined> = {};

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(REAL_HOME, ".mtlk-admit-test-"));
    fakeDriver = writeFakeRpcDriver({ dir: path.join(tmpRoot, "driver") });
    configRoot = path.join(tmpRoot, "pi-agent");
    fs.mkdirSync(configRoot, { recursive: true });
    nonRepoDir = path.join(tmpRoot, "plain-work");
    fs.mkdirSync(nonRepoDir, { recursive: true });
    fs.writeFileSync(path.join(nonRepoDir, "x.txt"), "x\n", "utf-8");
    repoDir = path.join(tmpRoot, "repo");
    initRepo(repoDir);
    repoSubdir = path.join(repoDir, "sub");
    fs.mkdirSync(repoSubdir, { recursive: true });

    // A REAL managed-style linked worktree of repoDir (its `.git` is a FILE
    // pointing at repoDir/.git/worktrees/<name>).
    linkedWorktree = path.join(tmpRoot, "wt-feature");
    git(["worktree", "add", "-b", "feat", linkedWorktree, "main"], repoDir);

    // A separate-git-dir checkout: the Git/common dir lives OUTSIDE the
    // checkout at its own absolute path.
    sgdCheckout = path.join(tmpRoot, "sgd-checkout");
    sgdGitDir = path.join(tmpRoot, "sgd-git");
    fs.mkdirSync(sgdCheckout, { recursive: true });
    git(["init", "--initial-branch=main", `--separate-git-dir=${sgdGitDir}`], sgdCheckout);
    git(["config", "user.email", "admit@tamandua.test"], sgdCheckout);
    git(["config", "user.name", "Admit Test"], sgdCheckout);
    fs.writeFileSync(path.join(sgdCheckout, "README.md"), "# sgd\n", "utf-8");
    git(["add", "README.md"], sgdCheckout);
    git(["commit", "-m", "initial"], sgdCheckout);

    for (const key of [MATCHLOCK_RPC_BIN_ENV, MATCHLOCK_RPC_ARGS_ENV, "FAKE_IMAGE_TAG", "FAKE_IMAGE_DIGEST", "FAKE_IMAGE_CONFIG_DIGEST", "FAKE_IMAGE_OCI_ENV_PATH", "FAKE_TRANSCRIPT_FILE", "PI_CODING_AGENT_DIR", "FAKE_RESOLVE_MISSING", "FAKE_CREATE_ACTUAL_DIGEST", "FAKE_CREATE_ACTUAL_CONFIG_DIGEST"]) {
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

  function setFake(opts: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(opts)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  /**
   * MTLK-ISO-SLICE2 US-003: a deterministic supporting swap-capability probe so
   * admissions never need a real matchlock binary. It echoes back the resolved
   * rpc binary path. Tests that exercise the refusal paths override it.
   */
  const supportingSwapProbe: MatchlockSwapSupportProbe = (binaryPath) => ({
    supported: true,
    binaryPath,
  });

  function admissionOpts(over: Record<string, unknown>): Record<string, unknown> {
    return {
      requestedImage: "vic/ml:latest",
      workspaceMode: "direct",
      workingDirectory: nonRepoDir,
      rpcBinaryPath: process.execPath,
      rpcArgs: [fakeDriver],
      swapSupportProbe: supportingSwapProbe,
      ...over,
    };
  }

  it("resolves the image over an owned RPC (resolve_image ONLY, zero create) and returns a pinned v2 policy for a NON-repository direct dir", async () => {
    transcript = tempTranscriptPath();
    setFake({
      [MATCHLOCK_RPC_BIN_ENV]: process.execPath,
      [MATCHLOCK_RPC_ARGS_ENV]: JSON.stringify([fakeDriver]),
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:fakedigest",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:fakeconfigdigest",
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: undefined,
    });
    const result = await admitMatchlockRun(
      admissionOpts({}) as never,
    );
    assert.equal(result.policy.version, MATCHLOCK_POLICY_VERSION);
    assert.equal(result.policy.resolvedImageDigest, "sha256:fakedigest");
    assert.equal(result.policy.resolvedImageConfigDigest, "sha256:fakeconfigdigest");
    assert.equal(result.policy.requestedImage, "vic/ml:latest");
    assert.equal(result.policy.configurationRoot, configRoot);
    assert.equal(result.policy.originalRepositoryRoot, null);
    assert.deepEqual(result.policy.gitMetadataRoots, []);
    assert.equal(result.policy.workMounts.length, 1);
    assert.equal(result.policy.workMounts[0].hostPath, nonRepoDir);
    assert.equal(result.policy.workMounts[0].guestPath, nonRepoDir);
    // Wire journal: ONE resolve_image, NO create.
    const txn = readTranscript(transcript);
    const methods = txn.map((e) => e.method).filter(Boolean);
    assert.deepEqual(methods, ["resolve_image"]);
  });

  it("persists exactly the caller-supplied resourceLimits for a FRESH admission (MTLK-VM-SIZE US-003)", async () => {
    transcript = tempTranscriptPath();
    setFake({
      [MATCHLOCK_RPC_BIN_ENV]: process.execPath,
      [MATCHLOCK_RPC_ARGS_ENV]: JSON.stringify([fakeDriver]),
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:fakedigest",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:fakeconfigdigest",
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: undefined,
    });
    const result = await admitMatchlockRun(
      admissionOpts({ resourceLimits: { cpus: 4, memoryMB: 4096, diskSizeMB: 20480 } }) as never,
    );
    assert.deepEqual(result.policy.resourceLimits, {
      cpus: 4,
      memoryMB: 4096,
      diskSizeMB: 20480,
      swapMB: MATCHLOCK_DEFAULT_SWAP_MB,
    });
    // Still resolve-only: supplied limits never trigger a create.
    assert.deepEqual(readTranscript(transcript).map((e) => e.method).filter(Boolean), ["resolve_image"]);
  });

  it("an inherited policy's resourceLimits win over newly supplied limits (replacement, MTLK-VM-SIZE US-003)", async () => {
    setFake({
      [MATCHLOCK_RPC_BIN_ENV]: process.execPath,
      [MATCHLOCK_RPC_ARGS_ENV]: JSON.stringify([fakeDriver]),
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:fakedigest",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:fakeconfigdigest",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const fresh = await admitMatchlockRun(
      admissionOpts({ resourceLimits: { cpus: 4, memoryMB: 4096, diskSizeMB: 20480 } }) as never,
    );
    const replacement = await admitMatchlockRun(
      admissionOpts({
        inheritedPolicy: fresh.policy,
        resourceLimits: { cpus: 8, memoryMB: 8192, diskSizeMB: 40960 },
      }) as never,
    );
    assert.deepEqual(
      replacement.policy.resourceLimits,
      { cpus: 4, memoryMB: 4096, diskSizeMB: 20480, swapMB: MATCHLOCK_DEFAULT_SWAP_MB },
      "a rugpull replacement retains the failed run's admitted VM size and swap (INHERITANCE RULE: preserved VERBATIM)",
    );
    assert.equal(replacement.policy.requestedImage, fresh.policy.requestedImage);
  });

  // SHARED-V3 (MTLK-SWAP): the resolved swapMB rides the resourceLimits into
  // the persisted v3 record. A fresh write keeps an explicit 0 (swap off) and
  // a positive size verbatim; an INHERITED write preserves the inherited
  // swapMB VERBATIM — never recomputed from the current environment.
  it("SHARED-V3: a fresh admission persists the supplied swapMB (0 = off and positive) and an inherited write preserves it verbatim", async () => {
    setFake({
      [MATCHLOCK_RPC_BIN_ENV]: process.execPath,
      [MATCHLOCK_RPC_ARGS_ENV]: JSON.stringify([fakeDriver]),
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:fakedigest",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:fakeconfigdigest",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const off = await admitMatchlockRun(
      admissionOpts({
        resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480, swapMB: 0 },
      }) as never,
    );
    assert.equal(off.policy.resourceLimits.swapMB, 0, "an explicit 0 (swap off) is preserved on a fresh v3 write");
    assert.equal(off.policy.requestedImageSource, "explicit");

    const sized = await admitMatchlockRun(
      admissionOpts({
        resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480, swapMB: MATCHLOCK_MAX_SWAP_MB },
      }) as never,
    );
    assert.equal(sized.policy.resourceLimits.swapMB, MATCHLOCK_MAX_SWAP_MB);

    const replacement = await admitMatchlockRun(
      admissionOpts({
        inheritedPolicy: off.policy,
        // Newly supplied limits must NOT recompute the inherited swap (0).
        resourceLimits: { cpus: 8, memoryMB: 8192, diskSizeMB: 40960, swapMB: 32768 },
      }) as never,
    );
    assert.deepEqual(
      replacement.policy.resourceLimits,
      { cpus: 2, memoryMB: 2048, diskSizeMB: 20480, swapMB: 0 },
      "an inherited write preserves swapMB verbatim (INHERITANCE RULE)",
    );
  });

  // SHARED-V3 US-009: the parser's REAL provenance is threaded through
  // admission into the persisted v3 record. A fresh write records the caller's
  // source; absent defaults to "explicit"; an inherited write preserves the
  // inherited source VERBATIM (never recomputed from the current environment).
  it("SHARED-V3: a fresh admission persists the caller's requestedImageSource (standard/explicit) and an inherited write preserves it verbatim", async () => {
    setFake({
      [MATCHLOCK_RPC_BIN_ENV]: process.execPath,
      [MATCHLOCK_RPC_ARGS_ENV]: JSON.stringify([fakeDriver]),
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:fakedigest",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:fakeconfigdigest",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const standard = await admitMatchlockRun(
      admissionOpts({ imageSource: "standard" }) as never,
    );
    assert.equal(standard.policy.requestedImageSource, "standard");
    // The persisted record is a FULL valid v3 record: serialize/parse round-trips.
    assert.equal(
      parseMatchlockPolicy(serializeMatchlockPolicy(standard.policy)).requestedImageSource,
      "standard",
      "a fresh standard write is a complete v3 record",
    );

    const explicit = await admitMatchlockRun(
      admissionOpts({ imageSource: "explicit" }) as never,
    );
    assert.equal(explicit.policy.requestedImageSource, "explicit");

    const absent = await admitMatchlockRun(admissionOpts({}) as never);
    assert.equal(absent.policy.requestedImageSource, "explicit", "absent provenance defaults to explicit");

    const replacement = await admitMatchlockRun(
      admissionOpts({
        inheritedPolicy: standard.policy,
        // A fresh "explicit" must NOT overwrite the inherited provenance.
        imageSource: "explicit",
      }) as never,
    );
    assert.equal(
      replacement.policy.requestedImageSource,
      "standard",
      "an inherited write preserves requestedImageSource VERBATIM (INHERITANCE RULE)",
    );
  });

  // SHARED-V3 US-009: R13 root-usage consent is a per-action fact: true only
  // when the override was supplied to THIS (fresh) action. An inherited write
  // preserves the persisted value verbatim and never recomputes it.
  it("SHARED-V3: a fresh admission records rootUsageConsent true only with the override and an inherited write preserves it verbatim", async () => {
    setFake({
      [MATCHLOCK_RPC_BIN_ENV]: process.execPath,
      [MATCHLOCK_RPC_ARGS_ENV]: JSON.stringify([fakeDriver]),
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:fakedigest",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:fakeconfigdigest",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const consented = await admitMatchlockRun(
      admissionOpts({ rootUsageConsent: true }) as never,
    );
    assert.equal(consented.policy.rootUsageConsent, true);

    const plain = await admitMatchlockRun(admissionOpts({}) as never);
    assert.equal(plain.policy.rootUsageConsent, false, "absent consent records false");

    const explicitFalse = await admitMatchlockRun(
      admissionOpts({ rootUsageConsent: false }) as never,
    );
    assert.equal(explicitFalse.policy.rootUsageConsent, false);

    const replacement = await admitMatchlockRun(
      admissionOpts({
        inheritedPolicy: consented.policy,
        // A fresh false must NOT revoke the inherited consent.
        rootUsageConsent: false,
      }) as never,
    );
    assert.equal(
      replacement.policy.rootUsageConsent,
      true,
      "an inherited write preserves rootUsageConsent VERBATIM (INHERITANCE RULE)",
    );
    assert.equal(
      parseMatchlockPolicy(serializeMatchlockPolicy(replacement.policy)).rootUsageConsent,
      true,
      "the inherited-consent write is a complete valid v3 record",
    );
  });

  it("preserves the USER IMAGE's effective PATH (oci env PATH) on the persisted policy", async () => {
    transcript = tempTranscriptPath();
    setFake({
      [MATCHLOCK_RPC_BIN_ENV]: process.execPath,
      [MATCHLOCK_RPC_ARGS_ENV]: JSON.stringify([fakeDriver]),
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:fakedigest",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:fakeconfigdigest",
      FAKE_IMAGE_OCI_ENV_PATH: "/opt/tamandua-synthetic-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: undefined,
    });
    const result = await admitMatchlockRun(admissionOpts({}) as never);
    assert.equal(
      result.policy.imagePath,
      "/opt/tamandua-synthetic-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    // The immutable pin is unchanged: PATH is preserved metadata, not identity.
    assert.equal(result.policy.resolvedImageDigest, "sha256:fakedigest");
    assert.equal(result.policy.resolvedImageConfigDigest, "sha256:fakeconfigdigest");
    const txn = readTranscript(transcript);
    assert.deepEqual(txn.map((e) => e.method).filter(Boolean), ["resolve_image"]);
  });

  it("an image with no declared PATH yields a policy with imagePath absent (runner uses its conservative default)", async () => {
    transcript = tempTranscriptPath();
    setFake({
      [MATCHLOCK_RPC_BIN_ENV]: process.execPath,
      [MATCHLOCK_RPC_ARGS_ENV]: JSON.stringify([fakeDriver]),
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_IMAGE_OCI_ENV_PATH: undefined,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: undefined,
    });
    const result = await admitMatchlockRun(admissionOpts({}) as never);
    assert.equal(result.policy.imagePath, undefined);
  });

  it("resolves the complete ORIGINAL repository for a direct cwd INSIDE a repo (subdir) and pins content+config", async () => {
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: undefined,
    });
    const result = await admitMatchlockRun(
      admissionOpts({ workingDirectory: repoSubdir }) as never,
    );
    assert.equal(result.policy.originalRepositoryRoot, repoDir);
    // The subdir work mount plus the repo root mount (nested entries are
    // deduplicated by the mount planner at create time).
    assert.ok(result.policy.workMounts.some((m) => m.hostPath === repoSubdir));
    // Git metadata roots nested inside the mounted original are NOT listed as
    // separate roots (the planner would drop them as redundant).
    assert.deepEqual(result.policy.gitMetadataRoots, []);
    assert.equal(result.identity.digest, "sha256:fakedigest");
  });

  it("refuses when the selected host pi CONFIGURATION directory is absent (only the host pi executable may be absent)", async () => {
    transcript = tempTranscriptPath();
    const missingConfig = path.join(tmpRoot, "missing-pi-agent");
    setFake({
      PI_CODING_AGENT_DIR: missingConfig,
      FAKE_TRANSCRIPT_FILE: transcript,
    });
    await assert.rejects(
      () => admitMatchlockRun(admissionOpts({}) as never),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "guest_configuration_incompatible" &&
        /existing DIRECTORY/.test(err.message),
    );
    // No RPC child was ever spawned for the refusal.
    assert.deepEqual(readTranscript(transcript), []);
  });

  // R13 / spec C §2.3: an EXPLICIT provenance store miss keeps the
  // import-and-retry guidance and never fetches or builds an image.
  it("refuses when the image cannot be resolved (resolve_image error) — explicit provenance keeps the import-and-retry guidance, no create", async () => {
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: "1",
    });
    await assert.rejects(
      () => admitMatchlockRun(admissionOpts({ imageSource: "explicit" }) as never),
      (err: unknown) => {
        if (!(err instanceof MatchlockAdmissionError)) return false;
        assert.equal(err.code, "image_unusable");
        assert.match(err.message, /is not usable: image_unusable/);
        assert.match(err.message, /Import it into the local matchlock store/);
        assert.match(err.message, /matchlock pull vic\/ml:latest/);
        assert.match(err.message, /nothing ran natively/);
        assert.doesNotMatch(err.message, /tamandua matchlock setup/);
        return true;
      },
    );
    const methods = readTranscript(transcript).map((e) => e.method).filter(Boolean);
    assert.deepEqual(methods, ["resolve_image"]);
  });

  // R13 / spec C §2.3: a STANDARD provenance store miss names the
  // `tamandua matchlock setup` remedy (no fetch, no build, no native fallback).
  it("refuses a standard-provenance store miss with the `tamandua matchlock setup` remedy and no fetch/build", async () => {
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: "1",
    });
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            requestedImage: "igorhvr/tamandua",
            imageSource: "standard",
          }) as never,
        ),
      (err: unknown) => {
        if (!(err instanceof MatchlockAdmissionError)) return false;
        assert.equal(err.code, "image_unusable");
        assert.match(err.message, /the standard Matchlock image igorhvr\/tamandua is not in the local matchlock store/);
        assert.match(err.message, /tamandua matchlock setup/);
        assert.match(err.message, /--matchlock-image <image>/);
        assert.match(err.message, /nothing ran natively/);
        assert.doesNotMatch(err.message, /matchlock pull/);
        return true;
      },
    );
    // The only matchlock interaction is the store lookup — never a pull/build.
    const methods = readTranscript(transcript).map((e) => e.method).filter(Boolean);
    assert.deepEqual(methods, ["resolve_image"]);
  });

  // R13 (spec C §2.6): the effective-uid gate runs FIRST — an euid-0 process
  // with no consent refuses before the allow-private probe, the image resolve
  // and any policy construction, and never spawns a matchlock process.
  it("R13: euid 0 with no consent refuses matchlock_root_usage_refused FIRST (no probe, no resolve, no policy) and spawns nothing", async () => {
    const dir = path.join(tmpRoot, "r13-root-refusal");
    fs.mkdirSync(dir, { recursive: true });
    const isolatedTranscript = path.join(dir, "wire.jsonl");
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: isolatedTranscript,
      FAKE_RESOLVE_MISSING: undefined,
    });
    let allowPrivateProbed = 0;
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            effectiveUid: () => 0,
            allowPrivate: ["192.168.107.74:8888"],
            allowPrivateSupportProbe: () => {
              allowPrivateProbed += 1;
              return { supported: true, binaryPath: process.execPath };
            },
          }) as never,
        ),
      (err: unknown) => {
        if (!(err instanceof MatchlockAdmissionError)) return false;
        assert.equal(err.code, "matchlock_root_usage_refused");
        assert.equal(err.message, matchlockRootUsageRefusalText());
        assert.match(err.message, /refusing to execute a Matchlock run as root/);
        assert.match(err.message, /documented to run unprivileged/);
        assert.match(err.message, new RegExp(MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG));
        assert.match(err.message, /nothing ran natively/);
        return true;
      },
    );
    assert.equal(allowPrivateProbed, 0, "the root gate precedes the allow-private capability probe");
    assert.equal(
      fs.existsSync(isolatedTranscript),
      false,
      "no matchlock RPC process may be spawned on a root refusal",
    );
  });

  // R13: euid 0 WITH consent inherited from the persisted policy proceeds and
  // preserves the inherited consent VERBATIM.
  it("R13: euid 0 with inherited consent proceeds and the replacement preserves rootUsageConsent true", async () => {
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:fakedigest",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:fakeconfigdigest",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const consented = await admitMatchlockRun(
      admissionOpts({ rootUsageConsent: true }) as never,
    );
    assert.equal(consented.policy.rootUsageConsent, true);
    const replacement = await admitMatchlockRun(
      admissionOpts({
        inheritedPolicy: consented.policy,
        effectiveUid: () => 0,
        // No override supplied to THIS action: the inherited consent carries it.
      }) as never,
    );
    assert.equal(
      replacement.policy.rootUsageConsent,
      true,
      "inherited consent permits the root process and is preserved VERBATIM",
    );
  });

  // R13: euid 0 + an override supplied to THIS action proceeds and the fresh
  // policy records rootUsageConsent true (spec C §4.4/§4.5).
  it("R13: euid 0 with the override supplied to this action proceeds and persists rootUsageConsent true", async () => {
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:fakedigest",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:fakeconfigdigest",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const result = await admitMatchlockRun(
      admissionOpts({ effectiveUid: () => 0, rootUsageConsent: true }) as never,
    );
    assert.equal(result.policy.rootUsageConsent, true);
    assert.deepEqual(readTranscript(transcript).map((e) => e.method).filter(Boolean), ["resolve_image"]);
  });

  // R13: a fresh NON-root submission records the consent flag truthfully —
  // false without the override and true with it.
  it("R13: a fresh non-root admission records rootUsageConsent truthfully (false absent, true with the override)", async () => {
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:fakedigest",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:fakeconfigdigest",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const plain = await admitMatchlockRun(
      admissionOpts({ effectiveUid: () => 1000 }) as never,
    );
    assert.equal(plain.policy.rootUsageConsent, false, "no override records consent false for a fresh submission");
    const overridden = await admitMatchlockRun(
      admissionOpts({ effectiveUid: () => 1000, rootUsageConsent: true }) as never,
    );
    assert.equal(overridden.policy.rootUsageConsent, true, "the override is recorded truthfully");
  });

  // R13: an override supplied to THIS action may set an inherited false to
  // true (§4.5 authoritative rule) so the persisted gate value stays
  // consistent with what the gate actually permitted.
  it("R13: an override can set an inherited rootUsageConsent false to true", async () => {
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:fakedigest",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:fakeconfigdigest",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const without = await admitMatchlockRun(
      admissionOpts({ effectiveUid: () => 1000 }) as never,
    );
    assert.equal(without.policy.rootUsageConsent, false);
    const withOverride = await admitMatchlockRun(
      admissionOpts({
        inheritedPolicy: without.policy,
        effectiveUid: () => 0,
        rootUsageConsent: true,
      }) as never,
    );
    assert.equal(withOverride.policy.rootUsageConsent, true);
  });

  // R13 parity: the hermes branch runs the SAME root gate with the same typed
  // code and ordering, before its selection checks and any effect.
  it("R13 parity: admitHermesMatchlockRun refuses euid 0 without consent with the same code and ordering", async () => {
    const dir = path.join(tmpRoot, "r13-hermes-refusal");
    fs.mkdirSync(dir, { recursive: true });
    const isolatedTranscript = path.join(dir, "wire.jsonl");
    const hermesRoot = path.join(tmpRoot, "r13-hermes-home");
    fs.mkdirSync(hermesRoot, { recursive: true });
    setFake({
      PI_CODING_AGENT_DIR: undefined,
      FAKE_TRANSCRIPT_FILE: isolatedTranscript,
      FAKE_RESOLVE_MISSING: undefined,
    });
    let allowPrivateProbed = 0;
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            harness: "hermes",
            submission: { homeDir: path.join(tmpRoot, "operator"), cwd: nonRepoDir, hermesHomeEnv: hermesRoot },
            effectiveUid: () => 0,
            allowPrivate: ["registry.internal"],
            allowPrivateSupportProbe: () => {
              allowPrivateProbed += 1;
              return { supported: true, binaryPath: process.execPath };
            },
          }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "matchlock_root_usage_refused" &&
        err.message === matchlockRootUsageRefusalText(),
    );
    assert.equal(allowPrivateProbed, 0, "the root gate precedes the allow-private probe on the hermes path too");
    assert.equal(fs.existsSync(isolatedTranscript), false, "the hermes root refusal spawns no matchlock process");
  });

  // ── MTLK-ISO-SLICE2 US-003: swap-capability handshake at admission ──

  /**
   * US-003: a deterministic supporting probe is the default for these tests
   * (admissionOpts injects it) so no real matchlock binary is needed. Each
   * test here overrides it to exercise a refusal path.
   */
  function swapFakes(over: Record<string, string | undefined> = {}): void {
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      FAKE_RESOLVE_MISSING: undefined,
      ...over,
    });
  }

  it("US-003: a FRESH admission probes the binary resolved by resolveRpcInvocation for --swap and persists the policy when it supports the flag", async () => {
    transcript = tempTranscriptPath();
    swapFakes();
    let probedBinary: string | undefined;
    let probedCalls = 0;
    const result = await admitMatchlockRun(
      admissionOpts({
        swapSupportProbe: (binaryPath: string) => {
          probedBinary = binaryPath;
          probedCalls += 1;
          return { supported: true, binaryPath, version: "9.9.9" };
        },
      }) as never,
    );
    assert.equal(probedCalls, 1, "the swap probe runs exactly once per admission");
    assert.equal(probedBinary, process.execPath, "the probe runs against the resolved rpc binary");
    assert.equal(result.policy.requestedImage, "vic/ml:latest");
    assert.deepEqual(
      readTranscript(transcript).map((e) => e.method).filter(Boolean),
      ["resolve_image"],
      "a supporting probe keeps admission resolve-only",
    );
  });

  it("MTLK-ISO2-MEND: admission resolves the rpc executable ONCE and binds it across awaited probes (no re-resolution drift)", async () => {
    // Owned fake driver A is the binary the swap probe qualifies. The swap
    // probe is the first AWAITED operation; when it runs it mutates the ambient
    // rpc env to a NON-EXISTENT binary B — exactly what an operator env flip
    // between two awaits looks like. A build that re-resolves before the image
    // transport launches B and dies with matchlock_unavailable; resolving once
    // and binding A for both the probe and the launch keeps the action sound.
    const driftDir = path.join(tmpRoot, "drift-driver");
    const driverA = writeFakeRpcDriver({ dir: driftDir });
    const driverB = path.join(driftDir, "gone-matchlock-binary");
    assert.equal(fs.existsSync(driverB), false, "the drift target must not exist");
    transcript = tempTranscriptPath();
    swapFakes();
    const savedBin = process.env[MATCHLOCK_RPC_BIN_ENV];
    const savedArgs = process.env[MATCHLOCK_RPC_ARGS_ENV];
    setFake({
      [MATCHLOCK_RPC_BIN_ENV]: driverA,
      [MATCHLOCK_RPC_ARGS_ENV]: undefined,
      FAKE_TRANSCRIPT_FILE: transcript,
    });
    const probed: string[] = [];
    try {
      const result = await admitMatchlockRun(
        admissionOpts({
          rpcBinaryPath: undefined,
          rpcArgs: undefined,
          swapSupportProbe: (binaryPath: string) => {
            probed.push(binaryPath);
            process.env[MATCHLOCK_RPC_BIN_ENV] = driverB;
            return { supported: true, binaryPath };
          },
        }) as never,
      );
      assert.equal(probed.length, 1, "the swap probe runs exactly once");
      assert.equal(probed[0], driverA, "the swap probe qualified owned driver A");
      assert.equal(result.policy.resolvedImageDigest, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      assert.deepEqual(
        readTranscript(transcript).map((e) => e.method).filter(Boolean),
        ["resolve_image"],
        "the image transport launched the SAME binary the probe qualified",
      );
    } finally {
      if (savedBin === undefined) delete process.env[MATCHLOCK_RPC_BIN_ENV];
      else process.env[MATCHLOCK_RPC_BIN_ENV] = savedBin;
      if (savedArgs === undefined) delete process.env[MATCHLOCK_RPC_ARGS_ENV];
      else process.env[MATCHLOCK_RPC_ARGS_ENV] = savedArgs;
    }
  });

  it("US-003: a binary that does not advertise --swap refuses with matchlock_swap_unsupported naming the resolved path + remedy, writes NO policy and resolves NO image", async () => {
    const dir = path.join(tmpRoot, "swap-unsupported");
    fs.mkdirSync(dir, { recursive: true });
    const isolatedTranscript = path.join(dir, "wire.jsonl");
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: isolatedTranscript,
      FAKE_RESOLVE_MISSING: undefined,
    });
    let probedBinary: string | undefined;
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            swapSupportProbe: (binaryPath: string) => {
              probedBinary = binaryPath;
              return {
                supported: false,
                binaryPath,
                version: "0.1.0",
                reasonCode: "unsupported",
                reason: '"matchlock run --help" does not list --swap',
              };
            },
          }) as never,
        ),
      (err: unknown) => {
        if (!(err instanceof MatchlockAdmissionError)) return false;
        assert.equal(err.code, "matchlock_swap_unsupported");
        assert.ok(err.message.includes(process.execPath), `names the resolved binary: ${err.message}`);
        assert.match(err.message, /--swap/);
        assert.match(err.message, /tamandua matchlock setup/);
        return true;
      },
    );
    assert.equal(probedBinary, process.execPath, "the refusal names the resolved rpc binary");
    assert.equal(
      fs.existsSync(isolatedTranscript),
      false,
      "a swap refusal writes no policy and issues no resolve_image",
    );
  });

  it("US-003: a timeout/unparseable (probe_failed) result refuses with the same typed matchlock_swap_unsupported code", async () => {
    swapFakes();
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            swapSupportProbe: (binaryPath: string) => ({
              supported: false,
              binaryPath,
              reasonCode: "probe_failed",
              reason: `"${binaryPath} run --help" did not exit (killed by a signal or timed out)`,
            }),
          }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "matchlock_swap_unsupported" &&
        /probe_failed|did not exit|timed out|killed/.test(err.message),
    );
  });

  it("US-003: a missing matchlock binary (ENOENT) keeps the matchlock_unavailable classification", async () => {
    swapFakes();
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            swapSupportProbe: (binaryPath: string) => ({
              supported: false,
              binaryPath,
              reasonCode: "missing_binary",
              reason: `matchlock binary not found: ${binaryPath}`,
            }),
          }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "matchlock_unavailable" &&
        err.message.includes(process.execPath),
    );
  });

  it("US-003: a throwing probe fails closed with the typed matchlock_swap_unsupported refusal", async () => {
    swapFakes();
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            swapSupportProbe: () => {
              throw new Error("probe exploded");
            },
          }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "matchlock_swap_unsupported" &&
        /probe exploded/.test(err.message) &&
        err.message.includes(process.execPath),
    );
  });

  it("US-003: a swap-DISABLED (swapMB 0) admission still probes for --swap and persists swapMB 0", async () => {
    transcript = tempTranscriptPath();
    swapFakes();
    let probedCalls = 0;
    const result = await admitMatchlockRun(
      admissionOpts({
        resourceLimits: { cpus: 1, memoryMB: 1024, diskSizeMB: 1024, swapMB: 0 },
        swapSupportProbe: (binaryPath: string) => {
          probedCalls += 1;
          return { supported: true, binaryPath };
        },
      }) as never,
    );
    assert.equal(probedCalls, 1, "the qualified-runtime proxy runs even when swap is disabled");
    assert.equal(result.policy.resourceLimits.swapMB, 0);
  });

  it("US-003: an inherited-policy replacement probes again before re-admitting", async () => {
    transcript = tempTranscriptPath();
    swapFakes();
    const first = await admitMatchlockRun(admissionOpts({}) as never);
    let replacementProbed = 0;
    const replacement = await admitMatchlockRun(
      admissionOpts({
        inheritedPolicy: first.policy,
        swapSupportProbe: (binaryPath: string) => {
          replacementProbed += 1;
          return { supported: true, binaryPath };
        },
      }) as never,
    );
    assert.equal(replacementProbed, 1, "a replacement re-runs the handshake before re-admitting");
    assert.equal(replacement.policy.requestedImage, first.policy.requestedImage);
  });

  it("US-003: euid 0 with no consent never reaches the swap probe (R13 precedes it)", async () => {
    const dir = path.join(tmpRoot, "swap-r13-refusal");
    fs.mkdirSync(dir, { recursive: true });
    const isolatedTranscript = path.join(dir, "wire.jsonl");
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: isolatedTranscript,
      FAKE_RESOLVE_MISSING: undefined,
    });
    let probed = 0;
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            effectiveUid: () => 0,
            swapSupportProbe: (binaryPath: string) => {
              probed += 1;
              return { supported: true, binaryPath };
            },
          }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError && err.code === "matchlock_root_usage_refused",
    );
    assert.equal(probed, 0, "the R13 root gate precedes the swap probe");
    assert.equal(fs.existsSync(isolatedTranscript), false, "no matchlock process on a root refusal");
  });

  it("US-003 parity: the hermes path runs the same swap handshake (refusal taxonomy + supporting persist)", async () => {
    const hermesRoot = path.join(tmpRoot, "swap-hermes");
    fs.mkdirSync(hermesRoot, { recursive: true });
    const hermesSubmission = {
      homeDir: path.join(tmpRoot, "operator"),
      cwd: nonRepoDir,
      hermesHomeEnv: hermesRoot,
    };
    // Unsupported refuses with the same typed code/name before any effect.
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            harness: "hermes",
            submission: hermesSubmission,
            swapSupportProbe: (binaryPath: string) => ({
              supported: false,
              binaryPath,
              reasonCode: "unsupported",
              reason: "no --swap",
            }),
          }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "matchlock_swap_unsupported" &&
        err.message.includes(process.execPath) &&
        /tamandua matchlock setup/.test(err.message),
    );
    // A supporting probe lets the hermes admission proceed and persist.
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: undefined,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_IMAGE_TAG: "vic/hermes:latest",
      FAKE_IMAGE_DIGEST: "sha256:hermesdigest00000000000000000000000000000000000000000000000000000",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:hermesconfig0000000000000000000000000000000000000000000000000000",
      FAKE_RESOLVE_MISSING: undefined,
    });
    let probedCalls = 0;
    const result = await admitMatchlockRun(
      admissionOpts({
        harness: "hermes",
        submission: hermesSubmission,
        swapSupportProbe: (binaryPath: string) => {
          probedCalls += 1;
          return { supported: true, binaryPath };
        },
      }) as never,
    );
    assert.equal(probedCalls, 1, "the hermes path probes exactly once");
    assert.equal(result.policy.harness, "hermes");
    assert.deepEqual(readTranscript(transcript).map((e) => e.method).filter(Boolean), ["resolve_image"]);
  });

  it("US-003: with no injected probe the DEFAULT probe runs against the resolved rpc binary and refuses typed when it is not a swap-capable matchlock", async () => {
    const dir = path.join(tmpRoot, "swap-default-probe");
    fs.mkdirSync(dir, { recursive: true });
    const isolatedTranscript = path.join(dir, "wire.jsonl");
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: isolatedTranscript,
      FAKE_RESOLVE_MISSING: undefined,
    });
    await assert.rejects(
      () =>
        admitMatchlockRun(
          // `swapSupportProbe: undefined` deliberately exercises the production
          // default; the resolved rpc binary here is node (process.execPath),
          // which cannot answer `run --help`, so the default probe refuses.
          admissionOpts({ swapSupportProbe: undefined }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "matchlock_swap_unsupported" &&
        err.message.includes(process.execPath),
    );
    assert.equal(fs.existsSync(isolatedTranscript), false, "the default refusal issues no resolve_image");
  });

  it("refuses a replacement whose freshly resolved image does NOT match the inherited pin (moved tag; never re-pins)", async () => {
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_IMAGE_DIGEST: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const first = await admitMatchlockRun(admissionOpts({}) as never);
    // Now the image MOVED: the store resolves different content.
    setFake({
      FAKE_IMAGE_DIGEST: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    });
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({ inheritedPolicy: first.policy }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "image_identity_mismatch" &&
        /is NOT re-pinned|never re-pins|refusing to relaunch on moved content/.test(err.message),
    );
    const methods = readTranscript(transcript).map((e) => e.method).filter(Boolean);
    assert.deepEqual(methods, ["resolve_image", "resolve_image"]);
  });

  it("a replacement RETAINS the inherited configuration root/profile, guest destination and original authority", async () => {
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const first = await admitMatchlockRun(admissionOpts({ workingDirectory: repoSubdir }) as never);
    const firstConfigRoot = first.policy.configurationRoot;
    // The daemon/env changes afterwards: a different PI_CODING_AGENT_DIR and
    // a different cwd must NOT become the new authority.
    setFake({
      PI_CODING_AGENT_DIR: path.join(tmpRoot, "unrelated-config"),
      FAKE_IMAGE_DIGEST: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    });
    const replacement = await admitMatchlockRun(
      admissionOpts({ inheritedPolicy: first.policy }) as never,
    );
    assert.equal(replacement.policy.configurationRoot, firstConfigRoot);
    assert.equal(replacement.policy.configurationProfile, first.policy.configurationProfile);
    assert.equal(replacement.policy.guestConfigurationRoot, first.policy.guestConfigurationRoot);
    assert.equal(replacement.policy.originalRepositoryRoot, first.policy.originalRepositoryRoot);
    assert.deepEqual(pinFromPolicy(replacement.policy), pinFromPolicy(first.policy));
  });

  // ── MTLK-HERMES-EXEC US-003: hermes opt-in admission ─────────────────

  it("HERMES opt-in: resolves the FROZEN submission selection + image pin (resolve_image ONLY) and returns a harness-hermes v2 policy", async () => {
    transcript = tempTranscriptPath();
    const hermesRoot = path.join(tmpRoot, "hermes-home");
    fs.mkdirSync(hermesRoot, { recursive: true });
    setFake({
      PI_CODING_AGENT_DIR: undefined, // a hermes admission must NOT consult the pi config root
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_IMAGE_TAG: "vic/hermes:latest",
      FAKE_IMAGE_DIGEST: "sha256:hermesdigest00000000000000000000000000000000000000000000000000000",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:hermesconfig0000000000000000000000000000000000000000000000000000",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const result = await admitMatchlockRun(
      admissionOpts({
        harness: "hermes",
        submission: { homeDir: path.join(tmpRoot, "operator"), cwd: nonRepoDir, hermesHomeEnv: hermesRoot },
      }) as never,
    );
    assert.equal(result.policy.version, MATCHLOCK_POLICY_VERSION);
    assert.equal(result.policy.harness, "hermes");
    assert.equal(result.policy.resolvedImageDigest, "sha256:hermesdigest00000000000000000000000000000000000000000000000000000");
    assert.equal(result.policy.configurationRoot, hermesRoot, "canonical host Hermes config root");
    assert.equal(result.policy.configurationProfile, "default");
    assert.equal(result.policy.guestConfigurationRoot, "/workspace/config/hermes");
    assert.deepEqual(result.policy.hermes, {
      homeDir: path.join(tmpRoot, "operator"),
      cwd: nonRepoDir,
      hermesHomeEnv: hermesRoot,
    });
    assert.equal(result.policy.originalRepositoryRoot, null);
    const methods = readTranscript(transcript).map((e) => e.method).filter(Boolean);
    assert.deepEqual(methods, ["resolve_image"], "hermes admission resolves WITHOUT creating a VM");
  });

  it("HERMES opt-in with a NAMED profile (HERMES_HOME under profiles/<name>): the whole profile dir is the admitted root with the profiles guest mapping", async () => {
    transcript = tempTranscriptPath();
    const profilesRoot = path.join(tmpRoot, "hermes-root", "profiles");
    const teamDir = path.join(profilesRoot, "team-a");
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(path.join(teamDir, "config.yaml"),
      "terminal:\n  backend: local\n", "utf-8");
    setFake({
      PI_CODING_AGENT_DIR: undefined,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_IMAGE_TAG: "vic/hermes:latest",
      FAKE_IMAGE_DIGEST: "sha256:hermesdigest00000000000000000000000000000000000000000000000000000",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:hermesconfig0000000000000000000000000000000000000000000000000000",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const result = await admitMatchlockRun(
      admissionOpts({
        harness: "hermes",
        submission: { homeDir: path.join(tmpRoot, "operator"), cwd: nonRepoDir, hermesHomeEnv: teamDir },
      }) as never,
    );
    assert.equal(result.policy.harness, "hermes");
    assert.equal(result.policy.configurationRoot, teamDir, "the named profile dir is the whole-dir mount root");
    assert.equal(result.policy.configurationProfile, "team-a");
    assert.equal(result.policy.guestConfigurationRoot, "/workspace/config/hermes/profiles/team-a");
    assert.equal(result.policy.hermes?.hermesHomeEnv, teamDir);
    const methods = readTranscript(transcript).map((e) => e.method).filter(Boolean);
    assert.deepEqual(methods, ["resolve_image"]);
  });

  it("HERMES opt-in refuses an explicit NON-LOCAL terminal backend BEFORE the image RPC (bounded diagnostics, zero effects)", async () => {
    transcript = tempTranscriptPath();
    const remoteRoot = path.join(tmpRoot, "hermes-remote");
    fs.mkdirSync(remoteRoot, { recursive: true });
    fs.writeFileSync(path.join(remoteRoot, "config.yaml"),
      "terminal:\n  backend: openai\n", "utf-8");
    setFake({
      PI_CODING_AGENT_DIR: undefined,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: undefined,
    });
    await assert.rejects(
      () => admitMatchlockRun(
        admissionOpts({
          harness: "hermes",
          submission: { homeDir: path.join(tmpRoot, "operator"), cwd: nonRepoDir, hermesHomeEnv: remoteRoot },
        }) as never,
      ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "hermes_selection_refused" &&
        /terminal-backend-(remote|unknown)/.test(err.message),
    );
    assert.deepEqual(readTranscript(transcript), [], "refused hermes config must never reach the image RPC");
  });

  it("HERMES opt-in refuses when the FROZEN submission inputs are absent (never resolved from ambient state)", async () => {
    await assert.rejects(
      () => admitMatchlockRun(
        admissionOpts({ harness: "hermes" }) as never,
      ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "hermes_selection_refused" &&
        /FROZEN submission inputs/.test(err.message),
    );
  });

  it("a hermes REPLACEMENT inherits the FROZEN hermes selection + config trio and does NOT re-read ambient HERMES_HOME", async () => {
    transcript = tempTranscriptPath();
    const hermesRoot = path.join(tmpRoot, "hermes-home-inherit");
    fs.mkdirSync(hermesRoot, { recursive: true });
    setFake({
      PI_CODING_AGENT_DIR: undefined,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:hermesdigest00000000000000000000000000000000000000000000000000000",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:hermesconfig0000000000000000000000000000000000000000000000000000",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const first = await admitMatchlockRun(
      admissionOpts({
        harness: "hermes",
        submission: { homeDir: path.join(tmpRoot, "operator"), cwd: nonRepoDir, hermesHomeEnv: hermesRoot },
      }) as never,
    );
    // Ambient state changes afterwards: a different HERMES_HOME must NOT
    // retarget the inherited selection.
    setFake({
      HERMES_HOME: path.join(tmpRoot, "unrelated-hermes"),
      FAKE_IMAGE_DIGEST: "sha256:hermesdigest00000000000000000000000000000000000000000000000000000",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:hermesconfig0000000000000000000000000000000000000000000000000000",
    });
    const replacement = await admitMatchlockRun(
      admissionOpts({ inheritedPolicy: first.policy }) as never,
    );
    assert.equal(replacement.policy.harness, "hermes");
    assert.equal(replacement.policy.configurationRoot, hermesRoot);
    assert.equal(replacement.policy.guestConfigurationRoot, "/workspace/config/hermes");
    assert.deepEqual(replacement.policy.hermes, first.policy.hermes);
    assert.deepEqual(pinFromPolicy(replacement.policy), pinFromPolicy(first.policy));
    const methods = readTranscript(transcript).map((e) => e.method).filter(Boolean);
    assert.deepEqual(methods, ["resolve_image", "resolve_image"]);
  });

  // ── MTLK-DSH-EXEC US-002: harness "dsh" submission persistence ────────

  function dshSubmission(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      homeDir: path.join(tmpRoot, "home"),
      env: {},
      cwd: nonRepoDir,
      ...over,
    };
  }

  function admissionOptsDsh(over: Record<string, unknown>): Record<string, unknown> {
    const base = admissionOpts(over);
    return {
      ...base,
      harness: "dsh",
      // A caller-supplied submission wins; otherwise fall back to the default
      // (never overwrite an explicit frozen submission context).
      submission: base.submission !== undefined ? base.submission : dshSubmission(),
    };
  }

  it("dsh DEFAULT submission (<home>/.dsh) persists a pinned harness-dsh policy with the frozen context, headless profile and /workspace/config/dsh", async () => {
    const homeDir = path.join(tmpRoot, "home");
    const dshHome = path.join(homeDir, ".dsh");
    fs.mkdirSync(dshHome, { recursive: true });
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: path.join(tmpRoot, "ignored-for-dsh"),
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:fakedigest",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:fakeconfigdigest",
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: undefined,
      FAKE_IMAGE_PATH: undefined,
    });
    const result = await admitMatchlockRun(admissionOptsDsh({}) as never);
    const policy = result.policy;
    assert.equal(policy.harness, "dsh");
    assert.equal(policy.configurationRoot, dshHome);
    assert.equal(policy.configurationProfile, "headless");
    assert.equal(policy.guestConfigurationRoot, "/workspace/config/dsh");
    assert.equal(policy.submissionHomeDir, homeDir);
    assert.equal(policy.submissionCwd, nonRepoDir);
    assert.equal(policy.submissionDshHomeEnv, null);
    assert.equal(policy.submissionDshHomeSource, "default");
    assert.equal(policy.imagePath, undefined, "no image PATH declared => none persisted");
    // Zero create frames; only the owned resolve.
    const methods = readTranscript(transcript).map((e) => e.method).filter(Boolean);
    assert.deepEqual(methods, ["resolve_image"]);
  });

  it("dsh explicit/relative/tilde DSH_HOME resolves from the FROZEN submission cwd/home and persists the env selection", async () => {
    const homeDir = path.join(tmpRoot, "home2");
    const cwd = path.join(tmpRoot, "cwd2");
    fs.mkdirSync(path.join(cwd, "rel-dsh"), { recursive: true }); // relative DSH_HOME target
    fs.mkdirSync(path.join(homeDir, "tilde-dsh"), { recursive: true }); // ~/tilde-dsh target
    fs.mkdirSync(path.join(tmpRoot, "abs-dsh"), { recursive: true });
    transcript = tempTranscriptPath();
    setFake({
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: undefined,
      FAKE_IMAGE_DIGEST: "sha256:fakedigest",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:fakeconfigdigest",
    });
    // Relative against captured cwd.
    const rel = await admitMatchlockRun(
      admissionOptsDsh({
        harness: "dsh",
        submission: { homeDir, env: { DSH_HOME: "rel-dsh" }, cwd },
      }) as never,
    );
    assert.equal(rel.policy.configurationRoot, path.join(cwd, "rel-dsh"));
    assert.equal(rel.policy.submissionDshHomeEnv, "rel-dsh");
    assert.equal(rel.policy.submissionDshHomeSource, "env");
    // ~ expansion against captured home.
    const tilde = await admitMatchlockRun(
      admissionOptsDsh({
        harness: "dsh",
        submission: { homeDir, env: { DSH_HOME: "~/tilde-dsh" }, cwd },
      }) as never,
    );
    assert.equal(tilde.policy.configurationRoot, path.join(homeDir, "tilde-dsh"));
    // Whitespace-only DSH_HOME is treated as UNSET (default <home>/.dsh).
    fs.mkdirSync(path.join(homeDir, ".dsh"), { recursive: true });
    const blank = await admitMatchlockRun(
      admissionOptsDsh({
        harness: "dsh",
        submission: { homeDir, env: { DSH_HOME: "   " }, cwd },
      }) as never,
    );
    assert.equal(blank.policy.configurationRoot, path.join(homeDir, ".dsh"));
    assert.equal(blank.policy.submissionDshHomeSource, "default");
    assert.equal(blank.policy.submissionDshHomeEnv, null);
    const methods = readTranscript(transcript).map((e) => e.method).filter(Boolean);
    assert.deepEqual(methods, ["resolve_image", "resolve_image", "resolve_image"]);
  });

  it("dsh admission persists the image's declared PATH from the pinned config (helper-pack prepend base at dispatch)", async () => {
    const homeDir = path.join(tmpRoot, "home3");
    const dshHome = path.join(homeDir, ".dsh");
    fs.mkdirSync(dshHome, { recursive: true });
    transcript = tempTranscriptPath();
    setFake({
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: undefined,
      FAKE_IMAGE_DIGEST: "sha256:fakedigest",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:fakeconfigdigest",
      FAKE_IMAGE_PATH: "/custom/dsh/bin:/usr/local/bin:/usr/bin:/bin",
    });
    const result = await admitMatchlockRun(admissionOptsDsh({}) as never);
    assert.equal(result.policy.imagePath, "/custom/dsh/bin:/usr/local/bin:/usr/bin:/bin");
  });

  it("dsh REFUSAL: a missing/non-directory selected DSH_HOME refuses loudly BEFORE any RPC/VM/native effect", async () => {
    transcript = tempTranscriptPath();
    const missing = path.join(tmpRoot, "missing-dsh-home");
    setFake({ FAKE_TRANSCRIPT_FILE: transcript });
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOptsDsh({
            harness: "dsh",
            submission: { homeDir: path.join(tmpRoot, "home"), env: { DSH_HOME: missing }, cwd: nonRepoDir },
          }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "guest_configuration_incompatible" &&
        /existing DIRECTORY/.test(err.message),
    );
    assert.deepEqual(readTranscript(transcript), [], "no RPC child may be spawned for a config refusal");
  });

  it("dsh REFUSAL: a broad host source (wholesale home) or live admin state can never be the selected DSH_HOME", async () => {
    transcript = tempTranscriptPath();
    const homeDir = path.join(tmpRoot, "home4");
    fs.mkdirSync(homeDir, { recursive: true });
    setFake({ FAKE_TRANSCRIPT_FILE: transcript });
    // Wholesale home as DSH_HOME (admission ctx pins the home).
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOptsDsh({
            harness: "dsh",
            submission: { homeDir, env: { DSH_HOME: homeDir }, cwd: nonRepoDir },
            admission: { home: homeDir, liveStateRoot: path.join(homeDir, ".tamandua") },
          }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "mount_policy_rejected" &&
        /Refusing to mount broad host source/.test(err.message),
    );
    // Administrative .tamandua state as DSH_HOME.
    const live = path.join(homeDir, ".tamandua");
    fs.mkdirSync(path.join(live, "sub"), { recursive: true });
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOptsDsh({
            harness: "dsh",
            submission: { homeDir, env: { DSH_HOME: path.join(live, "sub") }, cwd: nonRepoDir },
            admission: { home: homeDir, liveStateRoot: live },
          }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "mount_policy_rejected",
    );
    assert.deepEqual(readTranscript(transcript), [], "no RPC for broad/admin DSH_HOME refusals");
  });

  it("dsh REFUSAL: missing frozen submission context (no daemon rediscovery allowed)", async () => {
    transcript = tempTranscriptPath();
    setFake({ FAKE_TRANSCRIPT_FILE: transcript });
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            harness: "dsh",
            submission: undefined,
          }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "dsh_submission_context_required" &&
        /FROZEN submission context/.test(err.message),
    );
    assert.deepEqual(readTranscript(transcript), []);
  });

  it("dsh replacement RETAINS the inherited frozen context and resolved DSH_HOME even when a different submission/home now applies", async () => {
    transcript = tempTranscriptPath();
    const homeDir = path.join(tmpRoot, "home5");
    const dshHome = path.join(homeDir, ".dsh");
    fs.mkdirSync(dshHome, { recursive: true });
    setFake({
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: undefined,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      FAKE_IMAGE_PATH: "/opt/dsh/bin:/usr/bin:/bin",
    });
    const first = await admitMatchlockRun(
      admissionOptsDsh({
        harness: "dsh",
        submission: { homeDir, env: {}, cwd: nonRepoDir },
      }) as never,
    );
    // A moved submission (different HOME / explicit DSH_HOME) must NOT
    // re-resolve the effective home of the replacement.
    setFake({ PI_CODING_AGENT_DIR: undefined });
    const replacement = await admitMatchlockRun(
      admissionOptsDsh({
        harness: "dsh",
        submission: { homeDir: path.join(tmpRoot, "unrelated-home"), env: { DSH_HOME: "/elsewhere" }, cwd: path.join(tmpRoot, "elsewhere") },
        inheritedPolicy: first.policy,
      }) as never,
    );
    assert.equal(replacement.policy.configurationRoot, dshHome);
    assert.equal(replacement.policy.submissionHomeDir, homeDir);
    assert.equal(replacement.policy.submissionDshHomeSource, "default");
    assert.equal(replacement.policy.imagePath, "/opt/dsh/bin:/usr/bin:/bin", "image PATH stays pinned");
    assert.deepEqual(pinFromPolicy(replacement.policy), pinFromPolicy(first.policy));
  });
  // ── US-008 exact linked-worktree path integration ──────────────────────

  it("admits a REAL linked worktree at its EXACT path plus the ENTIRE original repository, and mounts both RW at identical host/guest paths", async () => {
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:aaaa000000000000000000000000000000000000000000000000000000000000",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:bbbb000000000000000000000000000000000000000000000000000000000000",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const result = await admitMatchlockRun(
      admissionOpts({
        workspaceMode: "worktree",
        workingDirectory: linkedWorktree,
        worktreeOriginRepository: repoDir,
      }) as never,
    );
    // Exact cwd: the managed linked worktree itself, same host/guest spelling.
    assert.equal(result.policy.workingDirectory, linkedWorktree);
    assert.equal(result.policy.workMounts.length, 1);
    assert.equal(result.policy.workMounts[0].hostPath, linkedWorktree);
    assert.equal(result.policy.workMounts[0].guestPath, linkedWorktree);
    // The ENTIRE original repository is admitted at its exact path.
    assert.equal(result.policy.originalRepositoryRoot, repoDir);
    // Git metadata nested under the original is covered by the repo mount (no
    // clone/relocation, no duplicate roots).
    assert.deepEqual(result.policy.gitMetadataRoots, []);

    const helperPack = path.join(tmpRoot, "guest-pack");
    fs.mkdirSync(helperPack, { recursive: true });
    const cfg = buildMatchlockCreateConfig(result.policy, result.identity, {
      helperPackHostPath: helperPack,
    });
    const mounts = cfg.vfs?.mounts ?? {};
    assert.equal(mounts[linkedWorktree]?.host_path, linkedWorktree);
    assert.equal(mounts[linkedWorktree]?.readonly, false);
    assert.equal(mounts[repoDir]?.host_path, repoDir);
    assert.equal(mounts[repoDir]?.readonly, false);
    // The worktree's `.git` file resolves into the mounted original metadata.
    const dotGit = fs.readFileSync(path.join(linkedWorktree, ".git"), "utf-8").trim();
    assert.match(dotGit, /^gitdir:/);
    const gitDir = path.resolve(linkedWorktree, dotGit.slice("gitdir:".length).trim());
    assert.ok(gitDir.startsWith(repoDir + path.sep), `gitdir ${gitDir} must live under the mounted original`);
  });

  it("admits a separate-git-dir checkout with its EXTERNAL git/common dir at its own exact absolute path RW", async () => {
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:cccc000000000000000000000000000000000000000000000000000000000000",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:dddd000000000000000000000000000000000000000000000000000000000000",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const result = await admitMatchlockRun(
      admissionOpts({ workingDirectory: sgdCheckout }) as never,
    );
    assert.equal(result.policy.workingDirectory, sgdCheckout);
    assert.equal(result.policy.originalRepositoryRoot, sgdCheckout);
    // The external Git/common dir is a required separate RW root at its exact
    // absolute path — never dropped as redundant, never relocated.
    assert.ok(
      result.policy.gitMetadataRoots.includes(sgdGitDir),
      `external git metadata root ${sgdGitDir} must be admitted (got ${JSON.stringify(result.policy.gitMetadataRoots)})`,
    );
    const helperPack = path.join(tmpRoot, "guest-pack-2");
    fs.mkdirSync(helperPack, { recursive: true });
    const cfg = buildMatchlockCreateConfig(result.policy, result.identity, {
      helperPackHostPath: helperPack,
    });
    const mounts = cfg.vfs?.mounts ?? {};
    assert.equal(mounts[sgdCheckout]?.host_path, sgdCheckout);
    assert.equal(mounts[sgdGitDir]?.host_path, sgdGitDir);
    assert.equal(mounts[sgdGitDir]?.readonly, false);
  });

  it("refuses a worktree working directory that is not a git worktree before any image resolve", async () => {
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: undefined,
    });
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({ workspaceMode: "worktree", workingDirectory: nonRepoDir }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "mount_policy_rejected" &&
        /does not resolve to a git worktree/.test(err.message),
    );
    assert.deepEqual(readTranscript(transcript), []);
  });

  it("refuses a SYMLINK worktree spelling (no symlink-only relocated cwd) before any image resolve", async () => {
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: undefined,
    });
    const alias = path.join(tmpRoot, "wt-alias");
    fs.symlinkSync(linkedWorktree, alias);
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({ workspaceMode: "worktree", workingDirectory: alias }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "mount_policy_rejected" &&
        /is a symlink/.test(err.message),
    );
    assert.deepEqual(readTranscript(transcript), []);
  });

  // ── MTLK-ALLOW-PRIVATE: per-run private-destination exceptions ─────────
  //
  // Admission is the ONE persistence point for the operator-resolved
  // allow-private list: a FRESH opt-in records it as `networkAllowPrivate` on
  // the returned/persisted policy (pi, dsh and hermes alike) and a rugpull
  // replacement RETAINS the inherited policy's list — never the daemon
  // environment, never a newly supplied list.

  function allowPrivateFakes(over: Record<string, string | undefined> = {}): void {
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      FAKE_RESOLVE_MISSING: undefined,
      ...over,
    });
  }

  /**
   * US-008: a deterministic supporting probe so allow-private admissions never
   * need a real matchlock binary. It echoes back the resolved rpc binary path.
   */
  const supportingAllowPrivateProbe: MatchlockAllowPrivateSupportProbe = (binaryPath) => ({
    supported: true,
    binaryPath,
  });

  it("ALLOW-PRIVATE pi: a FRESH admission persists the normalized list on the pinned policy (resolve-only)", async () => {
    transcript = tempTranscriptPath();
    allowPrivateFakes();
    const result = await admitMatchlockRun(
      admissionOpts({
        allowPrivate: ["  192.168.107.74:8888  ", "registry.internal", "192.168.107.74:8888", "10.0.0.0/8"],
        allowPrivateSupportProbe: supportingAllowPrivateProbe,
      }) as never,
    );
    assert.deepEqual(
      result.policy.networkAllowPrivate,
      ["192.168.107.74:8888", "registry.internal", "10.0.0.0/8"],
      "trimmed, blank-free, deduped first-seen order",
    );
    // Round-trip through the serializer the caller persists with.
    const reparsed = parseMatchlockPolicy(serializeMatchlockPolicy(result.policy));
    assert.deepEqual(reparsed.networkAllowPrivate, result.policy.networkAllowPrivate);
    assert.equal(reparsed.networkPolicyVersion, 2);
    // The dispatch-side create params map the PERSISTED policy list (the
    // controller reads `runs.matchlock_policy`, never the daemon environment).
    const helperPack = path.join(tmpRoot, "ap-guest-pack");
    fs.mkdirSync(helperPack, { recursive: true });
    const cfg = buildMatchlockCreateConfig(reparsed, result.identity, { helperPackHostPath: helperPack });
    assert.deepEqual(cfg.network.allow_private, ["192.168.107.74:8888", "registry.internal", "10.0.0.0/8"]);
    assert.equal(cfg.network.block_private_ips, true);
    // Still resolve-only: allow-private never triggers a create.
    assert.deepEqual(readTranscript(transcript).map((e) => e.method).filter(Boolean), ["resolve_image"]);
  });

  it("ALLOW-PRIVATE dsh: a FRESH admission persists the list on the harness-dsh policy", async () => {
    const homeDir = path.join(tmpRoot, "ap-home");
    fs.mkdirSync(path.join(homeDir, ".dsh"), { recursive: true });
    transcript = tempTranscriptPath();
    setFake({
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: undefined,
      FAKE_IMAGE_TAG: "vic/ml:latest",
      FAKE_IMAGE_DIGEST: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    const result = await admitMatchlockRun(
      admissionOptsDsh({
        harness: "dsh",
        submission: { homeDir, env: {}, cwd: nonRepoDir },
        allowPrivate: ["[2001:db8::1]:443", "metadata.internal"],
        allowPrivateSupportProbe: supportingAllowPrivateProbe,
      }) as never,
    );
    assert.equal(result.policy.harness, "dsh");
    assert.deepEqual(result.policy.networkAllowPrivate, ["[2001:db8::1]:443", "metadata.internal"]);
    assert.deepEqual(readTranscript(transcript).map((e) => e.method).filter(Boolean), ["resolve_image"]);
  });

  it("ALLOW-PRIVATE hermes: a FRESH admission persists the list on the harness-hermes policy", async () => {
    const hermesRoot = path.join(tmpRoot, "ap-hermes");
    fs.mkdirSync(hermesRoot, { recursive: true });
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: undefined,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_IMAGE_TAG: "vic/hermes:latest",
      FAKE_IMAGE_DIGEST: "sha256:hermesdigest00000000000000000000000000000000000000000000000000000",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:hermesconfig0000000000000000000000000000000000000000000000000000",
      FAKE_RESOLVE_MISSING: undefined,
    });
    const result = await admitMatchlockRun(
      admissionOpts({
        harness: "hermes",
        submission: { homeDir: path.join(tmpRoot, "operator"), cwd: nonRepoDir, hermesHomeEnv: hermesRoot },
        allowPrivate: ["192.168.107.74:8888"],
        allowPrivateSupportProbe: supportingAllowPrivateProbe,
      }) as never,
    );
    assert.equal(result.policy.harness, "hermes");
    assert.deepEqual(result.policy.networkAllowPrivate, ["192.168.107.74:8888"]);
    assert.deepEqual(readTranscript(transcript).map((e) => e.method).filter(Boolean), ["resolve_image"]);
  });

  it("ALLOW-PRIVATE replacement: the INHERITED policy list wins over a newly supplied list and env is never consulted", async () => {
    transcript = tempTranscriptPath();
    allowPrivateFakes();
    const first = await admitMatchlockRun(
      admissionOpts({
        allowPrivate: ["192.168.107.74:8888"],
        allowPrivateSupportProbe: supportingAllowPrivateProbe,
      }) as never,
    );
    // A moved environment and a DIFFERENT supplied list must not retarget the
    // replacement: the persisted policy list is authoritative.
    process.env.TAMANDUA_MATCHLOCK_ALLOW_PRIVATE = "10.9.9.9:1234";
    try {
      const replacement = await admitMatchlockRun(
        admissionOpts({
          inheritedPolicy: first.policy,
          allowPrivate: ["10.9.9.9:1234", "elsewhere.internal"],
          allowPrivateSupportProbe: supportingAllowPrivateProbe,
        }) as never,
      );
      assert.deepEqual(
        replacement.policy.networkAllowPrivate,
        ["192.168.107.74:8888"],
        "a rugpull replacement retains the failed run's admitted exceptions",
      );
    } finally {
      delete process.env.TAMANDUA_MATCHLOCK_ALLOW_PRIVATE;
    }
    assert.deepEqual(readTranscript(transcript).map((e) => e.method).filter(Boolean), ["resolve_image", "resolve_image"]);
  });

  it("ALLOW-PRIVATE absent/empty: no support probe runs and the persisted policy has no networkAllowPrivate key", async () => {
    transcript = tempTranscriptPath();
    allowPrivateFakes();
    let probeCalls = 0;
    const neverProbe: MatchlockAllowPrivateSupportProbe = () => {
      probeCalls += 1;
      throw new Error("the allow-private support probe must not run for an empty list");
    };
    const absent = await admitMatchlockRun(
      admissionOpts({ allowPrivateSupportProbe: neverProbe }) as never,
    );
    const empty = await admitMatchlockRun(
      admissionOpts({ allowPrivate: [], allowPrivateSupportProbe: neverProbe }) as never,
    );
    assert.equal(probeCalls, 0, "an absent/empty list must never probe the installed binary");
    assert.equal("networkAllowPrivate" in absent.policy, false);
    assert.equal("networkAllowPrivate" in empty.policy, false);
    assert.deepEqual(
      readTranscript(transcript).map((e) => e.method).filter(Boolean),
      ["resolve_image", "resolve_image"],
      "empty/absent allow-private admission stays resolve-only and byte-identical",
    );
  });

  it("ALLOW-PRIVATE invalid entry refuses the admission BEFORE any RPC effect", async () => {
    const dir = path.join(tmpRoot, "ap-invalid");
    fs.mkdirSync(dir, { recursive: true });
    const isolatedTranscript = path.join(dir, "wire.jsonl");
    // Point the fake at a transcript in an isolated dir but do NOT create it:
    // a refusal before any RPC leaves it non-existent.
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: isolatedTranscript,
      FAKE_RESOLVE_MISSING: undefined,
    });
    await assert.rejects(
      () => admitMatchlockRun(admissionOpts({ allowPrivate: ["host:0"] }) as never),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "policy_invalid_record" &&
        /invalid allow-private entry/.test(err.message),
    );
    assert.equal(fs.existsSync(isolatedTranscript), false, "no RPC child may be spawned for an invalid entry");
  });

  // ── MTLK-ALLOW-PRIVATE US-008: fail closed when matchlock lacks the flag ──

  it("ALLOW-PRIVATE unsupported (pi): a non-empty list on a matchlock without --allow-private refuses with matchlock_allow_private_unsupported and writes NO policy", async () => {
    const dir = path.join(tmpRoot, "ap-unsupported");
    fs.mkdirSync(dir, { recursive: true });
    const isolatedTranscript = path.join(dir, "wire.jsonl");
    // Point the fake at a transcript in an isolated dir but do NOT create it:
    // the refusal precedes every RPC/create effect.
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: isolatedTranscript,
      FAKE_RESOLVE_MISSING: undefined,
    });
    const requested = ["192.168.107.74:8888", "registry.internal"];
    let probedBinary: string | undefined;
    let probedCalls = 0;
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            allowPrivate: requested,
            allowPrivateSupportProbe: (binaryPath: string) => {
              probedBinary = binaryPath;
              probedCalls += 1;
              return {
                supported: false,
                binaryPath,
                version: "0.1.0",
                reasonCode: "unsupported",
                reason: '"matchlock run --help" does not list --allow-private',
              };
            },
          }) as never,
        ),
      (err: unknown) => {
        if (!(err instanceof MatchlockAdmissionError)) return false;
        assert.equal(err.code, "matchlock_allow_private_unsupported");
        // Names the resolved binary and EVERY requested entry.
        assert.ok(err.message.includes(process.execPath), `names the binary: ${err.message}`);
        for (const entry of requested) {
          assert.ok(err.message.includes(entry), `names the requested entry ${entry}: ${err.message}`);
        }
        // Actionable remedies: upgrade matchlock or drop the flag/env.
        assert.match(err.message, /upgrade matchlock/i);
        assert.match(err.message, /--matchlock-allow-private/);
        assert.match(err.message, /TAMANDUA_MATCHLOCK_ALLOW_PRIVATE/);
        return true;
      },
    );
    assert.equal(probedCalls, 1, "the support probe runs exactly once");
    assert.equal(probedBinary, process.execPath, "the probe runs against the resolved rpc binary");
    assert.equal(fs.existsSync(isolatedTranscript), false, "no RPC child may be spawned when the probe refuses");
  });

  it("ALLOW-PRIVATE missing binary (hermes): the uniform matchlock_unavailable taxonomy fires for a missing binary", async () => {
    const hermesRoot = path.join(tmpRoot, "ap-hermes-unsupported");
    fs.mkdirSync(hermesRoot, { recursive: true });
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            harness: "hermes",
            submission: { homeDir: path.join(tmpRoot, "operator"), cwd: nonRepoDir, hermesHomeEnv: hermesRoot },
            allowPrivate: ["registry.internal"],
            allowPrivateSupportProbe: () => ({
              supported: false,
              binaryPath: "fake-matchlock",
              reasonCode: "missing_binary",
            }),
          }) as never,
        ),
      // MTLK-ISO2-CORRECTIVE (F6): a missing binary keeps the SAME
      // matchlock_unavailable taxonomy regardless of the allow-private list.
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "matchlock_unavailable",
    );
  });

  it("ALLOW-PRIVATE unsupported: a throwing probe fails closed with the same typed refusal", async () => {
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            allowPrivate: ["192.168.107.74:8888"],
            allowPrivateSupportProbe: () => {
              throw new Error("probe exploded");
            },
          }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "matchlock_allow_private_unsupported" &&
        /probe exploded/.test(err.message),
    );
  });

  it("ALLOW-PRIVATE supported: a supporting probe persists the list and admission stays resolve-only", async () => {
    transcript = tempTranscriptPath();
    allowPrivateFakes();
    let probedBinary: string | undefined;
    const result = await admitMatchlockRun(
      admissionOpts({
        allowPrivate: ["192.168.107.74:8888", "box.internal"],
        allowPrivateSupportProbe: (binaryPath: string) => {
          probedBinary = binaryPath;
          return { supported: true, binaryPath, version: "9.9.9" };
        },
      }) as never,
    );
    assert.equal(probedBinary, process.execPath, "the probe runs against the resolved rpc binary");
    assert.deepEqual(result.policy.networkAllowPrivate, ["192.168.107.74:8888", "box.internal"]);
    assert.deepEqual(readTranscript(transcript).map((e) => e.method).filter(Boolean), ["resolve_image"]);
  });

  // ── MTLK-ISO2-CORRECTIVE F6: crossed allow-private × missing/unsupported ──

  it("F6: allow-private × MISSING swap binary reports matchlock_unavailable and never runs the flag probe", async () => {
    let flagProbeCalls = 0;
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            allowPrivate: ["registry.internal"],
            swapSupportProbe: (binaryPath: string) => ({
              supported: false,
              binaryPath,
              reasonCode: "missing_binary",
              reason: `not found: ${binaryPath}`,
            }),
            allowPrivateSupportProbe: () => {
              flagProbeCalls += 1;
              return { supported: true, binaryPath: "x" };
            },
          }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError && err.code === "matchlock_unavailable",
    );
    assert.equal(flagProbeCalls, 0, "the swap handshake precedes the flag probe");
  });

  it("F6: allow-private × UNSUPPORTED swap binary reports matchlock_swap_unsupported and never runs the flag probe", async () => {
    let flagProbeCalls = 0;
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            allowPrivate: ["registry.internal"],
            swapSupportProbe: (binaryPath: string) => ({
              supported: false,
              binaryPath,
              reasonCode: "unsupported",
            }),
            allowPrivateSupportProbe: () => {
              flagProbeCalls += 1;
              return { supported: true, binaryPath: "x" };
            },
          }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError && err.code === "matchlock_swap_unsupported",
    );
    assert.equal(flagProbeCalls, 0, "the swap handshake precedes the flag probe");
  });

  it("F6: NO allow-private × MISSING swap binary reports the SAME matchlock_unavailable taxonomy", async () => {
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            swapSupportProbe: (binaryPath: string) => ({
              supported: false,
              binaryPath,
              reasonCode: "missing_binary",
            }),
          }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError && err.code === "matchlock_unavailable",
    );
  });

  it("F6: NO allow-private × UNSUPPORTED swap binary reports the SAME matchlock_swap_unsupported taxonomy", async () => {
    await assert.rejects(
      () =>
        admitMatchlockRun(
          admissionOpts({
            swapSupportProbe: (binaryPath: string) => ({
              supported: false,
              binaryPath,
              reasonCode: "unsupported",
            }),
          }) as never,
        ),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError && err.code === "matchlock_swap_unsupported",
    );
  });

  it("F6: a default-PATH lookup passes the resolved ABSOLUTE path into the swap AND flag leaf probes", async () => {
    const fakeDir = path.join(tmpRoot, "f6-default-path");
    fs.mkdirSync(fakeDir, { recursive: true });
    const fakeMatchlock = path.join(fakeDir, "matchlock");
    fs.writeFileSync(fakeMatchlock, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const savedBin = process.env[MATCHLOCK_RPC_BIN_ENV];
    const savedPath = process.env.PATH;
    delete process.env[MATCHLOCK_RPC_BIN_ENV];
    process.env.PATH = `${fakeDir}${path.delimiter}${savedPath ?? ""}`;
    try {
      let swapProbePath: string | undefined;
      let flagProbePath: string | undefined;
      await assert.rejects(
        () =>
          admitMatchlockRun(
            admissionOpts({
              rpcBinaryPath: undefined,
              allowPrivate: ["registry.internal"],
              swapSupportProbe: (binaryPath: string) => {
                swapProbePath = binaryPath;
                return { supported: true, binaryPath };
              },
              allowPrivateSupportProbe: (binaryPath: string) => {
                flagProbePath = binaryPath;
                return { supported: false, binaryPath, reasonCode: "unsupported", reason: "no flag" };
              },
            }) as never,
          ),
        (err: unknown) =>
          err instanceof MatchlockAdmissionError &&
          err.code === "matchlock_allow_private_unsupported",
      );
      assert.equal(swapProbePath, fakeMatchlock, "the swap leaf probe receives the absolute resolved path");
      assert.equal(flagProbePath, fakeMatchlock, "the flag leaf probe receives the SAME absolute path");
      assert.ok(path.isAbsolute(swapProbePath as string), "never the bare name `matchlock`");
    } finally {
      if (savedBin === undefined) delete process.env[MATCHLOCK_RPC_BIN_ENV];
      else process.env[MATCHLOCK_RPC_BIN_ENV] = savedBin;
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });
});
