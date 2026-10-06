/**
 * Tests for the `tamandua matchlock` CLI surface.
 *
 * Two layers are covered:
 *
 *  1. MTLK-SETUP (US-014): the group/setup help content, the top-level
 *     registration (`isTopLevelGroup`/`KNOWN_TOP_LEVEL`), the global usage line
 *     and the spawn-based setup `--help` dispatch.
 *  2. MTLK-INTERACTIVE US-012: in-process handler tests with an injected
 *     cwd/env/host probe, captured streams and a fake `runSession` seam (no VM,
 *     terminal or real matchlock), plus real CLI subprocess tests through
 *     `bin/tamandua` for the help exit codes and the unknown-subcommand /
 *     unknown-option refusals.
 *
 * This file imports `node:child_process` directly, so it is registered in the
 * serial lane (`tests/serial-files.txt`).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import {
  getMatchlockHelp,
  getMatchlockHermesHelp,
  getMatchlockHermesShellHelp,
  getMatchlockPiHelp,
  getMatchlockPiShellHelp,
  getMatchlockSetupHelp,
  handleMatchlock,
  type MatchlockCommandDeps,
} from "../../../dist/cli/commands/matchlock.js";
import {
  INTERACTIVE_SESSION_SUBCOMMANDS,
  type InteractiveSessionArgs,
} from "../../../dist/cli/matchlock-interactive-args.js";
import { createDefaultMatchlockSetupDeps } from "../../../dist/installer/matchlock-setup-runner.js";
import { KNOWN_TOP_LEVEL, isTopLevelGroup } from "../../../dist/cli/shared.js";
import { cleanChildEnv, createTempHome } from "../../../tests/helpers/test-env.ts";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WRAPPER_PATH = path.resolve(__dirname, "..", "..", "..", "bin", "tamandua");

/** Exact global usage line required by spec §4.1. */
const USAGE_LINE =
  "tamandua matchlock setup          Provision matchlock: binaries, host setup, standard image";

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const testEnv = createTempHome("tamandua-matchlock-cli-test-");
  const result = spawnSync("/bin/sh", [WRAPPER_PATH, ...args], {
    encoding: "utf8",
    env: cleanChildEnv({ HOME: testEnv.homeDir }),
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("matchlock command module", () => {
  it("is backed by a source module", () => {
    assert.equal(fs.existsSync(path.join(process.cwd(), "src/cli/commands/matchlock.ts")), true);
  });

  it("exports the group help", () => {
    const help = getMatchlockHelp();
    assert.match(help, /tamandua matchlock/);
    assert.match(help, /setup/);
    assert.match(help, /matchlock setup --help/);
  });

  it("documents the four phases", () => {
    const help = getMatchlockSetupHelp();
    assert.match(help, /Phases \(in order\)/);
    assert.match(help, /1\. Binaries/);
    assert.match(help, /2\. Host setup/);
    assert.match(help, /3\. Boot assets/);
    assert.match(help, /4\. Verify/);
  });

  it("documents every flag", () => {
    const help = getMatchlockSetupHelp();
    for (const flag of [
      "--latest",
      "--ref <sha|tag|branch>",
      "--prefix <dir>",
      "--refresh-image",
      "--allow-low-disk-space",
      "--no-host-setup",
      "--no-image",
      "--force",
      "--smoke",
      "--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs",
    ]) {
      assert.ok(help.includes(flag), `setup help should document ${flag}`);
    }
  });

  it("documents platform notes", () => {
    const help = getMatchlockSetupHelp();
    assert.match(help, /Linux \(amd64\/arm64\)/);
    assert.match(help, /macOS \(Apple Silicon\)/);
    assert.match(help, /\/opt\/homebrew\/bin/);
    assert.match(help, /SDKROOT=MacOSX26\.5\.sdk/);
  });

  it("documents the re-login caveat", () => {
    const help = getMatchlockSetupHelp();
    assert.match(help, /RE-LOGIN CAVEAT/);
    assert.match(help, /log out and back in/);
    assert.match(help, /refuses --smoke/);
  });

  it("documents the admission-refusal relationship", () => {
    const help = getMatchlockSetupHelp();
    assert.match(help, /Provision this host with: tamandua matchlock setup/);
    assert.match(help, /never pulls or builds an image\s+at launch/);
  });

  it("documents the kernel-warm / offline (R11) contract", () => {
    const help = getMatchlockSetupHelp();
    assert.match(help, /kernel pull/);
    assert.match(help, /assets: offline-ready/);
    assert.match(help, /no\s+public-internet access/);
  });

  it("declines command groups owned by other handlers", async () => {
    assert.equal(await handleMatchlock("workflow", ["workflow", "status"]), false);
    assert.equal(await handleMatchlock("dashboard", ["dashboard", "status"]), false);
    assert.equal(await handleMatchlock("setup", ["setup"]), false);
  });
});

describe("matchlock CLI registration", () => {
  it("registers matchlock as a known top-level group", () => {
    assert.equal(isTopLevelGroup("matchlock"), true);
    assert.ok(KNOWN_TOP_LEVEL.includes("matchlock"));
  });

  it("exposes the spawn-capable default deps factory", () => {
    const deps = createDefaultMatchlockSetupDeps();
    assert.equal(typeof deps.runCommand, "function");
    assert.equal(typeof deps.fs.isExecutable, "function");
    assert.equal(typeof deps.resolveStoredImage, "function");
    assert.equal(typeof deps.accountHomeResolver, "function");
    assert.equal(deps.platform, process.platform);
    assert.equal(deps.arch, process.arch);
  });

  it("global usage contains the new matchlock setup line", () => {
    const result = cli(["--help"]);
    assert.equal(result.status, 0);
    assert.ok(
      result.stdout.includes(USAGE_LINE),
      `global usage should contain:\n${USAGE_LINE}\n--- actual ---\n${result.stdout}`,
    );
  });

  it("`matchlock --help` prints the group help", () => {
    const result = cli(["matchlock", "--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /tamandua matchlock/);
    assert.match(result.stdout, /matchlock setup --help/);
    // Group help is not the detailed setup help.
    assert.doesNotMatch(result.stdout, /Phases \(in order\)/);
  });

  it("`matchlock setup --help` prints the setup help", () => {
    const result = cli(["matchlock", "setup", "--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Phases \(in order\)/);
    assert.match(result.stdout, /1\. Binaries/);
    assert.match(result.stdout, /--refresh-image/);
    assert.match(result.stdout, /Provision this host with: tamandua matchlock setup/);
  });

  it("`matchlock setup -h` dispatches to the setup help too", () => {
    const result = cli(["matchlock", "setup", "-h"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Phases \(in order\)/);
  });

  it("`matchlock --help` does not execute the command", () => {
    const result = cli(["matchlock", "--help"]);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /refusing to run as root/);
    assert.equal(result.stderr, "");
  });

  // Superseded by the combined dispatcher: an unknown matchlock action now
  // routes through the shared unknown-command reporter (disclosed in the
  // reconciliation report), preserving the non-zero outcome and the guidance.
  it("an unknown matchlock action fails with usage guidance", () => {
    const result = cli(["matchlock", "frobnicate"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown command: "matchlock frobnicate"/);
  });

  // The combined usage synopsis now names all five subcommands, so the regex is
  // relaxed from main's setup-only form to the shared prefix (disclosed).
  it("a missing matchlock subcommand fails with usage guidance", () => {
    const result = cli(["matchlock"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing matchlock subcommand/);
    assert.match(result.stderr, /Usage: tamandua matchlock/);
  });
});

const HOST_PROBE = { onlineCpus: () => 4, totalMemoryMB: () => 8192 };

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

interface Captured {
  deps: MatchlockCommandDeps;
  stdout: () => string;
  stderr: () => string;
  exits: number[];
}

function captureDeps(overrides: Partial<MatchlockCommandDeps> = {}): Captured {
  let out = "";
  let err = "";
  const exits: number[] = [];
  const deps: MatchlockCommandDeps = {
    cwd: makeTemp("mtlk-cli-"),
    env: {},
    hostProbe: HOST_PROBE,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    exit: (code) => {
      exits.push(code);
    },
    ...overrides,
  };
  return { deps, stdout: () => out, stderr: () => err, exits };
}

describe("matchlock CLI handler (in-process)", () => {
  it("returns false for unrelated top-level groups", async () => {
    const captured = captureDeps();
    assert.equal(await handleMatchlock("workflow", ["workflow", "list"], captured.deps), false);
    assert.equal(await handleMatchlock("", [], captured.deps), false);
    assert.deepEqual(captured.exits, []);
  });

  it("refuses a missing subcommand with a usage error", async () => {
    const captured = captureDeps();
    assert.equal(await handleMatchlock("matchlock", ["matchlock"], captured.deps), true);
    assert.deepEqual(captured.exits, [1]);
    assert.match(captured.stderr(), /Missing matchlock subcommand\./);
    assert.match(captured.stderr(), /Usage: tamandua matchlock/);
  });

  it("refuses an unknown option naming the exact token without launching", async () => {
    let launched = false;
    const captured = captureDeps({
      runSession: async () => {
        launched = true;
        return 0;
      },
    });

    assert.equal(
      await handleMatchlock("matchlock", ["matchlock", "pi", "--nope"], captured.deps),
      true,
    );

    assert.equal(launched, false);
    assert.deepEqual(captured.exits, [1]);
    assert.match(captured.stderr(), /Unknown option "--nope" for tamandua matchlock pi/);
  });

  it("refuses a value-bearing --matchlock and points at --matchlock-image", async () => {
    const captured = captureDeps();
    await handleMatchlock(
      "matchlock",
      ["matchlock", "hermes", "--matchlock=igorhvr/tamandua"],
      captured.deps,
    );
    assert.deepEqual(captured.exits, [1]);
    assert.match(captured.stderr(), /--matchlock takes no value/);
    assert.match(captured.stderr(), /--matchlock-image/);
  });

  it("refuses a zero swap size", async () => {
    const captured = captureDeps();
    await handleMatchlock(
      "matchlock",
      ["matchlock", "pi", "--matchlock-swap", "0"],
      captured.deps,
    );
    assert.deepEqual(captured.exits, [1]);
    assert.match(captured.stderr(), /--matchlock-no-swap/);
  });

  it("refuses simultaneous --matchlock-swap and --matchlock-no-swap", async () => {
    const captured = captureDeps();
    await handleMatchlock(
      "matchlock",
      ["matchlock", "pi", "--matchlock-swap", "1024", "--matchlock-no-swap"],
      captured.deps,
    );
    assert.deepEqual(captured.exits, [1]);
    assert.match(captured.stderr(), /Cannot specify both/);
  });

  it("parses a valid pi invocation and hands the plan to the runSession seam", async () => {
    const cwd = makeTemp("mtlk-cli-cwd-");
    let seen: InteractiveSessionArgs | undefined;
    const captured = captureDeps({
      cwd,
      runSession: async (args) => {
        seen = args;
        return 0;
      },
    });

    assert.equal(await handleMatchlock("matchlock", ["matchlock", "pi"], captured.deps), true);

    assert.ok(seen, "runSession must receive the parsed invocation");
    assert.equal(seen.subcommand, "pi");
    assert.equal(seen.harness, "pi");
    assert.equal(seen.shell, false);
    assert.equal(seen.workingDirectory, cwd);
    assert.equal(seen.image, "igorhvr/tamandua");
    assert.equal(seen.imageSource, "standard");
    // Exit 0 is the dispatcher's normal fall-through; it must not call exit().
    assert.deepEqual(captured.exits, []);
  });

  it("parses hermes-shell and propagates the launched exit status", async () => {
    let seen: InteractiveSessionArgs | undefined;
    const captured = captureDeps({
      runSession: async (args) => {
        seen = args;
        return 7;
      },
    });

    await handleMatchlock("matchlock", ["matchlock", "hermes-shell"], captured.deps);

    assert.ok(seen);
    assert.equal(seen.subcommand, "hermes-shell");
    assert.equal(seen.harness, "hermes");
    assert.equal(seen.shell, true);
    assert.deepEqual(captured.exits, [7]);
  });

  it("wires the production default to the interactive orchestration (no-terminal refusal, no launch)", async () => {
    const captured = captureDeps({
      session: { planOptions: { stdinIsTty: false, stdoutIsTty: false } },
    });
    await handleMatchlock("matchlock", ["matchlock", "pi"], captured.deps);
    assert.deepEqual(captured.exits, [1]);
    assert.match(captured.stderr(), /without a terminal on stdin and stdout/);
    assert.match(captured.stderr(), /no host-execution fallback/);
  });
});

describe("matchlock help renderers", () => {
  it("group help names the five subcommands, the shared options and both invariants", () => {
    const help = getMatchlockHelp();
    assert.match(help, /^tamandua matchlock — Run pi or Hermes in a disposable Matchlock VM/);
    assert.match(help, /Usage: tamandua matchlock <pi\|pi-shell\|hermes\|hermes-shell>/);
    for (const sub of ["setup", ...INTERACTIVE_SESSION_SUBCOMMANDS]) {
      assert.match(help, new RegExp(`^  ${sub}`, "m"), `group help must list ${sub}`);
    }
    assert.match(help, /--matchlock-image <ref>/);
    assert.match(help, /--matchlock-no-swap/);
    assert.match(help, /--matchlock-allow-private <entry>/);
    assert.match(help, /--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs/);
    assert.match(help, /tamandua matchlock setup/);
    assert.match(help, /no workflow-round deadline/);
  });

  const renderers: Array<[string, () => string]> = [
    ["pi", getMatchlockPiHelp],
    ["pi-shell", getMatchlockPiShellHelp],
    ["hermes", getMatchlockHermesHelp],
    ["hermes-shell", getMatchlockHermesShellHelp],
  ];

  for (const [subcommand, render] of renderers) {
    it(`${subcommand} help documents its own usage and the shared option set`, () => {
      const help = render();
      assert.match(help, new RegExp(`Usage: tamandua matchlock ${subcommand} `));
      assert.match(help, /--working-directory-for-harness <dir>/);
      assert.match(help, /--matchlock-image <ref>/);
      assert.match(help, /Environment precedence:/);
    });
  }

  it("shell helps explain the identical guest and the no-substitution refusal", () => {
    for (const help of [getMatchlockPiShellHelp(), getMatchlockHermesShellHelp()]) {
      assert.match(help, /zsh/);
      assert.match(help, /refused explicitly/);
      assert.match(help, /no shell is substituted/);
    }
  });
});

describe("matchlock top-level registration", () => {
  it("is recognized by isTopLevelGroup and listed in KNOWN_TOP_LEVEL", () => {
    assert.equal(isTopLevelGroup("matchlock"), true);
    assert.ok(KNOWN_TOP_LEVEL.includes("matchlock"));
  });
});

describe("tamandua matchlock — CLI subprocess", () => {
  function cli(args: string[]) {
    const th = createTempHome("tamandua-mtlk-cli-");
    const wrapperPath = path.resolve("bin/tamandua");
    const result = spawnSync("/bin/sh", [wrapperPath, ...args], {
      encoding: "utf8",
      env: cleanChildEnv({
        HOME: th.homeDir,
        TAMANDUA_STATE_DIR: th.tamanduaDir,
      }),
      timeout: 60_000,
    });
    return result;
  }

  it("serves group help and lists the command in the global usage", () => {
    const groupHelp = cli(["matchlock", "--help"]);
    assert.equal(groupHelp.status, 0, `stderr: ${groupHelp.stderr}`);
    assert.match(groupHelp.stdout ?? "", /tamandua matchlock — Run pi or Hermes/);
    assert.match(groupHelp.stdout ?? "", /--matchlock-image/);

    const globalHelp = cli(["--help"]);
    assert.equal(globalHelp.status, 0);
    assert.match(globalHelp.stdout ?? "", /tamandua matchlock <pi\|pi-shell\|hermes\|hermes-shell>/);
  });

  for (const subcommand of ["pi", "pi-shell", "hermes", "hermes-shell"] as const) {
    it(`serves ${subcommand} --help and -h with exit 0`, () => {
      const long = cli(["matchlock", subcommand, "--help"]);
      assert.equal(long.status, 0, `stderr: ${long.stderr}`);
      assert.match(long.stdout ?? "", new RegExp(`Usage: tamandua matchlock ${subcommand} `));

      const short = cli(["matchlock", subcommand, "-h"]);
      assert.equal(short.status, 0, `stderr: ${short.stderr}`);
      assert.match(short.stdout ?? "", new RegExp(`Usage: tamandua matchlock ${subcommand} `));
    });
  }

  it("rejects an unknown subcommand with a suggestion and no full usage dump", () => {
    const result = cli(["matchlock", "pie"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr ?? "", /Unknown command: "matchlock pie"/);
    assert.match(result.stderr ?? "", /Did you mean: tamandua matchlock pi\?/);
    assert.doesNotMatch(result.stdout ?? "", /tamandua get-ready/);
  });

  it("rejects a missing subcommand", () => {
    const result = cli(["matchlock"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr ?? "", /Missing matchlock subcommand\./);
  });

  it("rejects an unknown option naming the problem", () => {
    const result = cli(["matchlock", "pi", "--bogus"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr ?? "", /Unknown option "--bogus" for tamandua matchlock pi/);
  });
});
