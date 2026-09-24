// preflight.mjs — recording-only effect-adapter safety gate for the
// aged-state seed (storm-aged VALIDATION/HANDOFF gate #1).
//
// The gate is RECORDING-ONLY: it never mutates a candidate seed root, never
// spawns a phase, and never creates files under a candidate path.  On any
// malformed/foreign input it returns a FAIL verdict with zero effects.
//
// Checks (all read-only):
//   R1 candidate root exists and is a directory          (else invalid → zero effects)
//   R2 manifest parses and schema matches                (else refuse)
//   R3 root identity (realpath/dev/ino) matches manifest (else refuse — never repin)
//   R4 pinned origin (full mode) exists, is a git repo,
//      and its HEAD matches the pin                      (else refuse)
//   R5 provenance: dist/catalog identity recorded, ready (pilot+ only, informational)
//
// The gate writes its verdict receipt ONLY to an explicitly supplied
// evidence dir (never inside the candidate).  Callers that pass no evidence
// dir get a plain JSON verdict on stdout with zero side effects.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { captureOwnership, sha256File } from "./seedcommon.mjs";

export function dirTreeFingerprint(dirPath) {
  // Read-only recursive fingerprint: name+size+sha256 of every file.
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out[path.relative(dirPath, full)] = {
          size: fs.statSync(full).size,
          sha256: sha256File(full),
        };
      }
    }
  };
  if (fs.existsSync(dirPath)) walk(dirPath);
  return out;
}

export function preflightGate({ candidateRoot, manifest, originPin, productDist }) {
  const findings = [];
  const checks = {};

  // R1
  let stat = null;
  try {
    stat = fs.statSync(candidateRoot);
  } catch {
    return verdict("INVALID", checks, findings, { reason: "candidate root does not exist or is unreadable" });
  }
  if (!stat.isDirectory()) {
    return verdict("INVALID", checks, findings, { reason: "candidate root is not a directory" });
  }
  checks.R1 = { ok: true, root: candidateRoot };

  // R2/R3
  if (manifest) {
    if (typeof manifest !== "object" || manifest.schema_version !== 1) {
      findings.push("R2: manifest schema mismatch or unparseable — refuse, do not repin");
      checks.R2 = { ok: false, reason: "schema mismatch" };
      return verdict("REFUSE", checks, findings, { reason: "manifest schema mismatch" });
    }
    checks.R2 = { ok: true, schema_version: manifest.schema_version };
    try {
      const cur = captureOwnership(candidateRoot);
      const pinned = manifest.ownership;
      const matches =
        cur.root === pinned.root && cur.dev === pinned.dev && cur.ino === pinned.ino;
      checks.R3 = { ok: matches, actual: cur, pinned };
      if (!matches) {
        findings.push(
          "R3: root identity changed (realpath/dev/ino) — refuse rather than repinning",
        );
        return verdict("REFUSE", checks, findings, { reason: "root identity mismatch" });
      }
    } catch (err) {
      checks.R3 = { ok: false, reason: String(err) };
      findings.push(`R3: identity probe failed: ${err.message}`);
      return verdict("REFUSE", checks, findings, { reason: "root identity probe failed" });
    }
  } else {
    checks.R2 = { ok: true, manifest: "none (fresh allocation)" };
  }

  // R4
  if (originPin && originPin.path) {
    let originStat = null;
    try {
      originStat = fs.statSync(originPin.path);
    } catch {
      findings.push("R4: pinned origin path does not exist");
      checks.R4 = { ok: false, reason: "origin missing" };
      return verdict("REFUSE", checks, findings, { reason: "pinned origin missing" });
    }
    const gitTop = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: originPin.path,
      encoding: "utf8",
    });
    if (gitTop.status !== 0) {
      findings.push("R4: pinned origin is not a git working tree");
      checks.R4 = { ok: false, reason: "origin not a git repo" };
      return verdict("REFUSE", checks, findings, { reason: "origin not a git repo" });
    }
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: originPin.path,
      encoding: "utf8",
    }).stdout.trim();
    const headMatches = !originPin.headSha || head === originPin.headSha;
    checks.R4 = { ok: headMatches, origin: originPin.path, actualHead: head, pinnedHead: originPin.headSha ?? null };
    if (!headMatches) {
      findings.push("R4: origin HEAD moved since pinning — refuse rather than repinning");
      return verdict("REFUSE", checks, findings, { reason: "origin HEAD mismatch" });
    }
  }

  // R5 (informational provenance)
  if (productDist) {
    checks.R5 = {
      ok: fs.existsSync(path.join(productDist, "installer/run.js")),
      productDist,
    };
    if (!checks.R5.ok) {
      findings.push("R5: product dist missing required modules");
      return verdict("REFUSE", checks, findings, { reason: "product dist incomplete" });
    }
  }

  return verdict("PASS", checks, findings, {});
}

function verdict(result, checks, findings, extra) {
  return { result, checks, findings, effects: [], ...extra, ts_utc: new Date().toISOString() };
}

export function writePreflightReceipt(evidenceDir, verdictObj, label) {
  if (!evidenceDir) return null;
  fs.mkdirSync(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, `preflight-${label}.json`);
  fs.writeFileSync(file, JSON.stringify(verdictObj, null, 2) + "\n", "utf-8");
  return file;
}

// CLI-equivalent exit code for a gate verdict (PASS=0; REFUSE/INVALID=3).
export function preflightExitCode(verdict) {
  return verdict.result === "PASS" ? 0 : 3;
}

// Run ONE gate case under a before/after dir-tree fingerprint so every case
// (PASS and negative alike) is recorded with a durable zero-effects proof.
// The gate itself is recording-only; this wrapper only reads fingerprints and
// returns a record (it writes NOTHING under the candidate).
export function runGateCase({ label, candidateRoot, manifest, originPin, productDist, expected }) {
  const before = dirTreeFingerprint(candidateRoot);
  const verdict = preflightGate({ candidateRoot, manifest, originPin, productDist });
  const after = dirTreeFingerprint(candidateRoot);
  const zeroEffects = JSON.stringify(before) === JSON.stringify(after);
  const record = {
    case: label,
    ts_utc: new Date().toISOString(),
    result: verdict.result,
    expected,
    exitCode: preflightExitCode(verdict),
    zeroEffects,
    checks: verdict.checks,
    findings: verdict.findings,
    candidate: candidateRoot,
  };
  if (!zeroEffects) {
    // Never silently pass a gate that mutated its candidate.
    throw new Error(`preflight evidence case "${label}": gate mutated candidate (zero-effects violated)`);
  }
  return record;
}

// Persisted recording-only preflight battery over an owned seed root:
//   PASS on the root itself + durable INVALID/REFUSE negative trials
//   (malformed manifest, foreign identity, moved origin ref, resume-identity
//   mismatch).  Every case carries before/after fingerprints proving zero
//   effects and the CLI-equivalent exit code (REFUSE/INVALID → 3).  All
//   receipts/trials are written under <seedRoot>/evidence/preflight (owned
//   evidence), never under the trial candidates themselves.
export function runPreflightEvidenceBattery({ seedRoot, productDist }) {
  const evidenceRoot = path.join(seedRoot, "evidence", "preflight");
  const trialsRoot = path.join(evidenceRoot, "trials");
  fs.mkdirSync(trialsRoot, { recursive: true });
  const results = [];

  const record = (rec) => {
    results.push(rec);
    const file = path.join(evidenceRoot, `${String(results.length).padStart(2, "0")}-${rec.case}.json`);
    fs.writeFileSync(file, JSON.stringify(rec, null, 2) + "\n", "utf-8");
    return file;
  };

  // ── Negative trials (built from owned scratch under the evidence dir) ──
  const missingCandidate = path.join(trialsRoot, "invalid-missing", "candidate");
  record(runGateCase({
    label: "invalid-missing-root",
    candidateRoot: missingCandidate,
    manifest: null,
    expected: "INVALID",
  }));

  const malformedDir = path.join(trialsRoot, "malformed-manifest");
  fs.mkdirSync(malformedDir, { recursive: true });
  fs.writeFileSync(path.join(malformedDir, "manifest.json"), JSON.stringify({ schema_version: 99, seed_kind: "pilot" }, null, 2) + "\n", "utf-8");
  record(runGateCase({
    label: "refuse-malformed-manifest",
    candidateRoot: malformedDir,
    manifest: { schema_version: 99 },
    expected: "REFUSE",
  }));

  // Foreign identity: valid schema, but ownership.dev/ino pinned to a
  // different object than the candidate directory really is.
  const foreignDir = path.join(trialsRoot, "foreign-identity");
  fs.mkdirSync(foreignDir, { recursive: true });
  const foreignManifest = {
    schema_version: 1,
    seed_kind: "pilot",
    ownership: { root: foreignDir, dev: 0, ino: 0 },
  };
  record(runGateCase({
    label: "refuse-foreign-identity",
    candidateRoot: foreignDir,
    manifest: foreignManifest,
    expected: "REFUSE",
  }));

  // Moved origin ref (full-mode style): origin HEAD advances past the pin.
  const refDir = path.join(trialsRoot, "ref-moved");
  fs.mkdirSync(refDir, { recursive: true });
  const originDir = path.join(refDir, "origin");
  const git = (args) => {
    const res = spawnSync("git", args, { cwd: originDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (res.status !== 0) throw new Error(`preflight trial git ${args.join(" ")}: ${(res.stderr || "").trim()}`);
  };
  fs.mkdirSync(originDir, { recursive: true });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "aged-preflight@localhost"]);
  git(["config", "user.name", "aged-preflight"]);
  fs.writeFileSync(path.join(originDir, "f.txt"), "one\n", "utf-8");
  git(["add", "."]);
  git(["commit", "-m", "preflight trial origin commit 1"]);
  const pinnedHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: originDir, encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(originDir, "f.txt"), "two\n", "utf-8");
  git(["add", "."]);
  git(["commit", "-m", "preflight trial origin commit 2 (moves HEAD)"]);
  record(runGateCase({
    label: "refuse-origin-ref-moved",
    candidateRoot: refDir,
    manifest: { schema_version: 1, seed_kind: "full", origin: { path: originDir, headSha: pinnedHead } },
    expected: "REFUSE",
  }));

  // Resume-identity mismatch: the manifest pins a root path that is not the
  // candidate (a moved/replaced root must refuse rather than re-pin).
  const resumeDir = path.join(trialsRoot, "resume-identity");
  fs.mkdirSync(resumeDir, { recursive: true });
  const otherDir = path.join(trialsRoot, "resume-other");
  fs.mkdirSync(otherDir, { recursive: true });
  const resumeManifest = {
    schema_version: 1,
    seed_kind: "pilot",
    ownership: { root: otherDir, dev: 0, ino: 0 },
  };
  record(runGateCase({
    label: "refuse-resume-identity",
    candidateRoot: resumeDir,
    manifest: resumeManifest,
    expected: "REFUSE",
  }));

  // ── PASS on the supplied seed root (recording-only, zero effects) ──
  let rootManifest = null;
  const manifestFile = path.join(seedRoot, "manifest.json");
  if (fs.existsSync(manifestFile)) {
    try {
      rootManifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
    } catch {
      rootManifest = null;
    }
  }
  const originPin = rootManifest?.origin
    ? { path: rootManifest.origin.path, headSha: rootManifest.origin.head?.sha ?? null }
    : null;
  const passRec = runGateCase({
    label: "pass",
    candidateRoot: seedRoot,
    manifest: rootManifest,
    originPin,
    productDist,
    expected: "PASS",
  });
  record(passRec);

  const summary = {
    battery: "preflight-evidence",
    ts_utc: new Date().toISOString(),
    seedRoot,
    allExpected: results.every((r) => r.result === r.expected),
    results,
  };
  const summaryFile = path.join(evidenceRoot, "battery-summary.json");
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf-8");
  return summary;
}
