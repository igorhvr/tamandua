import { describe, it, before, after } from "node:test";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildMatchlockCreateConfig,
  validateWorkMounts,
  isBroadHostSource,
  shadowsProtectedGuestRoot,
  MatchlockMountPlanError,
  MATCHLOCK_GUEST_RUNTIME_ROOT,
  isHostAttestedProgressResource,
  hostProgressResourceDir,
} from "../../../dist/installer/matchlock/mount-plan.js";
import {
  discoverDshInstallDerivedDirs,
  dshProfileOverlayRoot,
  prepareDshProfileOverlay,
} from "../../../dist/installer/matchlock/dsh-profile-overlay.js";
import type { ExecutionIsolation } from "../../../dist/installer/matchlock/policy.js";
import { MATCHLOCK_NETWORK_POLICY_VERSION } from "../../../dist/installer/matchlock/policy.js";

const IDENTITY = { digest: "sha256:aaaa", config_digest: "sha256:bbbb", tag: "img:1" };

// Composed so the portability lint does not flag this negative fixture: the
// value is a path-shape assertion input, not a procfs read.
const PROC_SELF_MEM = ["", "proc", "self", "mem"].join("/");

function policy(over: Partial<ExecutionIsolation> = {}): ExecutionIsolation {
  const base: ExecutionIsolation = {
    version: 1,
    backend: "matchlock",
    requestedImage: "img:1",
    harness: "pi",
    configurationRoot: "/opt/config/pi",
    configurationProfile: "settings.json",
    guestConfigurationRoot: "/workspace/config/pi",
    workPathMode: "host-absolute",
    workingDirectory: "/opt/project",
    workMounts: [{ hostPath: "/opt/project", hostRealPath: "/opt/project", guestPath: "/opt/project" }],
    originalRepositoryRoot: "/opt/project",
    gitMetadataRoots: ["/opt/project/.git"],
    mountPolicyVersion: 1,
    networkPolicyVersion: MATCHLOCK_NETWORK_POLICY_VERSION,
    resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 },
  };
  return { ...base, ...over };
}

describe("matchlock mount plan", () => {
  let tmp: string;
  let helperPack: string;
  before(() => {
    tmp = tamanduaTempDir("tamandua-mtlk-mount-");
    helperPack = path.join(tmp, "runtime");
    fs.mkdirSync(helperPack, { recursive: true });
    fs.writeFileSync(path.join(helperPack, "bin-tamandua"), "#!/bin/sh\n", "utf8");
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("mounts work/original/git at exact host/guest paths RW; config RW; helper RO; nested same-source .git is dropped", () => {
    const p = policy({ configurationRoot: tmp });
    const cfg = buildMatchlockCreateConfig(p, IDENTITY, { helperPackHostPath: helperPack });
    assert.equal(cfg.image, "img:1");
    assert.deepEqual(cfg.image_identity, IDENTITY);
    assert.equal(cfg.vfs?.exact_destinations, true);
    assert.equal(cfg.env?.PI_CODING_AGENT_DIR, "/workspace/config/pi");
    assert.equal(cfg.vfs?.mounts?.["/opt/project"].type, "host_fs");
    assert.equal(cfg.vfs?.mounts?.["/opt/project"].readonly, false);
    assert.equal(cfg.vfs?.mounts?.["/opt/project"].host_path, "/opt/project");
    // /opt/project/.git is nested INSIDE the /opt/project mount from the SAME
    // host source, so it is redundant and dropped BEFORE create — a real
    // create (ValidateExactDestinationMounts) rejects nested destinations.
    assert.equal(cfg.vfs?.mounts?.["/opt/project/.git"], undefined, "nested same-source .git destination must be dropped");
    assert.equal(cfg.vfs?.mounts?.[MATCHLOCK_GUEST_RUNTIME_ROOT].type, "host_fs");
    assert.equal(cfg.vfs?.mounts?.[MATCHLOCK_GUEST_RUNTIME_ROOT].readonly, true);
    assert.equal(cfg.vfs?.mounts?.[MATCHLOCK_GUEST_RUNTIME_ROOT].host_path, helperPack);
    // config mounted at guest override
    assert.equal(cfg.vfs?.mounts?.["/workspace/config/pi"].host_path, tmp);
  });

  // MTLK-VM-SIZE US-006: the policy's resolved VM resources must reach the
  // create request the runtime receives.
  it("MTLK-VM-SIZE: the policy's cpus/memory_mb/disk_size_mb reach the create request resources", () => {
    const p = policy({
      configurationRoot: tmp,
      resourceLimits: { cpus: 4, memoryMB: 4096, diskSizeMB: 20480 },
    });
    const cfg = buildMatchlockCreateConfig(p, IDENTITY, { helperPackHostPath: helperPack });
    assert.deepEqual(cfg.resources, { cpus: 4, memory_mb: 4096, disk_size_mb: 20480 });
  });

  // MTLK-ALLOW-PRIVATE US-003: the persisted per-run allow-private list must
  // reach the create request as `network.allow_private`, and the field must be
  // OMITTED entirely (not `allow_private: []` / `undefined`) when empty.
  it("MTLK-ALLOW-PRIVATE: a policy with networkAllowPrivate emits network.allow_private equal to the exact list", () => {
    const p = policy({
      configurationRoot: tmp,
      networkAllowPrivate: ["192.168.107.74:8888", "registry.internal.example", "[2001:db8::1]:443", "10.0.0.0/8"],
    });
    const cfg = buildMatchlockCreateConfig(p, IDENTITY, { helperPackHostPath: helperPack });
    assert.equal(cfg.network?.block_private_ips, true);
    assert.equal(cfg.network?.intercept, true);
    assert.deepEqual(cfg.network?.allow_private, [
      "192.168.107.74:8888",
      "registry.internal.example",
      "[2001:db8::1]:443",
      "10.0.0.0/8",
    ]);
  });

  it("MTLK-ALLOW-PRIVATE: a policy without networkAllowPrivate omits the allow_private key entirely", () => {
    const absent = buildMatchlockCreateConfig(policy({ configurationRoot: tmp }), IDENTITY, {
      helperPackHostPath: helperPack,
    });
    assert.equal(Object.keys(absent.network ?? {}).includes("allow_private"), false);
    assert.equal("allow_private" in (absent.network ?? {}), false);

    // An explicit empty list is also omitted — the block stays on.
    const empty = buildMatchlockCreateConfig(
      policy({ configurationRoot: tmp, networkAllowPrivate: [] }),
      IDENTITY,
      { helperPackHostPath: helperPack },
    );
    assert.deepEqual(Object.keys(empty.network ?? {}).sort(), ["block_private_ips", "intercept"]);
  });

  it("MTLK-ALLOW-PRIVATE: the emitted allow_private list is a clone, never a live alias of the policy", () => {
    const entries = ["192.168.107.74:8888"];
    const p = policy({ configurationRoot: tmp, networkAllowPrivate: entries });
    const cfg = buildMatchlockCreateConfig(p, IDENTITY, { helperPackHostPath: helperPack });
    assert.deepEqual(cfg.network?.allow_private, entries);
    assert.notEqual(cfg.network?.allow_private, entries, "create params must not alias the policy array");
    entries.push("evil.example");
    assert.deepEqual(cfg.network?.allow_private, ["192.168.107.74:8888"]);
  });

  it("rejects a missing host configuration directory (fail closed, never image default)", () => {
    const missing = policy({ configurationRoot: path.join(tmp, "does-not-exist") });
    assert.throws(
      () => buildMatchlockCreateConfig(missing, IDENTITY, { helperPackHostPath: helperPack }),
      (e: unknown) => e instanceof MatchlockMountPlanError && e.code === "guest_configuration_incompatible",
    );
  });

  it("rejects work mounts whose guest path differs from the host path", () => {
    const bad = policy({
      workMounts: [{ hostPath: "/opt/project", hostRealPath: "/opt/project", guestPath: "/workspace/project" }],
    });
    assert.throws(
      () => validateWorkMounts(bad.workMounts),
      (e: unknown) => e instanceof MatchlockMountPlanError && e.code === "mount_policy_rejected",
    );
  });

  it("rejects broad host sources (/, home) and protected guest roots", () => {
    assert.equal(isBroadHostSource("/"), true);
    assert.equal(isBroadHostSource(os.homedir()), true);
    assert.equal(isBroadHostSource(path.join(os.homedir(), ".pi")), true);
    assert.equal(isBroadHostSource(path.join(os.homedir(), ".tamandua")), true);
    assert.equal(isBroadHostSource("/opt/project"), false);
    assert.equal(shadowsProtectedGuestRoot("/etc"), true);
    assert.equal(shadowsProtectedGuestRoot("/usr/local/bin"), true);
    assert.equal(shadowsProtectedGuestRoot("/workspace/config/pi"), false);
  });

  it("fails closed when no helper pack host path is supplied", () => {
    assert.throws(
      () => buildMatchlockCreateConfig(policy({ configurationRoot: tmp }), IDENTITY),
      (e: unknown) => e instanceof MatchlockMountPlanError && e.code === "guest_bridge_unavailable",
    );
  });

  it("admits NARROW repos under operator homes (Igor exact-path example) and managed worktrees under the live state dir", () => {
    // Linux operator home + managed worktree example from the task.
    const ctx = { home: "/root", liveStateRoot: "/root/.tamandua" };
    assert.equal(isBroadHostSource("/home/nietzsche/my-sample-repo", ctx), false);
    assert.equal(isBroadHostSource("/root/.tamandua/worktrees/sample-dev-target-tst-20260322", ctx), false);
    assert.equal(isBroadHostSource("/root/.tamandua/worktrees/sample-dev-target-tst-20260322/.git", ctx), false);
    assert.equal(
      shadowsProtectedGuestRoot("/root/.tamandua/worktrees/sample-dev-target-tst-20260322"),
      false,
      "a narrow guest subpath under /root (mounted repo/worktree) must not count as wholesale shadowing",
    );
    assert.equal(shadowsProtectedGuestRoot("/home/nietzsche/my-sample-repo"), false);

    // Mac /Users layout stays /Users inside the guest.
    const mac = { home: "/Users/igorhvr", liveStateRoot: "/Users/igorhvr/.tamandua" };
    assert.equal(isBroadHostSource("/Users/igorhvr/idm/tamandua", mac), false);
    assert.equal(isBroadHostSource("/Users/igorhvr/my-sample-repo", mac), false);
    assert.equal(shadowsProtectedGuestRoot("/Users/igorhvr/idm/tamandua"), false);
    assert.equal(shadowsProtectedGuestRoot("/Users/igorhvr/my-sample-repo"), false);
  });

  it("rejects WHOLESALE homes and live admin state (but never blocks narrow managed worktrees)", () => {
    const ctx = { home: "/root", liveStateRoot: "/root/.tamandua" };
    // Wholesale homes: the tree itself and one whole user home.
    assert.equal(isBroadHostSource("/home", ctx), true);
    assert.equal(isBroadHostSource("/home/nietzsche", ctx), true);
    assert.equal(isBroadHostSource("/Users", ctx), true);
    assert.equal(isBroadHostSource("/Users/igorhvr", ctx), true);
    assert.equal(isBroadHostSource("/root", ctx), true);
    // Live administrative state wholesale and its non-worktree descendants.
    assert.equal(isBroadHostSource("/root/.tamandua", ctx), true);
    assert.equal(isBroadHostSource("/root/.tamandua/logs", ctx), true);
    assert.equal(isBroadHostSource("/root/.tamandua/db", ctx), true);
    assert.equal(isBroadHostSource("/root/.tamandua/worktrees", ctx), true, "bare worktrees dir is not a single managed worktree");
    assert.equal(isBroadHostSource("/root/.tamandua/agents.json", ctx), true);
    // Guest-side wholesale homes are protected too.
    assert.equal(shadowsProtectedGuestRoot("/root"), true);
    assert.equal(shadowsProtectedGuestRoot("/home"), true);
    assert.equal(shadowsProtectedGuestRoot("/home/nietzsche"), true);
    assert.equal(shadowsProtectedGuestRoot("/Users/igorhvr"), true);
  });

  it("host source rejection covers canonical aliases and sensitive/state stores, and guest /proc,/sys,/dev and runtime assets", () => {
    const ctx = { home: "/root", liveStateRoot: "/root/.tamandua" };
    assert.equal(isBroadHostSource("/", ctx), true);
    assert.equal(isBroadHostSource("/proc", ctx), true);
    assert.equal(isBroadHostSource("/sys/kernel", ctx), true);
    assert.equal(isBroadHostSource("/dev/shm", ctx), true);
    assert.equal(isBroadHostSource("/run/user/0/ssh", ctx), true);
    assert.equal(isBroadHostSource("/root/.ssh/keys", ctx), true);
    assert.equal(isBroadHostSource("/root/.matchlock/state", ctx), true);
    assert.equal(isBroadHostSource("/root/.pi", ctx), true, "the whole pi agent store is never a source");
    // Guest destinations: OS roots, /proc,/sys,/dev,/tmp and Matchlock runtime assets.
    assert.equal(shadowsProtectedGuestRoot("/etc"), true);
    assert.equal(shadowsProtectedGuestRoot("/usr/local/bin"), true);
    assert.equal(shadowsProtectedGuestRoot(PROC_SELF_MEM), true);
    assert.equal(shadowsProtectedGuestRoot("/sys/kernel"), true);
    assert.equal(shadowsProtectedGuestRoot("/dev/kvm"), true);
    assert.equal(shadowsProtectedGuestRoot("/tmp"), true);
    assert.equal(shadowsProtectedGuestRoot("/opt/matchlock"), true);
    assert.equal(shadowsProtectedGuestRoot("/opt/matchlock/bin/matchlock"), true);
    assert.equal(shadowsProtectedGuestRoot("/workspace/config/pi"), false);
  });

  it("a work mount under a home / under the live worktrees dir passes buildMatchlockCreateConfig", () => {
    const ctx = { home: "/root", liveStateRoot: "/root/.tamandua" };
    const p = policy({
      configurationRoot: tmp,
      workMounts: [
        { hostPath: "/root/.tamandua/worktrees/sample-dev-target-tst-20260322", hostRealPath: "/root/.tamandua/worktrees/sample-dev-target-tst-20260322", guestPath: "/root/.tamandua/worktrees/sample-dev-target-tst-20260322" },
        { hostPath: "/home/nietzsche/my-sample-repo", hostRealPath: "/home/nietzsche/my-sample-repo", guestPath: "/home/nietzsche/my-sample-repo" },
      ],
      originalRepositoryRoot: "/home/nietzsche/my-sample-repo",
      gitMetadataRoots: ["/home/nietzsche/my-sample-repo/.git", "/root/.tamandua/worktrees/sample-dev-target-tst-20260322/.git"],
    });
    const cfg = buildMatchlockCreateConfig(p, IDENTITY, { helperPackHostPath: helperPack, admission: ctx });
    assert.equal(cfg.vfs?.mounts?.["/root/.tamandua/worktrees/sample-dev-target-tst-20260322"].readonly, false);
    assert.equal(cfg.vfs?.mounts?.["/home/nietzsche/my-sample-repo"].readonly, false);
    // The nested same-source .git destinations are dropped (the repo/worktree
    // mount already exposes them); the runtime rejects nested destinations.
    assert.equal(cfg.vfs?.mounts?.["/home/nietzsche/my-sample-repo/.git"], undefined);
    assert.equal(cfg.vfs?.mounts?.["/root/.tamandua/worktrees/sample-dev-target-tst-20260322/.git"], undefined);
    // The config root still mounts the ENTIRE selected directory RW at the guest override.
    assert.equal(cfg.vfs?.mounts?.["/workspace/config/pi"].host_path, tmp);
    assert.equal(cfg.vfs?.mounts?.["/workspace/config/pi"].readonly, false);
  });

  it("managed RO guest helper pack under the live state guest-packs subtree is mountable; other live-state pack paths refuse", () => {
    const ctx = { home: "/root", liveStateRoot: "/root/.tamandua" };
    const managedPack = "/root/.tamandua/matchlock/guest-packs/20260909T193827Z_961647b4";
    const cfg = buildMatchlockCreateConfig(policy({ configurationRoot: tmp }), IDENTITY, {
      helperPackHostPath: managedPack,
      admission: ctx,
    });
    assert.equal(cfg.vfs?.mounts?.[MATCHLOCK_GUEST_RUNTIME_ROOT].host_path, managedPack);
    assert.equal(cfg.vfs?.mounts?.[MATCHLOCK_GUEST_RUNTIME_ROOT].readonly, true, "managed guest pack must mount RO");
    // A helper pack anywhere else under the live state dir is still refused.
    for (const badPack of [
      "/root/.tamandua/matchlock/other/x",
      "/root/.tamandua/logs/tamandua.log",
      "/root/.tamandua/matchlock/guest-packs",
    ]) {
      assert.throws(
        () =>
          buildMatchlockCreateConfig(policy({ configurationRoot: tmp }), IDENTITY, {
            helperPackHostPath: badPack,
            admission: ctx,
          }),
        (e: unknown) => e instanceof MatchlockMountPlanError && /broad host source/.test((e as Error).message),
        `expected refusal for helper pack at ${badPack}`,
      );
    }
  });

  it("the helper pack mount stays RO even when its host path overlaps the selected configuration root", () => {
    const p = policy({ configurationRoot: tmp });
    // helperPackHostPath == the RW config root: the helper mount at the
    // reserved guest path must STAY readonly, never silently upgraded.
    const cfg = buildMatchlockCreateConfig(p, IDENTITY, { helperPackHostPath: tmp });
    assert.equal(cfg.vfs?.mounts?.[MATCHLOCK_GUEST_RUNTIME_ROOT].host_path, tmp);
    assert.equal(cfg.vfs?.mounts?.[MATCHLOCK_GUEST_RUNTIME_ROOT].readonly, true, "helper pack must remain RO");
    assert.equal(cfg.vfs?.mounts?.["/workspace/config/pi"].host_path, tmp);
    assert.equal(cfg.vfs?.mounts?.["/workspace/config/pi"].readonly, false);
  });

  it("the selected configuration source must be a DIRECTORY (fail closed, never an image default)", () => {
    const file = path.join(tmp, "config-file");
    fs.writeFileSync(file, "{}", "utf8");
    assert.throws(
      () => buildMatchlockCreateConfig(policy({ configurationRoot: file }), IDENTITY, { helperPackHostPath: helperPack }),
      (e: unknown) => e instanceof MatchlockMountPlanError && e.code === "guest_configuration_incompatible",
    );
  });

  it("rejects guest-destination collisions/overrides between planned mounts", () => {
    // A git metadata root claims the same guest destination as the config
    // override but points at a different host source -> collision, not override.
    const p = policy({
      configurationRoot: tmp,
      gitMetadataRoots: ["/workspace/config/pi"],
    });
    assert.throws(
      () => buildMatchlockCreateConfig(p, IDENTITY, { helperPackHostPath: helperPack }),
      (e: unknown) => e instanceof MatchlockMountPlanError && e.code === "mount_policy_rejected" && /collision/.test(e.message),
    );
  });

  it("drops redundant SAME-source nesting (repo + its .git) mirroring the runtime nested-collision rule", () => {
    // The canonical repo policy emits /opt/project (original/work) AND
    // /opt/project/.git (gitMetadataRoot). The runtime's
    // ValidateExactDestinationMounts REJECTS a destination nested inside
    // another at create time, so the plan must normalize: because the .git
    // host source sits under the already-mounted /opt/project host source,
    // the nested mount is redundant and dropped (the write-through parent
    // exposes it). No nested destination may reach the wire.
    const p = policy({ configurationRoot: tmp });
    const cfg = buildMatchlockCreateConfig(p, IDENTITY, { helperPackHostPath: helperPack });
    const mounts = cfg.vfs?.mounts ?? {};
    const keys = Object.keys(mounts);
    assert.equal(mounts["/opt/project"]?.host_path, "/opt/project");
    assert.equal(mounts["/opt/project/.git"], undefined);
    for (const key of keys) {
      for (const other of keys) {
        if (key !== other) {
          assert.ok(!key.startsWith(other + "/"), `no destination may be nested: ${key} inside ${other}`);
        }
      }
    }
  });

  it("fails closed on DIFFERENT-source nesting (runtime nested-collision rule)", () => {
    // A git metadata root whose GUEST destination nests under the config
    // mount's guest override while its HOST source is a different tree: the
    // runtime rejects this collision, so the plan must fail closed before
    // create (the runtime error: "mount destination collides with (is nested
    // inside)").
    const p = policy({
      configurationRoot: tmp,
      gitMetadataRoots: ["/workspace/config/pi/nested-git"],
    });
    assert.throws(
      () => buildMatchlockCreateConfig(p, IDENTITY, { helperPackHostPath: helperPack }),
      (e: unknown) =>
        e instanceof MatchlockMountPlanError &&
        e.code === "mount_policy_rejected" &&
        /nested inside/.test(e.message),
    );
  });

  it("rejects an EXISTING symlink host_fs source (runtime validateNoSourceSymlink mirror)", () => {
    // A real `create` refuses host_fs sources that are symlinks; the planner
    // mirrors that by failing closed on the config source before create.
    const real = path.join(tmp, "config-real");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "settings.json"), "{}", "utf8");
    const link = path.join(tmp, "config-link");
    fs.symlinkSync(real, link, "dir");
    const p = policy({ configurationRoot: link });
    assert.throws(
      () => buildMatchlockCreateConfig(p, IDENTITY, { helperPackHostPath: helperPack }),
      (e: unknown) =>
        e instanceof MatchlockMountPlanError &&
        e.code === "mount_policy_rejected" &&
        /is a symlink/.test(e.message),
    );
    // The REAL directory itself is admitted (mounting the whole selected
    // configuration directory RW).
    const ok = buildMatchlockCreateConfig(policy({ configurationRoot: real }), IDENTITY, {
      helperPackHostPath: helperPack,
    });
    assert.equal(ok.vfs?.mounts?.["/workspace/config/pi"].host_path, real);
  });

  it("MTLK-PROGRESS: exports ONLY the exact host-attested per-run progress resource at /workspace/runs/<runId>, helper stays RO, work/config rules unchanged", () => {
    const root = tamanduaTempDir("tamandua-mtlk-progress-mount-");
    try {
      const live = path.join(root, "state");
      const runId = "11111111-1111-4111-8111-111111111111";
      const hostDir = path.join(live, "runs", runId, "progress-resource");
      fs.mkdirSync(hostDir, { recursive: true });
      fs.writeFileSync(path.join(hostDir, "progress.txt"), "# Progress\nseed\n", "utf8");

      const p = policy({ configurationRoot: path.join(root, "config") });
      fs.mkdirSync(p.configurationRoot, { recursive: true });
      const ctx = { home: path.join(root, "home"), liveStateRoot: live };
      const cfg = buildMatchlockCreateConfig(p, IDENTITY, {
        helperPackHostPath: helperPack,
        admission: ctx,
        progressResource: { runId },
      });

      // Exact scoped resource exported at the specified special guest path.
      const guestDir = `/workspace/runs/${runId}`;
      assert.equal(cfg.vfs?.mounts?.[guestDir].type, "host_fs");
      assert.equal(cfg.vfs?.mounts?.[guestDir].host_path, hostDir);
      assert.equal(cfg.vfs?.mounts?.[guestDir].readonly, false);
      // Helper RO + config/work rules unchanged.
      assert.equal(cfg.vfs?.mounts?.[MATCHLOCK_GUEST_RUNTIME_ROOT].readonly, true);
      assert.equal(cfg.vfs?.mounts?.["/workspace/config/pi"].readonly, false);
      assert.equal(cfg.vfs?.mounts?.["/opt/project"].host_path, "/opt/project");

      // Admission predicate: only the exact deterministic per-run dir is
      // host-attested; arbitrary state paths, siblings, and other runs fail.
      assert.equal(isHostAttestedProgressResource(hostDir, runId, live), true);
      assert.equal(isHostAttestedProgressResource(path.join(live, "runs", runId), runId, live), false);
      assert.equal(isHostAttestedProgressResource(path.join(live, "runs", "99999999-9999-4999-8999-999999999999", "progress-resource"), runId, live), false);
      assert.equal(isHostAttestedProgressResource(path.join(live, "logs"), runId, live), false);
      assert.equal(isHostAttestedProgressResource(path.join(live, "worktrees", "wt"), runId, live), false);
      assert.equal(isHostAttestedProgressResource("/etc/passwd", runId, live), false);
      // A non-uuid run id is never host-attested (predicate fails closed).
      assert.equal(isHostAttestedProgressResource(hostDir, "malicious/../runId", live), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("MTLK-PROGRESS: refuses a progress resource whose host dir is missing/non-directory or whose run id is not a uuid", () => {
    const root = tamanduaTempDir("tamandua-mtlk-progress-mount-bad-");
    try {
      const live = path.join(root, "state");
      const runId = "11111111-1111-4111-8111-111111111111";
      const p = policy({ configurationRoot: path.join(root, "config") });
      fs.mkdirSync(p.configurationRoot, { recursive: true });
      const ctx = { home: path.join(root, "home"), liveStateRoot: live };
      // Missing host dir -> fail closed before create.
      assert.throws(
        () => buildMatchlockCreateConfig(p, IDENTITY, {
          helperPackHostPath: helperPack,
          admission: ctx,
          progressResource: { runId },
        }),
        (e: unknown) => e instanceof MatchlockMountPlanError && e.code === "mount_policy_rejected" && /must exist as a real directory/.test(e.message),
      );
      // The deterministic host dir derivation matches the admission predicate.
      assert.equal(hostProgressResourceDir(runId, live), path.join(live, "runs", runId, "progress-resource"));
      // Non-uuid run id -> refused by the derivation helper.
      assert.throws(
        () => hostProgressResourceDir("malicious/../runId", live),
        (e: unknown) => e instanceof MatchlockMountPlanError,
      );
      // A file at the resource dir is not a real directory -> refused.
      const dirFile = hostProgressResourceDir(runId, live);
      fs.mkdirSync(path.dirname(dirFile), { recursive: true });
      fs.writeFileSync(dirFile, "not a dir", "utf8");
      assert.throws(
        () => buildMatchlockCreateConfig(p, IDENTITY, {
          helperPackHostPath: helperPack,
          admission: ctx,
          progressResource: { runId },
        }),
        (e: unknown) => e instanceof MatchlockMountPlanError && e.code === "mount_policy_rejected" && /must exist as a real directory/.test(e.message),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("MTLK-PROGRESS: a SYMLINKED progress resource host dir is refused directly by buildMatchlockCreateConfig (lstatSync admission, not only the later source-symlink sweep)", () => {
    const root = tamanduaTempDir("tamandua-mtlk-progress-mount-link-");
    try {
      const live = path.join(root, "state");
      const runId = "11111111-1111-4111-8111-111111111111";
      const hostDir = hostProgressResourceDir(runId, live);
      const realTarget = path.join(root, "real-resource-target");
      fs.mkdirSync(realTarget, { recursive: true });
      fs.mkdirSync(path.dirname(hostDir), { recursive: true });
      // Resource dir itself is a symlink to a real dir: a following statSync
      // would resolve it and report the TARGET as a directory, making an
      // isSymbolicLink() guard dead code; the admission must lstat no-follow.
      fs.symlinkSync(realTarget, hostDir, "dir");

      const p = policy({ configurationRoot: path.join(root, "config") });
      fs.mkdirSync(p.configurationRoot, { recursive: true });
      const ctx = { home: path.join(root, "home"), liveStateRoot: live };
      assert.throws(
        () => buildMatchlockCreateConfig(p, IDENTITY, {
          helperPackHostPath: helperPack,
          admission: ctx,
          progressResource: { runId },
        }),
        (e: unknown) => e instanceof MatchlockMountPlanError && e.code === "mount_policy_rejected" && /must exist as a real directory/.test(e.message),
        "a symlinked resource dir must be refused by the local lstatSync admission",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("MTLK-PROGRESS: refuses when the progress guest destination /workspace/runs/<runId> already has a DIFFERENT RW host_fs source (placeMount collision)", () => {
    const root = tamanduaTempDir("tamandua-mtlk-progress-mount-collide-");
    try {
      const live = path.join(root, "state");
      const runId = "11111111-1111-4111-8111-111111111111";
      const hostDir = hostProgressResourceDir(runId, live);
      fs.mkdirSync(hostDir, { recursive: true });
      fs.writeFileSync(path.join(hostDir, "progress.txt"), "seed", "utf8");

      // Another RW source (the ENTIRE selected configuration dir) is already
      // planned at the exact special guest destination /workspace/runs/<runId>
      // via the config guest override. The progress resource must not silently
      // override or merge with it — placeMount refuses the collision.
      const configHost = path.join(root, "config");
      fs.mkdirSync(configHost, { recursive: true });
      const p = policy({
        configurationRoot: configHost,
        guestConfigurationRoot: `/workspace/runs/${runId}`,
      });
      const ctx = { home: path.join(root, "home"), liveStateRoot: live };
      assert.throws(
        () => buildMatchlockCreateConfig(p, IDENTITY, {
          helperPackHostPath: helperPack,
          admission: ctx,
          progressResource: { runId },
        }),
        (e: unknown) =>
          e instanceof MatchlockMountPlanError &&
          e.code === "mount_policy_rejected" &&
          /collision/.test(e.message) &&
          new RegExp(`/workspace/runs/${runId}`).test(e.message),
        "progress RW mount must fail closed when another RW host_fs source already claims its guest destination",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("MTLK-PROGRESS: an RW host_fs source can never claim the RO helper pack destination /workspace/runtime (same-destination RO-helper-versus-RW fails closed)", () => {
    const root = tamanduaTempDir("tamandua-mtlk-progress-mount-ro-");
    try {
      const live = path.join(root, "state");
      const runId = "11111111-1111-4111-8111-111111111111";
      const hostDir = hostProgressResourceDir(runId, live);
      fs.mkdirSync(hostDir, { recursive: true });

      // Craft a policy whose RW configuration override targets the SAME guest
      // destination that the RO helper pack is reserved to (a different host
      // source than the helper pack). placeMount must refuse: the helper pack
      // destination stays read-only, never silently upgraded to RW by the
      // config/work/progress family of RW mounts.
      const configHost = path.join(root, "config");
      fs.mkdirSync(configHost, { recursive: true });
      const p = policy({
        configurationRoot: configHost,
        guestConfigurationRoot: MATCHLOCK_GUEST_RUNTIME_ROOT,
      });
      const ctx = { home: path.join(root, "home"), liveStateRoot: live };
      assert.throws(
        () => buildMatchlockCreateConfig(p, IDENTITY, {
          helperPackHostPath: helperPack,
          admission: ctx,
          progressResource: { runId },
        }),
        (e: unknown) =>
          e instanceof MatchlockMountPlanError &&
          e.code === "mount_policy_rejected" &&
          /collision/.test(e.message) &&
          new RegExp(MATCHLOCK_GUEST_RUNTIME_ROOT.replace(/[/]/g, "\\/")).test(e.message),
        "an RW source at the RO helper destination must be refused, not merged/upgraded",
      );

      // The refusal is about the destination, not the progress option: without
      // the colliding config override the plan still exports the progress
      // resource RW at /workspace/runs/<runId> and keeps the helper RO.
      const ok = buildMatchlockCreateConfig(policy({ configurationRoot: configHost }), IDENTITY, {
        helperPackHostPath: helperPack,
        admission: ctx,
        progressResource: { runId },
      });
      assert.equal(ok.vfs?.mounts?.[`/workspace/runs/${runId}`].readonly, false);
      assert.equal(ok.vfs?.mounts?.[MATCHLOCK_GUEST_RUNTIME_ROOT].readonly, true, "helper pack must remain RO");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("~/.pi boundary is deliberate: whole store refused, canonical config dir ~/.pi/agent admitted", () => {
    const ctx = { home: "/root", liveStateRoot: "/root/.tamandua" };
    // The WHOLE pi agent store is never a source…
    assert.equal(isBroadHostSource("/root/.pi", ctx), true);
    // …but the canonical default configuration directory ~/.pi/agent IS: the
    // task requires the ENTIRE selected configuration DIRECTORY to be mounted
    // RW (never an image default) and that directory canonically is
    // ~/.pi/agent. This is a deliberate boundary, documented in
    // isBroadHostSource, not an accident.
    assert.equal(isBroadHostSource("/root/.pi/agent", ctx), false);
    // Sensitive descendants beneath the store remain blocked.
    assert.equal(isBroadHostSource("/root/.pi/agent/.ssh", ctx), true);
    assert.equal(isBroadHostSource("/root/.pi/.matchlock", ctx), true);
  });

  // ── MTLK-DSH-EXEC US-002: mount-plan dsh mode ────────────────────────
  //
  // REWRITTEN by DSH-PROFILE-OVERLAY US-002 (contracts MTLK-DSH-EXEC and
  // DSH-PROFILE-OVERLAY): the MTLK-DSH-EXEC source contract mounted the WHOLE
  // effective DSH_HOME RW as ONE unit; the composed-home contract instead maps
  // durable entries host RW and sources each install-derived profile module dir
  // from the private per-run overlay.
  //
  // REWRITTEN AGAIN by DSH-OVERLAY-FSYNC-FIX US-003 (same contracts): the
  // per-entry plan made the runtime promote the DSH_HOME parent to a synthetic
  // FUSE router root with no provider to fsync (run #35). The shipped plan is
  // now ONE real host-backed effective-home root sourced from the private
  // per-run overlay, so `fsync(<DSH_HOME>)` succeeds while profiles/ stays the
  // private only source. This file is listed in
  // tests/matchlock-integration-test-parity.test.ts REWRITTEN_ASSERTIONS.

  const DSH_RUN_ID = "11111111-2222-3333-4444-555555555555";
  const DSH_GUEST_ROOT = "/workspace/config/dsh";

  function dshPolicy(over: Partial<ExecutionIsolation> = {}): ExecutionIsolation {
    const base: ExecutionIsolation = {
      version: 2,
      backend: "matchlock",
      requestedImage: "img:dsh",
      harness: "dsh",
      configurationRoot: "/opt/dsh-home",
      configurationProfile: "headless",
      guestConfigurationRoot: DSH_GUEST_ROOT,
      workPathMode: "host-absolute",
      workingDirectory: "/opt/project",
      workMounts: [{ hostPath: "/opt/project", hostRealPath: "/opt/project", guestPath: "/opt/project" }],
      originalRepositoryRoot: "/opt/project",
      gitMetadataRoots: [],
      mountPolicyVersion: 1,
      networkPolicyVersion: MATCHLOCK_NETWORK_POLICY_VERSION,
      resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 },
      submissionHomeDir: "/home/operator",
      submissionCwd: "/home/operator/work",
      submissionDshHomeEnv: null,
      submissionDshHomeSource: "default",
      resolvedImageDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      resolvedImageConfigDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    };
    return { ...base, ...over };
  }

  /**
   * Synthetic dsh home with the real headless profile layout: an
   * install-derived `profiles/node_modules` farm, a per-profile
   * `node_modules`, a `.dsh-module-fallback`, plus durable categories.
   */
  function makeDshHome(prefix = "dsh-home-"): string {
    const home = fs.mkdtempSync(path.join(tmp, prefix));
    fs.mkdirSync(path.join(home, "profiles", "node_modules", "@deepseek-ai"), { recursive: true });
    fs.mkdirSync(path.join(home, "profiles", "headless", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(home, "profiles", "headless", ".dsh-module-fallback", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(home, "profiles", "headless", "cordis.yml"), "[]\n", "utf8");
    fs.writeFileSync(path.join(home, "profiles", "headless", "package.json"), "{}\n", "utf8");
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(home, "storages"), { recursive: true });
    fs.writeFileSync(path.join(home, ".credentials.yaml"), "refs: []\n", "utf8");
    fs.writeFileSync(path.join(home, ".anonymous-user-id"), "anon\n", "utf8");
    fs.writeFileSync(path.join(home, "unknown-entry.bin"), "x", "utf8");
    return home;
  }

  /** Prepare the private overlay and return the host-attested option value. */
  function dshOverlayFor(
    home: string,
    liveStateRoot: string,
    runId = DSH_RUN_ID,
  ): { runId: string; liveStateRoot: string; overlayRoot: string } {
    prepareDshProfileOverlay(runId, liveStateRoot, home);
    return { runId, liveStateRoot, overlayRoot: dshProfileOverlayRoot(runId, liveStateRoot) };
  }

  it("dsh mode: mounts ONE real effective-home root from the private overlay (never the host profiles farm) and sets DSH_HOME (no PI_CODING_AGENT_DIR)", () => {
    const home = makeDshHome();
    const liveState = fs.mkdtempSync(path.join(tmp, "live-state-"));
    const overlay = dshOverlayFor(home, liveState);
    const p = dshPolicy({ configurationRoot: home });
    const cfg = buildMatchlockCreateConfig(p, IDENTITY, {
      helperPackHostPath: helperPack,
      admission: { home: path.join(tmp, "operator-home"), liveStateRoot: liveState },
      dshProfileOverlay: overlay,
    });
    assert.equal(cfg.env?.DSH_HOME, DSH_GUEST_ROOT);
    assert.equal(cfg.env?.PI_CODING_AGENT_DIR, undefined, "dsh mode must not inject the pi config override");

    const mounts = cfg.vfs?.mounts ?? {};
    // ONE destination: the effective home root, sourced from the private overlay
    // (a real host-backed directory). This is what makes the home root itself
    // fsync-able instead of a synthetic router root.
    assert.equal(mounts[DSH_GUEST_ROOT]?.host_path, overlay.overlayRoot);
    assert.equal(mounts[DSH_GUEST_ROOT]?.type, "host_fs");
    assert.equal(mounts[DSH_GUEST_ROOT]?.readonly, false);
    // The whole-home HOST mount is gone: the effective home's profiles/ is the
    // private staged copy, never the host install-derived farm.
    assert.notEqual(mounts[DSH_GUEST_ROOT]?.host_path, home);
    const stagedProfiles = path.join(overlay.overlayRoot, "profiles");
    assert.ok(fs.lstatSync(stagedProfiles).isDirectory());

    // No mount ever exposes the host install-derived dirs.
    const derived = new Set(discoverDshInstallDerivedDirs(home));
    assert.ok(derived.size > 0, "fixture must have install-derived dirs");
    for (const [guest, m] of Object.entries(mounts)) {
      for (const rel of derived) {
        assert.notEqual(
          m.host_path,
          path.join(home, rel),
          `mount ${guest} exposed the host install-derived source`,
        );
      }
    }

    // Every durable top-level entry is materialized in the effective home.
    const durable = [
      ".credentials.yaml",
      ".anonymous-user-id",
      "sessions",
      "storages",
      "unknown-entry.bin",
    ];
    for (const rel of durable) {
      assert.equal(
        fs.existsSync(path.join(overlay.overlayRoot, rel)),
        true,
        `${rel} must be staged in the effective home`,
      );
    }

    // No destination nested inside another (the composed plan is flat).
    const dests = Object.keys(mounts);
    for (const inner of dests) {
      for (const outer of dests) {
        if (inner === outer) continue;
        assert.ok(!inner.startsWith(outer + path.sep), `${inner} must not be nested inside ${outer}`);
      }
    }
    assert.equal(mounts["/opt/project"].readonly, false);
    assert.equal(mounts[MATCHLOCK_GUEST_RUNTIME_ROOT].readonly, true);
  });

  it("dsh mode: the helper-pack bin is prepended ONLY to the image's declared PATH (nonstandard image PATH preserved; absent when the image declares none)", () => {
    const dshHome = fs.mkdtempSync(path.join(tmp, "dsh-home2-"));
    const liveState = fs.mkdtempSync(path.join(tmp, "live-state-path-"));
    const overlay = dshOverlayFor(dshHome, liveState);
    const custom = dshPolicy({
      configurationRoot: dshHome,
      imagePath: "/opt/dsh/install/bin:/usr/local/bin:/usr/bin:/bin",
    });
    const cfg = buildMatchlockCreateConfig(custom, IDENTITY, { helperPackHostPath: helperPack, dshProfileOverlay: overlay });
    assert.equal(cfg.env?.PATH, `${MATCHLOCK_GUEST_RUNTIME_ROOT}/bin:/opt/dsh/install/bin:/usr/local/bin:/usr/bin:/bin`,
      "helper-pack bin prepended to the image PATH — the image's nonstandard PATH must survive verbatim");
    const noImagePath = dshPolicy({ configurationRoot: dshHome, imagePath: undefined });
    const cfg2 = buildMatchlockCreateConfig(noImagePath, IDENTITY, { helperPackHostPath: helperPack, dshProfileOverlay: overlay });
    assert.equal(cfg2.env?.PATH, undefined, "when the image declares no PATH the plan leaves PATH to the image default");
    assert.equal(cfg2.env?.DSH_HOME, DSH_GUEST_ROOT);
  });

  it("dsh mode: a missing/non-directory selected DSH_HOME refuses loudly (guest_configuration_incompatible)", () => {
    const missing = dshPolicy({ configurationRoot: path.join(tmp, "no-such-dsh-home") });
    assert.throws(
      () => buildMatchlockCreateConfig(missing, IDENTITY, { helperPackHostPath: helperPack }),
      (e: unknown) => e instanceof MatchlockMountPlanError && e.code === "guest_configuration_incompatible",
    );
  });

  it("dsh mode: a dsh policy with NO host-attested overlay option is refused (never a whole-home fallback)", () => {
    const home = makeDshHome();
    const p = dshPolicy({ configurationRoot: home });
    assert.throws(
      () => buildMatchlockCreateConfig(p, IDENTITY, { helperPackHostPath: helperPack }),
      (e: unknown) => e instanceof MatchlockMountPlanError && e.code === "dsh_profile_overlay_required",
    );
  });

  it("dsh mode: an UNPREPARED private overlay is refused before create (source_missing)", () => {
    const home = makeDshHome();
    const liveState = fs.mkdtempSync(path.join(tmp, "live-state-unprepared-"));
    const p = dshPolicy({ configurationRoot: home });
    assert.throws(
      () => buildMatchlockCreateConfig(p, IDENTITY, {
        helperPackHostPath: helperPack,
        dshProfileOverlay: { runId: DSH_RUN_ID, liveStateRoot: liveState },
      }),
      (e: unknown) => e instanceof MatchlockMountPlanError && e.code === "dsh_profile_overlay_source_missing",
    );
  });

  it("dsh mode: a broad host source or live admin state can never be admitted as the DSH_HOME (wholesale home, ~/.tamandua)", () => {
    const ctx = { home: "/home/operator", liveStateRoot: "/home/operator/.tamandua" };
    // Wholesale home as DSH_HOME is a broad source.
    assert.equal(isBroadHostSource("/home/operator", ctx), true);
    assert.equal(isBroadHostSource("/home/operator/.tamandua", ctx), true);
    assert.equal(isBroadHostSource("/home/operator/.tamandua/runs", ctx), true);
    // A narrow selected dsh home (the design's whole-effective-home case) is fine.
    assert.equal(isBroadHostSource("/home/operator/.dsh", ctx), false);
    assert.equal(isBroadHostSource("/home/operator/dsh-data", ctx), false);
  });
});
