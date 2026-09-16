/**
 * Portable service-holder resolution.
 *
 * Finds which process currently holds a TCP listening port and proves the
 * holder is a Tamandua service (daemon / dashboard / MCP), so the daemon
 * lifecycle commands can take over a live process even when its pidfile is
 * missing or stale (DPID).
 *
 * Platform strategy:
 *  - Linux: `ss -ltnp` (fallback `ss -ltnpH`) — parses the local-address
 *    column and every `pid=NNN` in the `users:((...))` process column.
 *  - macOS: `lsof -nP -iTCP:<port> -sTCP:LISTEN` — the pid is column 2 and
 *    the NAME column carries the local address (possibly with `(LISTEN)`).
 *
 * The holder is then verified by reading its command line (procfs on Linux,
 * `ps` on macOS — see src/lib/proc-info.ts) and matching a Tamandua service
 * entry point. This module ONLY reads: it never signals, stops, or kills
 * anything. It is deliberately injectable (`opts.runCommand` /
 * `opts.getCmdline`) so unit tests can feed fixture output without spawning
 * `ss`/`lsof`/`ps`.
 */
import { spawnSync } from "node:child_process";
import { getCmdline } from "./proc-info.js";

/** Which Tamandua service a port holder should be verified as. */
export type ServiceKind = "daemon" | "dashboard" | "mcp";

/** A verified port holder: an exact pid and the cmdline that proved it. */
export interface ServiceHolder {
  pid: number;
  cmdline: string;
}

/** Minimal shape of a command result, mirrored from child_process.spawnSync. */
export interface RunCommandResult {
  stdout: string;
  status: number | null;
}

/** Injectable synchronous command runner (argv form, never a shell string). */
export type RunCommand = (command: string, args: string[]) => RunCommandResult;

/** Injectable dependencies for holder resolution (tests pass fixtures). */
export interface ServiceHolderOptions {
  /** Override platform detection (unit tests exercise both formats). */
  platform?: NodeJS.Platform;
  /** Override the command runner (default: spawnSync). */
  runCommand?: RunCommand;
  /** Override the cmdline reader (default: getCmdline from proc-info). */
  getCmdline?: (pid: number) => string;
}

/**
 * Tamandua entry-point script basenames under a `server/` directory. The
 * daemon hosts MCP in-process with `--with-mcp`, so an `mcp` holder may also
 * be the daemon script.
 */
function expectedScriptNames(service: ServiceKind): string[] {
  switch (service) {
    case "daemon":
      return ["daemon.js"];
    case "dashboard":
      return ["dashboard-standalone.js"];
    case "mcp":
      return ["mcp-standalone.js", "daemon.js"];
  }
}

/** Strip a single pair of surrounding single/double quotes from a token. */
function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/** True when `token` is exactly `<something>/server/<script>` or `server/<script>`. */
function tokenMatchesServerScript(token: string, script: string): boolean {
  const cleaned = stripQuotes(token);
  const suffix = `/server/${script}`;
  return cleaned === `server/${script}` || cleaned.endsWith(suffix);
}

/**
 * Whether a process cmdline belongs to the named Tamandua service.
 *
 * Splits on whitespace and accepts a token whose path ends in the service's
 * entry-point script. Unrelated processes (python's `http.server`, nginx, an
 * arbitrary `node app.js`) never match.
 */
export function isTamanduaServiceCmdline(cmdline: string, service: ServiceKind): boolean {
  if (!cmdline) return false;
  const tokens = cmdline.trim().split(/\s+/).filter((token) => token !== "");
  const scripts = expectedScriptNames(service);
  return tokens.some((token) => scripts.some((script) => tokenMatchesServerScript(token, script)));
}

/** Default runner: best-effort spawnSync, never throws, empty stdout on failure. */
function defaultRunCommand(command: string, args: string[]): RunCommandResult {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      status: result.status ?? null,
    };
  } catch {
    return { stdout: "", status: null };
  }
}

/** Dedupe + ascending sort for pid arrays. */
function sortedUniquePids(pids: Iterable<number>): number[] {
  return [...new Set(pids)].sort((a, b) => a - b);
}

/**
 * Parse `ss -ltnp` / `ss -ltnpH` output for pids listening on `port`.
 *
 * Columns are whitespace-split: State, Recv-Q, Send-Q, Local Address:Port,
 * Peer Address:Port, [Process]. A row matches when the local address column
 * ends with `:<port>`; every `pid=NNN` in `users:(("name",pid=NNN,fd=..))`
 * is collected. Header/malformed/other-port rows are ignored.
 */
export function parseSsListenPids(stdout: string, port: number): number[] {
  const pids: number[] = [];
  const suffix = `:${port}`;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const columns = line.split(/\s+/);
    // Need at least State/Recv-Q/Send-Q/Local-Address to identify the socket.
    if (columns.length < 4) continue;
    const localAddress = columns[3];
    if (!localAddress.endsWith(suffix)) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(match[1]);
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    }
  }
  return sortedUniquePids(pids);
}

/**
 * Parse `lsof -nP -iTCP:<port> -sTCP:LISTEN` output for listening pids.
 *
 * The COMMAND header row is skipped; the pid is column 2 (index 1) and the
 * NAME column (index 8 onward) must end with `:<port>` (a trailing
 * `(LISTEN)` is allowed). Repeated fd rows for one pid dedupe.
 */
export function parseLsofListenPids(stdout: string, port: number): number[] {
  const pids: number[] = [];
  const suffix = `:${port}`;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const columns = line.split(/\s+/);
    if (columns[0] === "COMMAND") continue; // header row
    // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME — 9 columns minimum.
    if (columns.length < 9) continue;
    const pid = Number(columns[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const name = columns
      .slice(8)
      .filter((token) => token !== "(LISTEN)")
      .join(" ");
    if (!name.endsWith(suffix)) continue;
    pids.push(pid);
  }
  return sortedUniquePids(pids);
}

/**
 * Every pid listening on `port`, with no cmdline filtering.
 *
 * Used by doctor to report the "port held by an unknown pid" case. Returns an
 * empty array when the OS command is unavailable or the port is free.
 */
export function resolvePortHolderPids(port: number, opts?: ServiceHolderOptions): number[] {
  const platform = opts?.platform ?? process.platform;
  const run = opts?.runCommand ?? defaultRunCommand;

  if (platform === "darwin") {
    const result = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    if (result.status !== 0 && !result.stdout) return [];
    return parseLsofListenPids(result.stdout, port);
  }

  // Linux and other Unix: ss first, no-header form as a fallback.
  const listed = run("ss", ["-ltnp"]);
  if (listed.status === 0) return parseSsListenPids(listed.stdout, port);
  const noHeader = run("ss", ["-ltnpH"]);
  if (noHeader.status === 0) return parseSsListenPids(noHeader.stdout, port);
  return [];
}

/**
 * Resolve the first pid listening on `port` whose cmdline proves it is the
 * named Tamandua service. Null when the OS command is unavailable, the port
 * is free, or no candidate verifies.
 */
export function resolvePortHolder(
  port: number,
  service: ServiceKind,
  opts?: ServiceHolderOptions,
): ServiceHolder | null {
  const readCmdline = opts?.getCmdline ?? getCmdline;
  for (const pid of resolvePortHolderPids(port, opts)) {
    const cmdline = readCmdline(pid);
    if (cmdline && isTamanduaServiceCmdline(cmdline, service)) {
      return { pid, cmdline };
    }
  }
  return null;
}
