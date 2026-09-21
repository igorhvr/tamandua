import { describe, it } from "node:test";
import assert from "node:assert";
import {
  MATCHLOCK_MAX_CPUS,
  MATCHLOCK_DEFAULT_CPUS_CAP,
  MATCHLOCK_DEFAULT_MEMORY_CAP_MB,
  MATCHLOCK_DEFAULT_DISK_MB,
  MATCHLOCK_DEFAULT_MEMORY_HOST_FRACTION,
  MATCHLOCK_MAX_MEMORY_HOST_FRACTION,
  MATCHLOCK_CPUS_ENV,
  MATCHLOCK_MEMORY_ENV,
  MATCHLOCK_DISK_ENV,
  MatchlockResourceLimitError,
  defaultMatchlockResourceHostProbe,
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
    assert.equal(MATCHLOCK_CPUS_ENV, "TAMANDUA_MATCHLOCK_CPUS");
    assert.equal(MATCHLOCK_MEMORY_ENV, "TAMANDUA_MATCHLOCK_MEMORY_MB");
    assert.equal(MATCHLOCK_DISK_ENV, "TAMANDUA_MATCHLOCK_DISK_MB");
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
    });
  });

  it("formats the canonical launch/status summary", () => {
    assert.equal(
      formatMatchlockResourceSummary("img", { cpus: 8, memoryMB: 16384, diskSizeMB: 20480 }),
      "matchlock: img cpus=8 memory=16384MB disk=20480MB",
    );
  });
});
