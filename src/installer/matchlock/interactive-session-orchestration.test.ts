/**
 * MTLK-INTERACTIVE US-013 — interactive session orchestration and pre-launch UX.
 *
 * Drives the orchestration seams OWNED by the tests: a fake admission plan, a
 * fake runtime and a fake controller. No real VM, model call, terminal or
 * matchlock invocation happens. Covers:
 *   - all four subcommands flow plan -> runtime/create config -> controller;
 *   - the pre-launch summary (resources, provenance, pinned digests, guest
 *     uid/gid, resolved mount scope) and the shell-variant harness hint;
 *   - exit-status propagation and the unconfirmed-cleanup non-success;
 *   - the observed-guest probe and the zsh-less explicit refusal;
 *   - typed admission refusals reported as a clean non-zero.
 *
 * The orchestration seams are fully injected here, so the test never spawns a
 * process (the serial-classification guard classifies it parallel-lane); it is
 * therefore not registered in tests/serial-files.txt.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import {
  buildInteractiveSessionRuntime,
  formatInteractiveSessionPrelaunch,
  probeInteractiveGuestFacts,
  runInteractiveSession,
} from "../../../dist/installer/matchlock/interactive-session-orchestration.js";
import {
  INTERACTIVE_GUEST_HARNESS_UNUSABLE_CODE,
  InteractiveGuestPrepError,
} from "../../../dist/installer/matchlock/interactive-guest-prep.js";
import { InteractiveSessionPlanError } from "../../../dist/installer/matchlock/interactive-session-plan.js";

const created: string[] = [];

function makeTemp(prefix: string): string {
  const dir = tamanduaTempDir(prefix);
  created.push(dir);
  return dir;
}

after(() => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ── fixtures ─────────────────────────────────────────────────────────

let configRoot: string;
let liveStateRoot: string;

before(() => {
  // The interactive identical-path contract mounts the config at its real host
  // path, which must sit outside the protected guest OS subtrees (/tmp, ...).
  configRoot = fs.mkdtempSync(path.join(os.homedir(), ".mtlk-orch-config-"));
  created.push(configRoot);
  liveStateRoot = makeTemp("mtlk-orch-state-");
});

function makePolicy(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 3,
    backend: "matchlock",
    requestedImage: "igorhvr/tamandua",
    requestedImageSource: "standard",
    rootUsageConsent: false,
    harness: "pi",
    configurationRoot: configRoot,
    configurationProfile: "settings.json",
    guestConfigurationRoot: "/workspace/config/pi",
    workPathMode: "host-absolute",
    workingDirectory: "/srv/interactive-work",
    workMounts: [
      {
        hostPath: "/srv/interactive-work",
        hostRealPath: "/srv/interactive-work",
        guestPath: "/srv/interactive-work",
      },
    ],
    originalRepositoryRoot: "/opt/original-repo",
    gitMetadataRoots: ["/opt/git-common"],
    mountPolicyVersion: 1,
    networkPolicyVersion: 2,
    resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480, swapMB: 8192 },
    imagePath: "/usr/local/bin:/usr/bin:/bin",
    ...over,
  };
}

function makePlan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subcommand: "pi",
    harness: "pi",
    shell: false,
    image: "igorhvr/tamandua",
    imageSource: "standard",
    workingDirectory: "/srv/interactive-work",
    identity: { uid: 4242, gid: 4343, homeDir: "/home/testuser", cwd: "/srv/interactive-work" },
    configSelection: { piConfigRoot: configRoot, piConfigProfile: "settings.json" },
    allowPrivate: [],
    resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480, swapMB: 8192 },
    rootUsageOverride: false,
    policy: makePolicy(),
    pinnedIdentity: { tag: "igorhvr/tamandua", digest: "sha256:aaaa", config_digest: "sha256:bbbb" },
    ...over,
  };
}

function makeFacts(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    passwdUids: [],
    groupGids: [],
    existingDirs: [],
    imagePath: "/usr/local/bin:/usr/bin:/bin",
    term: "xterm-256color",
    colorTerm: "truecolor",
    binary: { path: "/usr/bin/zsh", runnableAsUser: true },
    ...over,
  };
}

function makePrep(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    harness: "pi",
    shell: false,
    uid: 4242,
    gid: 4343,
    user: "tamandua",
    group: "tamandua",
    guestHome: "/home/u4242",
    guestConfigurationRoot: "/workspace/config/pi",
    guestWorkingDirectory: "/srv/interactive-work",
    commands: [],
    env: { HOME: "/home/u4242", PI_CODING_AGENT_DIR: "/workspace/config/pi" },
    ...over,
  };
}

function makeRuntime(plan: Record<string, unknown>, prep = makePrep()): Record<string, unknown> {
  return {
    plan,
    createConfig: {
      image: "igorhvr/tamandua",
      // ICEBOX Pillar B: the composer always emits the resolved boolean and
      // the resolved dns_priority; the banner reads the emitted boolean.
      privileged: true,
      network: { block_private_ips: true, intercept: true, dns_priority: "ipv4" },
      vfs: {
        mounts: {
          "/srv/interactive-work": { type: "host_fs", readonly: false },
          "/workspace/config/pi": { type: "host_fs", readonly: false },
        },
      },
    },
    hostMountDestinations: ["/srv/interactive-work", "/workspace/config/pi"],
    prepInput: {},
    basePrep: prep,
    resolveGuestPrep: async () => prep,
  };
}

const OK_OUTCOME = {
  exitCode: 0,
  vmId: "vm-1",
  cleanupConfirmed: true,
  cancelled: false,
};

// ── pre-launch summary ───────────────────────────────────────────────

describe("US-013: interactive pre-launch summary", () => {
  it("prints the resource summary, provenance, pinned digests, guest uid/gid and mount scope", () => {
    const plan = makePlan();
    const text = formatInteractiveSessionPrelaunch(makeRuntime(plan));

    assert.match(text, /matchlock: interactive pi session/);
    // ICEBOX 5ui: the summary line carries the provenance suffix (this plan
    // records `standard` provenance).
    assert.match(
      text,
      /matchlock: igorhvr\/tamandua \(standard image\) cpus=2 memory=2048MB disk=20480MB/,
    );
    assert.match(text, /image provenance: standard/);
    assert.match(text, /digest=sha256:aaaa config=sha256:bbbb/);
    assert.match(text, /guest identity: uid=4242 gid=4343/);
    assert.match(text, /mounts \(2\):/);
    assert.match(text, /rw \/srv\/interactive-work/);
    assert.match(text, /rw \/workspace\/config\/pi/);
    assert.doesNotMatch(text, /inside the shell/);
  });

  it("names the harness command to run inside for the shell variants", () => {
    const piShell = makePlan({ subcommand: "pi-shell", shell: true });
    const piText = formatInteractiveSessionPrelaunch(makeRuntime(piShell));
    assert.match(piText, /matchlock: interactive pi-shell session/);
    assert.match(piText, /run `pi` inside the shell to start the same session/);

    const hermesShell = makePlan({
      subcommand: "hermes-shell",
      harness: "hermes",
      shell: true,
      policy: makePolicy({ harness: "hermes", guestConfigurationRoot: "/workspace/config/hermes" }),
    });
    const hermesText = formatInteractiveSessionPrelaunch(makeRuntime(hermesShell));
    assert.match(hermesText, /run `hermes` inside the shell to start the same session/);
  });

  it("appends the allow-private entries through the shared resource summary", () => {
    const plan = makePlan({ allowPrivate: ["10.0.0.1", "10.0.0.2"] });
    const text = formatInteractiveSessionPrelaunch(makeRuntime(plan));
    assert.match(text, /allow-private=10\.0\.0\.1,10\.0\.0\.2/);
  });

  // ── ICEBOX: 5ui suffix + Pillar B guest-sudo banner ──────────────────

  it("ICEBOX 5ui: the ` (standard image)` suffix is driven by the RECORDED provenance, not the image name", () => {
    const standard = formatInteractiveSessionPrelaunch(makeRuntime(makePlan()));
    assert.match(
      standard,
      /matchlock: igorhvr\/tamandua \(standard image\) cpus=2 memory=2048MB disk=20480MB/,
    );

    // The SAME image reference with EXPLICIT provenance: no suffix.
    const explicit = formatInteractiveSessionPrelaunch(
      makeRuntime(makePlan({ imageSource: "explicit" })),
    );
    assert.match(explicit, /matchlock: igorhvr\/tamandua cpus=2 memory=2048MB disk=20480MB/);
    assert.doesNotMatch(explicit, /\(standard image\)/);
  });

  it("ICEBOX Pillar B: prints exactly one additive guest-sudo line immediately after guest identity (both variants)", () => {
    const privilegedText = formatInteractiveSessionPrelaunch(makeRuntime(makePlan()));
    const privilegedLines = privilegedText.trimEnd().split("\n");
    const identityIdx = privilegedLines.findIndex((line) => line.startsWith("guest identity: "));
    assert.ok(identityIdx >= 0, "the guest identity line must be present");
    assert.equal(
      privilegedLines[identityIdx + 1],
      "guest sudo: passwordless for all users (privileged VM)",
      "the privileged banner line sits immediately AFTER the guest identity line",
    );
    assert.equal(
      privilegedLines.filter((line) => line.startsWith("guest sudo: ")).length,
      1,
      "exactly one guest-sudo line",
    );

    // The opt-out variant: the fixture's create configuration says false, and
    // the banner must report exactly that (the create config is the authority).
    const base = makeRuntime(makePlan());
    const optedOut = {
      ...base,
      createConfig: {
        ...(base.createConfig as Record<string, unknown>),
        privileged: false,
      },
    };
    const optedOutText = formatInteractiveSessionPrelaunch(optedOut as never);
    const optedOutLines = optedOutText.trimEnd().split("\n");
    const optedOutIdx = optedOutLines.findIndex((line) => line.startsWith("guest identity: "));
    assert.equal(optedOutLines[optedOutIdx + 1], "guest sudo: blocked (standard VM)");
    assert.doesNotMatch(optedOutText, /passwordless/);
  });
});

// ── runtime construction + guest prep resolution ─────────────────────

describe("US-013: interactive runtime and guest prep resolution", () => {
  it("derives the mount scope, shared launch env and probes the guest for the effective prep", async () => {
    const plan = makePlan();
    const facts = makeFacts();
    const runtime = buildInteractiveSessionRuntime(plan, {
      admission: { home: "/home/testuser", liveStateRoot },
      env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
      probeGuestFacts: async () => facts,
    });

    assert.ok(runtime.hostMountDestinations.includes(configRoot), "config mounts at its identical host path");
    assert.ok(runtime.hostMountDestinations.includes("/srv/interactive-work"));
    assert.ok(
      !runtime.hostMountDestinations.includes("/workspace/config/pi"),
      "config is never relocated to the workflow guest override",
    );

    // The VM-wide create env is built by the SHARED helper before the guest.
    assert.equal(runtime.basePrep.env.HOME, "/home/u4242");
    assert.equal(runtime.basePrep.env.PI_CODING_AGENT_DIR, configRoot);
    assert.equal(runtime.basePrep.env.PATH, "/usr/local/bin:/usr/bin:/bin");
    assert.equal(runtime.basePrep.env.TERM, "xterm-256color");
    assert.equal(runtime.basePrep.env.COLORTERM, "truecolor");
    assert.equal(runtime.basePrep.commands.length, 0, "the effective commands come from the probe");

    const prep = await runtime.resolveGuestPrep({} as never);
    assert.equal(prep.uid, 4242);
    assert.equal(prep.gid, 4343);
    assert.equal(prep.guestHome, "/home/u4242");
    assert.equal(prep.guestConfigurationRoot, configRoot);
    assert.equal(prep.env.PI_CODING_AGENT_DIR, configRoot);
    assert.ok(
      prep.commands.some((command: { id: string }) => command.id === "groupadd"),
      "absent group gid must be added",
    );
    assert.ok(
      prep.commands.some((command: { id: string }) => command.id === "useradd"),
      "absent uid must be added",
    );
  });

  it("fails closed with a typed refusal when the image has no zsh runnable as the selected user", async () => {
    const plan = makePlan({ subcommand: "pi-shell", shell: true });
    const runtime = buildInteractiveSessionRuntime(plan, {
      admission: { home: "/home/testuser", liveStateRoot },
      probeGuestFacts: async () => makeFacts({ binary: null }),
    });

    await assert.rejects(
      () => runtime.resolveGuestPrep({} as never),
      (error: unknown) => {
        assert.ok(error instanceof InteractiveGuestPrepError);
        assert.equal((error as InteractiveGuestPrepError).code, INTERACTIVE_GUEST_HARNESS_UNUSABLE_CODE);
        assert.match((error as Error).message, /zsh/);
        assert.match((error as Error).message, /no automatic installation and no root retry/);
        return true;
      },
    );
  });
});

// ── observed guest facts probe ───────────────────────────────────────

describe("US-013: observed guest facts probe", () => {
  function backendEmitting(stdout: string, exitCode = 0): Record<string, unknown> {
    return {
      execStream: async (
        _cmd: unknown,
        notify: (frame: { kind: string; base64?: string }) => void,
      ) => {
        if (stdout !== "") {
          notify({ kind: "stdout", base64: Buffer.from(stdout, "utf8").toString("base64") });
        }
        return { exit_code: exitCode, duration_ms: 1 };
      },
    };
  }

  const PREP_INPUT = {
    harness: "pi",
    shell: false,
    identity: { uid: 4242, gid: 4343, hostHomeDir: "/home/testuser" },
    guestWorkingDirectory: "/srv/interactive-work",
    guestConfigurationRoot: "/workspace/config/pi",
    hostConfigurationRoot: configRoot,
    guestHome: "/home/u4242",
    hostMountDestinations: ["/srv/interactive-work", "/workspace/config/pi"],
  };

  it("parses passwd/group presence, existing dirs and a runnable harness binary", async () => {
    const facts = await probeInteractiveGuestFacts(
      backendEmitting("passwd=0\ngroup=1\ndir=/home/u4242\nbin=/usr/bin/pi|755 0 0\n") as never,
      PREP_INPUT as never,
      { imagePath: "/usr/bin", term: "xterm", colorTerm: null },
    );
    assert.deepEqual(facts.passwdUids, []);
    assert.deepEqual(facts.groupGids, [4343]);
    assert.deepEqual(facts.existingDirs, ["/home/u4242"]);
    assert.equal(facts.binary?.path, "/usr/bin/pi");
    assert.equal(facts.binary?.runnableAsUser, true);
    assert.equal(facts.imagePath, "/usr/bin");
    assert.equal(facts.term, "xterm");
  });

  it("reports no binary when the image lacks the shell and fails closed on unreadable mode metadata", async () => {
    const missing = await probeInteractiveGuestFacts(
      backendEmitting("passwd=0\ngroup=0\n") as never,
      { ...PREP_INPUT, shell: true } as never,
    );
    assert.equal(missing.binary, null);

    const noMeta = await probeInteractiveGuestFacts(
      backendEmitting("passwd=0\ngroup=0\nbin=/usr/bin/pi|\n") as never,
      PREP_INPUT as never,
    );
    assert.equal(noMeta.binary?.path, "/usr/bin/pi");
    assert.equal(noMeta.binary?.runnableAsUser, false, "unknown execute metadata fails closed");
  });
});

// ── orchestration runner ─────────────────────────────────────────────

describe("US-013: interactive session orchestration runner", () => {
  const SUBCOMMANDS = [
    { subcommand: "pi", harness: "pi", shell: false },
    { subcommand: "pi-shell", harness: "pi", shell: true },
    { subcommand: "hermes", harness: "hermes", shell: false },
    { subcommand: "hermes-shell", harness: "hermes", shell: true },
  ] as const;

  function makeArgs(subcommand: string, harness: string, shell: boolean): Record<string, unknown> {
    return {
      subcommand,
      harness,
      shell,
      workingDirectory: "/srv/interactive-work",
      image: "igorhvr/tamandua",
      imageSource: "standard",
      allowPrivate: [],
      rootUsageOverride: false,
      resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480, swapMB: 8192 },
    };
  }

  it("routes all four subcommands plan -> runtime -> controller and propagates exit status", async () => {
    for (const entry of SUBCOMMANDS) {
      const prep = makePrep({ shell: entry.shell, harness: entry.harness });
      let seenPlan: unknown;
      let seenPrep: unknown;
      let seenResolve: unknown;
      let out = "";
      const code = await runInteractiveSession(makeArgs(entry.subcommand, entry.harness, entry.shell) as never, {
        plan: async (args) => {
          seenPlan = args;
          return makePlan({ subcommand: entry.subcommand, harness: entry.harness, shell: entry.shell }) as never;
        },
        buildRuntime: (plan) => makeRuntime(plan as Record<string, unknown>, prep) as never,
        createController: (_plan, controllerPrep, options) => {
          seenPrep = controllerPrep;
          seenResolve = options.resolveGuestPrep;
          assert.equal(options.stdout, undefined);
          return {
            run: async () => ({ ...OK_OUTCOME, exitCode: 7 }),
          };
        },
        stdout: (text) => {
          out += text;
        },
        stderr: () => {},
      });

      assert.equal(code, 7, `${entry.subcommand} must propagate the launched exit status`);
      assert.ok(seenPlan, "the plan seam must receive the parsed invocation");
      assert.equal(seenPrep, prep, "the controller must receive the base prep");
      assert.equal(typeof seenResolve, "function", "the controller must receive the guest-prep resolver");
      assert.match(out, /interactive .* session/, `${entry.subcommand} must print the summary`);
      if (entry.shell) {
        assert.match(out, /inside the shell/, `${entry.subcommand} must name the harness command`);
      }
    }
  });

  it("returns non-success naming the VM when cleanup is not positively confirmed", async () => {
    let err = "";
    const code = await runInteractiveSession(makeArgs("pi", "pi", false) as never, {
      plan: async () => makePlan() as never,
      buildRuntime: (plan) => makeRuntime(plan as Record<string, unknown>) as never,
      createController: () => ({
        run: async () => ({
          exitCode: 3,
          vmId: "vm-42",
          cleanupConfirmed: false,
          cleanupError: "Matchlock VM vm-42 was not confirmed closed.",
          cancelled: false,
        }),
      }),
      stdout: () => {},
      stderr: (text) => {
        err += text;
      },
    });
    assert.equal(code, 3);
    assert.match(err, /vm-42 was not confirmed closed/);
  });

  it("reports a typed admission refusal as a clean non-zero and launches nothing", async () => {
    let launched = false;
    let err = "";
    const code = await runInteractiveSession(makeArgs("pi", "pi", false) as never, {
      plan: async () => {
        throw new InteractiveSessionPlanError("matchlock_interactive_tty_required", "no terminal");
      },
      createController: () => {
        launched = true;
        return { run: async () => ({ ...OK_OUTCOME }) };
      },
      stdout: () => {},
      stderr: (text) => {
        err += text;
      },
    });
    assert.equal(code, 1);
    assert.equal(launched, false);
    assert.match(err, /Error: no terminal/);
  });

  it("surfaces a typed guest-prep refusal (zsh-less image) as a clean non-zero", async () => {
    let err = "";
    const code = await runInteractiveSession(makeArgs("pi-shell", "pi", true) as never, {
      plan: async () => makePlan({ subcommand: "pi-shell", shell: true }) as never,
      buildRuntime: (plan) =>
        ({
          ...makeRuntime(plan as Record<string, unknown>),
          resolveGuestPrep: async () => {
            throw new InteractiveGuestPrepError(
              INTERACTIVE_GUEST_HARNESS_UNUSABLE_CODE,
              "the image does not provide a zsh executable",
            );
          },
        }) as never,
      createController: () => ({
        run: async () => {
          throw new InteractiveGuestPrepError(
            INTERACTIVE_GUEST_HARNESS_UNUSABLE_CODE,
            "the image does not provide a zsh executable",
          );
        },
      }),
      stdout: () => {},
      stderr: (text) => {
        err += text;
      },
    });
    assert.equal(code, 1);
    assert.match(err, /zsh executable/);
  });

  it("prints the root-consent warning when the plan carries one", async () => {
    let err = "";
    const code = await runInteractiveSession(makeArgs("pi", "pi", false) as never, {
      plan: async () =>
        makePlan({ rootUsageOverride: true, rootUsageWarning: "root usage overridden" }) as never,
      buildRuntime: (plan) => makeRuntime(plan as Record<string, unknown>) as never,
      createController: () => ({ run: async () => ({ ...OK_OUTCOME }) }),
      stdout: () => {},
      stderr: (text) => {
        err += text;
      },
    });
    assert.equal(code, 0);
    assert.match(err, /Warning: root usage overridden/);
  });

  // ══════════════════════════════════════════════════════════════════
  // MTLK-RPC-BIN-SPLIT (tamandua-dwl): admitted rpc binding threading
  // ══════════════════════════════════════════════════════════════════
  // The plan freezes ONE rpc invocation; the session must launch exactly that
  // (binary + argv) and refuse a controller override that names a DIFFERENT
  // executable BEFORE any VM work. These are the differential tests the dwl
  // bead asks for: admission binding vs override vs PATH.

  const ADMITTED_RPC = { binaryPath: "/opt/admitted/matchlock", args: ["rpc", "--frozen"] };

  it("threads the admitted invocation into the controller (no override)", async () => {
    let seen: Record<string, unknown> | undefined;
    const code = await runInteractiveSession(makeArgs("pi", "pi", false) as never, {
      plan: async () => makePlan({ resolvedRpc: ADMITTED_RPC }) as never,
      buildRuntime: (plan) => makeRuntime(plan as Record<string, unknown>) as never,
      createController: (_plan, _prep, options) => {
        seen = options as unknown as Record<string, unknown>;
        return { run: async () => ({ ...OK_OUTCOME }) };
      },
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(code, 0);
    assert.equal(seen?.rpcBinaryPath, ADMITTED_RPC.binaryPath, "the admitted binary reaches the controller");
    assert.deepEqual(seen?.rpcArgs, [...ADMITTED_RPC.args], "the admitted argv reaches the controller");
  });

  it("refuses a controller rpc binary override that disagrees with the admitted binding", async () => {
    let launched = false;
    let err = "";
    const code = await runInteractiveSession(makeArgs("pi", "pi", false) as never, {
      plan: async () => makePlan({ resolvedRpc: ADMITTED_RPC }) as never,
      buildRuntime: (plan) => makeRuntime(plan as Record<string, unknown>) as never,
      controllerOptions: { rpcBinaryPath: "/decoy/other-matchlock" },
      createController: () => {
        launched = true;
        return { run: async () => ({ ...OK_OUTCOME }) };
      },
      stdout: () => {},
      stderr: (text) => {
        err += text;
      },
    });
    assert.equal(code, 1, "a disagreeing binary override is a typed refusal");
    assert.equal(launched, false, "no controller/VM work may start on a binding mismatch");
    assert.match(err, /disagrees with the admitted matchlock invocation/);
  });

  it("refuses a controller rpc args override that disagrees with the admitted argv", async () => {
    let launched = false;
    let err = "";
    const code = await runInteractiveSession(makeArgs("pi", "pi", false) as never, {
      plan: async () => makePlan({ resolvedRpc: ADMITTED_RPC }) as never,
      buildRuntime: (plan) => makeRuntime(plan as Record<string, unknown>) as never,
      controllerOptions: { rpcArgs: ["rpc", "--other"] },
      createController: () => {
        launched = true;
        return { run: async () => ({ ...OK_OUTCOME }) };
      },
      stdout: () => {},
      stderr: (text) => {
        err += text;
      },
    });
    assert.equal(code, 1, "a disagreeing argv override is a typed refusal");
    assert.equal(launched, false);
    assert.match(err, /disagree with the admitted matchlock/);
  });

  it("accepts an agreeing override and normalizes an explicit empty args override", async () => {
    let seen: Record<string, unknown> | undefined;
    const code = await runInteractiveSession(makeArgs("pi", "pi", false) as never, {
      plan: async () =>
        makePlan({ resolvedRpc: { binaryPath: "/opt/admitted/matchlock", args: ["rpc"] } }) as never,
      buildRuntime: (plan) => makeRuntime(plan as Record<string, unknown>) as never,
      // Same executable (exact spelling) and an EXPLICIT EMPTY args array:
      // the empty array mirrors the transport default ["rpc"], so it cannot
      // disagree with an admitted default binding.
      controllerOptions: { rpcBinaryPath: "/opt/admitted/matchlock", rpcArgs: [] },
      createController: (_plan, _prep, options) => {
        seen = options as unknown as Record<string, unknown>;
        return { run: async () => ({ ...OK_OUTCOME }) };
      },
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(code, 0, "an agreeing override must proceed");
    assert.equal(seen?.rpcBinaryPath, "/opt/admitted/matchlock");
    assert.deepEqual(seen?.rpcArgs, ["rpc"], "the admitted argv is transported");
  });
});
