import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";

import {
  INTERACTIVE_SESSION_SUBCOMMANDS,
  MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG,
  InteractiveSessionArgError,
  parseInteractiveSessionArgs,
  type ParseInteractiveSessionArgsOptions,
} from "../../dist/cli/matchlock-interactive-args.js";
import { MATCHLOCK_IMAGE_ENV, STANDARD_MATCHLOCK_IMAGE } from "../../dist/installer/matchlock/standard-image.js";
import {
  MATCHLOCK_CPUS_ENV,
  MATCHLOCK_DISK_ENV,
  MATCHLOCK_MEMORY_ENV,
  MATCHLOCK_SWAP_ENV,
  MatchlockResourceLimitError,
} from "../../dist/installer/matchlock/resource-limits.js";
import { MATCHLOCK_ALLOW_PRIVATE_ENV } from "../../dist/installer/matchlock/allow-private.js";
import {
  MatchlockIsolationSettingError,
} from "../../dist/installer/matchlock/isolation-settings.js";

// Deterministic host probe: 8 online CPUs, 32 GiB MemTotal so the built-in
// defaults are stable (cpus 8, memory 16384 MB, disk 20480 MB, swap 8192 MB).
const HOST_PROBE = { onlineCpus: () => 8, totalMemoryMB: () => 32768 };

const BASE_OPTIONS: ParseInteractiveSessionArgsOptions = {
  cwd: process.cwd(),
  env: {},
  hostProbe: HOST_PROBE,
};

function parse(args: string[], subcommand = "pi", overrides: ParseInteractiveSessionArgsOptions = {}) {
  return parseInteractiveSessionArgs(subcommand, args, { ...BASE_OPTIONS, ...overrides });
}

describe("parseInteractiveSessionArgs — subcommands and base resolution", () => {
  it("accepts all four subcommands with the correct harness/shell selection", () => {
    const expected: Record<string, { harness: string; shell: boolean }> = {
      pi: { harness: "pi", shell: false },
      "pi-shell": { harness: "pi", shell: true },
      hermes: { harness: "hermes", shell: false },
      "hermes-shell": { harness: "hermes", shell: true },
    };
    for (const subcommand of INTERACTIVE_SESSION_SUBCOMMANDS) {
      const result = parse([], subcommand);
      assert.equal(result.subcommand, subcommand);
      assert.deepEqual(
        { harness: result.harness, shell: result.shell },
        expected[subcommand],
        `subcommand ${subcommand}`,
      );
    }
  });

  it("returns the resolved working directory, image provenance, resource limits, root override and allow-private list", () => {
    const result = parse([MATCHLOCK_ROOT_USAGE_OVERRIDE_FLAG, "--matchlock-allow-private", "10.0.0.1"]);
    assert.equal(result.workingDirectory, process.cwd());
    assert.equal(result.image, STANDARD_MATCHLOCK_IMAGE);
    assert.equal(result.imageSource, "standard");
    assert.equal(result.rootUsageOverride, true);
    assert.deepEqual(result.allowPrivate, ["10.0.0.1"]);
    assert.deepEqual(
      {
        cpus: result.resourceLimits.cpus,
        memoryMB: result.resourceLimits.memoryMB,
        diskSizeMB: result.resourceLimits.diskSizeMB,
        swapMB: result.resourceLimits.swapMB,
      },
      { cpus: 8, memoryMB: 16384, diskSizeMB: 20480, swapMB: 8192 },
    );
    assert.deepEqual(result.resourceLimits.sources, {
      cpus: "default",
      memoryMB: "default",
      diskSizeMB: "default",
      swapMB: "default",
    });
  });

  it("rejects an unknown subcommand", () => {
    assert.throws(
      () => parseInteractiveSessionArgs("dsh", [], BASE_OPTIONS),
      /Unknown matchlock subcommand/,
    );
  });

  it("accepts a redundant bare --matchlock as a no-op opt-in", () => {
    const withBare = parse(["--matchlock"]);
    const withoutBare = parse([]);
    assert.deepEqual(withBare, withoutBare);
  });
});

describe("parseInteractiveSessionArgs — option/env precedence", () => {
  it("resolves image: flag > env > built-in standard and records provenance", () => {
    const builtIn = parse([]);
    assert.equal(builtIn.image, STANDARD_MATCHLOCK_IMAGE);
    assert.equal(builtIn.imageSource, "standard");

    const fromEnv = parse([], "pi", { env: { [MATCHLOCK_IMAGE_ENV]: "env.example/img" } });
    assert.equal(fromEnv.image, "env.example/img");
    assert.equal(fromEnv.imageSource, "standard");

    const fromFlag = parse(["--matchlock-image", "flag.example/img"], "pi", {
      env: { [MATCHLOCK_IMAGE_ENV]: "env.example/img" },
    });
    assert.equal(fromFlag.image, "flag.example/img");
    assert.equal(fromFlag.imageSource, "explicit");

    const equalsForm = parse(["--matchlock-image=equals.example/img"]);
    assert.equal(equalsForm.image, "equals.example/img");
    assert.equal(equalsForm.imageSource, "explicit");
  });

  it("resolves cpus: flag > env > built-in default", () => {
    const defaults = parse([]);
    assert.equal(defaults.resourceLimits.cpus, 8);
    assert.equal(defaults.resourceLimits.sources.cpus, "default");

    const fromEnv = parse([], "pi", { env: { [MATCHLOCK_CPUS_ENV]: "5" } });
    assert.equal(fromEnv.resourceLimits.cpus, 5);
    assert.equal(fromEnv.resourceLimits.sources.cpus, "env");

    const fromFlag = parse(["--matchlock-cpus", "3"], "pi", { env: { [MATCHLOCK_CPUS_ENV]: "5" } });
    assert.equal(fromFlag.resourceLimits.cpus, 3);
    assert.equal(fromFlag.resourceLimits.sources.cpus, "flag");

    const equalsForm = parse(["--matchlock-cpus=2"]);
    assert.equal(equalsForm.resourceLimits.cpus, 2);
    assert.equal(equalsForm.resourceLimits.sources.cpus, "flag");
  });

  it("resolves memory: flag > env > built-in default (with the <n>g grammar)", () => {
    const defaults = parse([]);
    assert.equal(defaults.resourceLimits.memoryMB, 16384);
    assert.equal(defaults.resourceLimits.sources.memoryMB, "default");

    const fromEnv = parse([], "pi", { env: { [MATCHLOCK_MEMORY_ENV]: "6000" } });
    assert.equal(fromEnv.resourceLimits.memoryMB, 6000);
    assert.equal(fromEnv.resourceLimits.sources.memoryMB, "env");

    const fromFlag = parse(["--matchlock-memory", "2g"], "pi", {
      env: { [MATCHLOCK_MEMORY_ENV]: "6000" },
    });
    assert.equal(fromFlag.resourceLimits.memoryMB, 2048);
    assert.equal(fromFlag.resourceLimits.sources.memoryMB, "flag");

    const equalsForm = parse(["--matchlock-memory=1g"]);
    assert.equal(equalsForm.resourceLimits.memoryMB, 1024);
  });

  it("resolves disk: flag > env > built-in default", () => {
    const defaults = parse([]);
    assert.equal(defaults.resourceLimits.diskSizeMB, 20480);
    assert.equal(defaults.resourceLimits.sources.diskSizeMB, "default");

    const fromEnv = parse([], "pi", { env: { [MATCHLOCK_DISK_ENV]: "30000" } });
    assert.equal(fromEnv.resourceLimits.diskSizeMB, 30000);
    assert.equal(fromEnv.resourceLimits.sources.diskSizeMB, "env");

    const fromFlag = parse(["--matchlock-disk", "4096"], "pi", {
      env: { [MATCHLOCK_DISK_ENV]: "30000" },
    });
    assert.equal(fromFlag.resourceLimits.diskSizeMB, 4096);
    assert.equal(fromFlag.resourceLimits.sources.diskSizeMB, "flag");
  });

  it("resolves swap: flag > env (size or off) > built-in default", () => {
    const defaults = parse([]);
    assert.equal(defaults.resourceLimits.swapMB, 8192);
    assert.equal(defaults.resourceLimits.sources.swapMB, "default");

    const fromEnv = parse([], "pi", { env: { [MATCHLOCK_SWAP_ENV]: "2048" } });
    assert.equal(fromEnv.resourceLimits.swapMB, 2048);
    assert.equal(fromEnv.resourceLimits.sources.swapMB, "env");

    const envOff = parse([], "pi", { env: { [MATCHLOCK_SWAP_ENV]: "off" } });
    assert.equal(envOff.resourceLimits.swapMB, 0);
    assert.equal(envOff.resourceLimits.sources.swapMB, "env");

    const fromFlag = parse(["--matchlock-swap", "1024"], "pi", {
      env: { [MATCHLOCK_SWAP_ENV]: "2048" },
    });
    assert.equal(fromFlag.resourceLimits.swapMB, 1024);
    assert.equal(fromFlag.resourceLimits.sources.swapMB, "flag");
  });

  it("disables swap with --matchlock-no-swap", () => {
    const result = parse(["--matchlock-no-swap"]);
    assert.equal(result.resourceLimits.swapMB, 0);
    assert.equal(result.resourceLimits.sources.swapMB, "flag");
  });
});

describe("parseInteractiveSessionArgs — refusals", () => {
  it("rejects a value-bearing --matchlock in the equals form", () => {
    assert.throws(() => parse(["--matchlock=igorhvr/tamandua"]), /takes no value/);
  });

  it("rejects a value that follows bare --matchlock (never consumed)", () => {
    assert.throws(() => parse(["--matchlock", "igorhvr/tamandua"]), /Unexpected argument/);
  });

  it("rejects unknown long, equals and short options and positional arguments", () => {
    assert.throws(() => parse(["--bogus"]), /Unknown option/);
    assert.throws(() => parse(["--bogus=1"]), /Unknown option/);
    assert.throws(() => parse(["-x"]), /Unknown option/);
    assert.throws(() => parse(["stray"]), /Unexpected argument/);
  });

  it("rejects duplicate singleton flags", () => {
    assert.throws(
      () => parse(["--matchlock-image", "a", "--matchlock-image", "b"]),
      /Duplicate --matchlock-image/,
    );
    assert.throws(
      () => parse(["--matchlock-cpus", "2", "--matchlock-cpus=3"]),
      /Duplicate --matchlock-cpus/,
    );
    assert.throws(
      () => parse([`--working-directory-for-harness=${process.cwd()}`, "--working-directory-for-harness", process.cwd()]),
      /Duplicate --working-directory-for-harness/,
    );
  });

  it("rejects missing values (at end of argv and before another known option)", () => {
    assert.throws(() => parse(["--matchlock-image"]), /Missing value for --matchlock-image/);
    assert.throws(() => parse(["--matchlock-image="]), /Missing value for --matchlock-image/);
    assert.throws(() => parse(["--matchlock-cpus"]), /Missing value for --matchlock-cpus/);
    assert.throws(
      () => parse(["--matchlock-image", "--matchlock-cpus", "2"]),
      /Missing value for --matchlock-image/,
    );
    assert.throws(() => parse(["--matchlock-allow-private"]), /Missing value for --matchlock-allow-private/);
  });

  it("rejects --matchlock-swap together with --matchlock-no-swap in either order", () => {
    assert.throws(
      () => parse(["--matchlock-swap", "1024", "--matchlock-no-swap"]),
      /Cannot specify both --matchlock-(swap and --matchlock-no-swap|no-swap and --matchlock-swap)/,
    );
    assert.throws(
      () => parse(["--matchlock-no-swap", "--matchlock-swap", "1024"]),
      /Cannot specify both --matchlock-(swap and --matchlock-no-swap|no-swap and --matchlock-swap)/,
    );
  });

  it("rejects zero sizes for cpus, memory, disk and swap", () => {
    assert.throws(() => parse(["--matchlock-cpus", "0"]), MatchlockResourceLimitError);
    assert.throws(() => parse(["--matchlock-memory", "0"]), MatchlockResourceLimitError);
    assert.throws(() => parse(["--matchlock-disk", "0"]), MatchlockResourceLimitError);
    assert.throws(() => parse(["--matchlock-swap", "0"]), /0 does not disable swap/);
    assert.throws(() => parse(["--matchlock-swap=0"]), /0 does not disable swap/);
  });

  it("propagates a typed error (never a bare success) for invalid option values", () => {
    assert.throws(() => parse(["--matchlock-cpus", "abc"]), MatchlockResourceLimitError);
    assert.throws(() => parse(["--matchlock-swap", "-1"]), MatchlockResourceLimitError);
    assert.throws(() => parse(["--matchlock-image", "   "]), InteractiveSessionArgError);
  });
});

describe("parseInteractiveSessionArgs — allow-private", () => {
  it("accepts repeatable entries in space and equals forms and normalizes them", () => {
    const result = parse([
      "--matchlock-allow-private", "10.0.0.1",
      "--matchlock-allow-private=example.com:443",
      "--matchlock-allow-private", "  10.0.0.1  ",
    ]);
    assert.deepEqual(result.allowPrivate, ["10.0.0.1", "example.com:443"]);
  });

  it("CLI entries replace the TAMANDUA_MATCHLOCK_ALLOW_PRIVATE default list", () => {
    const env = { [MATCHLOCK_ALLOW_PRIVATE_ENV]: "env.example.com,10.9.9.9" };
    const withFlag = parse(["--matchlock-allow-private", "10.0.0.1"], "pi", { env });
    assert.deepEqual(withFlag.allowPrivate, ["10.0.0.1"]);

    const envOnly = parse([], "pi", { env });
    assert.deepEqual(envOnly.allowPrivate, ["env.example.com", "10.9.9.9"]);

    const none = parse([]);
    assert.deepEqual(none.allowPrivate, []);
  });

  it("refuses an invalid CLI entry naming the offending value", () => {
    assert.throws(
      () => parse(["--matchlock-allow-private", "bad entry"]),
      (err: unknown) => {
        assert.ok(err instanceof InteractiveSessionArgError);
        assert.match(err.message, /invalid allow-private entry/);
        assert.match(err.message, /bad entry/);
        return true;
      },
    );
  });

  it("refuses an invalid env-default entry naming the offending value", () => {
    assert.throws(
      () => parse([], "pi", { env: { [MATCHLOCK_ALLOW_PRIVATE_ENV]: "ok.example,bad entry" } }),
      /bad entry/,
    );
  });
});

describe("parseInteractiveSessionArgs — working directory", () => {
  it("defaults to process.cwd()", () => {
    const result = parse([]);
    assert.equal(result.workingDirectory, process.cwd());
  });

  it("resolves a relative existing directory against the invoking cwd", () => {
    const result = parse(["--working-directory-for-harness", "src"]);
    assert.equal(result.workingDirectory, path.join(process.cwd(), "src"));
  });

  it("resolves an injected cwd as the default", () => {
    const injected = path.join(process.cwd(), "src");
    const result = parse([], "pi", { cwd: injected });
    assert.equal(result.workingDirectory, injected);
  });

  it("rejects a non-existent directory", () => {
    assert.throws(
      () => parse(["--working-directory-for-harness", "definitely-not-a-real-dir-99dead97"]),
      /does not exist/,
    );
  });

  it("rejects a relative directory that escapes the invoking cwd", () => {
    assert.throws(
      () => parse(["--working-directory-for-harness", "../outside-99dead97"]),
      /must not escape the invoking directory/,
    );
    assert.throws(
      () => parse(["--working-directory-for-harness=../.."]),
      /must not escape the invoking directory/,
    );
  });

  it("rejects a path that is a file, not a directory", () => {
    assert.throws(
      () => parse(["--working-directory-for-harness", "package.json"]),
      /must be a directory/,
    );
  });

  it("accepts an absolute existing directory", () => {
    const result = parse(["--working-directory-for-harness", process.cwd()]);
    assert.equal(result.workingDirectory, process.cwd());
  });
});

// ── ICEBOX isolation settings (privileged-by-default + DNS priority) ──

describe("ICEBOX isolation settings on the interactive parser", () => {
  it("defaults to privileged ON (source default) and ipv4 (source default)", () => {
    const result = parse([], "pi", { env: {} });
    assert.deepEqual(result.matchlockPrivileged, { privileged: true, source: "default" });
    assert.deepEqual(result.matchlockDnsPriority, { priority: "ipv4", source: "default" });
  });

  it("opts the whole-VM privilege out via the flag and via the env (flag > env)", () => {
    const byFlag = parse(["--matchlock-no-privileged"], "pi", { env: {} });
    assert.deepEqual(byFlag.matchlockPrivileged, { privileged: false, source: "flag" });

    const byEnv = parse([], "pi", { env: { TAMANDUA_MATCHLOCK_NO_PRIVILEGED: "1" } });
    assert.deepEqual(byEnv.matchlockPrivileged, { privileged: false, source: "env" });

    const both = parse(["--matchlock-no-privileged"], "pi", {
      env: { TAMANDUA_MATCHLOCK_NO_PRIVILEGED: "1" },
    });
    assert.deepEqual(both.matchlockPrivileged, { privileged: false, source: "flag" });
  });

  it("accepts each DNS-priority flag and both flags (ipv6 wins, either order)", () => {
    const ipv4 = parse(["--matchlock-prioritize-ipv4-dns-resolution"], "pi", { env: {} });
    assert.deepEqual(ipv4.matchlockDnsPriority, { priority: "ipv4", source: "flag" });

    const ipv6 = parse(["--matchlock-prioritize-ipv6-dns-resolution"], "pi", { env: {} });
    assert.deepEqual(ipv6.matchlockDnsPriority, { priority: "ipv6", source: "flag" });

    const bothV4First = parse(
      ["--matchlock-prioritize-ipv4-dns-resolution", "--matchlock-prioritize-ipv6-dns-resolution"],
      "pi",
      { env: {} },
    );
    assert.deepEqual(bothV4First.matchlockDnsPriority, { priority: "ipv6", source: "flag" });

    const bothV6First = parse(
      ["--matchlock-prioritize-ipv6-dns-resolution", "--matchlock-prioritize-ipv4-dns-resolution"],
      "pi",
      { env: {} },
    );
    assert.deepEqual(bothV6First.matchlockDnsPriority, { priority: "ipv6", source: "flag" });
  });

  it("resolves the DNS env, lets either flag win over it, and ignores malformed env under a flag", () => {
    const envV6 = parse([], "pi", { env: { TAMANDUA_MATCHLOCK_DNS_PRIORITY: "ipv6" } });
    assert.deepEqual(envV6.matchlockDnsPriority, { priority: "ipv6", source: "env" });

    const flagV4 = parse(["--matchlock-prioritize-ipv4-dns-resolution"], "pi", {
      env: { TAMANDUA_MATCHLOCK_DNS_PRIORITY: "ipv6" },
    });
    assert.deepEqual(flagV4.matchlockDnsPriority, { priority: "ipv4", source: "flag" });

    const flagV6 = parse(["--matchlock-prioritize-ipv6-dns-resolution"], "pi", {
      env: { TAMANDUA_MATCHLOCK_DNS_PRIORITY: "garbage" },
    });
    assert.deepEqual(flagV6.matchlockDnsPriority, { priority: "ipv6", source: "flag" });
  });

  it("refuses a malformed CONSULTED TAMANDUA_MATCHLOCK_DNS_PRIORITY with a typed error", () => {
    assert.throws(
      () => parse([], "pi", { env: { TAMANDUA_MATCHLOCK_DNS_PRIORITY: "garbage" } }),
      (err: unknown) =>
        err instanceof MatchlockIsolationSettingError &&
        err.message.includes("TAMANDUA_MATCHLOCK_DNS_PRIORITY"),
    );
  });

  it("accepts both new flags on all four subcommands (both DNS flag orders resolve ipv6)", () => {
    for (const subcommand of INTERACTIVE_SESSION_SUBCOMMANDS) {
      for (const dnsArgs of [
        ["--matchlock-prioritize-ipv4-dns-resolution", "--matchlock-prioritize-ipv6-dns-resolution"],
        ["--matchlock-prioritize-ipv6-dns-resolution", "--matchlock-prioritize-ipv4-dns-resolution"],
      ]) {
        const result = parse(["--matchlock-no-privileged", ...dnsArgs], subcommand, { env: {} });
        assert.deepEqual(result.matchlockPrivileged, { privileged: false, source: "flag" });
        assert.deepEqual(
          result.matchlockDnsPriority,
          { priority: "ipv6", source: "flag" },
          `${subcommand} ${dnsArgs.join(" ")} => ipv6 wins`,
        );
      }
    }
  });

  it("rejects the value-bearing equals form of --matchlock-no-privileged", () => {
    assert.throws(
      () => parse(["--matchlock-no-privileged=1"]),
      (err: unknown) =>
        err instanceof InteractiveSessionArgError &&
        /Unknown option "--matchlock-no-privileged=1"/.test(err.message),
    );
  });

  it("never consumes a following token as a value for the boolean flags", () => {
    // `--matchlock-no-privileged pi` must treat `pi` as an unexpected
    // positional argument, never as the flag's value.
    assert.throws(() => parse(["--matchlock-no-privileged", "pi"]), /Unexpected argument/);
    assert.throws(
      () => parse(["--matchlock-prioritize-ipv6-dns-resolution", "something"]),
      /Unexpected argument/,
    );
  });
});
