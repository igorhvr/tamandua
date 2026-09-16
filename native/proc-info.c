/*
 * proc-info.c — sandbox-safe process metadata via sysctl (MPSX follow-on).
 *
 * The macOS Seatbelt signal profile used for per-execution signal isolation
 * denies execution of setuid binaries, which makes /bin/ps unusable (EPERM)
 * inside a sandboxed harness round. sysctl(2), however, IS permitted, so this
 * helper exposes the subset of process information the product and its tests
 * need, without ever invoking an external binary:
 *
 *   proc-info list          one pid per line
 *   proc-info pid <pid>     one TAB-separated record for <pid>
 *   proc-info dump          one TAB-separated record per visible process
 *   proc-info env <pid>     raw NUL-separated environ block for <pid>
 *
 * A record is:
 *   <pid>\t<ppid>\t<pgid>\t<state>\t<startSec>\t<startUsec>\t<cmdline>
 *
 * where <state> is one of I R S T Z ? and <cmdline> is argv joined by single
 * spaces (empty when the kernel refuses KERN_PROCARGS2, e.g. for another
 * user's process). The record's cmdline is LAST so a tab inside an argument
 * cannot confuse field splitting.
 *
 * The `env` subcommand walks the SAME KERN_PROCARGS2 buffer past argv and
 * emits the environ block verbatim. sysctl(2) returns the environ block for
 * same-user processes even though `/bin/ps -E` cannot; it exits 1 when the
 * kernel refuses. It is the source of the state-dir scoping evidence in
 * src/lib/proc-info.ts `getEnvironText`/`environHasEntry`.
 *
 * This tool never calls /bin/ps and never shells out to any external binary.
 *
 * Exit codes: 0 success; 64 usage error; 1 lookup failure (pid/env mode).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/param.h>

/* Darwin p_stat values (sys/proc.h): SIDL=1 SRUN=2 SSLEEP=3 SSTOP=4 SZOMB=5. */
static char state_char(int st) {
  switch (st) {
    case 1: return 'I';
    case 2: return 'R';
    case 3: return 'S';
    case 4: return 'T';
    case 5: return 'Z';
    default: return '?';
  }
}

/*
 * Read a process's argv via KERN_PROCARGS2 and join it with single spaces.
 * Returns 0 on success (out may be an empty string), -1 when unavailable.
 * Never writes more than outsz bytes.
 */
static int read_cmdline(int pid, char *out, size_t outsz) {
  out[0] = '\0';
  int mib[3] = { CTL_KERN, KERN_PROCARGS2, pid };
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0) return -1;
  if (size < sizeof(int) || size > (size_t)(8 * 1024 * 1024)) return -1;

  char *buf = malloc(size);
  if (buf == NULL) return -1;
  if (sysctl(mib, 3, buf, &size, NULL, 0) != 0) {
    free(buf);
    return -1;
  }

  int argc = 0;
  memcpy(&argc, buf, sizeof(int));
  char *cp = buf + sizeof(int);
  char *end = buf + size;

  /* skip the executable path, then any NUL padding before argv[0] */
  cp += strnlen(cp, (size_t)(end - cp));
  while (cp < end && *cp == '\0') cp++;

  /*
   * Join argv with single spaces and sanitize control characters (notably
   * embedded newlines/tabs from prompts and heredocs) so each record stays a
   * single TAB-safe line. Substring matching on the cmdline is unaffected.
   */
  size_t used = 0;
  for (int i = 0; i < argc && cp < end; i++) {
    size_t l = strnlen(cp, (size_t)(end - cp));
    if (l == 0) break;
    if (used + l + 2 >= outsz) break;
    if (used > 0) out[used++] = ' ';
    for (size_t k = 0; k < l; k++) {
      unsigned char c = (unsigned char)cp[k];
      out[used++] = (c < 0x20 || c == 0x7f) ? ' ' : (char)c;
    }
    cp += l + 1;
  }
  out[used] = '\0';
  free(buf);
  return 0;
}

/*
 * Write a process's environ block, read from the same KERN_PROCARGS2 buffer
 * as read_cmdline(), to stdout as NUL-separated NAME=value entries.
 *
 * KERN_PROCARGS2 returns the raw stack strings area: argc (int), the
 * executable path, NUL padding, argc NUL-terminated argv strings, then the
 * environ entries. The kernel's own private apple string vector
 * (pfz/stack_guard/executable_cdhash/...) is stored contiguously AFTER the
 * environ with no reliable delimiter, so it may be included when populated;
 * consumers do exact `NAME=value` membership tests, which is unaffected.
 * When the private vector is still zero-filled the first empty entry ends
 * the block.
 *
 * Returns 0 on success (the block may be empty), -1 when the kernel refuses
 * KERN_PROCARGS2 (typically another user's process).
 */
static int write_environ(int pid) {
  int mib[3] = { CTL_KERN, KERN_PROCARGS2, pid };
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0) return -1;
  if (size < sizeof(int) || size > (size_t)(8 * 1024 * 1024)) return -1;

  char *buf = malloc(size);
  if (buf == NULL) return -1;
  if (sysctl(mib, 3, buf, &size, NULL, 0) != 0) {
    free(buf);
    return -1;
  }

  int argc = 0;
  memcpy(&argc, buf, sizeof(int));
  char *cp = buf + sizeof(int);
  char *end = buf + size;

  /* skip the executable path, then NUL padding before argv[0] */
  cp += strnlen(cp, (size_t)(end - cp));
  while (cp < end && *cp == '\0') cp++;

  /* skip argc NUL-terminated argv strings */
  for (int i = 0; i < argc && cp < end; i++) {
    size_t max = (size_t)(end - cp);
    size_t l = strnlen(cp, max);
    if (l >= max) {  /* truncated buffer: no terminator before the end */
      cp = end;
      break;
    }
    cp += l + 1;
  }

  /* environ starts after the NUL padding that follows argv */
  while (cp < end && *cp == '\0') cp++;

  /*
   * Emit each NUL-terminated NAME=value entry (NUL-separated in the output).
   * The kernel's private apple string vector may follow the environ without a
   * separator when populated; it is harmless for exact membership tests. The
   * first empty entry (the zero-filled tail before the vector is populated)
   * ends the block.
   */
  while (cp < end) {
    size_t max = (size_t)(end - cp);
    size_t l = strnlen(cp, max);
    if (l == 0 || l >= max) break;
    fwrite(cp, 1, l, stdout);
    fputc('\0', stdout);
    cp += l + 1;
  }
  free(buf);
  return 0;
}

static void print_record(int pid, int ppid, int pgid, int stat,
                         long start_sec, long start_usec) {
  char cmdline[65536];
  if (read_cmdline(pid, cmdline, sizeof(cmdline)) != 0) cmdline[0] = '\0';
  printf("%d\t%d\t%d\t%c\t%ld\t%ld\t%s\n", pid, ppid, pgid, state_char(stat),
         start_sec, start_usec, cmdline);
}

static int cmd_pid(int pid) {
  int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
  struct kinfo_proc kp;
  memset(&kp, 0, sizeof(kp));
  size_t len = sizeof(kp);
  if (sysctl(mib, 4, &kp, &len, NULL, 0) != 0 || kp.kp_proc.p_pid == 0) {
    fprintf(stderr, "proc-info: no such process: %d\n", pid);
    return 1;
  }
  print_record(kp.kp_proc.p_pid, (int)kp.kp_eproc.e_ppid, (int)kp.kp_eproc.e_pgid,
               kp.kp_proc.p_stat, (long)kp.kp_proc.p_starttime.tv_sec,
               (long)kp.kp_proc.p_starttime.tv_usec);
  return 0;
}

static int cmd_dump(void) {
  int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0 };
  size_t size = 0;
  if (sysctl(mib, 4, NULL, &size, NULL, 0) != 0) {
    fprintf(stderr, "proc-info: KERN_PROC_ALL size failed: %s\n", strerror(errno));
    return 1;
  }

  struct kinfo_proc *procs = NULL;
  int count = 0;
  /* The process table can grow between the size probe and the read; retry. */
  for (int attempt = 0; attempt < 4; attempt++) {
    size_t bytes = size + size / 8 + 16 * sizeof(struct kinfo_proc);
    struct kinfo_proc *next = realloc(procs, bytes);
    if (next == NULL) {
      free(procs);
      fprintf(stderr, "proc-info: out of memory\n");
      return 1;
    }
    procs = next;
    size_t got = bytes;
    if (sysctl(mib, 4, procs, &got, NULL, 0) == 0) {
      size = got;
      count = (int)(got / sizeof(struct kinfo_proc));
      break;
    }
    if (errno != ENOMEM) {
      free(procs);
      fprintf(stderr, "proc-info: KERN_PROC_ALL read failed: %s\n", strerror(errno));
      return 1;
    }
    size = size * 2;
  }
  if (procs == NULL) return 1;

  for (int i = 0; i < count; i++) {
    int pid = procs[i].kp_proc.p_pid;
    if (pid <= 0) continue;
    print_record(pid, (int)procs[i].kp_eproc.e_ppid, (int)procs[i].kp_eproc.e_pgid,
                 procs[i].kp_proc.p_stat, (long)procs[i].kp_proc.p_starttime.tv_sec,
                 (long)procs[i].kp_proc.p_starttime.tv_usec);
  }
  free(procs);
  return 0;
}

static int cmd_list(void) {
  int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0 };
  size_t size = 0;
  if (sysctl(mib, 4, NULL, &size, NULL, 0) != 0) {
    fprintf(stderr, "proc-info: KERN_PROC_ALL size failed: %s\n", strerror(errno));
    return 1;
  }
  struct kinfo_proc *procs = malloc(size + size / 8 + 16 * sizeof(struct kinfo_proc));
  if (procs == NULL) return 1;
  size_t got = size + size / 8 + 16 * sizeof(struct kinfo_proc);
  if (sysctl(mib, 4, procs, &got, NULL, 0) != 0) {
    free(procs);
    fprintf(stderr, "proc-info: KERN_PROC_ALL read failed: %s\n", strerror(errno));
    return 1;
  }
  int count = (int)(got / sizeof(struct kinfo_proc));
  for (int i = 0; i < count; i++) {
    int pid = procs[i].kp_proc.p_pid;
    if (pid > 0) printf("%d\n", pid);
  }
  free(procs);
  return 0;
}

/* Parse a decimal pid argv value; returns 0 and stores it, or -1. */
static int parse_pid_arg(const char *text, int *out) {
  char *endp = NULL;
  long pid = strtol(text, &endp, 10);
  if (endp == text || *endp != '\0' || pid <= 0 || pid > 9999999) return -1;
  *out = (int)pid;
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: proc-info list | pid <pid> | dump | env <pid>\n");
    return 64;
  }
  if (strcmp(argv[1], "list") == 0) return cmd_list();
  if (strcmp(argv[1], "dump") == 0) return cmd_dump();
  if (strcmp(argv[1], "pid") == 0 || strcmp(argv[1], "env") == 0) {
    if (argc < 3) {
      fprintf(stderr, "usage: proc-info %s <pid>\n", argv[1]);
      return 64;
    }
    int pid = 0;
    if (parse_pid_arg(argv[2], &pid) != 0) {
      fprintf(stderr, "proc-info: invalid pid: %s\n", argv[2]);
      return 64;
    }
    if (strcmp(argv[1], "pid") == 0) return cmd_pid(pid);
    if (write_environ(pid) != 0) {
      fprintf(stderr, "proc-info: no environment for pid: %d\n", pid);
      return 1;
    }
    return 0;
  }
  fprintf(stderr, "proc-info: unknown command: %s\n", argv[1]);
  return 64;
}
