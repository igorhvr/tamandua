import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, it } from "node:test";

import {
  SWEEP_DAEMON_INSTANCE_ENV,
  SWEEP_RUN_ID_ENV,
  SWEEP_STATE_DIR_ENV,
  computeDaemonInstanceToken,
  getDaemonInstanceToken,
  matchesSweepOwnership,
  parseSweepOwnership,
  resolveDaemonInstanceToken,
  resolveSweepStateDir,
} from "../../dist/installer/sweep-ownership.js";
import { getProcessStartIdentity } from "../../dist/lib/process-start-identity.js";
import { tamanduaTempRoot } from "../../dist/lib/temp-dir.js";

// ── Fixtures ─────────────────────────────────────────────────────────

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";
const START_A = "v2:4242:1700000000000";
const START_B = "v2:4242:1700000000001";
const STATE_A = path.join(tamanduaTempRoot(), "tamandua-sweep-state-a");
const STATE_B = path.join(tamanduaTempRoot(), "tamandua-sweep-state-b");
const INSTANCE_A = computeDaemonInstanceToken({ stateDir: STATE_A, startIdentity: START_A });
const INSTANCE_B = computeDaemonInstanceToken({ stateDir: STATE_B, startIdentity: START_B });

/** Join env entries into the NUL-separated environ text shape. */
function envText(...entries: string[]): string {
  return entries.join("\0");
}

// ── resolveSweepStateDir ─────────────────────────────────────────────

describe("resolveSweepStateDir", () => {
  it("prefers a trimmed TAMANDUA_STATE_DIR over HOME", () => {
    const resolved = resolveSweepStateDir({
      [SWEEP_STATE_DIR_ENV]: `  ${STATE_A}  `,
      HOME: "/home/outer",
    });
    assert.equal(resolved, path.resolve(STATE_A));
  });

  it("resolves a relative TAMANDUA_STATE_DIR against the cwd", () => {
    assert.equal(
      resolveSweepStateDir({ [SWEEP_STATE_DIR_ENV]: "relative-state" }),
      path.resolve("relative-state"),
    );
  });

  it("falls back to <HOME>/.tamandua when no override is present", () => {
    assert.equal(
      resolveSweepStateDir({ HOME: "/home/outer" }),
      path.resolve(path.join("/home/outer", ".tamandua")),
    );
  });

  it("trims HOME before composing the default state dir", () => {
    assert.equal(
      resolveSweepStateDir({ HOME: "  /home/outer  " }),
      path.resolve(path.join("/home/outer", ".tamandua")),
    );
  });

  it("ignores an empty/whitespace TAMANDUA_STATE_DIR and uses HOME", () => {
    assert.equal(
      resolveSweepStateDir({ [SWEEP_STATE_DIR_ENV]: "   ", HOME: "/home/outer" }),
      path.resolve(path.join("/home/outer", ".tamandua")),
    );
    assert.equal(
      resolveSweepStateDir({ [SWEEP_STATE_DIR_ENV]: "", HOME: "/home/outer" }),
      path.resolve(path.join("/home/outer", ".tamandua")),
    );
  });

  it("returns null when neither the override nor HOME is available", () => {
    assert.equal(resolveSweepStateDir({}), null);
    assert.equal(resolveSweepStateDir({ HOME: "   " }), null);
    assert.equal(resolveSweepStateDir({ [SWEEP_STATE_DIR_ENV]: "  " }), null);
  });
});

// ── computeDaemonInstanceToken ───────────────────────────────────────

describe("computeDaemonInstanceToken", () => {
  it("is deterministic and a 64-char lowercase sha256 hex digest", () => {
    const first = computeDaemonInstanceToken({ stateDir: STATE_A, startIdentity: START_A });
    const second = computeDaemonInstanceToken({ stateDir: STATE_A, startIdentity: START_A });
    assert.equal(first, second);
    assert.match(first ?? "", /^[0-9a-f]{64}$/);
  });

  it("hashes exactly stateDir + NUL + startIdentity", () => {
    const expected = createHash("sha256")
      .update(`${STATE_A}\0${START_A}`)
      .digest("hex");
    assert.equal(
      computeDaemonInstanceToken({ stateDir: STATE_A, startIdentity: START_A }),
      expected,
    );
  });

  it("differs when the state dir differs", () => {
    assert.notEqual(
      computeDaemonInstanceToken({ stateDir: STATE_A, startIdentity: START_A }),
      computeDaemonInstanceToken({ stateDir: STATE_B, startIdentity: START_A }),
    );
  });

  it("differs when the start identity differs", () => {
    assert.notEqual(
      computeDaemonInstanceToken({ stateDir: STATE_A, startIdentity: START_A }),
      computeDaemonInstanceToken({ stateDir: STATE_A, startIdentity: START_B }),
    );
  });

  it("trims both components so whitespace cannot fork the identity", () => {
    assert.equal(
      computeDaemonInstanceToken({ stateDir: ` ${STATE_A} `, startIdentity: ` ${START_A} ` }),
      computeDaemonInstanceToken({ stateDir: STATE_A, startIdentity: START_A }),
    );
  });

  it("returns null when either component is missing or empty", () => {
    assert.equal(computeDaemonInstanceToken({ stateDir: null, startIdentity: START_A }), null);
    assert.equal(computeDaemonInstanceToken({ stateDir: STATE_A, startIdentity: null }), null);
    assert.equal(computeDaemonInstanceToken({ stateDir: undefined, startIdentity: undefined }), null);
    assert.equal(computeDaemonInstanceToken({ stateDir: "", startIdentity: START_A }), null);
    assert.equal(computeDaemonInstanceToken({ stateDir: STATE_A, startIdentity: "" }), null);
    assert.equal(computeDaemonInstanceToken({ stateDir: "   ", startIdentity: START_A }), null);
    assert.equal(computeDaemonInstanceToken({ stateDir: STATE_A, startIdentity: "   " }), null);
  });
});

// ── resolveDaemonInstanceToken ───────────────────────────────────────

describe("resolveDaemonInstanceToken", () => {
  it("uses explicitly injected inputs and matches computeDaemonInstanceToken", () => {
    assert.equal(
      resolveDaemonInstanceToken({ stateDir: STATE_A, startIdentity: START_A }),
      computeDaemonInstanceToken({ stateDir: STATE_A, startIdentity: START_A }),
    );
  });

  it("prefers an explicit stateDir over the environment", () => {
    assert.equal(
      resolveDaemonInstanceToken({
        stateDir: STATE_A,
        startIdentity: START_A,
        env: { [SWEEP_STATE_DIR_ENV]: STATE_B },
      }),
      computeDaemonInstanceToken({ stateDir: STATE_A, startIdentity: START_A }),
    );
  });

  it("resolves the state dir from the injected env when none is given", () => {
    assert.equal(
      resolveDaemonInstanceToken({
        startIdentity: START_A,
        env: { [SWEEP_STATE_DIR_ENV]: STATE_A },
      }),
      computeDaemonInstanceToken({ stateDir: STATE_A, startIdentity: START_A }),
    );
  });

  it("returns null when the state dir is unavailable", () => {
    assert.equal(
      resolveDaemonInstanceToken({ stateDir: "", startIdentity: START_A, env: {} }),
      null,
    );
  });

  it("returns null when the process start identity is unreadable", () => {
    // pid 0 is never a valid process, so getProcessStartIdentity returns null
    // on every platform (without depending on a real pid or /proc).
    assert.equal(resolveDaemonInstanceToken({ stateDir: STATE_A, pid: 0 }), null);
  });

  it("reads the current process identity by default", () => {
    const token = resolveDaemonInstanceToken({ stateDir: STATE_A });
    const expected = computeDaemonInstanceToken({
      stateDir: STATE_A,
      startIdentity: getProcessStartIdentity(process.pid),
    });
    // The kernel start identity is readable on linux/darwin; on an exotic
    // platform it stays non-null ("v2u:"). Either way the token must equal the
    // token derived from the same inputs — never a fabricated value.
    assert.equal(token, expected);
  });
});

// ── getDaemonInstanceToken ───────────────────────────────────────────

describe("getDaemonInstanceToken", () => {
  it("is stable across repeated calls and equals a fresh resolution", () => {
    const first = getDaemonInstanceToken();
    const second = getDaemonInstanceToken();
    assert.equal(first, second);
    if (first !== null) {
      assert.match(first, /^[0-9a-f]{64}$/);
      assert.equal(first, resolveDaemonInstanceToken());
    }
  });
});

// ── parseSweepOwnership ──────────────────────────────────────────────

describe("parseSweepOwnership", () => {
  it("parses exact run id and daemon-instance values", () => {
    assert.deepEqual(
      parseSweepOwnership(
        envText(`${SWEEP_RUN_ID_ENV}=${RUN_A}`, `${SWEEP_DAEMON_INSTANCE_ENV}=${INSTANCE_A}`),
      ),
      { runId: RUN_A, daemonInstance: INSTANCE_A },
    );
  });

  it("takes the first non-empty value and skips empty ones", () => {
    assert.deepEqual(
      parseSweepOwnership(
        envText(
          `${SWEEP_RUN_ID_ENV}=`,
          `${SWEEP_RUN_ID_ENV}=${RUN_A}`,
          `${SWEEP_DAEMON_INSTANCE_ENV}=${INSTANCE_A}`,
          `${SWEEP_DAEMON_INSTANCE_ENV}=${INSTANCE_B}`,
        ),
      ),
      { runId: RUN_A, daemonInstance: INSTANCE_A },
    );
  });

  it("returns nulls for missing keys, empty environ, and unknown env", () => {
    assert.deepEqual(parseSweepOwnership(null), { runId: null, daemonInstance: null });
    assert.deepEqual(parseSweepOwnership(undefined), { runId: null, daemonInstance: null });
    assert.deepEqual(parseSweepOwnership(""), { runId: null, daemonInstance: null });
    assert.deepEqual(parseSweepOwnership(envText("PATH=/usr/bin", "LANG=C")), {
      runId: null,
      daemonInstance: null,
    });
    assert.deepEqual(parseSweepOwnership(envText(`${SWEEP_RUN_ID_ENV}=${RUN_A}`)), {
      runId: RUN_A,
      daemonInstance: null,
    });
  });

  it("does not match prefix/suffix lookalike keys", () => {
    assert.deepEqual(
      parseSweepOwnership(
        envText(
          `X${SWEEP_RUN_ID_ENV}=${RUN_A}`,
          `${SWEEP_RUN_ID_ENV}_SUFFIX=${RUN_B}`,
          `X${SWEEP_DAEMON_INSTANCE_ENV}=${INSTANCE_A}`,
        ),
      ),
      { runId: null, daemonInstance: null },
    );
  });

  it("requires an exact value, never a substring", () => {
    assert.deepEqual(parseSweepOwnership(envText(`${SWEEP_RUN_ID_ENV}=${RUN_A}-extra`)), {
      runId: `${RUN_A}-extra`,
      daemonInstance: null,
    });
  });
});

// ── matchesSweepOwnership ────────────────────────────────────────────

describe("matchesSweepOwnership", () => {
  it("matches only on the exact run id plus exact daemon token", () => {
    const environ = envText(
      `${SWEEP_RUN_ID_ENV}=${RUN_A}`,
      `${SWEEP_DAEMON_INSTANCE_ENV}=${INSTANCE_A}`,
    );
    assert.equal(matchesSweepOwnership(environ, RUN_A, INSTANCE_A), true);
  });

  it("rejects a different run id even with the right daemon token", () => {
    const environ = envText(
      `${SWEEP_RUN_ID_ENV}=${RUN_A}`,
      `${SWEEP_DAEMON_INSTANCE_ENV}=${INSTANCE_A}`,
    );
    assert.equal(matchesSweepOwnership(environ, RUN_B, INSTANCE_A), false);
  });

  it("rejects a marker carrying the same run id but an inherited outer instance", () => {
    // The cross-run kill shape: the process inherited the run id it was
    // spawned under, but the sweeping daemon instance is a different one.
    const inherited = envText(
      `${SWEEP_RUN_ID_ENV}=${RUN_A}`,
      `${SWEEP_DAEMON_INSTANCE_ENV}=${INSTANCE_A}`,
    );
    assert.equal(matchesSweepOwnership(inherited, RUN_A, INSTANCE_B), false);
  });

  it("rejects a marker with a missing daemon instance", () => {
    assert.equal(
      matchesSweepOwnership(envText(`${SWEEP_RUN_ID_ENV}=${RUN_A}`), RUN_A, INSTANCE_A),
      false,
    );
    assert.equal(
      matchesSweepOwnership(
        envText(`${SWEEP_RUN_ID_ENV}=${RUN_A}`, `${SWEEP_DAEMON_INSTANCE_ENV}=`),
        RUN_A,
        INSTANCE_A,
      ),
      false,
    );
  });

  it("never matches when the expected daemon token is null or empty", () => {
    const environ = envText(
      `${SWEEP_RUN_ID_ENV}=${RUN_A}`,
      `${SWEEP_DAEMON_INSTANCE_ENV}=${INSTANCE_A}`,
    );
    assert.equal(matchesSweepOwnership(environ, RUN_A, null), false);
    assert.equal(matchesSweepOwnership(environ, RUN_A, undefined), false);
    assert.equal(matchesSweepOwnership(environ, RUN_A, ""), false);
    assert.equal(matchesSweepOwnership(environ, RUN_A, "   "), false);
  });

  it("never matches when the expected run id is null or empty", () => {
    const environ = envText(
      `${SWEEP_RUN_ID_ENV}=${RUN_A}`,
      `${SWEEP_DAEMON_INSTANCE_ENV}=${INSTANCE_A}`,
    );
    assert.equal(matchesSweepOwnership(environ, null, INSTANCE_A), false);
    assert.equal(matchesSweepOwnership(environ, "", INSTANCE_A), false);
  });

  it("rejects an unreadable environ and unrelated env tokens", () => {
    assert.equal(matchesSweepOwnership(null, RUN_A, INSTANCE_A), false);
    assert.equal(matchesSweepOwnership("", RUN_A, INSTANCE_A), false);
    assert.equal(
      matchesSweepOwnership(envText("PATH=/usr/bin", `${SWEEP_RUN_ID_ENV}x=${RUN_A}`), RUN_A, INSTANCE_A),
      false,
    );
  });

  it("rejects a lookalike daemon token", () => {
    const environ = envText(
      `${SWEEP_RUN_ID_ENV}=${RUN_A}`,
      `${SWEEP_DAEMON_INSTANCE_ENV}=${INSTANCE_A}`,
    );
    assert.equal(matchesSweepOwnership(environ, RUN_A, `${INSTANCE_A}0`), false);
  });
});
