#!/usr/bin/env node

// session-leader-spawn — portable session/group-leader spawn for
// run-scripted-scenario (MACP4 US-003).
//
// macOS ships no setsid(1) (util-linux), so the harness cannot use the
// `setsid` binary to make the scenario command a session/group leader.
// This wrapper is the portable replacement: child_process.spawn(..., {
// detached: true }) calls setsid(2) in the child BEFORE exec on POSIX, so
// the child becomes the leader of a NEW SESSION and a NEW PROCESS GROUP
// with pgid == pid — exactly the property run-scripted-scenario proves
// (COMMAND_GROUP_PROVEN) before releasing the scenario command, and the
// property that makes a negative-pgid kill (-<pid>) reach the whole
// scenario command group without touching the harness's own group.
//
// Contract with the harness:
//   * argv: <pidFile> <command> [args...]
//   * The wrapper writes the spawned child's pid to <pidFile> immediately
//     after a successful spawn, so the harness can prove the group against
//     the REAL leader pid (on linux the leader pid differs from the
//     wrapper's own pid, which is what the harness tracks as its direct
//     child).
//   * stdio is inherited (the child shares the harness's stdin/stdout/
//     stderr, exactly like the old `exec setsid ...` path).
//   * The wrapper waits for the child and exits with its status (128+signum
//     when the child is killed by a signal, matching shell `wait`
//     convention), so the harness's `wait "$COMMAND_PID"` returns the
//     scenario command's real exit status.
//
// Zero tokens; confined to torture-test/. Node is a hard requirement of the
// harness (run-scripted-scenario refuses to run without node), so this
// wrapper adds no new runtime dependency.

import { spawn } from "node:child_process";
import fs from "node:fs";

const [pidFile, command, ...args] = process.argv.slice(2);
if (!pidFile || !command) {
  process.stderr.write("session-leader-spawn: usage: <pidFile> <command> [args...]\n");
  process.exit(2);
}

const child = spawn(command, args, { detached: true, stdio: "inherit" });

// The child is a session/group leader (detached:true -> setsid(2) before
// exec), so its pid IS the leader pid the harness must prove against.
fs.writeFileSync(pidFile, `${child.pid}\n`);

child.on("error", (error) => {
  process.stderr.write(`session-leader-spawn: cannot spawn ${command}: ${error.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    const signum = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }[signal] ?? 0;
    process.exit(128 + signum || 1);
  }
  process.exit(code ?? 1);
});
