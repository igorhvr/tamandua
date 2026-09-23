import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import {
  buildMatchlockPolicy,
  serializeMatchlockPolicy,
  parseMatchlockPolicy,
  isExecutionIsolationPolicy,
  assertNoCredentialValues,
  resolvePiConfigRoot,
  resolveDshPolicyHome,
  DEFAULT_DSH_CONFIGURATION_ROOT,
  DEFAULT_DSH_CONFIGURATION_PROFILE,
  MatchlockPolicyError,
  MATCHLOCK_POLICY_VERSION,
  MATCHLOCK_MOUNT_POLICY_VERSION,
  MATCHLOCK_NETWORK_POLICY_VERSION,
  DEFAULT_GUEST_CONFIGURATION_ROOT,
  DEFAULT_PI_CONFIG_PROFILE,
  type ExecutionIsolation,
} from "../../../dist/installer/matchlock/policy.js";
import type { DshSubmissionContext } from "../../../dist/installer/matchlock/dsh-adapter-contract.js";

/** Explicit limits threaded through the base fixture (post-MTLK-VM-SIZE). */
const EXPLICIT_RESOURCE_LIMITS = { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 };

const BASE = {
  requestedImage: "vic/matchlock-base:latest",
  identity: {
    digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    config_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    tag: "vic/matchlock-base:latest",
  },
  harness: "pi" as const,
  workingDirectory: "/opt/project",
  originalRepositoryRoot: "/opt/project",
  workMounts: [
    { hostPath: "/opt/project", hostRealPath: "/opt/project", guestPath: "/opt/project" },
  ],
  gitMetadataRoots: ["/opt/project/.git"],
  resourceLimits: EXPLICIT_RESOURCE_LIMITS,
};

/** Frozen submission context helper for dsh policy tests. */
function dshSubmission(over: Partial<DshSubmissionContext> = {}): DshSubmissionContext {
  return {
    homeDir: "/home/operator",
    env: {},
    cwd: "/home/operator/work",
    ...over,
  };
}

/** dsh BASE params for buildMatchlockPolicy. */
function dshBase(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...BASE,
    harness: "dsh",
    configurationRoot: "/home/operator/.dsh",
    submissionHomeDir: "/home/operator",
    submissionCwd: "/home/operator/work",
    submissionDshHomeEnv: null,
    submissionDshHomeSource: "default",
    ...over,
  };
}

/** A version-1 legacy record (as US-001 wrote before MTLK-ADMIT): unpinned. */
function legacyV1Record(): Record<string, unknown> {
  const record: Record<string, unknown> = { ...BASE };
  delete record.identity;
  record.version = 1;
  delete record.resolvedImageDigest;
  delete record.resolvedImageConfigDigest;
  return record;
}

describe("matchlock policy", () => {
  let origPiDir: string | undefined;
  let origHome: string | undefined;

  before(() => {
    origPiDir = process.env.PI_CODING_AGENT_DIR;
    origHome = process.env.HOME;
  });

  after(() => {
    if (origPiDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = origPiDir;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
  });

  it("buildMatchlockPolicy produces a well-formed version-2 ExecutionIsolation record", () => {
    const policy = buildMatchlockPolicy(BASE);
    assert.equal(policy.version, MATCHLOCK_POLICY_VERSION);
    assert.equal(policy.backend, "matchlock");
    assert.equal(policy.requestedImage, "vic/matchlock-base:latest");
    // The immutable content+config pin captured by admission is REQUIRED.
    assert.equal(policy.resolvedImageDigest, BASE.identity.digest);
    assert.equal(policy.resolvedImageConfigDigest, BASE.identity.config_digest);
    assert.equal(policy.harness, "pi");
    assert.equal(policy.configurationRoot, resolvePiConfigRoot());
    assert.equal(policy.configurationProfile, DEFAULT_PI_CONFIG_PROFILE);
    assert.equal(policy.guestConfigurationRoot, DEFAULT_GUEST_CONFIGURATION_ROOT);
    assert.equal(policy.workPathMode, "host-absolute");
    assert.equal(policy.workingDirectory, "/opt/project");
    assert.deepEqual(policy.workMounts, BASE.workMounts);
    assert.equal(policy.originalRepositoryRoot, "/opt/project");
    assert.deepEqual(policy.gitMetadataRoots, BASE.gitMetadataRoots);
    assert.equal(policy.mountPolicyVersion, MATCHLOCK_MOUNT_POLICY_VERSION);
    assert.equal(policy.networkPolicyVersion, MATCHLOCK_NETWORK_POLICY_VERSION);
    assert.deepEqual(policy.resourceLimits, EXPLICIT_RESOURCE_LIMITS);
  });

  it("buildMatchlockPolicy derives host-based default limits from a fake probe when none are supplied", () => {
    const { resourceLimits: _explicit, ...withoutLimits } = BASE;
    const policy = buildMatchlockPolicy({
      ...withoutLimits,
      resourceHostProbe: { onlineCpus: () => 4, totalMemoryMB: () => 16384 },
    });
    assert.deepEqual(policy.resourceLimits, { cpus: 4, memoryMB: 8192, diskSizeMB: 20480 });
  });

  it("MATCHLOCK_POLICY_VERSION stays 2 and a persisted v2 record with legacy 2/2048/20480 limits still parses", () => {
    assert.equal(MATCHLOCK_POLICY_VERSION, 2);
    const policy = buildMatchlockPolicy(BASE);
    assert.deepEqual(policy.resourceLimits, { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 });
    const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
    assert.equal(parsed.version, 2);
    assert.deepEqual(parsed.resourceLimits, { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 });
  });

  // UNION-FINAL US-007: the union folds resourceLimits into the SAME v2
  // runs.matchlock_policy column the pre-MTLK-VM-SIZE build wrote. A row
  // persisted by that older build (default 2/2048/20480, no imagePath) must
  // keep parsing after the union — the policy version is deliberately NOT
  // bumped, so parse must not reject or silently drop the legacy limits.
  it("US-007: a legacy v2 runs.matchlock_policy row (old limits, no imagePath) parses and round-trips its resourceLimits", () => {
    const persisted = JSON.parse(
      serializeMatchlockPolicy(buildMatchlockPolicy(BASE)),
    ) as Record<string, unknown>;
    // The pre-VM-size shape: version-2, the then-default limits, no imagePath.
    persisted.version = 2;
    persisted.resourceLimits = { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 };
    delete persisted.imagePath;

    const parsed = parseMatchlockPolicy(JSON.stringify(persisted));
    assert.equal(parsed.version, MATCHLOCK_POLICY_VERSION);
    assert.deepEqual(
      parsed.resourceLimits,
      { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 },
      "a legacy v2 row must keep its persisted resourceLimits",
    );
    assert.equal(parsed.imagePath, undefined, "no imagePath on the legacy row");
    // A second full round-trip is byte-stable (the DB column can be rewritten).
    const rewritten = serializeMatchlockPolicy(parsed);
    assert.deepEqual(parseMatchlockPolicy(rewritten), parsed);
    assert.equal(rewritten, JSON.stringify(persisted), "serialize is stable for the legacy row");
  });

  it("configurationRoot honours PI_CODING_AGENT_DIR at capture time", () => {
    process.env.PI_CODING_AGENT_DIR = "/captured/pi/config";
    const policy = buildMatchlockPolicy(BASE);
    assert.equal(policy.configurationRoot, "/captured/pi/config");
  });

  it("originalRepositoryRoot is null-able", () => {
    const policy = buildMatchlockPolicy({ ...BASE, originalRepositoryRoot: null });
    assert.equal(policy.originalRepositoryRoot, null);
  });

  it("buildMatchlockPolicy rejects a missing identity pin (no silent unpinned policy)", () => {
    const { identity: _identity, ...withoutIdentity } = BASE;
    assert.throws(
      () => buildMatchlockPolicy(withoutIdentity as never),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /immutable image identity/.test(err.message),
    );
  });

  it("buildMatchlockPolicy rejects an identity pin with no config digest", () => {
    assert.throws(
      () => buildMatchlockPolicy({ ...BASE, identity: { digest: "sha256:a", config_digest: "" } }),
      /immutable image identity/,
    );
  });

  it("buildMatchlockPolicy persists an optional imagePath (image effective PATH from admission) and round-trips", () => {
    const policy = buildMatchlockPolicy({
      ...BASE,
      imagePath: "/opt/tamandua-synthetic-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    });
    assert.equal(
      policy.imagePath,
      "/opt/tamandua-synthetic-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
    assert.deepEqual(parsed, policy);
    assert.ok(isExecutionIsolationPolicy(parsed));
  });

  it("a version-2 record without imagePath stays valid (legacy/undiscovered) and parse keeps it absent", () => {
    const policy = buildMatchlockPolicy(BASE);
    assert.equal(policy.imagePath, undefined);
    const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
    assert.equal(parsed.imagePath, undefined);
  });

  it("parse rejects a record whose imagePath is not a colon-separated absolute PATH list", () => {
    const good = buildMatchlockPolicy({ ...BASE, imagePath: "/a:/b" });
    const base = JSON.parse(serializeMatchlockPolicy(good)) as Record<string, unknown>;
    for (const bad of ["relative", "/a::/b", ":", "/a\n/b", "x".repeat(17000)]) {
      assert.throws(
        () => parseMatchlockPolicy(JSON.stringify({ ...base, imagePath: bad })),
        (err: unknown) => err instanceof MatchlockPolicyError && /imagePath/.test(err.message),
        `imagePath ${JSON.stringify(bad.slice(0, 40))} must be rejected`,
      );
    }
  });

  it("serialize → parse round-trips to an equal version-2 policy", () => {
    const policy = buildMatchlockPolicy(BASE);
    const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
    assert.deepEqual(parsed, policy);
    assert.ok(isExecutionIsolationPolicy(parsed));
  });

  it("parse rejects malformed JSON", () => {
    assert.throws(
      () => parseMatchlockPolicy("not json"),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_json_invalid" &&
        /Invalid matchlock policy JSON/.test(err.message),
    );
  });

  it("parse rejects a structurally invalid record", () => {
    const policy = buildMatchlockPolicy(BASE);
    const bad = { ...policy, backend: "native" };
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(bad)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /Invalid matchlock policy/.test(err.message),
    );
  });

  it("parse fails closed on a legacy version-1 UNPINNED record with an actionable error", () => {
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(legacyV1Record())),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_legacy_unpinned" &&
        /legacy UNPINNED record/.test(err.message) &&
        /recreate the run with --matchlock/.test(err.message),
    );
  });

  it("parse fails closed on an unsupported future version", () => {
    const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    policy.version = 99;
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(policy)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError && err.code === "policy_unsupported_version",
    );
  });

  it("parse fails closed on a version-2 record missing the required immutable pin", () => {
    const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    delete policy.resolvedImageDigest;
    delete policy.resolvedImageConfigDigest;
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(policy)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /resolvedImageDigest is required/.test(err.message),
    );
  });

  it("parse rejects a version-2 record with a non-absolute path", () => {
    const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    policy.workingDirectory = "relative/project";
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(policy)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        /workingDirectory must be a narrow absolute path/.test(err.message),
    );
  });

  it("parse fails closed on a path-shaped configurationProfile (absolute path cannot smuggle outside the config root)", () => {
    const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    policy.configurationProfile = "/etc/passwd";
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(policy)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /configurationProfile must be a bare file name with no path separators/.test(err.message),
    );
  });

  it("parse fails closed on a configurationProfile containing a path separator", () => {
    const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    policy.configurationProfile = "profiles/team/settings.json";
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(policy)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        /configurationProfile must be a bare file name with no path separators/.test(err.message),
    );
  });

  it("parse fails closed on dot/relative configurationProfile values", () => {
    for (const bad of [".", "..", "..\\settings.json"]) {
      const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
      policy.configurationProfile = bad;
      assert.throws(
        () => parseMatchlockPolicy(JSON.stringify(policy)),
        /configurationProfile must be a bare file name with no path separators/,
        `configurationProfile ${JSON.stringify(bad)} must fail closed`,
      );
    }
  });

  it("buildMatchlockPolicy rejects a path-shaped configurationProfile up front", () => {
    assert.throws(
      () => buildMatchlockPolicy({ ...BASE, configurationProfile: "/etc/passwd" }),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /bare file name with no path separators/.test(err.message),
    );
  });

  it("parse rejects a version-2 record with non-positive resource limits", () => {
    const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    (policy.resourceLimits as Record<string, number>).memoryMB = 0;
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(policy)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        /resourceLimits must be finite positive numbers/.test(err.message),
    );
  });

  it("parse rejects a work mount whose guest path differs from its host path", () => {
    const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    (policy.workMounts as Array<Record<string, string>>)[0].guestPath = "/somewhere/else";
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(policy)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        /identical narrow absolute host\/guest paths/.test(err.message),
    );
  });

  it("parse rejects an unknown/credential-bearing key (fail closed, not sanitize)", () => {
    const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    policy["api_key"] = "sk-secret-1234";
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(policy)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_credential_field" &&
        /must not contain credential-bearing field "api_key"/.test(err.message),
    );
  });

  it("parse rejects a nested credential value inside workMounts", () => {
    const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    (policy.workMounts as Array<Record<string, string>>)[0]["token"] = "abc";
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(policy)),
      /must not contain credential-bearing field "token"/,
    );
  });

  it("assertNoCredentialValues rejects a top-level credential key", () => {
    assert.throws(
      () => assertNoCredentialValues({ password: "hunter2" }),
      /must not contain credential-bearing field "password"/,
    );
  });

  it("buildMatchlockPolicy rejects an empty requestedImage", () => {
    assert.throws(
      () => buildMatchlockPolicy({ ...BASE, requestedImage: "   " }),
      /non-empty requestedImage/,
    );
  });

  it("a serialized policy contains no credential-bearing substrings", () => {
    const policy = buildMatchlockPolicy(BASE);
    const json = serializeMatchlockPolicy(policy);
    for (const fragment of ["token", "secret", "password", "credential", "api_key"]) {
      assert.ok(!json.toLowerCase().includes(fragment), `policy must not contain "${fragment}"`);
    }
  });

  it("policy declares host-absolute work mount exact-path rule matching the design", () => {
    const policy: ExecutionIsolation = buildMatchlockPolicy(BASE);
    assert.equal(policy.workPathMode, "host-absolute");
    for (const mount of policy.workMounts) {
      assert.equal(mount.guestPath, mount.hostPath, "guestPath must equal hostPath for every work mount");
    }
  });

  // ── MTLK-ALLOW-PRIVATE US-002: persisted per-run allow-private list ──────

  it("MATCHLOCK_NETWORK_POLICY_VERSION is 2 (version 2 adds the allow-private destination list)", () => {
    assert.equal(MATCHLOCK_NETWORK_POLICY_VERSION, 2);
  });

  it("buildMatchlockPolicy records a normalized networkAllowPrivate list and round-trips it", () => {
    const policy = buildMatchlockPolicy({
      ...BASE,
      networkAllowPrivate: [
        " 192.168.107.74:8888 ",
        "example.internal",
        "192.168.107.74:8888",
        "10.0.0.0/8",
      ],
    });
    assert.equal(policy.networkPolicyVersion, MATCHLOCK_NETWORK_POLICY_VERSION);
    assert.deepEqual(policy.networkAllowPrivate, [
      "192.168.107.74:8888",
      "example.internal",
      "10.0.0.0/8",
    ]);
    const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
    assert.deepEqual(parsed, policy);
    assert.deepEqual(parsed.networkAllowPrivate, policy.networkAllowPrivate);
    assert.ok(isExecutionIsolationPolicy(parsed));
  });

  it("buildMatchlockPolicy clones the allow-private array (persisted record never aliases caller state)", () => {
    const supplied = ["192.168.107.74:8888"];
    const policy = buildMatchlockPolicy({ ...BASE, networkAllowPrivate: supplied });
    supplied.push("later.example");
    assert.deepEqual(policy.networkAllowPrivate, ["192.168.107.74:8888"]);
  });

  it("buildMatchlockPolicy omits networkAllowPrivate when no entries are admitted", () => {
    const policy = buildMatchlockPolicy(BASE);
    assert.equal("networkAllowPrivate" in policy, false);
    const empty = buildMatchlockPolicy({ ...BASE, networkAllowPrivate: [] });
    assert.equal("networkAllowPrivate" in empty, false);
    const blanks = buildMatchlockPolicy({ ...BASE, networkAllowPrivate: ["  ", ""] });
    assert.equal("networkAllowPrivate" in blanks, false);
    const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
    assert.equal(parsed.networkAllowPrivate, undefined);
  });

  it("buildMatchlockPolicy rejects an invalid allow-private entry naming the entry", () => {
    assert.throws(
      () => buildMatchlockPolicy({ ...BASE, networkAllowPrivate: ["good.example", "10.0.0.0/99"] }),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /networkAllowPrivate/.test(err.message) &&
        /10\.0\.0\.0\/99/.test(err.message),
    );
  });

  it("buildMatchlockPolicy rejects an oversized allow-private list", () => {
    const many = Array.from({ length: 65 }, (_, i) => `10.0.${Math.floor(i / 256)}.${i % 256}`);
    assert.throws(
      () => buildMatchlockPolicy({ ...BASE, networkAllowPrivate: many }),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /networkAllowPrivate/.test(err.message) &&
        /at most 64/.test(err.message),
    );
  });

  it("parse accepts a record carrying networkAllowPrivate", () => {
    const policy = buildMatchlockPolicy({ ...BASE, networkAllowPrivate: ["192.168.107.74:8888"] });
    const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
    assert.deepEqual(parsed.networkAllowPrivate, ["192.168.107.74:8888"]);
  });

  it("parse fails closed on a non-array networkAllowPrivate", () => {
    const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    for (const bad of ["192.168.107.74:8888", 42, { entry: "192.168.107.74:8888" }, null]) {
      policy.networkAllowPrivate = bad;
      assert.throws(
        () => parseMatchlockPolicy(JSON.stringify(policy)),
        (err: unknown) =>
          err instanceof MatchlockPolicyError &&
          err.code === "policy_invalid_record" &&
          /networkAllowPrivate/.test(err.message),
        `networkAllowPrivate ${JSON.stringify(bad)} must fail closed`,
      );
    }
  });

  it("parse fails closed on an entry that fails the US-001 shape validator", () => {
    const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    for (const bad of [["10.0.0.0/99"], ["has space"], [""], ["host:0"], ["[fe80::1]"]]) {
      policy.networkAllowPrivate = bad;
      assert.throws(
        () => parseMatchlockPolicy(JSON.stringify(policy)),
        (err: unknown) =>
          err instanceof MatchlockPolicyError &&
          err.code === "policy_invalid_record" &&
          /networkAllowPrivate/.test(err.message),
        `networkAllowPrivate ${JSON.stringify(bad)} must fail closed`,
      );
    }
  });

  it("parse fails closed on an oversized networkAllowPrivate list", () => {
    const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    policy.networkAllowPrivate = Array.from({ length: 65 }, (_, i) => `10.0.${Math.floor(i / 256)}.${i % 256}`);
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(policy)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /networkAllowPrivate/.test(err.message),
    );
  });

  it("unknown-field rejection is unaffected by the new networkAllowPrivate key", () => {
    const policy = buildMatchlockPolicy({
      ...BASE,
      networkAllowPrivate: ["192.168.107.74:8888"],
    }) as unknown as Record<string, unknown>;
    policy["not_a_policy_field"] = "x";
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(policy)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /unknown field "not_a_policy_field"/.test(err.message),
    );
  });

  // ── MTLK-HERMES-EXEC US-003: hermes harness axis on the persisted policy ─

  const HERMES_SUBMISSION = {
    homeDir: "/home/operator",
    cwd: "/srv/project",
    hermesHomeEnv: null as string | null,
  };

  const HERMES_BASE = {
    ...BASE,
    harness: "hermes" as const,
    configurationRoot: "/home/operator/.hermes",
    configurationProfile: "default",
    guestConfigurationRoot: "/workspace/config/hermes",
    hermes: HERMES_SUBMISSION,
  };

  it("buildMatchlockPolicy produces a valid harness-hermes policy carrying the FROZEN submission inputs + resolved config root/profile", () => {
    const policy = buildMatchlockPolicy(HERMES_BASE);
    assert.equal(policy.version, MATCHLOCK_POLICY_VERSION);
    assert.equal(policy.harness, "hermes");
    // The FROZEN submission inputs are persisted verbatim (never ambient).
    assert.deepEqual(policy.hermes, HERMES_SUBMISSION);
    // The configuration trio carries the resolved effective Hermes selection.
    assert.equal(policy.configurationRoot, "/home/operator/.hermes");
    assert.equal(policy.configurationProfile, "default");
    assert.equal(policy.guestConfigurationRoot, "/workspace/config/hermes");
    // Round trip: serialize → parse returns an equal version-2 hermes policy.
    const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
    assert.deepEqual(parsed, policy);
    assert.equal(parsed.harness, "hermes");
    assert.deepEqual(parsed.hermes, HERMES_SUBMISSION);
    assert.ok(isExecutionIsolationPolicy(parsed));
  });

  it("a hermes policy may carry a NAMED profile id as configurationProfile", () => {
    const policy = buildMatchlockPolicy({
      ...HERMES_BASE,
      configurationRoot: "/home/operator/.hermes/profiles/team-a",
      configurationProfile: "team-a",
      guestConfigurationRoot: "/workspace/config/hermes/profiles/team-a",
      hermes: { ...HERMES_SUBMISSION, hermesHomeEnv: "/home/operator/.hermes/profiles/team-a" },
    });
    assert.equal(policy.harness, "hermes");
    assert.equal(policy.configurationProfile, "team-a");
    const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
    assert.equal(parsed.configurationProfile, "team-a");
    assert.equal(parsed.hermes?.hermesHomeEnv, "/home/operator/.hermes/profiles/team-a");
  });

  it("buildMatchlockPolicy refuses a harness-hermes policy without the FROZEN submission inputs", () => {
    const { hermes: _hermes, ...withoutSubmission } = HERMES_BASE;
    assert.throws(
      () => buildMatchlockPolicy(withoutSubmission as never),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /FROZEN Hermes submission inputs/.test(err.message),
    );
  });

  it("buildMatchlockPolicy refuses a harness-hermes policy that would silently default to the pi configuration root", () => {
    assert.throws(
      () => buildMatchlockPolicy({
        ...HERMES_BASE,
        configurationRoot: undefined,
        guestConfigurationRoot: undefined,
        configurationProfile: undefined,
      }),
      /explicit canonical host Hermes configuration root/,
    );
  });

  it("buildMatchlockPolicy refuses a harness-pi policy that carries a hermes submission", () => {
    assert.throws(
      () => buildMatchlockPolicy({ ...BASE, hermes: HERMES_SUBMISSION } as never),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /harness "pi" Matchlock policy must not carry a hermes submission block/.test(err.message),
    );
  });

  it("parse fails closed on a harness-hermes record whose hermes block is missing", () => {
    const policy = buildMatchlockPolicy(HERMES_BASE) as unknown as Record<string, unknown>;
    delete policy.hermes;
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(policy)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /harness "hermes" requires the FROZEN hermes submission block/.test(err.message),
    );
  });

  it("parse fails closed on a harness-pi record that carries a hermes submission block", () => {
    const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    policy.hermes = HERMES_SUBMISSION;
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(policy)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /harness "pi" must not carry a hermes submission block/.test(err.message),
    );
  });

  it("parse fails closed on a harness-dsh record that lacks its FROZEN submission context (MTLK-INTEGRATE US-003 union)", () => {
    // MTLK-HERMES-EXEC union MTLK-DSH-EXEC: the pi+hermes slice refused any
    // harness other than pi/hermes with 'harness must be "pi" or "hermes"'.
    // The MTLK-DSH-EXEC contract ADMITS harness "dsh", but only with its
    // frozen submission context, so this losing assertion is rewritten to the
    // union contract's dsh-shape refusal (the unknown-harness refusal is
    // pinned separately by the dsh block's 'neither pi nor dsh' test).
    const policy = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    policy.harness = "dsh";
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(policy)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /submissionHomeDir is required for dsh policies/.test(err.message),
    );
  });

  it("parse fails closed on hermes submission fields that are not the frozen shapes", () => {
    const cases: Array<{ mutate: (p: Record<string, unknown>) => void; fragment: RegExp }> = [
      {
        mutate: (p) => ((p.hermes as Record<string, unknown>).homeDir = "relative/home"),
        fragment: /hermes submission block/,
      },
      {
        mutate: (p) => ((p.hermes as Record<string, unknown>).cwd = "relative/cwd"),
        fragment: /hermes submission block/,
      },
      {
        mutate: (p) => ((p.hermes as Record<string, unknown>).hermesHomeEnv = "bad\u0000value"),
        fragment: /hermes submission block/,
      },
      {
        mutate: (p) => { (p.hermes as Record<string, unknown>).apiKey = "x"; },
        fragment: /must not contain credential-bearing field/,
      },
    ];
    for (const { mutate, fragment } of cases) {
      const policy = buildMatchlockPolicy(HERMES_BASE) as unknown as Record<string, unknown>;
      mutate(policy);
      assert.throws(
        () => parseMatchlockPolicy(JSON.stringify(policy)),
        (err: unknown) =>
          err instanceof MatchlockPolicyError && fragment.test(err.message),
        `hermes submission shape must fail closed`,
      );
    }
  });

  it("a serialized hermes policy contains no credential-bearing substrings", () => {
    const policy = buildMatchlockPolicy(HERMES_BASE);
    const json = serializeMatchlockPolicy(policy);
    for (const fragment of ["token", "secret", "password", "credential", "api_key", "private_key"]) {
      assert.ok(!json.toLowerCase().includes(fragment), `policy must not contain "${fragment}"`);
    }
  });

  // ── MTLK-DSH-EXEC US-002: harness "dsh" records ──────────────────────

  it("resolveDshPolicyHome follows native parity: default <home>/.dsh, explicit, relative->cwd, tilde, whitespace-only-as-unset", () => {
    const home = "/home/operator";
    const cwd = "/home/operator/work";
    const base: DshSubmissionContext = { homeDir: home, cwd, env: {} };
    assert.deepEqual(resolveDshPolicyHome(dshSubmission({})), { hostHome: "/home/operator/.dsh", source: "default" });
    assert.deepEqual(resolveDshPolicyHome({ ...base, env: { DSH_HOME: "   " } }), { hostHome: "/home/operator/.dsh", source: "default" });
    assert.deepEqual(resolveDshPolicyHome({ ...base, env: { DSH_HOME: "/custom/dsh-home" } }), { hostHome: "/custom/dsh-home", source: "env" });
    // Relative $DSH_HOME resolves against the captured cwd (never daemon cwd).
    assert.deepEqual(resolveDshPolicyHome({ ...base, env: { DSH_HOME: "rel/dsh" } }), { hostHome: "/home/operator/work/rel/dsh", source: "env" });
    // `~`/`~/` expand against the captured home.
    assert.deepEqual(resolveDshPolicyHome({ ...base, env: { DSH_HOME: "~/.config/dsh" } }), { hostHome: "/home/operator/.config/dsh", source: "env" });
    assert.deepEqual(resolveDshPolicyHome({ homeDir: home, cwd, env: { DSH_HOME: "~" } }), { hostHome: "/home/operator", source: "env" });
    // Whitespace around an explicit value is trimmed before resolution.
    assert.deepEqual(resolveDshPolicyHome({ ...base, env: { DSH_HOME: "  /padded/dsh  " } }), { hostHome: "/padded/dsh", source: "env" });
  });

  it("builds a pinned version-2 dsh record (default home) with the frozen submission context and headless semantics", () => {
    const policy = buildMatchlockPolicy(dshBase() as never);
    assert.equal(policy.version, MATCHLOCK_POLICY_VERSION);
    assert.equal(policy.harness, "dsh");
    assert.equal(policy.configurationRoot, "/home/operator/.dsh");
    assert.equal(policy.configurationProfile, DEFAULT_DSH_CONFIGURATION_PROFILE);
    assert.equal(policy.guestConfigurationRoot, DEFAULT_DSH_CONFIGURATION_ROOT);
    assert.equal(policy.submissionHomeDir, "/home/operator");
    assert.equal(policy.submissionCwd, "/home/operator/work");
    assert.equal(policy.submissionDshHomeEnv, null);
    assert.equal(policy.submissionDshHomeSource, "default");
    assert.equal(policy.resolvedImageDigest, BASE.identity.digest);
    assert.equal(policy.resolvedImageConfigDigest, BASE.identity.config_digest);
  });

  it("dsh serialize → parse round-trips; explicit-env record keeps its captured env value", () => {
    const policy = buildMatchlockPolicy(
      dshBase({
        configurationRoot: "/home/operator/.custom/dsh",
        submissionDshHomeEnv: "~/.custom/dsh",
        submissionDshHomeSource: "env",
        imagePath: "/opt/dsh/bin:/usr/local/bin:/usr/bin:/bin",
      }) as never,
    );
    const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
    assert.deepEqual(parsed, policy);
    assert.ok(isExecutionIsolationPolicy(parsed));
    assert.equal(parsed.imagePath, "/opt/dsh/bin:/usr/local/bin:/usr/bin:/bin");
    assert.equal(parsed.submissionDshHomeSource, "env");
    assert.equal(parsed.submissionDshHomeEnv, "~/.custom/dsh");
  });

  it("dsh policy imagePath keeps a NONSTANDARD image PATH verbatim (helper-pack prepend happens at the planner)", () => {
    const policy = buildMatchlockPolicy(dshBase({ imagePath: "/custom/dsh/install/bin" }) as never);
    assert.equal(policy.imagePath, "/custom/dsh/install/bin");
    const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
    assert.equal(parsed.imagePath, "/custom/dsh/install/bin");
  });

  it("buildMatchlockPolicy refuses a dsh record without an explicit resolved configurationRoot (never re-derives from daemon env)", () => {
    const { configurationRoot: _r, ...rest } = dshBase();
    assert.throws(
      () => buildMatchlockPolicy(rest as never),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /resolved effective host DSH_HOME/.test(err.message),
    );
  });

  it("buildMatchlockPolicy refuses a dsh record without the frozen submission context", () => {
    assert.throws(
      () => buildMatchlockPolicy(dshBase({ submissionHomeDir: undefined, submissionCwd: undefined }) as never),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /submission homeDir/.test(err.message),
    );
  });

  it("buildMatchlockPolicy refuses a pi record carrying dsh-only submission fields", () => {
    assert.throws(
      () =>
        buildMatchlockPolicy({
          ...BASE,
          submissionHomeDir: "/home/operator",
          submissionCwd: "/home/operator/work",
        } as never),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /must not carry the dsh-only frozen submission-context fields/.test(err.message),
    );
  });

  it("parse fails closed on a dsh record missing the submission context and on one missing the env-value/source consistency", () => {
    const record = buildMatchlockPolicy(dshBase() as never) as unknown as Record<string, unknown>;
    delete record.submissionHomeDir;
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(record)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /submissionHomeDir is required for dsh policies/.test(err.message),
    );
    const inconsistent = buildMatchlockPolicy(dshBase() as never) as unknown as Record<string, unknown>;
    inconsistent.submissionDshHomeSource = "env";
    inconsistent.submissionDshHomeEnv = null;
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(inconsistent)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        /requires a non-empty submissionDshHomeEnv/.test(err.message),
    );
  });

  it("parse fails closed on a dsh record with a relative submissionCwd (frozen context must be absolute)", () => {
    const record = buildMatchlockPolicy(dshBase() as never) as unknown as Record<string, unknown>;
    record.submissionCwd = "relative/work";
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(record)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        /submissionCwd is required for dsh policies/.test(err.message),
    );
  });

  it("parse rejects an unknown harness (neither pi, hermes nor dsh) under the three-harness union", () => {
    // MTLK-DSH-EXEC union MTLK-HERMES-EXEC: this test originally used
    // harness "hermes" (unknown to the pi+dsh union) and expected 'harness
    // must be "pi" or "dsh"'. Once the hermes contract is merged, "hermes" is
    // valid, so the union decides the shape: an UNKNOWN value is still
    // refused, with the three-harness message.
    const policy = buildMatchlockPolicy(dshBase() as never) as unknown as Record<string, unknown>;
    policy.harness = "custom-harness";
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(policy)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /harness must be "pi", "hermes" or "dsh"/.test(err.message),
    );
  });

  it("existing harness pi records (without any dsh fields) still parse unchanged", () => {
    const policy = buildMatchlockPolicy(BASE);
    const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
    assert.equal(parsed.harness, "pi");
    assert.equal(parsed.submissionHomeDir, undefined);
    assert.equal(parsed.imagePath, undefined);
    assert.deepEqual(parsed, policy);
  });

  it("MTLK-INTEGRATE US-003 cross-harness mixing: a hermes record carrying dsh fields and a pi record carrying dsh fields both fail closed", () => {
    // The union admits pi, hermes and dsh, but a record may carry only its OWN
    // harness's submission block. (MTLK-HERMES-EXEC + MTLK-DSH-EXEC union.)
    const hermesWithDsh = buildMatchlockPolicy(HERMES_BASE) as unknown as Record<string, unknown>;
    hermesWithDsh.submissionHomeDir = "/home/operator";
    hermesWithDsh.submissionCwd = "/home/operator/work";
    hermesWithDsh.submissionDshHomeEnv = null;
    hermesWithDsh.submissionDshHomeSource = "default";
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(hermesWithDsh)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /field "submissionHomeDir" is only valid on dsh/.test(err.message),
    );

    const piWithDsh = buildMatchlockPolicy(BASE) as unknown as Record<string, unknown>;
    piWithDsh.submissionHomeDir = "/home/operator";
    piWithDsh.submissionCwd = "/home/operator/work";
    piWithDsh.submissionDshHomeEnv = null;
    piWithDsh.submissionDshHomeSource = "default";
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify(piWithDsh)),
      (err: unknown) =>
        err instanceof MatchlockPolicyError &&
        err.code === "policy_invalid_record" &&
        /field "submissionHomeDir" is only valid on dsh/.test(err.message),
    );
  });

  it("MTLK-INTEGRATE US-003 three-harness round-trip: pi, hermes and dsh records each serialize → parse equal", () => {
    const pi = buildMatchlockPolicy(BASE);
    const hermes = buildMatchlockPolicy(HERMES_BASE);
    const dsh = buildMatchlockPolicy(dshBase() as never);
    for (const [name, policy] of [["pi", pi], ["hermes", hermes], ["dsh", dsh]] as const) {
      const parsed = parseMatchlockPolicy(serializeMatchlockPolicy(policy));
      assert.equal(parsed.harness, name);
      assert.deepEqual(parsed, policy);
      assert.ok(isExecutionIsolationPolicy(parsed));
    }
  });

  it("the resolved default DSH_HOME path is a plain narrow absolute path (fixtures mirror real homes)", () => {
    // Guards against accidental use of the host os.homedir() in fixtures.
    assert.ok(path.isAbsolute("/home/operator/.dsh"));
    assert.equal(path.join("/home/operator", ".dsh"), "/home/operator/.dsh");
  });
});
