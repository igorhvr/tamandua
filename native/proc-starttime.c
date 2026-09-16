/*
 * proc-starttime.c — tamandua Darwin kernel process start-time probe
 * (TZPI US-001).
 *
 * Purpose
 * -------
 * Report the KERNEL's start time for a pid as a raw, timezone-independent
 * value: `<sec>.<usec>` where both fields come from
 * `struct kinfo_proc.kp_proc.p_starttime` (a struct timeval). This is the
 * `v2` process-start identity source on macOS.
 *
 * Why not ps(1)?
 * --------------
 * `ps -p <pid> -o lstart=` formats a LOCAL-time human string, so the SAME
 * live pid yields different text depending on the caller's TZ
 * (TZPI defect 1). Separately, under the macOS Seatbelt signal profile used
 * for per-execution isolation /bin/ps is setuid and cannot be executed at
 * all (EPERM) — the identity probe then fails inside sandboxed harness
 * rounds (MPSX defect 2). `sysctl(CTL_KERN, KERN_PROC, KERN_PROC_PID, pid)`
 * returns the raw kernel timeval and works inside the sandbox.
 *
 * Contract
 * --------
 *   argv[1]  a positive decimal pid.
 *   stdout   exactly `<sec>.<usec>\n` (usec zero-padded to 6 digits), exit 0.
 *   stderr   ONE diagnostic line on any failure.
 *
 * Exit codes (documented; do not reuse casually):
 *   0    start time obtained and printed.
 *   64   usage error: missing/extra argv or a non-positive / malformed pid.
 *   1    lookup failure: sysctl failed, or the kernel reported a zero
 *        start time (process not found / not yet started).
 *
 * Non-negotiables:
 *   - The start time is obtained ONLY via sysctl KERN_PROC_PID /
 *     kp_proc.p_starttime. This file NEVER executes ps(1) or any other
 *     external binary (no fork/exec/system/popen).
 *   - Output is a raw numeric kernel value; no locale, no TZ, no formatting
 *     of a human date.
 *   - Single pid argument; no daemon behavior, no side effects.
 */
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/time.h>

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PROC_STARTTIME_EXIT_USAGE 64
#define PROC_STARTTIME_EXIT_LOOKUP 1

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "proc-starttime: usage: proc-starttime <pid>\n");
    return PROC_STARTTIME_EXIT_USAGE;
  }

  const char *arg = argv[1];
  char *end = NULL;
  errno = 0;
  long pid = strtol(arg, &end, 10);
  if (errno != 0 || end == arg || (end != NULL && *end != '\0') || pid <= 0 ||
      pid > INT_MAX) {
    fprintf(stderr, "proc-starttime: invalid pid: %s\n", arg);
    return PROC_STARTTIME_EXIT_USAGE;
  }

  struct kinfo_proc kp;
  memset(&kp, 0, sizeof(kp));

  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, (int)pid};
  size_t len = sizeof(kp);
  if (sysctl(mib, 4, &kp, &len, NULL, 0) != 0) {
    fprintf(stderr, "proc-starttime: sysctl KERN_PROC_PID %ld failed: %s\n",
            pid, strerror(errno));
    return PROC_STARTTIME_EXIT_LOOKUP;
  }

  struct timeval start = kp.kp_proc.p_starttime;
  if (start.tv_sec == 0 && start.tv_usec == 0) {
    /* sysctl can succeed with an unfilled/zeroed kinfo_proc when no process
       matches the pid; a real process never starts at epoch 0. */
    fprintf(stderr,
            "proc-starttime: no kernel start time for pid %ld "
            "(process not found)\n",
            pid);
    return PROC_STARTTIME_EXIT_LOOKUP;
  }

  printf("%lld.%06d\n", (long long)start.tv_sec, (int)start.tv_usec);
  return 0;
}
