/**
 * Fast, deterministic plumbing coverage for the long-HOME (>= 90 char)
 * zero-provider real-VM gate (MTLK-FIX item 1c / US-005).
 *
 * No VMs, no child processes, no matchlock runtime: these tests pin the pure
 * helpers the real-VM gate (`e2e-tests/matchlock-long-home-gate.test.ts`, run
 * on demand via `./run-matchlock-long-home-e2e-test`) relies on:
 *
 *   1. the long real-HOME path builder reaches >= 90 chars under any evidence
 *      root and stays inside it;
 *   2. a >= 90-char real HOME alone exceeds the Linux 107-byte sun_path limit,
 *      while the DEFAULT short-HOME alias resolves to a socket path that fits
 *      (the US-005 acceptance criterion);
 *   3. the qualification doc states Tamandua handles the short-HOME
 *      requirement and documents the TAMANDUA_MATCHLOCK_HOME_ALIAS escape
 *      hatch.
 *
 * Parallel lane: nothing here (transitively) reaches a child-process module.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import {
  LONG_HOME_MIN_CHARS,
  buildLongHomePath,
  probeLongHomeAlias,
} from "../e2e-tests/helpers/matchlock-long-home.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("long-HOME gate plumbing (US-005)", () => {
  it("builds an absolute real-HOME path of >= 90 chars under the evidence root", () => {
    const roots = [
      // A short evidence root must be padded up to the minimum.
      "/root/matchlock-work/evidence/mtlk-fix-Ab12Cd",
      // An already-long evidence root must not be shortened or broken.
      "/" + "e".repeat(80),
      // A deep-but-short root exercises path.join normalization.
      "/root/matchlock-work/evidence/mtlk-fix-XXXXXX/",
    ];
    for (const evidence of roots) {
      const home = buildLongHomePath(evidence);
      // `path.normalize` preserves a trailing separator, so strip it first.
      const normalizedEvidence = path.normalize(evidence).replace(/[\\/]+$/, "");
      assert.ok(path.isAbsolute(home), `HOME must be absolute: ${home}`);
      assert.ok(
        home.startsWith(normalizedEvidence + path.sep),
        `HOME must live under the evidence root (${normalizedEvidence}): ${home}`,
      );
      assert.ok(
        Buffer.byteLength(home, "utf8") >= LONG_HOME_MIN_CHARS,
        `HOME must reach ${LONG_HOME_MIN_CHARS} chars: ${home} (${Buffer.byteLength(home, "utf8")})`,
      );
      // Deterministic: same evidence root -> same HOME (a gate rerun reuses the
      // path, it never appends a random suffix).
      assert.equal(buildLongHomePath(evidence), home);
    }
  });

  it("rejects a relative evidence root and a non-positive minimum", () => {
    assert.throws(() => buildLongHomePath("relative/evidence"), /absolute evidence dir/);
    assert.throws(() => buildLongHomePath("/tmp/evidence", 0), /positive integer/);
  });

  it("resolves a >=90-char real HOME to a short alias whose socket path fits", () => {
    const root = tamanduaTempDir("mtlk-long-home-plumbing-");
    cleanups.push(root);
    const realHome = buildLongHomePath(root);
    fs.mkdirSync(realHome, { recursive: true });
    // A SHORT alias root, mirroring the gate runner's short unique TMPDIR:
    // the real default alias lives under a short dir, so the alias HOME (and
    // therefore the socket path) stays short even though the real HOME is long.
    const aliasTmp = fs.mkdtempSync("/tmp/mtlk-lh-");
    cleanups.push(aliasTmp);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;

    const probe = probeLongHomeAlias(realHome, { env: {}, tmpdir: aliasTmp, uid });

    // The premise: the real HOME alone cannot produce a bindable socket.
    assert.ok(probe.realHomeLength >= LONG_HOME_MIN_CHARS);
    assert.ok(
      probe.realHomeRefusal,
      `the ${probe.realHomeLength}-char real HOME must exceed the sun_path limit`,
    );
    assert.ok(probe.realHomeSocketBytes > probe.limit);

    // The fix: the DEFAULT alias resolves to a short, verified HOME whose
    // computed socket path is under the 107-byte limit.
    assert.equal(probe.resolution.disabled, false);
    assert.equal(probe.resolution.realHome, realHome);
    assert.notEqual(probe.aliasHome, realHome);
    assert.equal(probe.aliasRefusal, null);
    assert.ok(
      probe.aliasSocketBytes < probe.limit,
      `alias socket path must fit under ${probe.limit} bytes (got ${probe.aliasSocketBytes}: ${probe.aliasSocketPath})`,
    );
    // The alias target is the real HOME byte-for-byte, so image cache, kernel
    // cache and the VM registry stay shared.
    assert.equal(fs.readlinkSync(probe.aliasHome), realHome);
    const aliasStat = fs.lstatSync(probe.aliasHome);
    assert.ok(aliasStat.isSymbolicLink());
    assert.equal(aliasStat.uid, uid);
  });

  it("documents that Tamandua handles the short-HOME requirement and the escape hatch", () => {
    const doc = fs.readFileSync(
      path.join(repoRoot, "docs", "matchlock-dsh-qualification.md"),
      "utf-8",
    );
    assert.match(doc, /Tamandua handles this/, "doc must state Tamandua handles the short-HOME requirement");
    assert.match(doc, /TAMANDUA_MATCHLOCK_HOME_ALIAS/, "doc must name the escape hatch env var");
    assert.match(doc, /short/i, "doc must describe the escape hatch purpose");
    assert.match(
      doc,
      /symlink|alias target|image cache/i,
      "doc must explain the alias target is the real HOME so caches/registry stay shared",
    );
  });
});
