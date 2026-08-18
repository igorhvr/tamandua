// E3.C.2 US-003 — Concurrent-run collision regression guard (proof-protocol gap).
//
// Pins the E3.C.2 daemon-control fix so the tier1 proof protocol can never
// again pass while a concurrent run can TERM this worktree's daemon launch
// (the E3.C.2 incident: E3.C.1's own bare-tier1 GREEN x2 proof passed because
// the collision is a RACE that only manifests on destructive interleaving of
// the then-FIXED systemd scope name + fixed ports across concurrent
// worktrees — a proof-protocol gap with no isolation guard).
//
// Three mechanical, bounded, hermetic pins (no campaign, zero tokens):
//   1. Scope-unit derivation is PER-WORKTREE: two different repo-root inputs
//      yield two different `tamandua-tt-<kind>-<suffix>` unit names, and
//      neither is the bare fixed `tamandua-tt-<kind>` (the old shared name
//      that let a concurrent run's stop TERM another run's in-flight
//      systemd-run launch). The same root yields the same suffix (stable
//      across invocations — a per-run random suffix would break stop
//      isolation).
//   2. Cross-worktree stop isolation: a stop whose recorded scope is NOT this
//      worktree's derived unit (a foreign worktree's unit or the legacy bare
//      fixed name) is REFUSED — never `systemctl --user stop`'d. Asserted
//      BOTH structurally (every `systemctl --user stop` site is scoped to the
//      per-worktree unit) AND behaviorally against a SAFE simulated systemd
//      (fake `systemctl`/`systemd-run` shims on PATH + planted provenance on
//      high unused ports — no real daemon, no real systemd interaction).
//   3. cmd_start's bounded port-free wait refuses to launch while the kind's
//      fixed ports are held (waits out `TT_DAEMON_PORT_WAIT_SECONDS`, then
//      fails with `refusing to launch into a busy port` instead of racing
//      into EADDRINUSE). Asserted structurally (markers present) and — for
//      the in-tree tool only — behaviorally with a self-terminating squatter
//      listener on the scripted control port.
//
// RED/GREEN protocol: the test FAILS against the pre-fix daemon-control
// (fixed scope name, ungated stops, no port wait) and PASSES against the
// fixed one. Reproduce the RED case with the pre-fix blob in a temp tree:
//
//   TMPD=$(mktemp -d)
//   mkdir -p "$TMPD/torture-test/bin" "$TMPD/torture-test/env" \
//            "$TMPD/torture-test/var/daemon-control"
//   git show <pre-fix-commit>:torture-test/bin/daemon-control \
//     > "$TMPD/torture-test/bin/daemon-control" && chmod +x "$TMPD/torture-test/bin/daemon-control"
//   cp torture-test/env/tt-env.sh torture-test/env/tt-env-scripted.sh \
//     "$TMPD/torture-test/env/"
//   TT_DC_TOOL="$TMPD/torture-test/bin/daemon-control" node --test \
//     torture-test/self-tests/tier1-daemon-control-scope-isolation.test.ts
//
// The behavioral port-wait arm only runs against the IN-TREE tool (an
// alternate tool path would need a real launch to prove the refusal); the
// structural port-wait pins still run and fail on the pre-fix tool.
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob (bounded battery —
// no run.sh edit). Zero tokens; confined to torture-test/. No kill sites
// (teardown is self-termination + liveness probes only).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const repoDcTool = path.join(ttRoot, "bin", "daemon-control");

// TT_DC_TOOL points the structural/derivation/stop-isolation assertions at an
// alternate daemon-control tree (used to demonstrate the RED case against the
// pre-fix fixed-scope tool). Behavioral arms that would touch real
// daemon/ports (cmd_start's launch refusal) only run against the in-tree tool.
const dcTool = process.env.TT_DC_TOOL ?? repoDcTool;
const isRepoTool = dcTool === repoDcTool;
const dcText = fs.readFileSync(dcTool, "utf8");

// The tool tree root: daemon-control lives at $TREE/torture-test/bin/.
// daemon-control derives TT_REPO_ROOT (and therefore the scope suffix) from
// its OWN location, so the planted-provenance dir and the "ours" unit must be
// computed against the tool's tree, not the repo root.
const toolTreeRoot = path.dirname(path.dirname(path.dirname(dcTool)));

// ── helpers ────────────────────────────────────────────────────────────

/** Env for everything this test spawns: strip NODE_TEST_CONTEXT (node:test
 *  auto-activates the isolation guard in every child) and disable the guard
 *  explicitly — the tool/squatter operate inside torture-test/var and temp
 *  state, never the live ~/.tamandua. */
function cleanEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.TAMANDUA_TEST_GUARD = "0";
  if (extra) Object.assign(env, extra);
  return env;
}

interface CmdResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(
  cmd: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): CmdResult {
  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env ?? cleanEnv(),
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

/** Extract a top-level `name() { ... }` function body (balanced-brace,
 *  quote-aware) from the tool text, or null when the function is absent. */
function extractFunction(text: string, name: string): string | null {
  const start = text.indexOf(`${name}()`);
  if (start < 0) return null;
  const open = text.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function stripBashComment(line: string): string {
  return line.replace(/\s+#.*$/, "");
}

interface Segment {
  startLine: number;
  endLine: number;
  lines: string[];
}

/** Split the tool text into if-block segments at `fi` boundaries — every
 *  `systemctl --user stop` must share its segment with the ownership gate
 *  (scope_unit_is_ours) or the derived unit variable (scope_unit). */
function splitIfBlocks(lines: string[]): Segment[] {
  const segments: Segment[] = [];
  let start = 1;
  let current: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    current.push(lines[i]);
    if (/^\s*fi\s*$/.test(lines[i])) {
      segments.push({ startLine: start, endLine: i + 1, lines: current });
      current = [];
      start = i + 2;
    }
  }
  if (current.length) segments.push({ startLine: start, endLine: lines.length, lines: current });
  return segments;
}

/** Run the tool's scope_suffix_for_root() (extracted from the audited text)
 *  for the given root; returns the 8-hex suffix or null when the helper is
 *  absent (pre-fix tool). */
function suffixForRoot(root: string, fnText: string): string | null {
  const fnFile = path.join(os.tmpdir(), `dc-fn-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
  const outFile = path.join(os.tmpdir(), `dc-sfx-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    fs.writeFileSync(fnFile, `${fnText}\n`);
    const res = run(
      ["bash", "-c", `set -u; source "$1"; scope_suffix_for_root "$2" > "$3"`, "_", fnFile, root, outFile],
      { timeoutMs: 30_000 },
    );
    if (res.status !== 0) return null;
    const value = fs.readFileSync(outFile, "utf8").trim();
    return value === "" ? null : value;
  } finally {
    fs.rmSync(fnFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

// ── the guard ──────────────────────────────────────────────────────────

describe("E3.C.2 US-003 — concurrent-run collision regression guard (per-worktree scope isolation)", () => {
  it("scope-unit derivation is per-worktree: two roots -> two distinct units, never the bare fixed name, deterministic per root", () => {
    const fn = extractFunction(dcText, "scope_suffix_for_root");
    assert.ok(
      fn,
      "daemon-control must define scope_suffix_for_root() — without the per-worktree suffix helper a concurrent run can still stop this worktree's fixed-name scope",
    );

    const fnFile = path.join(os.tmpdir(), `dc-fn-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
    const outFile = path.join(os.tmpdir(), `dc-sfx-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    const rootA = path.join(repoRoot, "worktree-alpha");
    const rootB = path.join(repoRoot, "worktree-beta");
    try {
      fs.writeFileSync(fnFile, `${fn}\n`);
      const res = run(
        [
          "bash",
          "-c",
          `set -u; source "$1"; for root in "$2" "$3" "$2"; do printf '%s\\n' "$(scope_suffix_for_root "$root")"; done > "$4"`,
          "_",
          fnFile,
          rootA,
          rootB,
          outFile,
        ],
        { timeoutMs: 30_000 },
      );
      assert.equal(res.status, 0, `scope_suffix_for_root must run: ${res.stderr}`);

      const suffixes = fs.readFileSync(outFile, "utf8").trim().split(/\r?\n/).filter((s) => s !== "");
      assert.equal(suffixes.length, 3, `expected 3 suffix outputs (A, B, A), got: ${JSON.stringify(suffixes)}`);
      for (const s of suffixes) {
        assert.match(s, /^[0-9a-f]{8}$/, `scope suffix must be 8-hex (cksum %08x), got: ${s}`);
        for (const kind of ["scripted", "real"]) {
          const unit = `tamandua-tt-${kind}-${s}`;
          assert.notEqual(unit, `tamandua-tt-${kind}`, `derived unit ${unit} must never equal the bare fixed name`);
        }
      }
      assert.notEqual(suffixes[0], suffixes[1], "two different repo roots must yield two different scope suffixes");
      assert.equal(suffixes[0], suffixes[2], "the same repo root must yield the SAME suffix (stable per-worktree unit name)");
    } finally {
      fs.rmSync(fnFile, { force: true });
      fs.rmSync(outFile, { force: true });
    }
  });

  it("cmd_start derives the per-worktree unit name tamandua-tt-<kind>-<suffix> from TT_REPO_ROOT", () => {
    const cmdStart = extractFunction(dcText, "cmd_start");
    assert.ok(cmdStart, "cmd_start must exist");
    assert.match(
      cmdStart,
      /scope_suffix="\$\(scope_suffix_for_root "\$TT_REPO_ROOT"\)"/,
      "cmd_start must derive the scope suffix from TT_REPO_ROOT (per-worktree)",
    );
    assert.match(
      cmdStart,
      /local scope_unit="tamandua-tt-\$name-\$scope_suffix"/,
      "cmd_start must build the per-worktree unit name tamandua-tt-<kind>-<suffix>",
    );
    assert.doesNotMatch(
      cmdStart,
      /local scope_unit="tamandua-tt-\$name"/,
      "cmd_start must NOT use the old fixed per-worktree-shared unit name tamandua-tt-<kind> (the E3.C.2 collision surface)",
    );
  });

  it("daemon-control defines the per-worktree scope helpers", () => {
    assert.match(dcText, /^scope_suffix_for_root\(\)/m, "missing scope_suffix_for_root()");
    assert.match(dcText, /^scope_unit_is_ours\(\)/m, "missing scope_unit_is_ours() (stop ownership gate)");
  });

  it("every systemctl --user stop site is scoped to the per-worktree unit (structural cross-worktree isolation)", () => {
    const lines = dcText.split(/\r?\n/);
    const stopSites: Array<{ lineNo: number; text: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const stripped = stripBashComment(lines[i]);
      if (/\bsystemctl[ \t]+--user[ \t]+stop\b/.test(stripped)) {
        stopSites.push({ lineNo: i + 1, text: stripped.trim() });
      }
    }
    assert.ok(stopSites.length > 0, "expected at least one systemctl --user stop site in daemon-control");

    const segments = splitIfBlocks(lines);
    for (const site of stopSites) {
      const seg = segments.find((s) => s.startLine <= site.lineNo && site.lineNo <= s.endLine);
      assert.ok(seg, `stop site at line ${site.lineNo} must belong to an if-block segment`);
      const segText = seg.lines.map(stripBashComment).join("\n");
      assert.match(
        segText,
        /scope_unit_is_ours|\bscope_unit\b/,
        `systemctl stop at line ${site.lineNo} is NOT scoped to the per-worktree unit: ${site.text} — a stop of a shared/fixed/foreign scope is the E3.C.2 collision surface`,
      );
      assert.doesNotMatch(
        site.text,
        /tamandua-tt-(scripted|real)\.scope/,
        `stop site at line ${site.lineNo} targets a bare fixed scope name: ${site.text}`,
      );
    }

    // The OLD fixed template must not survive in cmd_start (S1 pins the
    // derived form; this catches a reversion that keeps the variable name).
    const cmdStart = extractFunction(dcText, "cmd_start");
    assert.ok(cmdStart, "cmd_start must exist");
    assert.doesNotMatch(
      cmdStart,
      /local scope_unit="tamandua-tt-\$name"/,
      "cmd_start must not fall back to the fixed tamandua-tt-<kind> unit name",
    );
  });

  it("cmd_start carries the bounded port-free wait (TT_DAEMON_PORT_WAIT_SECONDS + busy-port refusal + stable-free settle)", () => {
    const cmdStart = extractFunction(dcText, "cmd_start");
    assert.ok(cmdStart, "cmd_start must exist");
    assert.match(cmdStart, /TT_DAEMON_PORT_WAIT_SECONDS/, "cmd_start must honor the TT_DAEMON_PORT_WAIT_SECONDS override");
    assert.match(cmdStart, /refusing to launch into a busy port/, "cmd_start must fail with the busy-port diagnostic");
    assert.match(cmdStart, /STAYS free across a settle/, "cmd_start must require the ports stable-free across a settle");
  });

  it("cmd_stop never issues systemctl stop against a foreign/legacy scope (safe simulated systemd)", () => {
    const provDir = path.join(toolTreeRoot, "torture-test", "var", "daemon-control");
    fs.mkdirSync(provDir, { recursive: true });
    const provFile = path.join(provDir, "scripted.json");
    const backup = fs.existsSync(provFile) ? `${provFile}.us003-bak-${process.pid}` : null;
    if (backup) fs.copyFileSync(provFile, backup);

    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "dc-fake-systemd-"));
    const logFile = path.join(fakeBin, "calls.log");
    const shim = (name: string): void => {
      const p = path.join(fakeBin, name);
      fs.writeFileSync(p, `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "$TT_FAKE_SYSTEMD_LOG"\nexit 0\n`);
      fs.chmodSync(p, 0o755);
    };
    shim("systemctl");
    shim("systemd-run");

    // The positive control (this worktree's derived unit) needs the
    // per-worktree helper; the foreign/legacy refusal cases run regardless —
    // so this arm also exercises a pre-fix tool (no helper) and catches it
    // issuing `systemctl stop` against a foreign/legacy scope.
    const fn = extractFunction(dcText, "scope_suffix_for_root");
    let ourUnit: string | null = null;
    if (fn) {
      const ourSuffix = suffixForRoot(toolTreeRoot, fn);
      assert.ok(
        ourSuffix && /^[0-9a-f]{8}$/.test(ourSuffix),
        `derived suffix for the tool tree must be 8-hex, got: ${ourSuffix}`,
      );
      ourUnit = `tamandua-tt-scripted-${ourSuffix}`;
    }

    // Planted provenance: ports on high unused numbers (never the fixed
    // 5334/5338/5339) so cmd_stop takes the "already stopped" idempotent path
    // — no real daemon, no real systemd, no tamandua invocation.
    const plantProv = (scopeUnit: string): void => {
      const prov = {
        name: "scripted",
        kind: "scripted",
        pid: 2147483647, // definitely not alive
        ports: ["25334", "25338", "25339"],
        scopeUnit,
        cgroupVerified: false,
        startedAt: "2026-08-17T00:00:00Z",
        cmdline: "tamandua daemon start",
        cwd: path.join(toolTreeRoot, "torture-test", "var", "home-scripted", ".tamandua"),
        startTime: "proc:0",
      };
      fs.writeFileSync(provFile, `${JSON.stringify(prov, null, 2)}\n`);
    };

    const cases: Array<{
      name: string;
      scope: string;
      expectStop: boolean;
      expectRefusal: boolean;
    }> = [
      { name: "foreign worktree unit", scope: "tamandua-tt-scripted-00000000", expectStop: false, expectRefusal: true },
      { name: "legacy bare fixed unit", scope: "tamandua-tt-scripted", expectStop: false, expectRefusal: true },
      ...(ourUnit
        ? [{ name: "this worktree unit (positive control)", scope: ourUnit, expectStop: true, expectRefusal: false }]
        : []),
    ];

    try {
      for (const c of cases) {
        fs.rmSync(logFile, { force: true });
        plantProv(c.scope);
        const env = cleanEnv({
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TT_FAKE_SYSTEMD_LOG: logFile,
        });
        const res = run(["bash", dcTool, "scripted", "stop"], { env, timeoutMs: 60_000 });
        const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
        const stopLine = `systemctl --user stop ${c.scope}.scope`;
        const resetLine = `systemctl --user reset-failed ${c.scope}.scope`;

        assert.equal(res.status, 0, `stop must be a no-op success for ${c.name}: ${res.stderr}`);
        if (c.expectStop) {
          assert.ok(
            log.includes(stopLine),
            `positive control: expected a systemctl stop of this worktree's unit ${c.scope}\nlog: ${log}`,
          );
        } else {
          assert.ok(
            !log.includes(stopLine),
            `cross-worktree isolation breached: daemon-control issued '${stopLine}' against ${c.name} ${c.scope} — a concurrent run's stop TERMs another run's in-flight daemon launch (the E3.C.2 regression)\nlog: ${log}\ntool stderr: ${res.stderr}`,
          );
          assert.ok(
            !log.includes(resetLine),
            `cross-worktree isolation breached: reset-failed issued against ${c.name} ${c.scope}\nlog: ${log}`,
          );
        }
        if (c.expectRefusal) {
          assert.match(res.stderr, /REFUSING/, `expected a REFUSING message for ${c.name}: ${res.stderr}`);
        }
      }
    } finally {
      fs.rmSync(provFile, { force: true });
      if (backup) fs.copyFileSync(backup, provFile);
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("cmd_start refuses to launch while the kind's fixed ports are held (bounded wait, distinct reason, no half-up daemon)", async (t) => {
    // The behavioral arm runs the tool for real: only the in-tree tool may be
    // exercised (an alternate tool path — the RED proof — would need a real
    // launch to prove the refusal; the structural port-wait pins above still
    // fail on the pre-fix tool).
    if (!isRepoTool) {
      t.skip("behavioral port-wait arm requires the in-tree daemon-control (structural pins still run)");
      return;
    }

    const squatterOut = path.join(os.tmpdir(), `dc-squatter-${process.pid}-${Date.now()}.out`);
    // The squatter self-terminates (no kill site in this test): retry-bind
    // 5339 until success (a concurrent worktree daemon may hold it — then the
    // refusal is still correct), hold it ~8s, then exit. A hard 15s cap
    // guarantees it always clears even if it never binds.
    const squatterScript = `
      const fs = require("fs");
      const net = require("net");
      const out = process.argv[1];
      const log = (m) => fs.appendFileSync(out, m + "\\n");
      const hardCap = setTimeout(() => process.exit(0), 15000);
      function tryBind() {
        const server = net.createServer();
        server.on("error", () => { try { server.close(); } catch {} setTimeout(tryBind, 100); });
        server.listen(5339, "127.0.0.1", () => {
          log("LISTENING");
          setTimeout(() => { try { server.close(); } catch {} process.exit(0); }, 8000);
        });
      }
      tryBind();
      setInterval(() => {}, 500);
    `;
    const squatter = spawn(process.execPath, ["-e", squatterScript, squatterOut], {
      cwd: repoRoot,
      env: cleanEnv(),
      stdio: ["ignore", "ignore", "ignore"],
    });

    const scriptedStatePid = path.join(ttRoot, "var", "home-scripted", ".tamandua", "tamandua.pid");
    const pidBefore = fs.existsSync(scriptedStatePid) ? fs.readFileSync(scriptedStatePid, "utf8").trim() : "";

    let primary: unknown = null;
    try {
      // Wait for the squatter to report a bind (or the 8s grace — a
      // concurrent worktree daemon holding 5339 is equally a busy port).
      const bindDeadline = Date.now() + 8_000;
      while (Date.now() < bindDeadline) {
        if (fs.existsSync(squatterOut) && fs.readFileSync(squatterOut, "utf8").includes("LISTENING")) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const res = run(["bash", dcTool, "scripted", "start"], {
        env: cleanEnv({ TT_DAEMON_PORT_WAIT_SECONDS: "2" }),
        timeoutMs: 60_000,
      });
      assert.notEqual(
        res.status,
        0,
        `start must FAIL while a kind port is held (squatter/concurrent daemon); stdout: ${res.stdout}\nstderr: ${res.stderr}`,
      );
      assert.match(
        res.stderr,
        /refusing to launch into a busy port/,
        `start must refuse with the busy-port diagnostic (not EADDRINUSE, not a blind launch): ${res.stderr}`,
      );
      // The refused start exits BEFORE launching: the daemon pid file must be
      // untouched (no half-up daemon, no new pid).
      const pidAfter = fs.existsSync(scriptedStatePid) ? fs.readFileSync(scriptedStatePid, "utf8").trim() : "";
      assert.equal(pidAfter, pidBefore, "the refused start must not touch the daemon pid file (no half-up daemon)");
    } catch (error) {
      primary = error;
    }

    // The squatter self-terminates; wait (bounded) for it so nothing leaks
    // into the rest of the battery. Liveness probes only — no kill site.
    const exitDeadline = Date.now() + 30_000;
    while (Date.now() < exitDeadline && squatter.exitCode === null) {
      await new Promise((r) => setTimeout(r, 200));
    }
    fs.rmSync(squatterOut, { force: true });
    if (squatter.exitCode === null) {
      const leak = new Error("squatter listener did not self-terminate within the grace window (leak)");
      if (primary) throw primary;
      throw leak;
    }
    if (primary) throw primary;
  });
});
