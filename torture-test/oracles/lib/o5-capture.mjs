#!/usr/bin/env node
// o5-capture.mjs — bounded read-only OS snapshot recorder for the O5 process
// & port census (STORM-HYGIENE: "Input recorders may gather bounded read-only
// OS snapshots from explicit allowed scope").
//
// This module is the RECORDER side of the O5 split: the O5 evaluator
// (lib/o5.mjs) is strictly read-only over the captured snapshots and NEVER
// kills/reaps/cleans; this module gathers the snapshots, but ONLY inside the
// explicitly allowed scope passed by the caller (exact pids/pgids/ports that
// the caller owns or the host-admitted census admits). It never scans
// credentials or environment text (kernel-hidden on Darwin; forbidden here on
// every host), never walks the procfs tree broadly, and redacts/bounds every public
// cmdline field it records. Darwin: no env inspection — rows are recorded
// from the weaker ps/lsof evidence layers with the same identity/state fields
// the tt-process-identity seam provides.
//
// Evidence sources:
//   * process identity/group/state/cwd/cmdline — tt-process-identity.mjs
//     (portable procfs on linux, ps/lsof on procfs-less hosts; already
//     allowlisted for procfs use). Never reads another process's environ file.
//   * listener census — `lsof -nP -iTCP:<port> -sTCP:LISTEN` (or the seam).
//   * cgroup membership (linux, layer 1) — `ps -o cgroup=` (no direct
//     procfs access here; procps supports the cgroup output keyword; on
//     procfs-less hosts ps has no cgroup keyword and the row field is null).
//
// Listener-census capture contract (strengthened after the root capture probe,
// o5-o6-root-capture-probe-20260909):
//   * STRICT COMPLETE PREFLIGHT of every input BEFORE any tool call: ports
//     must be finite safe integers in 1..65535. Ranges ('1-65535'), strings,
//     floats, zero/negative values and broad selectors are REJECTED with NO
//     tool call; the returned inventory is mechanically non-success (tool
//     exit_code 2, preflight_rejected true, bounded diagnostics).
//   * The lsof -F output framing is VALIDATED, not skimmed: every field line
//     must carry a single-letter -F code, every pid must be a positive
//     integer, and every address/port name record must parse AND name the
//     requested port. exit 0 with no complete pid/address/port record,
//     unparseable/unframed lines, or an exit-1 payload that is anything other
//     than empty stdout+empty stderr are mechanically NON-SUCCESS with bounded
//     diagnostics — NEVER a complete empty census.
//   * Clean no-match is DISTINGUISHED from tool failure: lsof exit 1 with
//     EMPTY stdout AND EMPTY stderr is the positive absence observation
//     (release evidence) and normalizes to tool exit_code 0. lsof exit 1 with
//     any stderr/stdout content, exit 0 with a warning on stderr, exit != 0/1,
//     spawn failure, timeout and maxBuffer/unknown outcomes are tool
//     diagnostics: rows[] + non-zero tool exit_code so the O5 evaluator's
//     data-driven layer downgrade applies (never a false successful absence).
//
// Injectable seams (hermetic Darwin simulation and deterministic tool output,
// following the tt-process-identity convention):
//   TT_O5_PLATFORM = linux|darwin          force the platform branch
//   TT_O5_PS / TT_O5_LSOF                   shim binaries for ps/lsof

import { spawnSync } from 'node:child_process';
import {
  getProcessCwd,
  getProcessCmdline,
  getProcessGroup,
  getProcessParent,
  getProcessStartIdentity,
  getProcessState,
} from '../../bin/tt-process-identity.mjs';

export function o5Platform() {
  return process.env.TT_O5_PLATFORM ?? process.platform;
}

// redactCmdline: bound + redact a public cmdline field. Never a secret scan —
// this is a deterministic transform of the cmdline string the recorder already
// captured: the field is truncated to 512 chars, and any `--key=value` or
// `KEY=value` argument whose value looks credential-bearing (key token in the
// documented set, or a long high-entropy-looking value) is replaced by
// `REDACTED`. The evaluator never relies on cmdline values for verdicts.
const SECRET_KEYS = /(^|[\s=])(--?)?([a-zA-Z0-9_.-]*)(api[_-]?key|auth|token|secret|pass(word)?|credential|session|priv(ate)?[-_]?key)([a-zA-Z0-9_.-]*)(=|\s|$)/i;
export function redactCmdline(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  let value = raw;
  value = value.replace(/(--?[a-zA-Z0-9_.-]+=)(\S+)/g, (match, key, val) => {
    if (SECRET_KEYS.test(`${key}${val}`) || (val.length >= 24 && /^[A-Za-z0-9+/=_-]+$/.test(val))) {
      return `${key}REDACTED`;
    }
    return match;
  });
  value = value.replace(/(^|\s)([A-Z][A-Z0-9_]*(?:API|KEY|TOKEN|SECRET|PASS|AUTH)[A-Z0-9_]*=)(\S+)/g, '$1$2REDACTED');
  return value.length <= 512 ? value : value.slice(0, 512);
}

function runTool(binaryEnv, binary, args) {
  const resolved = binaryEnv ?? binary;
  let result;
  try {
    result = spawnSync(resolved, args, {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    return {
      status: 127,
      stdout: '',
      stderr: `spawn failed: ${resolved}`,
      spawnError: error instanceof Error ? error.message : String(error),
    };
  }
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  if (result.error !== undefined) {
    // spawn-side failure (ENOENT), timeout (ETIMEDOUT) or maxBuffer overflow:
    // the tool did not produce a trustworthy outcome — mechanically non-success.
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    return {
      status: Number.isInteger(result.status) && result.status !== -1 ? result.status : 127,
      stdout,
      stderr: stderr.length > 0 ? stderr : `lsof tool failure: ${message}`,
      spawnError: message,
    };
  }
  return { status: result.status ?? -1, stdout, stderr };
}

// boundedText: bounded diagnostic rendering (never a full secret/verbose dump).
function boundedText(text, max = 200) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

// A listener port is only admitted as a finite safe integer in the real TCP/UDP
// range 1..65535 — never a range, string, float or broad selector.
export function isValidListenerPort(port) {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535;
}

// parseLsofPortOutput(requestedPort, stdout): strict framing validation of one
// `lsof -F` capture. Every line must be a single-letter -F field code; pids
// must be positive integers; address/port name records must parse AND name the
// requested port. Returns { ok: false, reason } for any framing violation, or
// { ok: true, facts: [{pid, protocol, local_address, local_port}] }.
export function parseLsofPortOutput(requestedPort, stdout) {
  if (!isValidListenerPort(requestedPort)) {
    return { ok: false, reason: `invalid requested port ${JSON.stringify(requestedPort)}`, facts: [] };
  }
  const text = String(stdout ?? '');
  const facts = [];
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    const code = line[0];
    const value = line.slice(1);
    if (!/^[A-Za-z]$/.test(code)) {
      return { ok: false, reason: `unframed lsof field line ${boundedText(line, 120)}`, facts: [] };
    }
    if (code === 'p') {
      const pid = Number(value);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        return { ok: false, reason: `non-positive lsof pid field ${boundedText(line, 120)}`, facts: [] };
      }
      current = { pid, protocol: null };
    } else if (code === 'P') {
      if (current !== null && current.protocol === null && value.length > 0) current.protocol = value;
    } else if (code === 'n') {
      if (current === null) {
        return { ok: false, reason: `lsof name field with no owning pid record: ${boundedText(line, 120)}`, facts: [] };
      }
      const parsed = parseLsofName(value);
      if (parsed === null) {
        return { ok: false, reason: `unparseable lsof address:port field ${boundedText(line, 120)}`, facts: [] };
      }
      if (parsed.port !== requestedPort) {
        return { ok: false, reason: `lsof name field names port ${parsed.port}, not the requested ${requestedPort}: ${boundedText(line, 120)}`, facts: [] };
      }
      facts.push({
        pid: current.pid,
        protocol: current.protocol ?? 'tcp',
        local_address: parsed.address,
        local_port: parsed.port,
      });
    }
    // any other single-letter -F field code (f, c, t, L, ...) is accepted and
    // ignored — lsof emits fd lines even when only p/P/n are requested.
  }
  return { ok: true, facts };
}

// classifyListenerPort(port, result): per-port lsof outcome classification.
//   'clean'               exit 1 + EMPTY stdout + EMPTY stderr — the positive
//                         absence observation (nothing matched the port).
//   'listening'           exit 0 + well-formed complete record(s), no stderr.
//   'listening-diagnostic'rows present BUT the tool wrote stderr (warning):
//                         rows are kept as evidence; the port is still
//                         mechanically NON-success (never a clean census).
//   'malformed'           exit 0/1 whose stdout fails strict framing or yields
//                         no complete pid/address/port record.
//   'tool-error'          spawn failure / timeout / maxBuffer / exit outside
//                         {0,1} / exit 1 carrying stderr or stdout content.
function classifyListenerPort(port, result) {
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  const status = result.status;
  if (result.spawnError !== undefined) {
    return { kind: 'tool-error', detail: boundedText(result.spawnError, 200) };
  }
  if (status === 1 && stdout.length === 0 && stderr.length === 0) {
    return { kind: 'clean' };
  }
  if (status !== 0 && status !== 1) {
    return { kind: 'tool-error', detail: `lsof exited ${status}${stderr.length > 0 ? `: ${boundedText(stderr, 200)}` : ''}` };
  }
  const framed = parseLsofPortOutput(port, stdout);
  if (!framed.ok) {
    return { kind: 'malformed', detail: boundedText(framed.reason, 200) };
  }
  if (stderr.length > 0) {
    if (framed.facts.length === 0) {
      return { kind: 'tool-error', detail: `lsof reported a diagnostic with no rows: ${boundedText(stderr, 200)}` };
    }
    return { kind: 'listening-diagnostic', facts: framed.facts, detail: boundedText(stderr, 200) };
  }
  if (status === 1) {
    // exit 1 means lsof detected errors; only the empty-output exit 1 above is
    // a clean no-match. Content-bearing exit 1 is never a clean absence.
    return { kind: 'tool-error', detail: `lsof exited 1 with stdout content but no stderr: ${boundedText(stdout, 200)}` };
  }
  if (framed.facts.length === 0) {
    return { kind: 'malformed', detail: 'lsof exited 0 but no complete pid/address/port record was found in its output' };
  }
  return { kind: 'listening', facts: framed.facts };
}

// failureExitFor: the tool exit code recorded on the aggregate inventory for a
// non-success port outcome. Keeps a real observed non-zero exit when there is
// one; otherwise reports the lsof semantic failure code 1. Only ever used on
// NON-clean outcomes (a clean no-match normalizes to aggregate exit 0).
function failureExitFor(result) {
  if (Number.isInteger(result.status) && result.status > 0 && result.status <= 255) return result.status;
  if (result.spawnError !== undefined) return 127;
  return 1;
}

/**
 * probePresence(pid): tri-state mechanical presence of an ALREADY-ADMITTED pid
 * via `kill(pid, 0)` (no signal is delivered):
 *   'present'    — the pid exists (may be a zombie; state disambiguates);
 *   'absent'     — ESRCH: the pid does not exist — a POSITIVE absence
 *                  observation (the recorder's tool ran and the pid is gone);
 *   'unreadable' — EPERM/EACCES: existence cannot be determined — the caller
 *                  MUST record census.complete=false (never proof of death).
 */
export function probePresence(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unreadable';
  try {
    process.kill(pid, 0);
    return 'present';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'absent';
    return 'unreadable';
  }
}

/**
 * snapshotProcessRow(pid): one bounded read-only process observation row for
 * an ALREADY-ADMITTED pid that is PRESENT. Returns null when the pid is not a
 * positive integer or when it is absent/unreadable (callers use probePresence
 * for the tri-state and must not fabricate an identity).
 */
export function snapshotProcessRow(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const ts = new Date().toISOString();
  const state = getProcessState(pid);
  if (state === null) return null; // present-but-unreadable is handled by the caller as unreadable
  const platform = o5Platform();
  const pgid = getProcessGroup(pid);
  const ppid = getProcessParent(pid);
  const startIdentity = getProcessStartIdentity(pid);
  const cwd = getProcessCwd(pid);
  const cmdline = redactCmdline(getProcessCmdline(pid) ?? '');
  let cgroup = null;
  if (platform === 'linux') {
    const ps = runTool(process.env.TT_O5_PS, 'ps', ['-p', String(pid), '-o', 'cgroup=']);
    if (ps.status === 0) {
      const value = String(ps.stdout).trim();
      cgroup = value === '' ? null : value;
    }
  }
  return { pid, pgid, ppid, state, start_identity: startIdentity, cwd, cmdline, cgroup, ts };
}

/**
 * snapshotOwnedProcesses(pids, { spans }): bounded read-only census over the
 * exact owned/admitted pid set. Returns the observations.processes inventory
 * shape the O5 sidecar consumes. rows contains only LIVE observations. The
 * returned `absent` list is the recorder's POSITIVE absence evidence (the tool
 * examined each admitted pid and it does not exist); the returned `unreadable`
 * list MUST make the caller set census.complete=false and add a diagnostic —
 * an unreadable observation is never proof of death (the O5 honesty rule), and
 * the evaluator treats such an admission as UNRESOLVED, never dead.
 */
export function snapshotOwnedProcesses(pids, options = {}) {
  const rows = [];
  const absent = [];
  const unreadable = [];
  for (const pid of pids) {
    const presence = probePresence(pid);
    if (presence === 'absent') {
      absent.push(pid);
      continue;
    }
    if (presence === 'unreadable') {
      unreadable.push(pid);
      continue;
    }
    const row = snapshotProcessRow(pid);
    if (row === null) {
      unreadable.push(pid);
      continue;
    }
    rows.push(row);
  }
  return {
    rows,
    exact_count: rows.length,
    capped: false,
    absent,
    unreadable,
    tool: { name: 'o5-capture:tt-process-identity', exit_code: 0 },
    spans: options.spans ?? [{ start: new Date().toISOString(), end: new Date().toISOString() }],
  };
}

/**
 * snapshotOwnedListeners(ports, { spans }): bounded read-only listening-socket
 * census for the exact owned port set via lsof (BSD and linux both emit
 * `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp` rows). Returns the
 * observations.listeners inventory shape.
 *
 * Capture contract (see the header): STRICT COMPLETE PREFLIGHT of every input
 * BEFORE any tool call — ports must be finite safe integers 1..65535; any
 * invalid/out-of-scope entry makes NO tool call and returns a mechanically
 * non-success inventory (tool.exit_code 2, preflight_rejected true, bounded
 * diagnostics). Valid ports are captured one query at a time and the lsof -F
 * output framing is validated: lsof exit 1 with empty stdout+empty stderr is
 * the POSITIVE clean no-match (release evidence, aggregate tool exit_code 0);
 * exit 1 with content, exit 0 with malformed/unframed output or no complete
 * pid/address/port record, any stderr diagnostic, exit outside {0,1}, spawn
 * failure, timeout and maxBuffer/unknown outcomes are mechanically NON-SUCCESS
 * (rows only when genuinely parsed; bounded diagnostics; non-zero aggregate
 * tool exit_code) — the O5 evaluator treats the non-zero exit as an
 * unavailable/partial path-fd layer, NEVER as a complete empty census.
 */
export function snapshotOwnedListeners(ports, options = {}) {
  const defaultSpans = options.spans ?? [{ start: new Date().toISOString(), end: new Date().toISOString() }];
  // ── strict COMPLETE preflight of every input before ANY tool call ────────
  const scopeErrors = [];
  if (!Array.isArray(ports)) {
    scopeErrors.push(`ports must be an array, got ${ports === null ? 'null' : typeof ports}`);
  } else {
    for (let index = 0; index < ports.length; index += 1) {
      const port = ports[index];
      if (!isValidListenerPort(port)) {
        scopeErrors.push(
          `ports[${index}] is ${JSON.stringify(port)}; only finite safe integers in 1..65535 are admitted — no ranges ('1-65535'), strings, floats or broad selectors`,
        );
      }
    }
  }
  if (scopeErrors.length > 0) {
    // Invalid or unknown scope: make NO tool calls. Mechanically non-success,
    // never a false successful absence (root counterexample C).
    return {
      rows: [],
      exact_count: 0,
      capped: false,
      tool: { name: 'lsof', exit_code: 2 },
      spans: defaultSpans,
      preflight_rejected: true,
      diagnostics: scopeErrors.slice(0, 10),
      port_outcomes: scopeErrors.slice(0, 10).map((error, index) => ({
        port: Array.isArray(ports) ? ports[index] : null,
        outcome: 'rejected-input',
        detail: boundedText(error, 200),
      })),
    };
  }
  const rows = [];
  const seen = new Set();
  const diagnostics = [];
  const portOutcomes = [];
  let worstExit = 0;
  for (const port of ports) {
    const result = runTool(process.env.TT_O5_LSOF, 'lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-FpPn']);
    const outcome = classifyListenerPort(port, result);
    if (outcome.kind === 'clean') {
      portOutcomes.push({ port, outcome: 'clean', exit_code: 0 });
      continue;
    }
    if (outcome.kind === 'listening' || outcome.kind === 'listening-diagnostic') {
      if (outcome.kind === 'listening-diagnostic') {
        // rows are real evidence but the tool wrote a diagnostic (warning):
        // the port is not certified clean — record the bounded diagnostic and
        // keep the aggregate non-zero (data-driven downgrade in the checker).
        if (worstExit === 0) worstExit = failureExitFor(result);
        diagnostics.push(`port ${port}: lsof diagnostic: ${outcome.detail}`);
        portOutcomes.push({ port, outcome: 'listening-with-diagnostic', exit_code: worstExit, detail: boundedText(outcome.detail, 200) });
      } else {
        portOutcomes.push({ port, outcome: 'listening', exit_code: 0 });
      }
      for (const fact of outcome.facts) {
        const key = `${fact.pid}:${fact.local_port}`;
        if (seen.has(key)) continue; // duplicate port/pid rows are never double-counted
        seen.add(key);
        const identity = snapshotProcessRow(fact.pid);
        rows.push({
          pid: fact.pid,
          pgid: identity?.pgid ?? null,
          start_identity: identity?.start_identity ?? null,
          protocol: fact.protocol.toLowerCase(),
          local_address: fact.local_address,
          local_port: fact.local_port,
          ts: new Date().toISOString(),
        });
      }
      continue;
    }
    // malformed / tool-error: mechanically non-success with bounded diagnostics.
    if (worstExit === 0) worstExit = failureExitFor(result);
    diagnostics.push(`port ${port}: ${outcome.kind}: ${outcome.detail}`);
    portOutcomes.push({ port, outcome: outcome.kind, exit_code: worstExit, detail: boundedText(outcome.detail, 200) });
  }
  return {
    rows,
    exact_count: rows.length,
    capped: false,
    tool: { name: 'lsof', exit_code: worstExit },
    spans: defaultSpans,
    ...(diagnostics.length > 0 ? { diagnostics: diagnostics.slice(0, 20) } : {}),
    ...(portOutcomes.length > 0 ? { port_outcomes: portOutcomes.slice(0, 500) } : {}),
  };
}

// parseLsofName: lsof `n` name rows are 'ADDRESS:PORT' (IPv4) or
// '[v6addr]:PORT' — extract a plain address + numeric port. Never a scan.
export function parseLsofName(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let address = value;
  let port;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return null;
    address = value.slice(1, close);
    port = Number(value.slice(close + 2));
  } else {
    const lastColon = value.lastIndexOf(':');
    if (lastColon === -1) return null;
    address = value.slice(0, lastColon);
    port = Number(value.slice(lastColon + 1));
  }
  if (!Number.isInteger(port) || port <= 0) return null;
  return { address, port };
}

export { snapshotProcessRow as snapshotProcess };
