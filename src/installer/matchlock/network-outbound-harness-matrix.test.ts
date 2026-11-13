/**
 * NAT-EGRESS US-010 — harness matrix.
 *
 * The unrestricted-outbound network mode is chosen ONCE at creation and
 * persisted as the optional `networkOutbound` field on `runs.matchlock_policy`.
 * This file proves the mode reaches the ONE shared create composer under EVERY
 * workflow harness — `--pi-as-harness` (default), `--hermes-as-harness` and
 * `--dsh-as-harness` — so no harness can silently drop, widen or narrow it:
 *
 *   1. PARAMETERIZED MATRIX over the three admitted harness policy shapes and
 *      the three selection sources (default / flag / env). A persisted NAT mode
 *      composes `{block_private_ips:false, intercept:false}` with `dns_priority`
 *      and `allow_private` ABSENT; the default composes the d8047aa5
 *      intercepted block (including `dns_priority`).
 *   2. DSH PROFILE-OVERLAY PATH explicitly: a dsh policy composed with the
 *      host-attested `dshProfileOverlay` + `helperPackHostPath` still carries the
 *      network block verbatim in both modes — the private overlay preparation
 *      can neither bypass, overwrite nor omit it (two independently prepared
 *      overlays for the same mode compose byte-identical network blocks).
 *   3. HERMES ADMISSION BRANCH explicitly: `admitMatchlockRun({harness:"hermes"})`
 *      persists a supplied unrestricted mode and composes `intercept:false`;
 *      a default admission persists nothing and composes interception.
 *   4. NO interactive dsh surface: the shared interactive parser still rejects
 *      `dsh` (the baseline had no such command and this change adds none).
 *   5. ADMISSION REFUSALS (R6/R7): `admitMatchlockRun` refuses a contradictory
 *      RESOLVED selection (unrestricted + allow-private / DNS priority, flag or
 *      env sourced) BEFORE any matchlock RPC, and refuses a contradictory
 *      INHERITED stored policy instead of silently narrowing it.
 *   6. runWorkflow-DRIVEN MATRIX: the REAL `runWorkflow` is driven for pi,
 *      hermes and dsh (fake rpc driver + in-process fake control plane) and the
 *      persisted `runs.matchlock_policy` + the composer's network block are
 *      asserted per harness — the seam where a silent drop used to live.
 *
 * Serial lane: importing `admission.js` reaches `rpc-client.ts` (spawn) and
 * `repository-scope.ts` (execFileSync), so this file is registered in
 * `tests/serial-files.txt`. Everything is synthetic — no VM, no real matchlock
 * binary, no model, no network qualification is claimed here.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildMatchlockCreateConfig,
  MATCHLOCK_GUEST_RUNTIME_ROOT,
  type BuildMatchlockCreateConfigOptions,
} from "../../../dist/installer/matchlock/mount-plan.js";
import {
  buildMatchlockPolicy,
  parseMatchlockPolicy,
  serializeMatchlockPolicy,
  type BuildMatchlockPolicyParams,
  type ExecutionIsolation,
} from "../../../dist/installer/matchlock/policy.js";
import {
  MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV,
  resolveMatchlockNetworkOutbound,
  type ResolvedMatchlockNetworkOutbound,
} from "../../../dist/installer/matchlock/network-outbound.js";
import {
  dshProfileOverlayRoot,
  prepareDshProfileOverlay,
} from "../../../dist/installer/matchlock/dsh-profile-overlay.js";
import {
  admitMatchlockRun,
  MatchlockAdmissionError,
  MATCHLOCK_RPC_ARGS_ENV,
  MATCHLOCK_RPC_BIN_ENV,
  type MatchlockAllowPrivateSupportProbe,
} from "../../../dist/installer/matchlock/admission.js";
import { runWorkflow } from "../../../dist/installer/run.js";
import { getDb } from "../../../dist/db.js";
import { PREP_STATE_CAPABILITY } from "../../../dist/installer/matchlock/prep-state.js";
import { writeFakeRpcDriver, tempTranscriptPath } from "../../../dist/installer/matchlock/fake-rpc-driver.js";
import type { MatchlockSwapSupportProbe } from "../../../dist/installer/matchlock/swap-support.js";
import {
  INTERACTIVE_SESSION_SUBCOMMANDS,
  InteractiveSessionArgError,
  parseInteractiveSessionArgs,
} from "../../../dist/cli/matchlock-interactive-args.js";

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

/** The three admitted workflow harnesses and their real CLI opt-in spellings. */
const HARNESSES = [
  { harness: "pi", flag: "--pi-as-harness", guestConfigurationRoot: "/workspace/config/pi" },
  { harness: "hermes", flag: "--hermes-as-harness", guestConfigurationRoot: "/workspace/config/hermes" },
  { harness: "dsh", flag: "--dsh-as-harness", guestConfigurationRoot: "/workspace/config/dsh" },
] as const;
type MatrixHarness = (typeof HARNESSES)[number]["harness"];

/** The three selection sources from the story: default, flag and env. */
const SELECTIONS = [
  {
    name: "default",
    resolve: (): ResolvedMatchlockNetworkOutbound => resolveMatchlockNetworkOutbound({ flag: false, env: {} }),
    expectedNetwork: GOLDEN_INTERCEPTED_NETWORK,
    persisted: false,
  },
  {
    name: "flag",
    resolve: (): ResolvedMatchlockNetworkOutbound => resolveMatchlockNetworkOutbound({ flag: true, env: {} }),
    expectedNetwork: GOLDEN_UNRESTRICTED_NETWORK,
    persisted: true,
  },
  {
    name: "env",
    resolve: (): ResolvedMatchlockNetworkOutbound =>
      resolveMatchlockNetworkOutbound({ flag: false, env: { [MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV]: "1" } }),
    expectedNetwork: GOLDEN_UNRESTRICTED_NETWORK,
    persisted: true,
  },
] as const;

/** Mirror admission's emission rule: only a NAT selection is persisted. */
function persistedModeField(
  resolved: ResolvedMatchlockNetworkOutbound,
): Pick<BuildMatchlockPolicyParams, "networkOutbound"> {
  return resolved.unrestricted ? { networkOutbound: resolved } : {};
}

let tmpRoot: string;
let workDir: string;
let helperPack: string;
let piHome: string;
let hermesHome: string;
let dshHome: string;
let operatorHome: string;
let dshLiveState: string;
let overlayInvocationCounter = 0;
let savedEnv: Array<[string, string | undefined]> = [];
let fakeDriver: string;

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpRoot, prefix));
}

/** Synthetic dsh home with the real headless profile layout (overlay fixture). */
function makeDshHome(dir?: string): string {
  const home = dir ?? mkTmp("dsh-home-");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(home, "profiles", "node_modules", "@deepseek-ai"), { recursive: true });
  fs.mkdirSync(path.join(home, "profiles", "headless", "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(home, "profiles", "headless", ".dsh-module-fallback", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(home, "profiles", "headless", "cordis.yml"), "[]\n", "utf8");
  fs.writeFileSync(path.join(home, "profiles", "headless", "package.json"), "{}\n", "utf8");
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(home, "storages"), { recursive: true });
  fs.writeFileSync(path.join(home, ".credentials.yaml"), "refs: []\n", "utf8");
  fs.writeFileSync(path.join(home, ".anonymous-user-id"), "anon\n", "utf8");
  return home;
}

/**
 * Build the persisted policy shape for a harness from the FROZEN admission
 * inputs (exactly what `buildMatchlockPolicy` writes into
 * `runs.matchlock_policy`), including the optional network mode.
 */
function harnessPolicyParams(
  harness: MatrixHarness,
  resolved: ResolvedMatchlockNetworkOutbound,
  over: Partial<BuildMatchlockPolicyParams> = {},
): BuildMatchlockPolicyParams {
  const seat = HARNESSES.find((h) => h.harness === harness);
  assert.ok(seat, `unknown harness ${harness}`);
  const common = {
    requestedImage: "vic/ml:latest",
    identity: IDENTITY,
    harness,
    workingDirectory: workDir,
    originalRepositoryRoot: workDir,
    workMounts: [{ hostPath: workDir, hostRealPath: workDir, guestPath: workDir }],
    gitMetadataRoots: [] as string[],
    guestConfigurationRoot: seat.guestConfigurationRoot,
    ...persistedModeField(resolved),
  };
  if (harness === "dsh") {
    return {
      ...common,
      configurationRoot: dshHome,
      configurationProfile: "headless",
      submissionHomeDir: operatorHome,
      submissionCwd: workDir,
      submissionDshHomeEnv: null,
      submissionDshHomeSource: "default",
      ...over,
    };
  }
  if (harness === "hermes") {
    return {
      ...common,
      configurationRoot: hermesHome,
      configurationProfile: "default",
      hermes: { homeDir: operatorHome, cwd: workDir, hermesHomeEnv: hermesHome },
      ...over,
    };
  }
  return {
    ...common,
    configurationRoot: piHome,
    configurationProfile: "settings.json",
    ...over,
  };
}

/** Build the persisted policy shape for a harness. */
function buildHarnessPolicy(
  harness: MatrixHarness,
  resolved: ResolvedMatchlockNetworkOutbound,
  over: Partial<BuildMatchlockPolicyParams> = {},
): ExecutionIsolation {
  return buildMatchlockPolicy(harnessPolicyParams(harness, resolved, over));
}

/** Prepare a fresh private dsh overlay for the current fixture home. */
function prepareOverlay(): { runId: string; liveStateRoot: string; invocationId: string } {
  overlayInvocationCounter += 1;
  const hex = overlayInvocationCounter.toString(16).padStart(8, "0");
  const invocationId = `inv-aaaaaaaa-${hex}`;
  const runId = "11111111-2222-3333-4444-555555555555";
  prepareDshProfileOverlay(runId, invocationId, dshLiveState, dshHome);
  return { runId, liveStateRoot: dshLiveState, invocationId };
}

/**
 * Compose the create params from the PERSISTED `runs.matchlock_policy` string —
 * the same read the scheduler/runner performs on every launch. Nothing here
 * consults an ambient flag or environment.
 */
interface ComposedStored {
  policy: ExecutionIsolation;
  network: Record<string, unknown>;
  cfg: ReturnType<typeof buildMatchlockCreateConfig>;
  overlay?: { runId: string; liveStateRoot: string; invocationId: string };
}

function composeStored(stored: string, harness: MatrixHarness): ComposedStored {
  const policy = parseMatchlockPolicy(stored);
  const opts: BuildMatchlockCreateConfigOptions = { helperPackHostPath: helperPack };
  let overlay: ComposedStored["overlay"];
  if (harness === "dsh") {
    overlay = prepareOverlay();
    opts.dshProfileOverlay = overlay;
    opts.admission = { home: os.homedir(), liveStateRoot: dshLiveState };
  }
  const cfg = buildMatchlockCreateConfig(policy, IDENTITY, opts);
  return { policy, network: (cfg.network ?? {}) as Record<string, unknown>, cfg, ...(overlay ? { overlay } : {}) };
}

before(() => {
  // The mount plan refuses a /tmp GUEST destination ("shadows a protected
  // guest OS root"), so fixtures live under the REAL operator home as narrow
  // descendants, like admission.test.ts does. No VM or matchlock socket is
  // created, so no path-length concern applies.
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".mtlk-netegress-matrix-")));
  workDir = path.join(tmpRoot, "work");
  helperPack = path.join(tmpRoot, "guest-pack");
  piHome = path.join(tmpRoot, "pi-agent");
  hermesHome = path.join(tmpRoot, "hermes-home");
  operatorHome = path.join(tmpRoot, "operator");
  dshHome = makeDshHome();
  dshLiveState = mkTmp("live-state-");
  for (const dir of [workDir, helperPack, piHome, hermesHome, operatorHome]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fakeDriver = writeFakeRpcDriver({ dir: path.join(tmpRoot, "driver") });

  // Scoped to THIS test process only (no spawned children inherit it except
  // the owned fake rpc driver, which reads FAKE_* fixtures).
  const keys = [
    "HOME",
    "PI_CODING_AGENT_DIR",
    MATCHLOCK_RPC_BIN_ENV,
    MATCHLOCK_RPC_ARGS_ENV,
    "FAKE_IMAGE_TAG",
    "FAKE_IMAGE_DIGEST",
    "FAKE_IMAGE_CONFIG_DIGEST",
    "FAKE_RESOLVE_MISSING",
    "FAKE_TRANSCRIPT_FILE",
    "FAKE_IMAGE_PATH",
  ];
  savedEnv = keys.map((k) => [k, process.env[k]]);
});

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── 1. parameterized harness matrix ────────────────────────────────────────

describe("NAT-EGRESS US-010: every workflow harness composes the persisted mode through the ONE composer", () => {
  for (const { harness, flag } of HARNESSES) {
    for (const selection of SELECTIONS) {
      it(`${flag} + selection=${selection.name}: composes the expected network block from the stored policy`, () => {
        const resolved = selection.resolve();
        const built = buildHarnessPolicy(harness, resolved);
        assert.equal(built.harness, harness);

        if (selection.persisted) {
          // The persisted record carries the mode verbatim (source included).
          assert.deepEqual(built.networkOutbound, resolved);
        } else {
          assert.equal(
            Object.prototype.hasOwnProperty.call(built, "networkOutbound"),
            false,
            "the default writes NOTHING: absence means interception",
          );
        }

        // Every later launch reads the stored column and composes from it.
        const stored = serializeMatchlockPolicy(built);
        const { policy, network } = composeStored(stored, harness);
        assert.deepEqual(policy.networkOutbound, built.networkOutbound);
        assert.deepEqual(network, selection.expectedNetwork);
        if (selection.persisted) {
          assert.equal("dns_priority" in network, false, "dns_priority is interception-only");
          assert.equal("allow_private" in network, false, "allow_private is interception-only");
          assert.deepEqual(Object.keys(network).sort(), ["block_private_ips", "intercept"]);
        } else {
          assert.equal(network.dns_priority, "ipv4", "the intercepted block stays self-describing");
        }
      });
    }
  }

  it("the same mode composes a BYTE-IDENTICAL network block under all three harnesses", () => {
    for (const selection of SELECTIONS) {
      const resolved = selection.resolve();
      const blocks = HARNESSES.map(({ harness }) => {
        const stored = serializeMatchlockPolicy(buildHarnessPolicy(harness, resolved));
        return JSON.stringify(composeStored(stored, harness).network);
      });
      assert.equal(
        new Set(blocks).size,
        1,
        `selection=${selection.name}: harnesses must not drift (got ${JSON.stringify(blocks)})`,
      );
      assert.equal(blocks[0], JSON.stringify(selection.expectedNetwork));
    }
  });

  it("an unrestricted policy keeps stale interception settings off the wire under every harness", () => {
    for (const { harness } of HARNESSES) {
      const resolved = resolveMatchlockNetworkOutbound({ flag: true, env: {} });
      // Simulate a record that still carries leftovers from an earlier
      // resolution: the NAT composer must not advertise stopped machinery.
      const stale = buildHarnessPolicy(harness, resolved, {
        networkAllowPrivate: ["192.168.107.74:8888"],
        matchlockDnsPriority: { priority: "ipv6", source: "flag" },
      });
      const stored = serializeMatchlockPolicy(stale);
      const { network } = composeStored(stored, harness);
      assert.deepEqual(network, GOLDEN_UNRESTRICTED_NETWORK);
      assert.equal("dns_priority" in network, false);
      assert.equal("allow_private" in network, false);
    }
  });
});

// ── 2. dsh profile-overlay create path, exercised explicitly ───────────────

describe("NAT-EGRESS US-010: the dsh profile-overlay create path preserves the network block", () => {
  for (const selection of SELECTIONS) {
    it(`dsh overlay + helper pack, selection=${selection.name}: the overlay plan neither bypasses nor omits the network block`, () => {
      const resolved = selection.resolve();
      const stored = serializeMatchlockPolicy(buildHarnessPolicy("dsh", resolved));

      // Two INDEPENDENTLY prepared private overlays for the same mode: each is
      // exercised explicitly so overlay preparation cannot hide in a cached plan.
      const composedRuns = [composeStored(stored, "dsh"), composeStored(stored, "dsh")];

      for (const [index, composed] of composedRuns.entries()) {
        const label = `overlay-${index + 1}`;
        assert.deepEqual(composed.network, selection.expectedNetwork, `${label}: network block`);
        assert.ok(composed.overlay, `${label}: the overlay option was supplied`);
        // The overlay preparation is real: the DSH_HOME destination is the
        // prepared private overlay, not the host home.
        assert.equal(composed.cfg.env?.DSH_HOME, "/workspace/config/dsh", `${label}: DSH_HOME`);
        const homeMount = composed.cfg.vfs?.mounts?.["/workspace/config/dsh"];
        assert.ok(homeMount, `${label}: DSH_HOME must be mounted`);
        assert.equal(
          homeMount?.host_path,
          dshProfileOverlayRoot(
            composed.overlay.runId,
            composed.overlay.invocationId,
            composed.overlay.liveStateRoot,
          ),
          `${label}: DSH_HOME sourced from the prepared private overlay`,
        );
        assert.equal(homeMount?.readonly, false);
        assert.notEqual(homeMount?.host_path, dshHome, `${label}: never the host install-derived home`);
        // The RO helper pack is still mounted: the overlay path does not
        // replace the rest of the plan.
        assert.equal(
          composed.cfg.vfs?.mounts?.[MATCHLOCK_GUEST_RUNTIME_ROOT]?.readonly,
          true,
          `${label}: helper pack`,
        );
      }

      const [first, second] = composedRuns;

      // The overlay path can never influence the network block: two
      // independently prepared private overlays compose identical wire bytes.
      assert.equal(
        JSON.stringify(first.network),
        JSON.stringify(second.network),
        "dsh overlay preparation must not rewrite the network mode",
      );
      assert.notEqual(
        first.overlay?.invocationId,
        second.overlay?.invocationId,
        "the two composes really used distinct prepared overlays",
      );
      if (selection.persisted) {
        assert.deepEqual(Object.keys(first.network).sort(), ["block_private_ips", "intercept"]);
        assert.equal((first.policy as ExecutionIsolation).networkOutbound?.unrestricted, true);
      } else {
        assert.equal((first.policy as ExecutionIsolation).networkOutbound, undefined);
        assert.equal(first.network.intercept, true);
        assert.equal("dns_priority" in first.network, true);
      }
    });
  }

  it("dsh: a policy WITHOUT the persisted field composes interception even when an ambient NAT env value is set", () => {
    const previous = process.env[MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV];
    process.env[MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV] = "1";
    try {
      const stored = serializeMatchlockPolicy(
        buildHarnessPolicy("dsh", resolveMatchlockNetworkOutbound({ flag: false, env: {} })),
      );
      const { network } = composeStored(stored, "dsh");
      assert.deepEqual(network, GOLDEN_INTERCEPTED_NETWORK);
    } finally {
      if (previous === undefined) delete process.env[MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV];
      else process.env[MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV] = previous;
    }
  });
});

// ── 3. hermes Matchlock admission branch, exercised explicitly ─────────────

describe("NAT-EGRESS US-010: the hermes admission branch persists and composes the supplied mode", () => {
  const supportingSwapProbe: MatchlockSwapSupportProbe = (binaryPath) => ({
    supported: true,
    binaryPath,
  });
  const supportingAllowPrivateProbe: MatchlockAllowPrivateSupportProbe = (binaryPath) => ({
    supported: true,
    binaryPath,
  });

  function setFake(over: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  /** The standard hermes fresh-admission fake environment (resolve_image only). */
  function setFakeResolve(): void {
    setFake({
      [MATCHLOCK_RPC_BIN_ENV]: process.execPath,
      [MATCHLOCK_RPC_ARGS_ENV]: JSON.stringify([fakeDriver]),
      PI_CODING_AGENT_DIR: undefined, // a hermes admission must NOT consult the pi config root
      FAKE_IMAGE_TAG: "vic/hermes:latest",
      FAKE_IMAGE_DIGEST: "sha256:hermesdigest00000000000000000000000000000000000000000000000000000",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:hermesconfig0000000000000000000000000000000000000000000000000000",
      FAKE_TRANSCRIPT_FILE: tempTranscriptPath(),
      FAKE_RESOLVE_MISSING: undefined,
      FAKE_IMAGE_PATH: undefined,
    });
  }

  function hermesAdmissionOpts(over: Record<string, unknown>): Record<string, unknown> {
    return {
      requestedImage: "vic/hermes:latest",
      workspaceMode: "direct",
      workingDirectory: workDir,
      rpcBinaryPath: process.execPath,
      rpcArgs: [fakeDriver],
      swapSupportProbe: supportingSwapProbe,
      allowPrivateSupportProbe: supportingAllowPrivateProbe,
      harness: "hermes",
      submission: { homeDir: operatorHome, cwd: workDir, hermesHomeEnv: hermesHome },
      ...over,
    };
  }

  for (const source of ["flag", "env"] as const) {
    it(`harness=hermes, source=${source}: admission persists the supplied mode and composes intercept:false`, async () => {
      setFakeResolve();
      const supplied = resolveMatchlockNetworkOutbound(
        source === "flag"
          ? { flag: true, env: {} }
          : { flag: false, env: { [MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV]: "1" } },
      );
      const result = await admitMatchlockRun(
        hermesAdmissionOpts({ networkOutbound: supplied }) as never,
      );
      assert.equal(result.policy.harness, "hermes");
      assert.deepEqual(result.policy.networkOutbound, supplied);

      // The persisted record (the column write) carries the field, and a
      // later launch reading it composes the unrestricted wire block.
      const stored = serializeMatchlockPolicy(result.policy);
      const reparsed = parseMatchlockPolicy(stored);
      assert.deepEqual(reparsed.networkOutbound, supplied);
      const cfg = buildMatchlockCreateConfig(reparsed, result.identity, {
        helperPackHostPath: helperPack,
      });
      assert.deepEqual(cfg.network, GOLDEN_UNRESTRICTED_NETWORK);
      assert.equal("dns_priority" in (cfg.network ?? {}), false);
      assert.equal("allow_private" in (cfg.network ?? {}), false);
    });
  }

  it("harness=hermes, default: admission persists NO field and composes interception", async () => {
    setFakeResolve();
    const result = await admitMatchlockRun(hermesAdmissionOpts({}) as never);
    assert.equal(result.policy.harness, "hermes");
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.policy, "networkOutbound"),
      false,
      "the default writes nothing; absence means interception",
    );
    const reparsed = parseMatchlockPolicy(serializeMatchlockPolicy(result.policy));
    const cfg = buildMatchlockCreateConfig(reparsed, result.identity, {
      helperPackHostPath: helperPack,
    });
    assert.deepEqual(cfg.network, GOLDEN_INTERCEPTED_NETWORK);
  });

  it("harness=hermes, replacement: an inherited INTERCEPTED policy is not widened by a supplied NAT mode", async () => {
    setFakeResolve();
    const first = await admitMatchlockRun(hermesAdmissionOpts({}) as never);
    assert.equal(first.policy.networkOutbound, undefined);
    const replacement = await admitMatchlockRun(
      hermesAdmissionOpts({
        inheritedPolicy: first.policy,
        networkOutbound: { unrestricted: true, source: "flag" },
      }) as never,
    );
    assert.equal(replacement.policy.harness, "hermes");
    assert.equal(
      Object.prototype.hasOwnProperty.call(replacement.policy, "networkOutbound"),
      false,
      "absence in the inherited policy is authoritative",
    );
    const cfg = buildMatchlockCreateConfig(
      parseMatchlockPolicy(serializeMatchlockPolicy(replacement.policy)),
      replacement.identity,
      { helperPackHostPath: helperPack },
    );
    assert.deepEqual(cfg.network, GOLDEN_INTERCEPTED_NETWORK);
  });
});

// ── 3b. admission refuses a contradictory RESOLVED selection ─────────────

describe("NAT-EGRESS R6/R7: admission refuses a contradictory RESOLVED selection", () => {
  const supportingSwapProbe: MatchlockSwapSupportProbe = (binaryPath) => ({
    supported: true,
    binaryPath,
  });
  const supportingAllowPrivateProbe: MatchlockAllowPrivateSupportProbe = (binaryPath) => ({
    supported: true,
    binaryPath,
  });

  function setFake(over: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  /** A hermes fresh admission with the fake resolve-only RPC driver. */
  function hermesOpts(over: Record<string, unknown>, transcript: string): Record<string, unknown> {
    setFake({
      [MATCHLOCK_RPC_BIN_ENV]: process.execPath,
      [MATCHLOCK_RPC_ARGS_ENV]: JSON.stringify([fakeDriver]),
      PI_CODING_AGENT_DIR: undefined,
      FAKE_IMAGE_TAG: "vic/hermes:latest",
      FAKE_IMAGE_DIGEST: "sha256:hermesdigest00000000000000000000000000000000000000000000000000000",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:hermesconfig0000000000000000000000000000000000000000000000000000",
      FAKE_TRANSCRIPT_FILE: transcript,
      FAKE_RESOLVE_MISSING: undefined,
      FAKE_IMAGE_PATH: undefined,
    });
    return {
      requestedImage: "vic/hermes:latest",
      workspaceMode: "direct",
      workingDirectory: workDir,
      rpcBinaryPath: process.execPath,
      rpcArgs: [fakeDriver],
      swapSupportProbe: supportingSwapProbe,
      allowPrivateSupportProbe: supportingAllowPrivateProbe,
      harness: "hermes",
      submission: { homeDir: operatorHome, cwd: workDir, hermesHomeEnv: hermesHome },
      ...over,
    };
  }

  const refusal = async (
    opts: Record<string, unknown>,
    snippets: string[],
    transcript: string,
  ): Promise<MatchlockAdmissionError> => {
    let caught: MatchlockAdmissionError | undefined;
    await assert.rejects(
      () => admitMatchlockRun(opts as never),
      (err: unknown) => {
        assert.ok(err instanceof MatchlockAdmissionError, `expected MatchlockAdmissionError, got ${String(err)}`);
        assert.equal(err.code, "matchlock_network_outbound_conflict");
        for (const snippet of snippets) {
          assert.ok(err.message.includes(snippet), `refusal must name ${JSON.stringify(snippet)}: ${err.message}`);
        }
        caught = err;
        return true;
      },
    );
    assert.equal(
      fs.existsSync(transcript),
      false,
      "a refused admission must issue ZERO matchlock RPC (no resolve, no create, no VM)",
    );
    return caught as MatchlockAdmissionError;
  };

  it("a FRESH env-selected unrestricted admission + allow-private is refused before any RPC", async () => {
    const transcript = tempTranscriptPath();
    await refusal(
      {
        ...hermesOpts({}, transcript),
        networkOutbound: { unrestricted: true, source: "env" },
        allowPrivate: ["10.0.0.0/8"],
      },
      [MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV, "--matchlock-allow-private"],
      transcript,
    );
  });

  it("a FRESH flag-selected unrestricted admission + DNS priority env is refused before any RPC", async () => {
    const transcript = tempTranscriptPath();
    await refusal(
      {
        ...hermesOpts({}, transcript),
        networkOutbound: { unrestricted: true, source: "flag" },
        matchlockDnsPriority: { priority: "ipv6", source: "env" },
      },
      ["--matchlock-unrestricted-outbound-networking", "TAMANDUA_MATCHLOCK_DNS_PRIORITY"],
      transcript,
    );
  });

  it("a FRESH env-selected unrestricted admission + env-selected DNS priority is refused before any RPC", async () => {
    const transcript = tempTranscriptPath();
    await refusal(
      {
        ...hermesOpts({}, transcript),
        networkOutbound: { unrestricted: true, source: "env" },
        matchlockDnsPriority: { priority: "ipv6", source: "env" },
      },
      [MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV, "TAMANDUA_MATCHLOCK_DNS_PRIORITY"],
      transcript,
    );
  });

  it("a contradictory INHERITED stored policy is refused (never silently narrowed) naming the stored policy and the remedy", async () => {
    const transcript = tempTranscriptPath();
    const contradictory = buildHarnessPolicy("hermes", resolveMatchlockNetworkOutbound({
      flag: false,
      env: { [MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV]: "1" },
    }), {
      requestedImage: "vic/hermes:latest",
      networkAllowPrivate: ["10.0.0.0/8"],
      matchlockDnsPriority: { priority: "ipv6", source: "flag" },
    });
    const err = await refusal(
      hermesOpts({ inheritedPolicy: contradictory }, transcript),
      [
        MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV,
        "--matchlock-allow-private",
        "STORED Matchlock policy is contradictory",
        "create a new run",
      ],
      transcript,
    );
    assert.ok(err.message.length > 0);
  });
});

// ── 4. no interactive dsh surface ─────────────────────────────────────────

describe("NAT-EGRESS US-010: no interactive dsh surface is added", () => {
  it("the shared interactive subcommand set is exactly the four pi/hermes entry points", () => {
    assert.deepEqual([...INTERACTIVE_SESSION_SUBCOMMANDS], ["pi", "pi-shell", "hermes", "hermes-shell"]);
    assert.equal((INTERACTIVE_SESSION_SUBCOMMANDS as readonly string[]).includes("dsh"), false);
  });

  it("the shared interactive parser still rejects a dsh subcommand", () => {
    assert.throws(
      () => parseInteractiveSessionArgs("dsh", []),
      (error: unknown) =>
        error instanceof InteractiveSessionArgError &&
        /Unknown matchlock subcommand/.test((error as Error).message) &&
        /hermes-shell/.test((error as Error).message),
    );
  });
});

// ── 5. runWorkflow-driven matrix (the seam where a silent drop used to live) ─
//
// The pure matrix above proves the ONE composer behaves for every harness. This
// block closes the ACTUAL seam: it drives the REAL `runWorkflow` for
// `--pi-as-harness`, `--hermes-as-harness` and `--dsh-as-harness` through
// `runWorkflow` -> admission -> persisted `runs.matchlock_policy` -> the
// scheduler-side composer, so a mode that reaches run creation can never be
// dropped between the CLI and the policy row. Everything is synthetic (fake rpc
// driver + in-process fake control plane): no daemon, no VM, no real matchlock.

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

function runGit(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  runGit(["init", "--initial-branch=main"], dir);
  runGit(["config", "user.email", "test@tamandua.local"], dir);
  runGit(["config", "user.name", "Tamandua Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# Test Repo\n", "utf-8");
  runGit(["add", "README.md"], dir);
  runGit(["commit", "-m", "initial commit"], dir);
}

function writeMinimalWorkflow(workflowsRoot: string, workflowId: string): void {
  const workflowDir = path.join(workflowsRoot, workflowId);
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, "workflow.yml"),
    `id: ${workflowId}\nrun:\n  workspace: direct\nagents:\n  - id: dev\n    model: fake\n    workspace:\n      baseDir: .\nsteps:\n  - id: implement\n    agent: dev\n    input: Implement the task\n    expects: STATUS, CHANGES, TESTS\n`,
    "utf-8",
  );
}

describe("NAT-EGRESS R6/R7: runWorkflow persists and composes the resolved mode for every harness", () => {
  let runHome: string;
  let stateDir: string;
  let control: FakeControlPlane;
  let saved: Array<[string, string | undefined]> = [];

  function setEnv(key: string, value: string | undefined): void {
    saved.push([key, process.env[key]]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  before(async () => {
    runHome = fs.mkdtempSync(path.join(tmpRoot, "run-home-"));
    stateDir = fs.mkdtempSync(path.join(tmpRoot, "run-state-"));
    fs.mkdirSync(path.join(runHome, ".pi", "agent"), { recursive: true });
    fs.mkdirSync(path.join(runHome, ".hermes"), { recursive: true });
    makeDshHome(path.join(runHome, ".dsh"));
    control = await startFakeControlPlane();
    saved = [];
    setEnv("HOME", runHome);
    setEnv("TAMANDUA_STATE_DIR", stateDir);
    setEnv("TAMANDUA_DB_PATH", path.join(stateDir, "tamandua.db"));
    setEnv("TAMANDUA_CONTROL_PORT", String(control.port));
    setEnv(MATCHLOCK_RPC_BIN_ENV, process.execPath);
    setEnv(MATCHLOCK_RPC_ARGS_ENV, JSON.stringify([fakeDriver]));
    setEnv("FAKE_IMAGE_TAG", "vic/ml:latest");
    setEnv("FAKE_IMAGE_DIGEST", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    setEnv("FAKE_IMAGE_CONFIG_DIGEST", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    setEnv("FAKE_RESOLVE_MISSING", undefined);
    setEnv("FAKE_IMAGE_PATH", undefined);
  });

  after(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await control.close();
  });

  for (const { harness } of HARNESSES) {
    it(`${harness}: runWorkflow persists {unrestricted:true,source:'env'} and the composer emits intercept:false`, async () => {
      const workflowId = `test-netegress-runworkflow-${harness}`;
      // Installed workflows are resolved from the state dir, not HOME.
      writeMinimalWorkflow(path.join(stateDir, "workflows"), workflowId);
      const fixtureRoot = fs.mkdtempSync(path.join(tmpRoot, `rw-${harness}-`));
      const repoDir = path.join(fixtureRoot, "repo");
      initGitRepo(repoDir);
      const transcript = tempTranscriptPath();
      setEnv("FAKE_TRANSCRIPT_FILE", transcript);

      // This is exactly what the CLI parser resolves from the environment.
      const resolved = resolveMatchlockNetworkOutbound({
        flag: false,
        env: { [MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV]: "1" },
      });
      assert.deepEqual(resolved, { unrestricted: true, source: "env" });

      try {
        await runWorkflow({
          workflowId,
          taskTitle: `NAT ${harness} round`,
          workingDirectoryForHarness: repoDir,
          matchlockImage: "vic/ml:latest",
          ...(harness === "hermes" ? { harnessType: "hermes" as const } : {}),
          ...(harness === "dsh"
            ? {
                matchlockHarness: "dsh" as const,
                dshSubmission: { homeDir: runHome, env: {}, cwd: process.cwd() },
              }
            : {}),
          matchlockUnrestrictedOutbound: resolved,
          matchlockSwapSupportProbe: (binaryPath: string) => ({ supported: true, binaryPath }),
          matchlockResourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480, swapMB: 8192 },
        });
      } catch (err) {
        // Registration against the in-process control plane may still race; the
        // run row + policy are persisted BEFORE registration, so a daemon-side
        // failure is not a launch/policy failure.
        assert.ok(
          err instanceof Error && /Failed to register run with daemon|daemon/.test(err.message),
          `unexpected runWorkflow failure: ${String(err)}`,
        );
      }

      const db = getDb();
      const row = db
        .prepare(
          "SELECT matchlock_policy FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(workflowId) as { matchlock_policy: string | null } | undefined;
      assert.ok(row?.matchlock_policy, `${harness}: the run policy must be persisted`);
      const policy = parseMatchlockPolicy(row!.matchlock_policy!);
      assert.equal(policy.harness, harness);
      assert.deepEqual(policy.networkOutbound, { unrestricted: true, source: "env" });

      // Every LATER launch composes from that persisted record.
      const opts: BuildMatchlockCreateConfigOptions = { helperPackHostPath: helperPack };
      if (harness === "dsh") {
        const overlay = {
          runId: "11111111-2222-3333-4444-777777777777",
          invocationId: "inv-cccccccc-00000001",
          liveStateRoot: dshLiveState,
        };
        prepareDshProfileOverlay(overlay.runId, overlay.invocationId, overlay.liveStateRoot, path.join(runHome, ".dsh"));
        opts.dshProfileOverlay = overlay;
        opts.admission = { home: runHome, liveStateRoot: dshLiveState };
      }
      const cfg = buildMatchlockCreateConfig(policy, IDENTITY, opts);
      assert.deepEqual(cfg.network, GOLDEN_UNRESTRICTED_NETWORK, `${harness}: composed network block`);
      assert.equal("dns_priority" in (cfg.network ?? {}), false);
      assert.equal("allow_private" in (cfg.network ?? {}), false);

      // Guard against a silent-drop regression: the fake driver journal must
      // prove admission resolved the image exactly once and never created a VM.
      const methods = fs
        .readFileSync(transcript, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .map((entry) => entry.method)
        .filter(Boolean);
      assert.deepEqual(methods, ["resolve_image"], `${harness}: resolve-only, no create`);
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });
  }
});
