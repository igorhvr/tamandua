/**
 * NAT-EGRESS US-011 — lifecycle guard for the fresh-launch outbound mode.
 *
 * The accepted design is deliberately SMALL: the network mode is chosen once
 * when a run/session is CREATED, persisted as one optional field inside the
 * existing `runs.matchlock_policy` v3 JSON, and composed from that stored
 * record by the ONE shared create composer. There is no transition machinery:
 * changing the mode of an existing run is explicitly out of scope, no schema
 * migration was added, and no policy/network-policy version was bumped.
 *
 * This guard pins that shape against future drift:
 *
 *   1. The rejected lifecycle modules `resume-transition-journal.ts`,
 *      `resume-barrier.ts` and `network-transition.ts` do NOT exist under
 *      `src/installer/matchlock/` (source) or `dist/installer/matchlock/`
 *      (compiled), and no source or test file references them.
 *   2. `SCHEMA_VERSION` from `src/db.ts` is exactly 16 — the same value as the
 *      published base commit d8047aa5 — so this feature added no migration.
 *   3. `MATCHLOCK_POLICY_VERSION` is 3 and
 *      `MATCHLOCK_NETWORK_POLICY_VERSION` is 2 (the optional field rides the
 *      existing v3 record without a version bump).
 *
 * The baseline numbers are frozen here on purpose: if any of them must change,
 * the change is a deliberate lifecycle/schema decision and this guard must be
 * updated in the same commit (it must never be "fixed" by importing the current
 * value into the expectation).
 *
 * Pure filesystem + compiled-constant assertions: no spawn, no VM, no HOME or
 * state access, so this file stays in the parallel lane.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SCHEMA_VERSION } from "../../../dist/db.js";
import {
  MATCHLOCK_NETWORK_POLICY_VERSION,
  MATCHLOCK_POLICY_VERSION,
} from "../../../dist/installer/matchlock/policy.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const MATCHLOCK_SRC_DIR = path.join(REPO_ROOT, "src", "installer", "matchlock");
const MATCHLOCK_DIST_DIR = path.join(REPO_ROOT, "dist", "installer", "matchlock");

/** Frozen baseline (published d8047aa5) — see the file header. */
const BASELINE_D8047AA5_SCHEMA_VERSION = 16;
const BASELINE_D8047AA5_MATCHLOCK_POLICY_VERSION = 3;
const BASELINE_D8047AA5_MATCHLOCK_NETWORK_POLICY_VERSION = 2;

/**
 * The out-of-scope lifecycle modules the rejected bd6ab06b branch introduced.
 * None of them may exist in this candidate, and nothing may import them.
 */
const FORBIDDEN_LIFECYCLE_MODULES = [
  "resume-transition-journal",
  "resume-barrier",
  "network-transition",
] as const;

function walkTypescriptSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTypescriptSources(full));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs"))) {
      out.push(full);
    }
  }
  return out;
}

describe("NAT-EGRESS lifecycle guard (fresh-launch only, no transition machinery)", () => {
  it("the three rejected lifecycle modules do not exist in source or compiled output", () => {
    for (const moduleName of FORBIDDEN_LIFECYCLE_MODULES) {
      const sourcePath = path.join(MATCHLOCK_SRC_DIR, `${moduleName}.ts`);
      assert.equal(
        fs.existsSync(sourcePath),
        false,
        `out-of-scope lifecycle module must not exist: ${path.relative(REPO_ROOT, sourcePath)}`,
      );
      for (const compiled of [`${moduleName}.js`, `${moduleName}.d.ts`]) {
        const distPath = path.join(MATCHLOCK_DIST_DIR, compiled);
        assert.equal(
          fs.existsSync(distPath),
          false,
          `out-of-scope lifecycle module must not be compiled: ${path.relative(REPO_ROOT, distPath)}`,
        );
      }
    }
  });

  it("no file in the repository references the rejected lifecycle modules", () => {
    const selfPath = path.join(HERE, "network-outbound-lifecycle-guard.test.ts");
    const sources = walkTypescriptSources(path.join(REPO_ROOT, "src")).filter(
      (file) => path.resolve(file) !== path.resolve(selfPath),
    );
    assert.ok(sources.length > 0, "expected to scan TypeScript sources under src/");
    const offenders: string[] = [];
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf8");
      for (const moduleName of FORBIDDEN_LIFECYCLE_MODULES) {
        if (text.includes(moduleName)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} -> ${moduleName}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `no source may reference the out-of-scope lifecycle modules:\n${offenders.join("\n")}`,
    );
  });

  it("no transition/barrier/journal module was added to the matchlock package", () => {
    const suspicious = fs
      .readdirSync(MATCHLOCK_SRC_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /(transition|barrier)/.test(name) && !name.endsWith(".test.ts"));
    assert.deepEqual(
      suspicious,
      [],
      "the fresh-launch feature must not add network-transition/resume-barrier machinery",
    );
  });

  it("SCHEMA_VERSION is unchanged from the published base commit (16)", () => {
    assert.equal(SCHEMA_VERSION, BASELINE_D8047AA5_SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 16);
  });

  it("the Matchlock policy versions are unchanged (policy 3, network policy 2)", () => {
    assert.equal(MATCHLOCK_POLICY_VERSION, BASELINE_D8047AA5_MATCHLOCK_POLICY_VERSION);
    assert.equal(MATCHLOCK_POLICY_VERSION, 3);
    assert.equal(
      MATCHLOCK_NETWORK_POLICY_VERSION,
      BASELINE_D8047AA5_MATCHLOCK_NETWORK_POLICY_VERSION,
    );
    assert.equal(MATCHLOCK_NETWORK_POLICY_VERSION, 2);
  });
});
