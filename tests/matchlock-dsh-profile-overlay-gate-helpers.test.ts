/**
 * Fast, deterministic controls for the DSH-PROFILE-OVERLAY US-005 contained
 * profile-overlay regression gate:
 *
 *  - the gate's PURE helpers (`nativeDshBootPlan`, `parseFirstRequestOutput`,
 *    `guestFarmLinksAreGuestInstall`, `snapshotDshInstallDerivedFarms`); and
 *  - the DETERMINISTIC ZERO-PROVIDER fixture itself
 *    (`e2e-tests/dsh-fixture/fake-dsh.mjs`) executed NATIVELY with node: the
 *    native heal rewrites a synthetic host farm to host-install links, and the
 *    first-request probe resolves a module through the private farm and writes
 *    only guest-install links — with NO session/usage, so zero model tokens.
 *
 * No VM, no daemon, no provider, no network: every scratch path comes from
 * `tamanduaTempDir()`. This file imports `node:child_process` (it spawns the
 * fixture) and is therefore classified in the serial lane.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import {
  dshProfileOverlayRoot,
  prepareDshProfileOverlay,
} from "../dist/installer/matchlock/dsh-profile-overlay.js";
import {
  DSH_GATE_BOOT_LOCK_BASENAME,
  DSH_GATE_BOOT_LOCK_HOLD_MARKER,
  DSH_GATE_FIRST_REQUEST_PLUGIN,
  DSH_GATE_GUEST_INSTALL_ROOT,
  DSH_GATE_GUEST_INSTALL_ROOT_ENV,
  DSH_GATE_NATIVE_INSTALL_ROOT_ENV,
  DSH_GATE_NATIVE_HEAL_MARKER,
  DSH_GATE_FIRST_REQUEST_MARKER,
  DSH_GATE_PLACEHOLDER_CREDENTIALS,
  DshOverlayObserver,
  guestFarmLinksAreGuestInstall,
  nativeDshBootPlan,
  parseFirstRequestOutput,
  prepareComposedDshHome,
  snapshotDshFarmLinks,
  snapshotDshInstallDerivedFarms,
  snapshotDshProfilesInvariance,
  snapshotDshTreeFiles,
  snapshotDshTreeLinks,
  stageGateOwnedDshHome,
  stderrCarriesDshBootLockEnoent,
  watchDshProfilesBootLock,
} from "../e2e-tests/helpers/matchlock-dsh-gate-fixtures.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_DSH = path.join(REPO_ROOT, "e2e-tests", "dsh-fixture", "fake-dsh.mjs");

function baseEnv(extra: Record<string, string>): Record<string, string> {
  return {
    HOME: extra.HOME ?? "",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...extra,
  };
}

function sessionCount(dshHome: string): number {
  const sessions = path.join(dshHome, "sessions");
  if (!fs.existsSync(sessions)) return 0;
  let count = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const full = path.join(dir, entry.name);
        walk(full);
        if (entry.name.startsWith("session-")) count += 1;
      }
    }
  };
  walk(sessions);
  return count;
}

describe("matchlock dsh profile-overlay gate helpers (DSH-PROFILE-OVERLAY US-005)", () => {
  let root = "";

  before(() => {
    assert.ok(fs.existsSync(FAKE_DSH), `fixture dsh must exist: ${FAKE_DSH}`);
    root = tamanduaTempDir("mtlk-dsh-profile-overlay-");
  });

  after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* owned scratch */
    }
  });

  it("nativeDshBootPlan builds the marker argv and a credential-free isolated env", () => {
    const plan = nativeDshBootPlan({
      nodePath: "/usr/bin/node",
      fakeDshPath: FAKE_DSH,
      homeDir: path.join(root, "iso-home"),
      dshHome: path.join(root, "synth"),
      hostInstallRoot: path.join(root, "host-install"),
    });
    assert.equal(plan.command, "/usr/bin/node");
    assert.deepEqual(plan.args.slice(0, 2), [FAKE_DSH, "--profile"]);
    assert.ok(plan.args[plan.args.length - 1].includes(DSH_GATE_NATIVE_HEAL_MARKER));
    assert.equal(plan.env.DSH_HOME, path.join(root, "synth"));
    assert.equal(plan.env[DSH_GATE_NATIVE_INSTALL_ROOT_ENV], path.join(root, "host-install"));
    assert.ok(!("DSH_CREDENTIALS" in plan.env));
    assert.equal(plan.timeoutMs, 60_000);
  });

  it("nativeDshBootPlan refuses non-absolute synthetic roots", () => {
    assert.throws(
      () =>
        nativeDshBootPlan({
          nodePath: "/usr/bin/node",
          fakeDshPath: FAKE_DSH,
          homeDir: path.join(root, "iso-home"),
          dshHome: "relative-home",
          hostInstallRoot: path.join(root, "host-install"),
        }),
      /absolute synthetic DSH_HOME/,
    );
    assert.throws(
      () =>
        nativeDshBootPlan({
          nodePath: "/usr/bin/node",
          fakeDshPath: FAKE_DSH,
          homeDir: path.join(root, "iso-home"),
          dshHome: path.join(root, "synth"),
          hostInstallRoot: "relative-install",
        }),
      /absolute SYNTHETIC_DSH_INSTALL_ROOT/,
    );
  });

  it("parseFirstRequestOutput is line-anchored and detects the real request-extension failure", () => {
    assert.deepEqual(parseFirstRequestOutput("FIRST-REQUEST-RESOLVED:x\nSTATUS: done\n"), {
      resolved: true,
      plugin: "x",
      requestExtensionFailure: false,
    });
    // Embedded in a payload: never a success.
    assert.deepEqual(
      parseFirstRequestOutput("diagnostic echo: FIRST-REQUEST-RESOLVED:x"),
      { resolved: false, plugin: null, requestExtensionFailure: false },
    );
    const failed = parseFirstRequestOutput(
      "dsh: REQUEST_EXTENSION: DeepSeek request extension preparation failed: ENOENT",
    );
    assert.equal(failed.resolved, false);
    assert.equal(failed.requestExtensionFailure, true);
  });

  it("guestFarmLinksAreGuestInstall accepts guest-install links only", () => {
    assert.equal(
      guestFarmLinksAreGuestInstall({ "a/x": DSH_GATE_GUEST_INSTALL_ROOT + "/node_modules/x" }),
      true,
    );
    assert.equal(guestFarmLinksAreGuestInstall({ "a/x": "/opt/dsh/x" }), false);
    assert.equal(guestFarmLinksAreGuestInstall({}), false);
  });

  it("snapshotDshTreeFiles records regular files only and snapshotDshProfilesInvariance folds in the lock state", () => {
    const home = path.join(root, "profiles-invariance-home");
    const layout = prepareComposedDshHome(home);
    const profiles = path.join(home, "profiles");
    // A real file, a symlink (never a file), and the transient lock.
    fs.writeFileSync(path.join(profiles, "boot.log"), "x\n", "utf-8");
    assert.ok(
      snapshotDshTreeFiles(profiles).includes("boot.log"),
      "regular files are recorded",
    );
    assert.ok(
      !snapshotDshTreeFiles(profiles).some((f) => f.includes("node_modules") && f.endsWith("commander")),
      "symlinks are never reported as files",
    );

    const before = snapshotDshProfilesInvariance(home);
    assert.equal(before.lockPresent, false, "no host lock before the guest round");
    assert.equal(before.bootMarkerPresent, false, "no host boot marker before the guest round");
    assert.ok(
      before.files.includes(path.join(layout.profile, "package.json")),
      `durable profile config is a host file: ${JSON.stringify(before.files)}`,
    );

    fs.writeFileSync(path.join(profiles, "node_modules.lock"), "", "utf-8");
    const withLock = snapshotDshProfilesInvariance(home);
    assert.equal(withLock.lockPresent, true, "the lock file is detected at the exact sibling path");
    assert.notDeepEqual(withLock, before, "folding in the lock changes the invariance snapshot");
    fs.rmSync(path.join(profiles, "node_modules.lock"), { force: true });
  });

  it("DshOverlayObserver retains a transient boot lock and the durable staged profile config", async () => {
    const overlay = path.join(root, "observed-lock-overlay");
    fs.mkdirSync(path.join(overlay, "profiles", "headless"), { recursive: true });
    fs.writeFileSync(path.join(overlay, "profiles", "headless", "package.json"), "{}\n", "utf-8");

    const observer = new DshOverlayObserver(overlay, { intervalMs: 5 }).start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The real dsh creates the sibling lock `wx`, holds it across the heal,
    // then removes it in withFileLock's finally. The observer must retain the
    // observed path even though the file is gone by stop().
    const lock = path.join(overlay, "profiles", "node_modules.lock");
    fs.writeFileSync(lock, "", "utf-8");
    await new Promise((resolve) => setTimeout(resolve, 40));
    fs.rmSync(lock, { force: true });
    const observed = observer.stop();

    assert.equal(observed.rootSeen, true, "the overlay root is observed while live");
    assert.ok(
      observed.files.includes(path.join("profiles", "node_modules.lock")),
      `the transient boot lock must be retained: ${JSON.stringify(observed.files)}`,
    );
    assert.ok(
      observed.files.includes(path.join("profiles", "headless", "package.json")),
      `the durable staged config must be recorded: ${JSON.stringify(observed.files)}`,
    );
    assert.ok(
      observed.dirs.includes("profiles") && observed.dirs.includes(path.join("profiles", "headless")),
      `the private profiles dir must be recorded: ${JSON.stringify(observed.dirs)}`,
    );
    assert.equal(fs.existsSync(lock), false, "the observer never fabricates a durable lock");
  });

  it("the first-request probe holds the boot sibling lock for the prompt-requested window", async () => {
    const home = path.join(root, "hold-home");
    prepareComposedDshHome(home);
    const lockPath = path.join(home, "profiles", "node_modules.lock");
    const holdMs = 800;
    const child = spawn(
      process.execPath,
      [
        FAKE_DSH,
        "--profile",
        "headless",
        `${DSH_GATE_FIRST_REQUEST_MARKER}: probe ${DSH_GATE_BOOT_LOCK_HOLD_MARKER}:${holdMs}`,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: baseEnv({
          HOME: path.join(root, "iso-home"),
          DSH_HOME: home,
          [DSH_GATE_GUEST_INSTALL_ROOT_ENV]: path.join(root, "hold-guest-install"),
        }),
      },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    let firstSeenAt = -1;
    let lastSeenAt = -1;
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      if (fs.existsSync(lockPath)) {
        const at = Date.now() - started;
        if (firstSeenAt === -1) firstSeenAt = at;
        lastSeenAt = at;
      } else if (firstSeenAt !== -1 || child.exitCode !== null) {
        // Released (or the child exited): stop polling.
        if (firstSeenAt !== -1) break;
        if (child.exitCode !== null) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const exitCode = await closed;
    assert.notEqual(firstSeenAt, -1, `the held boot lock must be observable: ${stderr}`);
    assert.ok(
      lastSeenAt - firstSeenAt >= holdMs - 250,
      `the lock must be held for the requested window (observed ${lastSeenAt - firstSeenAt}ms of ${holdMs}ms)`,
    );
    assert.equal(exitCode, 0, `the held probe must still succeed: ${stderr}`);
    assert.equal(fs.existsSync(lockPath), false, "the probe releases the lock before exit");
  });

  it("snapshotDshInstallDerivedFarms captures nested scope links and ignores real files", () => {
    const home = path.join(root, "snap-home");
    prepareComposedDshHome(home);
    // Native heal writes a scoped, nested link + a real file.
    const scopeDir = path.join(home, "profiles", "node_modules", "@deepseek-ai");
    fs.mkdirSync(scopeDir, { recursive: true });
    fs.symlinkSync("/host-install/node_modules/@deepseek-ai/dsh-base", path.join(scopeDir, "dsh-base"));
    fs.writeFileSync(path.join(home, "profiles", "node_modules", "README"), "not a link\n", "utf-8");

    const snap = snapshotDshInstallDerivedFarms(home, [
      path.join("profiles", "node_modules"),
      path.join("profiles", "headless", "node_modules"),
      path.join("profiles", "headless", ".dsh-module-fallback"),
    ]);
    assert.equal(snap[path.join("profiles", "node_modules", "@deepseek-ai", "dsh-base")], "/host-install/node_modules/@deepseek-ai/dsh-base");
    assert.ok(!Object.keys(snap).some((k) => k.endsWith("README")), "real files are not links");
    assert.deepEqual(snapshotDshInstallDerivedFarms(home, ["profiles/does-not-exist"]), {});
  });

  it("the fixture native heal rewrites the synthetic host farm to host-install links with no session", () => {
    const home = path.join(root, "native-heal-home");
    const layout = prepareComposedDshHome(home);
    const before = snapshotDshInstallDerivedFarms(home, layout.installDerivedDirs);
    assert.ok(
      Object.values(before).some((t) => t.startsWith("/opt/dsh/")),
      "fixture must start with a mismatched /opt/dsh link",
    );

    const hostInstallRoot = path.join(root, "native-heal-install");
    const plan = nativeDshBootPlan({
      nodePath: process.execPath,
      fakeDshPath: FAKE_DSH,
      homeDir: path.join(root, "iso-home"),
      dshHome: home,
      hostInstallRoot,
    });
    const run = spawnSync(plan.command, plan.args, {
      encoding: "utf-8",
      timeout: plan.timeoutMs,
      env: baseEnv(plan.env),
    });
    assert.equal(run.status, 0, `native heal failed: ${run.stderr}`);
    assert.match(run.stdout, /^NATIVE-HEAL: links=\d+ /m);

    const after = snapshotDshInstallDerivedFarms(home, layout.installDerivedDirs);
    assert.notDeepEqual(after, before, "the native heal must retarget the mismatched links");
    assert.equal(
      after[path.join("profiles", "node_modules", "commander")],
      path.join(hostInstallRoot, "node_modules", "commander"),
    );
    assert.ok(
      Object.keys(after).some((k) => k.includes("@deepseek-ai" + path.sep + "dsh-base")),
      `the scoped closure link must be healed: ${JSON.stringify(after)}`,
    );
    for (const [rel, target] of Object.entries(after)) {
      assert.ok(target.startsWith(hostInstallRoot + path.sep), `healed ${rel} -> ${target} must be host-install`);
    }
    assert.equal(sessionCount(home), 0, "the native heal must record NO session (zero tokens)");
  });

  it("the fixture native heal refuses a missing install root and a home without the real headless layout", () => {
    const home = path.join(root, "native-heal-refusals");
    prepareComposedDshHome(home);
    const plan = nativeDshBootPlan({
      nodePath: process.execPath,
      fakeDshPath: FAKE_DSH,
      homeDir: path.join(root, "iso-home"),
      dshHome: home,
      hostInstallRoot: path.join(root, "some-install"),
    });
    // Unset install root: bounded refusal, no farm write.
    const unset = spawnSync(plan.command, plan.args, {
      encoding: "utf-8",
      timeout: plan.timeoutMs,
      env: baseEnv({ ...plan.env, [DSH_GATE_NATIVE_INSTALL_ROOT_ENV]: "" }),
    });
    assert.notEqual(unset.status, 0);
    assert.match(unset.stderr, /native heal requires an absolute/);

    // Missing real headless profile layout: refusal before any farm write.
    const bare = path.join(root, "bare-home");
    fs.mkdirSync(path.join(bare, "profiles", "node_modules"), { recursive: true });
    const missingProfile = spawnSync(plan.command, [
      FAKE_DSH,
      "--profile",
      "headless",
      `${DSH_GATE_NATIVE_HEAL_MARKER}: probe`,
    ], {
      encoding: "utf-8",
      timeout: plan.timeoutMs,
      env: baseEnv({ ...plan.env, DSH_HOME: bare }),
    });
    assert.notEqual(missingProfile.status, 0);
    assert.match(missingProfile.stderr, /headless profile layout missing/);
  });

  it("the fixture first-request probe resolves through the private farm and writes only guest-install links", () => {
    const home = path.join(root, "first-request-home");
    prepareComposedDshHome(home);
    // The real gate's in-VM private overlay starts EMPTY (the mismatched host
    // links live on the unmounted host farm); clear the fixture seeds so this
    // control observes exactly what the guest writes.
    const seededFarm = path.join(home, "profiles", "node_modules");
    for (const name of fs.readdirSync(seededFarm)) {
      fs.rmSync(path.join(seededFarm, name), { recursive: true, force: true });
    }
    const guestInstallRoot = path.join(root, "guest-install");
    const env = baseEnv({
      HOME: path.join(root, "iso-home"),
      DSH_HOME: home,
      [DSH_GATE_GUEST_INSTALL_ROOT_ENV]: guestInstallRoot,
      DSH_TELEMETRY_DISABLED: "1",
    });
    const run = spawnSync(
      process.execPath,
      [FAKE_DSH, "--profile", "headless", `${DSH_GATE_FIRST_REQUEST_MARKER}: probe`],
      { encoding: "utf-8", timeout: 30_000, env },
    );
    assert.equal(run.status, 0, `first-request probe failed: ${run.stderr}`);
    const outcome = parseFirstRequestOutput(run.stdout);
    assert.equal(outcome.resolved, true);
    assert.equal(outcome.plugin, DSH_GATE_FIRST_REQUEST_PLUGIN);
    assert.equal(outcome.requestExtensionFailure, false);

    // The private farm now carries ONLY a guest-install link that RESOLVES.
    const privateFarm = snapshotDshFarmLinks(seededFarm);
    assert.deepEqual(privateFarm, {
      [DSH_GATE_FIRST_REQUEST_PLUGIN]: path.join(guestInstallRoot, "node_modules", DSH_GATE_FIRST_REQUEST_PLUGIN),
    });
    assert.equal(guestFarmLinksAreGuestInstall(privateFarm, guestInstallRoot), true);
    assert.ok(fs.existsSync(fs.realpathSync(path.join(seededFarm, DSH_GATE_FIRST_REQUEST_PLUGIN, "package.json"))));
    assert.equal(sessionCount(home), 0, "the first-request probe must record NO session (zero model tokens)");
  });

  it("the first-request probe creates and removes the real boot sibling lock inside the staged private profiles dir", () => {
    // DSH-PROFILE-OVERLAY US-003: the new composed plan mounts ONE private
    // per-run `profiles/` tree. The probe's real `withFileLock` sibling
    // (`profiles/node_modules.lock`, wx + 0o600) must be creatable there and be
    // released (removed) afterwards, together with the durable sibling marker.
    const hostHome = path.join(root, "us003-staged-host-home");
    prepareComposedDshHome(hostHome);
    const liveState = tamanduaTempDir("mtlk-dsh-us003-lived-");
    const runId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    try {
      prepareDshProfileOverlay(runId, liveState, hostHome);
      const overlayRoot = dshProfileOverlayRoot(runId, liveState);
      const guestInstallRoot = path.join(root, "us003-guest-install");
      const run = spawnSync(
        process.execPath,
        [FAKE_DSH, "--profile", "headless", `${DSH_GATE_FIRST_REQUEST_MARKER}: probe`],
        {
          encoding: "utf-8",
          timeout: 30_000,
          env: baseEnv({
            HOME: path.join(root, "iso-home"),
            DSH_HOME: overlayRoot,
            [DSH_GATE_GUEST_INSTALL_ROOT_ENV]: guestInstallRoot,
          }),
        },
      );
      assert.equal(run.status, 0, `staged-private-profiles probe failed: ${run.stderr}`);
      const outcome = parseFirstRequestOutput(run.stdout);
      assert.equal(outcome.resolved, true);
      assert.equal(outcome.plugin, DSH_GATE_FIRST_REQUEST_PLUGIN);

      const profilesDir = path.join(overlayRoot, "profiles");
      assert.ok(
        fs.existsSync(path.join(profilesDir, "headless", "package.json")),
        "the private profiles dir must carry the staged durable profile config",
      );
      // The probe removed BOTH boot sibling artifacts it created.
      assert.equal(
        fs.existsSync(path.join(profilesDir, "node_modules.lock")),
        false,
        "the exclusive sibling lock must be removed after the probe",
      );
      assert.equal(
        fs.existsSync(path.join(profilesDir, "node_modules.synthetic-boot-marker")),
        false,
        "the durable sibling marker must be removed after the probe",
      );
    } finally {
      fs.rmSync(liveState, { recursive: true, force: true });
    }
  });

  it("the first-request probe fails with the exact node_modules.lock ENOENT shape when the profiles parent is absent (old per-child plan)", () => {
    // DSH-PROFILE-OVERLAY US-003: the old #31 per-child plan supplied the
    // guest an install-derived `profiles/node_modules` farm but never a real
    // writable `profiles/` parent, so dsh's `withFileLock(modulesDir)` died at
    // the SIBLING `<profiles>/node_modules.lock`. Model that guest-visible
    // effect: the old plan's private farm is present, the guest home has no
    // `profiles/` at all, and the probe must reproduce run #32's exact ENOENT.
    const oldPlanFarm = path.join(root, "us003-old-plan-overlay");
    fs.mkdirSync(path.join(oldPlanFarm, "profiles", "node_modules"), { recursive: true });
    assert.ok(
      fs.existsSync(path.join(oldPlanFarm, "profiles", "node_modules")),
      "the old per-child plan's private farm is present",
    );

    const guestHome = path.join(root, "us003-old-plan-guest");
    fs.mkdirSync(guestHome, { recursive: true });
    const lockPath = path.join(guestHome, "profiles", "node_modules.lock");
    const run = spawnSync(
      process.execPath,
      [FAKE_DSH, "--profile", "headless", `${DSH_GATE_FIRST_REQUEST_MARKER}: probe`],
      {
        encoding: "utf-8",
        timeout: 30_000,
        env: baseEnv({ HOME: path.join(root, "iso-home"), DSH_HOME: guestHome }),
      },
    );
    assert.notEqual(run.status, 0, "the probe must fail without a writable profiles parent");
    assert.equal(run.status, 8, `expected the boot-sibling failure exit: ${run.stderr}`);
    assert.ok(
      run.stderr.includes(`Error: ENOENT: no such file or directory, open '${lockPath}'`),
      `stderr must carry the exact production ENOENT shape: ${run.stderr}`,
    );
    assert.equal(parseFirstRequestOutput(run.stdout).resolved, false);
    assert.equal(
      fs.existsSync(path.join(guestHome, "profiles")),
      false,
      "the probe must never fabricate the missing guest profiles parent",
    );
  });

  it("the first-request probe reproduces the REQUEST_EXTENSION failure on a broken farm", () => {
    const home = path.join(root, "broken-farm-home");
    prepareComposedDshHome(home);
    // Make the farm link target un-creatable by pointing the guest install root
    // at an existing FILE, so symlink creation/resolution fails.
    const badRoot = path.join(root, "guest-install-is-a-file");
    fs.writeFileSync(badRoot, "not a directory\n", "utf-8");
    const run = spawnSync(
      process.execPath,
      [FAKE_DSH, "--profile", "headless", `${DSH_GATE_FIRST_REQUEST_MARKER}: probe`],
      {
        encoding: "utf-8",
        timeout: 30_000,
        env: baseEnv({
          HOME: path.join(root, "iso-home"),
          DSH_HOME: home,
          [DSH_GATE_GUEST_INSTALL_ROOT_ENV]: badRoot,
        }),
      },
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /REQUEST_EXTENSION: DeepSeek request extension preparation failed/);
    assert.equal(parseFirstRequestOutput(run.stdout).resolved, false);
  });

  // ── DSH-OVERLAY-LOCK-FIX US-005: real-dsh gate staging + lock watch ──────

  it("stageGateOwnedDshHome copies only durable profile config and never a symlink or credential", () => {
    // A synthetic stand-in for the operator's real dsh home: durable profile
    // config, an install-derived symlink farm, and a SECRET credentials file
    // that must never be read/copied.
    const sourceHome = path.join(root, "us005-source-dsh");
    const profileDir = path.join(sourceHome, "profiles", "headless");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "package.json"),
      '{"name":"dsh-profile-headless","dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]}}}\n',
      "utf-8",
    );
    fs.writeFileSync(path.join(profileDir, "cordis.yml"), "[]\n", "utf-8");
    fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), "[]\n", "utf-8");
    fs.writeFileSync(path.join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\n", "utf-8");
    fs.mkdirSync(path.join(profileDir, "node_modules"), { recursive: true });
    fs.symlinkSync("/opt/dsh/node_modules/undici", path.join(profileDir, "node_modules", "undici"));
    fs.mkdirSync(path.join(profileDir, ".dsh-module-fallback", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(sourceHome, "profiles", "node_modules"), { recursive: true });
    fs.symlinkSync(
      "/opt/dsh/node_modules/commander",
      path.join(sourceHome, "profiles", "node_modules", "commander"),
    );
    fs.mkdirSync(path.join(sourceHome, "sessions", "session-secret"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceHome, ".credentials.yaml"),
      "providers:\n  deepseek:\n    apiKey: REAL-SECRET-MUST-NOT-BE-COPIED\n",
      "utf-8",
    );
    const sourceProfilesBefore = snapshotDshProfilesInvariance(sourceHome);

    const destinationHome = path.join(root, "us005-gate-dsh");
    const layout = stageGateOwnedDshHome({
      sourceHome,
      destinationHome,
    });
    assert.equal(layout.profile, "headless");
    assert.equal(layout.homeDir, destinationHome);

    // Durable config files copied byte-identically.
    for (const file of ["package.json", "cordis.yml", "cordis.patch.yml", "pnpm-workspace.yaml"]) {
      assert.equal(
        fs.readFileSync(path.join(destinationHome, "profiles", "headless", file), "utf-8"),
        fs.readFileSync(path.join(profileDir, file), "utf-8"),
        `${file} must be copied byte-identically`,
      );
      assert.ok(
        layout.durableProfileFiles.includes(path.join("profiles", "headless", file)),
        `layout must record ${file}: ${JSON.stringify(layout.durableProfileFiles)}`,
      );
    }

    // Install-derived dirs exist EMPTY and NO symlink is copied.
    for (const rel of layout.installDerivedDirs) {
      const dir = path.join(destinationHome, rel);
      assert.ok(fs.existsSync(dir) && fs.lstatSync(dir).isDirectory(), `${rel} must be a real dir`);
      assert.equal(fs.readdirSync(dir).length, 0, `${rel} must be empty`);
    }
    assert.deepEqual(
      snapshotDshTreeLinks(path.join(destinationHome, "profiles")),
      {},
      "the staged home must carry no symlink under profiles/",
    );

    // Placeholder credentials, never the source secret; sessions never copied.
    assert.equal(
      fs.readFileSync(path.join(destinationHome, ".credentials.yaml"), "utf-8"),
      DSH_GATE_PLACEHOLDER_CREDENTIALS,
    );
    assert.ok(
      !fs
        .readFileSync(path.join(destinationHome, ".credentials.yaml"), "utf-8")
        .includes("REAL-SECRET-MUST-NOT-BE-COPIED"),
      "the source credentials must never leak into the gate home",
    );
    assert.equal(
      fs.existsSync(path.join(destinationHome, "sessions", "session-secret")),
      false,
      "source sessions are never staged",
    );
    assert.ok(fs.existsSync(path.join(destinationHome, "storages")));

    // The source home is untouched and the staged home is stageable by the
    // production private-overlay planner (a symlinked source entry would be
    // refused, so the empty derived dirs are mandatory).
    assert.deepEqual(snapshotDshProfilesInvariance(sourceHome), sourceProfilesBefore);
    const liveState = tamanduaTempDir("mtlk-us005-lived-");
    try {
      const overlay = prepareDshProfileOverlay(
        "11111111-2222-3333-4444-555555555555",
        liveState,
        destinationHome,
      );
      assert.equal(overlay.profilesStaged, true);
      assert.ok(
        fs.existsSync(path.join(overlay.overlayRoot, "profiles", "headless", "package.json")),
        "the private overlay must carry the staged profile config",
      );
    } finally {
      fs.rmSync(liveState, { recursive: true, force: true });
    }
  });

  it("watchDshProfilesBootLock catches a transient lock created and removed while the round is live", async () => {
    const profiles = path.join(root, "us005-lock-watch-profiles");
    fs.mkdirSync(profiles, { recursive: true });
    const watcher = watchDshProfilesBootLock(profiles, { pollMs: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lock = path.join(profiles, DSH_GATE_BOOT_LOCK_BASENAME);
    // Create + remove within a few ms, exactly like a fast real dsh heal.
    fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    fs.rmSync(lock, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const obs = watcher.stop();

    assert.equal(obs.presentAtStart, false);
    assert.equal(obs.seen, true, `the transient lock must be detected: ${JSON.stringify(obs)}`);
    assert.equal(fs.existsSync(lock), false, "the watcher never fabricates a durable lock");

    // A watch on an already-present lock is recorded without any event.
    fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
    const presentWatcher = watchDshProfilesBootLock(profiles, { pollMs: 50 });
    const presentObs = presentWatcher.stop();
    assert.equal(presentObs.presentAtStart, true);
    assert.equal(presentObs.seen, true);
    fs.rmSync(lock, { force: true });
  });

  it("stderrCarriesDshBootLockEnoent matches only the exact run-#32 lock shape", () => {
    const profiles = path.join(root, "us005-iso-profiles");
    const lockPath = path.join(profiles, DSH_GATE_BOOT_LOCK_BASENAME);
    assert.equal(
      stderrCarriesDshBootLockEnoent(
        `Error: ENOENT: no such file or directory, open '${lockPath}'`,
        profiles,
      ),
      true,
    );
    assert.equal(
      stderrCarriesDshBootLockEnoent(
        "Error: ENOENT: no such file or directory, open '/workspace/config/dsh/profiles/node_modules.lock'",
      ),
      true,
    );
    assert.equal(stderrCarriesDshBootLockEnoent("dsh: provider auth failed (401)"), false);
    assert.equal(
      stderrCarriesDshBootLockEnoent(
        "Error: ENOENT: no such file or directory, open '/workspace/config/dsh/profiles/headless/node_modules'",
      ),
      false,
      "an unrelated ENOENT is not the lock failure",
    );
  });
});
