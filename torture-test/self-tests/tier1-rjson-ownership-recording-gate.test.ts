// RJSON (beads tamandua-0j7.4.2.1, parent tamandua-0j7.4.2) — US-003 — the
// recording-only ownership gate, extended to the FIXED invocation-owned
// semantics for BOTH the persistence children (US-002) and the fixture
// recorder (US-003). US-001 built the gate + documented the pre-fix behavior.
//
// ── What this gate is ──────────────────────────────────────────────
// A focused, hermetic, recording-only regression that executes the ACTUAL
// cleanup/ownership decision code of
// torture-test/self-tests/tier1-rjson-recorder-emission-isolation.test.ts
// under unconditional recorded process / filesystem / wait / signal
// dependencies. It never issues a real signal, spawn, live-pid pidfile read,
// or filesystem removal; every operation the extracted code can perform is
// routed through recording bindings, and any unscripted/unknown op request
// raises BEFORE any real host operation could occur (escape proof).
//
// The technique is the coordinator-retained pattern from
// torture-test/var/review-logs/recorder-acceptance.7pn8r6/recording-proof.mjs:
// parse the CURRENT emission test source with the TypeScript compiler API
// (typescript is a repo devDependency), AST-extract the ACTUAL decision code
// by stable predicates — the spawnOwnedChild / currentChildVerdict /
// readChildIdentity / refuseChildSignal / stopOwnedChild functions, the
// recorder-ownership functions (currentRecorderVerdict / refuseRecorderSignal
// / stopOwnedRecorder / assertRecorderStopProceeds / readRecorderPidfile /
// recorderPidfilePath, plus the captureRecorderIdentity launcher), and the
// recorder-finally try/finally block — transpile them to plain JS, and
// execute them in fresh vm contexts whose process/fs/wait/signal
// dependencies and module-level helpers are replaced by recording bindings.
// Extraction fails loudly (asserts) when a target is missing or moved so
// this gate can never silently test a stale copy.
//
// ── US-002 fixed child-ownership semantics (ASSERTED here) ─────────
// Every owned persistence child argv carries a fresh per-invocation launch
// token (the fixture's mkdtemp suffix), launch identity evidence (ps cmdline
// + birth start) is captured at spawn on the exact handle this invocation
// created, and ONE guarded decision (currentChildVerdict) revalidates the
// CURRENT identity before EVERY signal — SIGTERM, then again before SIGKILL.
// Unknown/changed/stale/foreign/unreadable evidence REFUSES the signal with
// rich context (assert.fail) so evidence is preserved; a pid whose identity
// changed or was lost between TERM and KILL never receives a KILL; a child
// that dies before identity capture is never signaled (startup failure /
// spawn-retry disposal routes through the same guarded decision and records
// evidence instead).
//
// ── US-003 fixed recorder-ownership semantics (ASSERTED here) ──────
// The fixture recorder is started by this invocation through its own copied
// `start` subcommand (recorder runtime semantics unchanged — out of scope);
// its mutable pidfile plus the generic tt-recorder name alone never authorize
// a signal. A captured OwnedRecorder handle binds launch identity evidence
// (ps cmdline + birth start) to THIS invocation's exact fresh fixture +
// launch, and ONE guarded decision (currentRecorderVerdict) revalidates the
// CURRENT identity — pidfile content at the exact fixture path, liveness, ps
// cmdline + birth start vs the capture — before EVERY signal (TERM, then
// again before KILL). Every test-owned recorder cleanup decision path — the
// normal-stop pre-check (assertRecorderStopProceeds, before the recorder's
// own `stop` subcommand is invoked), the startup-error cleanup (rec === null:
// nothing was captured, so a live unproven pid is foreign and a stale dead
// pid is dead), and the finally leftover cleanup (stopOwnedRecorder) — routes
// through the same guarded decision on the ACTUAL code. A stale/foreign
// pidfile (other invocation / unrelated pid / unreadable / non-numeric),
// changed or unreadable identity, identity lost between TERM and KILL, and
// fixture-prefix-sibling path boundaries all REFUSE the signal with evidence
// preserved; a refusal in the finally stops the block BEFORE the fixture rm.
//
// ── Boundaries / hygiene ───────────────────────────────────────────
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob (no run.sh edit).
// Bounded, deterministic, idempotent, green on both hosts (pure JS + vm +
// the TS compiler; zero real operations, zero platform-specific code; no
// child_process import anywhere). Confined to torture-test/. Zero tokens.
// The only host filesystem reads are the gate's own sanctioned reads of the
// emission test source (and the typescript module load). No host writes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

// ── the live emission test source (the code under review) ───────────

const hereDir = path.dirname(fileURLToPath(import.meta.url));
const emissionFileName = "tier1-rjson-recorder-emission-isolation.test.ts";
const emissionFile = path.join(hereDir, emissionFileName);
assert.ok(
  fs.existsSync(emissionFile),
  `cannot find the emission test at ${emissionFile} — the recording gate must drive the ACTUAL emission-test code`,
);
const emissionText = fs.readFileSync(emissionFile, "utf8");

/** sha256 hex digest of a UTF-8 string. */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Hash pins. US-001 pinned the coordinator-reviewed US-001 source; US-002
// re-pinned the source and the child-ownership functions; US-003 edits the
// emission recorder helpers + call sites + the recorder-finally block, so the
// source pin and the recorder-function/finally-block pins move to the NEW
// code in this same story (the gate fails loudly on any later drift). The
// child-ownership functions are byte-identical to US-002, so their pins stay.
const SOURCE_SHA_PIN = "76fa7730355f2e61a661bb13b80eab78b37d88e8e16706fab66371be801d5b05";
const STOP_FN_SHA_PIN = "ea04d35f8318e8e4252ac03996faaea5f867868c141aed453cd82c377d7bbe1c";
const SPAWN_FN_SHA_PIN = "ecc73f4f8b06b9a9bde3a7bff0b8b00d32bab938524af21b302306a8d38d3ff6";
const VERDICT_FN_SHA_PIN = "79367f8307a334a6a9d4bf34f62b9960b667c244e3335f5ea8ac6cfd59614192";
const READ_FN_SHA_PIN = "e7f26e2eebced358e6bc7f7e1ffe05db3d820c5b6f23e33b917a52acab6985b8";
const REFUSE_FN_SHA_PIN = "5a2ade199be4ff05ed502257468a91988aea69a642e221ac5f03d96bab76f021";
// US-003 recorder-ownership pins (extracted ACTUAL emission-test code).
const REC_PIDFILE_FN_SHA_PIN = "3db5847a3ce36e412b3af13b07b316139145ec4cc0bc4136ea0f91b9b4e74b6b";
const REC_READ_FN_SHA_PIN = "9dbda598ea672750ea770e653a5d92b5bb5ff5156babaef2324af95761bd1c22";
const REC_VERDICT_FN_SHA_PIN = "f016eb2b2d203de749eb1fae5781e16b1586e6a4a68ee77c50d99d0af04e7779";
const REC_REFUSE_FN_SHA_PIN = "3b12fc864f7befc7eac420e35ed34c84e323a88a2979bd22880781fe23706173";
const REC_PRE_CHECK_FN_SHA_PIN = "ccaa697c92f627b0afc7fae3f38868087c4105e0f2e83868686a8a98c66bdbc7";
const REC_STOP_FN_SHA_PIN = "ac6f439354adf79f4fc506b149154c4e60408ee7cf5c97d638e726a5b09bb4ba";
const REC_CAPTURE_FN_SHA_PIN = "16f174c1e2aa63458b62ac660ef35f7ce85a6dffa08f367179a0d83d21465643";
const FINALLY_BLOCK_SHA_PIN = "39d0adc3f0e98f1aa025643f66346bdec27aca16abd50ed30ed07f8d7a237c73";

const sourceSha256 = sha256(emissionText);

// ── AST extraction of the ACTUAL decision code ──────────────────────

const ast = ts.createSourceFile(emissionFile, emissionText, ts.ScriptTarget.Latest, true);

/** All AST nodes satisfying `pred` (pre-order walk). */
function matches(pred: (n: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const walk = (n: ts.Node): void => {
    if (pred(n)) found.push(n);
    ts.forEachChild(n, walk);
  };
  walk(ast);
  return found;
}

/** Transpile a TS source fragment to plain ES2022 JavaScript. */
function compile(fragment: string): string {
  return ts.transpileModule(fragment, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

/** Extract exactly one top-level function declaration by name, failing
 *  loudly (assert) if it is missing or duplicated. */
function extractFunction(name: string): ts.FunctionDeclaration {
  const decls = matches(
    (n): boolean => ts.isFunctionDeclaration(n) && n.name !== undefined && n.name.text === name,
  );
  assert.equal(
    decls.length,
    1,
    `must find exactly one ${name} function declaration in the emission test, found ${decls.length}`,
  );
  return decls[0] as ts.FunctionDeclaration;
}

function sourceOf(node: ts.Node): { source: string; sha: string } {
  const source = node.getText(ast);
  return { source, sha: sha256(source) };
}

// Target 1: stopOwnedChild — the ONE guarded stop (revalidates before EACH
// signal: TERM, then again before the KILL escalation).
const stopFn = sourceOf(extractFunction("stopOwnedChild"));
// Structural pins: the guarded decision is invoked before TERM and again
// before KILL; signals only through process.kill; TERM -> KILL escalation.
assert.ok(
  (stopFn.source.match(/currentChildVerdict\(owned\)/g) ?? []).length >= 2,
  "stopOwnedChild must revalidate current identity before EACH signal (before SIGTERM and again before SIGKILL)",
);
assert.match(stopFn.source, /refuseChildSignal\(owned, "SIGTERM"/, "stopOwnedChild must refuse unproven SIGTERM");
assert.match(stopFn.source, /refuseChildSignal\(owned, "SIGKILL"/, "stopOwnedChild must refuse unproven SIGKILL");
assert.match(stopFn.source, /process\.kill\(/, "stopOwnedChild must signal through process.kill");
assert.match(stopFn.source, /SIGTERM/, "stopOwnedChild must have the TERM path");
assert.match(stopFn.source, /SIGKILL/, "stopOwnedChild must have the KILL escalation path");
assert.equal(stopFn.sha, STOP_FN_SHA_PIN, "stopOwnedChild drifted from the US-002-re-pinned hash");

// Target 2: currentChildVerdict — the ONE guarded identity decision every
// cleanup site (normal stop, failed-start disposal, spawn-retry disposal)
// routes through before any signal.
const verdictFn = sourceOf(extractFunction("currentChildVerdict"));
assert.match(verdictFn.source, /readChildIdentity\(/, "currentChildVerdict must read the current identity");
assert.match(verdictFn.source, /"owned"/, "currentChildVerdict must have the owned verdict");
assert.match(verdictFn.source, /"dead"/, "currentChildVerdict must have the dead verdict");
assert.match(verdictFn.source, /"foreign"/, "currentChildVerdict must have the foreign verdict");
assert.match(verdictFn.source, /"unreadable"/, "currentChildVerdict must have the unreadable verdict");
assert.match(verdictFn.source, /owned\.launchCmdline/, "currentChildVerdict must compare against the captured launch cmdline");
assert.match(verdictFn.source, /owned\.launchStart/, "currentChildVerdict must compare against the captured birth start");
assert.equal(verdictFn.sha, VERDICT_FN_SHA_PIN, "currentChildVerdict drifted from the US-002-re-pinned hash");

// Target 3: readChildIdentity — the synchronized liveness + cmdline + birth
// identity read used for both capture and revalidation.
const readFn = sourceOf(extractFunction("readChildIdentity"));
assert.match(readFn.source, /pidAlive\(/, "readChildIdentity must gate on pidAlive");
assert.match(readFn.source, /psCommand\(/, "readChildIdentity must read ps command-line evidence");
assert.match(readFn.source, /psStart\(/, "readChildIdentity must read the ps birth start");
assert.equal(readFn.sha, READ_FN_SHA_PIN, "readChildIdentity drifted from the US-002-re-pinned hash");

// Target 4: refuseChildSignal — the rich-context refusal (never signals).
const refuseFn = sourceOf(extractFunction("refuseChildSignal"));
assert.match(refuseFn.source, /assert\.fail\(/, "refuseChildSignal must raise a rich refusal");
assert.match(refuseFn.source, /refusing to deliver/, "refuseChildSignal must name the refused signal");
assert.equal(refuseFn.sha, REFUSE_FN_SHA_PIN, "refuseChildSignal drifted from the US-002-re-pinned hash");

// Target 5: spawnOwnedChild — the launcher that places the fresh token in
// argv and captures launch identity; its retry disposal must route through
// the same guarded decision and never issue a raw child.kill.
const spawnFn = sourceOf(extractFunction("spawnOwnedChild"));
assert.match(spawnFn.source, /token/, "spawnOwnedChild must carry the per-invocation launch token");
assert.match(spawnFn.source, /PERSIST_SCRIPT/, "spawnOwnedChild must build the persistence argv");
assert.match(spawnFn.source, /readChildIdentity\(/, "spawnOwnedChild must read identity at spawn");
assert.match(spawnFn.source, /currentChildVerdict\(/, "spawnOwnedChild disposal must route through the guarded decision");
assert.ok(!/\.kill\(/.test(spawnFn.source), "spawnOwnedChild must never issue a raw child.kill (unguarded bypass)");
assert.equal(spawnFn.sha, SPAWN_FN_SHA_PIN, "spawnOwnedChild drifted from the US-002-re-pinned hash");

// Target 6: recorderPidfilePath — the exact fixture recorder pidfile path.
const recPidfileFn = sourceOf(extractFunction("recorderPidfilePath"));
assert.match(recPidfileFn.source, /tt-recorder\.pid/, "recorderPidfilePath must name the fixture recorder pidfile");
assert.equal(recPidfileFn.sha, REC_PIDFILE_FN_SHA_PIN, "recorderPidfilePath drifted from the US-003-pinned hash");

// Target 7: readRecorderPidfile — the fixture pidfile read (fs only, recorded).
const recReadFn = sourceOf(extractFunction("readRecorderPidfile"));
assert.match(recReadFn.source, /existsSync/, "readRecorderPidfile must gate on existsSync");
assert.match(recReadFn.source, /readFileSync/, "readRecorderPidfile must read the pidfile");
assert.equal(recReadFn.sha, REC_READ_FN_SHA_PIN, "readRecorderPidfile drifted from the US-003-pinned hash");

// Target 8: currentRecorderVerdict — the ONE guarded identity decision every
// test-owned recorder cleanup site (normal-stop pre-check, startup-error
// cleanup, finally leftover cleanup) routes through before any signal.
const recVerdictFn = sourceOf(extractFunction("currentRecorderVerdict"));
assert.match(recVerdictFn.source, /readRecorderPidfile\(/, "currentRecorderVerdict must read the current pidfile");
assert.match(recVerdictFn.source, /"owned"/, "currentRecorderVerdict must have the owned verdict");
assert.match(recVerdictFn.source, /"dead"/, "currentRecorderVerdict must have the dead verdict");
assert.match(recVerdictFn.source, /"foreign"/, "currentRecorderVerdict must have the foreign verdict");
assert.match(recVerdictFn.source, /"unreadable"/, "currentRecorderVerdict must have the unreadable verdict");
assert.match(recVerdictFn.source, /readChildIdentity\(/, "currentRecorderVerdict must revalidate the live pid identity");
assert.match(recVerdictFn.source, /rec\.launchCmdline/, "currentRecorderVerdict must compare against the captured launch cmdline");
assert.match(recVerdictFn.source, /rec\.launchStart/, "currentRecorderVerdict must compare against the captured birth start");
assert.match(recVerdictFn.source, /rec\.pid !== pid/, "currentRecorderVerdict must refuse a pidfile that no longer names the captured pid");
assert.match(recVerdictFn.source, /rec === null/, "currentRecorderVerdict must handle a never-captured (startup-failure) recorder");
assert.equal(recVerdictFn.sha, REC_VERDICT_FN_SHA_PIN, "currentRecorderVerdict drifted from the US-003-pinned hash");

// Target 9: refuseRecorderSignal — the rich-context recorder refusal (never
// signals).
const recRefuseFn = sourceOf(extractFunction("refuseRecorderSignal"));
assert.match(recRefuseFn.source, /assert\.fail\(/, "refuseRecorderSignal must raise a rich refusal");
assert.match(recRefuseFn.source, /refusing to deliver/, "refuseRecorderSignal must name the refused signal");
assert.equal(recRefuseFn.sha, REC_REFUSE_FN_SHA_PIN, "refuseRecorderSignal drifted from the US-003-pinned hash");

// Target 10: stopOwnedRecorder — the ONE guarded recorder stop (revalidates
// pidfile + identity before TERM and again before the KILL escalation).
const recStopFn = sourceOf(extractFunction("stopOwnedRecorder"));
assert.ok(
  (recStopFn.source.match(/currentRecorderVerdict\(rec, varRoot\)/g) ?? []).length >= 2,
  "stopOwnedRecorder must revalidate current identity before EACH signal (before SIGTERM and again before SIGKILL)",
);
assert.match(recStopFn.source, /refuseRecorderSignal\(rec, varRoot, "SIGTERM"/, "stopOwnedRecorder must refuse unproven SIGTERM");
assert.match(recStopFn.source, /refuseRecorderSignal\(rec, varRoot, "SIGKILL"/, "stopOwnedRecorder must refuse unproven SIGKILL");
assert.match(recStopFn.source, /process\.kill\(/, "stopOwnedRecorder must signal through process.kill");
assert.match(recStopFn.source, /SIGTERM/, "stopOwnedRecorder must have the TERM path");
assert.match(recStopFn.source, /SIGKILL/, "stopOwnedRecorder must have the KILL escalation path");
assert.equal(recStopFn.sha, REC_STOP_FN_SHA_PIN, "stopOwnedRecorder drifted from the US-003-pinned hash");

// Target 11: assertRecorderStopProceeds — the normal-stop pre-check (before
// the recorder's own `stop` subcommand may signal the pidfile pid).
const recPreCheckFn = sourceOf(extractFunction("assertRecorderStopProceeds"));
assert.match(recPreCheckFn.source, /currentRecorderVerdict\(/, "assertRecorderStopProceeds must use the guarded decision");
assert.match(recPreCheckFn.source, /refuseRecorderSignal\(/, "assertRecorderStopProceeds must refuse unproven stops");
assert.equal(recPreCheckFn.sha, REC_PRE_CHECK_FN_SHA_PIN, "assertRecorderStopProceeds drifted from the US-003-pinned hash");

// Target 12: captureRecorderIdentity — the launcher that binds the started
// recorder's pid to THIS fixture + launch token and captures launch identity
// (structural pin only: it performs no signal, so it is not scenario-run).
const recCaptureFn = sourceOf(extractFunction("captureRecorderIdentity"));
assert.match(recCaptureFn.source, /readChildIdentity\(/, "captureRecorderIdentity must read identity at start");
assert.match(recCaptureFn.source, /cmdline\.includes\(token\)/, "captureRecorderIdentity must bind to THIS fixture's launch token");
assert.match(recCaptureFn.source, /launchCmdline: id\.cmdline/, "captureRecorderIdentity must retain the launch cmdline on the handle");
assert.match(recCaptureFn.source, /launchStart: id\.start/, "captureRecorderIdentity must retain the birth start on the handle");
assert.equal(recCaptureFn.sha, REC_CAPTURE_FN_SHA_PIN, "captureRecorderIdentity drifted from the US-003-pinned hash");

// Target 13: the recorder-finally try/finally block in the output-file test.
// US-003 routes the recorder leftover cleanup through the SAME guarded
// decision (stopOwnedRecorder), which changes the finally block's AST shape;
// the extraction predicate moves to the new shape and stays loud-failing.
const finallyTryNodes = matches(
  (n): boolean =>
    ts.isTryStatement(n) &&
    n.finallyBlock !== undefined &&
    n.finallyBlock.getText(ast).includes("stopOwnedRecorder("),
);
assert.equal(
  finallyTryNodes.length,
  1,
  `must find exactly one recorder-finally try block (stopOwnedRecorder cleanup), found ${finallyTryNodes.length}`,
);
const finallyTryNode = finallyTryNodes[0] as ts.TryStatement;
const finallyBlockSource = (finallyTryNode.finallyBlock as ts.Block).getText(ast);
const finallyBlockSha256 = sha256(finallyBlockSource);
assert.match(finallyBlockSource, /for \(const ch of children\) stopOwnedChild\(ch\)/, "recorder-finally must keep the guarded child loop");
assert.match(
  finallyBlockSource,
  /stopOwnedRecorder\(recorder, fixture\.varRoot\)/,
  "recorder-finally must route the recorder leftover cleanup through the ACTUAL guarded stopOwnedRecorder",
);
assert.match(finallyBlockSource, /fs\.rmSync\(fixture\.root/, "recorder-finally must remove the fixture root");
assert.equal(
  finallyBlockSha256,
  FINALLY_BLOCK_SHA_PIN,
  "recorder-finally block drifted from the US-003-re-pinned hash",
);
assert.equal(sourceSha256, SOURCE_SHA_PIN, "emission test source drifted from the US-003-re-pinned hash");

const stopCompiled = compile(stopFn.source);
const verdictCompiled = compile(verdictFn.source);
const readCompiled = compile(readFn.source);
const refuseCompiled = compile(refuseFn.source);
const spawnCompiled = compile(spawnFn.source);
const recPidfileCompiled = compile(recPidfileFn.source);
const recReadCompiled = compile(recReadFn.source);
const recVerdictCompiled = compile(recVerdictFn.source);
const recRefuseCompiled = compile(recRefuseFn.source);
const recPreCheckCompiled = compile(recPreCheckFn.source);
const recStopCompiled = compile(recStopFn.source);
const finallyCompiled = compile(`function __actualRecorderFinally()${finallyBlockSource}`);
for (const [label, js, expected] of [
  ["stopOwnedChild", stopCompiled, "function stopOwnedChild"],
  ["currentChildVerdict", verdictCompiled, "function currentChildVerdict"],
  ["readChildIdentity", readCompiled, "function readChildIdentity"],
  ["refuseChildSignal", refuseCompiled, "function refuseChildSignal"],
  ["spawnOwnedChild", spawnCompiled, "function spawnOwnedChild"],
  ["recorderPidfilePath", recPidfileCompiled, "function recorderPidfilePath"],
  ["readRecorderPidfile", recReadCompiled, "function readRecorderPidfile"],
  ["currentRecorderVerdict", recVerdictCompiled, "function currentRecorderVerdict"],
  ["refuseRecorderSignal", recRefuseCompiled, "function refuseRecorderSignal"],
  ["assertRecorderStopProceeds", recPreCheckCompiled, "function assertRecorderStopProceeds"],
  ["stopOwnedRecorder", recStopCompiled, "function stopOwnedRecorder"],
  ["recorder-finally", finallyCompiled, "__actualRecorderFinally"],
] as Array<[string, string, string]>) {
  assert.ok(js.includes(expected), `compiled ${label} missing (${expected})`);
}

// ── the recording harness (the ONLY route to any "host" operation) ──

/** Raised by the recording bindings when the extracted code requests an
 *  operation that is not part of the recorded contract. The request dies
 *  here — before any real host operation — which is the escape proof. */
class EscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscapeError";
  }
}

/** All op kinds the recording bindings may ever record. */
const ALLOWED_OPS = new Set([
  "pidAlive",
  "psCommand",
  "psStart",
  "sleepSync",
  "signal",
  "spawn",
  "fs.existsSync",
  "fs.readFileSync",
  "fs.rmSync",
]);

/** Scenario-controlled virtual process/filesystem state. Every operation the
 *  extracted code performs is answered from this state — never from the
 *  host — and every answer is recorded. */
interface ScenarioState {
  knownPids: Set<number>; // pids this scenario declares; anything else is unscripted -> escape
  alive: Set<number>; // pids currently alive
  cmdline: Map<number, string>; // ps command-line evidence per known pid ('' = unreadable/gone)
  start: Map<number, string>; // ps start (birth identity) per known pid ('' = unreadable/gone)
  termKills: boolean; // simulate the child's trap: SIGTERM exits cleanly (true) or survives (false)
  vfs: Map<string, { exists: boolean; content?: string }>; // virtual filesystem
  reuseAfterTerm?: { cmdline: string; start: string }; // identity changed between TERM and KILL (pid reuse)
  spawnPids?: Array<number | undefined>; // pids returned by successive spawn() calls (spawn scenarios)
}

interface RecordedOp {
  op: string;
  [key: string]: unknown;
}

/** Build the recording bindings for one scenario. Returns the log plus the
 *  binding functions/objects that go into the vm sandbox. */
function makeRecordingBindings(state: ScenarioState): {
  log: RecordedOp[];
  pidAlive: (pid: number) => boolean;
  psCommand: (pid: number) => string;
  psStart: (pid: number) => string;
  sleepSync: (ms: number) => void;
  processKill: (pid: number, signal: string) => void;
  spawn: (file: string, args: string[], opts: object) => { pid: number | undefined; stderr: object; kill: () => never };
  sleep: () => Promise<void>;
  fsProxy: object;
  pathJoin: (...parts: string[]) => string;
} {
  const log: RecordedOp[] = [];
  const escape = (msg: string): never => {
    throw new EscapeError(`recording-boundary escape: ${msg}`);
  };
  const ensureKnown = (pid: number, what: string): void => {
    if (!state.knownPids.has(pid)) escape(`${what} on unscripted pid ${pid} (not part of this scenario's process table)`);
  };

  const pidAlive = (pid: number): boolean => {
    ensureKnown(pid, "pidAlive");
    const result = state.alive.has(pid);
    log.push({ op: "pidAlive", pid, result });
    return result;
  };
  const psCommand = (pid: number): string => {
    ensureKnown(pid, "psCommand");
    const cmd = state.cmdline.get(pid);
    log.push({ op: "psCommand", pid, cmdline: cmd === undefined ? "" : cmd });
    return cmd === undefined ? "" : cmd;
  };
  const psStart = (pid: number): string => {
    ensureKnown(pid, "psStart");
    const s = state.start.get(pid);
    log.push({ op: "psStart", pid, start: s === undefined ? "" : s });
    return s === undefined ? "" : s;
  };
  const sleepSync = (ms: number): void => {
    log.push({ op: "sleepSync", ms });
    // Zero real wait: sleepSync is a recorded binding, never a host sleep.
  };
  const processKill = (pid: number, signal: string): void => {
    ensureKnown(pid, "signal");
    if (signal !== "SIGTERM" && signal !== "SIGKILL") {
      escape(`unscripted signal ${JSON.stringify(signal)}`);
    }
    if (!state.alive.has(pid)) {
      // Mimic the host ESRCH a real kill of a dead pid raises; the actual
      // code wraps process.kill in try/catch ("already gone") and swallows it.
      const esrch = new Error(`ESRCH: no such process ${pid}`);
      (esrch as Error & { code: string }).code = "ESRCH";
      log.push({ op: "signal", pid, signal, delivered: false, reason: "ESRCH" });
      throw esrch;
    }
    if (signal === "SIGTERM" && state.termKills) state.alive.delete(pid);
    if (signal === "SIGTERM" && !state.termKills && state.reuseAfterTerm !== undefined) {
      // The pid survives TERM but its identity changes before the KILL
      // revalidation (pid reuse between TERM and KILL).
      state.cmdline.set(pid, state.reuseAfterTerm.cmdline);
      state.start.set(pid, state.reuseAfterTerm.start);
    }
    if (signal === "SIGKILL") state.alive.delete(pid);
    log.push({ op: "signal", pid, signal, delivered: true });
  };
  // The virtual filesystem: the ONLY fs the extracted code can ever reach.
  // Unscripted method names raise before anything happens (escape proof).
  const FS_METHODS = new Set(["existsSync", "readFileSync", "rmSync"]);
  const fsProxy = new Proxy(
    {},
    {
      get(_target, prop, _receiver) {
        if (typeof prop === "symbol") escape(`symbolic fs access (${String(prop)})`);
        if (!FS_METHODS.has(prop as string)) {
          escape(`fs.${String(prop)} is not a recorded filesystem op (no real filesystem is reachable)`);
        }
        return (...args: unknown[]): unknown => {
          const target = String(args[0]);
          if (prop === "existsSync") {
            const entry = state.vfs.get(target);
            const result = entry !== undefined && entry.exists;
            log.push({ op: "fs.existsSync", target, result });
            return result;
          }
          if (prop === "readFileSync") {
            const entry = state.vfs.get(target);
            if (entry === undefined || !entry.exists) {
              // A read of a path with no virtual entry can never reach the
              // host: record the attempt, then raise the fs ENOENT the real
              // code would see (proving no live-pid/host read is possible).
              log.push({ op: "fs.readFileSync", target, content: null, missing: true });
              const enoent = new Error(`ENOENT: no such file or directory, open '${target}'`);
              (enoent as Error & { code: string }).code = "ENOENT";
              throw enoent;
            }
            log.push({ op: "fs.readFileSync", target, content: entry.content });
            return entry.content;
          }
          if (prop === "rmSync") {
            // Virtual removal: recorded, never touches the host filesystem.
            log.push({ op: "fs.rmSync", target, opts: (args[1] as object | undefined) ?? null });
            state.vfs.delete(target);
            return undefined;
          }
          throw new Error("unreachable recording fs method");
        };
      },
    },
  );
  // path.join is a pure operation (no host access); provide the plain join.
  const pathJoin = (...parts: string[]): string => parts.join("/");
  // spawn (spawnOwnedChild scenarios only): returns a scripted fake child.
  // Any raw child.kill on the fake is a regression (unguarded bypass) and
  // raises before any real operation.
  const spawnQueue: Array<number | undefined> = state.spawnPids ?? [];
  const spawn = (file: string, args: string[], opts: object): { pid: number | undefined; stderr: object; kill: () => never } => {
    const pid = spawnQueue.shift();
    log.push({ op: "spawn", file, args, pid: pid === undefined ? null : pid });
    if (pid !== undefined) state.knownPids.add(pid);
    return {
      pid,
      stderr: { on: () => {} },
      kill: () => escape("raw child.kill in spawnOwnedChild (unguarded bypass)"),
    };
  };
  // sleep is the module's async settle; the recording version resolves
  // immediately (zero real wait) so spawn scenarios stay instant.
  const sleep = async (): Promise<void> => {};
  return { log, pidAlive, psCommand, psStart, sleepSync, processKill, spawn, sleep, fsProxy, pathJoin };
}

// ── scenario table (fixed US-002 child + US-003 recorder semantics) ──

interface ScenarioOwnedChild {
  pid: number;
  argv: string[];
  stderr: string;
  launchCmdline: string;
  launchStart: string;
}

interface ScenarioOwnedRecorder {
  pid: number;
  varRoot: string;
  token: string;
  launchCmdline: string;
  launchStart: string;
}

interface ScenarioFixture {
  root: string;
  varRoot: string;
}

/** Structured fixed-semantics expectation for one scenario, checked against
 *  facts derived from the recording log + outcome (recorded-only). */
interface ScenarioExpect {
  raisedName: "AssertionError" | null;
  delivered: string[]; // exact sequence of DELIVERED signal names
  refusalPhase?: "TERM" | "KILL"; // which signal the refusal stopped (stop targets only)
  messageIncludes?: string[]; // substrings required in the raised message (when raised)
  spawnCount?: number; // expected spawn ops (spawn targets)
  capturedPid?: number; // expected spawned-handle pid (spawn owned-positive)
  rmSyncCount?: number; // expected fixture removals (finally targets)
}

interface ScenarioDefinition {
  id: string;
  target: "stopOwnedChild" | "spawnOwnedChild" | "recorderStop" | "recorderNormalStop" | "recorderFinally";
  kind: string; // case kind
  description: string;
  state: ScenarioState;
  owned?: ScenarioOwnedChild; // for stopOwnedChild scenarios (becomes __owned)
  spawn?: { token: string; cwd: string; argvTail: string[] }; // for spawnOwnedChild scenarios
  fixture?: ScenarioFixture; // for recorder scenarios (recorder pidfile under varRoot)
  recorder?: ScenarioOwnedRecorder | null; // for recorder scenarios (becomes __rec / recorder)
  children?: ScenarioOwnedChild[]; // for recorder-finally scenarios
  persistScript?: string; // PERSIST_SCRIPT global for spawn scenarios
  expect: ScenarioExpect;
  meta?: Record<string, string>; // free-form documentation notes (path tags etc.)
}

// The emission test's persistence argv pieces. The child argv now carries a
// fresh per-invocation token (CURRENT_TOKEN below) — never a fixed marker
// that recurs across invocations.
const PERSIST_MARKER = "fixture-persistence-script";
const CURRENT_TOKEN = "tt-recorder-rjson-TOK1a2b"; // THIS invocation's launch token
const OTHER_TOKEN = "tt-recorder-rjson-OTHR9z8y"; // a DIFFERENT invocation's launch token
const FIXED_MARKER_A = "rjson-argv0-A";
const CURRENT_FX_ROOT = "/synthetic/rjso-current-fx";
const CURRENT_FX_VAR = `${CURRENT_FX_ROOT}/torture-test/var`;
const OTHER_FX_ROOT = "/synthetic/rjso-OTHER-INVOCATION-fx";
const START_TS = "Sat Sep  6 12:00:00 2026"; // birth identity of the owned launch
const OTHER_START_TS = "Sat Sep  6 12:00:05 2026"; // birth identity of a foreign/reused process

function childArgv(): string[] {
  return ["bash", "-c", PERSIST_MARKER, CURRENT_TOKEN, FIXED_MARKER_A];
}
function childCmdline(tail: string): string {
  return `bash -c ${PERSIST_MARKER} ${CURRENT_TOKEN} ${FIXED_MARKER_A} ${tail}`;
}
function otherInvocationCmdline(tail: string): string {
  // Same argv names/markers as this invocation, but a DIFFERENT launch token
  // (another invocation) — a marker-only match must never authorize a signal.
  return `bash -c ${PERSIST_MARKER} ${OTHER_TOKEN} ${FIXED_MARKER_A} ${tail}`;
}

function currentFixture(): ScenarioFixture {
  return { root: CURRENT_FX_ROOT, varRoot: CURRENT_FX_VAR };
}
function pidfilePath(fixture: ScenarioFixture): string {
  return `${fixture.varRoot}/recorder/tt-recorder.pid`;
}

function ownedChild(pid: number, cmdline = childCmdline("marker-tail"), start = START_TS): ScenarioOwnedChild {
  return { pid, argv: childArgv(), stderr: "", launchCmdline: cmdline, launchStart: start };
}

// The fixture recorder's launch cmdline shapes. The recorder is started via
// `bash <fx>/torture-test/bin/tt-recorder start`, so the detached recorder's
// cmdline embeds the fixture-exact tool path (`source '<fx>/...tt-recorder'`)
// — the per-invocation token is part of that path. Only FULL cmdline + birth
// start equality with the captured launch evidence proves ownership.
function recorderCmdline(fxBin = `${CURRENT_FX_ROOT}/torture-test/bin/tt-recorder`, extra = ""): string {
  return `bash -c source '${fxBin}'; _run_loop '1'${extra}`;
}
function otherInvocationRecorderCmdline(): string {
  // Same generic shape (a tt-recorder under a torture-test/var fixture) but a
  // DIFFERENT invocation's fixture path/token — a name-only check would
  // accept it; full cmdline equality must refuse it.
  return recorderCmdline(`${OTHER_FX_ROOT}/torture-test/bin/tt-recorder`);
}
function capturedRecorder(pid: number, opts: { cmdline?: string; start?: string } = {}): ScenarioOwnedRecorder {
  return {
    pid,
    varRoot: CURRENT_FX_VAR,
    token: CURRENT_TOKEN,
    launchCmdline: opts.cmdline ?? recorderCmdline(),
    launchStart: opts.start ?? START_TS,
  };
}
/** vfs entry for a live recorder pidfile naming `pid`. */
function recorderPidfileEntry(fixture: ScenarioFixture, pid: number | string): { exists: boolean; content: string } {
  return { exists: true, content: String(pid) };
}

/** Build the process-table half of a scenario state for one live pid. */
function livePidState(
  pid: number,
  opts: { cmdline?: string; start?: string; alive?: boolean } = {},
): Pick<ScenarioState, "knownPids" | "alive" | "cmdline" | "start"> {
  return {
    knownPids: new Set([pid]),
    alive: opts.alive === false ? new Set() : new Set([pid]),
    cmdline: new Map([[pid, opts.cmdline ?? childCmdline("marker-tail")]]),
    start: new Map([[pid, opts.start ?? START_TS]]),
  };
}

const SCENARIOS: ScenarioDefinition[] = [
  // ── stopOwnedChild (owned persistence child) — fixed semantics ────
  {
    id: "stop-owned-term-then-dead",
    target: "stopOwnedChild",
    kind: "owned-positive cleanup: TERM after revalidated owned verdict; dead after TERM -> no KILL",
    description:
      "an owned child whose CURRENT identity (liveness + cmdline + birth start) exactly matches the launch evidence captured at spawn; SIGTERM exits it cleanly (trap). The gate asserts TERM is delivered only right after an owned verdict and that a dead-after-TERM child gets NO KILL.",
    state: { ...livePidState(700001), termKills: true, vfs: new Map() },
    owned: ownedChild(700001),
    expect: { raisedName: null, delivered: ["SIGTERM"] },
  },
  {
    id: "stop-owned-alive-term-then-kill",
    target: "stopOwnedChild",
    kind: "owned-positive KILL escalation: alive with matching identity after TERM -> KILL, itself preceded by revalidation",
    description:
      "an owned child that survives SIGTERM with its identity unchanged; the guard revalidates the CURRENT identity AGAIN between TERM and KILL and only an owned verdict receives the KILL.",
    state: { ...livePidState(700002), termKills: false, vfs: new Map() },
    owned: ownedChild(700002),
    expect: { raisedName: null, delivered: ["SIGTERM", "SIGKILL"] },
  },
  {
    id: "stop-pid-reuse-between-term-and-kill",
    target: "stopOwnedChild",
    kind: "identity changed between TERM and KILL (pid reuse) -> KILL REFUSED + evidence preserved",
    description:
      "the child survives SIGTERM but its identity changes before the KILL revalidation (the pid now runs a different program); the guard REFUSES the KILL (rich context) and issues no KILL — evidence preserved.",
    state: {
      ...livePidState(700003),
      termKills: false,
      reuseAfterTerm: { cmdline: "bash totally-foreign-reused", start: OTHER_START_TS },
      vfs: new Map(),
    },
    owned: ownedChild(700003),
    expect: { raisedName: "AssertionError", delivered: ["SIGTERM"], refusalPhase: "KILL", messageIncludes: ["refusing to deliver SIGKILL", "is not \"owned\""] },
  },
  {
    id: "stop-other-invocation-same-names",
    target: "stopOwnedChild",
    kind: "another invocation with the same argv names (token mismatch) -> REFUSED",
    description:
      "a process whose ps cmdline carries the SAME argv names/markers as this invocation's child but a DIFFERENT launch token (a different invocation on this host); the token-bound cmdline/start equality cannot match -> the signal is REFUSED before any delivery.",
    state: { ...livePidState(700004, { cmdline: otherInvocationCmdline("foreign-invocation line"), start: OTHER_START_TS }), termKills: true, vfs: new Map() },
    owned: ownedChild(700004),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM"] },
  },
  {
    id: "stop-changed-identity",
    target: "stopOwnedChild",
    kind: "changed/stale identity evidence (birth start differs) -> REFUSED",
    description:
      "the pid is alive with the SAME cmdline but a DIFFERENT birth start than the captured launch evidence (stale/changed identity — a reused pid that re-ran the same text is caught by the start mismatch); the signal is REFUSED.",
    state: { ...livePidState(700005, { start: OTHER_START_TS }), termKills: true, vfs: new Map() },
    owned: ownedChild(700005),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM"] },
  },
  {
    id: "stop-unreadable-identity",
    target: "stopOwnedChild",
    kind: "unreadable identity evidence (empty cmdline) -> REFUSED",
    description:
      "the pid is alive at the liveness gate but ps returns empty cmdline evidence (unreadable/raced); the verdict is unreadable -> REFUSED with evidence preserved.",
    state: {
      knownPids: new Set([700006]),
      alive: new Set([700006]),
      cmdline: new Map([[700006, ""]]),
      start: new Map([[700006, START_TS]]),
      termKills: true,
      vfs: new Map(),
    },
    owned: ownedChild(700006),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM", "unreadable"] },
  },
  {
    id: "stop-foreign-pid",
    target: "stopOwnedChild",
    kind: "foreign pid (unrelated process on our pid) -> REFUSED",
    description:
      "the pid is alive but runs a completely unrelated program (not the launch); verdict foreign -> REFUSED before any signal.",
    state: { ...livePidState(700007, { cmdline: "bash something-completely-different", start: OTHER_START_TS }), termKills: true, vfs: new Map() },
    owned: ownedChild(700007),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM"] },
  },
  {
    id: "stop-never-captured-handle",
    target: "stopOwnedChild",
    kind: "handle with no captured launch evidence (never captured) -> REFUSED",
    description:
      "a child that died before identity capture left an evidence-less handle; if the pid is later alive (reused) the guard can never prove ownership (no captured launch to match) -> REFUSED; an evidence-less handle can never authorize a signal.",
    state: { ...livePidState(700008), termKills: true, vfs: new Map() },
    owned: { pid: 700008, argv: childArgv(), stderr: "", launchCmdline: "", launchStart: "" },
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM"] },
  },
  {
    id: "stop-dead-at-entry",
    target: "stopOwnedChild",
    kind: "child already dead before cleanup -> no signal",
    description:
      "the child is no longer alive when cleanup runs; the guarded decision returns dead and no signal and no identity reads past liveness happen.",
    state: { ...livePidState(700009, { alive: false }), termKills: true, vfs: new Map() },
    owned: ownedChild(700009),
    expect: { raisedName: null, delivered: [] },
  },
  {
    id: "stop-sibling-fixture-prefix",
    target: "stopOwnedChild",
    kind: "exact path boundary: a sibling fixture path that merely PREFIX-matches never authorizes",
    description:
      "the pid's cmdline equals the launch cmdline plus an extra suffix (a process under a sibling fixture whose path starts with this fixture's path); only full cmdline+start equality proves ownership, so the prefix match is REFUSED.",
    state: { ...livePidState(700010, { cmdline: childCmdline("marker-tail") + " extra-sibling-suffix" }), termKills: true, vfs: new Map() },
    owned: ownedChild(700010),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM"] },
  },

  // ── spawnOwnedChild (launch identity capture + guarded retry) ─────
  {
    id: "spawn-owned-captured",
    target: "spawnOwnedChild",
    kind: "owned-positive launch: identity captured at spawn on the exact handle",
    description:
      "the spawn settles alive with THIS launch's token in the cmdline and a readable birth start; spawnOwnedChild returns the handle with launchCmdline/launchStart captured — no signal of any kind.",
    state: {
      knownPids: new Set(),
      alive: new Set([800001]),
      cmdline: new Map([[800001, childCmdline("marker-tail")]]),
      start: new Map([[800001, START_TS]]),
      termKills: true,
      vfs: new Map(),
      spawnPids: [800001],
    },
    spawn: { token: CURRENT_TOKEN, cwd: `${CURRENT_FX_VAR}/childA`, argvTail: [FIXED_MARKER_A, "tail"] },
    persistScript: PERSIST_MARKER,
    expect: { raisedName: null, delivered: [], spawnCount: 1, capturedPid: 800001 },
  },
  {
    id: "spawn-startup-failure",
    target: "spawnOwnedChild",
    kind: "startup failure / exit-before-identity-capture -> NEVER signals a stale pid",
    description:
      "every spawn attempt exits before identity capture (exec denial); each rejected child is routed through the SAME guarded decision (verdict dead) and its evidence is recorded, then the spawn is retried; after 5 attempts the function assert-fails with the retained attempt evidence and ZERO signals were issued.",
    state: {
      knownPids: new Set(),
      alive: new Set(),
      cmdline: new Map(),
      start: new Map(),
      termKills: true,
      vfs: new Map(),
      spawnPids: [800101, 800102, 800103, 800104, 800105],
    },
    spawn: { token: CURRENT_TOKEN, cwd: `${CURRENT_FX_VAR}/childA`, argvTail: [FIXED_MARKER_A, "tail"] },
    persistScript: PERSIST_MARKER,
    expect: {
      raisedName: "AssertionError",
      delivered: [],
      spawnCount: 5,
      messageIncludes: ["failed to stay alive after 5 attempts", "guarded verdict=dead", "retained attempt evidence"],
    },
  },
  {
    id: "spawn-reuse-recovery",
    target: "spawnOwnedChild",
    kind: "pid reused before identity capture -> refused, evidence recorded, retry recovers an owned launch",
    description:
      "the first spawn's pid is alive but already runs a DIFFERENT invocation's process (reuse before capture): the guarded decision refuses (no signal), the evidence is recorded, and the retry captures an owned launch.",
    state: {
      knownPids: new Set(),
      alive: new Set([800201, 800202]),
      cmdline: new Map([
        [800201, otherInvocationCmdline("reused")],
        [800202, childCmdline("marker-tail")],
      ]),
      start: new Map([
        [800201, OTHER_START_TS],
        [800202, START_TS],
      ]),
      termKills: true,
      vfs: new Map(),
      spawnPids: [800201, 800202],
    },
    spawn: { token: CURRENT_TOKEN, cwd: `${CURRENT_FX_VAR}/childA`, argvTail: [FIXED_MARKER_A, "tail"] },
    persistScript: PERSIST_MARKER,
    expect: { raisedName: null, delivered: [], spawnCount: 2, capturedPid: 800202 },
  },
  {
    id: "spawn-no-pid-exhausted",
    target: "spawnOwnedChild",
    kind: "spawn returns no pid (launch failure) -> no signal, retried, evidence retained",
    description:
      "the spawn call yields no pid at all (launch failure before a handle exists); each attempt records the evidence and retries, and after 5 attempts the function assert-fails with ZERO signals.",
    state: {
      knownPids: new Set(),
      alive: new Set(),
      cmdline: new Map(),
      start: new Map(),
      termKills: true,
      vfs: new Map(),
      spawnPids: [],
    },
    spawn: { token: CURRENT_TOKEN, cwd: `${CURRENT_FX_VAR}/childA`, argvTail: [FIXED_MARKER_A, "tail"] },
    persistScript: PERSIST_MARKER,
    expect: {
      raisedName: "AssertionError",
      delivered: [],
      spawnCount: 5,
      messageIncludes: ["failed to stay alive after 5 attempts", "spawn returned no pid", "retained attempt evidence"],
    },
  },

  // ── recorder-finally (child loop through ACTUAL stopOwnedChild; the
  //    recorder leftover cleanup routes through the ACTUAL guarded
  //    stopOwnedRecorder — US-003 fixed semantics) ───────────────────
  {
    id: "finally-children-delegation-owned",
    target: "recorderFinally",
    kind: "finally child loop delegates to the ACTUAL guarded stopOwnedChild (owned-positive); no recorder started -> no recorder signal, fixture rm follows",
    description:
      "the finally block first stops every registered child by calling the module-level stopOwnedChild (the compiled ACTUAL function composed in the same context) — an owned child with captured evidence is TERM'd after an owned verdict and, dead after TERM, gets no KILL; the recorder was never started (recorder === null, no pidfile), so stopOwnedRecorder sees no pidfile (dead) and issues no signal; the fixture rm follows.",
    state: { ...livePidState(800301), termKills: true, vfs: new Map() },
    fixture: currentFixture(),
    recorder: null,
    children: [ownedChild(800301)],
    expect: { raisedName: null, delivered: ["SIGTERM"], rmSyncCount: 1 },
  },

  // ── recorderStop: the ACTUAL guarded recorder stop (stopOwnedRecorder) ──
  {
    id: "recorder-owned-term-then-dead",
    target: "recorderStop",
    kind: "owned-positive recorder cleanup: TERM after revalidated owned verdict (pidfile + identity); dead after TERM -> no KILL",
    description:
      "an owned recorder whose CURRENT identity (pidfile content == captured pid, liveness, ps cmdline + birth start exactly matching the launch evidence captured at start) is revalidated before SIGTERM; SIGTERM exits it cleanly; dead after TERM -> NO KILL. This is the decision the finally leftover cleanup makes for a genuinely owned survivor (path=finally).",
    state: {
      ...livePidState(900001, { cmdline: recorderCmdline(), start: START_TS }),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900001)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900001),
    expect: { raisedName: null, delivered: ["SIGTERM"] },
    meta: { path: "finally", state: "owned leftover" },
  },
  {
    id: "recorder-owned-term-then-kill",
    target: "recorderStop",
    kind: "owned-positive recorder KILL escalation: alive with matching identity after TERM -> KILL, itself preceded by fresh pidfile+identity revalidation",
    description:
      "an owned recorder that survives SIGTERM with its identity unchanged; the guard revalidates the CURRENT identity (pidfile + liveness + cmdline + birth start) AGAIN between TERM and KILL, and only an owned verdict receives the KILL (path=finally KILL escalation).",
    state: {
      ...livePidState(900002, { cmdline: recorderCmdline(), start: START_TS }),
      termKills: false,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900002)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900002),
    expect: { raisedName: null, delivered: ["SIGTERM", "SIGKILL"] },
    meta: { path: "finally", state: "owned survivor ignores TERM" },
  },
  {
    id: "recorder-pid-reuse-between-term-and-kill",
    target: "recorderStop",
    kind: "recorder identity changed between TERM and KILL (pid reuse) -> KILL REFUSED + evidence preserved",
    description:
      "the recorder survives SIGTERM but its birth identity changes before the KILL revalidation (the pid was reused); the guard REFUSES the KILL with rich context and issues no KILL — evidence preserved.",
    state: {
      ...livePidState(900003, { cmdline: recorderCmdline(), start: START_TS }),
      termKills: false,
      reuseAfterTerm: { cmdline: recorderCmdline(), start: OTHER_START_TS },
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900003)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900003),
    expect: { raisedName: "AssertionError", delivered: ["SIGTERM"], refusalPhase: "KILL", messageIncludes: ["refusing to deliver SIGKILL", "is not \"owned\""] },
    meta: { path: "finally", state: "identity lost between TERM and KILL" },
  },
  {
    id: "recorder-other-invocation-same-names",
    target: "recorderStop",
    kind: "another invocation's recorder with the same generic shape (different fixture token) -> REFUSED",
    description:
      "the pidfile names our captured pid, but the live process is a recorder from ANOTHER invocation's fixture (same generic tt-recorder shape, different fixture path/token); a name-only check would accept it, full pidfile+identity equality REFUSES the TERM.",
    state: {
      knownPids: new Set([900004]),
      alive: new Set([900004]),
      cmdline: new Map([[900004, otherInvocationRecorderCmdline()]]),
      start: new Map([[900004, OTHER_START_TS]]),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900004)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900004),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM"] },
    meta: { path: "normal-stop", state: "other invocation, same names" },
  },
  {
    id: "recorder-changed-identity",
    target: "recorderStop",
    kind: "changed/stale recorder identity (birth start differs) -> REFUSED",
    description:
      "the recorder is alive with the SAME cmdline but a DIFFERENT birth start than the captured launch evidence (a reused pid that re-ran the same text is caught by the start mismatch); the signal is REFUSED.",
    state: {
      ...livePidState(900005, { cmdline: recorderCmdline(), start: OTHER_START_TS }),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900005)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900005),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM"] },
    meta: { path: "normal-stop", state: "changed identity" },
  },
  {
    id: "recorder-unreadable-identity",
    target: "recorderStop",
    kind: "unreadable recorder identity (empty ps cmdline) -> REFUSED",
    description:
      "the pid is alive at the liveness gate but ps returns empty cmdline evidence (unreadable/raced); the verdict is unreadable -> REFUSED with evidence preserved.",
    state: {
      knownPids: new Set([900006]),
      alive: new Set([900006]),
      cmdline: new Map([[900006, ""]]),
      start: new Map([[900006, START_TS]]),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900006)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900006),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM", "unreadable"] },
    meta: { path: "finally", state: "unreadable identity" },
  },
  {
    id: "recorder-foreign-pid",
    target: "recorderStop",
    kind: "foreign pid (unrelated process at our captured pid) -> REFUSED",
    description:
      "the captured pid is alive but runs a completely unrelated program (not the recorder we started); verdict foreign -> REFUSED before any signal.",
    state: {
      ...livePidState(900007, { cmdline: "bash totally-unrelated-program", start: OTHER_START_TS }),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900007)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900007),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM"] },
    meta: { path: "normal-stop", state: "unrelated pid" },
  },
  {
    id: "recorder-stale-foreign-pidfile",
    target: "recorderStop",
    kind: "stale/foreign pidfile naming a DIFFERENT pid than the captured handle -> REFUSED",
    description:
      "the pidfile content no longer names the pid this invocation captured (it names some other pid — a stale or foreign pidfile); the guard REFUSES before any identity read or signal: only the exact captured pid is ever a signal candidate.",
    state: {
      ...livePidState(900008, { cmdline: recorderCmdline(), start: START_TS }),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900099)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900008),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM"] },
    meta: { path: "finally", state: "stale/foreign pidfile (other pid)" },
  },
  {
    id: "recorder-pidfile-nonnumeric",
    target: "recorderStop",
    kind: "non-numeric recorder pidfile content -> REFUSED (unreadable), evidence preserved",
    description:
      "the fixture pidfile content is not a numeric pid (unreadable/corrupt); the guard REFUSES the signal — no live pid is provable from a non-numeric pidfile.",
    state: {
      knownPids: new Set([900010]),
      alive: new Set([900010]),
      cmdline: new Map([[900010, recorderCmdline()]]),
      start: new Map([[900010, START_TS]]),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), { exists: true, content: "not-a-pid" }]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900010),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM", "unreadable"] },
    meta: { path: "finally", state: "non-numeric pidfile" },
  },
  {
    id: "recorder-no-pidfile",
    target: "recorderStop",
    kind: "no fixture pidfile (recorder already stopped / never running here) -> dead, no signal",
    description:
      "the fixture pidfile is absent; the guarded decision is dead (nothing is running under this fixture) and stopOwnedRecorder returns without any signal.",
    state: { knownPids: new Set([900011]), alive: new Set([900011]), cmdline: new Map([[900011, recorderCmdline()]]), start: new Map([[900011, START_TS]]), termKills: true, vfs: new Map() },
    fixture: currentFixture(),
    recorder: capturedRecorder(900011),
    expect: { raisedName: null, delivered: [] },
    meta: { path: "finally", state: "no pidfile (normal completion)" },
  },
  {
    id: "recorder-never-captured-handle",
    target: "recorderStop",
    kind: "handle with no captured launch evidence (never captured) -> REFUSED",
    description:
      "a handle whose launch evidence was never captured (start died before capture); even with the pidfile naming its pid and a live process, the guard can never prove ownership (no captured launch to match) -> REFUSED.",
    state: {
      ...livePidState(900012, { cmdline: recorderCmdline(), start: START_TS }),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900012)]]),
    },
    fixture: currentFixture(),
    recorder: { pid: 900012, varRoot: CURRENT_FX_VAR, token: CURRENT_TOKEN, launchCmdline: "", launchStart: "" },
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM"] },
    meta: { path: "startup-error", state: "never-captured handle" },
  },
  {
    id: "recorder-sibling-fixture-prefix",
    target: "recorderStop",
    kind: "exact path boundary: a sibling-fixture cmdline that PREFIX-matches the launch never authorizes",
    description:
      "the current cmdline equals the captured launch cmdline plus an extra suffix (a process under a sibling fixture whose path starts with this fixture's path); only full cmdline+start equality proves ownership, so the prefix match is REFUSED.",
    state: {
      ...livePidState(900013, { cmdline: recorderCmdline() + " extra-sibling-suffix", start: START_TS }),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900013)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900013),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM"] },
    meta: { path: "finally", state: "sibling fixture prefix" },
  },
  {
    id: "recorder-startup-error-live-foreign",
    target: "recorderStop",
    kind: "startup failure cleanup: rec === null with a LIVE unproven pidfile pid -> REFUSED (no blind signal from a crashed start)",
    description:
      "the start never produced a captured handle (startup failure) but the fixture pidfile names a LIVE process we never captured; without captured launch evidence no pid is provably ours -> REFUSED — a crashed start must never blind-signal a live unproven pid.",
    state: {
      knownPids: new Set([900014]),
      alive: new Set([900014]),
      cmdline: new Map([[900014, otherInvocationRecorderCmdline()]]),
      start: new Map([[900014, OTHER_START_TS]]),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900014)]]),
    },
    fixture: currentFixture(),
    recorder: null,
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM"] },
    meta: { path: "startup-error", state: "live unproven pidfile pid" },
  },
  {
    id: "recorder-startup-error-dead-pidfile",
    target: "recorderStop",
    kind: "startup failure cleanup: rec === null with a stale DEAD pidfile pid -> dead, no signal",
    description:
      "the start crashed and left a stale pidfile naming a DEAD pid; the guarded decision is dead (nothing live to signal) and stopOwnedRecorder returns without any signal.",
    state: {
      knownPids: new Set([900015]),
      alive: new Set(),
      cmdline: new Map(),
      start: new Map(),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900015)]]),
    },
    fixture: currentFixture(),
    recorder: null,
    expect: { raisedName: null, delivered: [] },
    meta: { path: "startup-error", state: "stale dead pidfile" },
  },
  {
    id: "recorder-startup-error-no-pidfile",
    target: "recorderStop",
    kind: "startup failure cleanup: rec === null with no pidfile -> dead, no signal",
    description:
      "the start failed before any pidfile existed; the guarded decision is dead and stopOwnedRecorder returns without any signal.",
    state: { knownPids: new Set(), alive: new Set(), cmdline: new Map(), start: new Map(), termKills: true, vfs: new Map() },
    fixture: currentFixture(),
    recorder: null,
    expect: { raisedName: null, delivered: [] },
    meta: { path: "startup-error", state: "no pidfile" },
  },

  // ── recorderNormalStop: the ACTUAL normal-stop pre-check
  //    (assertRecorderStopProceeds, before the recorder's own `stop`
  //    subcommand may signal the pidfile pid) ─────────────────────────
  {
    id: "recorder-normal-owned-proceeds",
    target: "recorderNormalStop",
    kind: "normal stop: owned recorder -> proceeds (the recorder's own stop subcommand may run)",
    description:
      "the recorder's CURRENT identity still proves THIS invocation's recorder (owned verdict); assertRecorderStopProceeds returns without raising, so the normal-stop path proceeds to the recorder's own stop subcommand (path=normal-stop).",
    state: {
      ...livePidState(900021, { cmdline: recorderCmdline(), start: START_TS }),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900021)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900021),
    expect: { raisedName: null, delivered: [] },
    meta: { path: "normal-stop", state: "owned" },
  },
  {
    id: "recorder-normal-dead-proceeds",
    target: "recorderNormalStop",
    kind: "normal stop: recorder already dead (stale pidfile naming our pid) -> proceeds (no live target)",
    description:
      "the captured recorder died before the normal stop (stale pidfile naming our pid, nothing live); the guarded decision is dead -> assertRecorderStopProceeds returns (no live target to protect), so the recorder's own stale-pidfile handling may run (path=normal-stop).",
    state: {
      knownPids: new Set([900022]),
      alive: new Set(),
      cmdline: new Map(),
      start: new Map(),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900022)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900022),
    expect: { raisedName: null, delivered: [] },
    meta: { path: "normal-stop", state: "dead recorder" },
  },
  {
    id: "recorder-normal-other-invocation-refuses",
    target: "recorderNormalStop",
    kind: "normal stop: another invocation's recorder at our captured pid -> REFUSED (guarded normal stop cannot be bypassed)",
    description:
      "at normal-stop time the pidfile names our captured pid but the live process is ANOTHER invocation's recorder; assertRecorderStopProceeds REFUSES (evidence preserved) so the recorder's own stop subcommand is never invoked against an unproven pid (path=normal-stop).",
    state: {
      knownPids: new Set([900023]),
      alive: new Set([900023]),
      cmdline: new Map([[900023, otherInvocationRecorderCmdline()]]),
      start: new Map([[900023, OTHER_START_TS]]),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900023)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900023),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM"] },
    meta: { path: "normal-stop", state: "other invocation" },
  },
  {
    id: "recorder-normal-stale-pidfile-refuses",
    target: "recorderNormalStop",
    kind: "normal stop: stale/foreign pidfile (content != captured pid) -> REFUSED",
    description:
      "at normal-stop time the pidfile content names a pid that is not the captured recorder pid (stale/foreign pidfile); assertRecorderStopProceeds REFUSES before the recorder's own stop subcommand could signal that pid (path=normal-stop).",
    state: {
      ...livePidState(900024, { cmdline: recorderCmdline(), start: START_TS }),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900025)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900024),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM"] },
    meta: { path: "normal-stop", state: "stale/foreign pidfile" },
  },
  {
    id: "recorder-normal-unreadable-refuses",
    target: "recorderNormalStop",
    kind: "normal stop: unreadable recorder identity -> REFUSED",
    description:
      "at normal-stop time the recorder's ps cmdline is unreadable/empty; assertRecorderStopProceeds REFUSES with evidence preserved (path=normal-stop).",
    state: {
      knownPids: new Set([900026]),
      alive: new Set([900026]),
      cmdline: new Map([[900026, ""]]),
      start: new Map([[900026, START_TS]]),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900026)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900026),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM", "unreadable"] },
    meta: { path: "normal-stop", state: "unreadable identity" },
  },
  {
    id: "recorder-normal-changed-refuses",
    target: "recorderNormalStop",
    kind: "normal stop: changed recorder identity (birth start differs) -> REFUSED",
    description:
      "at normal-stop time the recorder's birth start no longer matches the launch capture (changed/reused identity); assertRecorderStopProceeds REFUSES with evidence preserved (path=normal-stop).",
    state: {
      ...livePidState(900027, { cmdline: recorderCmdline(), start: OTHER_START_TS }),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900027)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900027),
    expect: { raisedName: "AssertionError", delivered: [], refusalPhase: "TERM", messageIncludes: ["refusing to deliver SIGTERM"] },
    meta: { path: "normal-stop", state: "changed identity" },
  },

  // ── recorderFinally: the ACTUAL finally block (children loop +
  //    stopOwnedRecorder + fixture rm) — asserted fixed semantics ────
  {
    id: "finally-recorder-owned-leftover-stopped",
    target: "recorderFinally",
    kind: "finally: owned leftover recorder (normal stop raced/failed) -> TERM under owned verdict; dead after TERM -> no KILL; fixture rm follows",
    description:
      "the finally runs with a genuinely owned recorder still running (a normal stop raced/failed above): the ACTUAL stopOwnedRecorder revalidates pidfile + identity (owned) and TERMs it; dead after TERM -> no KILL; the fixture rm follows.",
    state: {
      ...livePidState(900031, { cmdline: recorderCmdline(), start: START_TS }),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900031)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900031),
    children: [],
    expect: { raisedName: null, delivered: ["SIGTERM"], rmSyncCount: 1 },
    meta: { path: "finally", state: "owned leftover" },
  },
  {
    id: "finally-recorder-owned-kill-escalation",
    target: "recorderFinally",
    kind: "finally: owned leftover recorder ignores TERM -> KILL escalation, itself preceded by fresh revalidation; fixture rm follows",
    description:
      "the owned leftover recorder survives SIGTERM with its identity unchanged; the ACTUAL stopOwnedRecorder revalidates the CURRENT identity AGAIN between TERM and KILL (pidfile + liveness + cmdline + birth start) and only an owned verdict receives the KILL; the fixture rm follows.",
    state: {
      ...livePidState(900032, { cmdline: recorderCmdline(), start: START_TS }),
      termKills: false,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900032)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900032),
    children: [],
    expect: { raisedName: null, delivered: ["SIGTERM", "SIGKILL"], rmSyncCount: 1 },
    meta: { path: "finally", state: "owned survivor ignores TERM" },
  },
  {
    id: "finally-recorder-foreign-pidfile-refuses",
    target: "recorderFinally",
    kind: "finally: stale/foreign pidfile (content != captured pid) -> REFUSED; NO fixture rm (refusal evidence preserved)",
    description:
      "the finally finds a pidfile naming a pid that is NOT the captured recorder pid (a stale/foreign pidfile, e.g. another invocation's or an unrelated pid); the ACTUAL stopOwnedRecorder REFUSES the signal and the refusal stops the finally BEFORE the fixture rm — the refusal evidence survives.",
    state: {
      ...livePidState(900033, { cmdline: recorderCmdline(), start: START_TS }),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900098)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900033),
    children: [],
    expect: { raisedName: "AssertionError", delivered: [], rmSyncCount: 0, messageIncludes: ["refusing to deliver SIGTERM"] },
    meta: { path: "finally", state: "foreign pidfile", note: "no blind fixture rm after a refusal" },
  },
  {
    id: "finally-recorder-foreign-identity-refuses",
    target: "recorderFinally",
    kind: "finally: pidfile names our pid but the live identity is foreign (other invocation) -> REFUSED; NO fixture rm (evidence preserved)",
    description:
      "the finally finds the pidfile naming our captured pid, but the live process is ANOTHER invocation's recorder (identity mismatch); the ACTUAL stopOwnedRecorder REFUSES and the finally stops BEFORE the fixture rm.",
    state: {
      knownPids: new Set([900034]),
      alive: new Set([900034]),
      cmdline: new Map([[900034, otherInvocationRecorderCmdline()]]),
      start: new Map([[900034, OTHER_START_TS]]),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900034)]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900034),
    children: [],
    expect: { raisedName: "AssertionError", delivered: [], rmSyncCount: 0, messageIncludes: ["refusing to deliver SIGTERM"] },
    meta: { path: "finally", state: "foreign identity", note: "no blind fixture rm after a refusal" },
  },
  {
    id: "finally-startup-error-live-foreign-refuses",
    target: "recorderFinally",
    kind: "finally after a failed start: rec === null with a LIVE unproven pidfile pid -> REFUSED; NO fixture rm (evidence preserved)",
    description:
      "the start failed (no captured handle) but a LIVE process sits on the fixture pidfile; the finally's stopOwnedRecorder (rec === null) can never prove ownership of a live pid -> REFUSED and the finally stops BEFORE the fixture rm: startup failure never blind-cleans a live unproven pid.",
    state: {
      knownPids: new Set([900035]),
      alive: new Set([900035]),
      cmdline: new Map([[900035, otherInvocationRecorderCmdline()]]),
      start: new Map([[900035, OTHER_START_TS]]),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900035)]]),
    },
    fixture: currentFixture(),
    recorder: null,
    children: [],
    expect: { raisedName: "AssertionError", delivered: [], rmSyncCount: 0, messageIncludes: ["refusing to deliver SIGTERM"] },
    meta: { path: "startup-error", state: "live unproven pidfile pid", note: "no blind fixture rm after a refusal" },
  },
  {
    id: "finally-startup-error-dead-pidfile",
    target: "recorderFinally",
    kind: "finally after a failed start: rec === null with a stale DEAD pidfile -> no signal; fixture rm follows",
    description:
      "the start crashed and left a stale pidfile naming a DEAD pid; the finally's stopOwnedRecorder sees dead (nothing live) and issues no signal; the fixture rm follows (the stale pidfile lives inside our own fresh fixture).",
    state: {
      knownPids: new Set([900036]),
      alive: new Set(),
      cmdline: new Map(),
      start: new Map(),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), recorderPidfileEntry(currentFixture(), 900036)]]),
    },
    fixture: currentFixture(),
    recorder: null,
    children: [],
    expect: { raisedName: null, delivered: [], rmSyncCount: 1 },
    meta: { path: "startup-error", state: "stale dead pidfile" },
  },
  {
    id: "finally-nonnumeric-pidfile-refuses",
    target: "recorderFinally",
    kind: "finally: non-numeric recorder pidfile -> REFUSED (unreadable); NO fixture rm (evidence preserved)",
    description:
      "the finally finds a non-numeric pidfile (unreadable/corrupt); no live pid is provable from it, so the ACTUAL stopOwnedRecorder REFUSES and the finally stops BEFORE the fixture rm.",
    state: {
      knownPids: new Set([900037]),
      alive: new Set([900037]),
      cmdline: new Map([[900037, recorderCmdline()]]),
      start: new Map([[900037, START_TS]]),
      termKills: true,
      vfs: new Map([[pidfilePath(currentFixture()), { exists: true, content: "not-a-pid" }]]),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900037),
    children: [],
    expect: { raisedName: "AssertionError", delivered: [], rmSyncCount: 0, messageIncludes: ["refusing to deliver SIGTERM", "unreadable"] },
    meta: { path: "finally", state: "non-numeric pidfile", note: "no blind fixture rm after a refusal" },
  },
  {
    id: "finally-no-pidfile",
    target: "recorderFinally",
    kind: "finally: no leftover pidfile (recorder already stopped) -> no signal; fixture rm follows",
    description: "no pidfile remains (the normal stop removed it); stopOwnedRecorder sees dead and issues no signal; the fixture rm follows.",
    state: {
      knownPids: new Set([900038]),
      alive: new Set([900038]),
      cmdline: new Map([[900038, recorderCmdline()]]),
      start: new Map([[900038, START_TS]]),
      termKills: true,
      vfs: new Map(),
    },
    fixture: currentFixture(),
    recorder: capturedRecorder(900038),
    children: [],
    expect: { raisedName: null, delivered: [], rmSyncCount: 1 },
    meta: { path: "finally", state: "no pidfile (normal completion)" },
  },
];

// ── execute every scenario under the recording bindings ─────────────

interface ScenarioOutcome {
  raisedName?: string;
  raisedMessage?: string;
}

interface ScenarioResult {
  definition: ScenarioDefinition;
  log: RecordedOp[];
  outcome: ScenarioOutcome;
  facts: ScenarioFacts;
  spawned?: ScenarioOwnedChild | null; // spawn scenarios: the returned owned handle
  decision: string; // read back from the recording log + outcome (recorded-only)
}

interface ScenarioFacts {
  deliveredSignals: string[];
  signalAttempts: number;
  psCommandReads: number;
  psStartReads: number;
  spawnCount: number;
  rmSyncCount: number;
  refusalPhase: "TERM" | "KILL" | null;
  refusalVerdict: string | null;
  termDelivered: boolean;
  killDelivered: boolean;
}

/** Derive structured facts purely from the recording log and the outcome. */
function deriveFacts(log: RecordedOp[], outcome: ScenarioOutcome): ScenarioFacts {
  const signalOps = log.filter((e) => e.op === "signal") as Array<RecordedOp & { signal: string; delivered: boolean }>;
  const deliveredSignals = signalOps.filter((s) => s.delivered === true).map((s) => s.signal);
  const termDelivered = deliveredSignals.includes("SIGTERM");
  const killDelivered = deliveredSignals.includes("SIGKILL");
  const refusalMessage = outcome.raisedMessage ?? "";
  const verdictMatch = refusalMessage.match(/current identity verdict "([a-z]+)"/);
  const isSignalRefusal = outcome.raisedName === "AssertionError" && refusalMessage.includes("refusing to deliver");
  return {
    deliveredSignals,
    signalAttempts: signalOps.length,
    psCommandReads: log.filter((e) => e.op === "psCommand").length,
    psStartReads: log.filter((e) => e.op === "psStart").length,
    spawnCount: log.filter((e) => e.op === "spawn").length,
    rmSyncCount: log.filter((e) => e.op === "fs.rmSync").length,
    refusalPhase: isSignalRefusal ? (termDelivered ? "KILL" : "TERM") : null,
    refusalVerdict: verdictMatch === null ? null : verdictMatch[1]!,
    termDelivered,
    killDelivered,
  };
}

/** Run one scenario: fresh vm context, compiled ACTUAL code, recording
 *  bindings only. Returns the full recording log, the outcome and the facts. */
async function runScenario(def: ScenarioDefinition): Promise<ScenarioResult> {
  const bindings = makeRecordingBindings(def.state);
  const sandbox: Record<string, unknown> = {
    assert, // node:assert is pure decision code — it performs no host operation
    pidAlive: bindings.pidAlive,
    psCommand: bindings.psCommand,
    psStart: bindings.psStart,
    sleepSync: bindings.sleepSync,
    process: { kill: bindings.processKill },
    fs: bindings.fsProxy,
    path: { join: bindings.pathJoin },
    children: def.children ?? [],
  };
  if (def.owned !== undefined) sandbox.__owned = def.owned;
  if (def.fixture !== undefined) sandbox.fixture = def.fixture;
  if (def.recorder !== undefined) sandbox.recorder = def.recorder; // recorder-finally uses the test-scoped `recorder` var
  if (def.recorder !== undefined) sandbox.__rec = def.recorder; // recorderStop / recorderNormalStop targets
  vm.createContext(sandbox);

  // The recorder guarded-decision chain, composed from the ACTUAL extracted
  // code: recorderPidfilePath + readRecorderPidfile (fixture pidfile),
  // currentRecorderVerdict + refuseRecorderSignal + stopOwnedRecorder /
  // assertRecorderStopProceeds, over the shared readChildIdentity verdict
  // helpers.
  const recorderChain =
    `${recPidfileCompiled}\n${recReadCompiled}\n${readCompiled}\n${recVerdictCompiled}\n${recRefuseCompiled}\n`;
  const recorderStopChain = `${recorderChain}${recStopCompiled}\n`;
  const recorderPreCheckChain = `${recorderChain}${recPreCheckCompiled}\n`;

  const outcome: ScenarioOutcome = {};
  let spawned: ScenarioOwnedChild | null = null;
  if (def.target === "stopOwnedChild") {
    const script = `${verdictCompiled}\n${readCompiled}\n${refuseCompiled}\n${stopCompiled}\nstopOwnedChild(__owned);`;
    try {
      vm.runInContext(script, sandbox, { timeout: 2000 });
    } catch (err) {
      outcome.raisedName = (err as Error).name;
      outcome.raisedMessage = String((err as Error).message ?? err);
    }
  } else if (def.target === "recorderStop") {
    // The ACTUAL guarded recorder stop (finally leftover + startup-error
    // cleanup decision path): stopOwnedRecorder(__rec, __varRoot).
    if (def.fixture === undefined || def.recorder === undefined) {
      throw new Error(`scenario ${def.id}: recorderStop needs fixture + recorder`);
    }
    sandbox.__varRoot = def.fixture.varRoot;
    const script = `${recorderStopChain}stopOwnedRecorder(__rec, __varRoot);`;
    try {
      vm.runInContext(script, sandbox, { timeout: 2000 });
    } catch (err) {
      outcome.raisedName = (err as Error).name;
      outcome.raisedMessage = String((err as Error).message ?? err);
    }
  } else if (def.target === "recorderNormalStop") {
    // The ACTUAL normal-stop pre-check (before the recorder's own `stop`
    // subcommand may signal the pidfile pid): assertRecorderStopProceeds.
    if (def.fixture === undefined || def.recorder === undefined) {
      throw new Error(`scenario ${def.id}: recorderNormalStop needs fixture + recorder`);
    }
    sandbox.__varRoot = def.fixture.varRoot;
    const script = `${recorderPreCheckChain}assertRecorderStopProceeds(__rec, __varRoot);`;
    try {
      vm.runInContext(script, sandbox, { timeout: 2000 });
    } catch (err) {
      outcome.raisedName = (err as Error).name;
      outcome.raisedMessage = String((err as Error).message ?? err);
    }
  } else if (def.target === "recorderFinally") {
    // recorder-finally: compose the ACTUAL guarded child stop
    // (stopOwnedChild + its decision helpers, for the children loop), the
    // ACTUAL guarded recorder stop chain, and the ACTUAL finally block.
    const script =
      `${verdictCompiled}\n${readCompiled}\n${refuseCompiled}\n${stopCompiled}\n${recorderStopChain}${finallyCompiled}\n` +
      `__actualRecorderFinally();`;
    try {
      vm.runInContext(script, sandbox, { timeout: 2000 });
    } catch (err) {
      outcome.raisedName = (err as Error).name;
      outcome.raisedMessage = String((err as Error).message ?? err);
    }
  } else {
    // spawnOwnedChild: async — the spawn/sleep/settle surface is recorded
    // (spawn returns scripted fake children; sleep resolves immediately).
    if (def.spawn === undefined || def.persistScript === undefined) {
      throw new Error(`scenario ${def.id}: spawnOwnedChild needs spawn + persistScript`);
    }
    sandbox.PERSIST_SCRIPT = def.persistScript;
    sandbox.spawn = bindings.spawn;
    sandbox.sleep = bindings.sleep;
    sandbox.__tok = def.spawn.token;
    sandbox.__cwd = def.spawn.cwd;
    sandbox.__tail = def.spawn.argvTail;
    const script =
      `${verdictCompiled}\n${readCompiled}\n${spawnCompiled}\n` +
      `(async () => { try { __spawned = await spawnOwnedChild(__tok, __cwd, __tail); } ` +
      `catch (e) { __spawnRaised = { name: e.name, message: String(e.message) }; } })();`;
    try {
      const promise = vm.runInContext(script, sandbox, { timeout: 2000 }) as Promise<unknown>;
      await promise;
    } catch (err) {
      outcome.raisedName = (err as Error).name;
      outcome.raisedMessage = String((err as Error).message ?? err);
    }
    const raised = sandbox.__spawnRaised as { name?: string; message?: string } | undefined;
    if (raised !== undefined) {
      outcome.raisedName = raised.name;
      outcome.raisedMessage = raised.message;
    }
    const s = sandbox.__spawned as ScenarioOwnedChild | undefined;
    spawned = s === undefined ? null : s;
  }
  const facts = deriveFacts(bindings.log, outcome);
  return { definition: def, log: bindings.log, outcome, facts, spawned, decision: deriveDecision(def, facts, outcome) };
}

/** Compose a decision string purely from the recorded facts and the outcome
 *  (plus the scenario's static documentation notes) — never from a re-run or
 *  a duplicated expected predicate. */
function deriveDecision(def: ScenarioDefinition, facts: ScenarioFacts, outcome: ScenarioOutcome): string {
  const note = def.meta !== undefined ? Object.values(def.meta).join("; ") : "";
  const noteSuffix = note.length > 0 ? ` [note: ${note}]` : "";
  const delivered = facts.deliveredSignals.join(", ");

  if (def.target === "stopOwnedChild") {
    if (outcome.raisedName === "AssertionError" && facts.refusalPhase === "KILL") {
      return `SIGKILL REFUSED after a delivered SIGTERM: the current identity no longer matches the launch (verdict "${facts.refusalVerdict}" between TERM and KILL) — no KILL, refusal evidence preserved${noteSuffix}`;
    }
    if (outcome.raisedName === "AssertionError") {
      return `signal REFUSED before any delivery: current identity verdict "${facts.refusalVerdict}" is not "owned" — no signal, refusal evidence preserved${noteSuffix}`;
    }
    if (facts.killDelivered) {
      return `owned-positive: identity revalidated (owned) immediately before SIGTERM and AGAIN between TERM and KILL -> SIGTERM then SIGKILL delivered (${delivered})${noteSuffix}`;
    }
    if (facts.termDelivered) {
      return `owned-positive: identity revalidated (owned) immediately before SIGTERM; child dead after TERM -> no SIGKILL (${delivered})${noteSuffix}`;
    }
    return `child not alive at entry (dead verdict) -> no signal, no identity reads past liveness${noteSuffix}`;
  }

  if (def.target === "spawnOwnedChild") {
    if (outcome.raisedName === "AssertionError") {
      return `spawn retries exhausted (${facts.spawnCount} spawns, zero delivered signals): startup failure / exit-before-identity-capture never signals a stale pid — retained attempt evidence raised${noteSuffix}`;
    }
    return `spawned and captured launch identity (cmdline + birth start) on the exact owned handle (${facts.spawnCount} spawn(s), zero signals)${noteSuffix}`;
  }

  if (def.target === "recorderStop") {
    // The ACTUAL guarded recorder stop (finally leftover / startup-error
    // cleanup): mirrors the guarded child stop decision.
    if (outcome.raisedName === "AssertionError" && facts.refusalPhase === "KILL") {
      return `recorder SIGKILL REFUSED after a delivered SIGTERM: the current identity no longer matches the launch (verdict "${facts.refusalVerdict}" between TERM and KILL) — no KILL, refusal evidence preserved${noteSuffix}`;
    }
    if (outcome.raisedName === "AssertionError") {
      return `recorder signal REFUSED before any delivery: current identity verdict "${facts.refusalVerdict}" is not "owned" — no signal, refusal evidence preserved${noteSuffix}`;
    }
    if (facts.killDelivered) {
      return `recorder owned-positive: pidfile + identity revalidated (owned) immediately before SIGTERM and AGAIN between TERM and KILL -> SIGTERM then SIGKILL delivered (${delivered})${noteSuffix}`;
    }
    if (facts.termDelivered) {
      return `recorder owned-positive: pidfile + identity revalidated (owned) immediately before SIGTERM; recorder dead after TERM -> no SIGKILL (${delivered})${noteSuffix}`;
    }
    return `recorder not running under this fixture (dead verdict: no pidfile / dead pid / crashed start) -> no signal${noteSuffix}`;
  }

  if (def.target === "recorderNormalStop") {
    // The ACTUAL normal-stop pre-check before the recorder's own `stop`
    // subcommand may signal the pidfile pid.
    if (outcome.raisedName === "AssertionError") {
      return `normal recorder stop REFUSED (pre-check): current identity verdict "${facts.refusalVerdict}" is not "owned" — the recorder's own stop subcommand is never invoked against an unproven pid, evidence preserved${noteSuffix}`;
    }
    return `normal recorder stop proceeds (verdict owned or dead — no live unproven target); the pre-check itself issues no signal${noteSuffix}`;
  }

  // recorderFinally: child-loop delegation goes through the ACTUAL guarded
  // stopOwnedChild; the recorder leftover cleanup routes through the ACTUAL
  // guarded stopOwnedRecorder (US-003 fixed semantics).
  const childSignals = facts.deliveredSignals.join(", ");
  if (outcome.raisedName === "AssertionError") {
    return `recorder finally REFUSED (verdict "${facts.refusalVerdict}"): no signal to the fixture recorder and NO fixture rm (refusal evidence preserved)${noteSuffix}`;
  }
  if (facts.rmSyncCount === 1 && def.children !== undefined && def.children.length > 0) {
    return `finally child loop delegated to the ACTUAL guarded stopOwnedChild (child signaled: ${childSignals || "none"}, dead after TERM -> no KILL) then fixture rm recorded${noteSuffix}`;
  }
  if (facts.killDelivered) {
    return `recorder finally: owned leftover recorder signaled under revalidated identity (${childSignals}); KILL escalation itself preceded by a fresh pidfile+identity read; fixture rm recorded${noteSuffix}`;
  }
  if (facts.termDelivered) {
    return `recorder finally: owned leftover recorder TERM'd under revalidated identity (${childSignals}); dead after TERM -> no KILL escalation; fixture rm recorded${noteSuffix}`;
  }
  return `recorder finally: no recorder signal (${childSignals || "none"} — no live provable recorder); fixture rm recorded${noteSuffix}`;
}

const scenarioResults: ScenarioResult[] = [];
for (const def of SCENARIOS) {
  // runScenario is async only for spawnOwnedChild; awaited sequentially here
  // (bounded, deterministic order) at module scope.
  scenarioResults.push(await runScenario(def));
}

// ── escape-proof probes (asserted) ──────────────────────────────────

/** A fresh recording context exactly like a decision scenario's, with an
 *  empty process/filesystem table, ready for probe expressions. */
function makeProbeContext(): Record<string, unknown> {
  const bindings = makeRecordingBindings({
    knownPids: new Set(),
    alive: new Set(),
    cmdline: new Map(),
    start: new Map(),
    termKills: true,
    vfs: new Map(),
  });
  const sandbox: Record<string, unknown> = {
    assert,
    pidAlive: bindings.pidAlive,
    psCommand: bindings.psCommand,
    psStart: bindings.psStart,
    sleepSync: bindings.sleepSync,
    process: { kill: bindings.processKill },
    fs: bindings.fsProxy,
    path: { join: bindings.pathJoin },
    spawn: bindings.spawn,
    children: [],
    __log: bindings.log,
  };
  vm.createContext(sandbox);
  return sandbox;
}

interface ProbeResult {
  id: string;
  expression: string;
  what: string;
  raisedName: string | null;
  detail: string;
}

const PROBES: Array<{ id: string; expression: string; what: string }> = [
  {
    id: "P1",
    expression: `fs.unlinkSync("/host/anything")`,
    what: "an unrecorded filesystem op (fs.unlinkSync) must raise before any real removal",
  },
  {
    id: "P2",
    expression: `process.kill(999001, "SIGKILL")`,
    what: "a signal to an unscripted pid must raise before any real signal",
  },
  {
    id: "P3",
    expression: `pidAlive(999002)`,
    what: "a liveness read of an unscripted pid must raise (no live-pid probe possible)",
  },
  {
    id: "P4",
    expression: `spawnSync("ps", ["-p", "1"])`,
    what: "an unrecorded spawn helper must raise (ReferenceError) before any real spawn",
  },
  {
    id: "P5",
    expression: `psCommand(999003)`,
    what: "a ps read of an unscripted pid must raise (no host ps possible)",
  },
  {
    id: "P7",
    expression: `psStart(999004)`,
    what: "a ps birth-start read of an unscripted pid must raise (no host ps possible)",
  },
  {
    id: "P8",
    expression: `spawn("bash", [], {}).kill("SIGKILL")`,
    what: "a raw child.kill on the recorded fake child must raise (unguarded-bypass tripwire)",
  },
];

function runProbes(): ProbeResult[] {
  const out: ProbeResult[] = [];
  for (const p of PROBES) {
    const sandbox = makeProbeContext();
    try {
      vm.runInContext(p.expression, sandbox, { timeout: 1000 });
      out.push({ id: p.id, expression: p.expression, what: p.what, raisedName: null, detail: "did NOT raise — escape proof FAILED" });
    } catch (err) {
      out.push({
        id: p.id,
        expression: p.expression,
        what: p.what,
        raisedName: (err as Error).name,
        detail: String((err as Error).message ?? err).slice(0, 160),
      });
    }
  }
  // P6 runs as an expression evaluation (a throw IS expected: virtual fs -> ENOENT).
  const sandbox6 = makeProbeContext();
  try {
    vm.runInContext(`fs.readFileSync("/proc/self/cmdline")`, sandbox6, { timeout: 1000 });
    out.push({ id: "P6", expression: `fs.readFileSync("/proc/self/cmdline")`, what: "a live-pid/pidfile-style host path read must never reach the host (virtual fs -> ENOENT)", raisedName: null, detail: "did NOT raise — escape proof FAILED" });
  } catch (err) {
    out.push({ id: "P6", expression: `fs.readFileSync("/proc/self/cmdline")`, what: "a live-pid/pidfile-style host path read must never reach the host (virtual fs -> ENOENT)", raisedName: (err as Error).name, detail: String((err as Error).message ?? err).slice(0, 160) });
  }
  return out;
}

const probeResults: ProbeResult[] = runProbes();

// ── the JSON evidence block (printed to stdout for retention) ───────

const evidence = {
  utc: new Date().toISOString(),
  gate: "tier1-rjson-ownership-recording-gate.test.ts (US-003)",
  recordedOnly: true,
  scope:
    "actual AST-extracted emission-test code (child: spawnOwnedChild + currentChildVerdict + readChildIdentity + refuseChildSignal + stopOwnedChild; recorder: recorderPidfilePath + readRecorderPidfile + currentRecorderVerdict + refuseRecorderSignal + stopOwnedRecorder + assertRecorderStopProceeds + captureRecorderIdentity; recorder-finally block) executed in fresh vm contexts under recording bindings; zero real signals/spawns/waits/removals/live-pid reads",
  source: { file: emissionFileName, sha256: sourceSha256 },
  hashPins: {
    sourceSha256: SOURCE_SHA_PIN,
    stopOwnedChildFunctionSha256: STOP_FN_SHA_PIN,
    spawnOwnedChildFunctionSha256: SPAWN_FN_SHA_PIN,
    currentChildVerdictFunctionSha256: VERDICT_FN_SHA_PIN,
    readChildIdentityFunctionSha256: READ_FN_SHA_PIN,
    refuseChildSignalFunctionSha256: REFUSE_FN_SHA_PIN,
    recorderPidfilePathFunctionSha256: REC_PIDFILE_FN_SHA_PIN,
    readRecorderPidfileFunctionSha256: REC_READ_FN_SHA_PIN,
    currentRecorderVerdictFunctionSha256: REC_VERDICT_FN_SHA_PIN,
    refuseRecorderSignalFunctionSha256: REC_REFUSE_FN_SHA_PIN,
    assertRecorderStopProceedsFunctionSha256: REC_PRE_CHECK_FN_SHA_PIN,
    stopOwnedRecorderFunctionSha256: REC_STOP_FN_SHA_PIN,
    captureRecorderIdentityFunctionSha256: REC_CAPTURE_FN_SHA_PIN,
    recorderFinallyBlockSha256: FINALLY_BLOCK_SHA_PIN,
  },
  extracted: {
    spawnOwnedChild: { present: true, functionSha256: spawnFn.sha },
    currentChildVerdict: { present: true, functionSha256: verdictFn.sha },
    readChildIdentity: { present: true, functionSha256: readFn.sha },
    refuseChildSignal: { present: true, functionSha256: refuseFn.sha },
    stopOwnedChild: { present: true, functionSha256: stopFn.sha },
    recorderPidfilePath: { present: true, functionSha256: recPidfileFn.sha },
    readRecorderPidfile: { present: true, functionSha256: recReadFn.sha },
    currentRecorderVerdict: { present: true, functionSha256: recVerdictFn.sha },
    refuseRecorderSignal: { present: true, functionSha256: recRefuseFn.sha },
    assertRecorderStopProceeds: { present: true, functionSha256: recPreCheckFn.sha },
    stopOwnedRecorder: { present: true, functionSha256: recStopFn.sha },
    captureRecorderIdentity: { present: true, functionSha256: recCaptureFn.sha },
    recorderFinally: { present: true, blockSha256: finallyBlockSha256 },
  },
  escapeProof: {
    hermeticSandbox: "typeof require/module/Buffer/process.env/setTimeout/fetch === undefined in the recording context",
    probes: probeResults,
  },
  scenarios: scenarioResults.map((r) => ({
    id: r.definition.id,
    target: r.definition.target,
    kind: r.definition.kind,
    description: r.definition.description,
    decision: r.decision,
    raised: r.outcome.raisedName === undefined ? null : { name: r.outcome.raisedName, message: r.outcome.raisedMessage },
    spawned: r.spawned === null || r.spawned === undefined ? null : { pid: r.spawned.pid, launchCmdline: r.spawned.launchCmdline, launchStart: r.spawned.launchStart },
    facts: r.facts,
    recordedOps: r.log,
    meta: r.definition.meta ?? null,
  })),
  limits: [
    "recorded-only proof: successful recorded cleanup is NOT proof a real child/recorder was collected",
    "the full emission test file and self-tests/run.sh were NOT executed in this run (independent-execution boundary; coordinator owns real Linux emission acceptance and actual Mac applicable checks after this recording proof is accepted)",
    "fixed child-ownership (US-002) AND fixed recorder-ownership (US-003) semantics are ASSERTED on the ACTUAL extracted code under recordings",
    "the recorder's own `stop` subcommand, discovery/escaping and emitted-data semantics are UNCHANGED and out of scope (torture-test/bin/tt-recorder untouched): the emission test guards the decision to invoke the stop subcommand (normal-stop pre-check) and performs its own guarded direct stop in the finally; the subcommand's internal TERM/KILL window remains the recorder's own (unchanged) semantics",
  ],
};

const evidenceLine = `RJSON-OWNERSHIP-GATE-EVIDENCE ${JSON.stringify(evidence)}`;
console.log(evidenceLine);
let evidencePrinted = true;

// ── assertions (the gate) ───────────────────────────────────────────

describe("RJSON US-003 — recording-only ownership gate (fixed child- AND recorder-ownership semantics on the ACTUAL emission-test code)", () => {
  it("extracts the ACTUAL child- and recorder-ownership code from the live emission test and pins every hash", () => {
    // Extraction itself runs at module scope with hard asserts; re-assert the
    // observable artifacts here so a missing/moved target fails this test
    // with a clear message.
    assert.equal(SCENARIOS.length >= 40, true, "scenario matrix must stay populated");
    assert.ok(stopFn.source.includes("stopOwnedChild"), "stopOwnedChild extracted text missing");
    assert.ok(spawnFn.source.includes("spawnOwnedChild"), "spawnOwnedChild extracted text missing");
    assert.ok(verdictFn.source.includes("currentChildVerdict"), "currentChildVerdict extracted text missing");
    assert.ok(readFn.source.includes("readChildIdentity"), "readChildIdentity extracted text missing");
    assert.ok(finallyBlockSource.includes("stopOwnedRecorder("), "recorder-finally extracted text missing (must route through stopOwnedRecorder)");
    assert.ok(recVerdictFn.source.includes("currentRecorderVerdict"), "currentRecorderVerdict extracted text missing");
    assert.ok(recStopFn.source.includes("stopOwnedRecorder"), "stopOwnedRecorder extracted text missing");
    assert.ok(recPreCheckFn.source.includes("assertRecorderStopProceeds"), "assertRecorderStopProceeds extracted text missing");
    assert.ok(recCaptureFn.source.includes("captureRecorderIdentity"), "captureRecorderIdentity extracted text missing");
    assert.equal(sourceSha256, SOURCE_SHA_PIN, "emission source sha256 must match the US-003-pinned hash");
    assert.equal(stopFn.sha, STOP_FN_SHA_PIN, "stopOwnedChild function sha256 must match the US-002-pinned hash");
    assert.equal(spawnFn.sha, SPAWN_FN_SHA_PIN, "spawnOwnedChild function sha256 must match the US-002-pinned hash");
    assert.equal(verdictFn.sha, VERDICT_FN_SHA_PIN, "currentChildVerdict function sha256 must match the US-002-pinned hash");
    assert.equal(readFn.sha, READ_FN_SHA_PIN, "readChildIdentity function sha256 must match the US-002-pinned hash");
    assert.equal(refuseFn.sha, REFUSE_FN_SHA_PIN, "refuseChildSignal function sha256 must match the US-002-pinned hash");
    assert.equal(recPidfileFn.sha, REC_PIDFILE_FN_SHA_PIN, "recorderPidfilePath function sha256 must match the US-003-pinned hash");
    assert.equal(recReadFn.sha, REC_READ_FN_SHA_PIN, "readRecorderPidfile function sha256 must match the US-003-pinned hash");
    assert.equal(recVerdictFn.sha, REC_VERDICT_FN_SHA_PIN, "currentRecorderVerdict function sha256 must match the US-003-pinned hash");
    assert.equal(recRefuseFn.sha, REC_REFUSE_FN_SHA_PIN, "refuseRecorderSignal function sha256 must match the US-003-pinned hash");
    assert.equal(recPreCheckFn.sha, REC_PRE_CHECK_FN_SHA_PIN, "assertRecorderStopProceeds function sha256 must match the US-003-pinned hash");
    assert.equal(recStopFn.sha, REC_STOP_FN_SHA_PIN, "stopOwnedRecorder function sha256 must match the US-003-pinned hash");
    assert.equal(recCaptureFn.sha, REC_CAPTURE_FN_SHA_PIN, "captureRecorderIdentity function sha256 must match the US-003-pinned hash");
    assert.equal(finallyBlockSha256, FINALLY_BLOCK_SHA_PIN, "recorder-finally block sha256 must match the US-003-re-pinned hash");
  });

  it("asserts the FIXED child-ownership semantics on the ACTUAL code: owned-positive TERM/KILL and every refusal (recorded-only)", () => {
    for (const r of scenarioResults) {
      const id = r.definition.id;
      // Mechanism: the ACTUAL code executed under recordings — it must never
      // raise an EscapeError (unscripted op) or a ReferenceError/TypeError
      // (missing helper => code drifted past the recorded surface). An
      // AssertionError is the fixed code's own guarded refusal/exhaustion
      // path, asserted per-scenario below.
      const raised = r.outcome.raisedName;
      assert.ok(
        raised === undefined || raised === "AssertionError",
        `scenario ${id}: extracted code raised ${raised} (${String(r.outcome.raisedMessage)}) — code drifted or escaped the recordings`,
      );
      // Every recorded op is from the allowed recorded set (nothing else can
      // have happened: the bindings are the only route to any operation).
      for (const op of r.log) {
        assert.ok(ALLOWED_OPS.has(op.op), `scenario ${id}: unexpected recorded op ${op.op}`);
      }
      // Decision read-back: each scenario decision must be a non-empty string
      // derived from its own recording log, and must match what the evidence
      // block carries (stdout evidence === recorded decisions).
      assert.ok(r.decision.length > 0, `scenario ${id}: decision must be read back from the log`);
      const ev = evidence.scenarios.find((s) => s.id === id);
      assert.ok(ev !== undefined, `scenario ${id}: missing from the JSON evidence block`);
      assert.equal(ev.decision, r.decision, `scenario ${id}: evidence decision must equal the recorded decision`);
      assert.deepEqual(ev.facts, r.facts, `scenario ${id}: evidence facts must equal the recorded facts`);
      assert.deepEqual(ev.recordedOps, r.log, `scenario ${id}: evidence recordedOps must equal the recording log`);

      // ── fixed-semantics expectations ──
      const exp = r.definition.expect;
      assert.equal(
        r.outcome.raisedName === undefined ? null : r.outcome.raisedName,
        exp.raisedName,
        `scenario ${id}: raisedName mismatch (message: ${String(r.outcome.raisedMessage)})`,
      );
      assert.deepEqual(r.facts.deliveredSignals, exp.delivered, `scenario ${id}: delivered signal sequence mismatch`);
      if (exp.refusalPhase !== undefined) {
        assert.equal(r.facts.refusalPhase, exp.refusalPhase, `scenario ${id}: refusal phase mismatch`);
        assert.equal(r.facts.signalAttempts, exp.delivered.length, `scenario ${id}: a refusal must add no undelivered signal attempt`);
      }
      for (const needle of exp.messageIncludes ?? []) {
        assert.ok(
          (r.outcome.raisedMessage ?? "").includes(needle),
          `scenario ${id}: raised message must include ${JSON.stringify(needle)} (got ${JSON.stringify(r.outcome.raisedMessage)})`,
        );
      }
      if (exp.spawnCount !== undefined) assert.equal(r.facts.spawnCount, exp.spawnCount, `scenario ${id}: spawn count mismatch`);
      if (exp.rmSyncCount !== undefined) assert.equal(r.facts.rmSyncCount, exp.rmSyncCount, `scenario ${id}: rmSync count mismatch`);
      if (exp.capturedPid !== undefined) {
        assert.ok(r.spawned !== null && r.spawned !== undefined, `scenario ${id}: an owned handle must be returned`);
        assert.equal(r.spawned.pid, exp.capturedPid, `scenario ${id}: captured handle pid mismatch`);
        assert.ok(r.spawned.launchCmdline !== "" && r.spawned.launchStart !== "", `scenario ${id}: launch identity must be captured on the handle`);
      }
    }

    // ── AC1: owned-positive cleanup — TERM only after a revalidated owned
    // verdict; dead-after-TERM -> no KILL; alive-with-matching-identity after
    // TERM -> KILL that is itself preceded by revalidation. ──
    const termDead = scenarioResults.find((r) => r.definition.id === "stop-owned-term-then-dead")!;
    const termIdx = termDead.log.findIndex((e) => e.op === "signal" && e.delivered === true);
    assert.ok(termIdx >= 3, "term-then-dead: TERM must be delivered after the entry identity read");
    assert.deepEqual(
      termDead.log.slice(termIdx - 3, termIdx).map((e) => e.op),
      ["pidAlive", "psCommand", "psStart"],
      "term-then-dead: the ops immediately before TERM must be the current-identity read (liveness + cmdline + birth start)",
    );
    assert.equal(termDead.facts.killDelivered, false, "term-then-dead: a dead-after-TERM child must get NO KILL");

    const termKill = scenarioResults.find((r) => r.definition.id === "stop-owned-alive-term-then-kill")!;
    const termKillIdx = termKill.log.findIndex((e) => e.op === "signal" && e.signal === "SIGTERM" && e.delivered === true);
    const killIdx = termKill.log.findIndex((e) => e.op === "signal" && e.signal === "SIGKILL" && e.delivered === true);
    assert.ok(termKillIdx >= 0 && killIdx > termKillIdx, "alive-term-then-kill: TERM then KILL must both be delivered in order");
    assert.deepEqual(
      termKill.log.slice(killIdx - 3, killIdx).map((e) => e.op),
      ["pidAlive", "psCommand", "psStart"],
      "alive-term-then-kill: the ops immediately before KILL must be a FRESH current-identity read (revalidation between TERM and KILL)",
    );

    // ── AC2: refusals — each refuses the signal and preserves evidence; the
    // gate issues no real signal in any refusal scenario (no undelivered
    // signal attempts either). ──
    const refusalIds = [
      "stop-pid-reuse-between-term-and-kill",
      "stop-other-invocation-same-names",
      "stop-changed-identity",
      "stop-unreadable-identity",
      "stop-foreign-pid",
      "stop-never-captured-handle",
      "stop-sibling-fixture-prefix",
    ];
    for (const id of refusalIds) {
      const r = scenarioResults.find((s) => s.definition.id === id)!;
      assert.equal(r.outcome.raisedName, "AssertionError", `${id}: refusal must raise`);
      assert.equal(r.facts.signalAttempts, r.facts.deliveredSignals.length, `${id}: a refusal must never attempt an unproven signal`);
      assert.ok(r.facts.refusalVerdict !== null, `${id}: refusal message must carry the verdict`);
    }
    // The pid-reuse case DID deliver TERM (proven owned first) but must refuse
    // the KILL and never deliver it.
    const reuse = scenarioResults.find((r) => r.definition.id === "stop-pid-reuse-between-term-and-kill")!;
    assert.deepEqual(reuse.facts.deliveredSignals, ["SIGTERM"], "pid-reuse: TERM delivered under owned verdict");
    assert.equal(reuse.facts.killDelivered, false, "pid-reuse: KILL must be REFUSED when identity changed between TERM and KILL");
    assert.equal(reuse.facts.refusalPhase, "KILL", "pid-reuse: refusal must happen at the KILL revalidation");
    for (const id of ["stop-other-invocation-same-names", "stop-changed-identity", "stop-unreadable-identity", "stop-foreign-pid", "stop-never-captured-handle", "stop-sibling-fixture-prefix"]) {
      const r = scenarioResults.find((s) => s.definition.id === id)!;
      assert.deepEqual(r.facts.deliveredSignals, [], `${id}: refusal before TERM must deliver zero signals`);
    }

    // ── AC3: startup failure / exit-before-identity-capture never signals a
    // stale pid: unverifiable children are treated as dead with evidence
    // recorded (assert.fail after retries, zero signals). ──
    const startup = scenarioResults.find((r) => r.definition.id === "spawn-startup-failure")!;
    assert.equal(startup.facts.spawnCount, 5, "startup-failure: 5 retry attempts");
    assert.equal(startup.facts.deliveredSignals.length, 0, "startup-failure: zero signals to a stale pid");
    assert.equal(startup.outcome.raisedName, "AssertionError", "startup-failure: retries exhausted -> loud failure with evidence");
    assert.ok((startup.outcome.raisedMessage ?? "").includes("guarded verdict=dead"), "startup-failure: each rejected attempt records the guarded dead verdict");
    const noPid = scenarioResults.find((r) => r.definition.id === "spawn-no-pid-exhausted")!;
    assert.equal(noPid.facts.deliveredSignals.length, 0, "spawn-no-pid: zero signals");
    assert.equal(noPid.outcome.raisedName, "AssertionError", "spawn-no-pid: retries exhausted loudly");

    // ── AC4: every child decision path routes through the same guarded
    // decision — normal stop (above), failed-start/spawn-retry disposal
    // (spawn scenarios above + reuse recovery), and the finally child loop
    // delegation through the ACTUAL stopOwnedChild. ──
    const delegation = scenarioResults.find((r) => r.definition.id === "finally-children-delegation-owned")!;
    assert.equal(delegation.outcome.raisedName, undefined, "finally delegation: owned child stopped cleanly");
    assert.deepEqual(delegation.facts.deliveredSignals, ["SIGTERM"], "finally delegation: child TERM'd under owned verdict");
    assert.equal(delegation.facts.killDelivered, false, "finally delegation: dead after TERM -> no KILL");
    assert.equal(delegation.facts.rmSyncCount, 1, "finally delegation: fixture rm recorded after the child loop");

    // ── owned-positive spawn captures launch identity on the handle. ──
    const captured = scenarioResults.find((r) => r.definition.id === "spawn-owned-captured")!;
    assert.ok(captured.spawned !== null, "spawn-owned-captured: handle returned");
    assert.equal(captured.spawned!.launchCmdline, childCmdline("marker-tail"), "spawn-owned-captured: launch cmdline captured");
    assert.equal(captured.spawned!.launchStart, START_TS, "spawn-owned-captured: birth start captured");
    assert.equal(captured.facts.deliveredSignals.length, 0, "spawn-owned-captured: no signal at spawn");
    // Reuse recovery: first attempt refused (foreign), retry captured the
    // owned launch — zero signals end to end.
    const recovery = scenarioResults.find((r) => r.definition.id === "spawn-reuse-recovery")!;
    assert.ok(recovery.spawned !== null, "spawn-reuse-recovery: retry recovers an owned handle");
    assert.equal(recovery.spawned!.pid, 800202, "spawn-reuse-recovery: captured pid is the second (owned) spawn");
    assert.equal(recovery.facts.spawnCount, 2, "spawn-reuse-recovery: first attempt rejected, second captured");
    assert.equal(recovery.facts.deliveredSignals.length, 0, "spawn-reuse-recovery: zero signals");
  });

  it("asserts the FIXED recorder-ownership semantics on the ACTUAL code: owned-positive TERM/KILL with pidfile+identity revalidation, every refusal across the normal-stop / startup-error / finally decision paths (recorded-only)", () => {
    // ── AC1: recorder cleanup accepts signals only when the CURRENT identity
    // (pidfile content + liveness + cmdline + birth start) matches the
    // captured recorder identity, revalidated before EACH signal. TERM must
    // be preceded by a fresh pidfile read + identity read. ──
    const recTermDead = scenarioResults.find((r) => r.definition.id === "recorder-owned-term-then-dead")!;
    const recTermIdx = recTermDead.log.findIndex((e) => e.op === "signal" && e.delivered === true);
    assert.ok(recTermIdx >= 5, "recorder-term-then-dead: TERM must be delivered after the pidfile + identity revalidation");
    assert.deepEqual(
      recTermDead.log.slice(recTermIdx - 5, recTermIdx).map((e) => e.op),
      ["fs.existsSync", "fs.readFileSync", "pidAlive", "psCommand", "psStart"],
      "recorder-term-then-dead: the ops immediately before TERM must be the current-identity read (pidfile content + liveness + cmdline + birth start)",
    );
    assert.equal(recTermDead.facts.killDelivered, false, "recorder-term-then-dead: a dead-after-TERM recorder must get NO KILL");

    const recTermKill = scenarioResults.find((r) => r.definition.id === "recorder-owned-term-then-kill")!;
    const recKillIdx = recTermKill.log.findIndex((e) => e.op === "signal" && e.signal === "SIGKILL" && e.delivered === true);
    assert.ok(recKillIdx >= 0, "recorder-term-then-kill: KILL must be delivered");
    assert.deepEqual(
      recTermKill.log.slice(recKillIdx - 5, recKillIdx).map((e) => e.op),
      ["fs.existsSync", "fs.readFileSync", "pidAlive", "psCommand", "psStart"],
      "recorder-term-then-kill: the ops immediately before KILL must be a FRESH pidfile + identity read (revalidation between TERM and KILL)",
    );

    // ── AC2: refusals (each refuses the signal, preserves evidence, and the
    // gate issues no real signal: no undelivered signal attempts). ──
    const recorderRefusalIds = [
      "recorder-pid-reuse-between-term-and-kill",
      "recorder-other-invocation-same-names",
      "recorder-changed-identity",
      "recorder-unreadable-identity",
      "recorder-foreign-pid",
      "recorder-stale-foreign-pidfile",
      "recorder-pidfile-nonnumeric",
      "recorder-never-captured-handle",
      "recorder-sibling-fixture-prefix",
      "recorder-startup-error-live-foreign",
      "recorder-normal-other-invocation-refuses",
      "recorder-normal-stale-pidfile-refuses",
      "recorder-normal-unreadable-refuses",
      "recorder-normal-changed-refuses",
    ];
    for (const id of recorderRefusalIds) {
      const r = scenarioResults.find((s) => s.definition.id === id)!;
      assert.equal(r.outcome.raisedName, "AssertionError", `${id}: recorder refusal must raise`);
      assert.equal(r.facts.signalAttempts, r.facts.deliveredSignals.length, `${id}: a recorder refusal must never attempt an unproven signal`);
      assert.ok(r.facts.refusalVerdict !== null, `${id}: recorder refusal message must carry the verdict`);
      assert.ok((r.outcome.raisedMessage ?? "").includes("refusing to deliver"), `${id}: recorder refusal message must name the refused signal`);
    }
    // Identity lost between TERM and KILL (pid reuse): TERM was delivered
    // under an owned verdict, but the KILL must be refused.
    const recReuse = scenarioResults.find((r) => r.definition.id === "recorder-pid-reuse-between-term-and-kill")!;
    assert.deepEqual(recReuse.facts.deliveredSignals, ["SIGTERM"], "recorder-pid-reuse: TERM delivered under owned verdict");
    assert.equal(recReuse.facts.killDelivered, false, "recorder-pid-reuse: KILL must be REFUSED when identity changed between TERM and KILL");
    assert.equal(recReuse.facts.refusalPhase, "KILL", "recorder-pid-reuse: refusal must happen at the KILL revalidation");
    for (const id of [
      "recorder-other-invocation-same-names",
      "recorder-changed-identity",
      "recorder-unreadable-identity",
      "recorder-foreign-pid",
      "recorder-stale-foreign-pidfile",
      "recorder-pidfile-nonnumeric",
      "recorder-never-captured-handle",
      "recorder-sibling-fixture-prefix",
      "recorder-startup-error-live-foreign",
      "recorder-normal-other-invocation-refuses",
      "recorder-normal-stale-pidfile-refuses",
      "recorder-normal-unreadable-refuses",
      "recorder-normal-changed-refuses",
    ]) {
      const r = scenarioResults.find((s) => s.definition.id === id)!;
      assert.deepEqual(r.facts.deliveredSignals, [], `${id}: refusal must deliver zero signals`);
    }
    // Non-numeric and stale/foreign pidfile and unreadable identity must name
    // the unreadable/foreign verdict in the refusal context.
    for (const id of ["recorder-pidfile-nonnumeric", "recorder-unreadable-identity", "recorder-normal-unreadable-refuses"]) {
      const r = scenarioResults.find((s) => s.definition.id === id)!;
      assert.ok((r.outcome.raisedMessage ?? "").includes("unreadable"), `${id}: refusal must carry the unreadable verdict context`);
    }

    // ── AC3: normal-stop, startup-error and finally decision paths each route
    // through the same guarded revalidating decision on the ACTUAL code. ──
    // Normal-stop path (assertRecorderStopProceeds): owned/dead proceed; any
    // stale/foreign/unreadable/changed state refuses.
    const normalOwned = scenarioResults.find((r) => r.definition.id === "recorder-normal-owned-proceeds")!;
    assert.equal(normalOwned.outcome.raisedName, undefined, "normal-owned: an owned recorder proceeds through the normal-stop pre-check");
    assert.equal(normalOwned.facts.deliveredSignals.length, 0, "normal-owned: the pre-check itself issues no signal");
    const normalDead = scenarioResults.find((r) => r.definition.id === "recorder-normal-dead-proceeds")!;
    assert.equal(normalDead.outcome.raisedName, undefined, "normal-dead: a dead recorder (no live target) proceeds");
    // Startup-error path (rec === null, stopOwnedRecorder): dead states
    // produce no signal; a live unproven pid refuses.
    for (const id of ["recorder-startup-error-dead-pidfile", "recorder-startup-error-no-pidfile"]) {
      const r = scenarioResults.find((s) => s.definition.id === id)!;
      assert.equal(r.outcome.raisedName, undefined, `${id}: startup failure with nothing live -> no refusal`);
      assert.equal(r.facts.deliveredSignals.length, 0, `${id}: startup failure never signals a stale pid`);
    }
    const startupLive = scenarioResults.find((r) => r.definition.id === "recorder-startup-error-live-foreign")!;
    assert.equal(startupLive.outcome.raisedName, "AssertionError", "startup-error-live-foreign: a live unproven pid refuses");
    assert.equal(startupLive.facts.deliveredSignals.length, 0, "startup-error-live-foreign: zero signals to an unproven pid");

    // ── AC4: the finally leftover cleanup routes through the ACTUAL guarded
    // stopOwnedRecorder and a refusal stops the finally BEFORE the fixture rm
    // (no blind fixture rm; refusal evidence preserved). ──
    const finOwned = scenarioResults.find((r) => r.definition.id === "finally-recorder-owned-leftover-stopped")!;
    assert.equal(finOwned.outcome.raisedName, undefined, "finally-owned-leftover: owned leftover recorder stopped cleanly");
    assert.deepEqual(finOwned.facts.deliveredSignals, ["SIGTERM"], "finally-owned-leftover: TERM under owned verdict");
    assert.equal(finOwned.facts.killDelivered, false, "finally-owned-leftover: dead after TERM -> no KILL");
    assert.equal(finOwned.facts.rmSyncCount, 1, "finally-owned-leftover: fixture rm follows the clean stop");
    const finKill = scenarioResults.find((r) => r.definition.id === "finally-recorder-owned-kill-escalation")!;
    assert.deepEqual(finKill.facts.deliveredSignals, ["SIGTERM", "SIGKILL"], "finally-kill-escalation: TERM then KILL under revalidated identity");
    assert.equal(finKill.facts.rmSyncCount, 1, "finally-kill-escalation: fixture rm follows");
    const finKillIdx = finKill.log.findIndex((e) => e.op === "signal" && e.signal === "SIGKILL" && e.delivered === true);
    assert.deepEqual(
      finKill.log.slice(finKillIdx - 5, finKillIdx).map((e) => e.op),
      ["fs.existsSync", "fs.readFileSync", "pidAlive", "psCommand", "psStart"],
      "finally-kill-escalation: the KILL inside the finally is preceded by a FRESH pidfile + identity read (revalidation between TERM and KILL)",
    );
    for (const id of [
      "finally-recorder-foreign-pidfile-refuses",
      "finally-recorder-foreign-identity-refuses",
      "finally-startup-error-live-foreign-refuses",
      "finally-nonnumeric-pidfile-refuses",
    ]) {
      const r = scenarioResults.find((s) => s.definition.id === id)!;
      assert.equal(r.outcome.raisedName, "AssertionError", `${id}: finally recorder refusal must raise`);
      assert.equal(r.facts.deliveredSignals.length, 0, `${id}: finally refusal issues no real signal`);
      assert.equal(r.facts.rmSyncCount, 0, `${id}: a finally refusal must stop BEFORE the fixture rm (no blind rm, evidence preserved)`);
    }
    for (const id of ["finally-startup-error-dead-pidfile", "finally-no-pidfile"]) {
      const r = scenarioResults.find((s) => s.definition.id === id)!;
      assert.equal(r.outcome.raisedName, undefined, `${id}: nothing live -> no refusal`);
      assert.equal(r.facts.deliveredSignals.length, 0, `${id}: no signal`);
      assert.equal(r.facts.rmSyncCount, 1, `${id}: fixture rm follows`);
    }

    // ── the finally child loop still delegates to the ACTUAL guarded
    // stopOwnedChild while the recorder cleanup routes through the ACTUAL
    // guarded stopOwnedRecorder. ──
    const finChild = scenarioResults.find((r) => r.definition.id === "finally-children-delegation-owned")!;
    assert.equal(finChild.outcome.raisedName, undefined, "finally-delegation: owned child stopped cleanly through the ACTUAL stopOwnedChild");
    assert.deepEqual(finChild.facts.deliveredSignals, ["SIGTERM"], "finally-delegation: child TERM'd under owned verdict");
    assert.equal(finChild.facts.rmSyncCount, 1, "finally-delegation: fixture rm recorded after child loop + no-pidfile recorder cleanup");
  });

  it("escape proof: hermetic sandbox and unscripted/unknown op requests raise before any real operation", () => {
    // (a) The recording context is hermetic: no Node/host capability is
    // reachable, and the sandbox's process/fs are the recording bindings.
    const sandbox = makeProbeContext();
    for (const probe of ["require", "module", "Buffer", "process.env", "setTimeout", "fetch", "spawnSync", "child_process"]) {
      assert.equal(
        vm.runInContext(`typeof ${probe}`, sandbox),
        "undefined",
        `recording context must not expose host capability '${probe}'`,
      );
    }
    // Even a Function-constructor escape attempt cannot reach the host.
    assert.equal(
      vm.runInContext(`(function(){ return this.constructor.constructor("return typeof require")(); })()`, sandbox),
      "undefined",
      "Function-constructor escape must not reach the host require",
    );
    // The sandbox process/fs are NOT the host objects.
    const recProcess = sandbox.process as { kill: unknown };
    assert.notEqual(recProcess, process, "recording process must not be the host process object");
    assert.notEqual(recProcess.kill, process.kill, "recording kill must not be the host process.kill");
    // (b) Each unscripted/unknown op request raised before any real op.
    for (const p of probeResults) {
      // P4 raises ReferenceError (unrecorded spawn helper absent from the
      // sandbox); P6 raises fs ENOENT from the VIRTUAL filesystem (the read
      // never reaches the host); everything else raises the fail-closed
      // EscapeError of the recording bindings.
      const expected = p.id === "P4" ? "ReferenceError" : p.id === "P6" ? "Error" : "EscapeError";
      assert.equal(p.raisedName, expected, `probe ${p.id} (${p.expression}): ${p.detail}`);
      if (p.id === "P6") {
        assert.match(p.detail, /ENOENT/, `probe P6 must raise ENOENT from the virtual fs, got: ${p.detail}`);
      }
    }
    // (c) No decision scenario ever requested an unscripted op (implicit in
    // the assertion above), and the recording harness performed zero real
    // process signals / filesystem removals / waits: every op in every log
    // is recorded, and the only host fs calls the gate itself makes are the
    // sanctioned source read above (the gate never imports child_process and
    // never calls a host removal/spawn/signal).
    const ownSource = fs.readFileSync(new URL(import.meta.url), "utf8");
    const importSpecifiers = [...ownSource.matchAll(/^\s*import\b[\s\S]*?\bfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    assert.ok(
      !importSpecifiers.includes("node:child_process") && !importSpecifiers.some((s) => s.includes("child_process")),
      `the gate itself must never import child_process (imports: ${importSpecifiers.join(", ")})`,
    );
    const everyOpRecorded = scenarioResults.every((r) => r.log.every((op) => ALLOWED_OPS.has(op.op)));
    assert.equal(everyOpRecorded, true, "all scenario operations must be recorded ops");
    // (d) No scenario ever delivered or attempted a real (host) signal: all
    // recorded pids are synthetic (7xxxxx/8xxxxx) scripted processes and the
    // only signal ops are recorded ones.
    const anyRealSignal = scenarioResults.some((r) => r.log.some((op) => op.op === "signal" && (op.pid as number) < 700000));
    assert.equal(anyRealSignal, false, "no scenario may reference a non-synthetic pid");
  });

  it("emits the JSON evidence block on stdout with source/function/block sha256 hashes and per-case outcomes", () => {
    // The evidence line was printed at module scope (retained on stdout for
    // the run log); assert the in-memory evidence object is complete,
    // round-trips through JSON, and carries every required field.
    assert.equal(evidencePrinted, true, "evidence block must be printed at module scope");
    const roundTripped = JSON.parse(JSON.stringify(evidence));
    assert.equal(roundTripped.source.sha256, sourceSha256);
    assert.equal(roundTripped.extracted.stopOwnedChild.functionSha256, stopFn.sha);
    assert.equal(roundTripped.extracted.spawnOwnedChild.functionSha256, spawnFn.sha);
    assert.equal(roundTripped.extracted.currentChildVerdict.functionSha256, verdictFn.sha);
    assert.equal(roundTripped.extracted.readChildIdentity.functionSha256, readFn.sha);
    assert.equal(roundTripped.extracted.recorderPidfilePath.functionSha256, recPidfileFn.sha);
    assert.equal(roundTripped.extracted.readRecorderPidfile.functionSha256, recReadFn.sha);
    assert.equal(roundTripped.extracted.currentRecorderVerdict.functionSha256, recVerdictFn.sha);
    assert.equal(roundTripped.extracted.refuseRecorderSignal.functionSha256, recRefuseFn.sha);
    assert.equal(roundTripped.extracted.assertRecorderStopProceeds.functionSha256, recPreCheckFn.sha);
    assert.equal(roundTripped.extracted.stopOwnedRecorder.functionSha256, recStopFn.sha);
    assert.equal(roundTripped.extracted.captureRecorderIdentity.functionSha256, recCaptureFn.sha);
    assert.equal(roundTripped.extracted.recorderFinally.blockSha256, finallyBlockSha256);
    assert.equal(roundTripped.hashPins.sourceSha256, SOURCE_SHA_PIN);
    assert.equal(roundTripped.hashPins.stopOwnedRecorderFunctionSha256, REC_STOP_FN_SHA_PIN);
    assert.equal(roundTripped.hashPins.currentRecorderVerdictFunctionSha256, REC_VERDICT_FN_SHA_PIN);
    assert.equal(roundTripped.hashPins.recorderFinallyBlockSha256, FINALLY_BLOCK_SHA_PIN);
    assert.ok(Array.isArray(roundTripped.scenarios) && roundTripped.scenarios.length === SCENARIOS.length);
    for (const s of roundTripped.scenarios) {
      assert.ok(typeof s.id === "string" && s.id.length > 0);
      assert.ok(typeof s.decision === "string" && s.decision.length > 0);
      assert.ok(Array.isArray(s.recordedOps));
      assert.ok(s.raised === null || typeof s.raised.name === "string");
      assert.ok(typeof s.facts.deliveredSignals.length === "number");
    }
    assert.ok(Array.isArray(roundTripped.escapeProof.probes) && roundTripped.escapeProof.probes.length >= 6);
    assert.ok(Array.isArray(roundTripped.limits) && roundTripped.limits.length >= 4);
    assert.equal(roundTripped.scenarios.filter((s: { meta: { path?: string } | null }) => s.meta?.path === "normal-stop").length >= 5, true, "normal-stop decision-path scenarios must be present");
    assert.equal(roundTripped.scenarios.filter((s: { meta: { path?: string } | null }) => s.meta?.path === "startup-error").length >= 4, true, "startup-error decision-path scenarios must be present");
    assert.equal(roundTripped.scenarios.filter((s: { meta: { path?: string } | null }) => s.meta?.path === "finally").length >= 8, true, "finally decision-path scenarios must be present");
    // The printed stdout line must be the exact serialization of `evidence`
    // (so retained stdout can be parsed back into this object).
    assert.equal(evidenceLine, `RJSON-OWNERSHIP-GATE-EVIDENCE ${JSON.stringify(evidence)}`);
  });
});
