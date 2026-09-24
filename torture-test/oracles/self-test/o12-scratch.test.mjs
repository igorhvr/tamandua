#!/usr/bin/env node

// o12-scratch.test.mjs — focused test for the O12 child-env policy module
// (O12-SCHEMA-13 US-006).
//
// `o12-scratch.mjs` decides the child environment of every O12 gate child
// (`run-o12-gate-self-tests.mjs`, `o12-fixture-matrix.mjs`,
// `o12-seed-snapshot.mjs`). This test pins:
//
//   * the explicit allow-list shape (guard on, /bin/false harnesses, private
//     HOME/TMPDIR, NO ambient TAMANDUA_* authority), and
//   * the ONE documented pass-through added by US-006:
//     TAMANDUA_O12_SEED_SNAPSHOT, the seed-EVIDENCE LOCATION override that
//     `o12.test.mjs`'s seed-pin assertion reads — mirroring the o12-group
//     pass-through `run-self-tests-alone.mjs` has carried since US-004. The O12
//     gate runner must be able to judge an owned seed store on a host where the
//     retained /opt/tamandua-storm-seed.* evidence is not visible; without the
//     pass-through its `o12.test.mjs` entry can only ever judge the absent host
//     path.
//
// It spawns nothing and writes nothing outside a private scratch dir under the
// OS temp base (outside the product guard's real-state prefix).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  REAL_STATE_DIR,
  isUnderRealState,
  o12ChildEnv,
  safeProbeTmpdir,
} from "./o12-scratch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(HERE, "run-o12-gate-self-tests.mjs");

/** The ambient authority names no O12 child may ever inherit. */
const AMBIENT_AUTHORITY = [
  "TAMANDUA_RUN_ID",
  "TAMANDUA_WORKER_PID",
  "TAMANDUA_CONTROL_PORT",
  "TAMANDUA_STATE_DIR",
  "TAMANDUA_WORKFLOWS_SRC",
  "TAMANDUA_DB_PATH",
];

/** Run `body` with `overrides` applied to process.env, restoring it afterwards. */
function withAmbientEnv(overrides, body) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("o12ChildEnv is an explicit allow-list: guard on, false harnesses, private HOME/TMPDIR, no ambient authority", () => {
  const contaminated = Object.fromEntries(AMBIENT_AUTHORITY.map((key) => [key, `sentinel-${key}`]));
  withAmbientEnv({ ...contaminated, TAMANDUA_O12_SEED_SNAPSHOT: undefined }, () => {
    const tmpdir = "/tmp/o12-scratch-unit-env";
    const env = o12ChildEnv({ tmpdir });
    assert.equal(env.TAMANDUA_TEST_GUARD, "1", "every O12 child runs under the test guard");
    assert.equal(env.TAMANDUA_PI_BINARY, "/bin/false");
    assert.equal(env.TAMANDUA_HERMES_BINARY, "/bin/false");
    assert.equal(env.TAMANDUA_DSH_BINARY, "/bin/false");
    assert.equal(env.HOME, tmpdir, "the child HOME is its private tmpdir");
    assert.equal(env.TMPDIR, tmpdir, "the child TMPDIR is its private tmpdir");
    assert.equal(env.TZ, "UTC");
    for (const key of AMBIENT_AUTHORITY) {
      assert.equal(key in env, false, `ambient authority ${key} must never reach an O12 child`);
    }
    assert.equal("TAMANDUA_O12_SEED_SNAPSHOT" in env, false,
      "with no override supplied the env carries no seed path at all");
  });
});

test("the seed-evidence override is forwarded when set (an evidence location, not authority) and an explicit extra still wins", () => {
  const owned = "/tmp/o12s13-owned/seed-snapshot-v13.sqlite";
  withAmbientEnv({
    TAMANDUA_O12_SEED_SNAPSHOT: owned,
    TAMANDUA_RUN_ID: "sentinel-run",
  }, () => {
    const env = o12ChildEnv({ tmpdir: "/tmp/o12-scratch-unit-seed" });
    assert.equal(env.TAMANDUA_O12_SEED_SNAPSHOT, owned,
      "the documented owned-copy override must reach the O12 children (the O12 gate runner's o12.test.mjs entry)");
    assert.equal("TAMANDUA_RUN_ID" in env, false,
      "forwarding the seed location must never also forward run/work authority");

    const explicit = o12ChildEnv({
      tmpdir: "/tmp/o12-scratch-unit-seed",
      extra: { TAMANDUA_O12_SEED_SNAPSHOT: "/tmp/explicit.sqlite" },
    });
    assert.equal(explicit.TAMANDUA_O12_SEED_SNAPSHOT, "/tmp/explicit.sqlite",
      "a caller-supplied extra value wins over the forwarded one");
  });
});

test("the O12 gate runner builds its child env from o12ChildEnv (so the pass-through reaches every entry)", () => {
  const source = fs.readFileSync(RUNNER_PATH, "utf8");
  assert.match(source, /import \{ o12ChildEnv, safeProbeTmpdir \} from '\.\/o12-scratch\.mjs'/,
    "the O12 gate runner imports the shared child-env policy");
  assert.match(source, /\.\.\.o12ChildEnv\(\{ tmpdir \}\)/,
    "every O12 gate self-test entry env is built from o12ChildEnv");
});

test("scratch bases stay outside the product guard's real-state prefix", () => {
  const probe = safeProbeTmpdir();
  assert.equal(isUnderRealState(probe), false,
    `a probe scratch dir must never resolve under ${REAL_STATE_DIR} (got ${probe})`);
  assert.equal(isUnderRealState(path.join(REAL_STATE_DIR, "worktrees", "x")), true,
    "the real-state predicate still recognises the production prefix");
});
