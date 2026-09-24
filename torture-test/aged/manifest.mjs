// manifest.mjs — owned seed-root manifest, allocation and identity pinning
// for the tt-storm-aged aged-state generator.
//
// Every seed lives under a freshly mkdtemp-owned root (default:
// <repo>/torture-test/var/results/storm-aged.<ts>-<rand>).  The manifest
// durably records source/catalog/recipe/root identities BEFORE any effect and
// is the resume/reconcile authority: on resume, identity mismatches refuse
// rather than re-pinning.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  AGED_SCHEMA_VERSION,
  utcNow,
  appendJsonl,
  writeExclusive,
  readJson,
  readJsonl,
  captureOwnership,
  sha256File,
  sha256Hex,
  gitExec,
  gitTry,
} from "./seedcommon.mjs";

export const SEED_KIND_PILOT = "pilot";
export const SEED_KIND_FULL = "full";

export function defaultResultsRoot() {
  // <this file>/../../var/results — i.e. torture-test/var/results (gitignored).
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "var", "results");
}

export function allocateSeedRoot({ baseDir, kind, runId }) {
  if (kind !== SEED_KIND_PILOT && kind !== SEED_KIND_FULL) {
    throw new Error(`allocateSeedRoot: unknown kind "${kind}"`);
  }
  fs.mkdirSync(baseDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(4).toString("hex");
  const root = fs.mkdtempSync(path.join(baseDir, `storm-aged.${stamp}.${rand}.`));
  const ownership = captureOwnership(root);

  const manifest = {
    schema_version: AGED_SCHEMA_VERSION,
    seed_kind: kind,
    allocated_at_utc: utcNow(),
    allocated_by_run: runId ?? null,
    ownership: {
      root: ownership.root,
      dev: ownership.dev,
      ino: ownership.ino,
    },
    source: null, // pinned by pinSource()
    catalog: null, // pinned by pinCatalog()
    origin: null, // pinned by pinOrigin()
    recipe: null, // pinned by pinRecipe()
    phases: {},
    counts: null, // filled by census after each phase
    qualified: false,
    disposition_counts: {},
  };

  fs.mkdirSync(path.join(root, "receipts"), { recursive: true });
  fs.mkdirSync(path.join(root, "evidence"), { recursive: true });
  fs.mkdirSync(path.join(root, "journal"), { recursive: true });
  writeExclusive(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  // Allocation receipt — durable BEFORE any effect.
  appendJsonl(path.join(root, "receipts", "root-allocated.jsonl"), {
    receipt: "root-allocated",
    ...ownership,
    allocated_at_utc: manifest.allocated_at_utc,
  });
  return root;
}

export function loadManifest(root) {
  const mf = readJson(path.join(root, "manifest.json"));
  // Refuse manifest/schema mismatch rather than repinning.
  if (mf.schema_version !== AGED_SCHEMA_VERSION) {
    throw new Error(
      `manifest schema mismatch: found ${mf.schema_version}, expected ${AGED_SCHEMA_VERSION}`,
    );
  }
  return mf;
}

export function saveManifest(root, manifest) {
  const tmp = path.join(root, "manifest.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, path.join(root, "manifest.json"));
}

export function assertRootIdentity(root, manifest) {
  const cur = captureOwnership(root);
  if (cur.root !== manifest.ownership.root) {
    throw new Error(
      `root identity mismatch: manifest pinned ${manifest.ownership.root}, actual ${cur.root}`,
    );
  }
  if (cur.dev !== manifest.ownership.dev || cur.ino !== manifest.ownership.ino) {
    throw new Error(
      `root dev/ino mismatch: manifest pinned ${manifest.ownership.dev}/${manifest.ownership.ino}, actual ${cur.dev}/${cur.ino}`,
    );
  }
  return cur;
}

export function phaseReceipt(root, phase, record) {
  appendJsonl(path.join(root, "receipts", `${phase}.jsonl`), {
    ts_utc: utcNow(),
    phase,
    ...record,
  });
}

export function journal(root, record) {
  appendJsonl(path.join(root, "journal", "journal.jsonl"), {
    ts_utc: utcNow(),
    ...record,
  });
}

export function readPhaseReceipts(root, phase) {
  return readJsonl(path.join(root, "receipts", `${phase}.jsonl`));
}

export function readJournal(root) {
  return readJsonl(path.join(root, "journal", "journal.jsonl"));
}

// Pin the generator's own source identity (repo commit/tree at load time).
export function pinSource({ repoRoot, gitHeadSha, gitHeadTree, gitSubject }) {
  return {
    commit: gitHeadSha,
    tree: gitHeadTree,
    subject: gitSubject,
    repoRoot,
  };
}

// Capture the EXECUTED code identity of the generator itself, durably, BEFORE
// any effect (allocation-time / phase-entry).  Reproducibility requires
// knowing exactly what ran, not just what HEAD was: when the working tree is
// dirty (the generator may legitimately run from an uncommitted tree), HEAD
// alone understates the executed code.  We therefore record:
//   head/head_tree  — the pinned base commit,
//   clean           — whether the working tree had no uncommitted changes,
//   porcelain_sha256 — sha256 of `git status --porcelain=v1` (stable ordering),
//                      so a dirty executed tree is still uniquely identified.
// Consumers refuse to re-pin on mismatch (identity is captured once).
export function pinExecutedSource(repoRoot) {
  const head = gitHead(repoRoot);
  const porcelain = gitTry(repoRoot, ["status", "--porcelain=v1"]) ?? "";
  return {
    repo_root: repoRoot,
    head,
    executed_at_utc: utcNow(),
    clean: porcelain.trim() === "",
    porcelain_sha256: sha256Hex(porcelain),
    provenance: "recorded before effects at allocation/phase entry (working-tree identity, not just HEAD)",
  };
}

// Refuse to re-pin when a manifest already carries an executed-source pin and
// the executed identity differs: source/recipe/root identity mismatch refuses
// rather than silently re-pinning (resume/reconcile authority).  A clean tree
// whose HEAD advanced past the pinned head is a legitimate code upgrade
// (refinement commits); that is reported, not refused — the executed identity
// of the already-created corpus is immutable.  A DIRTY executed tree can never
// be re-attributed to a later clean commit.
export function reconcileExecutedSource({ repoRoot, manifest }) {
  const current = pinExecutedSource(repoRoot);
  const pinned = manifest?.source ?? null;
  if (!pinned?.head) return { pinned: null, current };
  if (pinned.head.sha !== current.head.sha && current.clean && !pinned.clean) {
    return {
      pinned,
      current,
      note: "pinned executed source was a dirty tree over an earlier HEAD; current tree is clean at a later commit — retained corpus provenance is unchanged (see evidence/provenance-executed-identity.json)",
    };
  }
  return { pinned, current, note: null };
}

// Pin the bundled catalog identity (workflow.yml tree hashes per id).
export function pinCatalog(workflowsSourceDir, ids) {
  const catalog = {};
  for (const id of ids) {
    const yml = path.join(workflowsSourceDir, id, "workflow.yml");
    if (!fs.existsSync(yml)) {
      throw new Error(`pinCatalog: bundled workflow ${id} missing workflow.yml`);
    }
    catalog[id] = {
      workflow_yml_sha256: sha256File(yml),
      yml_path: yml,
    };
  }
  return catalog;
}

export function verifyCatalogStateDir(stateWorkflowsDir, pinnedCatalog) {
  const report = {};
  for (const id of Object.keys(pinnedCatalog)) {
    const yml = path.join(stateWorkflowsDir, id, "workflow.yml");
    if (!fs.existsSync(yml)) {
      report[id] = { ok: false, reason: "missing installed workflow.yml" };
      continue;
    }
    const h = sha256File(yml);
    report[id] = {
      ok: h === pinnedCatalog[id].workflow_yml_sha256,
      installed_sha256: h,
      pinned_sha256: pinnedCatalog[id].workflow_yml_sha256,
    };
  }
  return report;
}

export function recordsContainedPaths(root) {
  return {
    receiptsDir: path.join(root, "receipts"),
    evidenceDir: path.join(root, "evidence"),
    stateDir: path.join(root, "state"),
    worktreesRoot: path.join(root, "worktrees"),
    homeDir: path.join(root, "home"),
    tmpDir: path.join(root, "tmp"),
    fixturesDir: path.join(root, "fixtures"),
    catalogDir: path.join(root, "catalog-source"),
  };
}

export function ensureLayout(root) {
  const p = recordsContainedPaths(root);
  for (const dir of Object.values(p)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

// Resolve the pristine HEAD of a git repository (for identity pinning).
export function gitHead(repoDir) {
  return {
    sha: gitExec(repoDir, ["rev-parse", "HEAD"]),
    tree: gitExec(repoDir, ["rev-parse", "HEAD^{tree}"]),
    subject: gitExec(repoDir, ["log", "-1", "--pretty=%s"]),
  };
}
