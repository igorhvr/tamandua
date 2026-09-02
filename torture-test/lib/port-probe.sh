#!/usr/bin/env bash
# =============================================================================
# port-probe.sh — portable, address-exact TCP-connect liveness probe.
#
# SOURCE-ONLY library. Source it from a bash script:
#
#     . torture-test/lib/port-probe.sh
#
# Sourcing only DEFINES the three functions below — it has no side effects
# (no set -e/pipefail, no execution on import).
#
#   port_probe <port>
#       Return 0 when a TCP listener accepts a connection on 127.0.0.1:<port>,
#       1 otherwise. The probe is a single `node -e` net.connect against the
#       IPv4 loopback address with a bounded 1-second in-process timeout.
#       It is ADDRESS-EXACT: 127.0.0.1 only — no `localhost` hostname lookup
#       (which can resolve to the IPv6 loopback on darwin) and no IPv6
#       fallback.
#
#   is_port_listening <port>
#       Caller-facing name for port_probe (same semantics, same exit codes).
#
#   wait_for_port <port> <timeout_sec>
#       Poll port_probe until the port answers or the timeout elapses
#       (default 10 seconds). Return 0 on success, 1 on timeout.
#
# Portability: bash 3.2-safe (macOS /bin/bash) and free of GNU-isms — no GNU
# coreutils timeout, no bash /dev/tcp host-resolution connect, no readlink -f,
# no stat -c, no date -d, no setsid, no ss. Node is already a hard runtime
# dependency of the torture-test bin tools, so the `node -e` probe adds no
# new requirement.
# =============================================================================

# port_probe: attempt a bounded (1s) TCP connect to 127.0.0.1:<port>. Returns
# 0 when the connect succeeds, 1 otherwise (refused, black-holed, or timeout).
port_probe() {
  local port="$1"
  node -e '
    const net = require("net");
    const port = Number(process.argv[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);
    let settled = false;
    let socket;
    function finish(code) {
      if (settled) return;
      settled = true;
      if (socket) socket.destroy();
      process.exit(code);
    }
    socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000, () => finish(1));
    socket.once("connect", () => finish(0));
    socket.once("error", () => finish(1));
  ' "$port" 2>/dev/null
}

# is_port_listening: whether a TCP port is accepting connections. Returns 0 if
# listening, 1 if not. Delegates to the portable address-exact port_probe.
is_port_listening() {
  local port="$1"
  port_probe "$port"
}

# wait_for_port: poll until a TCP port is listening, up to a timeout in
# seconds (default 10). Returns 0 if the port becomes available, 1 on timeout.
wait_for_port() {
  local port="$1"
  local timeout="${2:-10}"
  local deadline
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if port_probe "$port"; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}
