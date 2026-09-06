/*
 * landlock-helper.c — tamandua per-execution Linux Landlock SIGNAL-scope
 * startup helper (KHYG US-001).
 *
 * Purpose
 * -------
 * Give ONE harness execution its OWN fresh native signal-security domain.
 * The scheduling daemon spawns this helper as a fresh child; the helper
 * applies a Landlock ruleset to ITSELF (never to the daemon, never to any
 * other process) and then, after an explicit release handshake on a private
 * control fd, exec(3)s the real harness command exactly once. Everything the
 * harness later spawns inherits the domain, so a worker can signal its own
 * execution's processes but not the daemon, another execution, or unrelated
 * host processes.
 *
 * This is process-signal isolation ONLY (Landlock LANDLOCK_SCOPE_SIGNAL).
 * It is deliberately NOT a filesystem sandbox and NOT a security boundary
 * against unprotected senders, same-execution self-kills, filesystem writes,
 * or indirect service-control APIs. See the KHYG task for the honest limits.
 *
 * Design / non-negotiables (see the KHYG task contract):
 *  - Single-threaded native startup before exec. Never fork(2), never
 *    setsid(2): the parent spawn already detaches the process group.
 *  - The restriction is applied to this process only, before any harness
 *    work starts.
 *  - Filesystem policy: handled_access_fs = LANDLOCK_ACCESS_FS_REFER ONLY,
 *    plus ONE allow rule granting LANDLOCK_ACCESS_FS_REFER at the filesystem
 *    root '/'. This is the small compatibility allow rule proven by the
 *    coordinator composition evidence (native-signal-probes.DHNQbp): it keeps
 *    cross-directory hardlink/rename working (no EXDEV) when this domain is
 *    composed with a filesystem Landlock domain in either order. No file
 *    confinement; no other filesystem/network rights are handled.
 *  - Landlock kernel ABI gate: the minimum supported ABI is 6 (the release
 *    that introduced LANDLOCK_SCOPE_SIGNAL). We deliberately do NOT raise the
 *    minimum to ABI 8.
 *  - Landlock entails no-new-privileges, ptrace restrictions, and filesystem
 *    policy-related mount limitations once a ruleset is applied. This helper
 *    does not change those semantics, and it never tries to loosen an outer
 *    sandbox (Landlock cannot be removed once applied).
 *
 * Control-channel readiness/release contract (NOT stdin)
 * -------------------------------------------------------
 * The helper expects a dedicated, bidirectional control fd (socketpair-style;
 * Node exposes it as an extra stdio entry). Contract:
 *   1. helper writes one READY line:  READY mode=landlock abi=<n> pid=<p>\n
 *   2. helper blocks reading the control fd until the parent sends the
 *      release (any byte). A setup child that never receives release can
 *      never have executed the harness.
 *   3. release received -> helper closes the control fd and exec(3)s the
 *      given argv exactly once.
 *   EOF on the control fd before release means the parent gave up (e.g.
 *   cancellation during setup): the helper exits WITHOUT executing anything.
 *
 * Exit codes (documented; do not reuse casually):
 *   0    target ran and exited 0
 *   124  helper usage error (bad argv)
 *   125  PRE-EXEC setup failure (ABI gate, ruleset/rule/prctl/restrict
 *        failure, control-fd problems, EOF-before-release). The target was
 *        NEVER executed. A distinct explanatory line is printed to stderr.
 *   126  exec(3) of the target failed AFTER release.
 * After release, the target replaces this process via exec, so any exit code
 * observed with READY received and release sent belongs to the target, never
 * to pre-exec setup.
 *
 * Usage
 * -----
 *   landlock-helper [--control-fd <n>] -- <program> [args...]
 *   landlock-helper [--control-fd <n>] <program> [args...]
 * The control fd defaults to 3. Everything after the first non-option
 * argument (or after an explicit "--") is the command to exec exactly once.
 *
 * Test-only hook (never used by production launches, never a CLI knob):
 *   TAMANDUA_LANDLOCK_HELPER_TEST_FORCE_ABI=<n>  overrides the ABI probe
 *   result so the ABI<6 gate can be exercised on any host. Only a value
 *   parsed as a non-negative integer takes effect; the special token
 *   "syscall-error" forces the probe to fail like an unsupported/disabled
 *   SYS_landlock_create_ruleset (ABI -1, errno ENOSYS) so tests can
 *   distinguish that case from a successful query below the minimum.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <poll.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

/* Documented exit codes (see header comment). */
#define HELPER_EXIT_OK 0
#define HELPER_EXIT_USAGE 124
#define HELPER_EXIT_SETUP_FAILURE 125
#define HELPER_EXIT_EXEC_FAILURE 126

/* Minimum Landlock ABI supporting LANDLOCK_SCOPE_SIGNAL. */
#define LANDLOCK_MIN_ABI 6

/* Default control fd when --control-fd is not given. */
#define DEFAULT_CONTROL_FD 3

/* Test-only override env var (see header comment). */
#define TEST_FORCE_ABI_ENV "TAMANDUA_LANDLOCK_HELPER_TEST_FORCE_ABI"

static void setup_fail(const char *stage, const char *detail) {
  fprintf(stderr,
          "tamandua-landlock-helper: pre-exec setup failure stage=%s detail=%s "
          "errno=%d (%s)\n",
          stage, detail, errno, errno != 0 ? strerror(errno) : "none");
}

/* Parse a non-negative long integer strictly. Returns false when invalid. */
static bool parse_long(const char *s, long *out) {
  if (s == NULL || *s == '\0') return false;
  errno = 0;
  char *end = NULL;
  long v = strtol(s, &end, 10);
  if (errno != 0 || end == s || *end != '\0') return false;
  if (v < 0) return false;
  *out = v;
  return true;
}

int main(int argc, char **argv) {
  /* ---- 0. Parse argv: [--control-fd <n>] [--] <program> [args...] ---- */
  int control_fd = DEFAULT_CONTROL_FD;
  int i = 1;
  if (argc <= 1) {
    fprintf(stderr, "tamandua-landlock-helper: usage: %s [--control-fd <n>] [--] <program> [args...]\n",
            argc > 0 ? argv[0] : "landlock-helper");
    return HELPER_EXIT_USAGE;
  }
  if (i < argc && strcmp(argv[i], "--control-fd") == 0) {
    if (i + 1 >= argc) {
      fprintf(stderr, "tamandua-landlock-helper: usage: --control-fd requires a value\n");
      return HELPER_EXIT_USAGE;
    }
    long fd_value = 0;
    if (!parse_long(argv[i + 1], &fd_value) || fd_value > 1024) {
      fprintf(stderr, "tamandua-landlock-helper: --control-fd value must be a small non-negative integer\n");
      return HELPER_EXIT_USAGE;
    }
    control_fd = (int)fd_value;
    i += 2;
  }
  if (i < argc && strcmp(argv[i], "--") == 0) i++;
  if (i >= argc) {
    fprintf(stderr, "tamandua-landlock-helper: no command to execute\n");
    return HELPER_EXIT_USAGE;
  }
  char **exec_argv = &argv[i];

  /* The control fd must be open before we rely on it. */
  if (fcntl(control_fd, F_GETFD) < 0) {
    errno = 0;
    setup_fail("control-fd-not-open", "spawner did not provide the control channel");
    return HELPER_EXIT_SETUP_FAILURE;
  }

  /* ---- 1. ABI gate (before any restriction or exec) ---- */
  errno = 0;
  long abi = (long)syscall(SYS_landlock_create_ruleset, NULL, 0,
                           LANDLOCK_CREATE_RULESET_VERSION);
  int abi_errno = errno; /* preserve the real errno of a failed probe */
  /* Test-only override: replace the probed ABI so the <6 gate is exercisable
     on hosts whose real ABI is high enough. */
  const char *force_abi_env = getenv(TEST_FORCE_ABI_ENV);
  if (force_abi_env != NULL) {
    if (strcmp(force_abi_env, "syscall-error") == 0) {
      abi = -1; /* simulate an unsupported/disabled SYS_landlock_create_ruleset */
      abi_errno = ENOSYS;
    } else {
      long forced = 0;
      if (parse_long(force_abi_env, &forced)) {
        abi = forced;
        if (forced >= LANDLOCK_MIN_ABI) abi_errno = 0;
      }
    }
  }
  if (abi < LANDLOCK_MIN_ABI) {
    char detail[192];
    if (abi < 0 && abi_errno != 0) {
      /* A real probe failure (e.g. ENOSYS: Landlock disabled/unsupported) is
         distinct from a successful query that merely reports a low ABI. */
      snprintf(detail, sizeof(detail),
               "landlock ABI probe failed: SYS_landlock_create_ruleset returned "
               "%ld errno=%d (%s); Landlock unavailable or disabled on this kernel",
               abi, abi_errno, strerror(abi_errno));
      errno = abi_errno;
    } else {
      snprintf(detail, sizeof(detail),
               "landlock kernel ABI %ld below required minimum %d "
               "(SYS_landlock_create_ruleset returned %ld)",
               abi, LANDLOCK_MIN_ABI, abi);
      errno = 0;
    }
    setup_fail("abi-below-minimum", detail);
    return HELPER_EXIT_SETUP_FAILURE;
  }

  /* ---- 2. Create the ruleset (SIGNAL scope + FS_REFER handled) ---- */
  struct landlock_ruleset_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.handled_access_fs = LANDLOCK_ACCESS_FS_REFER;
  attr.scoped = LANDLOCK_SCOPE_SIGNAL;
  int ruleset_fd = (int)syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
  if (ruleset_fd < 0) {
    setup_fail("create-ruleset", "SYS_landlock_create_ruleset failed");
    return HELPER_EXIT_SETUP_FAILURE;
  }

  /* ---- 3. One compatibility allow rule: FS_REFER at the filesystem root ---- */
  {
    int root_fd = open("/", O_PATH | O_CLOEXEC);
    if (root_fd < 0) {
      setup_fail("open-root", "open(\"/\", O_PATH) failed");
      close(ruleset_fd);
      return HELPER_EXIT_SETUP_FAILURE;
    }
    struct landlock_path_beneath_attr path_rule;
    memset(&path_rule, 0, sizeof(path_rule));
    path_rule.allowed_access = LANDLOCK_ACCESS_FS_REFER;
    path_rule.parent_fd = root_fd;
    if (syscall(SYS_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH,
                &path_rule, 0) < 0) {
      setup_fail("allow-refer-root", "SYS_landlock_add_rule(FS_REFER at /) failed");
      close(root_fd);
      close(ruleset_fd);
      return HELPER_EXIT_SETUP_FAILURE;
    }
    close(root_fd);
  }

  /* ---- 4. no_new_privs, then apply the domain to THIS process only ---- */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
    setup_fail("no-new-privileges", "prctl(PR_SET_NO_NEW_PRIVS, 1) failed");
    close(ruleset_fd);
    return HELPER_EXIT_SETUP_FAILURE;
  }
  if (syscall(SYS_landlock_restrict_self, ruleset_fd, 0) < 0) {
    setup_fail("restrict-self", "SYS_landlock_restrict_self failed");
    close(ruleset_fd);
    return HELPER_EXIT_SETUP_FAILURE;
  }
  close(ruleset_fd);

  /* ---- 5. READY record, then wait for release (never exec before it) ---- */
  char ready_line[256];
  int n = snprintf(ready_line, sizeof(ready_line),
                   "READY mode=landlock abi=%ld pid=%ld\n", abi, (long)getpid());
  if (n < 0 || (size_t)n >= sizeof(ready_line)) {
    errno = 0;
    setup_fail("ready-format", "internal READY formatting error");
    return HELPER_EXIT_SETUP_FAILURE;
  }
  size_t off = 0;
  size_t len = (size_t)n;
  while (off < len) {
    ssize_t w = write(control_fd, ready_line + off, len - off);
    if (w < 0) {
      if (errno == EINTR) continue;
      setup_fail("ready-write", "write of READY record to control fd failed");
      return HELPER_EXIT_SETUP_FAILURE;
    }
    off += (size_t)w;
  }

  /* Block until the parent releases us (any byte) or closes the channel
     (EOF -> cancellation/give-up: never execute the harness). */
  for (;;) {
    struct pollfd pfd;
    pfd.fd = control_fd;
    pfd.events = POLLIN;
    pfd.revents = 0;
    int pr = poll(&pfd, 1, -1);
    if (pr < 0) {
      if (errno == EINTR) continue;
      setup_fail("control-poll", "poll on control fd failed");
      return HELPER_EXIT_SETUP_FAILURE;
    }
    if ((pfd.revents & (POLLIN | POLLHUP | POLLERR)) == 0) continue;
    char byte = 0;
    ssize_t r = read(control_fd, &byte, 1);
    if (r < 0) {
      if (errno == EINTR) continue;
      setup_fail("control-read", "read on control fd failed");
      return HELPER_EXIT_SETUP_FAILURE;
    }
    if (r == 0) {
      errno = 0;
      setup_fail("control-eof-before-release",
                 "control channel closed before release; harness never started");
      return HELPER_EXIT_SETUP_FAILURE;
    }
    break; /* released exactly once */
  }
  close(control_fd);

  /* ---- 6. Exec the given argv exactly once. ---- */
  execvp(exec_argv[0], exec_argv);
  fprintf(stderr, "tamandua-landlock-helper: exec of target failed: %s (errno %d)\n",
          strerror(errno), errno);
  return HELPER_EXIT_EXEC_FAILURE;
}
