import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Cached root directory — computed once, reused for the process lifetime.
let _root: string | null = null;
let _fallback = false;
let _warned = false;

/** @internal Reset cached state (for testing only). */
export function _resetTempRoot(): void {
  _root = null;
  _fallback = false;
  _warned = false;
}

/**
 * Return the canonical Tamandua temp root directory.
 *
 * Priority:
 *  1. `TAMANDUA_TEST_TMPDIR` env override (created with mode 0700 if it doesn't exist).
 *  2. Default: `/tmp/tamandua-test` (created with mode 0700 on first use).
 *
 * If directory creation fails (permissions, read-only /tmp), falls back to
 * `os.tmpdir()` with a single warning to stderr — never throws.
 *
 * On macOS, `/tmp` is a symlink to `/private/tmp`.  The returned path is
 * resolved through `fs.realpathSync` so callers always get the canonical
 * physical path.
 */
export function tamanduaTempRoot(): string {
  if (_root !== null) return _root;

  const envDir = process.env.TAMANDUA_TEST_TMPDIR;
  const base = envDir ? envDir : "/tmp/tamandua-test";

  try {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    // Ensure mode 0700 even if directory already existed (mkdirSync with
    // recursive:true is a no-op on existing dirs, leaving old mode intact).
    fs.chmodSync(base, 0o700);
    _root = fs.realpathSync(base);
  } catch {
    _root = fs.realpathSync(os.tmpdir());
    _fallback = true;
  }

  if (_fallback && !_warned) {
    _warned = true;
    process.stderr.write(
      `tamanduaTempRoot: failed to create ${base}, falling back to ${_root}\n`,
    );
  }

  return _root;
}

/**
 * Create a unique temporary directory under {@link tamanduaTempRoot}.
 *
 * Drop-in replacement for `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`.
 * Returns the absolute path of the newly created directory.
 */
export function tamanduaTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(tamanduaTempRoot(), prefix));
}

/**
 * Short literal base for temp fixtures whose absolute paths must fit the unix
 * `sun_path` limit (108 bytes including NUL on Linux, 104 on macOS) even after
 * a deep fixed suffix such as Matchlock's
 * `<HOME>/.matchlock/vms/vm-XXXXXXXX/vsock.sock_5001` is appended.
 *
 * Deliberately NOT `tamanduaTempRoot()`: the ambient root (or a deep
 * `TAMANDUA_TEST_TMPDIR` evidence path) can be long enough that a fixture
 * `HOME` derived from it trips the product's pre-flight socket-path refusal.
 * `/tmp` is short on every platform — on macOS its realpath is
 * `/private/tmp`, only 8 bytes longer.
 */
const SHORT_TEMP_BASE = "/tmp";

/**
 * Create a unique temp directory under the short literal `/tmp` base and
 * return its canonical realpath.
 *
 * Use this ONLY for fixtures that must keep absolute unix-socket/document
 * paths within the `sun_path` budget; ordinary temp assets use
 * {@link tamanduaTempDir}. The caller owns cleanup (e.g. `fs.rmSync`).
 */
export function tamanduaShortTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(SHORT_TEMP_BASE, prefix));
  return fs.realpathSync(dir);
}
