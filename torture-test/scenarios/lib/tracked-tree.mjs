// tracked-tree.mjs — git tracked-tree verification for scenario assets
// (T2.1 EMERGENCY, US-002).
//
// The tier asset validators (bin/tt-tier2-assets, bin/tt-tier0-assets) must
// verify that every manifest-referenced scenario dir is part of the TRACKED
// TREE (`git ls-files`), NOT merely present on disk. Otherwise an authoring
// worktree whose scenario assets live only under gitignored var/ or as
// untracked files can go GREEN, while merged main — which only carries
// committed files — lacks the cells and the campaign dies with ENOENT
// (the 11 instant TEST_INFRA_FAILs of campaign-20260816T235948135Z).
//
// Every function here fails CLOSED: when tracked-ness cannot be verified
// (not a git checkout, git missing, ls-files error) the caller must refuse,
// so an untracked-asset GREEN is impossible for any tier.
//
// Confined to torture-test/. Zero tokens (pure git plumbing + path math).
import { execFileSync } from "node:child_process";
import path from "node:path";

// gitLsFiles(repoRoot, rel) — run `git ls-files -- <rel>` inside repoRoot and
// return the list of tracked paths (non-empty lines, repo-root-relative).
// Returns null when git is unavailable, the directory is not inside a git
// repository, or the command fails — callers must fail closed on null.
export function gitLsFiles(repoRoot, rel) {
  try {
    const out = execFileSync("git", ["ls-files", "--", rel], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return String(out)
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
  } catch {
    return null;
  }
}

// gitRepoRoot(cwdPath) — absolute top-level of the git repository that
// contains cwdPath (`git rev-parse --show-toplevel`), or null when cwdPath is
// not inside a git checkout.
export function gitRepoRoot(cwdPath) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: cwdPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const root = String(out).trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

// trackedTreeIssue(candidateAbs, cwdPath) — verifies that at least one TRACKED
// file lives under the absolute dir candidateAbs. Returns null when verified;
// otherwise returns a human-readable reason string (the caller attaches it to
// its own fail message, which must name the missing scenario dir).
//
// cwdPath must be inside the same git checkout as candidateAbs — callers pass
// the torture-test root (ttRoot), and candidateAbs is derived from a
// manifest-referenced scenarios/<dir> path resolved against that root.
export function trackedTreeIssue(candidateAbs, cwdPath) {
  const repoRoot = gitRepoRoot(cwdPath);
  if (repoRoot === null) {
    return "cannot determine the git repository root (is torture-test/ inside a git checkout?) — tracked-ness is unverifiable";
  }
  const rel = path.relative(repoRoot, candidateAbs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return `scenario dir ${candidateAbs} lies outside the git repository root ${repoRoot}`;
  }
  const tracked = gitLsFiles(repoRoot, rel);
  if (tracked === null) {
    return `git ls-files failed for ${rel} — tracked-ness is unverifiable`;
  }
  if (tracked.length === 0) {
    return `no tracked file exists under ${rel} (git ls-files is empty) — scenario assets must be committed to the tracked tree`;
  }
  return null;
}
