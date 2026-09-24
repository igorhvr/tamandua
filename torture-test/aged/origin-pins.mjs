// origin-pins.mjs — verify + pin a supplied owned tt-poly origin for the
// aged-state full seed (STORM-AGED).  Reads the build-golden hash ledger
// (`tt-poly.git.hashes`) and asserts every pinned SHA resolves as a real git
// commit in the supplied origin working tree (and, when given, the bare
// `tt-poly.git` it was cloned from), that the `seed/storm` ref resolves to its
// recorded SHA, and that the `FIXTURES_SRC` content hash still matches the
// current fixtures-src/tt-poly source tree.  Emits the durable pins manifest
// consumed by `full --origin` (US-004) and the qualification JSON (US-012).
//
// Standalone + importable: running this file directly verifies the material
// and writes the manifest; `full`/tests import the functions below.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { utcNow, gitTry } from "./seedcommon.mjs";
import {
  hashFixtureSourceDir,
  ensureGoldenBare,
  DEFAULT_FIXTURES_SRC_DIR,
} from "../bin/tt-golden-bootstrap.mjs";

const GIT_SHA1_RE = /^[0-9a-f]{40}$/;
const GIT_SHA256_RE = /^[0-9a-f]{64}$/;

// Parse the tt-poly.git.hashes ledger into a typed shape.  The ledger uses a
// `key=value` format (branch-format builder):
//   baseline=<40hex>        green baseline commit (== main tip)
//   seed/<NAME>=<40hex>     each seed ref tip (NAME != "storm")
//   broken-tests=<40hex>    quarantine-lane branch tip
//   seed/storm=<40hex>      composite seed/storm ref tip
//   FIXTURES_SRC=<64hex>    sha256 content hash of fixtures-src/tt-poly (S57)
// Unknown lines (comments/diagnostics) are ignored, matching the shared
// bootstrap's tolerance, EXCEPT that the seed/storm and broken-tests pins are
// required: they are the refs the seed instantiates worktrees from.
export function parseTtPolyHashes(content) {
  const seedPins = [];
  let baseline = null;
  let brokenTests = null;
  let seedStorm = null;
  let fixturesSrc = null;
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const m = /^([A-Za-z0-9/_-]+)=([0-9a-f]+)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    if (key === "baseline" && GIT_SHA1_RE.test(value)) baseline = value;
    else if (key === "broken-tests" && GIT_SHA1_RE.test(value)) brokenTests = value;
    else if (key === "seed/storm" && GIT_SHA1_RE.test(value)) seedStorm = value;
    else if (key === "FIXTURES_SRC" && GIT_SHA256_RE.test(value)) fixturesSrc = value;
    else if (key.startsWith("seed/") && GIT_SHA1_RE.test(value)) {
      seedPins.push({ name: key.slice("seed/".length), sha: value });
    }
  }
  return { baseline, seedPins, brokenTests, seedStorm, fixturesSrc };
}

function gitCatFileType(repoDir, sha, { bare = false } = {}) {
  const args = bare
    ? ["--git-dir", repoDir, "cat-file", "-t", sha]
    : ["-C", repoDir, "cat-file", "-t", sha];
  const res = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return res.status === 0 ? (res.stdout || "").trim() : null;
}

// Resolve a rev to a commit SHA (rev-parse --verify <rev>^{commit}) or null.
function gitCommitSha(repoDir, rev, { bare = false } = {}) {
  const args = bare
    ? ["--git-dir", repoDir, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`]
    : ["-C", repoDir, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`];
  const res = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return res.status === 0 ? (res.stdout || "").trim() : null;
}

// Verify a single pinned SHA resolves as a commit in `origin` and, when
// supplied, in `bare`.  Returns a per-location verdict record.
function verifyPinSha(pin, { originDir, bareDir }) {
  const verdict = { pin, origin: { ok: false, type: null }, bare: null };
  const originType = gitCatFileType(originDir, pin);
  verdict.origin = {
    ok: originType === "commit" && gitCommitSha(originDir, pin) === pin,
    type: originType,
  };
  if (bareDir) {
    const bareType = gitCatFileType(bareDir, pin, { bare: true });
    verdict.bare = {
      ok: bareType === "commit" && gitCommitSha(bareDir, pin, { bare: true }) === pin,
      type: bareType,
    };
  }
  return verdict;
}

// Full verification over the migrated tt-poly origin material.  Returns a
// result object whose `ok` is true only when EVERY recorded pin resolves and
// the FIXTURES_SRC content hash matches (when fixturesSrcDir is supplied).
export function verifyTtPolyOriginMaterial({
  originDir,
  bareDir = null,
  hashesContent,
  fixturesSrcDir = null,
}) {
  const parsed = parseTtPolyHashes(hashesContent);
  const originHead = gitHeadOrNull(originDir);
  const result = {
    ok: true,
    parsed,
    originHead: originHead ? originHead.sha : null,
    originTree: originHead ? originHead.tree : null,
    baseline: null,
    seedPins: [],
    brokenTests: null,
    seedStorm: null,
    fixturesSrc: null,
  };

  if (parsed.baseline) {
    result.baseline = verifyPinSha(parsed.baseline, { originDir, bareDir });
    if (!pinOk(result.baseline)) result.ok = false;
  }
  for (const { name, sha } of parsed.seedPins) {
    const v = verifyPinSha(sha, { originDir, bareDir });
    result.seedPins.push({ name, ...v });
    if (!pinOk(v)) result.ok = false;
  }
  if (parsed.brokenTests) {
    result.brokenTests = verifyPinSha(parsed.brokenTests, { originDir, bareDir });
    if (!pinOk(result.brokenTests)) result.ok = false;
  }
  if (parsed.seedStorm) {
    const v = verifyPinSha(parsed.seedStorm, { originDir, bareDir });
    // The seed instantiates worktrees from this REF, so the ref itself (not
    // only the object) must resolve to the recorded SHA.
    const originRef = gitCommitSha(originDir, "seed/storm");
    v.seedStormRef = {
      origin: originRef === parsed.seedStorm,
      resolvedSha: originRef,
    };
    if (bareDir) {
      const bareRef = gitCommitSha(bareDir, "refs/heads/seed/storm", { bare: true });
      v.seedStormRef.bare = bareRef === parsed.seedStorm;
      v.seedStormRef.bareResolvedSha = bareRef;
    }
    result.seedStorm = v;
    if (!pinOk(v) || v.seedStormRef.origin !== true) result.ok = false;
  } else {
    result.ok = false;
    result.seedStormMissing = true;
  }
  if (parsed.fixturesSrc) {
    const actual = fixturesSrcDir ? hashFixtureSourceDir(fixturesSrcDir) : null;
    result.fixturesSrc = {
      expected: parsed.fixturesSrc,
      actual,
      ok: actual === parsed.fixturesSrc,
      verified: fixturesSrcDir != null,
    };
    if (fixturesSrcDir != null && actual !== parsed.fixturesSrc) result.ok = false;
  }
  return result;
}

function pinOk(verdict) {
  if (!verdict) return false;
  if (verdict.origin?.ok !== true) return false;
  if (verdict.bare !== null && verdict.bare?.ok !== true) return false;
  return true;
}

function gitHeadOrNull(repoDir) {
  const sha = gitTry(repoDir, ["rev-parse", "HEAD"]);
  if (!sha) return null;
  return {
    sha,
    tree: gitTry(repoDir, ["rev-parse", "HEAD^{tree}"]) ?? null,
    subject: gitTry(repoDir, ["log", "-1", "--pretty=%s"]) ?? null,
  };
}

// Build the durable pins manifest consumed by `full --origin` (US-004) and the
// qualification JSON (US-012).  Purely derived from verification: origin path +
// sha + tree, bare path, every seed/* + broken-tests + seed/storm pin, the
// baseline, FIXTURES_SRC, and the honest verification verdict.
export function buildOriginPinsManifest({
  originDir,
  bareDir = null,
  hashesContent,
  fixturesSrcDir = null,
  verification = null,
}) {
  const verify = verification ?? verifyTtPolyOriginMaterial({
    originDir, bareDir, hashesContent, fixturesSrcDir,
  });
  const originReal = fs.realpathSync(originDir);
  const manifest = {
    schema: "storm-origin-pins",
    schema_version: 1,
    generated_at_utc: utcNow(),
    origin: {
      path: originReal,
      sha: verify.originHead,
      tree: verify.originTree,
      remote_url: gitTry(originReal, ["config", "--get", "remote.origin.url"]),
      main_ref: gitTry(originReal, ["rev-parse", "--abbrev-ref", "HEAD"]),
      branches: (gitTry(originReal, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]) ?? "")
        .split("\n").filter(Boolean),
    },
    bare: bareDir ? { path: fs.realpathSync(bareDir) } : null,
    pins: {
      baseline: verify.parsed.baseline,
      seed: verify.parsed.seedPins.map(({ name, sha }) => ({ name, sha })),
      broken_tests: verify.parsed.brokenTests,
      seed_storm: verify.parsed.seedStorm,
      fixtures_src: verify.parsed.fixturesSrc,
    },
    verification: {
      ok: verify.ok,
      baseline_ok: pinOk(verify.baseline),
      seed_pins_ok: verify.seedPins.every((v) => pinOk(v)),
      broken_tests_ok: pinOk(verify.brokenTests),
      seed_storm_ok: pinOk(verify.seedStorm),
      seed_storm_ref_resolves: verify.seedStorm?.seedStormRef?.origin === true,
      fixtures_src_match: verify.fixturesSrc?.ok ?? null,
      // Honest refusal detail: the exact recorded-vs-observed values that made
      // verification fail (null when it passed).  Never discard the reasons.
      diagnostics: verify.ok
        ? null
        : {
            origin_head: verify.originHead ?? null,
            fixtures_src: verify.fixturesSrc ?? null,
            seed_storm_missing: verify.seedStormMissing ?? false,
            seed_storm_ref: verify.seedStorm?.seedStormRef ?? null,
          },
    },
  };
  return manifest;
}

// ── Fresh owned origin materialization (US-003 fallback) ─────────────────
// The retained storm-fixture-input origin was built from an older torture
// tree; after the torture-port fixtures-src change its FIXTURES_SRC ledger
// record no longer matches the current source, so the canonical golden
// bootstrap refuses it (golden-fixtures-src-drift).  This builds a FRESH
// owned origin from the CURRENT fixtures-src via the same canonical builder
// the goldens use.  It only ever writes under its owned `outDir`; supplied /
// read-only material is never touched.

// The retained supplied origin's local branch shape (main / broken-tests /
// seed/storm) with HEAD on main and local main at the composite seed/storm
// tip — mirrored so later phases see the same origin working-tree shape.
export const ORIGIN_LOCAL_BRANCHES = ["main", "broken-tests", "seed/storm"];

function runGit(args, cwd = null) {
  const res = spawnSync("git", args, {
    cwd: cwd ?? undefined,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || "").trim()}`);
  }
  return (res.stdout || "").trim();
}

// Materialize a working clone of `bareDir` at `originDir` carrying the same
// local storm branch shape as the retained supplied origin (main /
// broken-tests / seed/storm, HEAD on main) — and, exactly like the supplied
// origin, with local `main` moved to the composite seed/storm tip (the bare's
// `main` stays the green baseline).  The seed instantiates worktrees from
// `mainRef=main`, so the composite content must be reachable through main.
// Any previous clone at that exact owned path is replaced.
export function materializeTtPolyOriginClone({ bareDir, originDir }) {
  const resolved = path.resolve(originDir);
  fs.rmSync(resolved, { recursive: true, force: true });
  runGit(["clone", "--quiet", bareDir, resolved]);
  runGit(["-C", resolved, "checkout", "--quiet", "-B", "broken-tests", "origin/broken-tests"]);
  runGit(["-C", resolved, "checkout", "--quiet", "-B", "seed/storm", "origin/seed/storm"]);
  runGit(["-C", resolved, "checkout", "--quiet", "main"]);
  runGit(["-C", resolved, "reset", "--hard", "--quiet", "seed/storm"]);
  return resolved;
}

// Build + verify a fresh OWNED tt-poly origin (golden bare + working clone)
// from the current fixtures-src.  Returns a result whose `ok` is true only
// when the freshly-built material passes the SAME verification the supplied
// origin is judged by (every pin resolves against the fresh ledger, the
// seed/storm ref resolves, and FIXTURES_SRC matches the current source).
export function buildOwnedTtPolyOrigin({ outDir, goldenDir = null, force = false }) {
  const goldenRoot = path.resolve(goldenDir ?? outDir);
  fs.mkdirSync(goldenRoot, { recursive: true });
  const build = ensureGoldenBare({ fixture: "tt-poly", goldenDir: goldenRoot, force });
  if (!build.ok) {
    return { ok: false, stage: "build-golden", goldenRoot, build };
  }
  const bareDir = build.barePath;
  const hashesPath = build.hashFilePath;
  const fixturesSrcDir = path.join(DEFAULT_FIXTURES_SRC_DIR, "tt-poly");
  const originDir = path.join(goldenRoot, "origin");
  let verify;
  try {
    materializeTtPolyOriginClone({ bareDir, originDir });
    verify = verifyTtPolyOriginMaterial({
      originDir,
      bareDir,
      hashesContent: fs.readFileSync(hashesPath, "utf-8"),
      fixturesSrcDir,
    });
  } catch (error) {
    return { ok: false, stage: "materialize-origin", goldenRoot, bareDir, hashesPath, fixturesSrcDir, originDir, error: error.message };
  }
  return {
    ok: verify.ok,
    stage: verify.ok ? "verified" : "verify-failed",
    goldenRoot,
    bareDir,
    hashesPath,
    fixturesSrcDir,
    originDir,
    build,
    verify,
  };
}

// Write the manifest atomically (tmp + rename) so a concurrent reader never
// observes a truncated file.
export function writeOriginPinsManifest(outPath, manifest) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, outPath);
  return outPath;
}

// ── Thin CLI (only when invoked directly) ────────────────────────────────
function usage() {
  return [
    "Usage:",
    "  node torture-test/aged/origin-pins.mjs --origin <dir> --hashes <file> [--bare <dir>] [--fixtures-src <dir>] --out <file>",
    "  node torture-test/aged/origin-pins.mjs --build-owned <dir> --out <file> [--force]",
    "",
    "Verify a supplied owned tt-poly origin against its hash ledger and write",
    "the durable pins manifest.  --fixtures-src enables the FIXTURES_SRC content",
    "hash check (S57).  Exit 0 iff every pin resolves.",
    "",
    "--build-owned builds a FRESH owned tt-poly origin (golden bare + working",
    "clone) from the current fixtures-src via the canonical golden bootstrap,",
    "verifies it, and writes the durable pins manifest.  Use it when the supplied",
    "material is unusable (e.g. fixtures-src drift refused it).",
  ].join("\n");
}

function printBuildOwnedJson(result, manifestPath) {
  process.stdout.write(`${JSON.stringify({
    ok: result.ok,
    stage: result.stage,
    manifest: manifestPath,
    golden_root: result.goldenRoot ?? null,
    origin: result.originDir ?? null,
    bare: result.bareDir ?? null,
    hashes: result.hashesPath ?? null,
    fixtures_src: result.verify?.fixturesSrc ?? null,
    reason: result.build?.reason ?? null,
    error: result.error ?? null,
  }, null, 2)}\n`);
}

function runCli(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const outPath = flag("--out");
  const buildOwnedDir = flag("--build-owned");

  if (buildOwnedDir) {
    if (!outPath) {
      process.stderr.write(`${usage()}\n`);
      return 2;
    }
    const result = buildOwnedTtPolyOrigin({
      outDir: buildOwnedDir,
      goldenDir: flag("--golden-dir"),
      force: argv.includes("--force"),
    });
    if (!result.ok) {
      printBuildOwnedJson(result, null);
      process.stderr.write(`owned tt-poly origin build/verification failed at stage '${result.stage}'\n`);
      return 1;
    }
    const manifest = buildOriginPinsManifest({
      originDir: result.originDir,
      bareDir: result.bareDir,
      hashesContent: fs.readFileSync(result.hashesPath, "utf-8"),
      fixturesSrcDir: result.fixturesSrcDir,
      verification: result.verify,
    });
    writeOriginPinsManifest(outPath, manifest);
    printBuildOwnedJson(result, outPath);
    return manifest.verification.ok ? 0 : 1;
  }

  const originDir = flag("--origin");
  const hashesFile = flag("--hashes");
  if (!originDir || !hashesFile || !outPath) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const bareDir = flag("--bare");
  const fixturesSrcDir = flag("--fixtures-src");
  const hashesContent = fs.readFileSync(hashesFile, "utf-8");
  const verification = verifyTtPolyOriginMaterial({
    originDir, bareDir, hashesContent, fixturesSrcDir,
  });
  const manifest = buildOriginPinsManifest({
    originDir, bareDir, hashesContent, fixturesSrcDir, verification,
  });
  writeOriginPinsManifest(outPath, manifest);
  process.stdout.write(`${JSON.stringify({
    ok: verification.ok,
    manifest: outPath,
    origin_head: verification.originHead,
    origin_tree: verification.originTree,
    baseline: verification.baseline,
    broken_tests: verification.brokenTests,
    seed_storm: verification.seedStorm,
    fixtures_src: verification.fixturesSrc,
  }, null, 2)}\n`);
  return verification.ok ? 0 : 1;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isCli) {
  process.exitCode = runCli(process.argv.slice(2));
}
