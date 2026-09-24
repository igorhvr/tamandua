// Tier-2 STORM-REHEARSAL US-008 — numeric freeSlots admission snapshot (SF-3).
//
// Attempt 3 recorded every S9/S10 admission attempt with freeSlots=null: run
// creation is asynchronous ("pending admission; the reconciler will admit
// it"), the launch result carried no numeric freeSlots, and the DB read seam
// does not expose a slot count. decisionCorrectness was therefore null and the
// consistency gate (which requires true) failed. US-008 gives the engine a
// NUMERIC admission snapshot taken from the campaign's PRIVATE control plane
// at the moment of each S9/S10 attempt:
//
//     GET /control/limits -> { maxActiveTimers }
//     GET /control/jobs   -> { jobs: [...] }
//     freeSlots = maxActiveTimers - jobs.length
//
// Priority: the existing daemon-register-response path still WINS when it
// actually carries a numeric freeSlots; otherwise the control plane is queried
// per attempt (never once at round start). When the plane is
// unreachable/malformed the snapshot stays null with an explicit UNKNOWN basis
// and the attempt is left UNJUDGED — a fabricated 0/"green" is never recorded.
//
// This file is hermetic: pure/recording fakes plus ONE in-process loopback
// control-plane HTTP server (bound to 127.0.0.1:0) to exercise the real
// tt-storm-real.mjs seam. It never spawns a daemon/scheduler/harness/model and
// never touches live ~/.tamandua state.
//
// Coverage:
//   A1  resolveStormControlUrl precedence + fallbacks (explicit opts, state
//       controlUrl, bare control port, none);
//   A2  controlPlaneAdmissionSnapshot computes numeric freeSlots with basis
//       'control-plane:limits+jobs'; unwired/malformed/unreachable -> null;
//   A3  observeQueuedAdmission records a numeric snapshot PER ATTEMPT from the
//       control plane (S9 demand 7 queues at 0 free, S10 demand 1 admits at 7)
//       and queueVerdict reports decisionCorrectness true with judged >= 2;
//   A4  an unreachable/malformed plane yields freeSlots null with basis
//       'control-plane:UNKNOWN' and the attempt stays unjudged (verdict
//       decisionCorrectness null, judged 0);
//   A5  the daemon-register-response numeric path still wins (control plane is
//       not queried);
//   A6  the REAL tt-storm-real.mjs makeRealControlGet seam parses the private
//       control plane's JSON over loopback (sending the daemon-secret header)
//       and refuses non-loopback/unwired/unauthenticated targets.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  controlPlaneAdmissionSnapshot,
  observeQueuedAdmission,
  queueVerdict,
  resolveStormControlUrl,
} from "../bin/tt-storm-engine.mjs";
import { makeRealControlGet } from "../bin/tt-storm-real.mjs";

const CONTROL_URL = "http://127.0.0.1:45678/";

// In-memory fs: enough for saveState's write+rename (state persistence).
function makeFakeFs() {
  const files = new Map();
  return {
    files,
    writeFileSync: (p: string, data: unknown) => { files.set(String(p), String(data)); },
    renameSync: (from: string, to: string) => {
      files.set(String(to), files.get(String(from)));
      files.delete(String(from));
    },
    existsSync: (p: string) => files.has(String(p)),
    readFileSync: (p: string) => files.get(String(p)) ?? "",
    mkdirSync: () => {},
  };
}

function makeState() {
  return {
    campaign_id: "storm-admission-snapshot-test",
    source: { active_cap: 52 },
    daemon_ports: { dashboard: 1, mcp: 2, control: 45678, controlUrl: CONTROL_URL },
    queue: { attempts: [] as any[], s10_admitted_at: null, first_capacity_at: null },
    rounds: { A: { runs: {} as Record<string, any> } },
  };
}

function makeCtx(controlGet: any, { controlUrl = CONTROL_URL }: any = {}) {
  return {
    fs: makeFakeFs(),
    clock: { nowUtc: () => "2026-09-12T00:00:00.000Z", nowMs: () => 0, sleep: async () => {} },
    db: { open: () => ({ ok: false }) },
    proc: { controlGet },
    opts: { controlUrl },
  } as any;
}

function makeLaunch(rosterId: string, demand: number) {
  return { rosterId, run: `run-${rosterId}`, workflow: "feature-dev-merge-worktree", harness: "pi", queued: true, round: "A", demand, timers: demand };
}

function makeRunRec(rosterId: string) {
  return { rosterId, runId: null, status: "registered", admission: [] as any[] } as any;
}

const ops = { record: () => {} };

// A recording control plane with mutable limits/jobs; every GET is recorded.
function makeRecordingPlane(initial: any) {
  const limits = { maxActiveTimers: initial.maxActiveTimers };
  let jobs = { jobs: new Array(initial.jobs).fill({ id: "job" }) };
  const calls: string[] = [];
  const controlGet = async (url: string) => {
    calls.push(String(url));
    if (String(url).endsWith("/control/limits")) return { ok: true, statusCode: 200, latencyMs: 1, body: limits };
    if (String(url).endsWith("/control/jobs")) return { ok: true, statusCode: 200, latencyMs: 1, body: jobs };
    return { ok: false, statusCode: 404, latencyMs: 1, body: null, error: "not found" };
  };
  return {
    calls,
    limits,
    setJobs: (n: number) => { jobs = { jobs: new Array(n).fill({ id: "job" }) }; },
    setMax: (n: number) => { limits.maxActiveTimers = n; },
    controlGet,
  };
}

describe("tier2-storm-rehearsal-admission-snapshot (US-008, SF-3)", () => {
  it("A1: resolveStormControlUrl resolves the explicit override then state.daemon_ports", () => {
    // explicit ctx.opts.controlUrl wins
    assert.equal(
      resolveStormControlUrl({ opts: { controlUrl: "http://127.0.0.1:1111/" } }, { daemon_ports: { controlUrl: "http://127.0.0.1:2222/" } }),
      "http://127.0.0.1:1111/",
    );
    // state.daemon_ports.controlUrl when no explicit override
    assert.equal(resolveStormControlUrl({ opts: {} }, { daemon_ports: { controlUrl: CONTROL_URL } }), CONTROL_URL);
    // bare allocated control port derives a URL
    assert.equal(resolveStormControlUrl({ opts: {} }, { daemon_ports: { control: 4444 } }), "http://127.0.0.1:4444/");
    // nothing recorded / not wired -> null (UNKNOWN, never fabricated)
    assert.equal(resolveStormControlUrl({ opts: {} }, { daemon_ports: null }), null);
    assert.equal(resolveStormControlUrl({ opts: { controlUrl: "" } }, null), null);
  });

  it("A2: controlPlaneAdmissionSnapshot yields numeric freeSlots = maxActiveTimers - jobs", async () => {
    const plane = makeRecordingPlane({ maxActiveTimers: 52, jobs: 45 });
    const snap = await controlPlaneAdmissionSnapshot(makeCtx(plane.controlGet), makeState());
    assert.ok(snap, "snapshot present");
    assert.equal(snap.maxActiveTimers, 52);
    assert.equal(snap.scheduledJobs, 45);
    assert.equal(snap.freeSlots, 7);
    assert.equal(snap.basis, "control-plane:limits+jobs");
    assert.deepEqual(plane.calls, [`${CONTROL_URL}control/limits`, `${CONTROL_URL}control/jobs`]);
  });

  it("A2b: controlPlaneAdmissionSnapshot is null for unwired/unreachable/malformed planes", async () => {
    const state = makeState();
    // unwired: no controlGet seam
    assert.equal(await controlPlaneAdmissionSnapshot(makeCtx(undefined), state), null);
    // unreachable: seam throws
    assert.equal(await controlPlaneAdmissionSnapshot(makeCtx(async () => { throw new Error("ECONNREFUSED"); }), state), null);
    // malformed: 200 with a non-numeric maxActiveTimers
    assert.equal(await controlPlaneAdmissionSnapshot(makeCtx(async () => ({ ok: true, statusCode: 200, body: { maxActiveTimers: "many" } })), state), null);
    // malformed: jobs body is not an array
    const notArray = async (url: string) => (url.endsWith("/control/limits")
      ? { ok: true, statusCode: 200, body: { maxActiveTimers: 52 } }
      : { ok: true, statusCode: 200, body: { jobs: "none" } });
    assert.equal(await controlPlaneAdmissionSnapshot(makeCtx(notArray), state), null);
    // not wired at all: no resolvable URL even with a seam
    assert.equal(await controlPlaneAdmissionSnapshot(makeCtx(async () => ({ ok: true, statusCode: 200, body: {} })), { daemon_ports: null }), null);
  });

  it("A3: observeQueuedAdmission records a numeric per-attempt snapshot and queueVerdict judges it correct", async () => {
    const plane = makeRecordingPlane({ maxActiveTimers: 52, jobs: 52 }); // 0 free
    const ctx = makeCtx(plane.controlGet);
    const state = makeState();

    // S9 demands 7 timers: 0 free -> queue.
    const s9 = makeRunRec("S9");
    state.rounds.A.runs.S9 = s9;
    await observeQueuedAdmission(ctx, state, ops, makeLaunch("S9", 7), s9, "/tmp/campaign");
    assert.equal(s9.admission.length, 1);
    assert.equal(typeof s9.admission[0].freeSlots, "number");
    assert.equal(s9.admission[0].freeSlots, 0);
    assert.equal(s9.admission[0].freeSlotsBasis, "control-plane:limits+jobs");
    assert.equal(s9.admission[0].demandedTimers, 7);
    assert.equal(s9.admission[0].decision, "queue");
    assert.equal(s9.status, "queued");

    // Capacity frees before S10's attempt: 45 jobs -> 7 free. The SECOND
    // attempt sees the NEW number, proving the plane is queried per attempt
    // (decision time), not read once at round start.
    plane.setJobs(45);
    const s10 = makeRunRec("S10");
    state.rounds.A.runs.S10 = s10;
    await observeQueuedAdmission(ctx, state, ops, makeLaunch("S10", 1), s10, "/tmp/campaign");
    assert.equal(s10.admission.length, 1);
    assert.equal(s10.admission[0].freeSlots, 7);
    assert.equal(s10.admission[0].decision, "admit");
    assert.equal(s10.status, "admitted");

    // 2 attempts x 2 endpoints = the plane was asked at EACH decision.
    assert.equal(plane.calls.length, 4);

    const verdict = queueVerdict(state);
    assert.equal(verdict.decisionCorrectnessJudged, 2);
    assert.equal(verdict.decisionCorrectness, true);
    assert.equal(verdict.decisionCorrectnessUnjudged, 0);
    assert.equal(verdict.attempts.length, 2);
    for (const a of verdict.attempts) {
      assert.equal(typeof a.freeSlots, "number");
      assert.equal(a.decision === "admit", a.freeSlots >= a.demandedTimers);
    }
  });

  it("A4: unreachable/malformed control plane stays UNKNOWN and unjudged (never a fabricated number)", async () => {
    // The control plane is EXPECTED (controlUrl resolvable) but refuses.
    const ctx = makeCtx(async () => ({ ok: false, statusCode: 503, body: null, error: "unavailable" }));
    const state = makeState();
    const s9 = makeRunRec("S9");
    state.rounds.A.runs.S9 = s9;
    await observeQueuedAdmission(ctx, state, ops, makeLaunch("S9", 7), s9, "/tmp/campaign");

    const rec = s9.admission[0];
    assert.equal(rec.freeSlots, null, "freeSlots must stay null, never a fabricated 0");
    assert.equal(rec.freeSlotsBasis, "control-plane:UNKNOWN");
    assert.equal(rec.decision, "hold");
    assert.equal(s9.status, "queued");

    const verdict = queueVerdict(state);
    assert.equal(verdict.decisionCorrectness, null, "no numeric snapshot -> unjudged");
    assert.equal(verdict.decisionCorrectnessJudged, 0);
    assert.equal(verdict.decisionCorrectnessUnjudged, 1);
  });

  it("A5: the daemon-register-response numeric path wins and the control plane is not queried", async () => {
    const plane = makeRecordingPlane({ maxActiveTimers: 52, jobs: 45 });
    const ctx = makeCtx(plane.controlGet);
    const state = makeState();
    const s9 = makeRunRec("S9");
    state.rounds.A.runs.S9 = s9;
    // Product 202 queued response carries a numeric freeSlots: use it verbatim.
    await observeQueuedAdmission(ctx, state, ops, makeLaunch("S9", 7), s9, "/tmp/campaign", { admission: { state: "queued", freeSlots: 0, maxActiveTimers: 52 } });
    assert.equal(s9.admission[0].freeSlots, 0);
    assert.equal(s9.admission[0].freeSlotsBasis, "daemon-register-response:queued");
    assert.equal(plane.calls.length, 0, "control plane untouched when the register response carries freeSlots");
  });

  it("A6: the real makeRealControlGet seam parses loopback JSON and refuses non-loopback/unwired targets", async () => {
    // The private control plane authenticates with x-tamandua-secret (the
    // daemon's daemon-secret file); the seam reads it lazily and sends it when
    // the file exists.
    const SECRET = "unit-test-secret-token";
    const server = http.createServer((req, res) => {
      if (req.headers["x-tamandua-secret"] !== SECRET) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/control/limits") res.end(JSON.stringify({ maxActiveTimers: 52 }));
      else if (req.url === "/control/jobs") res.end(JSON.stringify({ jobs: [{ id: "a" }, { id: "b" }] }));
      else res.end(JSON.stringify({}));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-storm-admission-secret-"));
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const secretPath = path.join(tmp, "daemon-secret");
      fs.writeFileSync(secretPath, SECRET + "\n");
      const get = makeRealControlGet({ controlUrl: `http://127.0.0.1:${port}/`, secretPath });
      const limits = await get("/control/limits");
      assert.equal(limits.ok, true, `authenticated limits read: ${limits.error ?? ""}`);
      assert.equal(limits.body.maxActiveTimers, 52);
      const jobs = await get("/control/jobs");
      assert.equal(jobs.ok, true);
      assert.equal(jobs.body.jobs.length, 2);
      // Without the secret file the plane answers 401 -> ok:false (UNKNOWN),
      // never a fabricated number.
      const noSecret = await makeRealControlGet({ controlUrl: `http://127.0.0.1:${port}/`, secretPath: path.join(tmp, "absent") })("/control/limits");
      assert.equal(noSecret.ok, false);
      assert.equal(noSecret.statusCode, 401);
      // A relative path with no bound base is a first-class not-wired failure.
      const unwired = await makeRealControlGet({ controlUrl: null })("/control/limits");
      assert.equal(unwired.ok, false);
      assert.match(String(unwired.error), /no private control plane wired/);
      // Containment: an absolute non-loopback target is refused without fetch.
      const foreign = await makeRealControlGet({ controlUrl: null })("http://example.com/control/limits");
      assert.equal(foreign.ok, false);
      assert.match(String(foreign.error), /refused non-loopback host/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
