/**
 * doctor-gate tests (G7 DOCTOR-GATE).
 *
 * US-001 covers the two foundations of the doctor launch gate in
 * `src/installer/matchlock/doctor-gate.ts`:
 *
 *  - `LAUNCH_GATE_STORE_CONTRACT`, the runtime store contract seed derived from
 *    the G1 store-control discovery;
 *  - `resolveEffectiveJournalMode`, the faithful host-side model of the stock
 *    Hermes `database.journal_mode` resolution (config spec section 2a).
 *
 * These tests import the COMPILED module from dist/ (repo convention for this
 * directory), so `npm run build` must run first. Every fixture profile comes
 * from `tamanduaShortTempDir` and is removed in the `after()` hook; the
 * operator home is never read, written or otherwise touched.
 *
 * US-002 adds the observation composition (`resolveLaunchGateObservations` and
 * `interactiveStoreMountPlan`): disposable profiles with synthetic 100-byte
 * SQLite headers are observed through the SAME profile resolver, mount plan,
 * store-set resolver, header reader and adapter the launch path uses.
 *
 * US-003 adds the check mapper (`runLaunchGateChecks`): the same fixture
 * profiles are evaluated through the launch path's own `evaluateGate`, and the
 * resulting verdict is rendered as launch-scoped doctor checks. The agreement
 * test runs both halves on one fixture and compares verdict and reason codes.
 *
 * The module reads config files and store header bytes only (`readFileSync`,
 * `observeStore`): no database driver, no clock, no randomness and no writes.
 * The one mount-plan parity test uses the interactive create-config builder to
 * prove the doctor plan is the launch plan; it follows the existing
 * mount-plan fixture pattern of a narrow disposable directory under the
 * operator home (the interactive identical-path mount refuses /tmp), removed
 * in `after()`. No operator profile is read and no temp profile lives there.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import {
  LAUNCH_GATE_REASON_MAX_LENGTH,
  LAUNCH_GATE_HOLDER_CHECK_NAME,
  LAUNCH_GATE_HOLDER_OBSERVATION_CHECK_NAME,
  LAUNCH_GATE_STORE_CONTRACT,
  LAUNCH_GATE_STORE_ENTRIES,
  LAUNCH_GATE_STORE_SET_CHECK_NAME,
  LAUNCH_GATE_SUMMARY_CHECK_NAME,
  HOLDER_PROBE_SCOPE,
  interactiveStoreMountPlan,
  listOpenFileHolders,
  resolveEffectiveJournalMode,
  resolveLaunchGateObservations,
  runLaunchGateChecks,
  sanitizeHolderDescription,
} from "../../../dist/installer/matchlock/doctor-gate.js";
import { evaluateGate } from "../../../dist/installer/matchlock/launch-gate.js";
import { buildInteractiveSessionCreateConfig } from "../../../dist/installer/matchlock/mount-plan.js";
import { observeStore } from "../../../dist/installer/matchlock/store-header.js";
import type { ExecutionIsolation } from "../../../dist/installer/matchlock/policy.js";
import { MATCHLOCK_NETWORK_POLICY_VERSION } from "../../../dist/installer/matchlock/policy.js";

/** Every disposable path created by this file; removed in `after()`. */
const createdDirs: string[] = [];

after(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Create a disposable directory under the short literal `/tmp` base. */
function freshDir(prefix: string): string {
  const dir = tamanduaShortTempDir(prefix);
  createdDirs.push(dir);
  return dir;
}

/** Create a disposable profile home; `configYaml` null means no config file. */
function freshProfile(configYaml?: string | null): string {
  const dir = freshDir("g7-dg-profile-");
  if (configYaml !== null && configYaml !== undefined) {
    fs.writeFileSync(path.join(dir, "config.yaml"), configYaml, "utf8");
  }
  return dir;
}

/** Create a disposable managed-scope directory with an optional config.yaml. */
function freshManaged(configYaml?: string | null): string {
  const dir = freshDir("g7-dg-managed-");
  if (configYaml !== null && configYaml !== undefined) {
    fs.writeFileSync(path.join(dir, "config.yaml"), configYaml, "utf8");
  }
  return dir;
}

/** A config.yaml whose `database.journal_mode` leaf is exactly `value`. */
function configWithMode(value: string): string {
  return `database:\n  journal_mode: ${value}\n`;
}

/**
 * Deterministic observation options: no managed layer and an empty
 * environment, so nothing about the host (including `/etc/hermes` or the
 * ambient environment) can influence the result.
 */
const NO_MANAGED_LAYER = { managedDir: null, env: {} } as const;

// ---------------------------------------------------------------------------
// LAUNCH_GATE_STORE_CONTRACT
// ---------------------------------------------------------------------------

describe("LAUNCH_GATE_STORE_CONTRACT", () => {
  it("classifies state.db as required and the feature stores as optional-present", () => {
    const byPath = new Map(
      LAUNCH_GATE_STORE_CONTRACT.entries.map((entry) => [entry.relativePath, entry]),
    );

    assert.equal(LAUNCH_GATE_STORE_CONTRACT.complete, true);

    for (const relativePath of [
      "state.db",
      "verification_evidence.db",
      "kanban.db",
      "projects.db",
    ]) {
      const entry = byPath.get(relativePath);
      assert.ok(entry, `expected a contract entry for ${relativePath}`);
      assert.equal(typeof entry.trigger, "string");
      assert.ok((entry.trigger ?? "").length > 0, "each entry carries a trigger");
    }

    assert.equal(byPath.get("state.db")?.classification, "required");
    assert.equal(
      byPath.get("verification_evidence.db")?.classification,
      "optional-present",
    );
    assert.equal(byPath.get("kanban.db")?.classification, "optional-present");
    assert.equal(byPath.get("projects.db")?.classification, "optional-present");

    // Only state.db is required: a required optional store would manufacture
    // permanent refusals.
    assert.equal(
      LAUNCH_GATE_STORE_CONTRACT.entries.filter(
        (entry) => entry.classification === "required",
      ).length,
      1,
    );
    assert.equal(LAUNCH_GATE_STORE_CONTRACT.entries.length, 4);
  });

  it("exports the entries as a stable view of the contract", () => {
    assert.deepEqual(LAUNCH_GATE_STORE_ENTRIES, LAUNCH_GATE_STORE_CONTRACT.entries);
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveJournalMode
// ---------------------------------------------------------------------------

describe("resolveEffectiveJournalMode", () => {
  it("honours an explicit user delete", () => {
    const profile = freshProfile(configWithMode("delete"));

    const observed = resolveEffectiveJournalMode(profile, NO_MANAGED_LAYER);

    assert.equal(observed.journalMode, "delete");
    assert.equal(observed.observed, true);
  });

  it("recognises delete after trim and case folding, like the writer", () => {
    const profile = freshProfile(
      `database:\n  journal_mode: "  DELETE  "\n`,
    );

    const observed = resolveEffectiveJournalMode(profile, NO_MANAGED_LAYER);

    assert.equal(observed.journalMode, "delete");
    assert.equal(observed.observed, true);
  });

  it("resolves wal when the database section is absent", () => {
    const profile = freshProfile(`terminal:\n  backend: local\n`);

    const observed = resolveEffectiveJournalMode(profile, NO_MANAGED_LAYER);

    assert.equal(observed.journalMode, "wal");
    assert.equal(observed.observed, true);
  });

  it("resolves wal when config.yaml is absent entirely", () => {
    const profile = freshProfile(null);

    const observed = resolveEffectiveJournalMode(profile, NO_MANAGED_LAYER);

    assert.equal(observed.journalMode, "wal");
    assert.equal(observed.observed, true);
  });

  it("resolves wal fail-safe for an unrecognised value", () => {
    const profile = freshProfile(configWithMode("truncate"));

    const observed = resolveEffectiveJournalMode(profile, NO_MANAGED_LAYER);

    assert.equal(observed.journalMode, "wal");
    assert.equal(observed.observed, true);
  });

  it("resolves wal fail-safe for a non-string value", () => {
    const profile = freshProfile(`database:\n  journal_mode: 2\n`);
    const nested = freshProfile(
      `database:\n  journal_mode:\n    nested: true\n`,
    );

    assert.equal(
      resolveEffectiveJournalMode(profile, NO_MANAGED_LAYER).journalMode,
      "wal",
    );
    assert.equal(
      resolveEffectiveJournalMode(nested, NO_MANAGED_LAYER).journalMode,
      "wal",
    );
  });

  it("never consults HERMES_JOURNAL_MODE", () => {
    // The writer ignores this variable; honouring it would admit a store the
    // writer treats as WAL. Set it in BOTH the ambient environment and the
    // injected env to prove neither path reads it.
    const profile = freshProfile(configWithMode("wal"));
    const previous = process.env.HERMES_JOURNAL_MODE;
    process.env.HERMES_JOURNAL_MODE = "delete";
    try {
      assert.equal(
        resolveEffectiveJournalMode(profile).journalMode,
        "wal",
        "ambient HERMES_JOURNAL_MODE must not override the user config",
      );
      assert.equal(
        resolveEffectiveJournalMode(profile, {
          managedDir: null,
          env: { HERMES_JOURNAL_MODE: "delete" },
        }).journalMode,
        "wal",
        "injected HERMES_JOURNAL_MODE must not override the user config",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.HERMES_JOURNAL_MODE;
      } else {
        process.env.HERMES_JOURNAL_MODE = previous;
      }
    }
  });

  it("lets a managed-scope delete override a user wal", () => {
    const profile = freshProfile(configWithMode("wal"));
    const managed = freshManaged(configWithMode("delete"));

    const observed = resolveEffectiveJournalMode(profile, {
      managedDir: managed,
      env: {},
    });

    assert.equal(observed.journalMode, "delete");
    assert.equal(observed.observed, true);
  });

  it("lets a managed-scope wal override a user delete", () => {
    const profile = freshProfile(configWithMode("delete"));
    const managed = freshManaged(configWithMode("wal"));

    const observed = resolveEffectiveJournalMode(profile, {
      managedDir: managed,
      env: {},
    });

    assert.equal(observed.journalMode, "wal");
    assert.equal(observed.observed, true);
  });

  it("keeps the user value when the managed layer has no journal_mode leaf", () => {
    const profile = freshProfile(configWithMode("delete"));
    const managed = freshManaged(`terminal:\n  backend: local\n`);

    const observed = resolveEffectiveJournalMode(profile, {
      managedDir: managed,
      env: {},
    });

    assert.equal(observed.journalMode, "delete");
  });

  it("resolves the managed scope from HERMES_MANAGED_DIR when it is a directory", () => {
    const profile = freshProfile(configWithMode("wal"));
    const managed = freshManaged(configWithMode("delete"));

    const observed = resolveEffectiveJournalMode(profile, {
      env: { HERMES_MANAGED_DIR: managed },
    });

    assert.equal(observed.journalMode, "delete");
    assert.match(observed.source, /HERMES_MANAGED_DIR/);
  });

  it("ignores HERMES_MANAGED_DIR when it does not name an existing directory", () => {
    // Only meaningful when the default /etc/hermes layer is absent on this
    // host; otherwise that default layer legitimately applies instead.
    if (fs.existsSync("/etc/hermes")) return;
    const profile = freshProfile(configWithMode("delete"));

    const observed = resolveEffectiveJournalMode(profile, {
      env: { HERMES_MANAGED_DIR: path.join(freshDir("g7-dg-missing-"), "nope") },
    });

    assert.equal(observed.journalMode, "delete");
    assert.match(observed.source, /managed scope: none/);
  });

  it("reports unreadable (never wal) for a non-mapping document", () => {
    const profile = freshProfile(`- one\n- two\n`);

    const observed = resolveEffectiveJournalMode(profile, NO_MANAGED_LAYER);

    assert.equal(observed.journalMode, "unreadable");
    assert.equal(observed.observed, false);
    assert.match(observed.source, /host-observed/);
  });

  it("reports unreadable (never wal) for malformed YAML", () => {
    const profile = freshProfile(`database: [unclosed\n`);

    const observed = resolveEffectiveJournalMode(profile, NO_MANAGED_LAYER);

    assert.equal(observed.journalMode, "unreadable");
    assert.equal(observed.observed, false);
  });

  it("reports unreadable for an unreadable config path", () => {
    // A directory at config.yaml's path is unreadable regardless of uid.
    const profile = freshProfile(null);
    fs.mkdirSync(path.join(profile, "config.yaml"));

    const observed = resolveEffectiveJournalMode(profile, NO_MANAGED_LAYER);

    assert.equal(observed.journalMode, "unreadable");
    assert.equal(observed.observed, false);
    assert.match(observed.source, /could not be read/);
  });

  it("reports unreadable when only the managed config is malformed", () => {
    const profile = freshProfile(configWithMode("delete"));
    const managed = freshManaged(`database: [unclosed\n`);

    const observed = resolveEffectiveJournalMode(profile, {
      managedDir: managed,
      env: {},
    });

    assert.equal(observed.journalMode, "unreadable");
    assert.equal(observed.observed, false);
    assert.match(observed.source, /managed scope/);
  });

  it("names the host perspective and the managed scope (or none) in source", () => {
    const profile = freshProfile(configWithMode("delete"));
    const managed = freshManaged(configWithMode("delete"));

    const withoutManaged = resolveEffectiveJournalMode(
      profile,
      NO_MANAGED_LAYER,
    );
    assert.match(withoutManaged.source, /host-observed/);
    assert.match(withoutManaged.source, /managed scope: none/);
    assert.match(withoutManaged.source, /HERMES_JOURNAL_MODE is not consulted/);
    assert.ok(
      withoutManaged.source.includes(path.join(profile, "config.yaml")),
      "source names the user config it observed",
    );

    const withManaged = resolveEffectiveJournalMode(profile, {
      managedDir: managed,
      env: {},
    });
    assert.match(withManaged.source, /host-observed/);
    assert.ok(
      withManaged.source.includes(path.join(managed, "config.yaml")),
      "source names the managed config it observed",
    );
    assert.match(withManaged.source, /managed layer wins/);
  });

  it("does not mutate the config bytes it observes", () => {
    const profile = freshProfile(configWithMode("delete"));
    const configPath = path.join(profile, "config.yaml");
    const before = fs.readFileSync(configPath);

    resolveEffectiveJournalMode(profile, NO_MANAGED_LAYER);

    assert.deepEqual(fs.readFileSync(configPath), before);
  });
});

// ---------------------------------------------------------------------------
// US-002: profile + interactive mount plan + store set + byte observations
// ---------------------------------------------------------------------------

/** The 16-byte database file signature. */
const SQLITE_MAGIC = "SQLite format 3\u0000";

/**
 * A synthetic, COMPLETE 100-byte SQLite header: the signature at offset 0 and
 * the (write, read) version pair at offsets 18/19. A truncated header is a
 * separate case and never passes as a format observation.
 */
function sqliteHeader(write: number, read: number): Buffer {
  const header = Buffer.alloc(100);
  header.write(SQLITE_MAGIC, 0, "latin1");
  header[18] = write;
  header[19] = read;
  return header;
}

/** Create a disposable profile home under a disposable temp HOME. */
function freshHome(): string {
  return freshDir("g7-dg-home-");
}

/** Create a disposable profile with a config and optional synthetic stores. */
function freshCandidateProfile(options: {
  journalMode?: string;
  configYaml?: string | null;
  stores?: Record<string, [number, number]>;
} = {}): string {
  const profile = freshDir("g7-dg-candidate-");
  const configYaml =
    options.configYaml === undefined
      ? configWithMode(options.journalMode ?? "delete")
      : options.configYaml;
  if (configYaml !== null) {
    fs.writeFileSync(path.join(profile, "config.yaml"), configYaml, "utf8");
  }
  for (const [name, pair] of Object.entries(options.stores ?? { "state.db": [1, 1] })) {
    fs.writeFileSync(path.join(profile, name), sqliteHeader(pair[0], pair[1]));
  }
  return profile;
}

/**
 * Deterministic observation options for one fixture profile: no managed config
 * layer, an empty environment, and the frozen submission triple pointed at the
 * profile.
 */
function observationOptions(
  profile: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    homeDir: freshHome(),
    cwd: profile,
    hermesHomeEnv: profile,
    env: {},
    managedDir: null,
    ...extra,
  };
}

describe("interactiveStoreMountPlan", () => {
  it("mounts the profile home at its identical absolute host path", () => {
    const profile = freshCandidateProfile();

    const plan = interactiveStoreMountPlan(profile);

    assert.deepEqual(Object.keys(plan.mounts ?? {}), [profile]);
    assert.equal(plan.mounts?.[profile]?.host_path, profile);
  });

  it("matches the configuration mount produced by buildInteractiveSessionCreateConfig", () => {
    // The interactive builder mounts the configuration at its IDENTICAL host
    // path, so it refuses the protected guest roots (/tmp, /etc, ...). Like the
    // existing mount-plan fixture, use a narrow disposable directory under the
    // operator's home and remove it afterwards. No operator profile is read.
    const configDir = fs.mkdtempSync(path.join(os.homedir(), ".g7-dg-config-"));
    createdDirs.push(configDir);
    const IDENTITY = { digest: "sha256:aaaa", config_digest: "sha256:bbbb", tag: "img:1" };
    const policy: ExecutionIsolation = {
      version: 1,
      backend: "matchlock",
      requestedImage: "img:1",
      harness: "hermes",
      configurationRoot: configDir,
      configurationProfile: "default",
      guestConfigurationRoot: "/workspace/config/hermes",
      workPathMode: "host-absolute",
      workingDirectory: "/srv/interactive-work",
      workMounts: [
        {
          hostPath: "/srv/interactive-work",
          hostRealPath: "/srv/interactive-work",
          guestPath: "/srv/interactive-work",
        },
      ],
      originalRepositoryRoot: "/srv/interactive-origin",
      gitMetadataRoots: ["/srv/interactive-origin/.git"],
      mountPolicyVersion: 1,
      networkPolicyVersion: MATCHLOCK_NETWORK_POLICY_VERSION,
      resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480, swapMB: 0 },
    };

    const createConfig = buildInteractiveSessionCreateConfig(policy, IDENTITY, {
      ownerUid: 4242,
      ownerGid: 4343,
      admission: { home: os.homedir(), liveStateRoot: freshDir("g7-dg-state-") },
    });
    const builderMount = createConfig.vfs?.mounts?.[configDir];
    const plan = interactiveStoreMountPlan(configDir);

    assert.ok(builderMount, "the interactive builder mounts the configuration root itself");
    assert.equal(builderMount.host_path, configDir);
    assert.equal(plan.mounts?.[configDir]?.host_path, builderMount.host_path);
    // The identical destination key, never the workflow relocation.
    assert.equal(plan.mounts?.[configDir] === undefined, false);
    assert.equal(plan.mounts?.["/workspace/config/hermes"], undefined);
  });
});

describe("resolveLaunchGateObservations", () => {
  it("resolves a converted disposable profile as a complete, candidate inventory", () => {
    const profile = freshCandidateProfile({ journalMode: "delete", stores: { "state.db": [1, 1] } });

    const observed = resolveLaunchGateObservations(observationOptions(profile));

    assert.equal(observed.candidate, true);
    assert.equal(observed.reason, null);
    assert.equal(observed.failureStage, null);
    assert.ok(observed.selection);
    assert.equal(observed.selection.hostEffectiveDir, profile);
    assert.ok(observed.storeSet);
    assert.equal(observed.storeSet.inventoryComplete, true);
    assert.ok(observed.gateInput);
    assert.equal(observed.gateInput.inventoryComplete, true);
    assert.deepEqual(observed.gateInput.incompleteReasons, []);

    const state = observed.gateInput.stores.find((store) =>
      store.requestedPath.endsWith("state.db"),
    );
    assert.ok(state, "state.db is part of the inventory");
    assert.equal(state.presence, "present");
    assert.equal(state.required, true);
    assert.equal(state.header?.headerFormat, "rollback");
    assert.deepEqual(state.header?.rawBytes1819, [1, 1]);
    assert.equal(state.config?.journalMode, "delete");

    // The default mount plan covers the profile home, so the inventory is not
    // incomplete for a plan reason.
    assert.equal(
      observed.gateInput.incompleteReasons.some((reason) =>
        reason.startsWith("mount-plan-does-not-cover-profile-home"),
      ),
      false,
    );
    assert.deepEqual(observed.mountPlan, interactiveStoreMountPlan(profile));
  });

  it("carries the single config observation and the observed header on every store", () => {
    const profile = freshCandidateProfile({
      journalMode: "delete",
      stores: { "state.db": [1, 1], "kanban.db": [2, 2] },
    });

    const observed = resolveLaunchGateObservations(observationOptions(profile));
    assert.ok(observed.gateInput);
    assert.ok(observed.config);

    // Absent optional contract stores are in the inventory too (as knowledge,
    // not ignorance); the present subset is what carries bytes.
    const byPath = new Map(
      observed.gateInput.stores
        .filter((store) => store.presence === "present")
        .map((store) => [path.basename(store.requestedPath), store]),
    );
    assert.deepEqual([...byPath.keys()].sort(), ["kanban.db", "state.db"]);

    for (const [name, store] of byPath) {
      const readerObservation = observeStore(path.join(profile, name));
      assert.deepEqual(store.config, observed.config, `${name} carries the profile config`);
      assert.equal(store.presence, "present");
      assert.equal(store.header?.headerFormat, readerObservation.headerFormat);
      assert.deepEqual(store.header?.rawBytes1819, readerObservation.rawBytes1819);
      assert.equal(store.header?.fileSize, readerObservation.fileSize);
      assert.equal(store.header?.magicOk, readerObservation.magicOk);
      assert.equal(store.header?.readable, readerObservation.readable);
    }

    assert.equal(byPath.get("state.db")?.header?.headerFormat, "rollback");
    assert.equal(byPath.get("kanban.db")?.header?.headerFormat, "wal");
    assert.deepEqual(byPath.get("kanban.db")?.header?.rawBytes1819, [2, 2]);
  });

  it("honours an explicit mount plan and records its coverage doubt", () => {
    const profile = freshCandidateProfile();
    const unrelatedPlan = interactiveStoreMountPlan(freshDir("g7-dg-unrelated-"));

    const observed = resolveLaunchGateObservations(
      observationOptions(profile, { mountPlan: unrelatedPlan }),
    );

    assert.equal(observed.candidate, true);
    assert.deepEqual(observed.mountPlan, unrelatedPlan);
    assert.ok(observed.gateInput);
    assert.equal(observed.gateInput.inventoryComplete, false);
    assert.ok(
      observed.gateInput.incompleteReasons.some((reason) =>
        reason.startsWith("mount-plan-does-not-cover-profile-home"),
      ),
      `expected a mount coverage reason, got ${JSON.stringify(observed.gateInput.incompleteReasons)}`,
    );
    // The store is still observed: a coverage doubt narrows evidence, it does
    // not abort the sweep. (Absent optional contract stores remain in the
    // inventory as knowledge.)
    const state = observed.gateInput.stores.find((store) =>
      store.requestedPath.endsWith("state.db"),
    );
    assert.equal(state?.presence, "present");
    assert.equal(state?.header?.headerFormat, "rollback");
  });

  it("resolves candidate:false with a bounded reason and observes no store", () => {
    const home = freshHome();
    const missingProfile = path.join(home, ".hermes");
    const usableLookingStore = path.join(home, "state.db");
    // A store exists next to the fixture home, but a non-candidate resolution
    // must never observe anything at all.
    fs.writeFileSync(usableLookingStore, sqliteHeader(1, 1));

    const observed = resolveLaunchGateObservations({
      homeDir: home,
      cwd: home,
      hermesHomeEnv: null,
      env: {},
      managedDir: null,
    });

    assert.equal(observed.candidate, false);
    assert.equal(observed.failureStage, "selection");
    assert.equal(typeof observed.reason, "string");
    assert.ok((observed.reason ?? "").length > 0);
    assert.ok(
      (observed.reason ?? "").length <= LAUNCH_GATE_REASON_MAX_LENGTH,
      "reason is bounded",
    );
    assert.match(observed.reason ?? "", /selection: interactive_hermes_config_unavailable/);
    assert.equal(observed.selection, null);
    assert.equal(observed.mountPlan, null);
    assert.equal(observed.storeSet, null);
    assert.equal(observed.gateInput, null);
    assert.equal(observed.config, null);
  });

  it("resolves candidate:false when the profile path is not a directory", () => {
    const home = freshHome();
    const filePath = path.join(home, "not-a-profile");
    fs.writeFileSync(filePath, "not a directory\n");

    const observed = resolveLaunchGateObservations({
      homeDir: home,
      cwd: home,
      hermesHomeEnv: filePath,
      env: {},
      managedDir: null,
    });

    assert.equal(observed.candidate, false);
    assert.equal(observed.failureStage, "selection");
    assert.equal(observed.storeSet, null);
    assert.equal(observed.gateInput, null);
  });

  it("reports an incomplete contract while still observing every store", () => {
    const profile = freshCandidateProfile({
      journalMode: "delete",
      stores: { "state.db": [1, 1] },
    });

    const observed = resolveLaunchGateObservations(
      observationOptions(profile, {
        storeContract: {
          complete: false,
          entries: LAUNCH_GATE_STORE_CONTRACT.entries,
        },
      }),
    );

    assert.equal(observed.candidate, true);
    assert.ok(observed.gateInput);
    assert.equal(observed.gateInput.inventoryComplete, false);
    assert.ok(
      observed.gateInput.incompleteReasons.includes("contract-incomplete"),
      `expected contract-incomplete, got ${JSON.stringify(observed.gateInput.incompleteReasons)}`,
    );
    // Observations still exist for the stores the contract names.
    assert.ok(observed.gateInput.stores.length > 0);
    const state = observed.gateInput.stores.find((store) =>
      store.requestedPath.endsWith("state.db"),
    );
    assert.equal(state?.presence, "present");
    assert.equal(state?.header?.headerFormat, "rollback");
  });
});

// ---------------------------------------------------------------------------
// US-003: gate verdict -> launch-scoped doctor checks
// ---------------------------------------------------------------------------

/** Forbidden vocabulary: the gate is launch-scoped, never an integrity check. */
const FORBIDDEN_WORDING = /unsafe|broken|corrupt/i;

/**
 * A COMPLETE probe that observed no holders. Injecting it keeps tests that
 * assert exact check counts independent of the (unavailable) default probe.
 */
const NO_HOLDERS_PROBE = (): {
  observationComplete: boolean;
  candidates: never[];
  failures: never[];
} => ({ observationComplete: true, candidates: [], failures: [] });

/** Extract every `code: <reason-code>` the check messages carry. */
function extractedCodes(
  checks: readonly { message: string }[],
): string[] {
  const codes: string[] = [];
  for (const check of checks) {
    for (const match of check.message.matchAll(/\(code: ([a-z-]+)\)/g)) {
      codes.push(match[1]);
    }
  }
  return codes.sort();
}

/** Every option set the agreement/wording sweep runs. */
function agreementFixtures(profile: string): Array<{ label: string; opts: Record<string, unknown> }> {
  return [
    { label: "converted", opts: observationOptions(profile) },
    {
      label: "unconverted",
      opts: observationOptions(
        freshCandidateProfile({ journalMode: "wal", stores: { "state.db": [2, 2] } }),
      ),
    },
    {
      label: "incomplete inventory",
      opts: observationOptions(
        freshCandidateProfile({
          journalMode: "wal",
          stores: { "state.db": [1, 1] },
        }),
        {
          storeContract: {
            complete: false,
            entries: LAUNCH_GATE_STORE_CONTRACT.entries,
          },
        },
      ),
    },
  ];
}

describe("runLaunchGateChecks", () => {
  it("passes the summary check with would-allow wording for a converted profile", () => {
    const profile = freshCandidateProfile({
      journalMode: "delete",
      stores: { "state.db": [1, 1] },
    });

    const checks = runLaunchGateChecks(
      observationOptions(profile, { holderProbe: NO_HOLDERS_PROBE }),
    );

    assert.equal(checks.length, 1, "a converted profile needs only the summary");
    const [summary] = checks;
    assert.equal(summary.name, LAUNCH_GATE_SUMMARY_CHECK_NAME);
    assert.equal(summary.status, "pass");
    assert.match(summary.message, /would allow a Matchlock hermes launch/);
    assert.doesNotMatch(summary.message, /would refuse/);
  });

  it("fails the summary and names each store with its reason codes for an unconverted profile", () => {
    const profile = freshCandidateProfile({
      journalMode: "wal",
      stores: { "state.db": [2, 2] },
    });

    const checks = runLaunchGateChecks(observationOptions(profile));

    const summary = checks[0];
    assert.equal(summary.name, LAUNCH_GATE_SUMMARY_CHECK_NAME);
    assert.equal(summary.status, "fail");
    assert.match(summary.message, /would refuse a Matchlock hermes launch/);

    const statePath = path.join(profile, "state.db");
    const storeChecks = checks.slice(1).filter((check) => check.name === statePath);
    assert.ok(storeChecks.length >= 2, "the store produces both refusal findings");
    for (const check of storeChecks) {
      assert.equal(check.status, "fail");
      assert.ok(
        check.message.startsWith(
          "would refuse a Matchlock hermes launch (code: ",
        ),
        `unexpected message shape: ${check.message}`,
      );
    }

    const codes = extractedCodes(storeChecks);
    assert.ok(codes.includes("wal-header"), `codes were ${codes.join(",")}`);
    assert.ok(
      codes.includes("not-delete-config"),
      `codes were ${codes.join(",")}`,
    );
  });

  it("reports an incomplete inventory as a set-scoped check while stores are still reported", () => {
    const profile = freshCandidateProfile({
      journalMode: "wal",
      stores: { "state.db": [2, 2] },
    });

    const checks = runLaunchGateChecks(
      observationOptions(profile, {
        storeContract: {
          complete: false,
          entries: LAUNCH_GATE_STORE_CONTRACT.entries,
        },
      }),
    );

    assert.equal(checks[0].status, "fail");

    const setCheck = checks.find(
      (check) => check.name === LAUNCH_GATE_STORE_SET_CHECK_NAME,
    );
    assert.ok(setCheck, "an incomplete inventory gets its own set-scoped check");
    assert.equal(setCheck.status, "fail");
    assert.match(setCheck.message, /\(code: inventory-incomplete\)/);

    // The sweep is not aborted: the store findings are still present.
    const statePath = path.join(profile, "state.db");
    const storeChecks = checks.filter((check) => check.name === statePath);
    assert.ok(storeChecks.length > 0, "store findings survive an inventory doubt");
    assert.ok(extractedCodes(storeChecks).includes("wal-header"));
  });

  it("agrees with evaluateGate on the reason-code set and the verdict for the same fixture", () => {
    const profile = freshCandidateProfile();
    for (const fixture of agreementFixtures(profile)) {
      const observations = resolveLaunchGateObservations(fixture.opts);
      assert.ok(observations.gateInput, `${fixture.label}: expected a gate input`);

      const verdict = evaluateGate(observations.gateInput);
      const checks = runLaunchGateChecks(fixture.opts);

      assert.deepEqual(
        extractedCodes(checks),
        verdict.findings.map((finding) => finding.code).sort(),
        `${fixture.label}: doctor codes must equal the gate's findings`,
      );

      const summary = checks[0];
      if (verdict.action === "allow") {
        assert.equal(summary.status, "pass", fixture.label);
        assert.match(summary.message, /would allow a Matchlock hermes launch/);
      } else {
        assert.equal(summary.status, "fail", fixture.label);
        assert.match(summary.message, /would refuse a Matchlock hermes launch/);
      }
    }
  });

  it("never uses integrity-checker vocabulary in names, messages or remedies", () => {
    const profile = freshCandidateProfile();
    const optionSets: Array<Record<string, unknown>> = [
      ...agreementFixtures(profile).map((fixture) => fixture.opts),
      // A non-candidate fixture is worded by this module too.
      {
        homeDir: freshHome(),
        cwd: profile,
        hermesHomeEnv: null,
        env: {},
        managedDir: null,
      },
    ];

    for (const opts of optionSets) {
      for (const check of runLaunchGateChecks(opts)) {
        assert.doesNotMatch(check.name, FORBIDDEN_WORDING);
        assert.doesNotMatch(check.message, FORBIDDEN_WORDING);
        if (check.remedy !== undefined) {
          assert.doesNotMatch(check.remedy, FORBIDDEN_WORDING);
        }
      }
    }
  });

  it("renders the evaluator's remedy commands verbatim", () => {
    const profile = freshCandidateProfile({
      journalMode: "wal",
      stores: { "state.db": [2, 2] },
    });

    const observations = resolveLaunchGateObservations(observationOptions(profile));
    assert.ok(observations.gateInput);
    const state = observations.gateInput.stores.find((store) =>
      store.requestedPath.endsWith("state.db"),
    );
    const canonical = state?.identity?.canonicalPath ?? path.join(profile, "state.db");

    const checks = runLaunchGateChecks(observationOptions(profile));
    const stateChecks = checks.filter((check) => check.name === path.join(profile, "state.db"));
    const deleteConfig = stateChecks.find((check) =>
      check.message.includes("(code: not-delete-config)"),
    );
    assert.ok(deleteConfig, "the not-delete-config finding is rendered");
    assert.ok(deleteConfig.remedy, "a finding with commands carries a remedy");
    assert.ok(
      deleteConfig.remedy.includes(
        `Run: hermes sessions set-journal-mode delete --db ${canonical}`,
      ),
      `expected the convert command in ${deleteConfig.remedy}`,
    );
    assert.match(deleteConfig.remedy, /Set `database\.journal_mode: delete`/);
  });

  it("reports exactly one info check when the profile is not a launch candidate", () => {
    const home = freshHome();

    const checks = runLaunchGateChecks({
      homeDir: home,
      cwd: home,
      hermesHomeEnv: null,
      env: {},
      managedDir: null,
    });

    assert.equal(checks.length, 1);
    assert.equal(checks[0].name, LAUNCH_GATE_SUMMARY_CHECK_NAME);
    assert.equal(checks[0].status, "info");
    assert.match(checks[0].message, /not a hermes-under-Matchlock launch candidate/);
    assert.match(checks[0].message, /was not evaluated/);
    assert.match(checks[0].message, /selection: interactive_hermes_config_unavailable/);
    assert.equal(checks[0].remedy, undefined);
  });

  it("produces valid DoctorCheckResult shapes", () => {
    const profile = freshCandidateProfile({
      journalMode: "wal",
      stores: { "state.db": [2, 2] },
    });

    for (const check of runLaunchGateChecks(observationOptions(profile))) {
      assert.equal(typeof check.name, "string");
      assert.ok(check.name.length > 0);
      assert.ok(["pass", "fail", "warn", "info"].includes(check.status));
      assert.equal(typeof check.message, "string");
      assert.ok(check.message.length > 0);
      assert.ok(check.remedy === undefined || typeof check.remedy === "string");
    }
  });
});

// ---------------------------------------------------------------------------
// Informational holder listing (US-005, spec sections 5 and 8)
// ---------------------------------------------------------------------------

describe("runLaunchGateChecks holder listing", () => {
  it("lists an injected holder for state.db as info and keeps the summary pass", () => {
    const profile = freshCandidateProfile({
      journalMode: "delete",
      stores: { "state.db": [1, 1] },
    });
    const stateDb = path.join(profile, "state.db");

    const checks = runLaunchGateChecks(
      observationOptions(profile, {
        holderProbe: (paths: readonly string[]) => {
          assert.ok(paths.includes(stateDb), "the probe sees the evaluated store path");
          return {
            observationComplete: true,
            candidates: [
              {
                pid: 4242,
                startIdentity: "v2:4242:1690000000000",
                description: "hermes serve --profile fixture",
                heldPaths: [stateDb],
              },
            ],
            failures: [],
          };
        },
      }),
    );

    const summary = checks[0];
    assert.equal(summary.name, LAUNCH_GATE_SUMMARY_CHECK_NAME);
    assert.equal(summary.status, "pass");
    assert.match(summary.message, /would allow a Matchlock hermes launch/);

    const holderChecks = checks.filter((check) =>
      check.name.startsWith(LAUNCH_GATE_HOLDER_CHECK_NAME),
    );
    assert.equal(holderChecks.length, 1);
    const [holder] = holderChecks;
    assert.equal(holder.status, "info");
    assert.match(holder.name, /pid 4242/);
    assert.match(holder.message, /holder pid 4242/);
    assert.match(holder.message, /start identity v2:4242:1690000000000/);
    assert.match(holder.message, /command: hermes serve --profile fixture/);
    assert.ok(holder.message.includes(stateDb), "the held store path is named");
    assert.equal(holder.remedy, undefined);

    // Holder checks come AFTER the summary and store checks.
    assert.equal(checks.indexOf(holder), checks.length - 1);
    assert.ok(!checks.some((check) => check.status === "fail"));
  });

  it("records a throwing probe as ONE info check without adding a fail", () => {
    const profile = freshCandidateProfile({
      journalMode: "delete",
      stores: { "state.db": [1, 1] },
    });

    const checks = runLaunchGateChecks(
      observationOptions(profile, {
        holderProbe: () => {
          throw new Error("lsof failed: EACCES for pid 99 token=abc123");
        },
      }),
    );

    assert.equal(checks[0].status, "pass", "the summary is unaffected");
    assert.ok(!checks.some((check) => check.status === "fail"));

    const infoChecks = checks.filter((check) => check.status === "info");
    assert.equal(infoChecks.length, 1);
    const [incomplete] = infoChecks;
    assert.equal(incomplete.name, LAUNCH_GATE_HOLDER_OBSERVATION_CHECK_NAME);
    assert.match(incomplete.message, /holder observation was incomplete/);
    assert.ok(incomplete.message.includes(HOLDER_PROBE_SCOPE), "the scope is named");
    assert.match(incomplete.message, /lsof failed: EACCES for pid 99/);
    // Credential-shaped probe text is redacted, never echoed.
    assert.doesNotMatch(incomplete.message, /abc123/);
    assert.match(incomplete.message, /<redacted>/);
  });

  it("reports the unavailable default probe informationally and keeps the summary pass", () => {
    const profile = freshCandidateProfile({
      journalMode: "delete",
      stores: { "state.db": [1, 1] },
    });

    // No holderProbe injected: the documented default must FAIL CLOSED rather
    // than present an empty list as a complete observation.
    const checks = runLaunchGateChecks(observationOptions(profile));

    assert.equal(checks[0].status, "pass");
    assert.ok(!checks.some((check) => check.status === "fail"));
    const infoChecks = checks.filter((check) => check.status === "info");
    assert.equal(infoChecks.length, 1);
    assert.equal(infoChecks[0].name, LAUNCH_GATE_HOLDER_OBSERVATION_CHECK_NAME);
    assert.match(infoChecks[0].message, /holder detection is unavailable in this build/);
    assert.match(infoChecks[0].message, /never affects the launch verdict/);

    // The default is honest about being incomplete.
    const observed = listOpenFileHolders([path.join(profile, "state.db")]);
    assert.equal(observed.observationComplete, false);
    assert.equal(observed.candidates.length, 0);
    assert.equal(observed.failures.length, 1);
    assert.equal(observed.failures[0].scope, HOLDER_PROBE_SCOPE);
  });

  it("never changes the reason codes or the verdict for an unconverted fixture", () => {
    const profile = freshCandidateProfile({
      journalMode: "wal",
      stores: { "state.db": [2, 2] },
    });
    const stateDb = path.join(profile, "state.db");
    const opts = observationOptions(profile, {});

    const plain = runLaunchGateChecks(opts);
    const withHolder = runLaunchGateChecks({
      ...opts,
      holderProbe: () => ({
        observationComplete: true,
        candidates: [
          {
            pid: 777,
            startIdentity: "v2:777:1690000000000",
            description: "hermes serve",
            heldPaths: [stateDb],
          },
        ],
        failures: [],
      }),
    });

    assert.deepEqual(extractedCodes(withHolder), extractedCodes(plain));
    assert.equal(withHolder[0].status, plain[0].status);
    assert.equal(withHolder[0].status, "fail");
    assert.match(withHolder[0].message, /would refuse a Matchlock hermes launch/);

    const observations = resolveLaunchGateObservations(opts);
    assert.ok(observations.gateInput);
    assert.deepEqual(
      extractedCodes(withHolder),
      evaluateGate(observations.gateInput).findings.map((finding) => finding.code).sort(),
    );
  });

  it("attributes an unqualified holder to the probed store paths", () => {
    const profile = freshCandidateProfile({
      journalMode: "delete",
      stores: { "state.db": [1, 1], "kanban.db": [1, 1] },
    });

    const checks = runLaunchGateChecks(
      observationOptions(profile, {
        holderProbe: () => ({
          observationComplete: true,
          candidates: [
            { pid: 5, startIdentity: "v2:5:1", description: "hermes serve" },
          ],
          failures: [],
        }),
      }),
    );

    const holder = checks.find((check) => check.name.startsWith(LAUNCH_GATE_HOLDER_CHECK_NAME));
    assert.ok(holder);
    assert.equal(holder.status, "info");
    assert.ok(holder.message.includes(path.join(profile, "state.db")));
    assert.ok(holder.message.includes(path.join(profile, "kanban.db")));
  });

  it("sanitizes credential-shaped holder descriptions and never echoes pattern-kill advice", () => {
    const profile = freshCandidateProfile({
      journalMode: "delete",
      stores: { "state.db": [1, 1] },
    });

    const checks = runLaunchGateChecks(
      observationOptions(profile, {
        holderProbe: () => ({
          observationComplete: true,
          candidates: [
            {
              pid: 9,
              startIdentity: "v2:9:1",
              description:
                "hermes serve --api-key sk-live-abcdef123456 --header Bearer tok-xyz token=abc pkill -f hermes",
            },
          ],
          failures: [],
        }),
      }),
    );

    const holder = checks.find((check) => check.name.startsWith(LAUNCH_GATE_HOLDER_CHECK_NAME));
    assert.ok(holder);
    assert.doesNotMatch(holder.message, /sk-live-abcdef123456/);
    assert.doesNotMatch(holder.message, /tok-xyz/);
    assert.doesNotMatch(holder.message, /token=abc/);
    assert.doesNotMatch(holder.message, /pkill|killall/);
    assert.ok(holder.message.includes("sk-<redacted>"));
    assert.ok(holder.message.includes("<redacted>"));

    // The sanitizer is exported and bounded for direct callers too.
    assert.equal(sanitizeHolderDescription("token=secret").includes("secret"), false);
    assert.ok(sanitizeHolderDescription("x".repeat(500)).length < 500);
  });

  it("records an observationComplete:false result without a reason as incomplete", () => {
    const profile = freshCandidateProfile({
      journalMode: "delete",
      stores: { "state.db": [1, 1] },
    });

    const checks = runLaunchGateChecks(
      observationOptions(profile, {
        holderProbe: () => ({
          observationComplete: false,
          candidates: [],
          failures: [],
        }),
      }),
    );

    assert.equal(checks[0].status, "pass");
    const infoChecks = checks.filter((check) => check.status === "info");
    assert.equal(infoChecks.length, 1);
    assert.match(infoChecks[0].message, /incomplete without a recorded reason/);
  });

  it("does not probe holders when the profile is not a launch candidate", () => {
    const home = freshHome();
    let probed = false;

    const checks = runLaunchGateChecks({
      homeDir: home,
      cwd: home,
      hermesHomeEnv: null,
      env: {},
      managedDir: null,
      holderProbe: () => {
        probed = true;
        return { observationComplete: true, candidates: [], failures: [] };
      },
    });

    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, "info");
    assert.equal(probed, false, "no stores were observed, so there is nothing to probe");
  });
});
