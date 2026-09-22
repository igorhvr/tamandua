/**
 * home-alias.test.ts — unit coverage for the Matchlock short-HOME alias
 * (tamandua-6sy.33.10.27). Pure/deterministic: a real temp filesystem for the
 * happy paths plus an injected in-memory filesystem for the refusal matrix.
 * No child processes, no VMs, no daemons (parallel lane).
 */

import { describe, it, afterEach } from "node:test";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MATCHLOCK_HOME_ALIAS_ENV,
  MATCHLOCK_HOME_ALIAS_KEY_HEX_CHARS,
  MATCHLOCK_HOME_ALIAS_OWNER_FILE,
  MATCHLOCK_HOME_ALIAS_OWNER_MODE,
  MATCHLOCK_HOME_ALIAS_OWNER_SCHEMA,
  MATCHLOCK_HOME_ALIAS_PARENT_MODE,
  MATCHLOCK_HOME_ALIAS_UNTRUSTED_CODE,
  MATCHLOCK_LONGEST_SOCKET_FILE_NAME,
  MATCHLOCK_MACOS_SUN_PATH_USABLE_LIMIT,
  MATCHLOCK_SOCKET_PATH_ADDED_BYTES,
  MATCHLOCK_SOCKET_PATH_TOO_LONG_CODE,
  MATCHLOCK_SUN_PATH_BYTES,
  MATCHLOCK_SUN_PATH_USABLE_LIMIT,
  MATCHLOCK_VM_ID_HEX_CHARS,
  MATCHLOCK_VM_ID_PREFIX,
  MatchlockHomeAliasError,
  buildMatchlockProcessEnv,
  computeLongestMatchlockSocketPath,
  describeMatchlockHomeAlias,
  matchlockHomeAliasKey,
  matchlockHomeAliasOwnerPath,
  matchlockSocketPathRefusal,
  resolveMatchlockHomeAlias,
  type MatchlockHomeAliasFs,
  type MatchlockHomeAliasOwnerDeps,
  type MatchlockHomeAliasOwnerRecord,
  type MatchlockHomeAliasStats,
} from "../../../dist/installer/matchlock/home-alias.js";

// ── In-memory fs for the refusal matrix ─────────────────────────────

type FakeNode =
  | { kind: "dir"; uid: number; mode: number }
  | { kind: "file"; uid: number; mode: number }
  | { kind: "symlink"; uid: number; target: string };

function statsFor(node: FakeNode): MatchlockHomeAliasStats {
  const mode =
    node.kind === "dir"
      ? 0o040000 | node.mode
      : node.kind === "symlink"
        ? 0o120777
        : 0o100000 | node.mode;
  return {
    uid: node.uid,
    mode,
    isSymbolicLink: () => node.kind === "symlink",
    isDirectory: () => node.kind === "dir",
    isFile: () => node.kind === "file",
  };
}

class FakeAliasFs implements MatchlockHomeAliasFs {
  readonly nodes = new Map<string, FakeNode>();
  /** Regular-file contents (owner.json sidecars and test fixtures). */
  readonly contents = new Map<string, string>();
  fail: {
    mkdir?: Error;
    symlink?: Error;
    unlink?: Error;
    readlink?: Error;
    lstat?: Error;
    stat?: Error;
    chmod?: Error;
    readFile?: Error;
    writeFile?: Error;
    rename?: Error;
  } = {};
  readonly mkdirCalls: Array<{ path: string; mode: number }> = [];
  readonly symlinkCalls: Array<{ target: string; linkPath: string }> = [];
  readonly unlinkCalls: string[] = [];
  readonly chmodCalls: Array<{ path: string; mode: number }> = [];
  // Read-path recordings (US-002 fs-spy isolation proof).
  readonly lstatCalls: string[] = [];
  readonly statCalls: string[] = [];
  readonly readlinkCalls: string[] = [];
  readonly readFileCalls: string[] = [];
  readonly writeFileCalls: string[] = [];
  readonly renameCalls: Array<{ from: string; to: string }> = [];

  readonly uid: number;

  constructor(uid: number) {
    this.uid = uid;
  }

  private err(code: string, message: string): Error & { code: string } {
    const e = new Error(message) as Error & { code: string };
    e.code = code;
    return e;
  }

  addDir(p: string, uid: number, mode = 0o700): this {
    this.nodes.set(p, { kind: "dir", uid, mode });
    return this;
  }

  addFile(p: string, uid: number, mode = 0o644, content = ""): this {
    this.nodes.set(p, { kind: "file", uid, mode });
    this.contents.set(p, content);
    return this;
  }

  addSymlink(p: string, uid: number, target: string): this {
    this.nodes.set(p, { kind: "symlink", uid, target });
    return this;
  }

  lstatSync(p: string): MatchlockHomeAliasStats {
    this.lstatCalls.push(p);
    if (this.fail.lstat) throw this.fail.lstat;
    const node = this.nodes.get(p);
    if (!node) throw this.err("ENOENT", `lstat ${p}`);
    return statsFor(node);
  }

  statSync(p: string, depth = 0): MatchlockHomeAliasStats {
    this.statCalls.push(p);
    if (this.fail.stat) throw this.fail.stat;
    const node = this.nodes.get(p);
    if (!node) throw this.err("ENOENT", `stat ${p}`);
    if (node.kind === "symlink") {
      if (depth > 8) throw this.err("ELOOP", `stat ${p}`);
      const resolved = path.isAbsolute(node.target)
        ? node.target
        : path.resolve(path.dirname(p), node.target);
      return this.statSync(resolved, depth + 1);
    }
    return statsFor(node);
  }

  readlinkSync(p: string): string {
    this.readlinkCalls.push(p);
    if (this.fail.readlink) throw this.fail.readlink;
    const node = this.nodes.get(p);
    if (!node) throw this.err("ENOENT", `readlink ${p}`);
    if (node.kind !== "symlink") throw this.err("EINVAL", `readlink ${p}`);
    return node.target;
  }

  readFileSync(p: string, _encoding: "utf8"): string {
    this.readFileCalls.push(p);
    if (this.fail.readFile) throw this.fail.readFile;
    const node = this.nodes.get(p);
    if (!node) throw this.err("ENOENT", `readFile ${p}`);
    if (node.kind !== "file") throw this.err("EISDIR", `readFile ${p}`);
    return this.contents.get(p) ?? "";
  }

  writeFileSync(p: string, data: string, options: { encoding: "utf8"; mode: number }): void {
    this.writeFileCalls.push(p);
    if (this.fail.writeFile) throw this.fail.writeFile;
    this.nodes.set(p, { kind: "file", uid: this.uid, mode: options.mode & 0o777 });
    this.contents.set(p, data);
  }

  renameSync(oldPath: string, newPath: string): void {
    this.renameCalls.push({ from: oldPath, to: newPath });
    if (this.fail.rename) throw this.fail.rename;
    const node = this.nodes.get(oldPath);
    if (!node) throw this.err("ENOENT", `rename ${oldPath}`);
    const content = this.contents.get(oldPath);
    this.nodes.delete(oldPath);
    this.contents.delete(oldPath);
    this.nodes.set(newPath, node);
    if (content !== undefined) this.contents.set(newPath, content);
  }

  symlinkSync(target: string, linkPath: string): void {
    if (this.fail.symlink) throw this.fail.symlink;
    if (this.nodes.has(linkPath)) throw this.err("EEXIST", `symlink ${linkPath}`);
    this.symlinkCalls.push({ target, linkPath });
    this.nodes.set(linkPath, { kind: "symlink", uid: this.uid, target });
  }

  mkdirSync(p: string, options: { recursive: boolean; mode: number }): void {
    if (this.fail.mkdir) throw this.fail.mkdir;
    this.mkdirCalls.push({ path: p, mode: options.mode });
    if (this.nodes.has(p)) return;
    if (options.recursive) {
      const parent = path.dirname(p);
      if (parent !== p && !this.nodes.has(parent)) this.mkdirSync(parent, options);
    }
    this.nodes.set(p, { kind: "dir", uid: this.uid, mode: options.mode & 0o777 });
  }

  chmodSync(p: string, mode: number): void {
    if (this.fail.chmod) throw this.fail.chmod;
    const node = this.nodes.get(p);
    if (!node) throw this.err("ENOENT", `chmod ${p}`);
    this.chmodCalls.push({ path: p, mode });
    if (node.kind === "symlink") return;
    node.mode = mode & 0o777;
  }

  unlinkSync(p: string): void {
    if (this.fail.unlink) throw this.fail.unlink;
    if (!this.nodes.has(p)) throw this.err("ENOENT", `unlink ${p}`);
    this.unlinkCalls.push(p);
    this.nodes.delete(p);
    this.contents.delete(p);
  }
}

const UID = 1234;
const REAL_HOME = "/home/example";

/** Keyed layout fixtures for the default (UID, REAL_HOME) pair. */
const KEY = matchlockHomeAliasKey(REAL_HOME);
const UID_DIR = `/tmp/tamandua/${UID}`;
const ALIAS_DIR = `${UID_DIR}/${KEY}`;
const ALIAS = `${ALIAS_DIR}/h`;

function keyedAliasFor(uid: number, realHome: string, root = "/tmp"): string {
  return `${root}/tamandua/${uid}/${matchlockHomeAliasKey(realHome)}/h`;
}

function fakeDeps(io: FakeAliasFs, env: Record<string, string | undefined> = {}) {
  return {
    env: { HOME: REAL_HOME, ...env },
    fs: io,
    uid: UID,
    tmpdir: "/tmp",
    realHome: REAL_HOME,
  };
}

function assertRefusal(fn: () => unknown, reason: string, messagePart: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof MatchlockHomeAliasError, `expected MatchlockHomeAliasError, got ${String(caught)}`);
  const err = caught as MatchlockHomeAliasError;
  assert.equal(err.code, MATCHLOCK_HOME_ALIAS_UNTRUSTED_CODE);
  assert.equal(err.reason, reason);
  assert.match(err.message, new RegExp(messagePart));
}

// ── Ownership fixtures (US-002) ─────────────────────────────────────

const OWNER_PID = 4242;
const OWNER_START = "v2:4242:1700000000000";

function ownerDeps(
  over: Partial<MatchlockHomeAliasOwnerDeps> = {},
): MatchlockHomeAliasOwnerDeps {
  return {
    pid: OWNER_PID,
    startIdentity: OWNER_START,
    classifyOwner: () => "same",
    ...over,
  };
}

function ownerRecord(
  over: Partial<MatchlockHomeAliasOwnerRecord> = {},
): MatchlockHomeAliasOwnerRecord {
  return {
    schema: MATCHLOCK_HOME_ALIAS_OWNER_SCHEMA,
    pid: 9999,
    startIdentity: "v2:9999:1600000000000",
    realHome: "/old/home",
    aliasPath: ALIAS,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/** All filesystem paths a resolution touched, for the isolation spy. */
function touchedPaths(io: FakeAliasFs): string[] {
  return [
    ...io.lstatCalls,
    ...io.statCalls,
    ...io.readlinkCalls,
    ...io.readFileCalls,
    ...io.mkdirCalls.map((c) => c.path),
    ...io.symlinkCalls.map((c) => c.linkPath),
    ...io.unlinkCalls,
    ...io.chmodCalls.map((c) => c.path),
    ...io.writeFileCalls,
    ...io.renameCalls.flatMap((c) => [c.from, c.to]),
  ];
}

// ── Real temp filesystem happy paths ────────────────────────────────

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("home-alias default alias (real fs)", () => {
  it("creates the keyed <uid>/<k>/h layout with both levels 0700 and readlink == real HOME", () => {
    const root = tamanduaTempDir("tamandua-home-alias-");
    cleanups.push(root);
    const tmp = path.join(root, "tmp");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });

    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const resolved = describeMatchlockHomeAlias({ env: { HOME: home }, tmpdir: tmp, uid });

    const key = matchlockHomeAliasKey(home);
    const expectedUidDir = path.join(tmp, "tamandua", String(uid));
    const expectedKeyDir = path.join(expectedUidDir, key);
    const expectedAlias = path.join(expectedKeyDir, "h");
    assert.equal(resolved.home, expectedAlias);
    assert.equal(resolved.aliasPath, expectedAlias);
    assert.equal(resolved.aliasKey, key);
    assert.equal(resolved.aliasDir, expectedKeyDir);
    assert.equal(resolved.realHome, home);
    assert.equal(resolved.disabled, false);

    for (const dir of [expectedUidDir, expectedKeyDir]) {
      const st = fs.lstatSync(dir);
      assert.ok(st.isDirectory(), `${dir} must be a real directory`);
      assert.ok(!st.isSymbolicLink(), `${dir} must not be a symlink`);
      assert.equal(st.uid, uid);
      assert.equal(st.mode & 0o777, MATCHLOCK_HOME_ALIAS_PARENT_MODE);
    }

    const linkStat = fs.lstatSync(expectedAlias);
    assert.ok(linkStat.isSymbolicLink());
    assert.equal(linkStat.uid, uid);
    assert.equal(fs.readlinkSync(expectedAlias), home);
  });

  it("is reusable and repairs a wrong-but-live target", () => {
    const root = tamanduaTempDir("tamandua-home-alias-");
    cleanups.push(root);
    const tmp = path.join(root, "tmp");
    const home = path.join(root, "home");
    const stale = path.join(root, "stale");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(stale, { recursive: true });

    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const first = resolveMatchlockHomeAlias({ env: { HOME: home }, tmpdir: tmp, uid });
    assert.equal(resolveMatchlockHomeAlias({ env: { HOME: home }, tmpdir: tmp, uid }), first);

    fs.unlinkSync(first);
    fs.symlinkSync(stale, first);
    assert.equal(fs.readlinkSync(first), stale);

    const repaired = resolveMatchlockHomeAlias({ env: { HOME: home }, tmpdir: tmp, uid });
    assert.equal(repaired, first);
    assert.equal(fs.readlinkSync(first), home);
  });

  it("refuses a non-symlink entry at the keyed alias path instead of removing it", () => {
    const root = tamanduaTempDir("tamandua-home-alias-");
    cleanups.push(root);
    const tmp = path.join(root, "tmp");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });

    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const alias = path.join(tmp, "tamandua", String(uid), matchlockHomeAliasKey(home), "h");
    fs.mkdirSync(path.dirname(alias), { recursive: true, mode: 0o700 });
    fs.writeFileSync(alias, "not a symlink");

    assertRefusal(
      () => resolveMatchlockHomeAlias({ env: { HOME: home }, tmpdir: tmp, uid }),
      "alias_not_symlink",
      "not a symlink",
    );
    assert.ok(fs.lstatSync(alias).isFile());
  });

  it("ignores the legacy <uid>/h symlink: same inode and readlink after resolving the keyed alias", () => {
    const root = tamanduaTempDir("tamandua-home-alias-");
    cleanups.push(root);
    const tmp = path.join(root, "tmp");
    const home = path.join(root, "home");
    const legacyTarget = path.join(root, "legacy-home");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(legacyTarget, { recursive: true });

    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const uidDir = path.join(tmp, "tamandua", String(uid));
    fs.mkdirSync(uidDir, { recursive: true, mode: 0o700 });
    const legacyAlias = path.join(uidDir, "h");
    fs.symlinkSync(legacyTarget, legacyAlias);

    const before = fs.lstatSync(legacyAlias);
    const beforeTarget = fs.readlinkSync(legacyAlias);

    const resolved = resolveMatchlockHomeAlias({ env: { HOME: home }, tmpdir: tmp, uid });
    assert.notEqual(resolved, legacyAlias, "the keyed alias must not be the legacy path");

    const after = fs.lstatSync(legacyAlias);
    assert.equal(after.ino, before.ino, "legacy symlink inode must not change");
    assert.equal(fs.readlinkSync(legacyAlias), beforeTarget, "legacy symlink target must not change");
    assert.ok(after.isSymbolicLink());

    // The new keyed alias exists alongside it and points at the real HOME.
    assert.equal(fs.readlinkSync(resolved), home);
  });
});

// ── Escape hatch ────────────────────────────────────────────────────

describe("home-alias escape hatch", () => {
  it("disables the alias with off (case-insensitive) and 0", () => {
    for (const value of ["off", "OFF", "Off", "0"]) {
      const io = new FakeAliasFs(UID);
      io.addDir("/tmp", UID);
      io.addDir(REAL_HOME, UID);
      const resolved = describeMatchlockHomeAlias(
        fakeDeps(io, { [MATCHLOCK_HOME_ALIAS_ENV]: value }),
      );
      assert.equal(resolved.disabled, true, `value ${value}`);
      assert.equal(resolved.home, REAL_HOME);
      assert.equal(resolved.aliasPath, null);
      assert.equal(resolved.aliasKey, null);
      assert.equal(resolved.aliasDir, null);
      assert.equal(io.symlinkCalls.length, 0);
    }
  });

  it("treats an empty/whitespace override as unset (default keyed alias)", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    const resolved = describeMatchlockHomeAlias(
      fakeDeps(io, { [MATCHLOCK_HOME_ALIAS_ENV]: "   " }),
    );
    assert.equal(resolved.disabled, false);
    assert.equal(resolved.aliasPath, ALIAS);
    assert.equal(resolved.aliasKey, KEY);
    assert.equal(resolved.aliasDir, ALIAS_DIR);
  });

  it("uses the LITERAL /tmp default root regardless of TMPDIR (the alias must stay short)", () => {
    const io = new FakeAliasFs(UID);
    io.addDir("/tmp", UID);
    io.addDir(REAL_HOME, UID);
    // No `tmpdir` dep: exercise the production default with a deliberately deep
    // ambient TMPDIR. A platform-temp-derived alias would land inside the deep
    // TMPDIR (longer than the HOME it replaces); the literal /tmp alias must not.
    const resolved = describeMatchlockHomeAlias({
      env: { HOME: REAL_HOME, TMPDIR: "/evidence/very/deep/scratch/tmp" },
      fs: io,
      uid: UID,
      realHome: REAL_HOME,
    });
    assert.equal(resolved.aliasPath, ALIAS);
    assert.equal(resolved.home, ALIAS);
    assert.equal(io.symlinkCalls[0]?.linkPath, ALIAS);
  });

  it("uses an absolute override as the alias location", () => {
    const io = new FakeAliasFs(UID);
    io.addDir("/", UID, 0o755);
    io.addDir(REAL_HOME, UID);
    const resolved = resolveMatchlockHomeAlias(
      fakeDeps(io, { [MATCHLOCK_HOME_ALIAS_ENV]: "/short/al" }),
    );
    assert.equal(resolved, "/short/al");
    assert.equal(io.symlinkCalls.length, 1);
    assert.deepEqual(io.symlinkCalls[0], { target: REAL_HOME, linkPath: "/short/al" });
    assert.equal(io.nodes.get("/short/al")?.kind, "symlink");
    // An override is not keyed: it reports the parent directory, no key.
    const described = describeMatchlockHomeAlias(
      fakeDeps(io, { [MATCHLOCK_HOME_ALIAS_ENV]: "/short/al" }),
    );
    assert.equal(described.aliasKey, null);
    assert.equal(described.aliasDir, "/short");
  });

  it("refuses a non-absolute override", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io, { [MATCHLOCK_HOME_ALIAS_ENV]: "relative/path" })),
      "override_not_absolute",
      "absolute path",
    );
  });
});

// ── Verification / refusal matrix ───────────────────────────────────

describe("home-alias verification and refusal", () => {
  it("refuses an unset or empty HOME", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    assertRefusal(
      () => resolveMatchlockHomeAlias({ env: {}, fs: io, uid: UID, tmpdir: "/tmp", realHome: "" }),
      "home_unset",
      "HOME is unset or empty",
    );
  });

  it("refuses a relative HOME", () => {
    const io = new FakeAliasFs(UID);
    assertRefusal(
      () =>
        resolveMatchlockHomeAlias({
          env: {},
          fs: io,
          uid: UID,
          tmpdir: "/tmp",
          realHome: "relative/home",
        }),
      "home_not_absolute",
      "not an absolute path",
    );
  });

  it("refuses a non-symlink path", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addFile(ALIAS, UID);
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "alias_not_symlink",
      "is not a symlink",
    );
  });

  it("refuses an alias owned by another user", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addSymlink(ALIAS, 999, REAL_HOME);
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "alias_wrong_owner",
      "owned by uid 999",
    );
  });

  it("repairs a wrong-but-live target", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addDir("/old/home", UID);
    io.addSymlink(ALIAS, UID, "/old/home");
    const resolved = resolveMatchlockHomeAlias(fakeDeps(io));
    assert.equal(resolved, ALIAS);
    assert.equal(io.nodes.get(ALIAS)?.kind, "symlink");
    assert.equal(io.readlinkSync(ALIAS), REAL_HOME);
    assert.deepEqual(io.unlinkCalls, [ALIAS]);
  });

  it("refuses a wrong target that cannot be replaced", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addDir("/old/home", UID);
    io.addSymlink(ALIAS, UID, "/old/home");
    io.fail.unlink = Object.assign(new Error("read-only"), { code: "EROFS" });
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "alias_wrong_target",
      "cannot be replaced",
    );
  });

  it("refuses a dangling symlink", () => {
    const io = new FakeAliasFs(UID);
    io.addSymlink(ALIAS, UID, "/does/not/exist");
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "alias_dangling",
      "dangling symlink",
    );
  });

  it("refuses when the alias matches but the real HOME is missing", () => {
    const io = new FakeAliasFs(UID);
    io.addSymlink(ALIAS, UID, REAL_HOME);
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "alias_dangling",
      "does not exist",
    );
  });

  it("refuses when the alias parent cannot be created", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.fail.mkdir = Object.assign(new Error("denied"), { code: "EACCES" });
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "parent_unwritable",
      "cannot be created",
    );
  });

  it("refuses when the alias parent is not a directory", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addFile(UID_DIR, UID);
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "parent_untrusted",
      "not a real directory",
    );
  });

  it("refuses when the default parent is owned by another user", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addDir(UID_DIR, 999, 0o700);
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "parent_untrusted",
      "owned by uid 999",
    );
  });

  it("tightens a wrong default parent mode and then succeeds", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addDir(UID_DIR, UID, 0o755);
    const resolved = resolveMatchlockHomeAlias(fakeDeps(io));
    assert.equal(resolved, ALIAS);
    assert.deepEqual(io.chmodCalls, [
      { path: UID_DIR, mode: MATCHLOCK_HOME_ALIAS_PARENT_MODE },
    ]);
  });

  it("creates both keyed levels at 0700 owned by the uid", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    resolveMatchlockHomeAlias(fakeDeps(io));
    for (const dir of [UID_DIR, ALIAS_DIR]) {
      const node = io.nodes.get(dir);
      assert.equal(node?.kind, "dir", `${dir} must be a directory`);
      assert.equal(node?.uid, UID, `${dir} must be owned by the uid`);
      if (node?.kind === "dir") assert.equal(node.mode, 0o700, `${dir} must be 0700`);
    }
  });

  it("refuses a symlink at the uid level (never follows a planted link)", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addDir("/some/real/dir", UID);
    io.addSymlink(UID_DIR, UID, "/some/real/dir");
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "parent_untrusted",
      "not a real directory",
    );
    assert.deepEqual(io.symlinkCalls, [], "no alias may be created under a symlinked uid dir");
  });

  it("refuses a symlink at the key level (never follows a planted link)", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addDir(UID_DIR, UID, 0o700);
    io.addDir("/some/real/dir", UID);
    io.addSymlink(ALIAS_DIR, UID, "/some/real/dir");
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "parent_untrusted",
      "not a real directory",
    );
    assert.deepEqual(io.symlinkCalls, [], "no alias may be created under a symlinked key dir");
  });

  it("refuses a key directory owned by another user", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addDir(UID_DIR, UID, 0o700);
    io.addDir(ALIAS_DIR, 999, 0o700);
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "parent_untrusted",
      "owned by uid 999",
    );
  });

  it("never touches the legacy <uid>/h symlink when using another key (fs spy)", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addDir(UID_DIR, UID, 0o700);
    io.addDir("/legacy/home", UID);
    const legacy = `${UID_DIR}/h`;
    io.addSymlink(legacy, UID, "/legacy/home");
    const lsatBefore = io.lstatSync(legacy);
    const linkBefore = io.readlinkSync(legacy);

    resolveMatchlockHomeAlias(fakeDeps(io));

    assert.equal(io.readlinkSync(legacy), linkBefore);
    assert.equal(io.lstatSync(legacy).uid, lsatBefore.uid);
    assert.ok(!io.unlinkCalls.includes(legacy), "the legacy symlink must never be unlinked");
    assert.ok(
      !io.symlinkCalls.some((call) => call.linkPath === legacy),
      "the legacy symlink must never be re-pointed",
    );
  });
});

// ── Owner sidecar + live-holder protocol (US-002) ───────────────────

describe("home-alias owner sidecar (US-002)", () => {
  it("writes <aliasDir>/owner.json 0600 with pid, a v2 startIdentity, realHome, aliasPath and updatedAt", () => {
    const root = tamanduaTempDir("tamandua-home-alias-owner-");
    cleanups.push(root);
    const tmp = path.join(root, "tmp");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });

    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const fixed = new Date("2026-09-22T01:02:03.000Z");
    const resolved = describeMatchlockHomeAlias({
      env: { HOME: home },
      tmpdir: tmp,
      uid,
      owner: ownerDeps(),
      now: () => fixed,
    });

    assert.ok(resolved.aliasDir);
    const ownerPath = matchlockHomeAliasOwnerPath(resolved.aliasDir);
    assert.equal(ownerPath, path.join(resolved.aliasDir, MATCHLOCK_HOME_ALIAS_OWNER_FILE));
    const st = fs.lstatSync(ownerPath);
    assert.ok(st.isFile(), "owner.json must be a regular file");
    assert.equal(st.mode & 0o777, MATCHLOCK_HOME_ALIAS_OWNER_MODE, "owner.json must be 0600");

    const record = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as MatchlockHomeAliasOwnerRecord;
    assert.equal(record.schema, MATCHLOCK_HOME_ALIAS_OWNER_SCHEMA);
    assert.equal(record.pid, OWNER_PID);
    assert.match(record.startIdentity, /^v2:4242:\d+$/);
    assert.equal(record.realHome, home);
    assert.equal(record.aliasPath, resolved.aliasPath);
    assert.equal(record.updatedAt, fixed.toISOString());
  });

  it("re-resolving from the same process reuses/refreshes its own sidecar and never refuses", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    const first = describeMatchlockHomeAlias({ ...fakeDeps(io), owner: ownerDeps() });
    const second = describeMatchlockHomeAlias({ ...fakeDeps(io), owner: ownerDeps() });
    assert.equal(first.home, ALIAS);
    assert.equal(second.home, ALIAS);
    assert.deepEqual(io.unlinkCalls, [], "our own alias is never re-pointed");
    assert.deepEqual(io.symlinkCalls.length, 1, "the alias symlink is created once");
    const record = JSON.parse(
      io.contents.get(matchlockHomeAliasOwnerPath(ALIAS_DIR)) ?? "{}",
    ) as MatchlockHomeAliasOwnerRecord;
    assert.equal(record.pid, OWNER_PID);
    assert.equal(record.startIdentity, OWNER_START);
  });

  it("refuses a live holder with alias_owned_by_live_daemon naming pid, startIdentity, realHome and alias path", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addDir("/old/home", UID);
    io.addSymlink(ALIAS, UID, "/old/home");
    io.addFile(
      matchlockHomeAliasOwnerPath(ALIAS_DIR),
      UID,
      0o600,
      JSON.stringify(ownerRecord()),
    );
    const nodeBefore = io.nodes.get(ALIAS);
    const targetBefore = io.readlinkSync(ALIAS);

    let caught: unknown;
    try {
      describeMatchlockHomeAlias({
        ...fakeDeps(io),
        owner: ownerDeps({ classifyOwner: () => "same" }),
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof MatchlockHomeAliasError, `expected typed refusal, got ${String(caught)}`);
    const err = caught as MatchlockHomeAliasError;
    assert.equal(err.code, MATCHLOCK_HOME_ALIAS_UNTRUSTED_CODE);
    assert.equal(err.reason, "alias_owned_by_live_daemon");
    for (const part of ["9999", "v2:9999:1600000000000", "/old/home", ALIAS]) {
      assert.ok(err.message.includes(part), `message must name "${part}": ${err.message}`);
    }

    // The refusal leaves the symlink byte-identical (same entry, same target).
    assert.equal(io.nodes.get(ALIAS), nodeBefore, "the symlink entry must not be replaced");
    assert.equal(io.readlinkSync(ALIAS), targetBefore, "the symlink target must not change");
    assert.deepEqual(io.unlinkCalls, [], "a live holder's alias must never be unlinked");
    assert.deepEqual(io.symlinkCalls, [], "a live holder's alias must never be re-pointed");
  });

  it("a live-holder refusal leaves the REAL alias inode and readlink unchanged", () => {
    const root = tamanduaTempDir("tamandua-home-alias-live-");
    cleanups.push(root);
    const tmp = path.join(root, "tmp");
    const home = path.join(root, "home");
    const other = path.join(root, "other-home");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(other, { recursive: true });

    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const aliasDir = path.join(tmp, "tamandua", String(uid), matchlockHomeAliasKey(home));
    fs.mkdirSync(aliasDir, { recursive: true, mode: 0o700 });
    const alias = path.join(aliasDir, "h");
    fs.symlinkSync(other, alias);
    fs.writeFileSync(
      matchlockHomeAliasOwnerPath(aliasDir),
      JSON.stringify(ownerRecord({ realHome: other, aliasPath: alias })),
      { mode: 0o600 },
    );

    const inoBefore = fs.lstatSync(alias).ino;
    const targetBefore = fs.readlinkSync(alias);
    assert.throws(
      () =>
        describeMatchlockHomeAlias({
          env: { HOME: home },
          tmpdir: tmp,
          uid,
          owner: ownerDeps({ classifyOwner: () => "same" }),
        }),
      (err: unknown) =>
        err instanceof MatchlockHomeAliasError && err.reason === "alias_owned_by_live_daemon",
    );
    assert.equal(fs.lstatSync(alias).ino, inoBefore, "the symlink inode must not change");
    assert.equal(fs.readlinkSync(alias), targetBefore, "the symlink target must not change");
    assert.ok(fs.lstatSync(alias).isSymbolicLink());
  });

  it("takes over a stale (dead) owner: re-points and rewrites the sidecar with our identity", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addDir("/old/home", UID);
    io.addSymlink(ALIAS, UID, "/old/home");
    io.addFile(
      matchlockHomeAliasOwnerPath(ALIAS_DIR),
      UID,
      0o600,
      JSON.stringify(ownerRecord({ pid: 8888, startIdentity: "v2:8888:1500000000000" })),
    );

    const resolved = describeMatchlockHomeAlias({
      ...fakeDeps(io),
      owner: ownerDeps({ classifyOwner: () => "different" }),
    });

    assert.equal(resolved.home, ALIAS);
    assert.equal(io.readlinkSync(ALIAS), REAL_HOME, "a stale alias is re-pointed at our HOME");
    assert.deepEqual(io.unlinkCalls, [ALIAS]);
    const record = JSON.parse(
      io.contents.get(matchlockHomeAliasOwnerPath(ALIAS_DIR)) ?? "{}",
    ) as MatchlockHomeAliasOwnerRecord;
    assert.equal(record.pid, OWNER_PID);
    assert.equal(record.startIdentity, OWNER_START);
    assert.equal(record.realHome, REAL_HOME);
  });

  it("repairs an alias pointing elsewhere when there is no owner sidecar", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addDir("/old/home", UID);
    io.addSymlink(ALIAS, UID, "/old/home");

    const resolved = describeMatchlockHomeAlias({ ...fakeDeps(io), owner: ownerDeps() });

    assert.equal(resolved.home, ALIAS);
    assert.equal(io.readlinkSync(ALIAS), REAL_HOME);
    assert.ok(io.contents.has(matchlockHomeAliasOwnerPath(ALIAS_DIR)), "ownership is adopted");
  });

  it("refuses a malformed sidecar with alias_owner_unreadable naming the path, without re-pointing", () => {
    for (const raw of ["{ not json", JSON.stringify({ schema: "other", pid: 1 })]) {
      const io = new FakeAliasFs(UID);
      io.addDir(REAL_HOME, UID);
      io.addDir("/old/home", UID);
      io.addSymlink(ALIAS, UID, "/old/home");
      const ownerPath = matchlockHomeAliasOwnerPath(ALIAS_DIR);
      io.addFile(ownerPath, UID, 0o600, raw);

      let caught: unknown;
      try {
        describeMatchlockHomeAlias({ ...fakeDeps(io), owner: ownerDeps() });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof MatchlockHomeAliasError, `expected typed refusal for ${raw}`);
      const err = caught as MatchlockHomeAliasError;
      assert.equal(err.reason, "alias_owner_unreadable");
      assert.ok(err.message.includes(ownerPath), `message must name the sidecar path: ${err.message}`);
      assert.equal(io.readlinkSync(ALIAS), "/old/home", "a malformed sidecar must not be re-pointed");
      assert.deepEqual(io.unlinkCalls, []);
    }
  });

  it("fails closed (alias_owner_unreadable) when a recorded owner's liveness is unknown", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addDir("/old/home", UID);
    io.addSymlink(ALIAS, UID, "/old/home");
    const ownerPath = matchlockHomeAliasOwnerPath(ALIAS_DIR);
    io.addFile(ownerPath, UID, 0o600, JSON.stringify(ownerRecord()));

    let caught: unknown;
    try {
      describeMatchlockHomeAlias({
        ...fakeDeps(io),
        owner: ownerDeps({ classifyOwner: () => "unknown" }),
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof MatchlockHomeAliasError, `expected typed refusal, got ${String(caught)}`);
    const err = caught as MatchlockHomeAliasError;
    assert.equal(err.reason, "alias_owner_unreadable");
    assert.ok(err.message.includes(ownerPath));
    assert.equal(io.readlinkSync(ALIAS), "/old/home", "unknown liveness must not re-point");
    assert.deepEqual(io.unlinkCalls, []);
  });

  it("resolving daemon B's key never touches daemon A's <k> dir or the legacy <uid>/h (fs spy)", () => {
    const homeA = "/home/a";
    const homeB = "/home/b";
    const keyA = matchlockHomeAliasKey(homeA);
    const io = new FakeAliasFs(UID);
    io.addDir(homeA, UID);
    io.addDir(homeB, UID);
    io.addDir(UID_DIR, UID, 0o700);
    io.addDir(`${UID_DIR}/${keyA}`, UID, 0o700);
    io.addSymlink(`${UID_DIR}/${keyA}/h`, UID, homeA);
    const legacy = `${UID_DIR}/h`;
    io.addDir("/legacy/home", UID);
    io.addSymlink(legacy, UID, "/legacy/home");

    describeMatchlockHomeAlias({
      env: { HOME: homeB },
      fs: io,
      uid: UID,
      tmpdir: "/tmp",
      realHome: homeB,
      owner: ownerDeps(),
    });

    const aPrefix = `${UID_DIR}/${keyA}`;
    for (const touched of touchedPaths(io)) {
      assert.ok(
        !(touched === aPrefix || touched.startsWith(`${aPrefix}/`)),
        `resolving B must never touch A's key dir: ${touched}`,
      );
      assert.notEqual(touched, legacy, `resolving B must never touch the legacy alias: ${touched}`);
    }
    assert.equal(io.readlinkSync(keyedAliasFor(UID, homeB)), homeB, "B's own alias is created");
  });

  it("home-alias.ts imports only Node-core leaf modules (never the process-spawning host module)", () => {
    const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "home-alias.ts");
    const source = fs.readFileSync(sourcePath, "utf8");
    const specifiers = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
    // `node:crypto` is required for the sha256 per-daemon key; `node:os` is
    // accepted so the assertion stays an explicit Node-core allowlist rather
    // than a brittle exact-match. The point is the ABSENCE of relative/host
    // imports (in particular ../lib/process-start-identity.js).
    const allowed = new Set(["node:fs", "node:os", "node:path", "node:crypto"]);
    assert.ok(specifiers.length > 0, "must find home-alias.ts import specifiers");
    for (const spec of specifiers) {
      assert.ok(spec.startsWith("node:"), `home-alias.ts must import only Node core, saw "${spec}"`);
      assert.ok(allowed.has(spec), `home-alias.ts import "${spec}" is not a permitted leaf builtin`);
    }
    assert.ok(
      !specifiers.includes("../lib/process-start-identity.js"),
      "home-alias.ts must not import the process-spawning host module",
    );
    assert.ok(!specifiers.includes("node:child_process"), "home-alias.ts must not import child_process");
  });
});

// ── Per-daemon key ──────────────────────────────────────────────────

describe("matchlockHomeAliasKey", () => {
  it("is deterministic and 6-8 lowercase hex chars", () => {
    const key = matchlockHomeAliasKey(REAL_HOME);
    assert.equal(key, matchlockHomeAliasKey(REAL_HOME));
    assert.equal(key, KEY);
    assert.equal(key.length, MATCHLOCK_HOME_ALIAS_KEY_HEX_CHARS);
    assert.ok(key.length >= 6 && key.length <= 8, "key must be 6-8 chars");
    assert.match(key, /^[0-9a-f]{6,8}$/);
  });

  it("normalizes a trailing slash like the resolver", () => {
    assert.equal(matchlockHomeAliasKey(REAL_HOME + "/"), matchlockHomeAliasKey(REAL_HOME));
  });

  it("returns distinct keys for distinct homes of the same uid", () => {
    const homes = ["/home/alice", "/home/bob", "/home/example", "/home/alice-longer"];
    const keys = homes.map((h) => matchlockHomeAliasKey(h));
    assert.equal(new Set(keys).size, homes.length, "distinct homes must map to distinct keys");
  });

  it("does not change when a different uid shares the same home", () => {
    // The key is a function of the REAL home only; the uid is a separate path
    // segment, so two uids cannot silently collide on one key directory.
    assert.equal(matchlockHomeAliasKey(REAL_HOME), KEY);
  });
});

// ── buildMatchlockProcessEnv ────────────────────────────────────────

describe("buildMatchlockProcessEnv", () => {
  it("replaces only HOME and preserves every other entry", () => {
    const base = { HOME: "/long/real/home", PATH: "/usr/bin", FOO: "bar", EMPTY: "" };
    const env = buildMatchlockProcessEnv(base, ALIAS);
    assert.deepEqual(env, {
      HOME: ALIAS,
      PATH: "/usr/bin",
      FOO: "bar",
      EMPTY: "",
    });
    // The input is not mutated.
    assert.equal(base.HOME, "/long/real/home");
  });

  it("keeps the real HOME when the alias is disabled", () => {
    const env = buildMatchlockProcessEnv({ HOME: "/long/real/home", X: "1" }, "/long/real/home");
    assert.equal(env.HOME, "/long/real/home");
    assert.equal(env.X, "1");
  });

  it("refuses an empty alias HOME", () => {
    assertRefusal(() => buildMatchlockProcessEnv({}, ""), "home_unset", "empty HOME");
  });
});

// ── Pre-flight SUN_LEN socket-path guard (US-004) ───────────────────

describe("computeLongestMatchlockSocketPath", () => {
  it("derives the longest path from the Matchlock layout constants", () => {
    // Read-only reference /opt/matchlock:
    //   pkg/state/state.go NewManager     -> <home>/.matchlock/vms
    //   pkg/api/config.go  GetID          -> "vm-" + uuid[:8]
    //   pkg/state/state.go SocketPath     -> <base>/<id>/socket
    //   pkg/sandbox/sandbox_linux.go      -> SocketPath + ".sock" (socket.sock)
    //     and the VFS UDS %s_%d of vsock.sock with VsockPortVFS=5001
    //     (pkg/vm/linux/backend.go)      -> <id>/vsock.sock_5001 (longest)
    assert.equal(MATCHLOCK_VM_ID_PREFIX, "vm-");
    assert.equal(MATCHLOCK_VM_ID_HEX_CHARS, 8);
    assert.equal(MATCHLOCK_LONGEST_SOCKET_FILE_NAME, "vsock.sock_5001");
    assert.equal(
      computeLongestMatchlockSocketPath("/home/alice"),
      "/home/alice/.matchlock/vms/vm-00000000/vsock.sock_5001",
    );
  });

  it("adds a fixed 43 bytes to HOME (the layout offset)", () => {
    assert.equal(MATCHLOCK_SOCKET_PATH_ADDED_BYTES, 43);
    for (const home of [ALIAS, "/" + "a".repeat(69), "/home/someone/with/a/long/path"]) {
      assert.equal(
        Buffer.byteLength(computeLongestMatchlockSocketPath(home), "utf8"),
        Buffer.byteLength(home, "utf8") + MATCHLOCK_SOCKET_PATH_ADDED_BYTES,
      );
    }
  });

  it("normalizes a trailing slash the way Go filepath.Join does", () => {
    assert.equal(
      computeLongestMatchlockSocketPath("/home/alice/"),
      "/home/alice/.matchlock/vms/vm-00000000/vsock.sock_5001",
    );
  });
});

/**
 * Build an absolute HOME whose longest Matchlock socket path is exactly
 * `total` bytes (the fixed layout adds 43; the leading "/" is part of HOME).
 */
function homeWithSocketPathBytes(total: number): string {
  return "/" + "a".repeat(total - MATCHLOCK_SOCKET_PATH_ADDED_BYTES - 1);
}

describe("matchlockSocketPathRefusal", () => {
  it("does not refuse a short default alias HOME", () => {
    const home = ALIAS;
    assert.equal(matchlockSocketPathRefusal(home), null);
    assert.ok(
      Buffer.byteLength(computeLongestMatchlockSocketPath(home), "utf8") <
        MATCHLOCK_SUN_PATH_USABLE_LIMIT,
    );
  });

  it("does not refuse a path whose length is exactly the 107-byte usable limit", () => {
    const home = homeWithSocketPathBytes(MATCHLOCK_SUN_PATH_USABLE_LIMIT);
    const longest = computeLongestMatchlockSocketPath(home);
    assert.equal(Buffer.byteLength(longest, "utf8"), 107);
    assert.equal(matchlockSocketPathRefusal(home), null);
  });

  it("refuses as soon as the path reaches 108 bytes, naming the limit, length, HOME and remedy", () => {
    const home = homeWithSocketPathBytes(MATCHLOCK_SUN_PATH_BYTES);
    const refusal = matchlockSocketPathRefusal(home);
    assert.ok(refusal, "a 108-byte socket path must be refused");
    assert.equal(refusal.length, 108);
    assert.equal(refusal.limit, 107);
    assert.equal(refusal.limit, MATCHLOCK_SUN_PATH_USABLE_LIMIT);
    assert.equal(refusal.home, home);
    assert.equal(refusal.path, computeLongestMatchlockSocketPath(home));
    assert.match(refusal.message, /107/);
    assert.ok(refusal.message.includes(String(refusal.length)), "message names the computed length");
    assert.ok(refusal.message.includes(home), "message names the HOME in use");
    assert.ok(refusal.message.includes(MATCHLOCK_HOME_ALIAS_ENV), "message names the remedy env var");
    assert.match(refusal.message, /short-HOME alias/);
  });

  it("refuses the 90-char HOME that failed the real-model qualification (run #70)", () => {
    const longHome = "/" + "h".repeat(89);
    assert.equal(longHome.length, 90);
    const refusal = matchlockSocketPathRefusal(longHome);
    assert.ok(refusal, "a 90-char HOME must be refused");
    assert.equal(refusal.length, 133);
    // The default per-uid alias for the SAME user is short enough.
    assert.equal(matchlockSocketPathRefusal(ALIAS), null);
  });

  it("counts multi-byte HOME characters as UTF-8 bytes", () => {
    // 60 three-byte chars + 30 ASCII = 210 bytes, well over 107 after the
    // 43-byte layout offset; the byte length (not code-point count) decides.
    const home = "/" + "é".repeat(60);
    const refusal = matchlockSocketPathRefusal(home);
    assert.ok(refusal);
    assert.equal(refusal.length, Buffer.byteLength(home, "utf8") + MATCHLOCK_SOCKET_PATH_ADDED_BYTES);
  });

  it("exposes the typed refusal code consumers must surface", () => {
    assert.equal(MATCHLOCK_SOCKET_PATH_TOO_LONG_CODE, "matchlock_home_socket_path_too_long");
  });
});

describe("long-HOME alias resolution (US-005 / item 1c)", () => {
  it("resolves a >=90-char real HOME to a keyed alias under BOTH 107 and 103 bytes", () => {
    // >= 90-char real HOME, the size class that failed the real-model
    // qualification (run #70) before the alias existed.
    const longHome = "/home/" + "very-long-home-segment/".repeat(4) + "user";
    assert.ok(longHome.length >= 90, `fixture HOME must be >= 90 chars (got ${longHome.length})`);

    // Without the alias the long real HOME exceeds the sun_path limit...
    const realRefusal = matchlockSocketPathRefusal(longHome);
    assert.ok(realRefusal, "the long real HOME must be refused without the alias");
    assert.equal(realRefusal.limit, MATCHLOCK_SUN_PATH_USABLE_LIMIT);
    assert.ok(realRefusal.length > 107);
    // ...and it also exceeds the stricter macOS limit.
    assert.ok(
      Buffer.byteLength(computeLongestMatchlockSocketPath(longHome), "utf8") >
        MATCHLOCK_MACOS_SUN_PATH_USABLE_LIMIT,
    );

    // ...but the DEFAULT keyed alias for the same user resolves short enough
    // that the computed socket path fits (and the alias target is the real HOME
    // so image cache / kernel cache / VM registry stay shared).
    const io = new FakeAliasFs(UID).addDir(longHome, UID);
    const resolved = describeMatchlockHomeAlias({
      env: { HOME: longHome },
      fs: io,
      uid: UID,
      tmpdir: "/tmp",
      realHome: longHome,
    });
    assert.equal(resolved.disabled, false);
    assert.equal(resolved.realHome, longHome);
    assert.equal(resolved.home, keyedAliasFor(UID, longHome));
    assert.equal(resolved.aliasKey, matchlockHomeAliasKey(longHome));
    const longest = computeLongestMatchlockSocketPath(resolved.home);
    const longestBytes = Buffer.byteLength(longest, "utf8");
    assert.ok(
      longestBytes < MATCHLOCK_SUN_PATH_USABLE_LIMIT,
      `alias socket path must fit under ${MATCHLOCK_SUN_PATH_USABLE_LIMIT} bytes (got ${longestBytes}: ${longest})`,
    );
    assert.ok(
      longestBytes < MATCHLOCK_MACOS_SUN_PATH_USABLE_LIMIT,
      `alias socket path must fit under the macOS ${MATCHLOCK_MACOS_SUN_PATH_USABLE_LIMIT} bytes (got ${longestBytes}: ${longest})`,
    );
    assert.equal(matchlockSocketPathRefusal(resolved.home), null);
    assert.equal(io.readlinkSync(resolved.home), longHome);
  });
});

// ── Keyed path-length proof (item 1: the extra <k> segment) ─────────

describe("keyed alias path-length proof", () => {
  it("exposes the Linux 107 and macOS 103 usable sun_path limits", () => {
    assert.equal(MATCHLOCK_SUN_PATH_USABLE_LIMIT, 107);
    assert.equal(MATCHLOCK_MACOS_SUN_PATH_USABLE_LIMIT, 103);
    assert.ok(MATCHLOCK_MACOS_SUN_PATH_USABLE_LIMIT < MATCHLOCK_SUN_PATH_USABLE_LIMIT);
  });

  it("fits BOTH limits for a worst-case uid and the longest real HOME", () => {
    // 4294967294 is the largest conventional Linux uid (10 digits), so the
    // <uid> path segment is at its widest; the <k> segment adds 8 more.
    const worstUid = 4294967294;
    const realHome = "/" + "h".repeat(89); // 90-char real HOME
    const io = new FakeAliasFs(worstUid).addDir(realHome, worstUid);
    const resolved = describeMatchlockHomeAlias({
      env: { HOME: realHome },
      fs: io,
      uid: worstUid,
      tmpdir: "/tmp",
      realHome,
    });

    assert.equal(
      resolved.home,
      `/tmp/tamandua/${worstUid}/${matchlockHomeAliasKey(realHome)}/h`,
    );
    const longest = computeLongestMatchlockSocketPath(resolved.home);
    const bytes = Buffer.byteLength(longest, "utf8");
    assert.ok(
      bytes < MATCHLOCK_SUN_PATH_USABLE_LIMIT,
      `keyed socket path must fit the Linux limit (got ${bytes}: ${longest})`,
    );
    assert.ok(
      bytes < MATCHLOCK_MACOS_SUN_PATH_USABLE_LIMIT,
      `keyed socket path must fit the macOS limit (got ${bytes}: ${longest})`,
    );

    // The extra keyed segments cost exactly the <k> length plus one separator
    // beyond a hypothetical unkeyed /tmp/tamandua/<uid>/h alias, and the keyed
    // path is still tens of bytes below the stricter macOS limit.
    const unkeyed = `/tmp/tamandua/${worstUid}/h`;
    const keyedBytes = Buffer.byteLength(computeLongestMatchlockSocketPath(resolved.home), "utf8");
    const unkeyedBytes = Buffer.byteLength(computeLongestMatchlockSocketPath(unkeyed), "utf8");
    assert.equal(keyedBytes - unkeyedBytes, MATCHLOCK_HOME_ALIAS_KEY_HEX_CHARS + 1);
    assert.ok(MATCHLOCK_MACOS_SUN_PATH_USABLE_LIMIT - keyedBytes >= 20);
  });
});
