/**
 * MTLK-INTERACTIVE-SUITE US-009 — T4 M7 spot-run contract.
 *
 * `scripts/tests/matchlock/runner/m7-spot-run.sh` is the T4 scheduled
 * `tamandua workflow run do-now --matchlock` spot-run. It is a faithful port of
 * the ACCEPTED W2 toolset `tools/m7-spot-run.sh` and the frozen
 * `templates/m7-spot-run-v2.sh` (`MTLK-INTERACTIVE-SUITE-SOURCES-20261009`):
 * isolated daemon (private `TAMANDUA_STATE_DIR`/DB/control-dashboard-MCP ports),
 * ownership-verified daemon stop, bounded run, `spot.txt == 'spot-ok'` artifact,
 * the run's own diag `resolvedImageDigest` binding, strict before/after
 * inventory snapshots, and a BOUND verdict file.
 *
 * ADDITION (tamandua-sus fix): the historical instrument enumerated "owned" VMs
 * only from diag-bundle `vmId` strings, so a STOPPED attempt-owned VM escaped
 * detection. This port enumerates the matchlock VM registry `vms` table
 * (INCLUDING `status='stopped'`) and requires ownership evidence — creation
 * inside the attempt window AND an exact workdir/config reference (or the run's
 * own diag naming the exact id) — before any exact-id `matchlock rm`. A
 * failed/unknown removal retains state and fails.
 *
 * BOUND VERDICT: the evaluated result is written to `$B/m7.verdict`, and the
 * absolute path of that invocation's file is recorded in
 * `<evidence-dir>/M7/m7-verdict-path.txt`; the final gate reads that file, so a
 * stray `M7-PASS` token in captured sub-output can never be the gate.
 *
 * This file is pure filesystem reads (no child_process, no dist import, no
 * daemon, no VM, no network, no model), so it stays in the parallel lane and
 * needs no tests/serial-files.txt entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const m7Path = path.join(repoRoot, "scripts", "tests", "matchlock", "runner", "m7-spot-run.sh");

function readM7(): string {
  assert.ok(existsSync(m7Path), `missing M7 runner ${m7Path}`);
  return readFileSync(m7Path, "utf-8");
}

/** Extract a top-level `name() { ... }` function body from shell source. */
function functionBody(text: string, name: string): string {
  const marker = `\n${name}() {`;
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `m7-spot-run.sh must define ${name}()`);
  const lines = text.slice(start + 1).split("\n");
  const body: string[] = [];
  for (const line of lines) {
    body.push(line);
    if (body.length > 1 && line === "}") break;
  }
  assert.equal(body[body.length - 1], "}", `could not find the end of ${name}()`);
  return body.join("\n");
}

describe("Matchlock interactive T4 M7 spot-run contract (MTLK-INTERACTIVE-SUITE US-009)", () => {
  it("ships an executable M7 runner wired to the shared suite modules and modes", () => {
    assert.ok(existsSync(m7Path), `missing ${m7Path}`);
    assert.ok(statSync(m7Path).isFile(), "m7-spot-run.sh is not a regular file");
    const text = readM7();
    for (const needle of [
      "lib/common.sh",
      "lib/lock.sh",
      "lib/image-store.sh",
      "mtlk_resolve_runtime",
      "mtlk_probe_capabilities",
      "mtlk_require_digest",
      "mtlk_resolve_mode",
      "mtlk_run_tamandua",
      "mtlk_gate_lock_acquire",
      "mtlk_gate_lock_release",
    ]) {
      assert.ok(text.includes(needle), `m7-spot-run.sh must use ${needle}`);
    }
    assert.match(text, /MTLK_EXPECT_DIGEST/, "the expected digest is a runner input");
    assert.match(text, /MTLK_M7_MATCHLOCK_VERSION/, "the matchlock provenance assertion is rebound, not dropped");
  });

  it("binds the M7 verdict file so a stray M7-PASS token can never be the gate", () => {
    const text = readM7();
    assert.ok(text.includes("m7-verdict-path.txt"), "must record the bound verdict path");
    assert.match(text, /printf '%s\\n' "\$VERDICT_FILE" >"\$EVM7\/m7-verdict-path\.txt"/);
    assert.match(text, /VERDICT_FILE="\$B\/m7\.verdict"/);
    assert.match(text, /echo "PASS" >"\$VERDICT_FILE"/);
    assert.match(text, /echo "FAIL" >"\$VERDICT_FILE"/);
    // The final gate reads the BOUND file, never a marker word.
    assert.match(text, /M7V="\$\(cat "\$VERDICT_FILE"/);
    assert.match(text, /\[ "\$M7V" = "PASS" \]/);
    assert.match(text, /printf '%s log=%s verdict-file=%s\\n' "\$FINAL" "\$LOG" "\$M7V"/);
    // `M7-PASS` is only ever a printed marker line, never a condition.
    assert.ok(text.includes("M7-PASS"), "the marker is still printed for humans");
    assert.doesNotMatch(text, /grep[^\n]*M7-PASS/);
    assert.doesNotMatch(text, /\[[^\n]*M7-PASS/);
    assert.doesNotMatch(text, /if[^\n]*M7-PASS/);
  });

  it("enumerates the attempt matchlock registry vms table INCLUDING stopped rows (tamandua-sus)", () => {
    const text = readM7();
    assert.match(text, /FROM\s+vms/i, "must read the matchlock registry vms table");
    assert.match(text, /SELECT id, status, created_at, config_json FROM vms/);
    assert.match(text, /mtlk_matchlock_state_db/, "must read the matchlock state DB, not the image-store metadata");
    assert.match(text, /status\s*!=\s*"stopped"/, "must include status='stopped' rows, not only diag vmIds");
    assert.match(text, /stopped-row/, "a stopped attempt-owned row must be recorded as accounted");
    assert.match(text, /created-in-attempt-window/);
  });

  it("requires ownership evidence before any exact-id removal", () => {
    const text = readM7();
    assert.match(text, /def mount_match/, "must correlate against the stored config");
    assert.match(text, /"destination", "guest", "guest_path"/, "exact guest destination fields only");
    assert.match(text, /t0 <= created_s <= t1/, "creation must fall inside the attempt window");
    assert.match(text, /exact-workdir\/config-reference/);
    assert.match(text, /diag-bundle-named-id/);
    // EXACT id removal only, never a glob.
    assert.match(text, /"\$ML" rm "\$v"/);
    assert.doesNotMatch(text, /"\$ML" rm [^\n]*[*]/);
    // Only the OWNED set is passed to rm; unowned ids are reported, never removed.
    assert.match(text, /for v in \$OWNED_PRESENT/);
    assert.doesNotMatch(text, /for v in \$UNOWNED_NEW/);
    // A failed/unknown removal RETAINS state and fails.
    assert.match(text, /VERIFY_OK/);
    assert.match(text, /RM_FAILED/);
    assert.match(text, /OWNED_REMAIN/);
    assert.match(text, /state retained on failure/);
  });

  it("cannot be skipped via inherited environment and acquires the gate lock at one layer only", () => {
    const text = readM7();
    assert.match(text, /mtlk_m7_skip_notice/);
    const body = functionBody(text, "mtlk_m7_skip_notice");
    assert.match(body, /MTLK_M7_SKIP/);
    assert.match(body, /LI155_M7/);
    assert.match(body, /cannot be skipped via inherited environment/);
    assert.doesNotMatch(body, /\bexit\b/, "the skip notice must not exit (a skip is not a pass)");
    assert.doesNotMatch(body, /\breturn 0\b/);
    // No skip switch can turn the run into a successful no-op.
    assert.doesNotMatch(text, /MTLK_M7_SKIP[^\n]*(exit 0|PASS|return 0)/);
    assert.doesNotMatch(text, /LI155_M7[^\n]*(exit 0|PASS|return 0)/);
    // Single layer: lock.sh owns flock; this script must never acquire it raw.
    assert.doesNotMatch(text, /\bflock\b/);
    assert.match(text, /single-layer/i);
  });

  it("keeps the protected M7 predicates and stays configuration-bound", () => {
    const text = readM7();
    assert.ok(text.includes("spot-ok"), "the artifact content assertion must survive");
    assert.match(text, /resolvedImageDigest/);
    assert.match(text, /M7-IMAGE-BINDING-OK/);
    assert.match(text, /mtlk_m7_parse_inventory/, "strict inventory parsing must survive");
    assert.match(text, /artifact_ok/);
    assert.match(text, /workflow stop "\$RID"/);
    // Allow-private covers the hostname AND the resolved IPv4 spelling.
    assert.match(text, /MTLK_ALLOW_PRIVATE|MTLK_M7_ALLOW_PRIVATE/);
    assert.match(text, /AF_INET/);
    // No literal 64-hex digest, host path, endpoint literal or backend name.
    assert.doesNotMatch(text, /\b[0-9a-f]{64}\b/i, "the digest must be a runner input, not a literal");
    assert.doesNotMatch(text, /\b(?:firecracker|qemu)\b/i, "no backend name may appear in the M7 runner");
    for (const literal of ["/home/", "/Users/", "li155-matrix", "192.168.107.74", "dogfood"]) {
      assert.ok(!text.includes(literal), `m7-spot-run.sh must not contain the host literal ${literal}`);
    }
  });
});
