/**
 * TIME-CLOCKS US-013 — cross-cutting wall-jump and mtime-tolerance regressions.
 *
 * This is the umbrella regression suite for the ONE time rule documented in
 * `src/lib/instant.ts` and `tests/MOTOR-CONTRACT.md`:
 *
 *   (1) In-process intervals/deadlines use the MONOTONIC clock, so a hostile
 *       wall-clock movement (a backward NTP step or a forward suspend/resume
 *       gap) may not make an elapsed/remaining value negative, inflated, or
 *       premature.
 *   (2) Values that must survive a restart (durable leases, staleness windows,
 *       crash-recovery reservations) keep wall-epoch semantics and are aged
 *       numerically through `instantAgeMs()`/`isOlderThan()` with an explicit
 *       documented tolerance.
 *   (3) File-mtime provenance (daemon pidfile / start lock, dsh session
 *       "created since spawn") keeps OS-epoch semantics but routes its
 *       age/since-spawn decision through the same helpers and tolerance.
 *
 * Coverage map:
 *   - backward + forward wall jumps on `Stopwatch`/`Deadline` (injected and
 *     production-default clocks);
 *   - a forward + backward wall jump on the dispatch instant-fail backoff gate
 *     (`armInstantFailBackoff` / `isInstantFailBackoffActive`);
 *   - a forward wall jump on the dashboard runs cache TTL;
 *   - a forward + backward wall jump on the durable harness-probe reservation;
 *   - a durable lease compared with and without the explicit tolerance under
 *     an injected now;
 *   - daemonctl pidfile / start-lock mtime tolerance exactly at, just inside
 *     and just outside the boundary (real `fs.statSync` mtimes);
 *   - dsh session attribution mtime tolerance exactly at, just inside and just
 *     outside `DSH_SESSION_MTIME_TOLERANCE_MS` (real `fs.utimesSync` mtimes).
 *
 * Determinism: every simulation uses an injected clock or an injected
 * `nowMs`; the only real waits are two tiny bounded (< 100ms) timers. No live
 * daemon, no real model, and no production port is touched.
 *
 * Serial-lane file: importing `agent-scheduler` / `harness-probe` /
 * `daemonctl` / `dsh-usage` reaches their `node:child_process` dependency, so
 * it is listed in tests/serial-files.txt.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { createTempHome } from "./helpers/test-env.ts";
import { tamanduaTempDir } from "../dist/lib/temp-dir.js";
import { assertStatePathIsolation } from "../dist/lib/test-guard.js";
import {
  monotonicNow,
  Stopwatch,
  Deadline,
  instantAgeMs,
  isOlderThan,
} from "../dist/lib/instant.js";
import { closeDb, getDb } from "../dist/db.js";
import {
  armInstantFailBackoff,
  isInstantFailBackoffActive,
  _instantFailStreakFor,
  _resetInstantFailStreaks,
  armPreclaimDeathBackoff,
  isPreclaimDeathBackoffActive,
  _preclaimDeathStreakFor,
  _resetPreclaimDeathStreaks,
} from "../dist/installer/agent-scheduler.js";
import {
  createDashboardServer,
  invalidateRunsCache,
  _runsCacheTimestampForTest,
} from "../dist/server/dashboard.js";
import { reserveHarnessProbe } from "../dist/installer/harness-probe.js";
import {
  PIDFILE_AGE_SLACK_SECONDS,
  START_LOCK_STALE_MS,
  _pidfileProvenanceMatchesForTest,
  _startLockIsStaleForTest,
} from "../dist/server/daemonctl.js";
import {
  DSH_SESSION_MTIME_TOLERANCE_MS,
  DSH_V3_LOG_PLAIN,
  dshSessionProjectDir,
  lookupDshSessionTokens,
} from "../dist/installer/dsh-usage.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ── State isolation (temp HOME / state / DB; no live instance) ──────

const th = createTempHome("tamandua-us013-");
const savedEnv = {
  HOME: process.env.HOME,
  TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
  TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
};

before(() => {
  process.env.HOME = th.homeDir;
  process.env.TAMANDUA_STATE_DIR = th.tamanduaDir;
  process.env.TAMANDUA_DB_PATH = path.join(th.tamanduaDir, "tamandua.db");
  assertStatePathIsolation(process.env.TAMANDUA_STATE_DIR, "US-013 test state");
  assertStatePathIsolation(process.env.TAMANDUA_DB_PATH, "US-013 test database");
});

after(() => {
  closeDb();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(th.root, { recursive: true, force: true });
});

/** Run `fn` with `Date.now` shifted by `offsetMs`, always restoring it. */
function withWallJump<T>(offsetMs: number, fn: () => T): T {
  const realDateNow = Date.now;
  try {
    Date.now = () => realDateNow() + offsetMs;
    return fn();
  } finally {
    Date.now = realDateNow;
  }
}

/** Run `fn` with `Date.now` pinned to an exact absolute wall instant. */
function withWallNow<T>(nowMs: number, fn: () => T): T {
  const realDateNow = Date.now;
  try {
    Date.now = () => nowMs;
    return fn();
  } finally {
    Date.now = realDateNow;
  }
}

/** Minimal GET that avoids undici (whose internals also read `Date.now`). */
function httpGetBody(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
  });
}

// ── (a) Monotonic Stopwatch / Deadline under wall jumps ─────────────

describe("US-013 monotonic stopwatch and deadline survive wall jumps", () => {
  it("a backward wall jump never makes a stopwatch elapsed negative or change it", () => {
    let monotonicMs = 5_000;
    const watch = new Stopwatch(() => monotonicMs);

    withWallJump(-26 * 60 * 60 * 1000, () => {
      monotonicMs += 250;
      const elapsed = watch.elapsedMs();
      assert.equal(elapsed, 250, "elapsed must equal the monotonic advance, not the wall delta");
      assert.ok(elapsed >= 0, "elapsed must never go negative");
    });
  });

  it("a forward wall jump does not inflate a stopwatch elapsed", () => {
    let monotonicMs = 5_000;
    const watch = new Stopwatch(() => monotonicMs);

    withWallJump(3 * DAY_MS, () => {
      monotonicMs += 100;
      assert.equal(watch.elapsedMs(), 100, "a forward wall jump must not inflate elapsed");
    });
  });

  it("a backward wall jump does not extend (or prematurely expire) a monotonic deadline", () => {
    let monotonicMs = 1_000;
    const deadline = new Deadline(500, () => monotonicMs);

    withWallJump(-5 * DAY_MS, () => {
      assert.equal(deadline.remainingMs(), 500, "remaining must not jump up on a backward step");
      assert.equal(deadline.expired(), false);
      monotonicMs += 499;
      assert.equal(deadline.remainingMs(), 1);
      assert.equal(deadline.expired(), false, "the deadline must not expire early");
      monotonicMs += 1;
      assert.equal(deadline.remainingMs(), 0);
      assert.equal(deadline.expired(), true, "the deadline expires exactly at the monotonic budget");
    });
  });

  it("a forward wall jump does not shorten a monotonic deadline", () => {
    let monotonicMs = 0;
    const deadline = new Deadline(500, () => monotonicMs);

    withWallJump(365 * DAY_MS, () => {
      assert.equal(deadline.remainingMs(), 500, "remaining must not shrink on a forward step");
      assert.equal(deadline.expired(), false);
      monotonicMs += 200;
      assert.equal(deadline.remainingMs(), 300);
      assert.equal(deadline.expired(), false);
    });
  });

  it("the production default monotonic clock ignores a backward Date.now jump", async () => {
    const watch = new Stopwatch(); // default: monotonicNow()

    const realDateNow = Date.now;
    try {
      Date.now = () => realDateNow() - 26 * 60 * 60 * 1000;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const elapsed = watch.elapsedMs();
      assert.ok(elapsed >= 10, `elapsed ${elapsed} must advance with real time`);
      assert.ok(elapsed < 5_000, `elapsed ${elapsed} must not be inflated by the wall jump`);
    } finally {
      Date.now = realDateNow;
    }
  });
});

// ── (b) Dispatch instant-fail backoff gate ─────────────────────────

describe("US-013 dispatch instant-fail backoff gate is monotonic", () => {
  after(() => {
    _resetInstantFailStreaks();
  });

  it("a forward wall jump cannot release the armed backoff gate", () => {
    const deadline = armInstantFailBackoff("us013-forward-job", 6, 60_000);
    const streak = _instantFailStreakFor("us013-forward-job");
    assert.ok(streak, "arming must record a streak");
    assert.ok(
      deadline < 1e12,
      `the armed deadline ${deadline} must be a monotonic reading, not an epoch instant`,
    );

    withWallJump(30 * DAY_MS, () => {
      assert.equal(
        isInstantFailBackoffActive(streak),
        true,
        "a forward wall jump must not open the monotonic backoff gate",
      );
      assert.equal(
        isInstantFailBackoffActive(streak, monotonicNow()),
        true,
        "the production gate (explicit monotonicNow) must stay closed",
      );
    });
  });

  it("a backward wall jump cannot extend the backoff gate", async () => {
    armInstantFailBackoff("us013-backward-job", 6, 30);
    const streak = _instantFailStreakFor("us013-backward-job");
    assert.ok(streak);

    await new Promise((resolve) => setTimeout(resolve, 60));

    withWallJump(-30 * DAY_MS, () => {
      assert.equal(
        isInstantFailBackoffActive(streak),
        false,
        "after 30ms of real time the gate must open; a backward wall jump must not extend it",
      );
    });
  });
});

// ── (b) Dispatch pre-claim-death backoff gate (OUTAGE-ROUNDS SCLS US-005) ──

describe("US-013 dispatch pre-claim-death backoff gate is monotonic", () => {
  after(() => {
    _resetPreclaimDeathStreaks();
  });

  it("a forward wall jump cannot release the armed pre-claim-death backoff gate", () => {
    const deadline = armPreclaimDeathBackoff("us013-preclaim-forward-job", 6, 60_000);
    const streak = _preclaimDeathStreakFor("us013-preclaim-forward-job");
    assert.ok(streak, "arming must record a streak");
    assert.ok(
      deadline < 1e12,
      `the armed deadline ${deadline} must be a monotonic reading, not an epoch instant`,
    );

    withWallJump(30 * DAY_MS, () => {
      assert.equal(
        isPreclaimDeathBackoffActive(streak),
        true,
        "a forward wall jump must not open the monotonic pre-claim-death backoff gate",
      );
      assert.equal(
        isPreclaimDeathBackoffActive(streak, monotonicNow()),
        true,
        "the production gate (explicit monotonicNow) must stay closed",
      );
    });
  });

  it("a backward wall jump cannot extend the pre-claim-death backoff gate", async () => {
    armPreclaimDeathBackoff("us013-preclaim-backward-job", 6, 30);
    const streak = _preclaimDeathStreakFor("us013-preclaim-backward-job");
    assert.ok(streak);

    await new Promise((resolve) => setTimeout(resolve, 60));

    withWallJump(-30 * DAY_MS, () => {
      assert.equal(
        isPreclaimDeathBackoffActive(streak),
        false,
        "after 30ms of real time the gate must open; a backward wall jump must not extend it",
      );
    });
  });
});

// ── (b) Dashboard runs cache TTL ───────────────────────────────────

describe("US-013 dashboard runs cache TTL is monotonic", () => {
  it("a forward wall jump does not expire or re-stamp a fresh cache entry", async () => {
    invalidateRunsCache();
    const server = createDashboardServer(0);
    try {
      if (!server.listening) await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const url = `http://127.0.0.1:${address.port}/api/runs`;

      await httpGetBody(url);
      const ts1 = _runsCacheTimestampForTest();
      assert.ok(ts1 !== null, "the first /api/runs response must populate the cache");
      assert.ok(
        ts1 < 1e12,
        `cache timestamp ${ts1} must be a monotonic reading, not an epoch instant`,
      );

      await withWallJumpAsync(30 * DAY_MS, () => httpGetBody(url));

      assert.equal(
        _runsCacheTimestampForTest(),
        ts1,
        "a forward wall jump must not expire a still-fresh monotonic cache entry",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/** `withWallJump` for an async body. */
async function withWallJumpAsync<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
  const realDateNow = Date.now;
  try {
    Date.now = () => realDateNow() + offsetMs;
    return await fn();
  } finally {
    Date.now = realDateNow;
  }
}

// ── (b) Durable harness-probe reservation ──────────────────────────

describe("US-013 harness-probe reservation staleness under wall jumps", () => {
  function insertRun(runId: string): void {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) " +
          "VALUES (?, 'feature-dev-merge', 'US-013 probe reservation test', 'running', '{}', ?, ?)",
      )
      .run(runId, now, now);
  }

  it("a forward wall jump inside the wall keeps the reservation fresh; beyond the wall it reclaims it", () => {
    insertRun("us013-probe-forward");
    const t0 = Date.UTC(2026, 8, 3, 12, 0, 0);
    assert.equal(
      reserveHarnessProbe("us013-probe-forward", { wallMs: 1_000, nowMs: t0 }),
      true,
      "the first caller must win the reservation",
    );

    // Rule 2: the reservation is a DURABLE crash-recovery lease, so wall time
    // (not monotonic time) governs — a forward wall jump past the wall makes a
    // crashed reservation reclaimable; one inside the wall does not.
    withWallNow(t0 + 500, () => {
      assert.equal(
        reserveHarnessProbe("us013-probe-forward", { wallMs: 1_000 }),
        false,
        "inside the crash-recovery wall the lease is still fresh",
      );
    });
    withWallNow(t0 + 2_000, () => {
      assert.equal(
        reserveHarnessProbe("us013-probe-forward", { wallMs: 1_000 }),
        true,
        "beyond the crash-recovery wall the stale reservation is reclaimable",
      );
    });
  });

  it("a backward wall jump never makes a fresh reservation stale", () => {
    insertRun("us013-probe-backward");
    const t0 = Date.UTC(2026, 8, 3, 12, 0, 0);
    assert.equal(
      reserveHarnessProbe("us013-probe-backward", { wallMs: 1_000, nowMs: t0 }),
      true,
    );

    withWallNow(t0 - 30 * DAY_MS, () => {
      assert.equal(
        reserveHarnessProbe("us013-probe-backward", { wallMs: 1_000 }),
        false,
        "a backward wall jump must not release a fresh durable lease",
      );
    });
  });
});

// ── (c) Durable lease ages with and without tolerance ──────────────

describe("US-013 durable lease ages are numeric and honor explicit tolerance", () => {
  const LEASE_MS = 5 * 60 * 1000;
  const CLAIM_TOLERANCE_MS = 1_000;
  const STORED_ISO = "2026-09-15T12:00:00.000Z";
  const STORED_MS = Date.parse(STORED_ISO);

  it("computes a signed age against an injected now (never a string comparison)", () => {
    assert.equal(instantAgeMs(STORED_ISO, STORED_MS + 30_000), 30_000);
    assert.equal(instantAgeMs(STORED_ISO, STORED_MS - 30_000), -30_000);
  });

  it("without tolerance the boundary is strict: exactly at the lease is fresh, +1ms is stale", () => {
    assert.equal(
      isOlderThan(STORED_ISO, LEASE_MS, STORED_MS + LEASE_MS),
      false,
      "exactly at the threshold is NOT older (strict comparison)",
    );
    assert.equal(isOlderThan(STORED_ISO, LEASE_MS, STORED_MS + LEASE_MS - 1), false);
    assert.equal(isOlderThan(STORED_ISO, LEASE_MS, STORED_MS + LEASE_MS + 1), true);
  });

  it("with tolerance the stale window widens by exactly the documented slack", () => {
    const atWidenedBoundary = STORED_MS + LEASE_MS + CLAIM_TOLERANCE_MS;
    assert.equal(
      isOlderThan(STORED_ISO, LEASE_MS, atWidenedBoundary, CLAIM_TOLERANCE_MS),
      false,
      "the tolerance widens the window to maxAge + tolerance",
    );
    assert.equal(isOlderThan(STORED_ISO, LEASE_MS, atWidenedBoundary - 1, CLAIM_TOLERANCE_MS), false);
    assert.equal(isOlderThan(STORED_ISO, LEASE_MS, atWidenedBoundary + 1, CLAIM_TOLERANCE_MS), true);
  });

  it("a backward injected now makes an old lease look fresh; a forward one makes it stale", () => {
    assert.equal(isOlderThan(STORED_ISO, LEASE_MS, STORED_MS - 30 * DAY_MS), false);
    assert.equal(instantAgeMs(STORED_ISO, STORED_MS - 1_000), -1_000);
    assert.equal(isOlderThan(STORED_ISO, LEASE_MS, STORED_MS + LEASE_MS + 1), true);
  });

  it("a forward WALL jump expires a durable lease through the default now", () => {
    withWallNow(STORED_MS + LEASE_MS + 1, () => {
      assert.equal(
        isOlderThan(STORED_ISO, LEASE_MS),
        true,
        "rule 2: a durable lease tracks wall time, so a forward wall jump expires it",
      );
    });
    withWallNow(STORED_MS + LEASE_MS - 1, () => {
      assert.equal(
        isOlderThan(STORED_ISO, LEASE_MS),
        false,
        "just inside the lease the durable instant is still fresh",
      );
    });
  });

  it("an unparseable stored instant is never stale and never fabricates an age", () => {
    assert.equal(instantAgeMs("not-an-instant", STORED_MS), undefined);
    assert.equal(instantAgeMs(undefined, STORED_MS), undefined);
    assert.equal(isOlderThan("not-an-instant", LEASE_MS, STORED_MS), false);
  });
});

// ── Rule 3: daemonctl pidfile / start-lock mtime tolerance ─────────

describe("US-013 daemonctl file-mtime provenance tolerance boundaries", () => {
  it("pidfile provenance: at, just inside and just outside PIDFILE_AGE_SLACK_SECONDS", () => {
    const dir = tamanduaTempDir("tamandua-us013-pidfile-");
    try {
      const pidFile = path.join(dir, "daemon.pid");
      fs.writeFileSync(pidFile, "4242\n");
      const mtimeMs = fs.statSync(pidFile).mtimeMs;
      const elapsedSeconds = 12;
      const atBoundary = mtimeMs + (elapsedSeconds + PIDFILE_AGE_SLACK_SECONDS) * 1_000;

      assert.equal(
        _pidfileProvenanceMatchesForTest(mtimeMs, elapsedSeconds, atBoundary),
        true,
        "exactly at the pidfile slack is NOT older (strict >)",
      );
      assert.equal(
        _pidfileProvenanceMatchesForTest(mtimeMs, elapsedSeconds, atBoundary - 1),
        true,
        "just inside the pidfile slack matches provenance",
      );
      assert.equal(
        _pidfileProvenanceMatchesForTest(mtimeMs, elapsedSeconds, atBoundary + 1),
        false,
        "just outside the pidfile slack refuses provenance",
      );
      assert.equal(
        _pidfileProvenanceMatchesForTest(mtimeMs, null, atBoundary),
        false,
        "an unknown process age must refuse provenance",
      );
      assert.equal(
        _pidfileProvenanceMatchesForTest(Number.NaN, elapsedSeconds, atBoundary),
        false,
        "an un-ageable mtime must refuse provenance",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("start-lock staleness: at, just inside and just outside START_LOCK_STALE_MS", () => {
    const dir = tamanduaTempDir("tamandua-us013-startlock-");
    try {
      const lockFile = path.join(dir, "start.lock");
      fs.writeFileSync(lockFile, "");
      const mtimeMs = fs.statSync(lockFile).mtimeMs;
      const atBoundary = mtimeMs + START_LOCK_STALE_MS;

      assert.equal(
        _startLockIsStaleForTest(mtimeMs, atBoundary),
        false,
        "exactly at the stale threshold is NOT stale (strict >)",
      );
      assert.equal(
        _startLockIsStaleForTest(mtimeMs, atBoundary - 1),
        false,
        "just inside the threshold is NOT stale",
      );
      assert.equal(
        _startLockIsStaleForTest(mtimeMs, atBoundary + 1),
        true,
        "just outside the threshold IS stale",
      );
      assert.equal(
        _startLockIsStaleForTest(Number.NaN, atBoundary),
        false,
        "an un-ageable mtime is never stale",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Rule 3: dsh session attribution mtime tolerance ────────────────

describe("US-013 dsh session attribution mtime tolerance boundaries", () => {
  function headerLine(id: string): string {
    return (
      JSON.stringify({ type: "session", version: 3, id, createdAt: 1, delegationDepth: 0 }) + "\n"
    );
  }

  function usageLine(input: number, output: number): string {
    return (
      JSON.stringify({
        type: "assistant/message",
        seq: 0,
        time: 1_700_000_000_000,
        data: {
          turn: 1,
          step: 1,
          message: { role: "assistant", content: [] },
          usage: { inputTokens: input, outputTokens: output },
        },
      }) + "\n"
    );
  }

  /**
   * Stage one plain-v3 session directory whose mtime is `ageMs` before the
   * passed spawn instant, then resolve tokens for that spawn instant. The
   * spawn timestamp is derived from the REAL `fs.statSync` mtime, so the
   * "exactly at the tolerance" case is exact regardless of fs rounding.
   */
  async function lookupAtAge(ageMs: number) {
    const root = tamanduaTempDir("tamandua-us013-dsh-");
    try {
      const dshHome = path.join(root, "dsh-home");
      const workdir = path.join(root, "worktree", "repo");
      const sessionName = "session-us013";
      const sessionDir = path.join(dshSessionProjectDir(dshHome, workdir), sessionName);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, DSH_V3_LOG_PLAIN),
        headerLine(sessionName) + usageLine(40, 2),
      );

      const fixed = new Date(1_700_000_000_000);
      fs.utimesSync(sessionDir, fixed, fixed);
      const mtimeMs = fs.statSync(sessionDir).mtimeMs;

      return await lookupDshSessionTokens({
        spawnedAtMs: mtimeMs + ageMs,
        workdir,
        env: { DSH_HOME: dshHome, PATH: process.env.PATH },
        zstdStrategy: "none",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it("includes a session at the tolerance boundary and just inside it", async () => {
    const atBoundary = await lookupAtAge(DSH_SESSION_MTIME_TOLERANCE_MS);
    assert.ok(atBoundary, "an mtime exactly at the tolerance is eligible (age <= tolerance)");
    assert.equal(atBoundary.totalTokens, 42);
    assert.equal(atBoundary.sessionRef, "session-us013");

    const justInside = await lookupAtAge(DSH_SESSION_MTIME_TOLERANCE_MS - 1_000);
    assert.ok(justInside, "an mtime just inside the tolerance is eligible");
    assert.equal(justInside.totalTokens, 42);
  });

  it("excludes a session just outside the tolerance (never a fabricated total)", async () => {
    const justOutside = await lookupAtAge(DSH_SESSION_MTIME_TOLERANCE_MS + 1_000);
    assert.equal(justOutside, null, "a session beyond the mtime tolerance must not be attributed");
  });
});
