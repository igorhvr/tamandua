/**
 * MTLK-GUEST-TEMP — the guest's temp space must never be the mounted home.
 *
 * Hermes re-points TMPDIR/TMP/TEMP at <HERMES_HOME>/cache/scratch on startup
 * unless the value is already set to something that is not Hermes' own scratch
 * dir (hermes_constants.apply_scratch_tmp_env). Under Matchlock the Hermes home
 * is a FUSE mount, and a Unix socket cannot be bound on it. The gateway control
 * socket first tries <HERMES_HOME>/gateway.sock, gets EOPNOTSUPP (errno 95),
 * and then falls back through tempfile.gettempdir() — which, after that re-point,
 * is the same unusable mount. The second bind fails the same way and bootstrap
 * aborts with "gateway session bootstrap control listener unavailable".
 *
 * Pinning TMPDIR to the guest-local /tmp makes the fallback land on a real
 * filesystem. These tests pin the policy itself: applied for a Hermes home,
 * never overriding a caller's explicit choice, and inert everywhere else.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyGuestTempPolicy } from "../dist/installer/matchlock/controller.js";

describe("applyGuestTempPolicy", () => {
  it("pins guest-local /tmp when a Hermes home is mapped", () => {
    const env: Record<string, string> = { HERMES_HOME: "/home/kaladin/.hermes" };
    applyGuestTempPolicy(env);
    assert.equal(env.TMPDIR, "/tmp");
  });

  it("never overrides a caller-chosen TMPDIR", () => {
    const env: Record<string, string> = { HERMES_HOME: "/home/k", TMPDIR: "/var/tmp" };
    applyGuestTempPolicy(env);
    assert.equal(env.TMPDIR, "/var/tmp");
  });

  it("leaves a non-Hermes harness environment untouched", () => {
    const env: Record<string, string> = { PI_CODING_AGENT_DIR: "/opt/pi" };
    applyGuestTempPolicy(env);
    assert.equal(env.TMPDIR, undefined);
  });

  it("tolerates an absent env", () => {
    assert.doesNotThrow(() => applyGuestTempPolicy(undefined));
  });
});
