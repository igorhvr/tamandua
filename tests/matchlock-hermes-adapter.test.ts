/**
 * Focused deterministic tests for the Matchlock Hermes adapter.
 *
 * All tests run with isolated temporary state/dirs (no real ~/.hermes, no
 * daemon, no models). They import the compiled adapter (dist) and exercise
 * pure profile resolution, guest launch construction, local-backend refusal,
 * store scope/no-fallback, session-trailer handling, token-accounting evidence,
 * external-dependency qualification, and the "native source untouched" guard.
 *
 * Profile-resolution expectations are GROUNDED IN THE ACTUAL INSTALLED CLI
 * (hermes_cli/main.py `_apply_profile_override` + hermes_cli/profiles.py
 * `resolve_profile_env`), reproduced via /root/matchlock-work/evidence/matrix.py
 * against synthetic homes. Notable native-observed rules encoded here:
 *   - `config.yaml.active_profile` is NOT consulted on the selection path
 *     (only the sticky `active_profile` FILE is).
 *   - a HERMES_HOME whose immediate parent is `profiles` is trusted without a
 *     marker condition on the grandparent.
 *   - a selected named profile that is missing/deleted/invalid is REFUSED.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { tamanduaTempDir } from "../dist/lib/temp-dir.js";

import {
  resolveHermesProfile,
  buildHermesGuestLaunch,
  extractSessionTrailer,
  stripSessionTrailer,
  scanHermesStoreTokens,
  storeDirWithinScope,
  computeHermesTokenTotal,
  readHermesConfig,
  assertLocalTerminalBackend,
  resolveHermesAdapterPlan,
  parseHermesConfig,
  DEFAULT_GUEST_HERMES_ROOT,
  DEFAULT_HERMES_PROFILE,
  DEFAULT_GUEST_HOME,
  HERMES_PROFILES_DIR,
} from "../dist/installer/matchlock/hermes-adapter.js";

const SRC_DIR = fileURLToPath(new URL("../src/installer/matchlock", import.meta.url));
const HERMES_SRC_FILES = [
  "hermes-adapter.ts",
  "hermes-profile.ts",
  "hermes-config.ts",
  "hermes-launch.ts",
  "hermes-output.ts",
  "hermes-store.ts",
];

function tempHome(prefix = "tamandua-matchlock-hermes-"): string {
  return tamanduaTempDir(prefix);
}

/**
 * Seed a synthetic Hermes home. Markers written at the root unless
 * `markers:false`. `configYaml` sets config.yaml text; `sticky` writes the
 * `active_profile` FILE; `namedProfiles` creates `profiles/<name>/config.yaml`.
 */
function makeHermesHome(
  root: string,
  opts: {
    configYaml?: string;
    markers?: boolean;
    sticky?: string;
    namedProfiles?: string[];
  } = {},
): void {
  fs.mkdirSync(root, { recursive: true });
  if (opts.markers !== false) {
    for (const marker of ["config.yaml", ".env", "state.db"]) {
      fs.writeFileSync(path.join(root, marker), "");
    }
  }
  if (opts.configYaml !== undefined) {
    fs.writeFileSync(path.join(root, "config.yaml"), opts.configYaml);
  }
  if (opts.sticky) {
    fs.writeFileSync(path.join(root, "active_profile"), opts.sticky);
  }
  for (const name of opts.namedProfiles ?? []) {
    const profRoot = path.join(root, HERMES_PROFILES_DIR, name);
    fs.mkdirSync(profRoot, { recursive: true });
    fs.writeFileSync(path.join(profRoot, "config.yaml"), "");
  }
}

/** Seed a state.db with token rows. */
function seedStateDb(
  storeDir: string,
  rows: Array<Record<string, number | null | string>>,
): void {
  fs.mkdirSync(storeDir, { recursive: true });
  const dbPath = path.join(storeDir, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0
    )
  `);
  for (const row of rows) {
    const keys = Object.keys(row);
    const placeholders = keys.map(() => "?").join(", ");
    db.prepare(`INSERT INTO sessions (${keys.join(", ")}) VALUES (${placeholders})`).run(
      ...(keys.map((k) => row[k]) as (number | null | string)[]),
    );
  }
  db.close();
}

describe("Matchlock Hermes adapter — profile resolution (native-grounded)", () => {
  it("resolves the default profile when nothing selects a named one (frozen input only)", () => {
    const homeRoot = tempHome();
    makeHermesHome(homeRoot); // markers at the resolved home root
    const plan = resolveHermesProfile({ homeDir: tempHome(), env: { HERMES_HOME: homeRoot }, cwd: "/sub/cwd" });
    assert.equal(plan.profile, DEFAULT_HERMES_PROFILE);
    assert.equal(plan.isNamedProfile, false);
    assert.equal(plan.hostHomeRoot, homeRoot);
    assert.equal(plan.hostEffectiveDir, homeRoot);
    assert.equal(plan.guestHomeRoot, DEFAULT_GUEST_HERMES_ROOT);
    assert.equal(plan.guestHermesHome, DEFAULT_GUEST_HERMES_ROOT);
    assert.equal(plan.outsideScope, false);
    assert.equal(plan.refused, false);
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it("ignores config.yaml.active_profile on the selection path (native reads only the FILE)", () => {
    // Native: only the sticky active_profile file is consulted; a YAML-only
    // active_profile does NOT select coder.
    const homeRoot = tempHome();
    makeHermesHome(homeRoot, {
      configYaml: "active_profile: coder\n",
      namedProfiles: ["coder"],
    });
    const plan = resolveHermesProfile({ homeDir: tempHome(), env: { HERMES_HOME: homeRoot }, cwd: "/sub/cwd" });
    assert.equal(plan.profile, DEFAULT_HERMES_PROFILE);
    assert.equal(plan.isNamedProfile, false);
    assert.equal(plan.hostEffectiveDir, homeRoot);
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it("prefers the active_profile FILE over config.yaml.active_profile (native sticky wins)", () => {
    // Native reads the file -> 'writer', never config.yaml's 'coder'.
    const homeRoot = tempHome();
    makeHermesHome(homeRoot, {
      configYaml: "active_profile: coder\n",
      sticky: "writer\n",
      namedProfiles: ["coder", "writer"],
    });
    const plan = resolveHermesProfile({ homeDir: tempHome(), env: { HERMES_HOME: homeRoot }, cwd: "/sub/cwd" });
    assert.equal(plan.profile, "writer");
    assert.equal(plan.hostEffectiveDir, path.join(homeRoot, HERMES_PROFILES_DIR, "writer"));
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it("trusts an explicit HERMES_HOME profiles/<name> home WITHOUT grandparent markers", () => {
    // Native trusts HERMES_HOME whose immediate parent is 'profiles' even when
    // the grandparent root carries no home markers.
    const base = tempHome();
    const customRoot = path.join(base, "custom-hermes");
    const profileHome = path.join(customRoot, HERMES_PROFILES_DIR, "coder");
    makeHermesHome(profileHome, { markers: true }); // markers INSIDE coder only
    const plan = resolveHermesProfile({
      homeDir: base,
      env: { HERMES_HOME: profileHome },
      cwd: "/sub/cwd",
    });
    assert.equal(plan.profile, "coder");
    assert.equal(plan.isNamedProfile, true);
    // No double-nesting: the effective dir is the coder home itself.
    assert.equal(plan.hostEffectiveDir, profileHome);
    assert.equal(plan.guestHermesHome, `${DEFAULT_GUEST_HERMES_ROOT}/${HERMES_PROFILES_DIR}/coder`);
    assert.equal(plan.refused, false);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("trusts an explicit HERMES_HOME profiles/<name> home even when no active selection exists", () => {
    // Native keeps HERMES_HOME as-is (it IS a profile home) -> coder, not default.
    const base = tempHome();
    const customRoot = path.join(base, "custom-hermes");
    const profileHome = path.join(customRoot, HERMES_PROFILES_DIR, "coder");
    makeHermesHome(profileHome, { markers: true });
    const plan = resolveHermesProfile({
      homeDir: base,
      env: { HERMES_HOME: profileHome },
      cwd: "/sub/cwd",
    });
    assert.equal(plan.profile, "coder");
    assert.equal(plan.isNamedProfile, true);
    assert.equal(plan.hostEffectiveDir, profileHome);
    assert.equal(plan.outsideScope, false);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("uses submission-time HERMES_HOME (absolute) and maps a named-profile home", () => {
    const root = tempHome();
    const profileHome = path.join(root, "hermes", HERMES_PROFILES_DIR, "coder");
    makeHermesHome(profileHome, {}); // markers inside coder home
    makeHermesHome(path.join(root, "hermes"), { namedProfiles: ["coder"] }); // markers at root too
    const plan = resolveHermesProfile({
      homeDir: "/some/home",
      env: { HERMES_HOME: path.join(root, "hermes", HERMES_PROFILES_DIR, "coder") },
      cwd: "/sub/cwd",
    });
    assert.equal(plan.isNamedProfile, true);
    assert.equal(plan.profile, "coder");
    assert.equal(plan.hostEffectiveDir, path.join(root, "hermes", HERMES_PROFILES_DIR, "coder"));
    assert.equal(plan.guestHermesHome, `${DEFAULT_GUEST_HERMES_ROOT}/${HERMES_PROFILES_DIR}/coder`);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses a sticky-selected profile that does not exist (native refusal)", () => {
    const homeRoot = tempHome();
    makeHermesHome(homeRoot, { sticky: "ghost\n" });
    const plan = resolveHermesProfile({ homeDir: tempHome(), env: { HERMES_HOME: homeRoot }, cwd: "/sub/cwd" });
    assert.equal(plan.refused, true);
    assert.match(plan.refusedReason!, /does not exist/);
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it("refuses a sticky-selected invalid profile id (native refusal)", () => {
    const homeRoot = tempHome();
    makeHermesHome(homeRoot, { sticky: "bad name!\n" });
    const plan = resolveHermesProfile({ homeDir: tempHome(), env: { HERMES_HOME: homeRoot }, cwd: "/sub/cwd" });
    assert.equal(plan.refused, true);
    assert.match(plan.refusedReason!, /invalid profile id/);
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it("refuses a sticky-selected tombstoned (deleted) profile (native refusal)", () => {
    const homeRoot = tempHome();
    makeHermesHome(homeRoot, {
      sticky: "coder\n",
      namedProfiles: ["coder"],
    });
    // Tombstone beside the profile dir marks it deleted.
    fs.mkdirSync(path.join(homeRoot, HERMES_PROFILES_DIR, ".deleted"), { recursive: true });
    fs.writeFileSync(path.join(homeRoot, HERMES_PROFILES_DIR, ".deleted", "coder"), "deleted\n");
    const plan = resolveHermesProfile({ homeDir: tempHome(), env: { HERMES_HOME: homeRoot }, cwd: "/sub/cwd" });
    assert.equal(plan.refused, true);
    assert.match(plan.refusedReason!, /deleted/);
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it("refuses a sticky-selected natively-RESERVED id even when its profile dir exists (native refusal)", () => {
    // Native _RESERVED_NAMES = {hermes, default, test, tmp, root, sudo} (profiles.py:117).
    // 'root' is reserved -> native `hermes` exits 1 ("Profile name 'root' is reserved"),
    // regardless of whether profiles/root exists. The adapter must refuse on the
    // RESERVED axis, not silently accept and launch under an id that shadows root.
    const homeRoot = tempHome();
    makeHermesHome(homeRoot, { sticky: "root\n", namedProfiles: ["root"] });
    const plan = resolveHermesProfile({ homeDir: tempHome(), env: { HERMES_HOME: homeRoot }, cwd: "/sub/cwd" });
    assert.equal(plan.refused, true);
    assert.match(plan.refusedReason!, /reserved/i, "reserved id must be refused for being reserved, not for being missing");
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it("accepts a sticky-selected id that native does NOT reserve (e.g. 'con')", () => {
    // 'con' is NOT in native _RESERVED_NAMES -> native selects it as a named
    // profile (HERMES_HOME=.../profiles/con, is_named=true). The previous
    // Windows-device hardcoded set wrongly refused it.
    const homeRoot = tempHome();
    makeHermesHome(homeRoot, { sticky: "con\n", namedProfiles: ["con"] });
    const plan = resolveHermesProfile({ homeDir: tempHome(), env: { HERMES_HOME: homeRoot }, cwd: "/sub/cwd" });
    assert.equal(plan.refused, false, "'con' is a valid, non-reserved profile id natively");
    assert.equal(plan.profile, "con");
    assert.equal(plan.isNamedProfile, true);
    assert.equal(plan.hostEffectiveDir, path.join(homeRoot, HERMES_PROFILES_DIR, "con"));
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it("refuses a sticky-selected reserved id even when it would otherwise be regex-valid (e.g. 'tmp')", () => {
    // 'tmp' matches the id regex but is reserved natively (mirrors the SystemExit path).
    const homeRoot = tempHome();
    makeHermesHome(homeRoot, { sticky: "tmp\n", namedProfiles: ["tmp"] });
    const plan = resolveHermesProfile({ homeDir: tempHome(), env: { HERMES_HOME: homeRoot }, cwd: "/sub/cwd" });
    assert.equal(plan.refused, true);
    assert.match(plan.refusedReason!, /reserved/i);
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it("resolves a relative HERMES_HOME against the submitting cwd", () => {
    const root = tempHome();
    const base = tempHome();
    const relTarget = path.join(root, "relative");
    fs.mkdirSync(relTarget, { recursive: true });
    const plan = resolveHermesProfile({
      homeDir: base,
      env: { HERMES_HOME: "relative" },
      cwd: root,
    });
    assert.equal(path.normalize(plan.hostHomeRoot), path.normalize(relTarget));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("changing process.env after capture cannot retarget the resolved profile", () => {
    const root = tempHome();
    const hermesRoot = path.join(root, "hermes");
    const profileHome = path.join(hermesRoot, HERMES_PROFILES_DIR, "coder");
    makeHermesHome(hermesRoot, { namedProfiles: ["coder"] });
    makeHermesHome(profileHome, {});
    // Frozen env pins the coder profile home.
    const frozen = resolveHermesProfile({ homeDir: tempHome(), env: { HERMES_HOME: profileHome }, cwd: "/c" });
    assert.equal(frozen.profile, "coder");
    // A daemon env change to a different HERMES_HOME retargets only when the
    // frozen env says so — i.e., the resolver follows the frozen param, not process.env.
    process.env.HERMES_HOME = "/some/other/root";
    const retargeted = resolveHermesProfile({ homeDir: tempHome(), env: { HERMES_HOME: "/some/other/root" }, cwd: "/c" });
    assert.equal(retargeted.hostHomeRoot, "/some/other/root");
    // Deleting process.env entirely cannot change the frozen plan.
    delete process.env.HERMES_HOME;
    const frozenAgain = resolveHermesProfile({ homeDir: tempHome(), env: { HERMES_HOME: profileHome }, cwd: "/c" });
    assert.equal(frozenAgain.hostHomeRoot, profileHome);
    assert.equal(frozenAgain.profile, "coder");
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.HERMES_HOME;
  });
});

describe("Matchlock Hermes adapter — external dependency qualification", () => {
  it("reports sibling profiles and root markers as neighbors (required=false), not auto-mount deps", () => {
    const root = tempHome();
    const home = path.join(root, ".hermes");
    makeHermesHome(home, { namedProfiles: ["coder", "writer"] });
    const plan = resolveHermesProfile({
      homeDir: root,
      env: { HERMES_HOME: path.join(home, HERMES_PROFILES_DIR, "coder") },
      cwd: "/c",
    });
    assert.equal(plan.profile, "coder");
    assert.equal(plan.isNamedProfile, true);
    // The whole root is NOT auto-mounted; only neighbors/root stores are listed,
    // and none of them is marked required (native skills/auth are profile-scoped).
    const deps = plan.externalDependencies;
    const sibling = deps.find((d) => d.kind === "sibling-profile" && d.name === "writer");
    assert.ok(sibling, "writer sibling should be reported");
    assert.equal(sibling!.required, false, "siblings are neighbors, not required deps");
    assert.ok(
      deps.every((d) => d.required === false),
      "no detected entry is auto-mount-required by default",
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("default profile carries no external dependencies", () => {
    const home = tempHome();
    makeHermesHome(home, { namedProfiles: ["coder"] });
    const plan = resolveHermesProfile({ homeDir: tempHome(), env: { HERMES_HOME: home }, cwd: "/c" });
    assert.equal(plan.profile, DEFAULT_HERMES_PROFILE);
    assert.deepEqual(plan.externalDependencies, []);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("Matchlock Hermes adapter — guest launch", () => {
  it("builds the exact one-shot chat argv/env/stdio contract", () => {
    const launch = buildHermesGuestLaunch({
      profileArg: DEFAULT_HERMES_PROFILE,
      hermesHome: DEFAULT_GUEST_HERMES_ROOT,
      prompt: "do the task",
      guestCwd: "/work/repo",
    });
    assert.deepEqual(launch.argv, [
      "hermes", "--profile", "default", "chat",
      "--max-turns", "8192", "--yolo", "-Q", "-q", "do the task",
    ]);
    assert.deepEqual(launch.env, { HERMES_HOME: DEFAULT_GUEST_HERMES_ROOT, HOME: DEFAULT_GUEST_HOME });
    assert.equal(launch.cwd, "/work/repo");
    assert.deepEqual(launch.stdio, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  });

  it("honours binary / maxTurns / guestHome overrides", () => {
    const launch = buildHermesGuestLaunch({
      profileArg: "coder",
      hermesHome: `${DEFAULT_GUEST_HERMES_ROOT}/${HERMES_PROFILES_DIR}/coder`,
      prompt: "x",
      guestCwd: "/w",
      binary: "/usr/local/bin/hermes",
      maxTurns: 10,
      guestHome: "/guest-hm",
    });
    assert.equal(launch.binary, "/usr/local/bin/hermes");
    assert.ok(launch.argv.includes("--max-turns"));
    assert.ok(launch.argv.includes("10"));
    assert.equal(launch.env.HOME, "/guest-hm");
    assert.equal(launch.env.HERMES_HOME, `${DEFAULT_GUEST_HERMES_ROOT}/${HERMES_PROFILES_DIR}/coder`);
  });

  it("positions --profile before the chat subcommand for the installed CLI", () => {
    const launch = buildHermesGuestLaunch({
      profileArg: "coder",
      hermesHome: DEFAULT_GUEST_HERMES_ROOT,
      prompt: "p",
      guestCwd: "/w",
    });
    const idxProfile = launch.argv.indexOf("--profile");
    const idxChat = launch.argv.indexOf("chat");
    assert.ok(idxProfile > 0, "--profile must be present");
    assert.ok(idxChat > idxProfile, "--profile must precede the chat subcommand");
  });
});

describe("Matchlock Hermes adapter — local backend refusal (guard)", () => {
  it("refuses an explicit remote terminal.backend", () => {
    const check = assertLocalTerminalBackend(viewOf("terminal:\n  backend: docker\n"));
    assert.equal(check.ok, false);
    assert.equal(check.code, "terminal-backend-remote");
    assert.match(check.reason!, /terminal\.backend is "docker"/i);
  });

  it("refuses an unrecognized terminal.backend without echoing the configured value", () => {
    const value = "sk-unknown-backend-token";
    const check = assertLocalTerminalBackend(viewOf(`terminal:\n  backend: ${value}\n`));
    assert.equal(check.ok, false);
    assert.equal(check.code, "terminal-backend-unknown");
    assert.ok(!check.reason!.includes(value), "unknown backend value must not be copied into diagnostics");
  });

  it("accepts an explicit local terminal.backend", () => {
    assert.deepEqual(assertLocalTerminalBackend(viewOf("terminal:\n  backend: local\n")), { ok: true });
  });

  it("treats an unset backend (default local) as acceptable", () => {
    assert.deepEqual(assertLocalTerminalBackend(null), { ok: true });
    assert.deepEqual(assertLocalTerminalBackend({}), { ok: true });
    assert.deepEqual(assertLocalTerminalBackend(viewOf("model: deepseek-v4-flash-vision-exp\n")), { ok: true });
  });

  it("surfaces an incompatible backend through the full adapter plan with no launch", () => {
    const home = tempHome();
    makeHermesHome(home, { configYaml: "terminal:\n  backend: ssh\n" });
    const plan = resolveHermesAdapterPlan(
      { homeDir: tempHome(), env: { HERMES_HOME: home }, cwd: "/c" },
      { prompt: "do it" },
    );
    assert.equal(plan.localBackend.ok, false);
    assert.equal(plan.localBackend.code, "terminal-backend-remote");
    assert.equal(plan.launch, null, "an explicitly remote backend must never yield a launch descriptor");
    assert.equal(plan.launchAdmission.ok, false);
    assert.equal(plan.launchAdmission.code, "terminal-backend-remote");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("admits only the EXACT string 'local' — padded/whitespace-only/block-scalar variants are unrecognized", () => {
    const variants: Array<{ yaml: string; raw: string }> = [
      { yaml: 'terminal:\n  backend: " local "\n', raw: " local " },
      { yaml: 'terminal:\n  backend: "   "\n', raw: "   " },
      { yaml: "terminal:\n  backend: |\n    local\n", raw: "local\n" },
    ];
    for (const { yaml, raw } of variants) {
      const check = assertLocalTerminalBackend(viewOf(yaml));
      assert.equal(check.ok, false, `exact-value admission must refuse ${JSON.stringify(raw)}`);
      if (!check.ok) {
        assert.equal(check.code, "terminal-backend-unknown");
        assert.ok(!JSON.stringify(check).includes(raw), "variant value must not be echoed into the reason");
      }
    }
    // Positive exact-value controls: the string must be exactly "local".
    assert.deepEqual(assertLocalTerminalBackend(viewOf('terminal:\n  backend: "local"\n')), { ok: true });
    assert.deepEqual(assertLocalTerminalBackend(viewOf("terminal:\n  backend: |-\n    local\n")), { ok: true });
    // A whitespace-padded remote name is NOT "docker" natively (env bridges the
    // raw scalar) — refuse as unknown and never echo the padded value.
    const paddedRemote = assertLocalTerminalBackend(viewOf('terminal:\n  backend: " docker "\n'));
    assert.equal(paddedRemote.ok, false);
    if (!paddedRemote.ok) {
      assert.equal(paddedRemote.code, "terminal-backend-unknown");
      assert.ok(!paddedRemote.reason!.includes(" docker "));
    }
  });

  it("refuses a whitespace-padded 'local' through the full adapter plan with no launch", () => {
    const home = tempHome();
    makeHermesHome(home, { configYaml: 'terminal:\n  backend: " local "\n' });
    const plan = resolveHermesAdapterPlan(
      { homeDir: tempHome(), env: { HERMES_HOME: home }, cwd: "/c" },
      { prompt: "do it" },
    );
    assert.equal(plan.config.status, "ok");
    assert.equal(plan.localBackend.ok, false);
    if (!plan.localBackend.ok) assert.equal(plan.localBackend.code, "terminal-backend-unknown");
    assert.equal(plan.launch, null, "an effectively-unrecognized backend must never yield a launch descriptor");
    assert.equal(plan.launchAdmission.ok, false);
    assert.equal(plan.launchAdmission.code, "terminal-backend-unknown");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("Matchlock Hermes adapter — store scope and no host-default fallback", () => {
  it("refuses a storeDir outside the admitted profile scope", () => {
    const root = tempHome();
    const home = path.join(root, "hermes");
    makeHermesHome(home, { namedProfiles: ["coder"] });
    const plan = resolveHermesAdapterPlan(
      { homeDir: root, env: { HERMES_HOME: path.join(home, HERMES_PROFILES_DIR, "coder") }, cwd: "/c" },
      { storeDir: "/totally/outside/scope" },
    );
    assert.equal(plan.storeScope.ok, false);
    const admitted = path.join(home, HERMES_PROFILES_DIR, "coder");
    assert.match(plan.storeScope.reason!, /outside the admitted profile scope/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("admits a storeDir inside the selected profile scope", () => {
    const root = tempHome();
    const home = path.join(root, "hermes");
    makeHermesHome(home, { namedProfiles: ["coder"] });
    const inScope = path.join(home, HERMES_PROFILES_DIR, "coder");
    const plan = resolveHermesAdapterPlan(
      { homeDir: root, env: { HERMES_HOME: inScope }, cwd: "/c" },
      { storeDir: inScope },
    );
    assert.equal(plan.storeScope.ok, true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("storeDirWithinScope is a pure lexical containment check", () => {
    assert.equal(storeDirWithinScope("/a/b", "/a"), true);
    assert.equal(storeDirWithinScope("/a", "/a"), true);
    assert.equal(storeDirWithinScope("/a/c/d", "/a/b"), false);
    assert.equal(storeDirWithinScope("/outside", "/a"), false);
  });

  it("never falls back to the host default store when evidence is missing", () => {
    const home = tempHome();
    process.env.HERMES_HOME = home;
    seedStateDb(home, [{ id: "sess-default", input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0 }]);

    const mapped = path.join(tempHome(), "mapped");
    fs.mkdirSync(mapped, { recursive: true });
    const scan = scanHermesStoreTokens({ storeDir: mapped, sessionRef: "sess-default" });
    assert.equal(scan.status, "unavailable");
    assert.match(scan.evidence[0], /state\.db not found/);
    const scanOk = scanHermesStoreTokens({ storeDir: home, sessionRef: "sess-default" });
    assert.equal(scanOk.status, "ok");
    assert.equal(scanOk.tokens, 3);

    delete process.env.HERMES_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mapped, { recursive: true, force: true });
  });
});

describe("Matchlock Hermes adapter — token accounting semantics", () => {
  it("sums input+output+cache_writes and excludes cache_read/reasoning", () => {
    const store = tempHome();
    seedStateDb(store, [
      { id: "s1", input_tokens: 100, output_tokens: 200, cache_read_tokens: 5_000_000, cache_write_tokens: 25, reasoning_tokens: 999 },
    ]);
    const scan = scanHermesStoreTokens({ storeDir: store, sessionRef: "s1" });
    assert.equal(scan.status, "ok");
    assert.equal(scan.tokens, 325);
    fs.rmSync(store, { recursive: true, force: true });
  });

  it("clamps negative tokens to 0 and rounds to integer", () => {
    const store = tempHome();
    seedStateDb(store, [
      { id: "s2", input_tokens: -10, output_tokens: 200, cache_read_tokens: -5, cache_write_tokens: 25 },
    ]);
    const scan = scanHermesStoreTokens({ storeDir: store, sessionRef: "s2" });
    assert.equal(scan.status, "ok");
    assert.equal(scan.tokens, 225);
    fs.rmSync(store, { recursive: true, force: true });
  });

  it("reports ambiguous evidence when token columns are NULL (not a verified zero)", () => {
    const store = tempHome();
    seedStateDb(store, [{ id: "s-null", input_tokens: null }]);
    const scan = scanHermesStoreTokens({ storeDir: store, sessionRef: "s-null" });
    assert.equal(scan.status, "ambiguous");
    assert.match(scan.evidence[0], /NULL token columns/);
    fs.rmSync(store, { recursive: true, force: true });
  });

  it("reports unavailable when a summed token field is non-numeric (never a verified zero)", () => {
    const store = tempHome();
    seedStateDb(store, [{ id: "s-bad", input_tokens: "abc", output_tokens: 1, cache_write_tokens: 1 }]);
    const scan = scanHermesStoreTokens({ storeDir: store, sessionRef: "s-bad" });
    assert.equal(scan.status, "unavailable");
    assert.match(scan.evidence[0], /non-numeric token fields/);
    fs.rmSync(store, { recursive: true, force: true });
  });

  it("computeHermesTokenTotal returns NaN (not 0) for non-finite/non-numeric fields", () => {
    assert.equal(Number.isNaN(computeHermesTokenTotal({ input_tokens: Number.POSITIVE_INFINITY, output_tokens: 1, cache_write_tokens: 1 })), true);
    assert.equal(Number.isNaN(computeHermesTokenTotal({ input_tokens: "x", output_tokens: 1, cache_write_tokens: 1 })), true);
    assert.equal(Number.isNaN(computeHermesTokenTotal({ input_tokens: Number.NaN, output_tokens: 1, cache_write_tokens: 1 })), true);
    assert.equal(computeHermesTokenTotal({ input_tokens: 10, output_tokens: 20, cache_write_tokens: 5 }), 35);
  });

  it("reports unavailable when the session row is missing", () => {
    const store = tempHome();
    seedStateDb(store, [{ id: "other", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }]);
    const scan = scanHermesStoreTokens({ storeDir: store, sessionRef: "s-missing" });
    assert.equal(scan.status, "unavailable");
    assert.match(scan.evidence[0], /not found/);
    fs.rmSync(store, { recursive: true, force: true });
  });

  it("reports truncated evidence on a read error", () => {
    const store = tempHome();
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, "state.db"), "not a sqlite database");
    const scan = scanHermesStoreTokens({ storeDir: store, sessionRef: "s1" });
    assert.equal(scan.status, "truncated");
    fs.rmSync(store, { recursive: true, force: true });
  });
});

describe("Matchlock Hermes adapter — session trailer handling", () => {
  it("prefers the stderr trailer over stdout", () => {
    const out = "final answer\nsession_id: session-on-out\n";
    const err = "\nsession_id: session-on-err\n";
    const t = extractSessionTrailer(out, err);
    assert.equal(t.sessionId, "session-on-err");
    assert.equal(t.source, "stderr");
  });

  it("falls back to stdout when stderr has no trailer", () => {
    const out = "\nsession_id: on-stdout\n";
    const t = extractSessionTrailer(out, "banner only");
    assert.equal(t.sessionId, "on-stdout");
    assert.equal(t.source, "stdout");
  });

  it("returns null evidence when no trailer is present", () => {
    const t = extractSessionTrailer("no trailer here", "nothing either");
    assert.deepEqual(t, { sessionId: null, source: null });
  });

  it("handles rotated/multiple trailers by taking the first", () => {
    const err = "\nsession_id: first\nsession_id: second\n";
    const t = extractSessionTrailer("", err);
    assert.equal(t.sessionId, "first");
  });

  it("strips the trailer line from assistant text for STATUS parsing", () => {
    const text = "STATUS: done\nreport body\n\nsession_id: abc\n";
    const stripped = stripSessionTrailer(text);
    assert.ok(!/session_id:/.test(stripped));
    assert.ok(stripped.includes("STATUS: done"));
    assert.ok(stripped.includes("report body"));
  });
});

describe("Matchlock Hermes adapter — full plan surfaces refusal and captured identity", () => {
  it("exposes selectionRefused and capturedIdentity on the plan", () => {
    const home = tempHome();
    makeHermesHome(home, { sticky: "ghost\n" });
    const plan = resolveHermesAdapterPlan({ homeDir: tempHome(), env: { HERMES_HOME: home }, cwd: "/c" });
    assert.equal(plan.selectionRefused, true);
    assert.equal(plan.capturedIdentity.hostHomeRoot, home);
    // The intended (refused) mount is the selected profile dir.
    assert.equal(plan.capturedIdentity.hostEffectiveDir, path.join(home, HERMES_PROFILES_DIR, "ghost"));
    assert.equal(plan.capturedIdentity.outsideScope, false);
    assert.ok(plan.integrationGates.length > 0, "integration gates remain explicit");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("Matchlock Hermes adapter — config parse guard (malformed/invalid shapes)", () => {
  it("never turns a malformed-YAML parse error into ok:true (direct parse)", () => {
    const res = parseHermesConfig("terminal: [");
    assert.equal(res.ok, false, "malformed YAML must not produce an ok config view");
    if (!res.ok) {
      assert.equal(res.problem!.code, "malformed-yaml");
      assert.equal(res.problem!.field, "config.yaml");
      assert.ok(res.problem!.detail.length > 0, "bounded actionable detail expected");
    }
  });

  it("probe parity: assertLocalTerminalBackend refuses a malformed parse passed straight in", () => {
    // Root reproduction: parseHermesConfig("terminal: [") failed to parse yet the
    // old check returned {ok:true}. The guard must refuse the failed parse itself.
    const check = assertLocalTerminalBackend(parseHermesConfig("terminal: ["));
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(check.code, "malformed-yaml");
  });

  it("probe parity: backend: 42 is not dropped and never asserts local", () => {
    // Root reproduction: the incompatible typed backend (42) was silently lost and
    // the check returned {ok:true}. The guard must classify and refuse it.
    const parsed = parseHermesConfig("terminal:\n  backend: 42\n");
    assert.equal(parsed.ok, false);
    const check = assertLocalTerminalBackend(parsed);
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(check.code, "terminal-backend-type");
  });

  it("reports malformed YAML with a bounded numeric location only", () => {
    const res = parseHermesConfig("terminal: {backend: local");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.problem.code, "malformed-yaml");
      if (res.problem.location) {
        assert.ok(Number.isInteger(res.problem.location.line) && res.problem.location.line > 0);
        assert.ok(Number.isInteger(res.problem.location.column) && res.problem.location.column > 0);
      }
    }
  });

  it("classifies invalid top-level types (scalar and sequence roots)", () => {
    for (const text of ["42\n", "- a\n- b\n"]) {
      const res = parseHermesConfig(text);
      assert.equal(res.ok, false, `expected refusal for ${JSON.stringify(text)}`);
      if (!res.ok) assert.equal(res.problem.code, "top-level-not-mapping");
    }
  });

  it("classifies a non-mapping terminal section", () => {
    for (const text of ["terminal: local\n", "terminal: 42\n"]) {
      const res = parseHermesConfig(text);
      assert.equal(res.ok, false, `expected refusal for ${JSON.stringify(text)}`);
      if (!res.ok) {
        assert.equal(res.problem.code, "terminal-not-mapping");
        assert.equal(res.problem.field, "terminal");
      }
    }
  });

  it("classifies an unsupported terminal.backend type instead of dropping it", () => {
    for (const text of [
      "terminal:\n  backend: 42\n",
      "terminal:\n  backend: true\n",
      "terminal:\n  backend:\n    - local\n",
      "terminal:\n  backend: {name: local}\n",
    ]) {
      const res = parseHermesConfig(text);
      assert.equal(res.ok, false, `expected refusal for ${JSON.stringify(text)}`);
      if (!res.ok) {
        assert.equal(res.problem.code, "terminal-backend-type");
        assert.equal(res.problem.field, "terminal.backend");
      }
    }
  });

  it("treats empty document / null root / null-or-empty backend as unset defaults", () => {
    assert.deepEqual(parseHermesConfig(""), { ok: true });
    assert.deepEqual(parseHermesConfig("terminal:\n"), { ok: true });
    assert.deepEqual(parseHermesConfig("terminal:\n  backend:\n"), { ok: true });
    assert.deepEqual(parseHermesConfig('terminal:\n  backend: ""\n'), { ok: true });
  });

  it("keeps an explicit local backend and other typed fields in the ok view", () => {
    const res = parseHermesConfig(
      "terminal:\n  backend: local\nmodel: deepseek-v4-flash-vision-exp\nactive_profile: coder\n",
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.terminalBackend, "local");
      assert.equal(res.model, "deepseek-v4-flash-vision-exp");
      assert.equal(res.activeProfile, "coder");
    }
  });

  it("keeps backend string scalars verbatim (never trims/normalizes into 'local')", () => {
    // Native Hermes bridges the raw scalar verbatim to TERMINAL_ENV, so the
    // parsed view must preserve padding / chomping so the exact-value check can
    // refuse these as unrecognized rather than folding them into "local".
    const pad = parseHermesConfig('terminal:\n  backend: " local "\n');
    assert.equal(pad.ok, true);
    if (pad.ok) assert.equal(pad.terminalBackend, " local ");

    const ws = parseHermesConfig('terminal:\n  backend: "   "\n');
    assert.equal(ws.ok, true);
    if (ws.ok) assert.equal(ws.terminalBackend, "   ");

    // Block scalar with clip chomping keeps the trailing newline: "local\n".
    const blockClip = parseHermesConfig("terminal:\n  backend: |\n    local\n");
    assert.equal(blockClip.ok, true);
    if (blockClip.ok) assert.equal(blockClip.terminalBackend, "local\n");

    // Block scalar with strip chomping yields the exact "local" — admissible.
    const blockStrip = parseHermesConfig("terminal:\n  backend: |-\n    local\n");
    assert.equal(blockStrip.ok, true);
    if (blockStrip.ok) assert.equal(blockStrip.terminalBackend, "local");
  });
});

describe("Matchlock Hermes adapter — config read guard (absent vs real fs failures)", () => {
  it("returns absent for a genuinely missing config under a valid root dir", () => {
    const root = tempHome();
    fs.mkdirSync(root, { recursive: true });
    const res = readHermesConfig(path.join(root, "config.yaml"));
    assert.equal(res.status, "absent");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads an ok typed view for an existing parseable config", () => {
    const root = tempHome();
    makeHermesHome(root, { configYaml: "terminal:\n  backend: local\n" });
    const res = readHermesConfig(path.join(root, "config.yaml"));
    assert.equal(res.status, "ok");
    if (res.status === "ok") assert.equal(res.config.terminalBackend, "local");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("classifies config.yaml-as-directory as not-a-file (EISDIR)", () => {
    const root = tempHome();
    fs.mkdirSync(path.join(root, "config.yaml"), { recursive: true });
    const res = readHermesConfig(path.join(root, "config.yaml"));
    assert.equal(res.status, "error");
    if (res.status === "error") {
      assert.equal(res.problem.code, "not-a-file");
      assert.equal(res.problem.errno, "EISDIR");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("classifies a config path under a file root as not-a-file (ENOTDIR)", () => {
    const base = tempHome();
    fs.mkdirSync(base, { recursive: true });
    const fileRoot = path.join(base, "root-is-a-file");
    fs.writeFileSync(fileRoot, "i am a file, not a directory");
    const res = readHermesConfig(path.join(fileRoot, "config.yaml"));
    assert.equal(res.status, "error");
    if (res.status === "error") {
      assert.equal(res.problem.code, "not-a-file");
      assert.equal(res.problem.errno, "ENOTDIR");
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("classifies a missing config root as invalid-root (never defaults to local)", () => {
    const base = tempHome();
    fs.mkdirSync(base, { recursive: true });
    const root = path.join(base, "does-not-exist");
    const res = readHermesConfig(path.join(root, "config.yaml"));
    assert.equal(res.status, "error");
    if (res.status === "error") assert.equal(res.problem.code, "invalid-root");
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("classifies malformed YAML in a real file as an error, never null", () => {
    const root = tempHome();
    makeHermesHome(root, { configYaml: "terminal: [\n" });
    const res = readHermesConfig(path.join(root, "config.yaml"));
    assert.equal(res.status, "error");
    if (res.status === "error") assert.equal(res.problem.code, "malformed-yaml");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("Matchlock Hermes adapter — config read guard (deterministic fs mocks, root-DAC independent)", () => {
  function fakeStats(dir: boolean): fs.Stats {
    return {
      isDirectory: () => dir,
      isFile: () => !dir,
    } as unknown as fs.Stats;
  }
  function fsErr(code: string): NodeJS.ErrnoException {
    const e = new Error(code) as NodeJS.ErrnoException;
    e.code = code;
    return e;
  }

  it("classifies an unreadable existing config (EACCES)", () => {
    const res = readHermesConfig("/cfg/config.yaml", {
      statSync: () => fakeStats(false),
      readFileSync: () => {
        throw fsErr("EACCES");
      },
    });
    assert.equal(res.status, "error");
    if (res.status === "error") {
      assert.equal(res.problem.code, "unreadable");
      assert.equal(res.problem.errno, "EACCES");
    }
  });

  it("classifies an EISDIR layout via stat isDirectory", () => {
    const res = readHermesConfig("/cfg/config.yaml", { statSync: () => fakeStats(true) });
    assert.equal(res.status, "error");
    if (res.status === "error") {
      assert.equal(res.problem.code, "not-a-file");
      assert.equal(res.problem.errno, "EISDIR");
    }
  });

  it("classifies a non-regular file (FIFO-like Stats.isFile false) as not-a-file without reading", () => {
    // A FIFO/socket/device at config.yaml passes stat but a readFileSync on a
    // FIFO would block indefinitely. The guard must classify !isFile() as
    // not-a-file and never attempt the read, keeping plan resolution bounded.
    let reads = 0;
    const res = readHermesConfig("/cfg/config.yaml", {
      statSync: () =>
        ({
          isDirectory: () => false,
          isFile: () => false,
        }) as unknown as fs.Stats,
      readFileSync: () => {
        reads += 1;
        throw new Error("must never read a non-regular file");
      },
    });
    assert.equal(reads, 0, "readFileSync must not be attempted on a non-regular file");
    assert.equal(res.status, "error");
    if (res.status === "error") {
      assert.equal(res.problem.code, "not-a-file");
      assert.equal(res.problem.errno, null, "no errno for a stat-visible non-regular file");
      assert.ok(!JSON.stringify(res.problem).includes("must never read"), "bounded problem only");
    }
  });

  it("classifies an ENOTDIR layout via stat throw", () => {
    const res = readHermesConfig("/cfg/config.yaml", {
      statSync: () => {
        throw fsErr("ENOTDIR");
      },
    });
    assert.equal(res.status, "error");
    if (res.status === "error") {
      assert.equal(res.problem.code, "not-a-file");
      assert.equal(res.problem.errno, "ENOTDIR");
    }
  });

  it("classifies a missing root as invalid-root, never absence", () => {
    const res = readHermesConfig("/missing/config.yaml", {
      statSync: () => {
        throw fsErr("ENOENT");
      },
    });
    assert.equal(res.status, "error");
    if (res.status === "error") {
      assert.equal(res.problem.code, "invalid-root");
      assert.equal(res.problem.errno, "ENOENT");
    }
  });

  it("treats ENOENT under a directory root as genuine absence", () => {
    const res = readHermesConfig("/root/config.yaml", {
      statSync: (p: string) => {
        if (p === "/root") return fakeStats(true);
        throw fsErr("ENOENT");
      },
    });
    assert.equal(res.status, "absent");
  });

  it("classifies a root stat failure during absence resolution as invalid-root", () => {
    const res = readHermesConfig("/root/config.yaml", {
      statSync: (p: string) => {
        if (p === "/root") throw fsErr("EACCES");
        throw fsErr("ENOENT");
      },
    });
    assert.equal(res.status, "error");
    if (res.status === "error") {
      assert.equal(res.problem.code, "invalid-root");
      assert.equal(res.problem.errno, "EACCES");
    }
  });
});

describe("Matchlock Hermes adapter — facade admission (no launch on refusal)", () => {
  it("refused profile + prompt yields no launch descriptor", () => {
    const home = tempHome();
    makeHermesHome(home, { sticky: "ghost\n" });
    const plan = resolveHermesAdapterPlan(
      { homeDir: tempHome(), env: { HERMES_HOME: home }, cwd: "/c" },
      { prompt: "do it" },
    );
    assert.equal(plan.selectionRefused, true);
    assert.equal(plan.launch, null, "a refused profile must never yield a launch descriptor");
    assert.equal(plan.launchAdmission.ok, false);
    assert.equal(plan.launchAdmission.code, "profile-refused");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("malformed config + prompt yields no launch descriptor and no ok:true backend", () => {
    const home = tempHome();
    makeHermesHome(home, { configYaml: "terminal: [\n" });
    const plan = resolveHermesAdapterPlan(
      { homeDir: tempHome(), env: { HERMES_HOME: home }, cwd: "/c" },
      { prompt: "do it" },
    );
    assert.equal(plan.config.status, "error");
    if (plan.config.status === "error") assert.equal(plan.config.problem.code, "malformed-yaml");
    assert.equal(plan.localBackend.ok, false, "a malformed config must never admit a local backend");
    assert.equal(plan.launch, null, "a malformed config must never yield a launch descriptor");
    assert.equal(plan.launchAdmission.ok, false);
    assert.equal(plan.launchAdmission.code, "malformed-yaml");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("config-as-directory + prompt yields no launch descriptor", () => {
    const home = tempHome();
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(home, "config.yaml"), { recursive: true });
    const plan = resolveHermesAdapterPlan(
      { homeDir: tempHome(), env: { HERMES_HOME: home }, cwd: "/c" },
      { prompt: "do it" },
    );
    assert.equal(plan.config.status, "error");
    if (plan.config.status === "error") assert.equal(plan.config.problem.code, "not-a-file");
    assert.equal(plan.localBackend.ok, false);
    assert.equal(plan.launch, null);
    assert.equal(plan.launchAdmission.ok, false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("valid default profile with genuinely absent config + prompt builds a launch (built-in defaults)", () => {
    const home = tempHome();
    fs.mkdirSync(home, { recursive: true }); // valid root; config.yaml genuinely absent
    const plan = resolveHermesAdapterPlan(
      { homeDir: tempHome(), env: { HERMES_HOME: home }, cwd: "/c" },
      { prompt: "do it", guestCwd: "/work/repo" },
    );
    assert.equal(plan.config.status, "absent");
    assert.equal(plan.profile.profile, DEFAULT_HERMES_PROFILE);
    assert.equal(plan.localBackend.ok, true);
    assert.equal(plan.launchAdmission.ok, true);
    assert.ok(plan.launch, "genuine absence under a valid root keeps the built-in-default launch");
    assert.deepEqual(plan.launch!.argv.slice(0, 3), ["hermes", "--profile", "default"]);
    assert.equal(plan.launch!.env.HERMES_HOME, DEFAULT_GUEST_HERMES_ROOT);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("valid named profile with explicit local backend + prompt builds the exact launch", () => {
    const root = tempHome();
    const home = path.join(root, "hermes");
    makeHermesHome(home, { namedProfiles: ["coder"] });
    makeHermesHome(path.join(home, HERMES_PROFILES_DIR, "coder"), {
      configYaml: "terminal:\n  backend: local\n",
    });
    const plan = resolveHermesAdapterPlan(
      {
        homeDir: root,
        env: { HERMES_HOME: path.join(home, HERMES_PROFILES_DIR, "coder") },
        cwd: "/c",
      },
      { prompt: "do it", guestCwd: "/work/repo" },
    );
    assert.equal(plan.profile.profile, "coder");
    assert.equal(plan.config.status, "ok");
    assert.equal(plan.localBackend.ok, true);
    assert.equal(plan.launchAdmission.ok, true);
    assert.ok(plan.launch);
    assert.deepEqual(plan.launch!.argv.slice(0, 5), ["hermes", "--profile", "coder", "chat", "--max-turns"]);
    assert.equal(
      plan.launch!.env.HERMES_HOME,
      `${DEFAULT_GUEST_HERMES_ROOT}/${HERMES_PROFILES_DIR}/coder`,
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("Matchlock Hermes adapter — facade admission precedence (guard refinement)", () => {
  it("pins launchAdmission.code precedence when several refusals coincide (profile-refused > config problem > local-backend)", () => {
    const scenarios: Array<{
      name: string;
      setup: (home: string) => void;
      expect: { ok: boolean; code: string | null };
    }> = [
      {
        name: "refused reserved sticky profile AND malformed config -> profile-refused (profile first)",
        setup: (home) => {
          fs.writeFileSync(path.join(home, "active_profile"), "tmp\n");
          fs.writeFileSync(path.join(home, "config.yaml"), "terminal: [\n");
        },
        expect: { ok: false, code: "profile-refused" },
      },
      {
        name: "refused reserved sticky profile AND remote backend -> profile-refused (profile first)",
        setup: (home) => {
          fs.writeFileSync(path.join(home, "active_profile"), "tmp\n");
          fs.writeFileSync(path.join(home, "config.yaml"), "terminal:\n  backend: ssh\n");
        },
        expect: { ok: false, code: "profile-refused" },
      },
      {
        name: "malformed config without profile refusal -> malformed-yaml (config problem second)",
        setup: (home) => {
          fs.writeFileSync(path.join(home, "config.yaml"), "terminal: [\n");
        },
        expect: { ok: false, code: "malformed-yaml" },
      },
      {
        name: "ok config read AND remote backend -> terminal-backend-remote (local-backend last)",
        setup: (home) => {
          fs.writeFileSync(path.join(home, "config.yaml"), "terminal:\n  backend: docker\n");
        },
        expect: { ok: false, code: "terminal-backend-remote" },
      },
      {
        name: "ok config read AND whitespace-padded 'local' backend -> terminal-backend-unknown",
        setup: (home) => {
          fs.writeFileSync(path.join(home, "config.yaml"), 'terminal:\n  backend: " local "\n');
        },
        expect: { ok: false, code: "terminal-backend-unknown" },
      },
      {
        name: "valid root with genuinely absent config (nothing refused) -> ok, null code",
        setup: () => undefined,
        expect: { ok: true, code: null },
      },
    ];

    for (const sc of scenarios) {
      const home = tempHome();
      fs.mkdirSync(home, { recursive: true });
      try {
        sc.setup(home);
        const plan = resolveHermesAdapterPlan(
          { homeDir: tempHome(), env: { HERMES_HOME: home }, cwd: "/c" },
          { prompt: "do it" },
        );
        assert.equal(plan.launchAdmission.ok, sc.expect.ok, sc.name);
        assert.equal(plan.launchAdmission.code, sc.expect.code, sc.name);
        if (!sc.expect.ok) {
          assert.equal(plan.launch, null, `${sc.name}: a refusal must never yield a launch descriptor`);
        } else {
          assert.ok(plan.launch, `${sc.name}: an admitted plan with a prompt builds a launch`);
        }
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it("treats empty/comment-only/whitespace-only config text as unset-default (never a refusal)", () => {
    for (const text of ["", "# only a comment\n", "   \n\n  \n"]) {
      const parsed = parseHermesConfig(text);
      assert.deepEqual(parsed, { ok: true }, `unset-default parse for ${JSON.stringify(text)}`);
      assert.deepEqual(assertLocalTerminalBackend(parsed), { ok: true });
    }
    // Through a real file + the facade: a comment-only config.yaml is present
    // but carries no backend override -> native unset-default local -> launch.
    const home = tempHome();
    fs.mkdirSync(home, { recursive: true });
    try {
      fs.writeFileSync(path.join(home, "config.yaml"), "# only a comment\n");
      const plan = resolveHermesAdapterPlan(
        { homeDir: tempHome(), env: { HERMES_HOME: home }, cwd: "/c" },
        { prompt: "do it", guestCwd: "/work/repo" },
      );
      assert.equal(plan.config.status, "ok");
      assert.equal(plan.localBackend.ok, true);
      assert.equal(plan.launchAdmission.ok, true);
      assert.ok(plan.launch, "comment-only config keeps the built-in-default launch");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Matchlock Hermes adapter — safe diagnostics (no config-content leakage)", () => {
  const SECRET = "sk-super-secret-token-9876543210";

  it("parse problem for malformed YAML never leaks an embedded secret", () => {
    const malformed = `terminal:\n  backend: local\napi_key: [${SECRET}, oops\n`;
    const res = parseHermesConfig(malformed);
    assert.equal(res.ok, false);
    const json = JSON.stringify(res);
    assert.ok(!json.includes(SECRET), "secret must not leak through the parse problem");
    assert.ok(!json.includes("api_key"), "raw config field content must not be echoed");
  });

  it("read problem for a malformed config file never leaks an embedded secret", () => {
    const home = tempHome();
    makeHermesHome(home, { configYaml: `terminal:\n  backend: local\napi_key: [${SECRET}, oops\n` });
    const res = readHermesConfig(path.join(home, "config.yaml"));
    assert.equal(res.status, "error");
    if (res.status === "error") {
      assert.equal(res.problem.code, "malformed-yaml");
      assert.ok(!JSON.stringify(res.problem).includes(SECRET));
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("full adapter plan never leaks a secret embedded in malformed YAML", () => {
    const home = tempHome();
    makeHermesHome(home, { configYaml: `terminal:\n  backend: local\napi_key: [${SECRET}, oops\n` });
    const plan = resolveHermesAdapterPlan(
      { homeDir: tempHome(), env: { HERMES_HOME: home }, cwd: "/c" },
      { prompt: "do it" },
    );
    assert.equal(plan.launch, null);
    assert.ok(!JSON.stringify(plan).includes(SECRET), "plan diagnostics must not leak the secret");
    assert.ok(!JSON.stringify(plan.launchAdmission).includes(SECRET));
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("unreadable problem keeps a bounded errno/detail only (no raw fs message)", () => {
    const res = readHermesConfig("/cfg/config.yaml", {
      statSync: () =>
        ({
          isDirectory: () => false,
          isFile: () => true,
        }) as unknown as fs.Stats,
      readFileSync: () => {
        const e = new Error(`EACCES: raw private message ${SECRET}`) as NodeJS.ErrnoException;
        e.code = "EACCES";
        throw e;
      },
    });
    assert.equal(res.status, "error");
    if (res.status === "error") {
      const json = JSON.stringify(res.problem);
      assert.ok(!json.includes(SECRET), "raw fs error text must not be copied into diagnostics");
      assert.equal(res.problem.errno, "EACCES");
    }
  });

  it("unrecognized backend value is not echoed into the check reason", () => {
    const check = assertLocalTerminalBackend(viewOf(`terminal:\n  backend: ${SECRET}\n`));
    assert.equal(check.ok, false);
    assert.equal(check.code, "terminal-backend-unknown");
    assert.ok(!JSON.stringify(check).includes(SECRET));
  });
});

describe("Matchlock Hermes adapter — native source untouched guard", () => {
  it("adapter source never spawns processes, writes files, or references native assets", () => {
    const forbiddenPatterns = [
      /node:child_process/,
      /writeFileSync|writeFile\(|rmSync|rmdirSync|unlinkSync|mkdirSync|appendFileSync/,
      /native\//,
      /process\.env/,
    ];
    for (const file of HERMES_SRC_FILES) {
      const text = stripComments(fs.readFileSync(path.join(SRC_DIR, file), "utf8"));
      for (const pattern of forbiddenPatterns) {
        assert.ok(
          !pattern.test(text),
          `${file} must not match ${pattern}`,
        );
      }
    }
  });

  it("adapter source contains no hardcoded host-source execution paths", () => {
    for (const file of HERMES_SRC_FILES) {
      const text = fs.readFileSync(path.join(SRC_DIR, file), "utf8");
      assert.ok(!/\.tamandua\/worktrees|\/usr\/local\/lib\/hermes/.test(text),
        `${file} references a host checkouts path`);
    }
  });
});

// Strip `/* */` and `//` comments so doc prose cannot trip code-only guards.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

// Helper: parse a config from a literal YAML fragment and return the ok typed
// view (ParsedHermesConfig with ok:true). Structural guard cases assert parse
// failures directly on parseHermesConfig instead.
function viewOf(yamlText: string): import("../dist/installer/matchlock/hermes-adapter.js").ParsedHermesConfig {
  const parsed = parseHermesConfig(yamlText);
  assert.equal(parsed.ok, true, `expected a parseable fragment, got problem ${parsed.ok ? "" : parsed.problem!.code}`);
  return parsed;
}
