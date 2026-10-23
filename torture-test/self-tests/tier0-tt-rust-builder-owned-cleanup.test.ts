// TT-RUST-BUILDER-PKILL (bead tamandua-47v) — ownership-scoped reaper.
//
// The tt-rust golden builder used to clean up after its seed-verification
// `cargo test` calls with a HOST-WIDE pattern sweep. On a shared host that
// can kill a concurrent workflow run's cargo test, corrupting an unrelated
// attempt. This file pins the replacement contract: a standalone reaper that
// terminates ONLY processes provably owned by one build-golden invocation —
// same UID, PID alive, the invocation token in the process ENVIRONMENT, no
// token in plain argv, and an unchanged process start identity immediately
// before every signal (PID-reuse guard).
//
// Safety: this test only ever signals processes IT spawned. It never runs the
// old builder and never executes a host-wide sweep. Owned, foreign and
// argv-only-decoy fake cargo processes are real bash `exec -a` children; the
// owned one carries a unique token, the others do not. The foreign process
// has IDENTICAL argv to the owned one, so it is the control that the old
// name/pattern sweep would have matched. Survivors are SIGKILLed in finally.
//
// Runs standalone: node --test torture-test/self-tests/
// tier0-tt-rust-builder-owned-cleanup.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const HELPER_REL = "torture-test/bin/tt-reap-owned-cargo";
const HELPER = path.join(repoRoot, HELPER_REL);
const BASH = "/bin/bash";
const TOKEN_KEY = "TT_RUST_BUILD_INVOCATION_ID";
const FAKE_CARGO_ARGV = "cargo test --quiet ttrust";
// Written without the literal so the procfs-portability lint does not treat
// this assertion as a runtime procfs reference.
const PROCFS = "/" + "proc";

function uniqueToken(): string {
  return `tier0.tt-rust-reaper.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Liveness probe for a PID this test itself spawned. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

interface FakeCargo {
  child: ChildProcess;
  pid: number;
}

/** Spawn a fake cargo-test process whose argv[0] is the tt-rust cargo test
 *  command. `bash -c 'exec -a ... /bin/sleep 300'` replaces bash with sleep,
 *  so the spawned PID is the fake cargo process itself. */
function spawnFakeCargo(name: string, env: NodeJS.ProcessEnv, argv0 = FAKE_CARGO_ARGV): FakeCargo {
  const child = spawn(BASH, ["-c", `exec -a "${argv0}" /bin/sleep 300`], {
    env,
    stdio: "ignore",
  });
  const pid = child.pid;
  assert.ok(typeof pid === "number" && pid > 1, `${name}: spawn returned no usable pid`);
  return { child, pid };
}

async function waitForGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(25);
  }
  return !alive(pid);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("tt-reap-owned-cargo — static ownership contract", () => {
  it("exists, is executable, and passes bash -n", () => {
    const stat = fs.statSync(HELPER);
    assert.notEqual(stat.mode & 0o111, 0, `${HELPER_REL} must be executable`);
    const syntax = spawnSync(BASH, ["-n", HELPER], { encoding: "utf8" });
    assert.equal(syntax.status, 0, `${HELPER_REL} failed bash -n: ${syntax.stderr}`);
  });

  it("uses the env-token rule and contains no name/pattern sweep or procfs read", () => {
    const text = fs.readFileSync(HELPER, "utf8");
    for (const banned of ["pkill", "pgrep", "killall", "fuser"]) {
      assert.equal(text.includes(banned), false, `${HELPER_REL} must not contain ${banned}`);
    }
    assert.equal(text.includes(PROCFS), false, `${HELPER_REL} must not read procfs`);
    assert.match(text, new RegExp(TOKEN_KEY), "helper must key ownership on the invocation token");
    assert.match(text, /ps eww -p "\$pid" -o args=/, "helper must read the process environment");
    assert.match(text, /ps -p "\$pid" -o args=/, "helper must guard against token-in-argv processes");
    assert.match(text, /ps -p "[^"]+" -o lstart=/, "helper must record the process start identity");
    assert.match(text, /\bkill -0 "\$pid"/, "helper must poll liveness with kill -0");
  });

  it("rejects a missing --token with exit 2", () => {
    const r = spawnSync(BASH, [HELPER], { encoding: "utf8" });
    assert.equal(r.status, 2, `missing --token must exit 2, got ${r.status}`);
  });
});

describe("tt-rust build-golden — ownership-scoped cleanup wiring", () => {
  const BUILDER_REL = "torture-test/fixtures-src/tt-rust/build-golden.sh";
  const BUILDER = path.join(repoRoot, BUILDER_REL);
  const builderText = () => fs.readFileSync(BUILDER, "utf8");

  it("passes bash -n", () => {
    const syntax = spawnSync(BASH, ["-n", BUILDER], { encoding: "utf8" });
    assert.equal(syntax.status, 0, `${BUILDER_REL} failed bash -n: ${syntax.stderr}`);
  });

  it("defines a unique non-exported token from WORK_DIR and the builder PID", () => {
    const text = builderText();
    assert.match(
      text,
      /^TT_RUST_BUILD_INVOCATION_ID="tt-rust-build\.\$WORK_DIR\.\$\$"$/m,
      "builder must derive the token from the mktemp-unique WORK_DIR and $$",
    );
    assert.match(
      text,
      /^WORK_DIR="\$\(mktemp -d /m,
      "token must be derived from a per-invocation mktemp work directory",
    );
    assert.doesNotMatch(
      text,
      /\bexport\s+TT_RUST_BUILD_INVOCATION_ID\b/,
      "the token must not be exported globally; only the cargo test command may carry it",
    );
  });

  it("passes the token only on the seed-loop cargo test command", () => {
    const text = builderText();
    assert.match(
      text,
      /if TT_RUST_BUILD_INVOCATION_ID="\$TT_RUST_BUILD_INVOCATION_ID" timeout 15 cargo test --quiet >\/dev\/null 2>&1; then/,
      "seed-loop cargo test must receive the token only through its command environment",
    );
    const tokenCarriers = text
      .split("\n")
      .map((line, index) => ({ line, lineNo: index + 1 }))
      .filter(({ line }) => line.includes("TT_RUST_BUILD_INVOCATION_ID"));
    const cargoCarriers = tokenCarriers.filter(({ line }) => line.includes("cargo test"));
    assert.equal(
      cargoCarriers.length,
      1,
      `exactly one cargo test command may carry the token, found ${cargoCarriers.length}`,
    );
    for (const { line, lineNo } of cargoCarriers) {
      assert.match(
        line,
        /TT_RUST_BUILD_INVOCATION_ID="\$TT_RUST_BUILD_INVOCATION_ID" timeout 15 cargo test/,
        `line ${lineNo}: token on a cargo test must be a command-environment prefix`,
      );
    }
  });

  it("replaces the host-wide sweep with the ownership reaper in the same block", () => {
    const text = builderText();
    assert.match(
      text,
      /"\$REPO_ROOT\/torture-test\/bin\/tt-reap-owned-cargo" --token "\$TT_RUST_BUILD_INVOCATION_ID"/,
      "builder must invoke the ownership reaper with its invocation token",
    );
    assert.match(
      text,
      /tt-reap-owned-cargo" --token "\$TT_RUST_BUILD_INVOCATION_ID" \|\| true\n\s+sleep 1\b/,
      "reaper call must keep the existing sleep 1 per-seed cleanup position",
    );
    assert.doesNotMatch(text, /\bpkill\b/, `${BUILDER_REL} must not contain a pkill sweep`);
    assert.doesNotMatch(text, /\bkillall\b/, `${BUILDER_REL} must not contain a killall sweep`);
    assert.doesNotMatch(text, /\bpgrep\b|\bfuser\b/, `${BUILDER_REL} must not resolve targets by name`);
    assert.equal(
      text.includes("cargo test.*ttrust"),
      false,
      `${BUILDER_REL} must not contain the old host-wide cargo pattern`,
    );
  });
});

describe("tt-reap-owned-cargo — behavioral ownership boundary", () => {
  it("terminates the owned fake cargo while foreign and argv-only decoys survive", async () => {
    const token = uniqueToken();
    const baseEnv: NodeJS.ProcessEnv = { ...process.env };
    delete baseEnv[TOKEN_KEY];

    const owned = spawnFakeCargo("owned", { ...baseEnv, [TOKEN_KEY]: token });
    const foreign = spawnFakeCargo("foreign", baseEnv);
    // argv-only decoy: the token is visible in argv but absent from env.
    const decoy = spawnFakeCargo("decoy", baseEnv, `${FAKE_CARGO_ARGV} ${token}`);
    const spawned = [owned, foreign, decoy];

    try {
      await sleep(400);
      console.log(
        `[reaper] BEFORE owned=${owned.pid} foreign=${foreign.pid} decoy=${decoy.pid} token=${token}`,
      );
      assert.equal(alive(owned.pid), true, "owned process must be alive before the reaper runs");
      assert.equal(alive(foreign.pid), true, "foreign control must be alive before the reaper runs");
      assert.equal(alive(decoy.pid), true, "argv-only decoy must be alive before the reaper runs");

      let helperRc = -1;
      let helperOut = "";
      let helperErr = "";
      try {
        helperOut = execFileSync(HELPER, ["--token", token, "--grace-seconds", "1"], {
          cwd: repoRoot,
          encoding: "utf8",
          env: baseEnv,
          timeout: 30_000,
        });
        helperRc = 0;
      } catch (error) {
        const err = error as {
          status?: number | null;
          stdout?: string | Buffer;
          stderr?: string | Buffer;
        };
        helperRc = typeof err.status === "number" ? err.status : -1;
        helperOut = String(err.stdout ?? "");
        helperErr = String(err.stderr ?? "");
      }
      console.log(`[reaper] helper_rc=${helperRc}`);
      console.log(`[reaper] helper stdout:\n${helperOut.trim()}`);
      if (helperErr.trim() !== "") console.log(`[reaper] helper stderr:\n${helperErr.trim()}`);
      assert.equal(helperRc, 0, `helper must exit 0 (stderr: ${helperErr.trim()})`);
      assert.match(
        helperOut,
        new RegExp(`TERM pid=${owned.pid}\\b`),
        "helper must record a TERM for the owned PID",
      );
      assert.match(helperOut, /reaped=\d+ owned process\(es\)/, "helper must report the final reaped count");
      assert.doesNotMatch(
        helperOut,
        new RegExp(`pid=${foreign.pid}\\b`),
        "helper must never signal the foreign control",
      );
      assert.doesNotMatch(
        helperOut,
        new RegExp(`pid=${decoy.pid}\\b`),
        "helper must never signal the argv-only decoy",
      );

      const ownedGone = await waitForGone(owned.pid, 5000);
      const foreignAlive = alive(foreign.pid);
      const decoyAlive = alive(decoy.pid);
      console.log(
        `[reaper] AFTER owned=${owned.pid} gone=${ownedGone} ` +
          `foreign=${foreign.pid} alive=${foreignAlive} decoy=${decoy.pid} alive=${decoyAlive}`,
      );
      assert.equal(ownedGone, true, "owned fake cargo process must be terminated");
      assert.equal(foreignAlive, true, "foreign process with identical argv must survive");
      assert.equal(decoyAlive, true, "argv-only token decoy must survive");
    } finally {
      for (const { child } of spawned) {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      await Promise.all(spawned.map(({ child }) => waitForExit(child)));
    }
  });
});

// ── mechanical classification guard ─────────────────────────────────────
// Sweep every tracked torture-test/ file for the host-wide kill tool names.
// The only permitted remaining hits are INERT: static regex ban lists or
// negative assertions, never executable cleanup and never operator advice.
// A new hit outside this allowlist fails here; the two production files must
// have zero hits.
describe("host-wide kill tool classification guard", () => {
  const TOOL_NAMES = ["pkill", "killall"];
  // file -> why every hit in that file is inert (classification comment).
  const INERT_ALLOWLIST = new Map<string, string>([
    [
      "torture-test/self-tests/tier0-sogi-cleanup-identity-gate.test.ts",
      "static escape-guard regex that BANS the tools (never executed)",
    ],
    [
      "torture-test/self-tests/tier1-kill-ancestry-hygiene.test.ts",
      "audit scanner ban regex, its explanatory comment and its test name",
    ],
    [
      "torture-test/self-tests/tier0-tt-rust-builder-owned-cleanup.test.ts",
      "negative assertions only (this file's own 'must not contain' checks)",
    ],
  ]);
  // Production-side files that must never mention the sweep tools at all.
  const PRODUCTION_FILES = [
    "torture-test/fixtures-src/tt-rust/build-golden.sh",
    "torture-test/bin/verify-heavy-campaign-tests.test.sh",
  ];

  function sweepHits(): Array<{ file: string; lineNo: number; text: string }> {
    const tracked = execFileSync("git", ["ls-files", "torture-test/"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter((rel) => rel !== "");
    const hits: Array<{ file: string; lineNo: number; text: string }> = [];
    for (const rel of tracked) {
      const raw = fs.readFileSync(path.join(repoRoot, rel));
      if (raw.includes(0)) continue; // binary file: no text lines to classify
      const lines = raw.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (TOOL_NAMES.some((tool) => lines[i].includes(tool))) {
          hits.push({ file: rel, lineNo: i + 1, text: lines[i].trim() });
        }
      }
    }
    return hits;
  }

  it("classifies every remaining hit as inert and finds zero in the two production files", () => {
    const hits = sweepHits();
    for (const hit of hits) {
      const reason = INERT_ALLOWLIST.get(hit.file);
      console.log(
        `[classification] ${hit.file}:${hit.lineNo} ` +
          (reason === undefined ? "UNCLASSIFIED" : `inert: ${reason}`),
      );
      assert.notEqual(
        reason,
        undefined,
        `${hit.file}:${hit.lineNo} names a host-wide kill tool outside the inert allowlist: ${hit.text}`,
      );
    }
    for (const production of PRODUCTION_FILES) {
      const ownHits = hits.filter((hit) => hit.file === production);
      assert.deepEqual(ownHits, [], `${production} must have zero sweep-tool hits`);
    }
  });

  it("keeps the two pre-existing audit ban patterns intact", () => {
    const sogi = fs.readFileSync(
      path.join(repoRoot, "torture-test/self-tests/tier0-sogi-cleanup-identity-gate.test.ts"),
      "utf8",
    );
    const tier1 = fs.readFileSync(
      path.join(repoRoot, "torture-test/self-tests/tier1-kill-ancestry-hygiene.test.ts"),
      "utf8",
    );
    assert.match(sogi, /\\bpkill\\b/, "sogi escape guard must still ban pkill");
    assert.match(sogi, /\\bkillall\\b/, "sogi escape guard must still ban killall");
    assert.match(
      tier1,
      /\\b\(pkill\|killall\|pgrep\|fuser\)\\b/,
      "tier1 audit scanner must still ban the sweep tools",
    );
    assert.match(
      tier1,
      /contains no name\/tree-sweep tools/,
      "tier1 audit test name must remain",
    );
  });
});
