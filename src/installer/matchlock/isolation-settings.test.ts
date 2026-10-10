/**
 * ICEBOX (tamandua-5rr.3 E2) — the shared isolation-setting resolvers.
 *
 * Pure module coverage (no child_process, no daemon, no VM), so this file
 * stays in the parallel lane and needs no tests/serial-files.txt entry:
 *   - resolveMatchlockPrivileged / resolveMatchlockDnsPriority precedence
 *     matrices, including the both-DNS-flags ipv6-wins rule (both orders),
 *     the malformed-consulted-env refusal and the winning-flag bypass;
 *   - the persisted-shape guards;
 *   - the committed dsh-adapter-contract text (privileged + DNS behavior).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MATCHLOCK_DNS_PRIORITY_ENV,
  MATCHLOCK_NO_PRIVILEGED_ENV,
  MATCHLOCK_NO_PRIVILEGED_FLAG,
  MATCHLOCK_PRIORITIZE_IPV4_FLAG,
  MATCHLOCK_PRIORITIZE_IPV6_FLAG,
  MatchlockIsolationSettingError,
  isMatchlockDnsPriorityValue,
  isMatchlockIsolationSettingSource,
  resolveMatchlockDnsPriority,
  resolveMatchlockPrivileged,
} from "../../../dist/installer/matchlock/isolation-settings.js";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

describe("ICEBOX privileged resolution (privileged-by-default)", () => {
  it("defaults ON with source default", () => {
    assert.deepEqual(resolveMatchlockPrivileged({}), { privileged: true, source: "default" });
    assert.deepEqual(resolveMatchlockPrivileged({ env: {} }), { privileged: true, source: "default" });
  });

  it("opts out on the flag with source flag", () => {
    assert.deepEqual(resolveMatchlockPrivileged({ noPrivilegedFlag: true }), {
      privileged: false,
      source: "flag",
    });
  });

  it("opts out on the env ONLY for the literal 1 (any other value keeps the default)", () => {
    assert.deepEqual(resolveMatchlockPrivileged({ env: { [MATCHLOCK_NO_PRIVILEGED_ENV]: "1" } }), {
      privileged: false,
      source: "env",
    });
    assert.deepEqual(
      resolveMatchlockPrivileged({ env: { [MATCHLOCK_NO_PRIVILEGED_ENV]: " 1 " } }),
      { privileged: false, source: "env" },
      "surrounding whitespace is trimmed before the literal check",
    );
    for (const value of ["0", "true", "TRUE", "yes", "on", "1x", ""]) {
      assert.deepEqual(
        resolveMatchlockPrivileged({ env: { [MATCHLOCK_NO_PRIVILEGED_ENV]: value } }),
        { privileged: true, source: "default" },
        `${MATCHLOCK_NO_PRIVILEGED_ENV}=${JSON.stringify(value)} must NOT opt out`,
      );
    }
  });

  it("resolves flag > env (an opt-out env under an opt-out flag attributes the flag)", () => {
    assert.deepEqual(
      resolveMatchlockPrivileged({
        noPrivilegedFlag: true,
        env: { [MATCHLOCK_NO_PRIVILEGED_ENV]: "1" },
      }),
      { privileged: false, source: "flag" },
    );
  });

  it("exposes the exact flag/env spellings the CLI help and refusal text name", () => {
    assert.equal(MATCHLOCK_NO_PRIVILEGED_FLAG, "--matchlock-no-privileged");
    assert.equal(MATCHLOCK_NO_PRIVILEGED_ENV, "TAMANDUA_MATCHLOCK_NO_PRIVILEGED");
  });
});

describe("ICEBOX DNS preference resolution (ipv4 default, ipv6 wins both flags)", () => {
  it("defaults to ipv4 with source default", () => {
    assert.deepEqual(resolveMatchlockDnsPriority({}), { priority: "ipv4", source: "default" });
    assert.deepEqual(resolveMatchlockDnsPriority({ env: {} }), {
      priority: "ipv4",
      source: "default",
    });
  });

  it("resolves each flag with source flag", () => {
    assert.deepEqual(resolveMatchlockDnsPriority({ ipv4Flag: true }), {
      priority: "ipv4",
      source: "flag",
    });
    assert.deepEqual(resolveMatchlockDnsPriority({ ipv6Flag: true }), {
      priority: "ipv6",
      source: "flag",
    });
  });

  it("resolves BOTH flags to ipv6 in either argument order (never an error)", () => {
    assert.deepEqual(resolveMatchlockDnsPriority({ ipv4Flag: true, ipv6Flag: true }), {
      priority: "ipv6",
      source: "flag",
    });
    // "Both orders" is a parser-level property; the resolver is order-free,
    // so the same call covers both argv spellings.
    assert.deepEqual(resolveMatchlockDnsPriority({ ipv6Flag: true, ipv4Flag: true }), {
      priority: "ipv6",
      source: "flag",
    });
  });

  it("resolves the env values (trimmed, exact tokens only) with source env", () => {
    assert.deepEqual(
      resolveMatchlockDnsPriority({ env: { [MATCHLOCK_DNS_PRIORITY_ENV]: "ipv4" } }),
      { priority: "ipv4", source: "env" },
    );
    assert.deepEqual(
      resolveMatchlockDnsPriority({ env: { [MATCHLOCK_DNS_PRIORITY_ENV]: "ipv6" } }),
      { priority: "ipv6", source: "env" },
    );
    assert.deepEqual(
      resolveMatchlockDnsPriority({ env: { [MATCHLOCK_DNS_PRIORITY_ENV]: "  ipv6 " } }),
      { priority: "ipv6", source: "env" },
      "surrounding whitespace is trimmed",
    );
  });

  it("a winning flag beats the env (either polarity)", () => {
    assert.deepEqual(
      resolveMatchlockDnsPriority({
        ipv4Flag: true,
        env: { [MATCHLOCK_DNS_PRIORITY_ENV]: "ipv6" },
      }),
      { priority: "ipv4", source: "flag" },
    );
    assert.deepEqual(
      resolveMatchlockDnsPriority({
        ipv6Flag: true,
        env: { [MATCHLOCK_DNS_PRIORITY_ENV]: "ipv4" },
      }),
      { priority: "ipv6", source: "flag" },
    );
  });

  it("refuses a malformed CONSULTED env value with a typed error naming the env var", () => {
    for (const bad of ["garbage", "IPV6", "v6", "ipv4,ipv6", "0", "true"]) {
      assert.throws(
        () => resolveMatchlockDnsPriority({ env: { [MATCHLOCK_DNS_PRIORITY_ENV]: bad } }),
        (err: unknown) =>
          err instanceof MatchlockIsolationSettingError &&
          err.code === "matchlock_isolation_setting_invalid" &&
          err.setting === MATCHLOCK_DNS_PRIORITY_ENV &&
          err.message.includes(MATCHLOCK_DNS_PRIORITY_ENV) &&
          /expected exactly "ipv4" or "ipv6"/.test(err.message),
        `${MATCHLOCK_DNS_PRIORITY_ENV}=${JSON.stringify(bad)} must be refused`,
      );
    }
  });

  it("never fails on a malformed env when a flag wins (env is only validated when consulted)", () => {
    for (const flag of [{ ipv4Flag: true }, { ipv6Flag: true }]) {
      const resolved = resolveMatchlockDnsPriority({
        ...flag,
        env: { [MATCHLOCK_DNS_PRIORITY_ENV]: "nonsense" },
      });
      assert.equal(resolved.source, "flag");
    }
  });

  it("treats an empty/whitespace-only env value as unset (default ipv4)", () => {
    for (const value of ["", "   "]) {
      assert.deepEqual(
        resolveMatchlockDnsPriority({ env: { [MATCHLOCK_DNS_PRIORITY_ENV]: value } }),
        { priority: "ipv4", source: "default" },
      );
    }
  });

  it("exposes the exact flag/env spellings the CLI help names", () => {
    assert.equal(MATCHLOCK_PRIORITIZE_IPV4_FLAG, "--matchlock-prioritize-ipv4-dns-resolution");
    assert.equal(MATCHLOCK_PRIORITIZE_IPV6_FLAG, "--matchlock-prioritize-ipv6-dns-resolution");
    assert.equal(MATCHLOCK_DNS_PRIORITY_ENV, "TAMANDUA_MATCHLOCK_DNS_PRIORITY");
  });
});

describe("ICEBOX persisted-shape guards", () => {
  it("accepts only the three resolution sources", () => {
    for (const ok of ["flag", "env", "default"]) {
      assert.equal(isMatchlockIsolationSettingSource(ok), true);
    }
    for (const bad of ["legacy", "FLAG", "", null, undefined, 1, {}]) {
      assert.equal(isMatchlockIsolationSettingSource(bad), false);
    }
  });

  it("accepts only ipv4/ipv6 priority values", () => {
    assert.equal(isMatchlockDnsPriorityValue("ipv4"), true);
    assert.equal(isMatchlockDnsPriorityValue("ipv6"), true);
    for (const bad of ["IPV4", "v6", "", null, undefined, 4, {}]) {
      assert.equal(isMatchlockDnsPriorityValue(bad), false);
    }
  });
});

describe("ICEBOX dsh-adapter-contract text", () => {
  // The contract prose wraps across comment lines (" * " prefixes), so strip
  // the leading comment markers before matching cross-line phrases.
  const contract = readRepoFile("src/installer/matchlock/dsh-adapter-contract.ts").replace(
    /^\s*\*+\s?/gm,
    "",
  );

  it("states the whole-VM privilege default, the opt-out and the DNS contract", () => {
    assert.match(contract, /ICEBOX \(tamandua-5rr\.3 E2\)/);
    assert.match(contract, /privileged/);
    assert.match(contract, /passwordless in-guest sudo/);
    assert.match(contract, /--matchlock-no-privileged/);
    assert.match(contract, /TAMANDUA_MATCHLOCK_NO_PRIVILEGED=1/);
    assert.match(contract, /freeze\s+on the run policy with their source at submission/);
    assert.match(contract, /network\.dns_priority/);
    assert.match(contract, /--matchlock-prioritize-ipv6-dns-resolution/);
    assert.match(contract, /TAMANDUA_MATCHLOCK_DNS_PRIORITY/);
    assert.match(contract, /resolve the DNS\s+preference from the environment ONLY/);
  });

  it("no longer claims the dsh opt-in does not request privileged Matchlock mode", () => {
    assert.ok(
      !/does not request privileged Matchlock mode/.test(contract),
      "the pre-ICEBOX claim must be gone: the VM is privileged by default",
    );
    assert.match(contract, /never grants a host execution channel/);
  });
});
