/**
 * DSH-OVERLAY-FSYNC-FIX US-001 — fast, deterministic controls for the
 * operator-shaped real-layout DSH_HOME fixture builder
 * (`e2e-tests/helpers/matchlock-dsh-gate-fixtures.ts` `stageRealLayoutDshHome`).
 *
 * The #34 real-boot gate used a MINIMAL zero-provider fixture home and never
 * exercised dsh's real boot path over an operator-shaped store. These controls
 * pin the new builder's contract with NO VM, no provider, no network:
 *
 *   - >= 3 distinct `sessions/<cwd-key>/session-<uuid>/` dirs each holding a
 *     REGULAR concatenated-zstd artifact (>= 2 frames), read both structurally
 *     (`scanMatchlockZstdFrames`) and through the PRODUCTION reader;
 *   - `storages/session_projcache/sessions/session-<uuid>.json` JSON records;
 *   - the durable profile config with EMPTY install-derived dirs and NO symlink
 *     under `profiles/`;
 *   - a supplied source home's durable config copied byte-identically while its
 *     `.credentials.yaml` and `sessions/` contents are never read or copied;
 *   - deterministic (byte-identical) rebuilds and a complete synthetic layout
 *     when the source home is absent.
 *
 * The builder is Node-core only (fs/path/os/zlib), so this file stays in the
 * parallel lane. Every scratch path comes from `tamanduaTempDir()`.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import {
  DSH_GATE_DURABLE_PROFILE_FILES,
  DSH_GATE_PLACEHOLDER_CREDENTIALS,
  DSH_GATE_REAL_DSH_HOME_ENV,
  DSH_GATE_REAL_LAYOUT_ANONYMOUS_USER_ID,
  DSH_GATE_REAL_LAYOUT_PROJECT_CWDS,
  diffDshHostStore,
  snapshotDshHostStore,
  snapshotDshTreeLinks,
  stageRealLayoutDshHome,
  stderrCarriesDshBootEnoent,
  stderrCarriesDshBootLockEnoent,
  stderrCarriesDshFsyncEnoent,
} from "../e2e-tests/helpers/matchlock-dsh-gate-fixtures.ts";
import {
  discoverSessionArtifacts,
  readDshSessionArtifact,
  scanMatchlockZstdFrames,
} from "../dist/installer/matchlock/dsh-session-store.js";

/** Recursive content digest: `dir` / `file:<base64>` / `link:<target>`. */
function treeDigest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const childRel = rel === "" ? entry.name : path.join(rel, entry.name);
      if (entry.isSymbolicLink()) {
        out[childRel] = `link:${fs.readlinkSync(full)}`;
      } else if (entry.isDirectory()) {
        out[childRel] = "dir";
        walk(full, childRel);
      } else if (entry.isFile()) {
        out[childRel] = `file:${fs.readFileSync(full).toString("base64")}`;
      }
    }
  };
  walk(root, "");
  return out;
}

/** A synthetic stand-in for the operator's real dsh home (never the real one). */
function makeSyntheticSourceHome(root: string, name: string): string {
  const source = path.join(root, name);
  const profileDir = path.join(source, "profiles", "headless");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "package.json"),
    '{"name":"dsh-profile-headless","dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]}}}\n',
    "utf-8",
  );
  fs.writeFileSync(path.join(profileDir, "cordis.yml"), "- plugins\n", "utf-8");
  fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), "[]\n", "utf-8");
  fs.writeFileSync(path.join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\n", "utf-8");
  fs.mkdirSync(path.join(profileDir, "node_modules"), { recursive: true });
  fs.symlinkSync("/opt/dsh/node_modules/undici", path.join(profileDir, "node_modules", "undici"));
  fs.mkdirSync(path.join(profileDir, ".dsh-module-fallback", "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(source, "profiles", "node_modules"), { recursive: true });
  fs.symlinkSync(
    "/opt/dsh/node_modules/commander",
    path.join(source, "profiles", "node_modules", "commander"),
  );
  // Real-credential sentinel and a real-session sentinel that must NEVER be read
  // or copied into a gate-owned home.
  fs.writeFileSync(
    path.join(source, ".credentials.yaml"),
    "providers:\n  deepseek:\n    apiKey: REAL-SECRET-MUST-NOT-BE-COPIED\n",
    "utf-8",
  );
  const sentinelSession = path.join(source, "sessions", "session-SENTINEL", "session.v3.jsonl.zstd");
  fs.mkdirSync(path.dirname(sentinelSession), { recursive: true });
  fs.writeFileSync(sentinelSession, "REAL-SESSION-CONTENT-MUST-NOT-BE-COPIED\n", "utf-8");
  return source;
}

describe("matchlock dsh real-layout DSH_HOME fixture (DSH-OVERLAY-FSYNC-FIX US-001)", () => {
  let root = "";

  before(() => {
    root = tamanduaTempDir("mtlk-dsh-real-layout-");
  });

  after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* owned scratch */
    }
  });

  it("seeds >= 3 distinct session project dirs with multi-frame concatenated-zstd artifacts", () => {
    const source = makeSyntheticSourceHome(root, "shape-source");
    const home = path.join(root, "shape-home");
    const layout = stageRealLayoutDshHome({ sourceHome: source, destinationHome: home });

    assert.ok(layout.sessionProjectDirs.length >= 3, "at least three project dirs");
    assert.equal(new Set(layout.sessionProjectDirs).size, layout.sessionProjectDirs.length);
    assert.equal(layout.sessionDirs.length, layout.sessionProjectDirs.length);
    assert.equal(layout.currentSessionArtifacts.length, layout.sessionProjectDirs.length);
    assert.equal(layout.legacySessionArtifacts.length, layout.sessionProjectDirs.length);
    assert.equal(layout.sessionLockFiles.length, layout.sessionProjectDirs.length);

    for (let i = 0; i < layout.sessionDirs.length; i++) {
      const sessionDirRel = layout.sessionDirs[i];
      const sessionDir = path.join(home, sessionDirRel);
      assert.ok(fs.lstatSync(sessionDir).isDirectory(), `${sessionDirRel} is a real dir`);

      for (const rel of [
        layout.currentSessionArtifacts[i],
        layout.legacySessionArtifacts[i],
      ]) {
        const artifact = path.join(home, rel);
        const st = fs.lstatSync(artifact);
        assert.ok(st.isFile() && !st.isSymbolicLink(), `${rel} must be a regular file`);
        const scan = scanMatchlockZstdFrames(fs.readFileSync(artifact));
        assert.equal(scan.corruptAt, null, `${rel} must not be corrupt`);
        assert.equal(scan.tornStart, null, `${rel} must not be torn`);
        assert.ok(scan.frames.length >= 2, `${rel} must hold >= 2 zstd frames`);
      }

      // The v3 artifact is the CURRENT generation to the production reader.
      const discovery = discoverSessionArtifacts(sessionDir);
      assert.equal(discovery.problem, null);
      assert.equal(discovery.current, "session.v3.jsonl.zstd");
      assert.ok(discovery.legacy.includes("session.jsonl.zstd"));

      const read = readDshSessionArtifact({
        artifactPath: path.join(home, layout.currentSessionArtifacts[i]),
        admittedRoot: home,
      });
      assert.equal(read.decode, "ok", `v3 artifact must decode: ${JSON.stringify(read)}`);
      assert.ok(read.header !== null, "v3 artifact carries a session header");
      assert.equal(read.header?.version, 3);
      assert.match(String(read.header?.id), /^00000000-0000-4000-8000-\d{12}$/);
      assert.ok((read.usageTokens ?? 0) > 0, "v3 artifact carries a usage record");

      const lock = fs.lstatSync(path.join(home, layout.sessionLockFiles[i]));
      assert.ok(lock.isFile() && !lock.isSymbolicLink(), "session.lock is a regular file");
    }
  });

  it("storages JSON records are regular files whose contents parse", () => {
    const source = makeSyntheticSourceHome(root, "storage-source");
    const home = path.join(root, "storage-home");
    const layout = stageRealLayoutDshHome({ sourceHome: source, destinationHome: home });

    assert.ok(layout.storageRecordFiles.length >= 1);
    for (const rel of layout.storageRecordFiles) {
      const full = path.join(home, rel);
      const st = fs.lstatSync(full);
      assert.ok(st.isFile() && !st.isSymbolicLink(), `${rel} is a regular file`);
      const parsed = JSON.parse(fs.readFileSync(full, "utf-8"));
      assert.equal(parsed.version, 7);
      assert.equal(typeof parsed.record.identity.cwd, "string");
      assert.equal(parsed.record.identity.isSeeded, false);
    }
    // Deterministic record ids under the real container path.
    assert.ok(
      layout.storageRecordFiles.every((rel) =>
        rel.startsWith(path.join("storages", "session_projcache", "sessions") + path.sep),
      ),
    );
  });

  it("profiles/ carries durable config with EMPTY install-derived dirs and no symlink", () => {
    const source = makeSyntheticSourceHome(root, "profiles-source");
    const home = path.join(root, "profiles-home");
    const layout = stageRealLayoutDshHome({ sourceHome: source, destinationHome: home });

    // Durable config copied byte-identically from the source profile dir.
    for (const file of DSH_GATE_DURABLE_PROFILE_FILES) {
      const rel = path.join("profiles", "headless", file);
      assert.ok(layout.durableProfileFiles.includes(rel), `${rel} recorded`);
      assert.equal(
        fs.readFileSync(path.join(home, rel), "utf-8"),
        fs.readFileSync(path.join(source, rel), "utf-8"),
        `${file} copied byte-identically`,
      );
      assert.equal(layout.synthesizedConfigFiles.includes(rel), false, `${file} was copied, not synthesized`);
    }

    for (const rel of layout.installDerivedDirs) {
      const dir = path.join(home, rel);
      const st = fs.lstatSync(dir);
      assert.ok(st.isDirectory() && !st.isSymbolicLink(), `${rel} is a real dir`);
      assert.equal(fs.readdirSync(dir).length, 0, `${rel} is empty`);
    }
    assert.deepEqual(
      snapshotDshTreeLinks(path.join(home, "profiles")),
      {},
      "no symlink anywhere under profiles/",
    );
  });

  it("a supplied source home's credentials and sessions are never read or copied", () => {
    const source = makeSyntheticSourceHome(root, "secret-source");
    const home = path.join(root, "secret-home");
    const layout = stageRealLayoutDshHome({ sourceHome: source, destinationHome: home });

    assert.equal(layout.credentialsFile, ".credentials.yaml");
    assert.equal(
      fs.readFileSync(path.join(home, ".credentials.yaml"), "utf-8"),
      DSH_GATE_PLACEHOLDER_CREDENTIALS,
    );
    // dsh's credentials-local provider refuses a file "readable beyond its
    // owner", so the staged placeholder MUST be 0600 like the operator's.
    assert.equal(
      fs.statSync(path.join(home, ".credentials.yaml")).mode & 0o777,
      0o600,
      "staged credentials must be owner-only (0600)",
    );
    assert.equal(
      fs.existsSync(path.join(home, "sessions", "session-SENTINEL")),
      false,
      "the source session dir is never staged",
    );

    // No staged byte anywhere may carry either source sentinel.
    for (const [rel, digest] of Object.entries(treeDigest(home))) {
      if (!digest.startsWith("file:")) continue;
      const content = Buffer.from(digest.slice("file:".length), "base64").toString("utf-8");
      assert.ok(!content.includes("REAL-SECRET-MUST-NOT-BE-COPIED"), `${rel} leaked credentials`);
      assert.ok(!content.includes("REAL-SESSION-CONTENT-MUST-NOT-BE-COPIED"), `${rel} leaked sessions`);
    }

    assert.equal(layout.anonymousUserIdFile, ".anonymous-user-id");
    assert.equal(
      fs.readFileSync(path.join(home, ".anonymous-user-id"), "utf-8"),
      `${DSH_GATE_REAL_LAYOUT_ANONYMOUS_USER_ID}\n`,
    );
  });

  it("two builds from the same inputs are byte-identical", () => {
    const source = makeSyntheticSourceHome(root, "determinism-source");
    const first = path.join(root, "determinism-home-a");
    const second = path.join(root, "determinism-home-b");
    const a = stageRealLayoutDshHome({ sourceHome: source, destinationHome: first });
    const b = stageRealLayoutDshHome({ sourceHome: source, destinationHome: second });

    assert.deepEqual(a.sessionDirs, b.sessionDirs, "deterministic session dir names");
    assert.deepEqual(a.storageRecordFiles, b.storageRecordFiles, "deterministic storage names");
    assert.deepEqual(treeDigest(first), treeDigest(second), "byte-identical trees");
  });

  it("an absent source home still yields a complete synthetic real-shape layout", () => {
    const home = path.join(root, "absent-source-home");
    const layout = stageRealLayoutDshHome({
      sourceHome: path.join(root, "definitely-absent-source"),
      destinationHome: home,
    });

    for (const file of DSH_GATE_DURABLE_PROFILE_FILES) {
      const rel = path.join("profiles", "headless", file);
      assert.ok(
        layout.synthesizedConfigFiles.includes(rel),
        `${rel} must be synthesized when the source is absent`,
      );
      assert.ok(fs.lstatSync(path.join(home, rel)).isFile(), `${rel} exists`);
    }
    assert.equal(layout.sessionDirs.length >= 3, true);
    assert.ok(layout.storageRecordFiles.length >= 1);
    assert.deepEqual(snapshotDshTreeLinks(path.join(home, "profiles")), {});
    assert.equal(
      fs.readFileSync(path.join(home, ".credentials.yaml"), "utf-8"),
      DSH_GATE_PLACEHOLDER_CREDENTIALS,
    );
  });

  it("sourceHome:null never reads the ambient operator home", () => {
    // Point the env override at a decoy source and HOME at an empty scratch dir
    // so a buggy fallback to the operator's real ~/.dsh would be observable.
    const decoy = makeSyntheticSourceHome(root, "decoy-source");
    const previousEnv = process.env[DSH_GATE_REAL_DSH_HOME_ENV];
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const isolatedHome = path.join(root, "isolated-operator-home");
    fs.mkdirSync(isolatedHome, { recursive: true });
    process.env[DSH_GATE_REAL_DSH_HOME_ENV] = decoy;
    process.env.HOME = isolatedHome;
    delete process.env.USERPROFILE;
    try {
      const home = path.join(root, "null-source-home");
      const layout = stageRealLayoutDshHome({ sourceHome: null, destinationHome: home });
      // Every durable file is synthesized because no source was consulted.
      for (const file of DSH_GATE_DURABLE_PROFILE_FILES) {
        const rel = path.join("profiles", "headless", file);
        assert.ok(layout.synthesizedConfigFiles.includes(rel), `${rel} must be synthesized`);
      }
    } finally {
      if (previousEnv === undefined) delete process.env[DSH_GATE_REAL_DSH_HOME_ENV];
      else process.env[DSH_GATE_REAL_DSH_HOME_ENV] = previousEnv;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile !== undefined) process.env.USERPROFILE = previousUserProfile;
    }
  });

  it("the TAMANDUA_GATE_REAL_DSH_HOME env override supplies the durable profile config", () => {
    const envSource = makeSyntheticSourceHome(root, "env-source");
    const previousEnv = process.env[DSH_GATE_REAL_DSH_HOME_ENV];
    const previousHome = process.env.HOME;
    process.env[DSH_GATE_REAL_DSH_HOME_ENV] = envSource;
    process.env.HOME = path.join(root, "env-isolated-operator-home");
    try {
      const home = path.join(root, "env-home");
      const layout = stageRealLayoutDshHome({ destinationHome: home });
      assert.equal(
        fs.readFileSync(path.join(home, "profiles", "headless", "cordis.yml"), "utf-8"),
        fs.readFileSync(path.join(envSource, "profiles", "headless", "cordis.yml"), "utf-8"),
      );
      assert.equal(layout.synthesizedConfigFiles.length, 0, "all durable config came from the env source");
    } finally {
      if (previousEnv === undefined) delete process.env[DSH_GATE_REAL_DSH_HOME_ENV];
      else process.env[DSH_GATE_REAL_DSH_HOME_ENV] = previousEnv;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("the seeded project keys mirror the installed dsh projectKey shape", () => {
    const home = path.join(root, "keys-home");
    const layout = stageRealLayoutDshHome({
      sourceHome: path.join(root, "keys-absent-source"),
      destinationHome: home,
      projectCount: DSH_GATE_REAL_LAYOUT_PROJECT_CWDS.length,
    });
    for (let i = 0; i < DSH_GATE_REAL_LAYOUT_PROJECT_CWDS.length; i++) {
      const cwd = DSH_GATE_REAL_LAYOUT_PROJECT_CWDS[i];
      const slug = cwd.replace(/^\/+/, "").replace(/\//g, "-");
      const expected = `--${slug}--`;
      assert.equal(layout.sessionProjectDirs[i], path.join("sessions", expected));
    }
  });

  // ── DSH-OVERLAY-FSYNC-FIX US-004: boot-ENOENT + host-store helpers ───────

  it("stderrCarriesDshFsyncEnoent matches the run-#35 root-fsync shape only", () => {
    assert.equal(
      stderrCarriesDshFsyncEnoent("dsh: ENOENT: no such file or directory, fsync\n"),
      true,
      "the exact run-#35 root-fsync line must match",
    );
    assert.equal(
      stderrCarriesDshFsyncEnoent(
        "Error: ENOENT: no such file or directory, fsync\n    at syncDirPosix (file:///opt/dsh/x.js:1:1)",
      ),
      true,
      "a stack-traced Node fsync ENOENT must match",
    );
    // An ENOENT that is NOT the fsync syscall is a different failure class and
    // must never be mistaken for the boot-root regression.
    assert.equal(
      stderrCarriesDshFsyncEnoent(
        "dsh: MISSING_CREDENTIAL: no API key for provider route deepseek-official\n",
      ),
      false,
    );
    assert.equal(
      stderrCarriesDshFsyncEnoent(
        "Error: ENOENT: no such file or directory, open '/workspace/config/dsh/.credentials.yaml'\n",
      ),
      false,
    );
    assert.equal(stderrCarriesDshFsyncEnoent(""), false);
  });

  it("stderrCarriesDshBootEnoent covers both the root-fsync and the boot-lock shapes", () => {
    const lockStderr =
      "Error: ENOENT: no such file or directory, open '/workspace/config/dsh/profiles/node_modules.lock'";
    const fsyncStderr = "dsh: ENOENT: no such file or directory, fsync";
    assert.equal(stderrCarriesDshBootEnoent(fsyncStderr), true);
    assert.equal(stderrCarriesDshBootEnoent(lockStderr), true);
    assert.equal(stderrCarriesDshBootEnoent("dsh: MISSING_CREDENTIAL\n"), false);
    // The lock matcher is unchanged and profilesDir-aware: it also matches the
    // resolved absolute lock path even without the canonical `open '...'` shape.
    assert.equal(stderrCarriesDshBootLockEnoent(lockStderr), true);
    assert.equal(
      stderrCarriesDshBootLockEnoent(
        "fatal: could not touch /workspace/config/dsh/profiles/node_modules.lock",
        "/workspace/config/dsh/profiles",
      ),
      true,
    );
    assert.equal(
      stderrCarriesDshBootLockEnoent(
        "fatal elsewhere",
        "/workspace/config/dsh/profiles",
      ),
      false,
    );
  });

  it("snapshotDshHostStore/diffDshHostStore observe a guest-written session and storage record", () => {
    const home = path.join(root, "observed-store-home");
    const layout = stageRealLayoutDshHome({
      sourceHome: path.join(root, "observed-absent-source"),
      destinationHome: home,
    });
    const before = snapshotDshHostStore(home);
    assert.equal(before.sessionDirs.length, layout.sessionDirs.length);
    assert.ok(before.sessionFiles.length >= layout.currentSessionArtifacts.length);
    assert.ok(before.storageFiles.length >= layout.storageRecordFiles.length);

    // Simulate the US-003 publish merge: a NEW session dir + v3 artifact + a
    // NEW projection record land in the host home.
    const newSessionRel = path.join("sessions", "--workspace-new--", "session-9999");
    fs.mkdirSync(path.join(home, newSessionRel), { recursive: true });
    const newArtifactRel = path.join(newSessionRel, "session.v3.jsonl.zstd");
    fs.writeFileSync(
      path.join(home, newArtifactRel),
      zlib.zstdCompressSync(
        Buffer.from(
          `${JSON.stringify({
            type: "session",
            version: 3,
            id: "99999999-0000-4000-8000-000000000009",
            createdAt: 1_700_000_000_000,
            isSeeded: false,
            cwd: "/workspace/new",
          })}\n`,
        ),
      ),
    );
    const newStorageRel = path.join(
      "storages",
      "session_projcache",
      "sessions",
      "session-99999999.json",
    );
    fs.writeFileSync(path.join(home, newStorageRel), '{"version":7}\n', "utf-8");

    const after = snapshotDshHostStore(home);
    const delta = diffDshHostStore(before, after);
    assert.deepEqual(delta.addedSessionDirs, [newSessionRel]);
    assert.deepEqual(delta.addedSessionFiles, [newArtifactRel]);
    assert.deepEqual(delta.addedStorageFiles, [newStorageRel]);

    // The production reader classifies the new artifact as a decodable v3
    // session record — the honest "first request record landed" assertion.
    const read = readDshSessionArtifact({
      artifactPath: path.join(home, newArtifactRel),
      admittedRoot: home,
    });
    assert.equal(read.decode, "ok", JSON.stringify(read));
    assert.equal(read.header?.version, 3);
    assert.equal(read.header?.id, "99999999-0000-4000-8000-000000000009");

    // A no-op round reports an empty delta.
    assert.deepEqual(diffDshHostStore(after, snapshotDshHostStore(home)), {
      addedSessionDirs: [],
      addedSessionFiles: [],
      addedStorageFiles: [],
    });
  });

  it("snapshotDshHostStore never follows a symlinked session leaf", () => {
    const home = path.join(root, "store-symlink-home");
    fs.mkdirSync(path.join(home, "sessions", "--proj--", "session-real"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "sessions", "--proj--", "session-real", "session.jsonl"),
      "{}\n",
      "utf-8",
    );
    // A symlinked leaf directory and a symlinked file MUST NOT be counted.
    const outside = path.join(root, "store-symlink-outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "session.v3.jsonl"), "{}\n", "utf-8");
    fs.symlinkSync(outside, path.join(home, "sessions", "--proj--", "session-linked"));
    fs.symlinkSync(
      path.join(outside, "session.v3.jsonl"),
      path.join(home, "sessions", "--proj--", "session-real", "session.linked.jsonl"),
    );

    const snapshot = snapshotDshHostStore(home);
    assert.deepEqual(snapshot.sessionDirs, [path.join("sessions", "--proj--", "session-real")]);
    assert.deepEqual(snapshot.sessionFiles, [
      path.join("sessions", "--proj--", "session-real", "session.jsonl"),
    ]);
  });
});
