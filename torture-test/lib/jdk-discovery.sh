#!/usr/bin/env bash
# =============================================================================
# jdk-discovery.sh — resolve a working JDK on darwin and linux.
#
# SOURCE-ONLY library. Source it from a bash script:
#
#     . torture-test/lib/jdk-discovery.sh
#
# On success it:
#   * exports JAVA_HOME to the resolved JDK directory
#   * prints one line to stdout: source=<java_home|mvn|path>
#
# On failure it:
#   * returns non-zero (fail closed)
#   * prints a remedy to stderr naming JAVA_HOME and nix
#
# Resolution order (the first working JDK wins):
#   1. JAVA_HOME — only when $JAVA_HOME/bin/java -version exits 0
#   2. the JDK `mvn -v` reports on its `runtime:` line — only when its
#      bin/java -version exits 0. This is what nix maven's bundled Zulu JDK
#      needs on darwin, where PATH `java` is Apple's stub.
#   3. `java` on PATH — only when `java -version` exits 0 (Apple's stub exits
#      non-zero, so it is skipped).
#
# bash 3.2-safe (macOS /bin/bash): no associative arrays, no ${var,,} case
# modification, no mapfile; every expansion under `set -u` is guarded.
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# jdk_discovery_resolve_symlinks <path>
#   Chase a symlink chain to a real path. BSD readlink on macOS has no -f,
#   so we walk the chain manually (bounded to 10 hops).
# -----------------------------------------------------------------------------
jdk_discovery_resolve_symlinks() {
  local target="$1"
  local link
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if [ -L "$target" ]; then
      link="$(readlink "$target")"
      case "$link" in
        /*) target="$link" ;;
        *)  target="$(cd "$(dirname "$target")" && pwd)/$link" ;;
      esac
    else
      break
    fi
  done
  printf '%s\n' "$target"
}

# -----------------------------------------------------------------------------
# jdk_discovery_run — the resolver body. Exports JAVA_HOME, prints the source,
# and returns non-zero with a remedy on stderr when nothing works.
# -----------------------------------------------------------------------------
jdk_discovery_run() {
  local java_bin
  local java_home

  # 1) JAVA_HOME — honour it only when it points at a working bin/java.
  if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
    if "$JAVA_HOME/bin/java" -version >/dev/null 2>&1; then
      export JAVA_HOME
      printf 'source=java_home\n'
      return 0
    fi
  fi

  # 2) The JDK `mvn -v` reports on its `runtime:` line. Parse it and verify
  #    that the reported JDK's bin/java actually runs before trusting it.
  if command -v mvn >/dev/null 2>&1; then
    local mvn_runtime
    mvn_runtime="$(mvn -v 2>/dev/null \
      | sed -n 's/^.*[Rr]untime:[[:space:]]*\([^,]*\).*$/\1/p' \
      | head -n 1 \
      | sed 's/[[:space:]]*$//' \
      || true)"
    if [ -n "$mvn_runtime" ] && [ -x "$mvn_runtime/bin/java" ]; then
      if "$mvn_runtime/bin/java" -version >/dev/null 2>&1; then
        export JAVA_HOME="$mvn_runtime"
        printf 'source=mvn\n'
        return 0
      fi
    fi
  fi

  # 3) `java` on PATH — only when it actually runs (Apple's stub exits
  #    non-zero, so a stub is skipped). Derive JAVA_HOME as the parent of the
  #    directory that holds the resolved java binary.
  if command -v java >/dev/null 2>&1; then
    if java -version >/dev/null 2>&1; then
      java_bin="$(command -v java)"
      if [ -L "$java_bin" ]; then
        java_bin="$(jdk_discovery_resolve_symlinks "$java_bin")"
      fi
      java_home="$(cd "$(dirname "$java_bin")/.." && pwd)"
      if [ -x "$java_home/bin/java" ]; then
        export JAVA_HOME="$java_home"
        printf 'source=path\n'
        return 0
      fi
    fi
  fi

  # Fail closed with a remedy.
  {
    printf 'jdk-discovery: no working JDK found on this host.\n'
    printf '  Remedy: export JAVA_HOME=/path/to/jdk (its bin/java must run),\n'
    printf '  or install a JDK via nix (e.g. `nix profile install nixpkgs#temurin-bin`).\n'
  } >&2
  return 1
}

# Source-only entry point: run the resolver when this file is sourced.
jdk_discovery_run
