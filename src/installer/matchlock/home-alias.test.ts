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
import {
  MATCHLOCK_HOME_ALIAS_ENV,
  MATCHLOCK_HOME_ALIAS_PARENT_MODE,
  MATCHLOCK_HOME_ALIAS_UNTRUSTED_CODE,
  MATCHLOCK_LONGEST_SOCKET_FILE_NAME,
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
  matchlockSocketPathRefusal,
  resolveMatchlockHomeAlias,
  type MatchlockHomeAliasFs,
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
  };
}

class FakeAliasFs implements MatchlockHomeAliasFs {
  readonly nodes = new Map<string, FakeNode>();
  fail: {
    mkdir?: Error;
    symlink?: Error;
    unlink?: Error;
    readlink?: Error;
    lstat?: Error;
    stat?: Error;
    chmod?: Error;
  } = {};
  readonly mkdirCalls: Array<{ path: string; mode: number }> = [];
  readonly symlinkCalls: Array<{ target: string; linkPath: string }> = [];
  readonly unlinkCalls: string[] = [];
  readonly chmodCalls: Array<{ path: string; mode: number }> = [];

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

  addFile(p: string, uid: number, mode = 0o644): this {
    this.nodes.set(p, { kind: "file", uid, mode });
    return this;
  }

  addSymlink(p: string, uid: number, target: string): this {
    this.nodes.set(p, { kind: "symlink", uid, target });
    return this;
  }

  lstatSync(p: string): MatchlockHomeAliasStats {
    if (this.fail.lstat) throw this.fail.lstat;
    const node = this.nodes.get(p);
    if (!node) throw this.err("ENOENT", `lstat ${p}`);
    return statsFor(node);
  }

  statSync(p: string, depth = 0): MatchlockHomeAliasStats {
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
    if (this.fail.readlink) throw this.fail.readlink;
    const node = this.nodes.get(p);
    if (!node) throw this.err("ENOENT", `readlink ${p}`);
    if (node.kind !== "symlink") throw this.err("EINVAL", `readlink ${p}`);
    return node.target;
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
  }
}

const UID = 1234;
const REAL_HOME = "/home/example";

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

// ── Real temp filesystem happy paths ────────────────────────────────

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("home-alias default alias (real fs)", () => {
  it("creates /tmp-style parent 0700 and a symlink whose readlink is the real HOME exactly", () => {
    const root = tamanduaTempDir("tamandua-home-alias-");
    cleanups.push(root);
    const tmp = path.join(root, "tmp");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });

    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const resolved = describeMatchlockHomeAlias({ env: { HOME: home }, tmpdir: tmp, uid });

    const expectedAlias = path.join(tmp, "tamandua", String(uid), "h");
    assert.equal(resolved.home, expectedAlias);
    assert.equal(resolved.aliasPath, expectedAlias);
    assert.equal(resolved.realHome, home);
    assert.equal(resolved.disabled, false);

    const parent = path.join(tmp, "tamandua", String(uid));
    const parentStat = fs.statSync(parent);
    assert.ok(parentStat.isDirectory());
    assert.equal(parentStat.uid, uid);
    assert.equal(parentStat.mode & 0o777, MATCHLOCK_HOME_ALIAS_PARENT_MODE);

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

  it("refuses a non-symlink entry instead of removing it", () => {
    const root = tamanduaTempDir("tamandua-home-alias-");
    cleanups.push(root);
    const tmp = path.join(root, "tmp");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });

    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const alias = path.join(tmp, "tamandua", String(uid), "h");
    fs.mkdirSync(path.dirname(alias), { recursive: true, mode: 0o700 });
    fs.writeFileSync(alias, "not a symlink");

    assertRefusal(
      () => resolveMatchlockHomeAlias({ env: { HOME: home }, tmpdir: tmp, uid }),
      "alias_not_symlink",
      "not a symlink",
    );
    assert.ok(fs.lstatSync(alias).isFile());
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
      assert.equal(io.symlinkCalls.length, 0);
    }
  });

  it("treats an empty/whitespace override as unset (default alias)", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    const resolved = describeMatchlockHomeAlias(
      fakeDeps(io, { [MATCHLOCK_HOME_ALIAS_ENV]: "   " }),
    );
    assert.equal(resolved.disabled, false);
    assert.equal(resolved.aliasPath, "/tmp/tamandua/1234/h");
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
    assert.equal(resolved.aliasPath, "/tmp/tamandua/1234/h");
    assert.equal(resolved.home, "/tmp/tamandua/1234/h");
    assert.equal(io.symlinkCalls[0]?.linkPath, "/tmp/tamandua/1234/h");
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
    io.addFile("/tmp/tamandua/1234/h", UID);
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "alias_not_symlink",
      "is not a symlink",
    );
  });

  it("refuses an alias owned by another user", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addSymlink("/tmp/tamandua/1234/h", 999, REAL_HOME);
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
    io.addSymlink("/tmp/tamandua/1234/h", UID, "/old/home");
    const resolved = resolveMatchlockHomeAlias(fakeDeps(io));
    assert.equal(resolved, "/tmp/tamandua/1234/h");
    assert.equal(io.nodes.get("/tmp/tamandua/1234/h")?.kind, "symlink");
    assert.equal(io.readlinkSync("/tmp/tamandua/1234/h"), REAL_HOME);
    assert.deepEqual(io.unlinkCalls, ["/tmp/tamandua/1234/h"]);
  });

  it("refuses a wrong target that cannot be replaced", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addDir("/old/home", UID);
    io.addSymlink("/tmp/tamandua/1234/h", UID, "/old/home");
    io.fail.unlink = Object.assign(new Error("read-only"), { code: "EROFS" });
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "alias_wrong_target",
      "cannot be replaced",
    );
  });

  it("refuses a dangling symlink", () => {
    const io = new FakeAliasFs(UID);
    io.addSymlink("/tmp/tamandua/1234/h", UID, "/does/not/exist");
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "alias_dangling",
      "dangling symlink",
    );
  });

  it("refuses when the alias matches but the real HOME is missing", () => {
    const io = new FakeAliasFs(UID);
    io.addSymlink("/tmp/tamandua/1234/h", UID, REAL_HOME);
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
    io.addFile("/tmp/tamandua/1234", UID);
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "parent_untrusted",
      "not a directory",
    );
  });

  it("refuses when the default parent is owned by another user", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addDir("/tmp/tamandua/1234", 999, 0o700);
    assertRefusal(
      () => resolveMatchlockHomeAlias(fakeDeps(io)),
      "parent_untrusted",
      "owned by uid 999",
    );
  });

  it("tightens a wrong default parent mode and then succeeds", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    io.addDir("/tmp/tamandua/1234", UID, 0o755);
    const resolved = resolveMatchlockHomeAlias(fakeDeps(io));
    assert.equal(resolved, "/tmp/tamandua/1234/h");
    assert.deepEqual(io.chmodCalls, [
      { path: "/tmp/tamandua/1234", mode: MATCHLOCK_HOME_ALIAS_PARENT_MODE },
    ]);
  });

  it("creates the default parent at 0700 owned by the uid", () => {
    const io = new FakeAliasFs(UID);
    io.addDir(REAL_HOME, UID);
    resolveMatchlockHomeAlias(fakeDeps(io));
    const parent = io.nodes.get("/tmp/tamandua/1234");
    assert.equal(parent?.kind, "dir");
    assert.equal(parent?.uid, UID);
    if (parent?.kind === "dir") assert.equal(parent.mode, 0o700);
  });
});

// ── buildMatchlockProcessEnv ────────────────────────────────────────

describe("buildMatchlockProcessEnv", () => {
  it("replaces only HOME and preserves every other entry", () => {
    const base = { HOME: "/long/real/home", PATH: "/usr/bin", FOO: "bar", EMPTY: "" };
    const env = buildMatchlockProcessEnv(base, "/tmp/tamandua/1234/h");
    assert.deepEqual(env, {
      HOME: "/tmp/tamandua/1234/h",
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
    for (const home of ["/tmp/tamandua/1234/h", "/" + "a".repeat(69), "/home/someone/with/a/long/path"]) {
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
    const home = "/tmp/tamandua/1234/h";
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
    assert.equal(matchlockSocketPathRefusal("/tmp/tamandua/1234/h"), null);
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
  it("resolves a >=90-char real HOME to an alias whose socket path is under 107 bytes", () => {
    // >= 90-char real HOME, the size class that failed the real-model
    // qualification (run #70) before the alias existed.
    const longHome = "/home/" + "very-long-home-segment/".repeat(4) + "user";
    assert.ok(longHome.length >= 90, `fixture HOME must be >= 90 chars (got ${longHome.length})`);

    // Without the alias the long real HOME exceeds the sun_path limit...
    const realRefusal = matchlockSocketPathRefusal(longHome);
    assert.ok(realRefusal, "the long real HOME must be refused without the alias");
    assert.equal(realRefusal.limit, MATCHLOCK_SUN_PATH_USABLE_LIMIT);
    assert.ok(realRefusal.length > 107);

    // ...but the DEFAULT per-uid alias for the same user resolves short enough
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
    assert.equal(resolved.home, "/tmp/tamandua/1234/h");
    const longest = computeLongestMatchlockSocketPath(resolved.home);
    const longestBytes = Buffer.byteLength(longest, "utf8");
    assert.ok(
      longestBytes < MATCHLOCK_SUN_PATH_USABLE_LIMIT,
      `alias socket path must fit under ${MATCHLOCK_SUN_PATH_USABLE_LIMIT} bytes (got ${longestBytes}: ${longest})`,
    );
    assert.equal(matchlockSocketPathRefusal(resolved.home), null);
    assert.equal(io.readlinkSync(resolved.home), longHome);
  });
});
