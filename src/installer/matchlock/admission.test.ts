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
  pinFromPolicy,
} from "../../../dist/installer/matchlock/admission.js";
import { serializeMatchlockPolicy } from "../../../dist/installer/matchlock/policy.js";
import { buildMatchlockCreateConfig } from "../../../dist/installer/matchlock/mount-plan.js";
import { writeFakeRpcDriver, tempTranscriptPath } from "../../../dist/installer/matchlock/fake-rpc-driver.js";

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

  function admissionOpts(over: Record<string, unknown>): Record<string, unknown> {
    return {
      requestedImage: "vic/ml:latest",
      workspaceMode: "direct",
      workingDirectory: nonRepoDir,
      rpcBinaryPath: process.execPath,
      rpcArgs: [fakeDriver],
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
    assert.equal(result.policy.version, 2);
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
    assert.deepEqual(result.policy.resourceLimits, { cpus: 4, memoryMB: 4096, diskSizeMB: 20480 });
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
      { cpus: 4, memoryMB: 4096, diskSizeMB: 20480 },
      "a rugpull replacement retains the failed run's admitted VM size",
    );
    assert.equal(replacement.policy.requestedImage, fresh.policy.requestedImage);
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

  it("refuses when the image cannot be resolved (resolve_image error) — honest refusal, no create", async () => {
    transcript = tempTranscriptPath();
    setFake({
      PI_CODING_AGENT_DIR: configRoot,
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: "1",
    });
    await assert.rejects(
      () => admitMatchlockRun(admissionOpts({}) as never),
      (err: unknown) =>
        err instanceof MatchlockAdmissionError &&
        err.code === "image_unusable" &&
        /could not resolve image/.test(err.message),
    );
    const methods = readTranscript(transcript).map((e) => e.method).filter(Boolean);
    assert.deepEqual(methods, ["resolve_image"]);
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
    assert.equal(result.policy.version, 2);
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

});
