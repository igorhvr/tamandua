/**
 * Synthetic long-lived "service" process for the US-003 invocation-owned
 * lifecycle gate (tests/invocation-owned-lifecycle.test.ts).
 *
 * This is a TEST fixture, not a tamandua process: it imports no tamandua
 * module, binds only an ephemeral loopback port, and exits only when
 * signalled. It deliberately provides BOTH kinds of ownership evidence the
 * invocation-ownership observers consume:
 *
 *  - linux: the HOME entry in the process environ — the spawner passes
 *    HOME=<owned home>, read by src/lib/proc-info.ts getEnvironText through
 *    the linux observer;
 *  - darwin: an open file descriptor under the owned home (the marker fd),
 *    reported by `lsof -p <pid> -Fn` through the darwin observer.
 *
 * The process writes its exact pid and bound port into a READY file under
 * $HOME/.tamandua (SERVICE_READY_FILE is not used — the spawner computes the
 * path from HOME + label) so the spawner can wait deterministically (absolute
 * deadline) and then verify liveness via GET /health, which echoes the label,
 * the service token and the pid (identity proof, not inference).
 *
 * Reads from the environment:
 *   HOME           owned home directory (ownership evidence + file location)
 *   SERVICE_LABEL  label used for the pid/ready/open file names
 *   SERVICE_TOKEN  opaque token echoed by /health
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const home = process.env.HOME;
const label = process.env.SERVICE_LABEL ?? "owned-service";
const token = process.env.SERVICE_TOKEN ?? "no-token";

const tamanduaDir = path.join(home, ".tamandua");
fs.mkdirSync(tamanduaDir, { recursive: true });

fs.writeFileSync(path.join(tamanduaDir, `${label}.pid`), `${process.pid}\n`, "utf8");

// Darwin ownership evidence: keep this fd open under the owned home for the
// whole lifetime (the lsof observer strips the " (deleted)" marker, so even
// an unlinked file still proves the process held the path).
const markerFd = fs.openSync(path.join(tamanduaDir, `${label}.open`), "a");
fs.writeSync(markerFd, `start pid=${process.pid}\n`);

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/health/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, label, token, pid: process.pid }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
});

server.on("error", (err) => {
  process.stderr.write(`[${label}] server error: ${err.message}\n`);
  process.exit(2);
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const readyFile = path.join(tamanduaDir, `${label}.ready`);
  fs.writeFileSync(readyFile, JSON.stringify({ pid: process.pid, port }), "utf8");
});

// Keep the marker fd live so the darwin lsof observer always sees a current
// open file under the owned home. unref'd: the server holds the loop open;
// this timer only refreshes the ownership evidence.
const heartbeat = setInterval(() => {
  try {
    fs.writeSync(markerFd, `hb ${Date.now()}\n`);
  } catch {
    // fd already closed — nothing left to refresh.
  }
}, 1000);
heartbeat.unref();

process.on("SIGTERM", () => process.exit(0));
