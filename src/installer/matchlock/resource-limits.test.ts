import { describe, it } from "node:test";
import assert from "node:assert";
import {
  MATCHLOCK_MAX_CPUS,
  MATCHLOCK_DEFAULT_CPUS_CAP,
  MATCHLOCK_DEFAULT_MEMORY_CAP_MB,
  MATCHLOCK_DEFAULT_DISK_MB,
  MATCHLOCK_DEFAULT_MEMORY_HOST_FRACTION,
  MATCHLOCK_MAX_MEMORY_HOST_FRACTION,
  MATCHLOCK_DEFAULT_SWAP_MB,
  MATCHLOCK_MAX_SWAP_MB,
  MATCHLOCK_CPUS_ENV,
  MATCHLOCK_MEMORY_ENV,
  MATCHLOCK_DISK_ENV,
  MATCHLOCK_SWAP_ENV,
  MatchlockResourceLimitError,
  defaultMatchlockResourceHostProbe,
  parseSwapMB,
  resolveMatchlockResourceLimits,
  formatMatchlockResourceSummary,
  type MatchlockResourceHostProbe,
} from "../../../dist/installer/matchlock/resource-limits.js";

/** Fake host probe helper. */
function probe(cpus: number, memoryMB: number): MatchlockResourceHostProbe {
  return { onlineCpus: () => cpus, totalMemoryMB: () => memoryMB };
}

describe("matchlock resource limits", () => {
  it("exports the standing caps and env names", () => {
    assert.equal(MATCHLOCK_MAX_CPUS, 16);
    assert.equal(MATCHLOCK_DEFAULT_CPUS_CAP, 8);
    assert.equal(MATCHLOCK_DEFAULT_MEMORY_CAP_MB, 16384);
    assert.equal(MATCHLOCK_DEFAULT_DISK_MB, 20480);
    assert.equal(MATCHLOCK_DEFAULT_MEMORY_HOST_FRACTION, 0.5);
    assert.equal(MATCHLOCK_MAX_MEMORY_HOST_FRACTION, 0.75);
    assert.equal(MATCHLOCK_DEFAULT_SWAP_MB, 8192);
    assert.equal(MATCHLOCK_MAX_SWAP_MB, 65536);
    assert.equal(MATCHLOCK_CPUS_ENV, "TAMANDUA_MATCHLOCK_CPUS");
    assert.equal(MATCHLOCK_MEMORY_ENV, "TAMANDUA_MATCHLOCK_MEMORY_MB");
    assert.equal(MATCHLOCK_DISK_ENV, "TAMANDUA_MATCHLOCK_DISK_MB");
    assert.equal(MATCHLOCK_SWAP_ENV, "TAMANDUA_MATCHLOCK_SWAP_MB");
  });

  it("default host probe reports positive host capacity", () => {
    assert.ok(defaultMatchlockResourceHostProbe.onlineCpus() >= 1);
    assert.ok(defaultMatchlockResourceHostProbe.totalMemoryMB() >= 1);
  });

  it("resolves host-derived defaults for a 4-CPU / 16-GB host", () => {
    const resolved = resolveMatchlockResourceLimits({ hostProbe: probe(4, 16384) });
    assert.deepEqual(
      { cpus: resolved.cpus, memoryMB: resolved.memoryMB, diskSizeMB: resolved.diskSizeMB },
      { cpus: 4, memoryMB: 8192, diskSizeMB: 20480 },
    );
    assert.deepEqual(resolved.sources, {
      cpus: "default",
      memoryMB: "default",
      diskSizeMB: "default",
      swapMB: "default",
    });
  });

  it("resolves host-derived defaults for a small 2-CPU / 4-GB host", () => {
    const resolved = resolveMatchlockResourceLimits({ hostProbe: probe(2, 4096) });
    assert.deepEqual(
      { cpus: resolved.cpus, memoryMB: resolved.memoryMB, diskSizeMB: resolved.diskSizeMB },
      { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 },
    );
  });

  it("clamps explicit cpus to the 16 cap and to the host CPU count", () => {
    assert.equal(resolveMatchlockResourceLimits({ cpus: 64, hostProbe: probe(96, 262144) }).cpus, 16);
    assert.equal(resolveMatchlockResourceLimits({ cpus: 8, hostProbe: probe(4, 16384) }).cpus, 4);
    assert.equal(resolveMatchlockResourceLimits({ cpus: 32, hostProbe: probe(96, 262144) }).cpus, 16);
  });

  it("clamps explicit memory to 75% of host and converts '<n>g'", () => {
    const resolved = resolveMatchlockResourceLimits({ memoryMB: "16g", hostProbe: probe(8, 16384) });
    assert.equal(resolved.memoryMB, 12288);
    assert.equal(resolved.sources.memoryMB, "flag");
    assert.equal(resolveMatchlockResourceLimits({ memoryMB: "16G", hostProbe: probe(8, 262144) }).memoryMB, 16384);
    assert.equal(resolveMatchlockResourceLimits({ memoryMB: "4096", hostProbe: probe(8, 262144) }).memoryMB, 4096);
  });

  it("resolves an explicit '40g' disk without an upper cap", () => {
    const resolved = resolveMatchlockResourceLimits({ diskSizeMB: "40g", hostProbe: probe(8, 16384) });
    assert.equal(resolved.diskSizeMB, 40960);
    assert.equal(resolved.sources.diskSizeMB, "flag");
    assert.equal(resolveMatchlockResourceLimits({ diskSizeMB: 1000000, hostProbe: probe(8, 16384) }).diskSizeMB, 1000000);
  });

  it("throws a typed, actionable error for invalid values", () => {
    const bad: Array<Partial<Record<"cpus" | "memoryMB" | "diskSizeMB", string>>> = [
      { cpus: "abc" },
      { cpus: "0" },
      { cpus: "-1" },
      { cpus: "2.5" },
      { cpus: "2g" },
      { memoryMB: "abc" },
      { memoryMB: "0" },
      { memoryMB: "-5" },
      { memoryMB: "1.5g" },
      { memoryMB: "0g" },
      { diskSizeMB: "abc" },
      { diskSizeMB: "0" },
      { diskSizeMB: "-1" },
      { diskSizeMB: "1.5" },
    ];
    for (const fields of bad) {
      assert.throws(
        () => resolveMatchlockResourceLimits({ ...fields, hostProbe: probe(8, 16384) }),
        (err: unknown) =>
          err instanceof MatchlockResourceLimitError &&
          err.code === "matchlock_resource_limit_invalid" &&
          err.message.length > 0,
        `expected ${JSON.stringify(fields)} to throw`,
      );
    }
  });

  it("rejects a degenerate host probe", () => {
    assert.throws(
      () => resolveMatchlockResourceLimits({ hostProbe: probe(0, 16384) }),
      MatchlockResourceLimitError,
    );
    assert.throws(
      () => resolveMatchlockResourceLimits({ hostProbe: probe(4, 0) }),
      MatchlockResourceLimitError,
    );
  });

  it("supplies values from env when flags are absent", () => {
    const resolved = resolveMatchlockResourceLimits({
      env: {
        [MATCHLOCK_CPUS_ENV]: "6",
        [MATCHLOCK_MEMORY_ENV]: "8192",
        [MATCHLOCK_DISK_ENV]: "30g",
      },
      hostProbe: probe(96, 262144),
    });
    assert.deepEqual(
      { cpus: resolved.cpus, memoryMB: resolved.memoryMB, diskSizeMB: resolved.diskSizeMB },
      { cpus: 6, memoryMB: 8192, diskSizeMB: 30720 },
    );
    assert.deepEqual(resolved.sources, {
      cpus: "env",
      memoryMB: "env",
      diskSizeMB: "env",
      swapMB: "default",
    });
  });

  it("lets explicit flags win over env", () => {
    const resolved = resolveMatchlockResourceLimits({
      cpus: 8,
      memoryMB: "4g",
      diskSizeMB: "10g",
      env: {
        [MATCHLOCK_CPUS_ENV]: "6",
        [MATCHLOCK_MEMORY_ENV]: "8192",
        [MATCHLOCK_DISK_ENV]: "30g",
      },
      hostProbe: probe(96, 262144),
    });
    assert.deepEqual(
      { cpus: resolved.cpus, memoryMB: resolved.memoryMB, diskSizeMB: resolved.diskSizeMB },
      { cpus: 8, memoryMB: 4096, diskSizeMB: 10240 },
    );
    assert.deepEqual(resolved.sources, {
      cpus: "flag",
      memoryMB: "flag",
      diskSizeMB: "flag",
      swapMB: "default",
    });
  });

  it("clamps env values by the same caps", () => {
    const resolved = resolveMatchlockResourceLimits({
      env: {
        [MATCHLOCK_CPUS_ENV]: "64",
        [MATCHLOCK_MEMORY_ENV]: "32g",
        [MATCHLOCK_DISK_ENV]: "20480",
      },
      hostProbe: probe(4, 4096),
    });
    assert.equal(resolved.cpus, 4);
    assert.equal(resolved.memoryMB, 3072);
    assert.equal(resolved.diskSizeMB, 20480);
  });

  it("treats absent or blank env values as unset", () => {
    const resolved = resolveMatchlockResourceLimits({
      env: { [MATCHLOCK_CPUS_ENV]: "   ", [MATCHLOCK_MEMORY_ENV]: "", [MATCHLOCK_DISK_ENV]: undefined },
      hostProbe: probe(2, 4096),
    });
    assert.deepEqual(
      { cpus: resolved.cpus, memoryMB: resolved.memoryMB, diskSizeMB: resolved.diskSizeMB },
      { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 },
    );
    assert.deepEqual(resolved.sources, {
      cpus: "default",
      memoryMB: "default",
      diskSizeMB: "default",
      swapMB: "default",
    });
  });

  // MTLK-SWAP (US-002): swap resolver — default, precedence, off switch,
  // matchlock cap and the typed parse errors.
  it("resolves the default 8192 MB swap with source 'default'", () => {
    const resolved = resolveMatchlockResourceLimits({ hostProbe: probe(8, 16384) });
    assert.equal(resolved.swapMB, MATCHLOCK_DEFAULT_SWAP_MB);
    assert.equal(resolved.swapMB, 8192);
    assert.equal(resolved.sources.swapMB, "default");
  });

  it("resolves an explicit swap size for MB and '<n>g' forms", () => {
    assert.equal(resolveMatchlockResourceLimits({ swapMB: "32g", hostProbe: probe(8, 16384) }).swapMB, 32768);
    assert.equal(resolveMatchlockResourceLimits({ swapMB: "32G", hostProbe: probe(8, 16384) }).swapMB, 32768);
    const plain = resolveMatchlockResourceLimits({ swapMB: "16384", hostProbe: probe(8, 16384) });
    assert.equal(plain.swapMB, 16384);
    assert.equal(plain.sources.swapMB, "flag");
    assert.equal(resolveMatchlockResourceLimits({ swapMB: 16384, hostProbe: probe(8, 16384) }).swapMB, 16384);
  });

  it("lets the swap flag win over env and env win over the default", () => {
    const flagWins = resolveMatchlockResourceLimits({
      swapMB: "4096",
      env: { [MATCHLOCK_SWAP_ENV]: "16384" },
      hostProbe: probe(8, 16384),
    });
    assert.equal(flagWins.swapMB, 4096);
    assert.equal(flagWins.sources.swapMB, "flag");

    const envWins = resolveMatchlockResourceLimits({
      env: { [MATCHLOCK_SWAP_ENV]: "16384" },
      hostProbe: probe(8, 16384),
    });
    assert.equal(envWins.swapMB, 16384);
    assert.equal(envWins.sources.swapMB, "env");
  });

  it("accepts the 65536 MB maximum and rejects 65537 naming the matchlock cap", () => {
    assert.equal(resolveMatchlockResourceLimits({ swapMB: "65536", hostProbe: probe(8, 16384) }).swapMB, 65536);
    assert.equal(resolveMatchlockResourceLimits({ swapMB: "64g", hostProbe: probe(8, 16384) }).swapMB, 65536);
    assert.throws(
      () => resolveMatchlockResourceLimits({ swapMB: "65537", hostProbe: probe(8, 16384) }),
      (err: unknown) =>
        err instanceof MatchlockResourceLimitError &&
        err.code === "matchlock_resource_limit_invalid" &&
        /65536/.test(err.message),
      "65537 must name the 65536 MB matchlock cap",
    );
  });

  it("rejects --matchlock-swap 0 with a pointer to --matchlock-no-swap", () => {
    assert.throws(
      () => resolveMatchlockResourceLimits({ swapMB: "0", hostProbe: probe(8, 16384) }),
      (err: unknown) =>
        err instanceof MatchlockResourceLimitError && /--matchlock-no-swap/.test(err.message),
      "flag 0 must point at --matchlock-no-swap",
    );
  });

  it("accepts env 'off' in any case as swap-off", () => {
    for (const value of ["off", "OFF", "Off", " off "]) {
      const resolved = resolveMatchlockResourceLimits({
        env: { [MATCHLOCK_SWAP_ENV]: value },
        hostProbe: probe(8, 16384),
      });
      assert.equal(resolved.swapMB, 0, `env ${JSON.stringify(value)} must yield swap off`);
      assert.equal(resolved.sources.swapMB, "env");
    }
  });

  it("rejects env 0 pointing at TAMANDUA_MATCHLOCK_SWAP_MB=off", () => {
    assert.throws(
      () => resolveMatchlockResourceLimits({ env: { [MATCHLOCK_SWAP_ENV]: "0" }, hostProbe: probe(8, 16384) }),
      (err: unknown) =>
        err instanceof MatchlockResourceLimitError &&
        /TAMANDUA_MATCHLOCK_SWAP_MB=off/.test(err.message) &&
        !/--matchlock-no-swap/.test(err.message),
      "env 0 must point at the env off spelling",
    );
  });

  it("treats a blank swap env value as unset (falls back to the default)", () => {
    const resolved = resolveMatchlockResourceLimits({
      env: { [MATCHLOCK_SWAP_ENV]: "   " },
      hostProbe: probe(8, 16384),
    });
    assert.equal(resolved.swapMB, MATCHLOCK_DEFAULT_SWAP_MB);
    assert.equal(resolved.sources.swapMB, "default");
  });

  it("lets --matchlock-no-swap beat a flag or env size and yields 0", () => {
    const overEnv = resolveMatchlockResourceLimits({
      noSwap: true,
      env: { [MATCHLOCK_SWAP_ENV]: "16384" },
      hostProbe: probe(8, 16384),
    });
    assert.equal(overEnv.swapMB, 0);
    assert.equal(overEnv.sources.swapMB, "flag");

    const overFlag = resolveMatchlockResourceLimits({
      noSwap: true,
      swapMB: "16384",
      hostProbe: probe(8, 16384),
    });
    assert.equal(overFlag.swapMB, 0);
    assert.equal(overFlag.sources.swapMB, "flag");
  });

  it("rejects negative, fractional and non-numeric swap values (flag and env)", () => {
    for (const bad of ["-1", "1.5", "1.5g", "abc", "0g", "00"]) {
      assert.throws(
        () => resolveMatchlockResourceLimits({ swapMB: bad, hostProbe: probe(8, 16384) }),
        MatchlockResourceLimitError,
        `flag swap ${JSON.stringify(bad)} must throw`,
      );
      assert.throws(
        () => resolveMatchlockResourceLimits({ env: { [MATCHLOCK_SWAP_ENV]: bad }, hostProbe: probe(8, 16384) }),
        MatchlockResourceLimitError,
        `env swap ${JSON.stringify(bad)} must throw`,
      );
    }
  });

  it("exports parseSwapMB enforcing the same grammar directly", () => {
    assert.equal(parseSwapMB("32g", "--matchlock-swap"), 32768);
    assert.equal(parseSwapMB(16384, "--matchlock-swap"), 16384);
    assert.equal(parseSwapMB("65536", "--matchlock-swap"), 65536);
    assert.throws(() => parseSwapMB("65537", "--matchlock-swap"), MatchlockResourceLimitError);
    assert.throws(
      () => parseSwapMB("0", MATCHLOCK_SWAP_ENV),
      (err: unknown) =>
        err instanceof MatchlockResourceLimitError && /TAMANDUA_MATCHLOCK_SWAP_MB=off/.test(err.message),
    );
  });

  it("formats the canonical launch/status summary", () => {
    assert.equal(
      formatMatchlockResourceSummary("img", {
        cpus: 8,
        memoryMB: 16384,
        diskSizeMB: 20480,
        swapMB: 8192,
      }),
      "matchlock: img cpus=8 memory=16384MB disk=20480MB swap=8192MB",
    );
  });

  // MTLK-ISO-SLICE2 US-011: the shared grammar carries the standard-image
  // marker (only for standard provenance) and renders swap=off for 0.
  it("renders the (standard image) marker only for standard provenance", () => {
    assert.equal(
      formatMatchlockResourceSummary("igorhvr/tamandua", {
        imageSource: "standard",
        cpus: 8,
        memoryMB: 16384,
        diskSizeMB: 20480,
        swapMB: 8192,
      }),
      "matchlock: igorhvr/tamandua (standard image) cpus=8 memory=16384MB disk=20480MB swap=8192MB",
    );
    assert.equal(
      formatMatchlockResourceSummary("vic/matchlock-base:latest", {
        imageSource: "explicit",
        cpus: 8,
        memoryMB: 16384,
        diskSizeMB: 20480,
        swapMB: 8192,
      }),
      "matchlock: vic/matchlock-base:latest cpus=8 memory=16384MB disk=20480MB swap=8192MB",
    );
  });

  it("renders swap=off for a zero swap size and keeps positive sizes in MB", () => {
    assert.equal(
      formatMatchlockResourceSummary("img", {
        cpus: 4,
        memoryMB: 4096,
        diskSizeMB: 20480,
        swapMB: 0,
      }),
      "matchlock: img cpus=4 memory=4096MB disk=20480MB swap=off",
    );
    assert.equal(
      formatMatchlockResourceSummary("img", {
        cpus: 4,
        memoryMB: 4096,
        diskSizeMB: 20480,
        swapMB: 65536,
      }),
      "matchlock: img cpus=4 memory=4096MB disk=20480MB swap=65536MB",
    );
  });

  // MTLK-ISO-SLICE2 US-011: the combined grammar places swap BEFORE
  // allow-private, so a run with both keeps the documented field order.
  it("orders swap before allow-private on the combined line", () => {
    assert.equal(
      formatMatchlockResourceSummary(
        "igorhvr/tamandua",
        {
          imageSource: "standard",
          cpus: 4,
          memoryMB: 4096,
          diskSizeMB: 20480,
          swapMB: 0,
        },
        ["box.internal"],
      ),
      "matchlock: igorhvr/tamandua (standard image) cpus=4 memory=4096MB disk=20480MB swap=off allow-private=box.internal",
    );
  });

  // MTLK-ALLOW-PRIVATE (US-006): the allow-private segment is appended ONLY
  // when the resolved list is non-empty, so absent/empty stays byte-identical.
  it("appends allow-private=<comma-separated entries> when the list is non-empty", () => {
    assert.equal(
      formatMatchlockResourceSummary(
        "img",
        { cpus: 8, memoryMB: 16384, diskSizeMB: 20480, swapMB: 8192 },
        ["192.168.107.74:8888", "box.internal", "[2001:db8::1]:443"],
      ),
      "matchlock: img cpus=8 memory=16384MB disk=20480MB swap=8192MB allow-private=192.168.107.74:8888,box.internal,[2001:db8::1]:443",
    );
  });

  it("appends no allow-private segment for an absent or empty list", () => {
    const base = "matchlock: img cpus=8 memory=16384MB disk=20480MB swap=8192MB";
    const limits = { cpus: 8, memoryMB: 16384, diskSizeMB: 20480, swapMB: 8192 };
    assert.equal(
      formatMatchlockResourceSummary("img", limits),
      base,
      "absent list must append nothing",
    );
    assert.equal(
      formatMatchlockResourceSummary("img", limits, []),
      base,
      "empty list must append nothing",
    );
  });
});
