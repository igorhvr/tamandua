// transport.mjs — zero-token transport boundary for the aged-state generator.
//
// Two distinct pieces:
//
// 1) NonDispatchingTransportServer — an explicitly LABELED, narrowly owned
//    NON-DISPATCHING registration-transport test double.  runWorkflow and the
//    real lifecycle functions (stopWorkflow / forceFailRun / advancePipeline
//    teardown) talk to the daemon control plane through control-client; the
//    double answers ONLY health / register / terminate / nudge with 2xx
//    receipts and performs NO scheduling, NO admission mutation, NO dispatch,
//    NO harness probe.  This keeps run creation through the REAL
//    runWorkflow/step-ops writers while guaranteeing zero model dispatch and
//    zero tokens.  It is a transport stub, NOT a claim of motor qualification
//    (CORE-MOTOR separately owns that).  Every request is journaled.
//
//    Anything that would pretend a real state transition occurred through
//    this boundary fails closed: pause/resume/suite endpoints return 501 and
//    are never faked here (real paused transitions go through the product's
//    control-server handlers via RealControlFacade).
//
// 2) RealControlFacade — hosts the REAL product control server (imported from
//    the pinned dist) on a random port with the private DB, so pausing a seed
//    run executes the actual product /control/pause-run handler.  The facade
//    is only ever asked for pause/resume; register-run is never sent to it
//    (runWorkflow's registration goes to the double), so the real server can
//    never schedule dispatch from a seed phase.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { utcNow, appendJsonl } from "./seedcommon.mjs";

export const TRANSPORT_LABEL = "aged-seed-non-dispatching-transport-double";
// Product-native pause/resume/stop/fail handler claims are NOT made through
// the double; endpoint returning 501 below documents that boundary.
const FAIL_CLOSED_ENDPOINTS = new Set([
  "/control/pause-run",
  "/control/resume-run",
  "/suite/lookup",
  "/suite/record",
  "/suite/claim",
  "/suite/release",
  "/suite/event",
  "/suite/flaky",
  "/suite/duration-history",
  "/suite/release-owner",
]);

export class NonDispatchingTransportServer {
  constructor({ port, secret, receiptDir, label = TRANSPORT_LABEL }) {
    this.port = port;
    this.secret = secret;
    this.receiptDir = receiptDir;
    this.label = label;
    this.receiptFile = path.join(receiptDir, `transport-${label}.jsonl`);
    this.counts = { health: 0, register: 0, terminate: 0, nudge: 0, refused: 0, failClosed: 0 };
    this.server = null;
  }

  _journal(method, pathname, status, body) {
    this.counts.total = (this.counts.total ?? 0) + 1;
    appendJsonl(this.receiptFile, {
      ts_utc: utcNow(),
      transport: this.label,
      method,
      path: pathname,
      status,
      body,
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const respond = (status, body) => {
          res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(body));
        };
        const url = req.url ?? "/";
        const method = req.method ?? "GET";
        const pathname = url.split("?")[0];

        const note = {
          transport: this.label,
          note: "registration-transport receipt only: NO scheduling, NO admission mutation, NO dispatch, NO harness probe performed",
        };

        if (pathname === "/control/health" && method === "GET") {
          this.counts.health += 1;
          this._journal(method, pathname, 200, {});
          respond(200, { status: "ok", pid: process.pid, timestamp: new Date().toISOString(), ...note });
          return;
        }
        if (this.secret) {
          const provided = req.headers["x-tamandua-secret"];
          const got = Array.isArray(provided) ? provided[0] : provided;
          if (got !== this.secret) {
            this.counts.refused += 1;
            this._journal(method, pathname, 401, { error: "Unauthorized" });
            respond(401, { error: "Unauthorized" });
            return;
          }
        }
        if (method === "POST") {
          let body = {};
          const chunks = [];
          req.on("data", (c) => chunks.push(c));
          req.on("end", () => {
            try {
              const raw = Buffer.concat(chunks).toString("utf-8");
              if (raw.trim()) body = JSON.parse(raw);
            } catch {
              body = { _parse_error: true };
            }
            this._handlePost(pathname, body, respond);
          });
          return;
        }
        if (pathname === "/control/limits" && method === "GET") {
          respond(200, { maxActiveTimers: 50 });
          return;
        }
        this.counts.failClosed += 1;
        this._journal(method, pathname, 404, { error: "not found on non-dispatching transport double" });
        respond(404, { error: `Not found on ${this.label}: ${method} ${pathname}` });
      });

      this.server = server;
      server.on("error", reject);
      server.listen(this.port, "127.0.0.1", () => resolve(server));
    });
  }

  _handlePost(pathname, body, respond) {
    const note = {
      transport: this.label,
      note: "registration-transport receipt only: NO scheduling, NO admission mutation, NO dispatch, NO harness probe performed",
    };
    if (pathname === "/control/register-run") {
      this.counts.register += 1;
      this._journal("POST", pathname, 202, { body });
      respond(202, {
        state: "active",
        requiredTimers: 0,
        maxActiveTimers: 50,
        receivedRunId: typeof body.runId === "string" ? body.runId : null,
        ...note,
      });
      return;
    }
    if (pathname === "/control/terminate-run") {
      this.counts.terminate += 1;
      this._journal("POST", pathname, 200, { body });
      respond(200, { terminated: true, ...note });
      return;
    }
    if (pathname === "/control/nudge") {
      this.counts.nudge += 1;
      this._journal("POST", pathname, 200, { body });
      respond(200, { nudged: true, ...note });
      return;
    }
    if (FAIL_CLOSED_ENDPOINTS.has(pathname)) {
      this.counts.failClosed += 1;
      this._journal("POST", pathname, 501, { body });
      respond(501, {
        error: `${this.label} never applies real state transitions; ${pathname} must go through the real product control-server handler (RealControlFacade) or the real lifecycle function`,
      });
      return;
    }
    this.counts.failClosed += 1;
    this._journal("POST", pathname, 404, { body });
    respond(404, { error: `Not found on ${this.label}: POST ${pathname}` });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}

// ── Real control-server facade ─────────────────────────────────────────

function httpJson(method, port, pathname, body, secret, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        method,
        hostname: "127.0.0.1",
        port,
        path: pathname,
        headers: {
          "content-type": "application/json",
          ...(secret ? { "x-tamandua-secret": secret } : {}),
          ...(payload ? { "content-length": Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let parsed = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } catch {
            /* raw body left empty */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("real control facade timeout"));
      resolve(null);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export class RealControlFacade {
  constructor({ port, secret, productDist }) {
    this.port = port;
    this.secret = secret;
    this.productDist = productDist;
    this.server = null;
  }

  async start() {
    const { createControlServer } = await import(
      new URL(`file://${path.join(this.productDist, "server/control-server.js")}`).href
    );
    this.server = createControlServer({ port: this.port, secret: this.secret });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.once("listening", resolve);
    });
    return this.server;
  }

  async pauseRun(runId, requestedBy = "aged-seed") {
    const r = await httpJson("POST", this.port, "/control/pause-run", { runId, requestedBy }, this.secret);
    return r;
  }

  async resumeRun(runId, requestedBy = "aged-seed") {
    const r = await httpJson("POST", this.port, "/control/resume-run", { runId, requestedBy }, this.secret);
    return r;
  }

  close() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}
