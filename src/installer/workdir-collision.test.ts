/**
 * Unit tests for the shared harness working-directory collision policy
 * (WORKDIR-FLAGS, US-001).
 *
 * The module is pure and is the single source of truth for the policy
 * resolution and the exact refusal/warning text, so these tests pin the
 * literals every later story imports instead of re-typing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WORKDIR_COLLISION_POLICY_KEY,
  WORKDIR_REFUSAL_EXIT_CODE,
  WORKDIR_REFUSAL_STATE,
  WORKDIR_SHARED_WARNING_MARKER,
  parseWorkdirCollisionPolicy,
  resolveWorkdirCollisionPolicy,
  formatWorkdirRefusalMessage,
  formatSharedWorkdirWarning,
  type WorkdirCollisionHolder,
} from "../../dist/installer/workdir-collision.js";

const HOLDER: WorkdirCollisionHolder = {
  runId: "run-abc123",
  runNumber: 27,
  workflowId: "feature-dev-merge",
  status: "running",
  since: "2026-09-16T05:00:00.000Z",
};

describe("workdir-collision constants", () => {
  it("exposes the shared policy key and values", () => {
    assert.equal(WORKDIR_COLLISION_POLICY_KEY, "workdir_collision_policy");
    assert.equal(WORKDIR_REFUSAL_EXIT_CODE, 75);
    assert.equal(WORKDIR_REFUSAL_STATE, "refused");
    assert.equal(
      WORKDIR_SHARED_WARNING_MARKER,
      "control-server: register-run shared harness workdir allowed",
    );
  });
});

describe("parseWorkdirCollisionPolicy", () => {
  it("accepts the three valid policies", () => {
    assert.equal(parseWorkdirCollisionPolicy("refuse"), "refuse");
    assert.equal(parseWorkdirCollisionPolicy("queue"), "queue");
    assert.equal(parseWorkdirCollisionPolicy("allow"), "allow");
  });

  it("rejects non-exact variants (only the three valid strings)", () => {
    assert.equal(parseWorkdirCollisionPolicy("QUEUE"), undefined);
    assert.equal(parseWorkdirCollisionPolicy("Allow"), undefined);
    assert.equal(parseWorkdirCollisionPolicy(" queue "), undefined);
    assert.equal(parseWorkdirCollisionPolicy("  refuse"), undefined);
  });

  it("returns undefined for invalid or non-string values", () => {
    assert.equal(parseWorkdirCollisionPolicy(""), undefined);
    assert.equal(parseWorkdirCollisionPolicy("bogus"), undefined);
    assert.equal(parseWorkdirCollisionPolicy(undefined), undefined);
    assert.equal(parseWorkdirCollisionPolicy(null), undefined);
    assert.equal(parseWorkdirCollisionPolicy(1), undefined);
    assert.equal(parseWorkdirCollisionPolicy("true"), undefined);
  });
});

describe("resolveWorkdirCollisionPolicy", () => {
  it("defaults to refuse with no context and no env", () => {
    assert.equal(resolveWorkdirCollisionPolicy({}, {}), "refuse");
  });

  it("context queue wins over env allow", () => {
    assert.equal(
      resolveWorkdirCollisionPolicy(
        { [WORKDIR_COLLISION_POLICY_KEY]: "queue" },
        { TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR: "1" },
      ),
      "queue",
    );
  });

  it("context allow wins over env", () => {
    assert.equal(
      resolveWorkdirCollisionPolicy(
        { [WORKDIR_COLLISION_POLICY_KEY]: "allow" },
        {},
      ),
      "allow",
    );
  });

  it("context refuse wins over env allow", () => {
    assert.equal(
      resolveWorkdirCollisionPolicy(
        { [WORKDIR_COLLISION_POLICY_KEY]: "refuse" },
        { TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR: "1" },
      ),
      "refuse",
    );
  });

  it("invalid context value falls through to the env", () => {
    assert.equal(
      resolveWorkdirCollisionPolicy(
        { [WORKDIR_COLLISION_POLICY_KEY]: "nonsense" },
        { TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR: "1" },
      ),
      "allow",
    );
    assert.equal(
      resolveWorkdirCollisionPolicy(
        { [WORKDIR_COLLISION_POLICY_KEY]: "" },
        {},
      ),
      "refuse",
    );
  });

  it("env=1 alone yields allow", () => {
    assert.equal(
      resolveWorkdirCollisionPolicy({}, {
        TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR: "1",
      }),
      "allow",
    );
  });

  it("env values other than 1 do not enable allow", () => {
    for (const value of ["0", "true", "yes", "", "01"]) {
      assert.equal(
        resolveWorkdirCollisionPolicy({}, {
          TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR: value,
        }),
        "refuse",
      );
    }
  });

  it("defaults the env argument to process.env", () => {
    const previous = process.env.TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR;
    try {
      process.env.TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR = "1";
      assert.equal(resolveWorkdirCollisionPolicy({}), "allow");
    } finally {
      if (previous === undefined) {
        delete process.env.TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR;
      } else {
        process.env.TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR = previous;
      }
    }
  });
});

describe("formatWorkdirRefusalMessage", () => {
  const dir = "/home/kaladin/checkout";

  it("names the holder and the three ways out", () => {
    const message = formatWorkdirRefusalMessage(HOLDER, dir);
    assert.match(message, /already held by run/);
    assert.ok(message.includes("#27"));
    assert.ok(message.includes("feature-dev-merge"));
    assert.ok(message.includes("status running"));
    assert.ok(message.includes(HOLDER.since));
    assert.ok(message.includes(dir));
    assert.ok(message.includes("--queue-behind-holder"));
    assert.ok(
      message.includes("--allow-multiple-runs-in-one-working-directory"),
    );
    assert.ok(message.includes("TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1"));
    assert.ok(message.includes("-worktree"));
    assert.match(message, /retry later/i);
  });

  it("puts the options on their own lines after the headline", () => {
    const message = formatWorkdirRefusalMessage(HOLDER, dir);
    const [headline, ...rest] = message.split("\n");
    assert.match(
      headline,
      /^Cannot start run: harness working directory .* is already held by run #27 /,
    );
    assert.ok(rest.length >= 4);
    assert.equal(rest[0].trim(), "Retry later once the holder finishes, or:");
  });

  it("substitutes the runId when runNumber is null and never prints null", () => {
    const message = formatWorkdirRefusalMessage(
      { ...HOLDER, runNumber: null },
      dir,
    );
    assert.ok(message.includes("run-abc123"));
    assert.doesNotMatch(message, /\bnull\b/);
    assert.doesNotMatch(message, /#null/);
    assert.match(message, /already held by run/);
  });
});

describe("formatSharedWorkdirWarning", () => {
  it("is one line containing the directory", () => {
    const warning = formatSharedWorkdirWarning("/home/kaladin/checkout");
    assert.equal(warning.split("\n").length, 1);
    assert.ok(warning.includes("/home/kaladin/checkout"));
    assert.match(
      warning,
      /^Warning: sharing harness working directory .* with another live run; concurrent git writes are the caller's responsibility\.$/,
    );
  });

  it("is workflow-agnostic (no merge-specific wording)", () => {
    const warning = formatSharedWorkdirWarning("/home/kaladin/other-checkout");
    assert.doesNotMatch(warning, /merge/i);
  });
});
