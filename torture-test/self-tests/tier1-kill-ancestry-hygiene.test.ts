// E3.C.1 US-007 — Global kill-site audit scanner (audit deliverable).
//
// Mechanically pins the explicit-recorded-target contract across the E3.C
// kill-bearing machinery, so the audit is REPRODUCIBLE on every run:
//
//   * NO name/tree-sweep tools: pkill / killall / pgrep / fuser are banned
//     outright anywhere in an audited file (these match by name/cmdline and
//     can reach a process the test never spawned).
//   * NO inline-resolved kill targets: `kill $(...)` (command substitution),
//     `ps ... | kill`, `xargs kill`, `find /proc`, and `/proc/[0-9]*` glob
//     loops are banned — a kill target must come from a recorded registry,
//     never from a sweep executed on the same line.
//   * NO /proc cwd/cmdline sweep as a target RESOLVER: every kill line is
//     classified, and its target must match the file's pinned recorded-
//     registry whitelist (pidfile / JSON record / DB claim row / child
//     handle / $! / env-token registry / explicit --target-* arg). Kill
//     lines must never reference /proc, ps, cmdline, cwd, or a /proc
//     enumeration loop variable.
//   * Every kill-bearing file must reference its layer's process-start
//     identity verification primitive (verifyKillTarget /
//     verifyRecordedTarget / verify_recorded_identity / verify_listener_target
//     / reapLivePgids / process_start_time / target_start_time /
//     IDENTITY_TOOL / snapshotSelfGroup...).
//   * The scripted probe battery (self-tests/tier1-scripted-probe-battery
//     .test.ts) must contain ZERO kill sites — every daemon lifecycle call
//     goes through daemon-control (US-004 identity-verified), and the
//     battery's only "kill-adjacent" code is the read-only self-group
//     survival assertion.
//   * run.sh's `ps eww` sweep (owned_pids) is allowed ONLY because it is
//     scoped by a unique per-launch env token (TT_SELF_TEST_INVOCATION_ID /
//     TT_SELF_TEST_OWNERSHIP_ROOT) — a recorded registry, never a
//     cwd/cmdline content match — and every signal is re-gated by
//     pid_is_owned / process_group_is_owned.
//
// The behavioral proof that the gating WORKS lives in the bin self-test
// suites (tt-chaos.test.sh, daemon-control.test.sh, tt-controller.test.sh,
// o4.test.mjs, reap-live-pgids.test.mjs, tier1-scripted-probe-battery).
// This scanner is the reproducible static audit on top of them.
//
// Confined to torture-test/. Zero tokens. Read-only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");

// ── global bans (applied to every audited file) ────────────────────
// Name/tree-sweep tools — matching by name/cmdline can reach a process the
// test never spawned (the E3.C root-cause class).
const SWEEP_TOOL_BANS: RegExp[] = [
  /\b(pkill|killall|pgrep|fuser)\b/,
];
// Kill targets resolved inline from a sweep on the same line. `\bkill[ \t]+`
// requires the kill COMMAND (whitespace after the token) — "tt-kill-sentinel"
// or "kill-harness" identifiers must not match.
const INLINE_RESOLVE_BANS: RegExp[] = [
  /\bkill[ \t]+[^\n]*\$\(/, // kill $(...) — command-substitution target
  /\bkill[ \t]+[^\n]*\|\s*[^\n]*xargs\b/, // kill | xargs
  /\bxargs\s+kill\b/,
  /\bps\b[^\n]*\|\s*[^\n]*\bkill[ \t]+/, // ps ... | kill
  /\bkill[ \t]+[^\n]*\$\s*\(\s*ps\b/, // kill $(ps ...)
  /\bfind\s+\/proc\b/, // find /proc — enumeration as target source
  /\bfor\b[^\n]*\bin\b[^\n]*\/proc\/\[0-9/, // bash /proc/[0-9]* glob loop
];

// ── per-file audit table ───────────────────────────────────────────
interface KillAudit {
  file: string; // path relative to torture-test/
  // Matches a kill-site LINE (comment-stripped). Bash: \bkill followed by
  // whitespace then a signal option and/or a $/" target — the "kill lingering
  // listeners" prose inside pass "..." strings must NOT match.
  killLine: RegExp;
  // Liveness checks (kill -0 / process.kill(pid, 0)) — exempt: they never
  // signal.
  liveness: RegExp[];
  // Recorded-registry kill shapes this file is allowed to fire. An empty
  // array means the file must contain NO kill site at all.
  allowed: RegExp[];
  // Process-start-identity verification primitives that must be referenced.
  identityRefs: RegExp[];
  // /proc-enumeration loop variables that must never appear in a kill line
  // (a /proc scan must never RESOLVE a kill target).
  scanVars: string[];
  // Extra whole-file assertions (regex must match).
  required?: RegExp[];
}

const AUDITS: KillAudit[] = [
  {
    // Chaos operator: kill-harness / kill-daemon / sigstop_sigcont resolve
    // from explicit --target-* args, the steps-table claim row, or the daemon
    // pidfile (US-002) and fire only after verifyKillTarget (identity ABA +
    // not-ancestor + pgid-disjoint + provenance belt-and-suspenders). The
    // /proc cwd/cmdline reads (verifyProcessProvenance) verify an
    // ALREADY-RESOLVED recorded pid; the readdirSync('/proc') loops
    // (captureProcScan / captureChildrenProcs) only build EVIDENCE strings —
    // their loop var `d` never appears in a kill line.
    file: "bin/tt-chaos",
    killLine: /process\.kill\(/,
    liveness: [/process\.kill\(\s*[^,)]+\s*,\s*0\s*\)/],
    allowed: [/process\.kill\(\s*pid\s*,/],
    identityRefs: [/\bverifyKillTarget\b/, /\bverifyRecordedTarget\b/, /const pid = record\.pid\b/],
    scanVars: ["d"],
  },
  {
    // Controller: the ONLY kill is child.kill(SIGTERM/SIGKILL) on the
    // controller's OWN spawned child handle (stopChild — evidence-limit /
    // launch-abort path); the controller records the child's process identity
    // at spawn (hookState.start_time / processStartTimeOf). processIsAlive's
    // process.kill(pid, 0) is a liveness probe.
    file: "bin/tt-controller",
    killLine: /child\.kill\(|process\.kill\(/,
    liveness: [/process\.kill\(\s*[^,)]+\s*,\s*0\s*\)/],
    allowed: [/child\.kill\(/],
    identityRefs: [/\bchild\.kill\(/, /\bstart_time\b/, /\bprocessStartTimeOf\b/],
    scanVars: [],
  },
  {
    // daemon-control: SIGTERM->SIGKILL escalation and lingering-listener
    // cleanup target ONLY the recorded provenance pid ($prov_pid) or a
    // listener verified to BE that recorded pid ($lingering_pid == $prov_pid),
    // each gated by verify_recorded_identity / verify_listener_target
    // (tt-process-identity --check/--verify). The ss/netstat port lookup only
    // IDENTIFIES the listener; the kill is refused unless it equals the
    // recorded daemon with a matching startTime (Tests 87-89 pin behavior).
    file: "bin/daemon-control",
    killLine: /\bkill[ \t]+(-{1,2}[A-Za-z0-9-]*[ \t]+)?[\$"]/,
    liveness: [/\bkill[ \t]+-0([ \t]+|["']|$)/],
    allowed: [
      /\bkill[ \t]+-[A-Z0-9]+[ \t]+"\$(prov_pid|lingering_pid)"/,
    ],
    identityRefs: [
      /\bverify_recorded_identity\b/,
      /\bverify_listener_target\b/,
      /\bIDENTITY_TOOL\b/,
      /"\$lingering_pid" = "\$prov_pid/,
    ],
    scanVars: [],
  },
  {
    // O4 fixture generator: records { pid, pgid, startTime } identities for
    // the detached sleeps and delegates ALL reaping to the shared
    // identity-verified reaper (reapLivePgids) — no kill sites of its own.
    file: "oracles/self-test/generate-o4-fixtures.mjs",
    killLine: /process\.kill\(|child\.kill\(|\.kill\(/,
    liveness: [],
    allowed: [],
    identityRefs: [/\breapLivePgids\b/, /\bstartTime\b/],
    scanVars: [],
  },
  {
    // O4 oracle test: delegates reaping to reapLivePgids (identity-verified) —
    // no kill sites of its own.
    file: "oracles/self-test/o4.test.mjs",
    killLine: /process\.kill\(|child\.kill\(|\.kill\(/,
    liveness: [],
    allowed: [],
    identityRefs: [/\breapLivePgids\b/],
    scanVars: [],
  },
  {
    // The shared O4 reaper: kills a recorded pgid/pid ONLY after
    // verifyRecordedTarget (ABA startTime + recorded-pgid match + disjoint
    // from the reaper's own group + not an ancestor). The `pid` single-pid
    // kill is the just-spawned child on group-leadership failure.
    file: "oracles/self-test/reap-live-pgids.mjs",
    killLine: /process\.kill\(/,
    liveness: [],
    allowed: [
      /process\.kill\(\s*-\s*record\.pgid\s*,/,
      /process\.kill\(\s*record\.pid\s*,/,
      /process\.kill\(\s*pid\s*,/,
    ],
    identityRefs: [/\bverifyRecordedTarget\b/],
    scanVars: [],
  },
  {
    // O4 mutation battery runner: every kill targets (a) the env-token
    // registry (owned_pids + pid_is_owned / process_group_is_owned match the
    // unique per-launch TT_SELF_TEST_* token, never cwd/cmdline content) or
    // (b) the recorded pid of a setsid child this script itself spawned
    // (-"$child_pid" / -"$active_group"). process_start_time provides the
    // identity for the watchdog supervisor validation.
    file: "oracles/self-test/run.sh",
    killLine: /\bkill[ \t]+(-{1,2}[A-Za-z0-9-]*[ \t]+)?[\$"]/,
    liveness: [/\bkill[ \t]+-0([ \t]+|["']|$)/],
    allowed: [
      /\bkill[ \t]+"-\$signal"[ \t]+"\$pid"/,
      /\bkill[ \t]+-[A-Z0-9]+[ \t]+--[ \t]+"-\$child_pid"/,
      /\bkill[ \t]+-[A-Z0-9]+[ \t]+--[ \t]+"-\$active_group"/,
    ],
    identityRefs: [
      /\bpid_is_owned\b/,
      /\bprocess_group_is_owned\b/,
      /\bprocess_start_time\b/,
      /TT_SELF_TEST_INVOCATION_ID/,
      /TT_SELF_TEST_OWNERSHIP_ROOT/,
    ],
    scanVars: [],
  },
  {
    // Scripted probe battery: ZERO inline kill sites (US-006). Every daemon
    // lifecycle call goes through daemon-control; the only kill-adjacent code
    // is the READ-ONLY self-group survival assertion (snapshotSelfGroup /
    // assertSelfGroupSurvived / getProcessState) proving the campaign left
    // the battery's own group untouched.
    file: "self-tests/tier1-scripted-probe-battery.test.ts",
    killLine: /process\.kill\(|child\.kill\(|\.kill\(/,
    liveness: [],
    allowed: [],
    identityRefs: [
      /\bsnapshotSelfGroup\b/,
      /\bassertSelfGroupSurvived\b/,
      /\bgetProcessState\b/,
      /daemon-control/,
    ],
    scanVars: [],
  },
  {
    // tt-chaos self-test: every kill targets a pid this test itself spawned
    // and recorded (spawn_isolated pidfile + note_pid / SPAWNED_PIDS registry,
    // $! capture, target_start_time identity) — never a sweep. tt-chaos
    // invocations carry explicit --target-pid/--target-start-time args.
    file: "bin/tt-chaos.test.sh",
    killLine: /\bkill[ \t]+(-{1,2}[A-Za-z0-9-]*[ \t]+)?[\$"]/,
    liveness: [/\bkill[ \t]+-0([ \t]+|["']|$)/],
    allowed: [
      /\bkill[ \t]+-[A-Z0-9]+[ \t]+"\$p"/,
      /\bkill[ \t]+-[A-Z0-9]+[ \t]+"\$(HARNESS_PID|STOP_PID|CONT_PID|DAEMON_PID|DAEMON2_PID|FOREIGN_PID|HARNESS3_PID|HARNESS4_PID|OUTSIDE_PID|SSC_PID|GM_PID|GM2_PID|GM2_PID_B|DECOY_PID|DECOY2_PID|ABA_PID|CLAIM_PID|DAEMON_DECOY_PID|LOG_PID)"/,
      /\bkill[ \t]+"\$(DECOY_PID|FOREIGN_PID|OUTSIDE_PID)"/,
      /\bkill[ \t]+-[A-Z0-9]+[ \t]+\$!/,
    ],
    identityRefs: [
      /\btarget_start_time\b/,
      /\bnote_pid\b/,
      /\bSPAWNED_PIDS\b/,
      /--target-pid/,
    ],
    scanVars: [],
  },
  {
    // daemon-control self-test: the only kill is the recorded US004 decoy
    // listener ($US004_DECOY_PID — a setsid spawn captured via $!); all other
    // kill matches are liveness (kill -0) or grep assertions on the tool text.
    // IDENTITY_TOOL + startTime-gating assertions pin the US-004 surface.
    file: "bin/daemon-control.test.sh",
    killLine: /\bkill[ \t]+(-{1,2}[A-Za-z0-9-]*[ \t]+)?[\$"]/,
    liveness: [/\bkill[ \t]+-0([ \t]+|["']|$)/],
    allowed: [
      /\bkill[ \t]+-[A-Z0-9]+[ \t]+"\$US004_DECOY_PID"/,
    ],
    identityRefs: [
      /\bIDENTITY_TOOL\b/,
      /tt-process-identity/,
      /\bstartTime\b/,
    ],
    scanVars: [],
  },
  {
    // The US-007 sentinel wrapper (new E3.C kill-bearing file): its only
    // kills are the sentinel subshell and the suite — the two pids it itself
    // spawned and recorded ($! / pidfile) — after its survival assertion
    // (proc_start_time + sentinel_is_alive incl. the zombie-state check).
    file: "bin/tt-kill-sentinel",
    killLine: /\bkill[ \t]+(-{1,2}[A-Za-z0-9-]*[ \t]+)?[\$"]/,
    liveness: [/\bkill[ \t]+-0([ \t]+|["']|$)/],
    allowed: [
      /\bkill[ \t]+-[A-Z0-9]+[ \t]+"\$(SUITE_PID|SENTINEL_PID)"/,
    ],
    identityRefs: [/\bproc_start_time\b/, /\bsentinel_is_alive\b/],
    scanVars: [],
  },
];

// ── helpers ────────────────────────────────────────────────────────

function stripBashComment(line: string): string {
  // Remove a `#` comment that starts after whitespace (never inside ${#...}
  // or a quoted string: those have no whitespace before the `#`).
  return line.replace(/\s+#.*$/, "");
}

function stripJsComment(line: string): string {
  return line.replace(/\/\/.*$/, "");
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#") || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

function auditText(audit: KillAudit): string {
  return fs.readFileSync(path.join(ttRoot, audit.file), "utf8");
}

function killSiteLines(audit: KillAudit, text: string): Array<{ lineNo: number; text: string }> {
  const out: Array<{ lineNo: number; text: string }> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (isCommentLine(lines[i])) continue;
    const stripped = lines[i].includes("//") || lines[i].includes("/*")
      ? stripJsComment(lines[i])
      : stripBashComment(lines[i]);
    if (audit.killLine.test(stripped)) out.push({ lineNo: i + 1, text: stripped.trim() });
  }
  return out;
}

function isLiveness(audit: KillAudit, line: string): boolean {
  return audit.liveness.some((re) => re.test(line));
}

// ── the audit ──────────────────────────────────────────────────────

describe("E3.C.1 US-007 — kill-site audit scanner (explicit-recorded-target contract)", () => {
  it("every audited E3.C kill-bearing file exists", () => {
    const missing = AUDITS.filter((a) => !fs.existsSync(path.join(ttRoot, a.file))).map((a) => a.file);
    assert.deepEqual(missing, [], "audited files missing");
  });

  for (const audit of AUDITS) {
    describe(`audit: ${audit.file}`, () => {
      const text = auditText(audit);

      it("contains no name/tree-sweep tools (pkill/killall/pgrep/fuser)", () => {
        for (const ban of SWEEP_TOOL_BANS) {
          const m = text.match(ban);
          assert.equal(m, null, `${audit.file} contains banned sweep tool: ${m?.[0]}`);
        }
      });

      it("contains no inline-resolved kill target (kill $(...), ps|kill, xargs kill, find /proc, /proc glob)", () => {
        for (const ban of INLINE_RESOLVE_BANS) {
          const m = text.match(ban);
          assert.equal(m, null, `${audit.file} contains banned inline target resolution: ${m?.[0]}`);
        }
      });

      it("every kill site consumes a recorded registry (or is a liveness probe)", () => {
        const sites = killSiteLines(audit, text);
        const violations: string[] = [];
        for (const site of sites) {
          if (isLiveness(audit, site.text)) continue;
          if (/\/proc\b|\/proc\/|readdirSync|cmdline|\bcwd\b|\bps\b/.test(site.text)) {
            violations.push(`line ${site.lineNo}: kill line references a /proc/ps/cmdline/cwd source: ${site.text}`);
            continue;
          }
          for (const scanVar of audit.scanVars) {
            if (new RegExp(`\\b${scanVar}\\b`).test(site.text)) {
              violations.push(`line ${site.lineNo}: kill target derives from /proc enumeration loop var '${scanVar}': ${site.text}`);
            }
          }
          if (audit.allowed.length === 0) {
            violations.push(`line ${site.lineNo}: file must contain NO kill sites (teardown is delegated to identity-verified machinery), got: ${site.text}`);
            continue;
          }
          if (!audit.allowed.some((shape) => shape.test(site.text))) {
            violations.push(`line ${site.lineNo}: kill target is not a recorded-registry expression (allowed shapes: ${audit.allowed.map(String).join(" | ")}): ${site.text}`);
          }
        }
        assert.deepEqual(violations, [], `${audit.file} kill-site violations:\n${violations.join("\n")}`);
      });

      it("references its process-start-identity verification primitive(s)", () => {
        const missing = audit.identityRefs
          .filter((re) => !re.test(text))
          .map((re) => re.toString());
        assert.deepEqual(missing, [], `${audit.file} missing identity-verification primitive(s) — a kill site without start-identity verification would violate the contract`);
      });

      for (const extra of audit.required ?? []) {
        it(`meets required pattern ${extra}`, () => {
          assert.match(text, extra, `${audit.file} missing required pattern ${extra}`);
        });
      }
    });
  }
});
