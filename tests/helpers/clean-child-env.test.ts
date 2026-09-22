/**
 * Pure regression tests for the cleanChildEnv allowlist TZ passthrough
 * (US-001).
 *
 * Matrix covered:
 *  1. an ambient base-env TZ passes through unchanged (no zone is forced);
 *  2. a base env without TZ yields a result env with no TZ key;
 *  3. an explicit TZ override replaces the passed-through value;
 *  4. an explicit { TZ: undefined } override removes TZ even when the base
 *     env carried it;
 *  5. unrelated (non-allowlist) base-env keys stay filtered out in every TZ
 *     scenario;
 *  6. existing allowlist passthrough and override semantics are unchanged
 *     (PATH is allowlisted and passes through; HOME is NOT an allowlist
 *     passthrough key — every call site supplies it as an explicit override,
 *     which also drives the TAMANDUA_STATE_DIR/DB/WORKTREE_ROOT synthesis).
 *
 * Additionally covers the US-008 test-child isolation contract:
 *  - TAMANDUA_STATE_DIR is ALWAYS forced to <HOME>/.tamandua and an injected
 *    state dir is ignored;
 *  - TAMANDUA_DB_PATH / TAMANDUA_WORKTREE_ROOT default to that forced path;
 *  - the inherited run/job markers are stripped even when passed as overrides;
 *  - a no-HOME call leaves the state dir exactly as before.
 *
 * These tests are pure and host-independent: every call passes an explicit
 * synthetic baseEnv (never process.env), no assertion relies on the host
 * timezone being set or unset, and nothing spawns child processes. The file
 * belongs in the parallel lane — do NOT add it to tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanChildEnv } from "./test-env.ts";

/** Synthetic base env: allowlist keys only, never process.env. */
function syntheticBaseEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    TERM: "xterm",
  };
}

describe("cleanChildEnv TZ allowlist passthrough", () => {
  it("passes an ambient base-env TZ through unchanged (no zone forced)", () => {
    // Deliberately a non-UTC zone: the helper must preserve the invocation's
    // zone verbatim, never force UTC or any other value.
    const baseTZ = "America/Sao_Paulo";
    const env = cleanChildEnv({}, { ...syntheticBaseEnv(), TZ: baseTZ });

    assert.equal(env.TZ, baseTZ);
  });

  it("omits TZ when the base env has no TZ key", () => {
    const env = cleanChildEnv({}, syntheticBaseEnv());

    assert.ok(!("TZ" in env), "result env must not contain a TZ key");
    assert.equal(env.TZ, undefined);
  });

  it("an explicit TZ override replaces the passed-through value", () => {
    const env = cleanChildEnv(
      { TZ: "Europe/Lisbon" },
      { ...syntheticBaseEnv(), TZ: "America/Sao_Paulo" },
    );

    assert.equal(env.TZ, "Europe/Lisbon");
  });

  it("an explicit { TZ: undefined } override removes TZ even when the base env carried it", () => {
    const env = cleanChildEnv(
      { TZ: undefined },
      { ...syntheticBaseEnv(), TZ: "Asia/Tokyo" },
    );

    assert.ok(!("TZ" in env), "explicit undefined must delete the TZ key");
    assert.equal(env.TZ, undefined);
  });
});

describe("cleanChildEnv unrelated-env filtering across TZ scenarios", () => {
  const markerKey = "TZPASS_MARKER_UNRELATED";
  const markerValue = "must-stay-filtered";

  const scenarios: Array<{
    name: string;
    baseTZ?: string;
    overrides?: Record<string, string | undefined>;
  }> = [
    { name: "TZ present in base env", baseTZ: "America/Sao_Paulo" },
    { name: "TZ absent from base env" },
    {
      name: "TZ replaced by an explicit override",
      baseTZ: "Asia/Tokyo",
      overrides: { TZ: "UTC" },
    },
    {
      name: "TZ removed by an explicit undefined",
      baseTZ: "Asia/Tokyo",
      overrides: { TZ: undefined },
    },
  ];

  for (const scenario of scenarios) {
    it(`filters unrelated base-env keys when ${scenario.name}`, () => {
      const base: NodeJS.ProcessEnv = { ...syntheticBaseEnv() };
      if (scenario.baseTZ !== undefined) base.TZ = scenario.baseTZ;
      base[markerKey] = markerValue;

      const env = cleanChildEnv(scenario.overrides ?? {}, base);

      assert.ok(
        !(markerKey in env),
        `${markerKey} must not leak into the cleaned child env`,
      );
      assert.equal(env[markerKey], undefined);
      // Allowlist passthrough stays intact in every TZ scenario.
      assert.equal(env.PATH, "/usr/bin:/bin");
      assert.equal(env.LANG, "C.UTF-8");
    });
  }
});

describe("cleanChildEnv existing allowlist semantics (regression)", () => {
  it("allowlisted base keys (PATH) still pass through unchanged", () => {
    const env = cleanChildEnv({}, syntheticBaseEnv());

    assert.equal(env.PATH, "/usr/bin:/bin");
    assert.equal(env.LANG, "C.UTF-8");
  });

  it("explicit overrides still replace allowlisted base values", () => {
    const env = cleanChildEnv(
      { PATH: "/custom/bin" },
      { ...syntheticBaseEnv(), PATH: "/usr/bin:/bin" },
    );

    assert.equal(env.PATH, "/custom/bin");
  });

  it("HOME is not a base passthrough key: a base-env HOME stays filtered out", () => {
    // Every call site supplies HOME via explicit overrides; cleanChildEnv
    // never copies an ambient HOME from the base env. Regression-pin that
    // filtering is untouched by the TZ addition.
    const env = cleanChildEnv({}, { ...syntheticBaseEnv(), HOME: "/home/from-base" });

    assert.ok(!("HOME" in env), "base-env HOME must stay filtered out");
    assert.equal(env.HOME, undefined);
  });

  it("an explicit HOME override is applied and still drives state-dir synthesis", () => {
    // Deliberately NOT under the temp dir: this file is pure (no temp dirs),
    // and the temp-dir guard (src/lib/temp-dir.guard.test.ts) forbids
    // hardcoded temp paths outside its allowlist. Any absolute HOME value
    // exercises the synthesis logic identically.
    const homeDir = "/home/tzpass-test/home";
    const env = cleanChildEnv({ HOME: homeDir }, syntheticBaseEnv());

    assert.equal(env.HOME, homeDir);
    assert.equal(env.TAMANDUA_STATE_DIR, `${homeDir}/.tamandua`);
    assert.equal(env.TAMANDUA_DB_PATH, `${homeDir}/.tamandua/tamandua.db`);
    assert.equal(env.TAMANDUA_WORKTREE_ROOT, `${homeDir}/.tamandua/worktrees`);
  });

  it("an explicit undefined override still removes allowlisted keys from the result", () => {
    const env = cleanChildEnv({ PATH: undefined }, syntheticBaseEnv());

    assert.ok(!("PATH" in env), "PATH must be removed by explicit undefined");
    assert.equal(env.PATH, undefined);
  });
});

describe("cleanChildEnv forces the child state dir from HOME (US-008)", () => {
  const homeDir = "/home/isolation-test/home";
  const forcedStateDir = `${homeDir}/.tamandua`;

  it("ignores an injected TAMANDUA_STATE_DIR override", () => {
    const env = cleanChildEnv(
      { HOME: homeDir, TAMANDUA_STATE_DIR: "/somewhere/else/.tamandua" },
      syntheticBaseEnv(),
    );

    assert.equal(env.TAMANDUA_STATE_DIR, forcedStateDir);
  });

  it("ignores an ambient base-env TAMANDUA_STATE_DIR", () => {
    const env = cleanChildEnv(
      { HOME: homeDir },
      { ...syntheticBaseEnv(), TAMANDUA_STATE_DIR: "/ambient/state" },
    );

    assert.equal(env.TAMANDUA_STATE_DIR, forcedStateDir);
  });

  it("derives exactly <HOME>/.tamandua, its DB and its worktree root", () => {
    const env = cleanChildEnv({ HOME: homeDir }, syntheticBaseEnv());

    assert.equal(env.TAMANDUA_STATE_DIR, forcedStateDir);
    assert.equal(env.TAMANDUA_DB_PATH, `${forcedStateDir}/tamandua.db`);
    assert.equal(env.TAMANDUA_WORKTREE_ROOT, `${forcedStateDir}/worktrees`);
  });

  it("leaves the state dir unset when HOME is absent", () => {
    const env = cleanChildEnv({}, syntheticBaseEnv());

    assert.ok(!("TAMANDUA_STATE_DIR" in env), "no HOME => no forced state dir");
    assert.ok(!("TAMANDUA_DB_PATH" in env), "no HOME => no synthesized DB path");
    assert.ok(
      !("TAMANDUA_WORKTREE_ROOT" in env),
      "no HOME => no synthesized worktree root",
    );
  });

  it("preserves an explicit TAMANDUA_STATE_DIR when HOME is absent", () => {
    const env = cleanChildEnv(
      { TAMANDUA_STATE_DIR: "/explicit/state" },
      syntheticBaseEnv(),
    );

    assert.equal(env.TAMANDUA_STATE_DIR, "/explicit/state");
  });
});

describe("cleanChildEnv strips inherited run/job markers (US-008)", () => {
  const homeDir = "/home/isolation-test/home";
  const markers = [
    "TAMANDUA_RUN_ID",
    "TAMANDUA_WORKER_JOB_ID",
    "TAMANDUA_DAEMON_INSTANCE",
    "TAMANDUA_WORKER_PID",
    "TAMANDUA_DAEMON_PID",
  ] as const;

  it("is absent for every marker even when present in the base env", () => {
    const base: NodeJS.ProcessEnv = { ...syntheticBaseEnv(), HOME: homeDir };
    for (const marker of markers) base[marker] = `base-${marker}`;

    const env = cleanChildEnv({}, base);

    for (const marker of markers) {
      assert.ok(!(marker in env), `${marker} must not leak from the base env`);
      assert.equal(env[marker], undefined);
    }
  });

  it("is absent for every marker even when supplied as an override", () => {
    const overrides: Record<string, string> = { HOME: homeDir };
    for (const marker of markers) overrides[marker] = `override-${marker}`;

    const env = cleanChildEnv(overrides, syntheticBaseEnv());

    for (const marker of markers) {
      assert.ok(!(marker in env), `${marker} must not leak from an override`);
      assert.equal(env[marker], undefined);
    }
  });

  it("keeps the guard and harness pins while dropping the markers", () => {
    const env = cleanChildEnv(
      {
        HOME: homeDir,
        TAMANDUA_TEST_GUARD: "1",
        TAMANDUA_PI_BINARY: "/bin/echo",
        TAMANDUA_RUN_ID: "run-outer",
      },
      syntheticBaseEnv(),
    );

    assert.equal(env.TAMANDUA_TEST_GUARD, "1");
    assert.equal(env.TAMANDUA_PI_BINARY, "/bin/echo");
    assert.ok(!("TAMANDUA_RUN_ID" in env));
  });
});
