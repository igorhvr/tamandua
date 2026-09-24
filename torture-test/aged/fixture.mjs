// fixture.mjs — owned git origin for the aged-state seed.
//
// Pilot mode builds an explicitly tiny owned git fixture inside the seed root
// (green single-file repo, main branch, committed history, no remotes).  Full
// mode requires a SUPPLIED owned/pinned origin (the tt-poly seed/storm origin
// with retained branches, owned by storm assembly); the fixture module pins
// its identity into the manifest on first use and REFUSES (rather than
// re-pinning) if a resumed run observes a moved/foreign origin.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { utcNow, gitExec, gitTry, captureOwnership } from "./seedcommon.mjs";
import { gitHead, saveManifest } from "./manifest.mjs";

export function ensureOrigin({ manifest, root, paths, suppliedOrigin = null }) {
  const kind = manifest.seed_kind;
  if (kind === "pilot") {
    const dir = path.join(paths.fixturesDir, "tiny-origin");
    if (manifest.origin && manifest.origin.pinned) {
      verifyOriginPin(manifest.origin, "pilot origin");
      return { checkout: dir, mainRef: "main", pinned: true };
    }
    const origin = buildTinyOrigin(dir);
    manifest.origin = {
      kind: "tiny-owned",
      pinned: true,
      path: dir,
      head: origin.head,
      mainRef: "main",
      ownership: origin.ownership,
      created_at_utc: utcNow(),
    };
    saveManifest(root, manifest);
    return { checkout: dir, mainRef: "main", pinned: true };
  }

  // Full mode: an owned/pinned origin must be supplied (tt-poly seed/storm
  // origin with retained branches).  Never invent one here.
  const originPath = suppliedOrigin ?? process.env.TT_POLY_ORIGIN ?? null;
  if (!originPath) {
    throw new Error(
      "full mode requires a supplied owned/pinned tt-poly origin (--origin <path> or TT_POLY_ORIGIN); no origin supplied — refusing to fabricate",
    );
  }
  const real = fs.realpathSync(originPath);
  const top = gitTry(real, ["rev-parse", "--show-toplevel"]);
  if (!top || path.resolve(top) !== real) {
    throw new Error(`full-mode origin must be a git working tree: ${originPath}`);
  }
  if (manifest.origin && manifest.origin.pinned) {
    verifyOriginPin(manifest.origin, "full origin");
    return { checkout: real, mainRef: manifest.origin.mainRef ?? "main", pinned: true };
  }
  const head = gitHead(real);
  const branches = gitExec(real, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean);
  const mainRef = branches.includes("main") ? "main" : (branches[0] ?? null);
  if (!mainRef) throw new Error(`full-mode origin has no branches: ${real}`);
  const ownership = captureOwnership(real);
  manifest.origin = {
    kind: "supplied-owned",
    pinned: true,
    path: real,
    head,
    branches,
    mainRef,
    ownership,
    created_at_utc: utcNow(),
  };
  saveManifest(root, manifest);
  return { checkout: real, mainRef, pinned: true };
}

function verifyOriginPin(pin, label) {
  const cur = gitHead(pin.path);
  if (cur.sha !== pin.head.sha) {
    throw new Error(
      `${label} HEAD moved since pinning (pinned ${pin.head.sha}, now ${cur.sha}) — refuse rather than re-pinning`,
    );
  }
  const own = captureOwnership(pin.path);
  if (own.dev !== pin.ownership.dev || own.ino !== pin.ownership.ino) {
    throw new Error(`${label} identity (dev/ino) changed since pinning — refuse`);
  }
}

// Export the tiny-origin builder for the self-test (it never runs a real
// model and is safe to call on any owned fresh dir).
export function buildTinyOrigin(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const run = (args) => {
    const res = spawnSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (res.status !== 0) {
      throw new Error(`tiny origin: git ${args.join(" ")} failed: ${(res.stderr || "").trim()}`);
    }
    return res.stdout.trim();
  };
  if (!fs.existsSync(path.join(dir, ".git"))) {
    run(["init", "-b", "main"]);
    run(["config", "user.email", "aged-seed@localhost"]);
    run(["config", "user.name", "aged-seed"]);
    fs.writeFileSync(path.join(dir, "README.md"), "# tiny aged-state origin\n\nseed-fixture repository owned by the tt-storm-aged seed.\n", "utf-8");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "a.txt"), "a\n", "utf-8");
    fs.writeFileSync(path.join(dir, "src", "b.txt"), "b\n", "utf-8");
    // sample.test.sh belongs under tests/ (the worktree workflows expect a
    // conventional repo layout with a tests dir; the seed fixture never runs a
    // real model, but the layout must be faithful).  Build the tests dir
    // explicitly — a plain path join, no segment-dropping replace tricks.
    fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "tests", "sample.test.sh"),
      "#!/usr/bin/env bash\n# seed-fixture sample test (synthetic; never executed by a real model)\nexit 0\n",
      "utf-8",
    );
    run(["add", "."]);
    run(["commit", "-m", "seed-fixture initial commit"]);
    fs.writeFileSync(path.join(dir, "src", "a.txt"), "a2\n", "utf-8");
    run(["add", "."]);
    run(["commit", "-m", "seed-fixture second commit"]);
  }
  const head = gitHead(dir);
  const ownership = captureOwnership(dir);
  return { head, ownership, dir };
}
