/**
 * harness-union.test.ts — MTLK-INTEGRATE US-005.
 *
 * Focused, explicit matrix coverage for the three-harness union of the four
 * Matchlock source contracts (MTLK-PI-EXEC, MTLK-HERMES-EXEC, MTLK-DSH-EXEC,
 * MTLK-WORKFLOWS):
 *
 *   - `policy.ts`: ONE ExecutionIsolation record with harness pi|hermes|dsh,
 *     each harness's OWN frozen submission/config-root/profile/guest-mount
 *     selection. Every cross-harness / mixed / malformed shape fails closed
 *     BOTH at build time (buildMatchlockPolicy) and on read of a persisted
 *     record (parseMatchlockPolicy / matchlockPolicyValidationErrors), and the
 *     serialization round-trip preserves harness + per-harness submission.
 *   - `dispatch-guard.ts`: a SINGLE generic `ctx.harnessType !== policy.harness`
 *     rule refuses all six cross-harness mismatches before any
 *     probe/findBinary/spawn/VM create. The guard is a pure decision function
 *     (no native imports, no I/O), so the refusal is pre-effect by
 *     construction; the assertions pin the returned refusal and its
 *     "before any native probe … before any VM create" contract.
 *
 * This file is pure (no node:child_process, no daemon lifecycle) and lives in
 * the parallel test lane.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildMatchlockPolicy,
  serializeMatchlockPolicy,
  parseMatchlockPolicy,
  isExecutionIsolationPolicy,
  matchlockPolicyValidationErrors,
  MatchlockPolicyError,
  type ExecutionIsolation,
} from "../../../dist/installer/matchlock/policy.js";
import { matchlockDispatchDecision } from "../../../dist/installer/matchlock/dispatch-guard.js";

const PIN = {
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  config_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  tag: "vic/ml:latest",
};

/** pi default record shape (harness pi). */
const PI_BASE = {
  requestedImage: "vic/ml:latest",
  identity: PIN,
  harness: "pi" as const,
  workingDirectory: "/opt/project",
  originalRepositoryRoot: "/opt/project",
  workMounts: [
    { hostPath: "/opt/project", hostRealPath: "/opt/project", guestPath: "/opt/project" },
  ],
  gitMetadataRoots: [] as string[],
};

/** FROZEN Hermes submission inputs (homeDir + HERMES_HOME snapshot + cwd). */
const HERMES_SUBMISSION = {
  homeDir: "/home/operator",
  cwd: "/opt/project",
  hermesHomeEnv: null as string | null,
};

/** hermes record shape (harness hermes + its OWN selection trio). */
const HERMES_BASE = {
  ...PI_BASE,
  harness: "hermes" as const,
  configurationRoot: "/home/operator/.hermes",
  configurationProfile: "default",
  guestConfigurationRoot: "/workspace/config/hermes",
  hermes: { ...HERMES_SUBMISSION },
};

/** dsh record shape (harness dsh + its FROZEN submission context). */
function dshBase(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...PI_BASE,
    harness: "dsh",
    configurationRoot: "/home/operator/.dsh",
    submissionHomeDir: "/home/operator",
    submissionCwd: "/home/operator/work",
    submissionDshHomeEnv: null,
    submissionDshHomeSource: "default",
    ...over,
  };
}

function buildThrows(params: Record<string, unknown>, fragment: RegExp): void {
  assert.throws(
    () => buildMatchlockPolicy(params as never),
    (err: unknown) =>
      err instanceof MatchlockPolicyError &&
      err.code === "policy_invalid_record" &&
      fragment.test(err.message),
    `buildMatchlockPolicy must fail closed (${fragment})`,
  );
}

function parseThrows(record: Record<string, unknown>, fragment: RegExp): void {
  assert.throws(
    () => parseMatchlockPolicy(JSON.stringify(record)),
    (err: unknown) =>
      err instanceof MatchlockPolicyError &&
      err.code === "policy_invalid_record" &&
      fragment.test(err.message),
    `parseMatchlockPolicy must fail closed (${fragment})`,
  );
}

/** A persisted structural mutation of a valid record. */
function asRecord(policy: ExecutionIsolation): Record<string, unknown> {
  return policy as unknown as Record<string, unknown>;
}

describe("harness union — accept paths for pi, hermes and dsh", () => {
  it("accepts a harness-pi record (default selection, no other harness's submission)", () => {
    const policy = buildMatchlockPolicy(PI_BASE);
    assert.equal(policy.harness, "pi");
    assert.equal(policy.hermes, undefined);
    assert.equal(policy.submissionHomeDir, undefined);
    assert.equal(policy.submissionCwd, undefined);
    assert.equal(policy.submissionDshHomeEnv, undefined);
    assert.equal(policy.submissionDshHomeSource, undefined);

    const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
    assert.deepEqual(parsed, policy);
    assert.ok(isExecutionIsolationPolicy(parsed));
  });

  it("accepts a harness-hermes record carrying its FROZEN submission block", () => {
    const policy = buildMatchlockPolicy(HERMES_BASE);
    assert.equal(policy.harness, "hermes");
    assert.deepEqual(policy.hermes, HERMES_SUBMISSION);
    assert.equal(policy.configurationRoot, "/home/operator/.hermes");
    assert.equal(policy.configurationProfile, "default");
    assert.equal(policy.guestConfigurationRoot, "/workspace/config/hermes");

    const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
    assert.deepEqual(parsed, policy);
    assert.deepEqual(parsed.hermes, HERMES_SUBMISSION);
    assert.ok(isExecutionIsolationPolicy(parsed));
  });

  it("accepts a harness-dsh record carrying its FROZEN submission context", () => {
    const policy = buildMatchlockPolicy(dshBase() as never);
    assert.equal(policy.harness, "dsh");
    assert.equal(policy.configurationRoot, "/home/operator/.dsh");
    assert.equal(policy.configurationProfile, "headless");
    assert.equal(policy.guestConfigurationRoot, "/workspace/config/dsh");
    assert.equal(policy.submissionHomeDir, "/home/operator");
    assert.equal(policy.submissionCwd, "/home/operator/work");
    assert.equal(policy.submissionDshHomeEnv, null);
    assert.equal(policy.submissionDshHomeSource, "default");
    assert.equal(policy.hermes, undefined);

    const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
    assert.deepEqual(parsed, policy);
    assert.ok(isExecutionIsolationPolicy(parsed));
  });

  it("treats an omitted harness as the pi default but refuses a submitted other-harness block", () => {
    const { harness: _h, ...withoutHarness } = PI_BASE;
    const policy = buildMatchlockPolicy(withoutHarness as never);
    assert.equal(policy.harness, "pi");
    // A pi-default record that carries a hermes block is still ambiguous and refused.
    buildThrows(
      { ...withoutHarness, hermes: HERMES_SUBMISSION },
      /must not carry a hermes submission block/,
    );
  });
});

describe("harness union — build-time refusal of unknown/cross-harness/malformed shapes", () => {
  it("refuses an unknown harness value", () => {
    buildThrows(
      { ...PI_BASE, harness: "custom-harness" },
      /harness must be "pi", "hermes" or "dsh"/,
    );
  });

  it("refuses a hermes record that also carries dsh-only submission fields", () => {
    buildThrows(
      { ...HERMES_BASE, submissionHomeDir: "/home/operator" },
      /must not carry the dsh-only frozen submission-context fields/,
    );
    buildThrows(
      { ...HERMES_BASE, submissionCwd: "/home/operator/work" },
      /must not carry the dsh-only frozen submission-context fields/,
    );
  });

  it("refuses a dsh record missing its FROZEN submission context", () => {
    buildThrows(
      { ...dshBase(), submissionHomeDir: undefined },
      /requires the frozen submission homeDir/,
    );
    buildThrows(
      { ...dshBase(), submissionCwd: undefined },
      /requires the frozen submission cwd/,
    );
    buildThrows(
      { ...dshBase(), submissionHomeDir: "relative/home" },
      /requires the frozen submission homeDir/,
    );
  });

  it("refuses a dsh record whose DSH_HOME env/source selection is inconsistent or malformed", () => {
    buildThrows(
      { ...dshBase(), submissionDshHomeSource: "env", submissionDshHomeEnv: null },
      /requires the captured non-empty DSH_HOME env value/,
    );
    buildThrows(
      { ...dshBase(), submissionDshHomeSource: "sideways" },
      /submissionDshHomeSource must be "env" or "default"/,
    );
  });

  it("refuses a pi record that carries either other harness's submission block", () => {
    buildThrows(
      { ...PI_BASE, hermes: HERMES_SUBMISSION },
      /must not carry a hermes submission block/,
    );
    buildThrows(
      { ...PI_BASE, submissionHomeDir: "/home/operator", submissionCwd: "/home/operator/work" },
      /must not carry the dsh-only frozen submission-context fields/,
    );
  });

  it("refuses a dsh record that also carries a hermes submission block (mixed record)", () => {
    buildThrows(
      { ...dshBase(), hermes: HERMES_SUBMISSION },
      /must not carry a hermes submission block/,
    );
  });

  it("refuses a mixed/invalid frozen hermes submission block", () => {
    buildThrows(
      { ...HERMES_BASE, hermes: { ...HERMES_SUBMISSION, homeDir: "relative/home" } },
      /requires the FROZEN Hermes submission inputs/,
    );
    buildThrows(
      { ...HERMES_BASE, hermes: { ...HERMES_SUBMISSION, cwd: "relative/cwd" } },
      /requires the FROZEN Hermes submission inputs/,
    );
    buildThrows(
      { ...HERMES_BASE, hermes: { ...HERMES_SUBMISSION, extraField: 1 } },
      /requires the FROZEN Hermes submission inputs/,
    );
    buildThrows(
      { ...HERMES_BASE, hermes: "not-an-object" },
      /requires the FROZEN Hermes submission inputs/,
    );
  });
});

describe("harness union — persisted-record validation fails closed (parse matrix)", () => {
  it("refuses an unknown harness on a persisted record", () => {
    const record = asRecord(buildMatchlockPolicy(dshBase() as never));
    record.harness = "custom-harness";
    parseThrows(record, /harness must be "pi", "hermes" or "dsh"/);
  });

  it("refuses a persisted hermes record carrying dsh fields", () => {
    const record = asRecord(buildMatchlockPolicy(HERMES_BASE));
    record.submissionHomeDir = "/home/operator";
    record.submissionCwd = "/home/operator/work";
    record.submissionDshHomeEnv = null;
    record.submissionDshHomeSource = "default";
    parseThrows(record, /field "submissionHomeDir" is only valid on dsh/);
  });

  it("refuses a persisted dsh record missing its frozen submission context", () => {
    const missingHome = asRecord(buildMatchlockPolicy(dshBase() as never));
    delete missingHome.submissionHomeDir;
    parseThrows(missingHome, /submissionHomeDir is required for dsh policies/);

    const missingEnv = asRecord(buildMatchlockPolicy(dshBase() as never));
    delete missingEnv.submissionDshHomeEnv;
    parseThrows(missingEnv, /submissionDshHomeEnv is required for dsh policies/);

    const relativeCwd = asRecord(buildMatchlockPolicy(dshBase() as never));
    relativeCwd.submissionCwd = "relative/work";
    parseThrows(relativeCwd, /submissionCwd is required for dsh policies/);
  });

  it("refuses a persisted pi record carrying a hermes submission block", () => {
    const record = asRecord(buildMatchlockPolicy(PI_BASE));
    record.hermes = HERMES_SUBMISSION;
    parseThrows(record, /harness "pi" must not carry a hermes submission block/);
  });

  it("refuses a persisted pi record carrying dsh-only submission fields", () => {
    const record = asRecord(buildMatchlockPolicy(PI_BASE));
    record.submissionHomeDir = "/home/operator";
    record.submissionCwd = "/home/operator/work";
    record.submissionDshHomeEnv = null;
    record.submissionDshHomeSource = "default";
    parseThrows(record, /field "submissionHomeDir" is only valid on dsh/);
  });

  it("refuses a persisted dsh record carrying a hermes submission block", () => {
    const record = asRecord(buildMatchlockPolicy(dshBase() as never));
    record.hermes = HERMES_SUBMISSION;
    parseThrows(record, /harness "dsh" must not carry a hermes submission block/);
  });

  it("refuses a persisted mixed/invalid frozen hermes submission block", () => {
    const relativeCwd = asRecord(buildMatchlockPolicy(HERMES_BASE));
    (relativeCwd.hermes as Record<string, unknown>).cwd = "relative/cwd";
    parseThrows(relativeCwd, /harness "hermes" requires the FROZEN hermes submission block/);

    const extraKey = asRecord(buildMatchlockPolicy(HERMES_BASE));
    (extraKey.hermes as Record<string, unknown>).extraField = 1;
    parseThrows(extraKey, /harness "hermes" requires the FROZEN hermes submission block/);

    const missingBlock = asRecord(buildMatchlockPolicy(HERMES_BASE));
    delete missingBlock.hermes;
    parseThrows(missingBlock, /harness "hermes" requires the FROZEN hermes submission block/);
  });

  it("matchlockPolicyValidationErrors enumerates the exact union failures", () => {
    const unknown = asRecord(buildMatchlockPolicy(PI_BASE));
    unknown.harness = "custom-harness";
    assert.match(matchlockPolicyValidationErrors(unknown).join("; "), /harness must be "pi", "hermes" or "dsh"/);

    const piWithHermes = asRecord(buildMatchlockPolicy(PI_BASE));
    piWithHermes.hermes = HERMES_SUBMISSION;
    assert.match(matchlockPolicyValidationErrors(piWithHermes).join("; "), /harness "pi" must not carry a hermes submission block/);

    const dshNoContext = asRecord(buildMatchlockPolicy(dshBase() as never));
    delete dshNoContext.submissionHomeDir;
    delete dshNoContext.submissionCwd;
    const dshErrors = matchlockPolicyValidationErrors(dshNoContext).join("; ");
    assert.match(dshErrors, /submissionHomeDir is required for dsh policies/);
    assert.match(dshErrors, /submissionCwd is required for dsh policies/);
  });
});

describe("harness union — serialization round-trip preserves harness + per-harness submission", () => {
  it("round-trips pi, hermes and dsh records without losing the harness or its submission", () => {
    const pi = buildMatchlockPolicy(PI_BASE);
    const hermes = buildMatchlockPolicy(HERMES_BASE);
    const dsh = buildMatchlockPolicy(dshBase() as never);

    for (const [name, policy] of [
      ["pi", pi],
      ["hermes", hermes],
      ["dsh", dsh],
    ] as const) {
      const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
      assert.equal(parsed.harness, name, `${name} harness must round-trip`);
      assert.deepEqual(parsed, policy, `${name} record must round-trip equal`);
      assert.ok(isExecutionIsolationPolicy(parsed), `${name} round-trip must stay valid`);
    }

    // Explicit per-harness submission preservation.
    assert.deepEqual(parseMatchlockPolicy(serializeMatchlockPolicy(hermes)).hermes, HERMES_SUBMISSION);
    const parsedDsh = parseMatchlockPolicy(serializeMatchlockPolicy(dsh));
    assert.equal(parsedDsh.submissionHomeDir, "/home/operator");
    assert.equal(parsedDsh.submissionCwd, "/home/operator/work");
    assert.equal(parsedDsh.submissionDshHomeSource, "default");
    assert.equal(parsedDsh.submissionDshHomeEnv, null);
  });
});

describe("harness union — dispatch-guard generic harness-match rule (six mismatches before any effect)", () => {
  const policies: Array<{ name: "pi" | "hermes" | "dsh"; json: string }> = [
    { name: "pi", json: serializeMatchlockPolicy(buildMatchlockPolicy(PI_BASE)) },
    { name: "hermes", json: serializeMatchlockPolicy(buildMatchlockPolicy(HERMES_BASE)) },
    { name: "dsh", json: serializeMatchlockPolicy(buildMatchlockPolicy(dshBase() as never)) },
  ];
  const harnesses: Array<"pi" | "hermes" | "dsh"> = ["pi", "hermes", "dsh"];

  it("refuses every one of the six policy×context harness mismatches before any probe/spawn/VM", () => {
    let refusedCount = 0;
    for (const policy of policies) {
      for (const contextHarness of harnesses) {
        const decision = matchlockDispatchDecision(policy.json, {
          workflowId: "do-now",
          harnessType: contextHarness,
        });
        if (policy.name === contextHarness) {
          assert.equal(decision.refused, false, `${policy.name}+${contextHarness} must match`);
          continue;
        }
        refusedCount += 1;
        assert.equal(decision.refused, true, `${policy.name} policy + ${contextHarness} context must refuse`);
        if (!decision.refused) continue;
        assert.equal(decision.code, "matchlock_workflow_unsupported");
        assert.equal(decision.policy?.harness, policy.name);
        assert.match(
          decision.message,
          new RegExp(`only supported with the ${policy.name} harness`),
          `${policy.name} policy refusal must name the admitted harness`,
        );
        // Pin the pre-effect contract: the guard refuses before any native
        // probe/harness and before any VM create.
        assert.match(decision.message, /before any native probe\/harness and before any VM create/);
      }
    }
    assert.equal(refusedCount, 6, "all six cross-harness mismatches must be refused");
  });

  it("matches by value with a single generic rule (an unknown context harness is also refused)", () => {
    for (const policy of policies) {
      const decision = matchlockDispatchDecision(policy.json, {
        workflowId: "do-now",
        harnessType: "custom-harness",
      });
      assert.equal(decision.refused, true, `unknown context harness must refuse against a ${policy.name} policy`);
      if (!decision.refused) continue;
      assert.match(decision.message, new RegExp(`only supported with the ${policy.name} harness`));
    }
  });

  it("treats an absent/blank context harness as no mismatch (workflow axis still decides)", () => {
    const piJson = policies[0].json;
    for (const harnessType of [undefined, "", "   "]) {
      const decision = matchlockDispatchDecision(piJson, { workflowId: "do-now", harnessType });
      assert.equal(decision.refused, false, `blank harness (${JSON.stringify(harnessType)}) must not force a mismatch`);
    }
  });

  it("carries the per-admitted-harness launch hint in each refusal", () => {
    // policy harness pi → pi hint
    const piMismatch = matchlockDispatchDecision(policies[0].json, { workflowId: "do-now", harnessType: "dsh" });
    assert.equal(piMismatch.refused, true);
    if (piMismatch.refused) assert.match(piMismatch.message, /--pi-as-harness/);
    // policy harness hermes → hermes hint
    const hermesMismatch = matchlockDispatchDecision(policies[1].json, { workflowId: "do-now", harnessType: "pi" });
    assert.equal(hermesMismatch.refused, true);
    if (hermesMismatch.refused) assert.match(hermesMismatch.message, /--hermes-as-harness --matchlock/);
    // policy harness dsh → dsh hint
    const dshMismatch = matchlockDispatchDecision(policies[2].json, { workflowId: "do-now", harnessType: "pi" });
    assert.equal(dshMismatch.refused, true);
    if (dshMismatch.refused) assert.match(dshMismatch.message, /--dsh-as-harness/);
  });
});
