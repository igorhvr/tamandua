/**
 * Unix-domain socket daemon identity primitive (DPID).
 *
 * A running Tamandua service advertises its identity over a state-dir Unix
 * socket (`~/.tamandua/daemon.sock`, `dashboard.sock`, `mcp.sock`) so liveness
 * no longer depends on a pidfile:
 *
 *  - The pidfile is an informational hint only; it can be missing, stale, or
 *    (in the historical defect) unlinked by a losing bind-race daemon.
 *  - The socket is the authoritative liveness primitive. `probeIdentitySocket`
 *    answers "is a live service there, and which pid/build/control-port?".
 *  - A crash leaves only a stale socket FILE with no listener. Connecting to it
 *    fails, so probing yields `null` (not running) and the next daemon unlinks
 *    and rebinds it.
 *
 * Design constraints:
 *  - Pure Node (`node:net`), no native code, identical behavior on Linux and
 *    macOS.
 *  - No process spawning: this module never runs `ss`/`lsof`/`ps` and never
 *    signals anything. Port-holder fallback lives in src/lib/service-holder.ts.
 *  - Probes never throw: any failure (ENOENT, ECONNREFUSED, timeout, corrupt
 *    payload) is reported as `null`.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { assertStatePathIsolation } from "../lib/test-guard.js";
import { resolveStateDir } from "../lib/tamandua-config.js";

/** Which Tamandua service owns an identity socket. */
export type ServiceKind = "daemon" | "dashboard" | "mcp";

/** The identity a live service advertises over its socket. */
export interface DaemonIdentity {
  /** Process id of the running service. */
  pid: number;
  /** Installed build version (see src/lib/version.ts getBuildVersion). */
  buildVersion: string;
  /** Control-plane TCP port this service bound (1–65535). */
  controlPort: number;
  /** ISO timestamp of when the service started. */
  startedAt: string;
  /**
   * Effective Tamandua state directory this service belongs to (DPID state-dir
   * scoping). Optional so identities/fixtures written before DPID stay valid;
   * when present it must be a non-empty string. Liveness resolution uses it to
   * prove a discovered process is OURS rather than an unrelated daemon on a
   * different state dir.
   */
  stateDir?: string;
}

/** Path options for identity sockets (tests pass a private temp home). */
export interface IdentityPathOptions {
  /** When set, use this directory instead of ~/.tamandua. */
  homeDir?: string;
}

/** Options for {@link bindIdentitySocket}. */
export interface BindIdentitySocketOptions {
  /** Probe timeout while checking for a live owner (default 500 ms). */
  probeTimeoutMs?: number;
  /** Filesystem mode applied to the bound socket (default 0600). */
  mode?: number;
}

/** A bound identity socket plus its lifecycle handle. */
export interface BoundIdentitySocket {
  /** The underlying `net.Server` (exported for observability/tests). */
  server: net.Server;
  /** The socket path this process bound. */
  socketPath: string;
  /**
   * Close the server and unlink the socket file this process created.
   * Idempotent: subsequent calls resolve without touching anything.
   */
  close(): Promise<void>;
}

/** Default probe timeout (ms). Kept short — a probe is a liveness hint. */
export const DEFAULT_PROBE_TIMEOUT_MS = 500;

/** Request line a client sends to ask for the identity. */
const IDENTITY_REQUEST = '{"op":"identity"}\n';

/**
 * Thrown by {@link bindIdentitySocket} when another live service already owns
 * the socket name. Deliberately distinct so daemon startup can print a clear
 * "another daemon is already live (pid N)" message and exit non-zero WITHOUT
 * unlinking the live owner's socket.
 */
export class IdentitySocketInUseError extends Error {
  readonly code = "EIDENTITYINUSE";
  readonly socketPath: string;
  readonly pid: number;
  readonly identity: DaemonIdentity;

  constructor(socketPath: string, identity: DaemonIdentity) {
    super(
      `Identity socket ${socketPath} is already owned by a live service ` +
        `(pid ${identity.pid}, control port ${identity.controlPort})`,
    );
    this.name = "IdentitySocketInUseError";
    this.socketPath = socketPath;
    this.pid = identity.pid;
    this.identity = identity;
  }
}

/** Socket file basename for a service. */
function socketFileName(service: ServiceKind): string {
  switch (service) {
    case "daemon":
      return "daemon.sock";
    case "dashboard":
      return "dashboard.sock";
    case "mcp":
      return "mcp.sock";
  }
}

/**
 * Resolve the identity socket path for a service.
 *
 * `getServiceSocketPath('daemon', { homeDir })` returns
 * `<homeDir>/.tamandua/daemon.sock`; dashboard/mcp use `dashboard.sock` /
 * `mcp.sock`. Without a `homeDir`, the effective state dir is resolved through
 * the shared {@link resolveStateDir} (honoring `TAMANDUA_STATE_DIR`) and the
 * test-isolation guard is consulted (mirroring daemonctl.getPidFile).
 */
export function getServiceSocketPath(
  service: ServiceKind,
  opts?: IdentityPathOptions,
): string {
  const socketPath = path.join(resolveStateDir(opts), socketFileName(service));
  if (!opts?.homeDir) {
    assertStatePathIsolation(socketPath, "getServiceSocketPath()");
  }
  return socketPath;
}

/** True when `value` is a structurally valid {@link DaemonIdentity}. */
export function isDaemonIdentity(value: unknown): value is DaemonIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const stateDir = candidate.stateDir;
  return (
    typeof candidate.pid === "number" &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.buildVersion === "string" &&
    typeof candidate.controlPort === "number" &&
    Number.isInteger(candidate.controlPort) &&
    candidate.controlPort > 0 &&
    candidate.controlPort < 65536 &&
    typeof candidate.startedAt === "string" &&
    candidate.startedAt.length > 0 &&
    // Optional for backward compatibility: absent is valid, present must be a
    // non-empty string.
    (stateDir === undefined || (typeof stateDir === "string" && stateDir.length > 0))
  );
}

/**
 * Parse one identity JSON line. Returns `null` for empty input, invalid JSON,
 * or a payload missing/invalid identity fields — never throws.
 */
export function parseIdentityLine(line: string): DaemonIdentity | null {
  try {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const parsed: unknown = JSON.parse(trimmed);
    return isDaemonIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Probe a service identity socket.
 *
 * Connects, sends `{"op":"identity"}\n`, and resolves with the parsed identity
 * from the first JSON line. Resolves `null` on ANY failure — missing path
 * (ENOENT), connection refused (stale socket), timeout, corrupt payload, or a
 * socket error. Never throws and never rejects.
 */
export function probeIdentitySocket(
  socketPath: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<DaemonIdentity | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let timer: NodeJS.Timeout | undefined;
    let socket: net.Socket;

    const finish = (result: DaemonIdentity | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        socket.removeAllListeners();
        socket.on("error", () => {});
        socket.destroy();
      } catch {
        // Best effort teardown.
      }
      resolve(result);
    };

    try {
      socket = net.createConnection(socketPath);
    } catch {
      resolve(null);
      return;
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();
    }

    socket.on("connect", () => {
      try {
        socket.write(IDENTITY_REQUEST);
      } catch {
        finish(null);
      }
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        finish(parseIdentityLine(buffer.slice(0, newline)));
      }
    });

    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

/** Promise wrapper around `server.listen(path)` that rejects on error. */
function listenOnSocket(server: net.Server, socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

/**
 * Bind a service identity socket.
 *
 * Contract:
 *  - If the path already exists, PROBE it first. A live identity means another
 *    service owns the name: throw {@link IdentitySocketInUseError} naming the
 *    live pid, WITHOUT unlinking the live socket.
 *  - If the probe fails (stale file after a crash), unlink it and bind.
 *  - The socket is chmod'ed 0600 (owner-only).
 *  - Each accepted connection receives one JSON identity line and is closed.
 *  - `close()` unlinks the socket file this process created.
 *
 * A lost bind race (EADDRINUSE between the probe and the bind) re-probes: a
 * live owner wins with the typed error, otherwise the stale file is removed and
 * the bind retried once.
 */
export async function bindIdentitySocket(
  socketPath: string,
  identity: DaemonIdentity,
  opts?: BindIdentitySocketOptions,
): Promise<BoundIdentitySocket> {
  if (!isDaemonIdentity(identity)) {
    throw new TypeError("bindIdentitySocket: identity is not a valid DaemonIdentity");
  }

  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  if (fs.existsSync(socketPath)) {
    const live = await probeIdentitySocket(socketPath, opts?.probeTimeoutMs);
    if (live) throw new IdentitySocketInUseError(socketPath, live);
    try {
      fs.unlinkSync(socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
  }

  // Track accepted connections so close() can force them down instead of
  // waiting for a half-open socket (a client that connects but never sends
  // leaves its request unread; without reading, the FIN is never processed and
  // server.close() would hang).
  const connections = new Set<net.Socket>();

  const createServer = (): net.Server =>
    net.createServer((socket) => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
      socket.on("error", () => {});
      // Read (and discard) the tiny request so the peer's FIN is processed and
      // the socket can fully close after our identity line is sent.
      socket.resume();
      socket.end(JSON.stringify(identity) + "\n");
    });

  let server = createServer();
  try {
    await listenOnSocket(server, socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
      // Another binder won the race. A live owner is authoritative.
      server.on("error", () => {});
      const live = await probeIdentitySocket(socketPath, opts?.probeTimeoutMs);
      if (live) throw new IdentitySocketInUseError(socketPath, live);
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Race: someone may have removed it already.
      }
      server = createServer();
      await listenOnSocket(server, socketPath);
    } else {
      server.on("error", () => {});
      throw err;
    }
  }

  // Post-listen errors (rare) must never crash the host process.
  server.on("error", () => {});

  try {
    fs.chmodSync(socketPath, opts?.mode ?? 0o600);
  } catch {
    // Best effort: several filesystems ignore socket modes.
  }

  let closed = false;
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise<void>((resolve) => {
      // Force any in-flight identity connection down; otherwise close waits
      // for it and can hang a shutdown.
      for (const socket of connections) {
        try {
          socket.destroy();
        } catch {
          // Best effort.
        }
      }
      connections.clear();
      server.close(() => {
        try {
          fs.unlinkSync(socketPath);
        } catch {
          // Already gone.
        }
        resolve();
      });
    });
  };

  return { server, socketPath, close };
}
