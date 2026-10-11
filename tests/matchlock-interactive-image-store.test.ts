/**
 * MTLK-INTERACTIVE-SUITE US-005 — private per-run matchlock image store
 * seeding (`lib/image-store.sh`) and the single-layer shared gate lock
 * (`lib/lock.sh`).
 *
 * The image-store contract under test: a fabricated operator store is seeded
 * into a private per-run HOME. Content-addressed blobs are HARDLINKED when the
 * private store is on the same device; mutable metadata (`metadata.db` and its
 * WAL/SHM siblings) and `kernels/` are independent COPIES; the operator store
 * is byte-unchanged; mutating the private copy leaves the operator copy
 * unchanged; and an empty/missing operator store is refused fail-closed.
 *
 * The lock contract under test: this layer takes the shared lock and EXPORTS
 * the `MTLK_GATE_LOCK_HELD=1` handshake; a nested (composed) layer sees the
 * handshake, acquires nothing and never blocks. Its `release` must not close
 * the outer layer's lock descriptor, and an invalid wait fails closed.
 *
 * This file spawns `bash` (node:child_process) and is therefore classified in
 * the serial lane; it is registered exactly once in tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const suiteDir = path.join(repoRoot, "scripts", "tests", "matchlock");
const imageStorePath = path.join(suiteDir, "lib", "image-store.sh");
const lockPath = path.join(suiteDir, "lib", "lock.sh");

// The hardlink contract only applies when the private store is on the same
// DEVICE as the operator store. This host's default test temp root (/tmp) is a
// tmpfs, a different device from $HOME, so the fixtures that must prove real
// hardlinks use a scratch root next to the repo (same device as $HOME).
const scratchParent = path.resolve(repoRoot, "..", "..");

/** Create a private same-device scratch root (caller removes it). */
function makeScratchRoot(tag: string): string {
  return mkdtempSync(path.join(scratchParent, `.mtlk-us005-${tag}-`));
}

/** Single-quote a string for safe interpolation into a `bash -c` script. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface RunResult {
  status: number | null;
  output: string;
  signal: NodeJS.Signals | null;
}

/** Spawn `bash -c <script>` with the ambient environment (no env object). */
function runBash(script: string, timeout = 120_000): RunResult {
  const result = spawnSync("bash", ["-c", script], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

// ── fabricated operator store ────────────────────────────────────────────

/** The two image blobs the fabricated operator store ships. */
const IMAGE_BLOB_FILES = ["sha256_aaa.erofs", "sha256_bbb.erofs"] as const;

/** Populate a fabricated operator matchlock image store at an explicit root. */
function populateOperatorStore(root: string): string {
  const images = path.join(root, "images");
  const blobs = path.join(images, "blobs");
  const kernels = path.join(root, "kernels");
  mkdirSync(blobs, { recursive: true });
  mkdirSync(kernels, { recursive: true });

  writeFileSync(path.join(blobs, IMAGE_BLOB_FILES[0]), "blob-aaa\n".repeat(64));
  writeFileSync(path.join(blobs, IMAGE_BLOB_FILES[1]), "blob-bbb\n".repeat(64));
  writeFileSync(path.join(images, "metadata.db"), "operator-images-metadata\n");
  writeFileSync(path.join(images, "metadata.db-wal"), "operator-images-wal\n");
  writeFileSync(path.join(images, "metadata.db-shm"), "operator-images-shm\n");
  mkdirSync(path.join(images, "local"), { recursive: true });
  writeFileSync(path.join(images, "local", "local-record.json"), '{"tag":"igorhvr/tamandua"}\n');

  mkdirSync(path.join(kernels, "6.19.8"), { recursive: true });
  writeFileSync(path.join(kernels, "6.19.8", "kernel"), "kernel-bytes\n".repeat(32));
  writeFileSync(path.join(kernels, "6.19.8", "kernel-qemu"), "kernel-qemu-bytes\n".repeat(32));
  writeFileSync(path.join(kernels, "metadata.db"), "operator-kernels-metadata\n");
  writeFileSync(path.join(kernels, "metadata.db-wal"), "operator-kernels-wal\n");
  return root;
}

interface TreeEntry {
  rel: string;
  kind: "file" | "dir";
  size: number;
  ino: number;
  nlink: number;
  hash: string;
}

/** Deterministically walk a directory tree with per-file sha256 + inode data. */
function walkTree(root: string): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  const visit = (dir: string, prefix: string): void => {
    const names = existsSync(dir) ? readdirSync(dir).sort() : [];
    for (const name of names) {
      const abs = path.join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const st = statSync(abs);
      if (st.isDirectory()) {
        entries.set(`${rel}/`, { rel: `${rel}/`, kind: "dir", size: 0, ino: 0, nlink: 0, hash: "" });
        visit(abs, rel);
      } else {
        entries.set(rel, {
          rel,
          kind: "file",
          size: st.size,
          ino: st.ino,
          nlink: st.nlink,
          hash: createHash("sha256").update(readFileSync(abs)).digest("hex"),
        });
      }
    }
  };
  visit(root, "");
  return entries;
}

/** sha256 over the whole tree (rel path + kind + per-file content sha). */
function hashTree(root: string): string {
  const entries = walkTree(root);
  const h = createHash("sha256");
  for (const rel of [...entries.keys()].sort()) {
    const e = entries.get(rel)!;
    h.update(`${rel}\u0000${e.kind}\u0000${e.hash}\n`);
  }
  return h.digest("hex");
}

function seedPrivateStore(operatorRoot: string, privateHome: string): RunResult {
  const script = [
    `export MTLK_OPERATOR_CACHE=${shQuote(operatorRoot)}`,
    `export MTLK_REPO_ROOT=${shQuote(repoRoot)}`,
    `. ${shQuote(imageStorePath)}`,
    `mtlk_image_store_seed ${shQuote(privateHome)}`,
  ].join("\n");
  return runBash(script);
}

// ── tests ────────────────────────────────────────────────────────────────

describe("Matchlock interactive image store + gate lock (MTLK-INTERACTIVE-SUITE US-005)", () => {
  it("ships lib/image-store.sh and lib/lock.sh", () => {
    assert.ok(existsSync(imageStorePath), `missing ${imageStorePath}`);
    assert.ok(existsSync(lockPath), `missing ${lockPath}`);
  });

  it("seeds a private store: hardlinks blobs, copies mutable metadata and kernels", () => {
    const scratch = makeScratchRoot("seed");
    const operatorRoot = populateOperatorStore(path.join(scratch, "operator-cache"));
    const privateHome = path.join(scratch, "home");
    try {
      mkdirSync(privateHome, { recursive: true });
      const before = hashTree(operatorRoot);
      const srcLinksBefore = new Map<string, number>();
      for (const [rel, e] of walkTree(operatorRoot)) srcLinksBefore.set(rel, e.nlink);
      // The scratch root next to the repo is on the same device as $HOME, so
      // the hardlink branch is the one under test here.
      assert.equal(
        statSync(operatorRoot).dev,
        statSync(privateHome).dev,
        "fixture must place the operator store and private HOME on the same device",
      );

      const result = seedPrivateStore(operatorRoot, privateHome);
      assert.equal(result.status, 0, `seeding failed (exit ${result.status}):\n${result.output}`);
      assert.match(result.output, /^MTLK-IMAGE-STORE-SEEDED /m, result.output);

      const store = path.join(privateHome, ".cache", "matchlock");
      assert.ok(existsSync(path.join(store, "images", "metadata.db")), "images/metadata.db missing");
      assert.ok(existsSync(path.join(store, "kernels")), "kernels/ missing");

      const srcEntries = walkTree(operatorRoot);
      const dstEntries = walkTree(store);

      // Every operator content file must exist in the private store with the
      // same bytes (the store is fully usable, not a stub).
      let sawHardlinkedBlob = false;
      for (const [rel, src] of srcEntries) {
        const dst = dstEntries.get(rel);
        assert.ok(dst, `private store is missing ${rel}`);
        assert.equal(dst.kind, src.kind, `kind mismatch for ${rel}`);
        if (src.kind !== "file") continue;
        assert.equal(dst.hash, src.hash, `content mismatch for ${rel}`);
        assert.equal(dst.size, src.size, `size mismatch for ${rel}`);

        const isMutable =
          rel.startsWith("images/metadata.db") ||
          rel.startsWith("images/local/") ||
          rel.startsWith("kernels/metadata.db");
        if (isMutable) {
          assert.notEqual(
            dst.ino,
            src.ino,
            `mutable file ${rel} must be an independent copy, not a hardlink`,
          );
        } else if (rel.startsWith("images/blobs/") || rel.startsWith("kernels/")) {
          // Content-addressed payloads share the operator inode.
          assert.equal(dst.ino, src.ino, `content ${rel} must be hardlinked, not copied`);
          sawHardlinkedBlob = true;
          assert.equal(
            dst.nlink,
            (srcLinksBefore.get(rel) ?? 1) + 1,
            `hardlinked content ${rel} must share exactly one extra link`,
          );
        }
      }
      assert.ok(sawHardlinkedBlob, "expected content blobs to be hardlinked into the private store");

      // Re-seeding is idempotent and still yields a usable store.
      const again = seedPrivateStore(operatorRoot, privateHome);
      assert.equal(again.status, 0, `re-seed failed: ${again.output}`);
      assert.ok(existsSync(path.join(store, "images", "metadata.db")));

      // The operator store is byte-unchanged after both seeds.
      assert.equal(hashTree(operatorRoot), before, "operator store changed during seeding");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("never lets a private mutation reach the operator store or a private peer", () => {
    const scratch = makeScratchRoot("mutation");
    const operatorRoot = populateOperatorStore(path.join(scratch, "operator-cache"));
    const homeA = path.join(scratch, "home-a");
    const homeB = path.join(scratch, "home-b");
    try {
      mkdirSync(homeA, { recursive: true });
      mkdirSync(homeB, { recursive: true });
      const before = hashTree(operatorRoot);
      assert.equal(seedPrivateStore(operatorRoot, homeA).status, 0);
      assert.equal(seedPrivateStore(operatorRoot, homeB).status, 0);

      const storeA = path.join(homeA, ".cache", "matchlock");
      const storeB = path.join(homeB, ".cache", "matchlock");
      const dbA = path.join(storeA, "images", "metadata.db");
      const walA = path.join(storeA, "images", "metadata.db-wal");
      const localA = path.join(storeA, "images", "local", "local-record.json");
      const kernelDbA = path.join(storeA, "kernels", "metadata.db");

      const operatorDbHash = createHash("sha256")
        .update(readFileSync(path.join(operatorRoot, "images", "metadata.db")))
        .digest("hex");
      const peerDbHash = createHash("sha256")
        .update(readFileSync(path.join(storeB, "images", "metadata.db")))
        .digest("hex");

      // Mutate every mutable private artifact; none may propagate.
      writeFileSync(dbA, "MUTATED-private-images-metadata\n");
      writeFileSync(walA, "MUTATED-private-images-wal\n");
      writeFileSync(localA, "MUTATED-private-local-record\n");
      writeFileSync(kernelDbA, "MUTATED-private-kernels-metadata\n");

      const afterOperatorHash = createHash("sha256")
        .update(readFileSync(path.join(operatorRoot, "images", "metadata.db")))
        .digest("hex");
      const afterPeerHash = createHash("sha256")
        .update(readFileSync(path.join(storeB, "images", "metadata.db")))
        .digest("hex");
      assert.equal(
        afterOperatorHash,
        operatorDbHash,
        "mutating the private metadata changed the operator metadata",
      );
      assert.equal(afterPeerHash, peerDbHash, "mutating one private store changed a peer store");
      assert.equal(hashTree(operatorRoot), before, "operator store changed after private mutation");

      // Direct inode independence for every mutable artifact.
      for (const [srcRel, dstRel] of [
        ["images/metadata.db", "images/metadata.db"],
        ["images/metadata.db-wal", "images/metadata.db-wal"],
        ["images/local/local-record.json", "images/local/local-record.json"],
        ["kernels/metadata.db", "kernels/metadata.db"],
      ] as const) {
        const srcIno = statSync(path.join(operatorRoot, srcRel)).ino;
        const dstIno = statSync(path.join(storeA, dstRel)).ino;
        assert.notEqual(srcIno, dstIno, `${dstRel} is hardlinked to the operator store`);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("fails closed on an empty/missing operator store and on an unusable private store", () => {
    const scratch = makeScratchRoot("refusal");
    const privateHome = path.join(scratch, "home");
    try {
      mkdirSync(privateHome, { recursive: true });
      // Missing operator store.
      const missing = path.join(scratch, "no-such-cache");
      const r1 = seedPrivateStore(missing, privateHome);
      assert.equal(r1.status, 4, `expected exit 4, got ${r1.status}:\n${r1.output}`);
      assert.match(r1.output, /MTLK-IMAGE-STORE-FAIL operator-store-missing:/, r1.output);

      // Empty operator store (exists, but no images/).
      const emptyRoot = path.join(scratch, "empty-cache");
      mkdirSync(emptyRoot, { recursive: true });
      const r2 = seedPrivateStore(emptyRoot, privateHome);
      assert.equal(r2.status, 4, `expected exit 4, got ${r2.status}:\n${r2.output}`);
      assert.match(r2.output, /MTLK-IMAGE-STORE-FAIL operator-images-missing:/, r2.output);

      // images/ present but metadata.db absent: refused (never an unusable store).
      const noMeta = path.join(scratch, "no-meta-cache");
      mkdirSync(path.join(noMeta, "images", "blobs"), { recursive: true });
      mkdirSync(path.join(noMeta, "kernels"), { recursive: true });
      const r3 = seedPrivateStore(noMeta, privateHome);
      assert.equal(r3.status, 4, `expected exit 4, got ${r3.status}:\n${r3.output}`);
      assert.match(r3.output, /MTLK-IMAGE-STORE-FAIL operator-images-metadata-db-missing:/, r3.output);

      // kernels/ absent: refused even when images/ is complete.
      const noKernels = populateOperatorStore(path.join(scratch, "no-kernels-cache"));
      rmSync(path.join(noKernels, "kernels"), { recursive: true, force: true });
      const r4 = seedPrivateStore(noKernels, privateHome);
      assert.equal(r4.status, 4, `expected exit 4, got ${r4.status}:\n${r4.output}`);
      assert.match(r4.output, /MTLK-IMAGE-STORE-FAIL operator-kernels-missing:/, r4.output);

      // The private store must never BE the operator store. Placing the
      // fabricated operator store at <privateHome>/.cache/matchlock makes the
      // operator cache and the private matchlock store the same path.
      const sameStoreHome = path.join(scratch, "same-store-home");
      mkdirSync(sameStoreHome, { recursive: true });
      const sameStore = populateOperatorStore(path.join(sameStoreHome, ".cache", "matchlock"));
      const r5 = seedPrivateStore(sameStore, sameStoreHome);
      assert.equal(r5.status, 4, `expected exit 4, got ${r5.status}:\n${r5.output}`);
      assert.match(r5.output, /MTLK-IMAGE-STORE-FAIL private-store-equals-operator-store:/, r5.output);

      // `mtlk_image_store_verify` refuses an unseeded private HOME. Use a fresh
      // HOME so the refusal is about the missing store, not an earlier seed.
      const verifyHome = path.join(scratch, "verify-home");
      mkdirSync(verifyHome, { recursive: true });
      const verifyScript = [
        `export MTLK_REPO_ROOT=${shQuote(repoRoot)}`,
        `. ${shQuote(imageStorePath)}`,
        `mtlk_image_store_verify ${shQuote(verifyHome)}`,
      ].join("\n");
      const r6 = runBash(verifyScript);
      assert.equal(r6.status, 4, `expected exit 4, got ${r6.status}:\n${r6.output}`);
      assert.match(r6.output, /MTLK-IMAGE-STORE-FAIL store-images-metadata-db-missing:/, r6.output);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("acquires the gate lock once and refuses nested acquisition via the handshake", () => {
    const scratch = makeScratchRoot("lock");
    const lockFile = path.join(scratch, "test-gate.lock");
    try {
      const script = [
        `export MTLK_REPO_ROOT=${shQuote(repoRoot)}`,
        `export MTLK_GATE_LOCK=${shQuote(lockFile)}`,
        `export MTLK_GATE_LOCK_WAIT=5`,
        `unset MTLK_GATE_LOCK_HELD`,
        `. ${shQuote(lockPath)}`,
        `mtlk_gate_lock_acquire`,
        `echo "acquire_rc=$?"`,
        `echo "held_env=[\${MTLK_GATE_LOCK_HELD:-unset}]"`,
        // A repeated acquisition by this layer sees the exported handshake and
        // must SKIP (never block).
        `mtlk_gate_lock_acquire`,
        `echo "skip_rc=$?"`,
        // Release once: the lock is dropped and the fd closed.
        `mtlk_gate_lock_release`,
        `echo "released_env=[\${MTLK_GATE_LOCK_HELD:-unset}]"`,
        // Release is idempotent and a no-op when this layer no longer owns it.
        `mtlk_gate_lock_release`,
        `echo "second_release_env=[\${MTLK_GATE_LOCK_HELD:-unset}]"`,
        `if [ -f ${shQuote(lockFile)} ]; then echo "lock_file=present"; else echo "lock_file=absent"; fi`,
        // After the release closed the owned descriptor, a fresh acquisition on
        // the same lock file succeeds again.
        `unset MTLK_GATE_LOCK_HELD`,
        `mtlk_gate_lock_acquire`,
        `echo "reacquire_rc=$?"`,
      ].join("\n");
      const result = runBash(script);
      assert.equal(result.status, 0, `lock script failed (exit ${result.status}):\n${result.output}`);
      assert.match(result.output, /^HELD /m, result.output);
      assert.match(result.output, /^SKIP /m, result.output);
      assert.match(result.output, /acquire_rc=0/, result.output);
      assert.match(result.output, /held_env=\[1\]/, result.output);
      assert.match(result.output, /skip_rc=0/, result.output);
      assert.match(result.output, /released_env=\[0\]/, result.output);
      assert.match(result.output, /second_release_env=\[0\]/, result.output);
      assert.match(result.output, /lock_file=present/, result.output);
      assert.match(result.output, /reacquire_rc=0/, result.output);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("inherits the handshake across a composed invocation without blocking", () => {
    const scratch = makeScratchRoot("lock-compose");
    const lockFile = path.join(scratch, "compose-gate.lock");
    try {
      // Outer layer takes the lock, then runs an inner `bash` that sources the
      // helper: the handshake is exported, so the inner layer must not flock.
      const script = [
        `export MTLK_REPO_ROOT=${shQuote(repoRoot)}`,
        `export MTLK_GATE_LOCK=${shQuote(lockFile)}`,
        `export MTLK_GATE_LOCK_WAIT=5`,
        `unset MTLK_GATE_LOCK_HELD`,
        `. ${shQuote(lockPath)}`,
        `mtlk_gate_lock_acquire`,
        // The inner layer inherits the exported handshake and must SKIP rather
        // than opening/flocking the shared lock file (which would deadlock).
        `bash -c '. ${shQuote(lockPath)}; mtlk_gate_lock_acquire; echo "inner_held_env=[\${MTLK_GATE_LOCK_HELD:-unset}]"'`,
        `echo "outer_held_env=[\${MTLK_GATE_LOCK_HELD:-unset}]"`,
      ].join("\n");
      const result = runBash(script, 20_000);
      assert.equal(
        result.signal,
        null,
        `composed invocation must not block; killed by ${result.signal}`,
      );
      assert.equal(result.status, 0, `composed script failed (exit ${result.status}):\n${result.output}`);
      assert.match(result.output, /^HELD /m, result.output);
      assert.match(result.output, /^SKIP /m, result.output);
      assert.match(result.output, /inner_held_env=\[1\]/, result.output);
      assert.match(result.output, /outer_held_env=\[1\]/, result.output);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("fails closed on an unusable lock (bad wait / missing flock visible as exit 6)", () => {
    const scratch = makeScratchRoot("lock-fail");
    const lockFile = path.join(scratch, "fail-gate.lock");
    try {
      const badWait = [
        `export MTLK_REPO_ROOT=${shQuote(repoRoot)}`,
        `export MTLK_GATE_LOCK=${shQuote(lockFile)}`,
        `export MTLK_GATE_LOCK_WAIT=not-a-number`,
        `unset MTLK_GATE_LOCK_HELD`,
        `. ${shQuote(lockPath)}`,
        `mtlk_gate_lock_acquire`,
      ].join("\n");
      const r1 = runBash(badWait);
      assert.equal(r1.status, 6, `expected exit 6, got ${r1.status}:\n${r1.output}`);
      assert.match(r1.output, /MTLK-GATE-LOCK-FAIL bad-wait:/, r1.output);

      const missingDir = [
        `export MTLK_REPO_ROOT=${shQuote(repoRoot)}`,
        `export MTLK_GATE_LOCK=${shQuote(path.join(scratch, "nope", "gate.lock"))}`,
        `unset MTLK_GATE_LOCK_HELD`,
        `. ${shQuote(lockPath)}`,
        `mtlk_gate_lock_acquire`,
      ].join("\n");
      const r2 = runBash(missingDir);
      assert.equal(r2.status, 6, `expected exit 6, got ${r2.status}:\n${r2.output}`);
      assert.match(r2.output, /MTLK-GATE-LOCK-FAIL lock-dir-missing:/, r2.output);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("binds the documented default lock and operator-store paths", () => {
    const script = [
      `export MTLK_REPO_ROOT=${shQuote(repoRoot)}`,
      `unset MTLK_GATE_LOCK`,
      `unset MTLK_OPERATOR_CACHE`,
      `unset TAMANDUA_GATE_OPERATOR_CACHE`,
      `. ${shQuote(imageStorePath)}`,
      `. ${shQuote(lockPath)}`,
      `echo "default_lock=\${MTLK_GATE_LOCK}"`,
      `echo "default_wait=\${MTLK_GATE_LOCK_WAIT:-3600}"`,
      `echo "operator_cache=\${MTLK_OPERATOR_CACHE}"`,
    ].join("\n");
    const result = runBash(script);
    assert.equal(result.status, 0, `binding check failed (exit ${result.status}):\n${result.output}`);
    assert.match(result.output, /^default_lock=\/home\/kaladin\/matchlock-work\/vaivm-gate\.lock$/m, result.output);
    assert.match(result.output, /^default_wait=3600$/m, result.output);
    assert.match(result.output, /^operator_cache=.*\/\.cache\/matchlock$/m, result.output);
  });
});
