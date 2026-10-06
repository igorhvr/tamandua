import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG,
  MATCHLOCK_ROOT_USAGE_REFUSAL_MESSAGE,
  MATCHLOCK_ROOT_USAGE_REFUSED_CODE,
  MATCHLOCK_ROOT_USAGE_WARNING,
  MATCHLOCK_ROOT_USAGE_WARNING_CODE,
  MatchlockRootUsageError,
  assertMatchlockRootUsageAllowed,
  currentMatchlockEuid,
  evaluateMatchlockRootUsage,
} from "../../../dist/installer/matchlock/root-gate.js";
import { MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG as CLI_ROOT_USAGE_OVERRIDE_FLAG } from "../../../dist/cli/matchlock-interactive-args.js";

const OVERRIDE_FLAG =
  "--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs";

describe("matchlock root-usage gate — constants and canonical flag", () => {
  it("exports the typed refusal code and warning code", () => {
    assert.equal(MATCHLOCK_ROOT_USAGE_REFUSED_CODE, "matchlock_root_usage_refused");
    assert.equal(MATCHLOCK_ROOT_USAGE_WARNING_CODE, "root_usage_override");
  });

  it("owns the exact override flag spelling and the interactive parser re-exports it", () => {
    assert.equal(MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG, OVERRIDE_FLAG);
    // Drift guard: the CLI parser must point at the same canonical constant.
    assert.equal(CLI_ROOT_USAGE_OVERRIDE_FLAG, MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG);
  });

  it("refusal message names the override flag and the unprivileged rule", () => {
    assert.ok(MATCHLOCK_ROOT_USAGE_REFUSAL_MESSAGE.includes(OVERRIDE_FLAG));
    assert.match(MATCHLOCK_ROOT_USAGE_REFUSAL_MESSAGE, /unprivileged/);
    assert.match(MATCHLOCK_ROOT_USAGE_REFUSAL_MESSAGE, /never for running matchlock itself/);
  });

  it("shared warning text states root execution is authorized by this invocation", () => {
    assert.ok(MATCHLOCK_ROOT_USAGE_WARNING.includes(OVERRIDE_FLAG));
    assert.match(MATCHLOCK_ROOT_USAGE_WARNING, /unprivileged/);
    // The warning describes authorization, never that execution occurred as root.
    assert.doesNotMatch(MATCHLOCK_ROOT_USAGE_WARNING, /executed as root/);
  });
});

describe("evaluateMatchlockRootUsage — injectable euid", () => {
  it("acceptance 1: euid 0 without the override refuses with the typed code naming the flag", () => {
    const decision = evaluateMatchlockRootUsage({ euid: 0, rootUsageOverride: false });
    assert.equal(decision.allowed, false);
    if (decision.allowed) throw new Error("expected refusal");
    assert.equal(decision.code, MATCHLOCK_ROOT_USAGE_REFUSED_CODE);
    assert.equal(decision.flag, MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG);
    assert.ok(decision.message.includes(OVERRIDE_FLAG));
  });

  it("acceptance 2: euid 0 with the override proceeds and returns the shared warning", () => {
    const decision = evaluateMatchlockRootUsage({ euid: 0, rootUsageOverride: true });
    assert.equal(decision.allowed, true);
    if (!decision.allowed) throw new Error("expected permission");
    assert.equal(decision.warning, MATCHLOCK_ROOT_USAGE_WARNING);
  });

  it("acceptance 3: a non-root euid proceeds without the override and without a warning", () => {
    for (const euid of [1, 1000, 501, 65534]) {
      const decision = evaluateMatchlockRootUsage({ euid, rootUsageOverride: false });
      assert.deepEqual(decision, { allowed: true }, `euid ${euid}`);
    }
  });

  it("non-root with the override also proceeds (consent irrelevant, no warning)", () => {
    assert.deepEqual(evaluateMatchlockRootUsage({ euid: 1000, rootUsageOverride: true }), {
      allowed: true,
    });
  });

  it("consent is session-scoped: root refuses for every absent/false consent spelling", () => {
    const absent = evaluateMatchlockRootUsage({ euid: 0, rootUsageOverride: false });
    assert.equal(absent.allowed, false);
    if (absent.allowed) throw new Error("expected refusal");
    assert.equal(absent.code, MATCHLOCK_ROOT_USAGE_REFUSED_CODE);
  });

  it("never infers consent from SUDO_UID in the environment", () => {
    const previous = process.env.SUDO_UID;
    process.env.SUDO_UID = "0";
    try {
      const decision = evaluateMatchlockRootUsage({ euid: 0, rootUsageOverride: false });
      assert.equal(decision.allowed, false, "SUDO_UID must not grant root consent");
    } finally {
      if (previous === undefined) delete process.env.SUDO_UID;
      else process.env.SUDO_UID = previous;
    }
  });

  it("is pure: repeated evaluation yields the same decision", () => {
    const first = evaluateMatchlockRootUsage({ euid: 0, rootUsageOverride: true });
    const second = evaluateMatchlockRootUsage({ euid: 0, rootUsageOverride: true });
    assert.deepEqual(first, second);
  });
});

describe("assertMatchlockRootUsageAllowed", () => {
  it("acceptance 2: root with the override returns the shared warning and does not throw", () => {
    assert.equal(
      assertMatchlockRootUsageAllowed({ euid: 0, rootUsageOverride: true }),
      MATCHLOCK_ROOT_USAGE_WARNING,
    );
  });

  it("acceptance 3: non-root returns undefined without the override", () => {
    assert.equal(assertMatchlockRootUsageAllowed({ euid: 1000 }), undefined);
  });

  it("throws a typed MatchlockRootUsageError for root without the override", () => {
    assert.throws(
      () => assertMatchlockRootUsageAllowed({ euid: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof MatchlockRootUsageError);
        assert.equal(error.code, MATCHLOCK_ROOT_USAGE_REFUSED_CODE);
        assert.equal(error.flag, MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG);
        assert.equal(error.name, "MatchlockRootUsageError");
        assert.ok(error.message.includes(OVERRIDE_FLAG));
        return true;
      },
    );
  });

  it("treats an explicit false override the same as absent", () => {
    assert.throws(
      () => assertMatchlockRootUsageAllowed({ euid: 0, rootUsageOverride: false }),
      MatchlockRootUsageError,
    );
  });

  it("acceptance 4: injected euid alone drives the decision (no real root needed)", () => {
    // Root is refused purely from the injected value…
    assert.throws(() => assertMatchlockRootUsageAllowed({ euid: 0 }), MatchlockRootUsageError);
    // …and a non-root euid is allowed purely from the injected value.
    assert.equal(assertMatchlockRootUsageAllowed({ euid: 4242 }), undefined);
  });
});

describe("currentMatchlockEuid", () => {
  it("reports the real process effective uid when the platform provides it", () => {
    const geteuid = process.geteuid;
    if (typeof geteuid === "function") {
      assert.equal(currentMatchlockEuid(), process.geteuid());
      assert.equal(typeof currentMatchlockEuid(), "number");
    } else {
      assert.throws(() => currentMatchlockEuid(), MatchlockRootUsageError);
    }
  });

  it("defaults the gate to the real effective uid when none is injected", () => {
    if (typeof process.geteuid !== "function") return;
    const expected =
      process.geteuid() === 0
        ? MATCHLOCK_ROOT_USAGE_WARNING
        : undefined;
    // The override is irrelevant for non-root; for root this supplies consent.
    assert.equal(assertMatchlockRootUsageAllowed({ rootUsageOverride: true }), expected);
  });
});
