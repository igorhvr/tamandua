/**
 * NAT-EGRESS US-009 — retention and anti-widening regression coverage.
 *
 * The network mode is chosen ONCE, when a run/session is created, and persisted
 * as the optional `networkOutbound` field on `runs.matchlock_policy`. This file
 * covers the two properties that matter operationally:
 *
 *   RETENTION      a stored NAT mode survives every later launch of that run
 *                  (queued dispatch, step retry, resume, daemon restart) because
 *                  each launch RE-PARSES the stored policy and never re-resolves
 *                  from current flags/environment. `intercept:false` must reach
 *                  the shared create composer every time.
 *   ANTI-WIDENING  an INTERCEPTED run can never be widened into NAT by a
 *                  replacement/rugpull performed while the environment/flag
 *                  selects unrestricted. An inherited policy without the field
 *                  is authoritative: absence means interception, full stop.
 *                  The mirror case (NAT run replaced with no flags) stays NAT.
 *
 * Everything is exercised at the PURE seams the product uses:
 *   - `buildMatchlockPolicy` / `serializeMatchlockPolicy` / `parseMatchlockPolicy`
 *     (the persisted record),
 *   - `resolveMatchlockNetworkOutbound` + `resolveAdmissionNetworkOutbound`
 *     (the ONLY admission-time mode decision),
 *   - `buildMatchlockCreateConfig` (the ONE scheduler-side create composer).
 * One test additionally drives the REAL `resumeWorkflow` against a disposable
 * DB and an in-process fake control plane (no daemon, no VM, no real matchlock
 * binary; the swap handshake and inherited-image verifier are injected) to prove
 * a plain resume leaves the stored policy string byte-for-byte unchanged.
 *
 * Serial lane: importing `run.js` reaches child_process-owning modules, so this
 * file is registered in `tests/serial-files.txt`. All HOME/state/DB overrides
 * are scoped to this test process and use a SHORT disposable directory.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  MATCHLOCK_POLICY_VERSION,
  buildMatchlockPolicy,
  parseMatchlockPolicy,
  serializeMatchlockPolicy,
  type ExecutionIsolation,
} from "../../../dist/installer/matchlock/policy.js";
import {
  MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV,
  resolveMatchlockNetworkOutbound,
  type ResolvedMatchlockNetworkOutbound,
} from "../../../dist/installer/matchlock/network-outbound.js";
import { resolveAdmissionNetworkOutbound } from "../../../dist/installer/matchlock/admission.js";
import { buildMatchlockCreateConfig } from "../../../dist/installer/matchlock/mount-plan.js";
import { PREP_STATE_CAPABILITY } from "../../../dist/installer/matchlock/prep-state.js";
import { getDb } from "../../../dist/db.js";
import { resumeWorkflow } from "../../../dist/installer/run.js";

const IDENTITY = {
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  config_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  tag: "vic/ml:latest",
};

/** The exact d8047aa5 default (intercepted) wire block. */
const GOLDEN_INTERCEPTED_NETWORK = {
  block_private_ips: true,
  intercept: true,
  dns_priority: "ipv4",
};

/** The unrestricted wire block: interception-only fields are ABSENT. */
const GOLDEN_UNRESTRICTED_NETWORK = {
  block_private_ips: false,
  intercept: false,
};

let tmpRoot: string;
let configRoot: string;
let workDir: string;
let helperPack: string;

/** Build a valid v3 pi policy with the same fixed identity/scope as production. */
function buildPolicy(over: Record<string, unknown> = {}): ExecutionIsolation {
  return buildMatchlockPolicy({
    requestedImage: "vic/ml:latest",
    identity: IDENTITY,
    harness: "pi",
    workingDirectory: workDir,
    originalRepositoryRoot: workDir,
    workMounts: [{ hostPath: workDir, hostRealPath: workDir, guestPath: workDir }],
    gitMetadataRoots: [],
    configurationRoot: configRoot,
    configurationProfile: "settings.json",
    ...over,
  } as Parameters<typeof buildMatchlockPolicy>[0]);
}

/**
 * One later launch: a fresh column READ (`parseMatchlockPolicy` on the stored
 * string) followed by the shared create composition. Nothing here consults the
 * ambient environment, which is exactly the contract under test.
 */
function composeStored(stored: string): {
  policy: ExecutionIsolation;
  network: Record<string, unknown>;
} {
  const policy = parseMatchlockPolicy(stored);
  const cfg = buildMatchlockCreateConfig(policy, IDENTITY, { helperPackHostPath: helperPack });
  return { policy, network: (cfg.network ?? {}) as Record<string, unknown> };
}

/**
 * Emulate the admission WRITE for one launch: the inherited policy is run
 * through the ONE mode decision and the result is persisted on a fresh record.
 * This mirrors `admitMatchlockRun` (resolveAdmissionNetworkOutbound ->
 * buildMatchlockPolicy) without any RPC/VM.
 */
function admitWrite(
  inherited: ExecutionIsolation | undefined,
  supplied: ResolvedMatchlockNetworkOutbound | undefined,
): ExecutionIsolation {
  const effective = resolveAdmissionNetworkOutbound(inherited, supplied);
  return buildPolicy(effective !== undefined ? { networkOutbound: effective } : {});
}

/**
 * Project a built v3 record back to the ORIGINAL v2 stored shape (SHARED-V3
 * additions stripped, version stamped 2) so the v2 READ path is exercised on a
 * real record rather than a hand-rolled mutation.
 */
function asV2Record(p: ExecutionIsolation): Record<string, unknown> {
  const record = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  record.version = 2;
  for (const key of [
    "requestedImageSource",
    "rootUsageConsent",
    "matchlockPrivileged",
    "matchlockDnsPriority",
    "networkOutbound",
  ]) {
    delete record[key];
  }
  delete (record.resourceLimits as Record<string, unknown>).swapMB;
  return record;
}

// ── fake control plane (in-process; no daemon) ─────────────────────────────

interface FakeControlPlane {
  port: number;
  close: () => Promise<void>;
}

async function startFakeControlPlane(): Promise<FakeControlPlane> {
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/control/health") {
      send(200, { status: "ok", prepStateCapability: PREP_STATE_CAPABILITY });
      return;
    }
    if (req.method === "POST" && req.url === "/control/register-run") {
      send(200, { state: "active", requiredTimers: 1, prepStateCapability: PREP_STATE_CAPABILITY });
      return;
    }
    // nudge/terminate and anything else: benign 200 (the caller swallows it).
    send(200, { state: "ok", prepStateCapability: PREP_STATE_CAPABILITY });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ── fixture lifecycle ──────────────────────────────────────────────────────

let savedEnv: Array<[string, string | undefined]> = [];

before(() => {
  // The mount plan refuses a /tmp guest destination (it shadows the guest's
  // disposable /tmp), so the work/config fixtures live under the REAL operator
  // home. No VM or matchlock socket is created here, so the path length is not
  // a Matchlock socket concern; the disposable dir is still short enough.
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".mtlk-netegress-retention-")));
  configRoot = path.join(tmpRoot, "pi-agent");
  workDir = path.join(tmpRoot, "work");
  helperPack = path.join(tmpRoot, "guest-pack");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(helperPack, { recursive: true });

  // Scoped to THIS test process only (no spawned children).
  const stateDir = path.join(tmpRoot, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  savedEnv = [
    ["HOME", process.env.HOME],
    ["TAMANDUA_STATE_DIR", process.env.TAMANDUA_STATE_DIR],
    ["TAMANDUA_DB_PATH", process.env.TAMANDUA_DB_PATH],
  ];
  process.env.HOME = tmpRoot;
  process.env.TAMANDUA_STATE_DIR = stateDir;
  process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
});

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── retention ──────────────────────────────────────────────────────────────

describe("NAT-EGRESS US-009: a stored NAT mode survives every later launch", () => {
  it("persists the fresh NAT mode, re-parses it, and composes intercept:false", () => {
    const fresh = admitWrite(undefined, resolveMatchlockNetworkOutbound({ flag: true }));
    assert.deepEqual(fresh.networkOutbound, { unrestricted: true, source: "flag" });

    const stored = serializeMatchlockPolicy(fresh);
    // A stored NAT record is self-describing on the read path.
    const reparsed = parseMatchlockPolicy(stored);
    assert.deepEqual(reparsed.networkOutbound, { unrestricted: true, source: "flag" });

    const { network } = composeStored(stored);
    assert.deepEqual(network, GOLDEN_UNRESTRICTED_NETWORK);
    assert.equal(JSON.stringify(network), '{"block_private_ips":false,"intercept":false}');
    assert.equal("dns_priority" in network, false, "dns_priority is interception-only");
    assert.equal("allow_private" in network, false, "allow_private is interception-only");
  });

  // COMPOSER DETERMINISM (honest label): this test calls the SAME pure
  // composer four times — it proves the stored record is enough to reproduce
  // the wire block on any launch, not that each lifecycle path was driven.
  // The REAL retained-record proof is the `resumeWorkflow` test below.
  it("composer determinism: a stored env-selected NAT record re-composes the SAME intercept:false block on every launch", () => {
    const stored = serializeMatchlockPolicy(
      admitWrite(undefined, resolveMatchlockNetworkOutbound({ env: { [MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV]: "1" } })),
    );
    const baseline = composeStored(stored).network;
    assert.deepEqual(baseline, GOLDEN_UNRESTRICTED_NETWORK);

    // Each label names a later launch of the SAME run; every call below reads
    // the persisted column (parse) and composes from it, never from a
    // flag/env. The labels are documentation — the loop is composer-only.
    for (const launch of ["queued dispatch", "step retry", "resume", "daemon restart"] as const) {
      const { policy, network } = composeStored(stored);
      assert.deepEqual(
        policy.networkOutbound,
        { unrestricted: true, source: "env" },
        `${launch}: the stored mode (and its selection source) is preserved verbatim`,
      );
      assert.equal(
        JSON.stringify(network),
        JSON.stringify(baseline),
        `${launch}: the composed wire block must be identical on every launch`,
      );
    }

    // A later launch never rewrites the column: re-serializing the parsed
    // record reproduces the exact stored bytes.
    assert.equal(serializeMatchlockPolicy(parseMatchlockPolicy(stored)), stored);
  });

  it("keeps dns_priority/allow_private off the NAT wire even when the stored policy carries stale interception settings", () => {
    const stored = serializeMatchlockPolicy(
      buildPolicy({
        networkOutbound: { unrestricted: true, source: "flag" },
        // Stale resolution leftover: interception-only machinery must not leak.
        networkAllowPrivate: ["192.168.107.74:8888"],
        matchlockDnsPriority: { priority: "ipv6", source: "flag" },
      }),
    );
    const { network } = composeStored(stored);
    assert.deepEqual(network, GOLDEN_UNRESTRICTED_NETWORK);
    assert.equal("dns_priority" in network, false);
    assert.equal("allow_private" in network, false);
  });
});

// ── anti-widening ──────────────────────────────────────────────────────────

describe("NAT-EGRESS US-009: anti-widening on replacement admission", () => {
  it("a replacement of an INTERCEPTED run stays intercepted even when the flag selects unrestricted", () => {
    const intercepted = admitWrite(undefined, resolveMatchlockNetworkOutbound({}));
    assert.equal("networkOutbound" in intercepted, false);
    const stored = serializeMatchlockPolicy(intercepted);

    // The operator (or a wrapper) now runs the replacement with the NAT flag.
    const inherited = parseMatchlockPolicy(stored);
    const supplied = resolveMatchlockNetworkOutbound({ flag: true });
    assert.deepEqual(supplied, { unrestricted: true, source: "flag" });

    const effective = resolveAdmissionNetworkOutbound(inherited, supplied);
    assert.equal(effective, undefined, "an inherited policy without the field is authoritative");

    const replacement = admitWrite(inherited, supplied);
    assert.equal(
      Object.prototype.hasOwnProperty.call(replacement, "networkOutbound"),
      false,
      "the replacement must not gain the field",
    );
    assert.equal(serializeMatchlockPolicy(replacement).includes("networkOutbound"), false);

    const composed = composeStored(serializeMatchlockPolicy(replacement));
    assert.deepEqual(composed.network, GOLDEN_INTERCEPTED_NETWORK);
    assert.equal(composed.network.intercept, true);
  });

  it("a replacement of an INTERCEPTED run stays intercepted even when the ENV selects unrestricted", () => {
    const stored = serializeMatchlockPolicy(admitWrite(undefined, resolveMatchlockNetworkOutbound({})));
    const inherited = parseMatchlockPolicy(stored);
    const supplied = resolveMatchlockNetworkOutbound({
      env: { [MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV]: "1" },
    });
    assert.deepEqual(supplied, { unrestricted: true, source: "env" });

    const effective = resolveAdmissionNetworkOutbound(inherited, supplied);
    assert.equal(effective, undefined);
    const replacement = admitWrite(inherited, supplied);
    assert.equal("networkOutbound" in replacement, false);
    assert.deepEqual(composeStored(serializeMatchlockPolicy(replacement)).network, GOLDEN_INTERCEPTED_NETWORK);
  });

  it("a replacement of a NAT run with no flags stays NAT", () => {
    const stored = serializeMatchlockPolicy(
      admitWrite(undefined, resolveMatchlockNetworkOutbound({ flag: true })),
    );
    const inherited = parseMatchlockPolicy(stored);

    // No flag, no env: the selection resolves to the intercepted DEFAULT, but
    // the inherited NAT mode is authoritative and must win.
    const supplied = resolveMatchlockNetworkOutbound({ env: {} });
    assert.deepEqual(supplied, { unrestricted: false, source: "default" });

    const effective = resolveAdmissionNetworkOutbound(inherited, supplied);
    assert.deepEqual(effective, { unrestricted: true, source: "flag" });

    const replacement = admitWrite(inherited, supplied);
    assert.deepEqual(replacement.networkOutbound, { unrestricted: true, source: "flag" });
    assert.notEqual(
      replacement.networkOutbound,
      inherited.networkOutbound,
      "the replacement clones the inherited mode (never aliases it)",
    );
    assert.deepEqual(composeStored(serializeMatchlockPolicy(replacement)).network, GOLDEN_UNRESTRICTED_NETWORK);
  });
});

// ── legacy / absent field ──────────────────────────────────────────────────

describe("NAT-EGRESS US-009: a stored record without the field is never upgraded", () => {
  it("a v3 legacy record composes interception regardless of an ambient unrestricted env", () => {
    const stored = serializeMatchlockPolicy(buildPolicy());
    assert.equal(stored.includes("networkOutbound"), false);

    // Ambient selection says NAT, but the stored record is authoritative.
    const ambient = resolveMatchlockNetworkOutbound({
      env: { [MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV]: "1" },
    });
    assert.deepEqual(ambient, { unrestricted: true, source: "env" });

    const inherited = parseMatchlockPolicy(stored);
    assert.equal(resolveAdmissionNetworkOutbound(inherited, ambient), undefined);

    const { policy, network } = composeStored(stored);
    assert.equal(policy.version, MATCHLOCK_POLICY_VERSION);
    assert.equal("networkOutbound" in policy, false);
    assert.deepEqual(network, GOLDEN_INTERCEPTED_NETWORK);

    // And an admission write for that legacy record does not materialize the
    // field either: absence stays absence.
    const replacement = admitWrite(inherited, ambient);
    assert.equal("networkOutbound" in replacement, false);
    assert.equal(serializeMatchlockPolicy(replacement).includes("networkOutbound"), false);
  });

  it("a v2 record normalized at read composes the d8047aa5 golden wire shape", () => {
    const fixture = buildPolicy();
    const v2 = asV2Record(fixture);
    assert.equal(v2.version, 2);
    assert.equal("networkOutbound" in v2, false);

    const normalized = parseMatchlockPolicy(JSON.stringify(v2));
    assert.equal(normalized.version, MATCHLOCK_POLICY_VERSION, "the read path projects v2 to v3");
    assert.equal("networkOutbound" in normalized, false);

    const fromV2 = buildMatchlockCreateConfig(normalized, IDENTITY, { helperPackHostPath: helperPack });
    const fromFixture = buildMatchlockCreateConfig(fixture, IDENTITY, { helperPackHostPath: helperPack });
    assert.deepEqual(fromV2.network, GOLDEN_INTERCEPTED_NETWORK);
    assert.equal(
      JSON.stringify(fromV2.network),
      JSON.stringify(fromFixture.network),
      "a normalized v2 record must compose byte-identically to the default fixture",
    );
  });

  it("a hand-built fixture without the field composes the same d8047aa5 block", () => {
    const { network } = composeStored(serializeMatchlockPolicy(buildPolicy()));
    assert.deepEqual(network, GOLDEN_INTERCEPTED_NETWORK);
    assert.deepEqual(Object.keys(network), ["block_private_ips", "intercept", "dns_priority"]);
  });
});

// ── plain resume does not rewrite the stored policy ────────────────────────

describe("NAT-EGRESS US-009: a plain resume leaves the stored policy byte-for-byte unchanged", () => {
  it("resumeWorkflow does not rewrite a NAT run's matchlock_policy", async () => {
    const db = getDb();
    const runId = `run-netegress-resume-${process.pid}`;
    const now = new Date().toISOString();
    const stored = serializeMatchlockPolicy(
      admitWrite(undefined, resolveMatchlockNetworkOutbound({ flag: true })),
    );

    db.prepare(
      `INSERT INTO runs (id, run_number, workflow_id, task, status, context, isolation_intent, matchlock_policy, scheduling_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, NULL, ?, ?)`,
    ).run(
      runId,
      9001,
      "test-netegress-retention",
      "plain resume must not rewrite the stored network mode",
      JSON.stringify({ working_directory_for_harness: workDir }),
      "true",
      stored,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, created_at, updated_at)
       VALUES (?, ?, 'implement', 'dev', 0, 'input', 'STATUS, CHANGES, TESTS', 'failed', 'single', ?, ?)`,
    ).run(`${runId}-step`, runId, now, now);

    const before = db
      .prepare("SELECT matchlock_policy FROM runs WHERE id = ?")
      .get(runId) as { matchlock_policy: string | null };
    assert.equal(before.matchlock_policy, stored);

    const fake = await startFakeControlPlane();
    const prevControlPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.TAMANDUA_CONTROL_PORT = String(fake.port);
    let result: Awaited<ReturnType<typeof resumeWorkflow>>;
    try {
      result = await resumeWorkflow(runId, {
        // Deterministic seams: no real matchlock binary and no owned RPC/VM.
        matchlockSwapSupportProbe: (binaryPath) => ({ supported: true, binaryPath }),
        matchlockInheritedImageVerifier: async () => {},
      });
    } finally {
      if (prevControlPort !== undefined) process.env.TAMANDUA_CONTROL_PORT = prevControlPort;
      else delete process.env.TAMANDUA_CONTROL_PORT;
      await fake.close();
    }

    assert.equal(result.status, "resumed", `resume must succeed: ${JSON.stringify(result)}`);

    const after = db
      .prepare("SELECT status, matchlock_policy FROM runs WHERE id = ?")
      .get(runId) as { status: string; matchlock_policy: string | null };
    assert.equal(after.status, "running");
    assert.equal(
      after.matchlock_policy,
      stored,
      "a plain resume writes no policy bytes: the stored NAT mode is untouched",
    );

    // Retention after the resume: the run still composes NAT.
    assert.deepEqual(composeStored(after.matchlock_policy as string).network, GOLDEN_UNRESTRICTED_NETWORK);
  });
});
