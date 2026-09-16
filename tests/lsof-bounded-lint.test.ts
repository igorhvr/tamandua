/**
 * LSOF-EVTA US-005 lint: every remaining Node `lsof` call site is bounded.
 *
 * `lsof` walks kernel process/file tables and on a host with a stale FUSE or
 * network mount can block forever inside the kernel (on vaivm 24 such
 * processes sat for five days). The US-001 primitive (`src/lib/lsof-probe.ts`)
 * centralizes the safe shape for product code; this gate enforces the same
 * contract for every other direct Node call site — product source, test
 * helpers and the torture-test Node tools:
 *
 *   - argv always carries `-b` (avoid blocking kernel calls) and `-w`
 *     (suppress warnings);
 *   - the call passes a finite `timeout`;
 *   - the call passes `killSignal: "SIGKILL"` (SIGTERM does not interrupt an
 *     lsof wedged in the kernel).
 *
 * Scope (deliberately narrow): `src/**\/*.ts`, `tests/**\/*.ts`,
 * `torture-test/bin/*.mjs` and the extensionless `torture-test/bin/
 * tt-verify-environment`. The POSIX shell call sites (bin/daemon-control,
 * tt-recorder) are bounded by their own portable background+kill+wait helper
 * (US-006/US-007) and are NOT scanned here; `torture-test/self-tests/**`
 * mentions lsof only inside structural assertions/strings, never as an
 * invocation, so it is not scanned either.
 *
 * This file is pure (parallel lane): no node:child_process, no spawns.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();
const LSOF = "lsof";

// The invocation matcher is composed from fragments so this lint file's own
// source never contains a literal that would match itself. It covers the
// literal `lsof` command (quoted or in a template/shell string) and the
// `lsofBin` variable seam used by torture-test/bin/tt-process-identity.mjs.
const INVOCATION_RE = new RegExp(
  "\\b(?:spawnSync|execFileSync|execFile|spawn|execSync|exec)" +
    "\\s*\\(\\s*(?:'" +
    LSOF +
    "'|\"" +
    LSOF +
    '"|`' +
    LSOF +
    "|" +
    LSOF +
    "Bin\\b)",
  "g",
);

interface InvocationSite {
  file: string;
  line: number;
  slice: string;
}

/** Recursively collect every `*.ts` file below `dir`. */
function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
}

/**
 * Return the text of one invocation: from the call site through the matching
 * closing paren of the argument list (paren-aware, so multi-line option
 * objects are included). Not string-aware, but every call site here is a
 * plain array/options call.
 */
function sliceInvocation(content: string, matchIndex: number): string {
  const open = content.indexOf("(", matchIndex);
  if (open === -1) return content.slice(matchIndex);
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    const ch = content[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return content.slice(matchIndex, i + 1);
    }
  }
  return content.slice(matchIndex);
}

/** True when `flag` appears as a standalone argv/shell token in `slice`. */
function hasFlagToken(slice: string, flag: string): boolean {
  return new RegExp(`(?:^|[\\s'"\`])${flag}(?:[\\s'"\`]|$)`).test(slice);
}

function findInvocations(relPath: string, content: string): InvocationSite[] {
  const sites: InvocationSite[] = [];
  for (const match of content.matchAll(INVOCATION_RE)) {
    const index = match.index ?? 0;
    sites.push({
      file: relPath,
      line: content.slice(0, index).split("\n").length,
      slice: sliceInvocation(content, index),
    });
  }
  return sites;
}

function scannedFiles(): string[] {
  const files: string[] = [];
  collectTsFiles(join(REPO_ROOT, "src"), files);
  collectTsFiles(join(REPO_ROOT, "tests"), files);
  const ttBin = join(REPO_ROOT, "torture-test", "bin");
  for (const entry of readdirSync(ttBin, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".mjs") || entry.name === "tt-verify-environment") {
      files.push(join(ttBin, entry.name));
    }
  }
  return files;
}

/**
 * Files that embed an `lsof` command as a lint FIXTURE string instead of
 * invoking it. `portability-lint.test.ts` feeds its scanner canned content
 * that intentionally contains the old unbounded shape, so it must not be
 * treated as a live call site (a REAL invocation added there would need a
 * fresh review).
 */
const FIXTURE_ONLY_FILES = new Set(["tests/portability-lint.test.ts"]);

function allInvocations(): InvocationSite[] {
  const sites: InvocationSite[] = [];
  for (const file of scannedFiles()) {
    const relPath = relative(REPO_ROOT, file);
    if (FIXTURE_ONLY_FILES.has(relPath)) continue;
    sites.push(...findInvocations(relPath, readFileSync(file, "utf8")));
  }
  return sites;
}

describe("LSOF-EVTA US-005 — every Node lsof call site is bounded", () => {
  it("discovers the known call sites (guards against a scanner that matches nothing)", () => {
    const files = new Set(allInvocations().map((s) => s.file));
    // The three call sites this story bounds plus the US-004 torture reader.
    assert.ok(
      files.has("tests/helpers/invocation-owned-cleanup.ts"),
      `expected the darwin observer site; found: ${[...files].join(", ")}`,
    );
    assert.ok(
      files.has("tests/dashboard-status-mcp.test.ts"),
      `expected the orphan-sweep site; found: ${[...files].join(", ")}`,
    );
    assert.ok(
      files.has("torture-test/bin/tt-verify-environment"),
      `expected the tt-verify-environment sites; found: ${[...files].join(", ")}`,
    );
    assert.ok(
      files.has("torture-test/bin/tt-process-identity.mjs"),
      `expected the US-004 torture reader site; found: ${[...files].join(", ")}`,
    );
  });

  it("no lsof invocation lacks -b and -w", () => {
    const offenders: string[] = [];
    for (const site of allInvocations()) {
      if (!hasFlagToken(site.slice, "-b") || !hasFlagToken(site.slice, "-w")) {
        offenders.push(`${site.file}:${site.line}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `lsof invocations must always pass -b -w (no blocking kernel calls, warnings suppressed): ${offenders.join(", ")}`,
    );
  });

  it("no lsof invocation lacks a finite timeout and SIGKILL-on-timeout", () => {
    const offenders: string[] = [];
    for (const site of allInvocations()) {
      const hasTimeout = /timeout\s*[:,]/.test(site.slice);
      const hasKillSignal = /killSignal\s*:\s*['"]SIGKILL['"]/.test(site.slice);
      if (!hasTimeout || !hasKillSignal) {
        offenders.push(
          `${site.file}:${site.line} (timeout=${hasTimeout}, killSignal=${hasKillSignal})`,
        );
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `lsof invocations must bound the child with a finite timeout + killSignal SIGKILL: ${offenders.join(", ")}`,
    );
  });

  it("scans a non-trivial tree (sanity: source and test files were read)", () => {
    assert.ok(
      scannedFiles().length > 100,
      "the scanner should read the product + test tree, not an empty set",
    );
  });
});
