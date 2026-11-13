/**
 * NAT-EGRESS US-001 — shared unrestricted-outbound network-mode resolver.
 *
 * Pure module coverage (no child_process, no daemon, no VM), so this file stays
 * in the parallel lane and needs no tests/serial-files.txt entry:
 *   - resolver precedence (flag > env=1 > default) and the malformed-env
 *     refusal, including the winning-flag bypass;
 *   - the RESOLVED-selection conflict matrix (allow-private flag/env,
 *     DNS-priority flag/env) with both sides named verbatim for the flag AND
 *     the env form, and the empty/whitespace non-conflicts;
 *   - the launch-summary segment spellings;
 *   - leaf-purity/constant-drift guards (the mirrored env spellings equal the
 *     canonical ones, and a no-VM module never imports child_process).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MATCHLOCK_NETWORK_OUTBOUND_CONFLICT_CODE,
  MATCHLOCK_NETWORK_OUTBOUND_INVALID_CODE,
  MATCHLOCK_NETWORK_OUTBOUND_RESUME_REFUSED_CODE,
  MATCHLOCK_OUTBOUND_ALLOW_PRIVATE_ENV,
  MATCHLOCK_OUTBOUND_DNS_PRIORITY_ENV,
  MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV,
  MATCHLOCK_UNRESTRICTED_OUTBOUND_FLAG,
  MatchlockNetworkOutboundError,
  assertMatchlockNetworkOutboundCompatible,
  formatMatchlockNetworkOutboundResumeRefusal,
  formatMatchlockNetworkOutboundSelectionLabel,
  formatMatchlockNetworkOutboundSummary,
  hasMatchlockUnrestrictedOutboundFlag,
  resolveMatchlockNetworkOutbound,
  type ResolvedMatchlockNetworkOutbound,
} from "../../../dist/installer/matchlock/network-outbound.js";
import { MATCHLOCK_ALLOW_PRIVATE_ENV } from "../../../dist/installer/matchlock/allow-private.js";
import {
  MATCHLOCK_DNS_PRIORITY_ENV,
  MATCHLOCK_PRIORITIZE_IPV4_FLAG,
  MATCHLOCK_PRIORITIZE_IPV6_FLAG,
} from "../../../dist/installer/matchlock/isolation-settings.js";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const NETWORK_FLAG = MATCHLOCK_UNRESTRICTED_OUTBOUND_FLAG;

/** The two unrestricted selections and the intercepted default. */
const FLAG_SELECTED: ResolvedMatchlockNetworkOutbound = { unrestricted: true, source: "flag" };
const ENV_SELECTED: ResolvedMatchlockNetworkOutbound = { unrestricted: true, source: "env" };
/** The exact unrestricted-side wording for an env-selected mode. */
const ENV_LABEL = `a non-empty ${MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV}=1`;

describe("network-outbound constants", () => {
  it("exports the documented flag and env spellings", () => {
    assert.equal(NETWORK_FLAG, "--matchlock-unrestricted-outbound-networking");
    assert.equal(
      MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV,
      "TAMANDUA_MATCHLOCK_UNRESTRICTED_NETWORKING",
    );
  });

  it("mirrors the canonical allow-private / DNS-priority env names", () => {
    assert.equal(MATCHLOCK_OUTBOUND_ALLOW_PRIVATE_ENV, MATCHLOCK_ALLOW_PRIVATE_ENV);
    assert.equal(MATCHLOCK_OUTBOUND_DNS_PRIORITY_ENV, MATCHLOCK_DNS_PRIORITY_ENV);
    assert.equal(MATCHLOCK_NETWORK_OUTBOUND_INVALID_CODE, "matchlock_network_outbound_invalid");
    assert.equal(MATCHLOCK_NETWORK_OUTBOUND_CONFLICT_CODE, "matchlock_network_outbound_conflict");
  });

  it("stays a leaf: no child_process and no runtime matchlock imports", () => {
    const source = readFileSync(
      resolve(repoRoot, "src/installer/matchlock/network-outbound.ts"),
      "utf-8",
    );
    assert.ok(!/from\s+["']node:child_process["']/.test(source));
    const importSpecifiers = [...source.matchAll(/^import\s+(type\s+)?[^;]+from\s+["']([^"']+)["']/gm)];
    for (const [, typeOnly, specifier] of importSpecifiers) {
      assert.ok(
        typeOnly !== undefined,
        `network-outbound.ts must only have type-only imports; found runtime import of ${specifier}`,
      );
    }
  });
});

describe("resolveMatchlockNetworkOutbound precedence", () => {
  it("defaults to intercepted with source default when nothing is set", () => {
    assert.deepEqual(resolveMatchlockNetworkOutbound(), {
      unrestricted: false,
      source: "default",
    });
    assert.deepEqual(resolveMatchlockNetworkOutbound({ env: {} }), {
      unrestricted: false,
      source: "default",
    });
  });

  it("selects unrestricted/flag for the flag only", () => {
    assert.deepEqual(resolveMatchlockNetworkOutbound({ flag: true }), {
      unrestricted: true,
      source: "flag",
    });
  });

  it("selects unrestricted/env for the literal env value 1 (trimmed)", () => {
    for (const value of ["1", " 1", "1 ", "  1  "]) {
      assert.deepEqual(
        resolveMatchlockNetworkOutbound({
          env: { [MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV]: value },
        }),
        { unrestricted: true, source: "env" },
        `env value ${JSON.stringify(value)}`,
      );
    }
  });

  it("treats absent, empty and whitespace-only env as default", () => {
    for (const value of [undefined, "", " ", "\t\n"]) {
      assert.deepEqual(
        resolveMatchlockNetworkOutbound({
          env: value === undefined ? {} : { [MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV]: value },
        }),
        { unrestricted: false, source: "default" },
        `env value ${JSON.stringify(value)}`,
      );
    }
  });

  it("refuses malformed env values with a typed error naming the var and accepted value", () => {
    for (const value of ["true", "yes", "0", "on", "TRUE"]) {
      assert.throws(
        () =>
          resolveMatchlockNetworkOutbound({
            env: { [MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV]: value },
          }),
        (err: unknown) => {
          assert.ok(err instanceof MatchlockNetworkOutboundError);
          assert.equal(err.code, MATCHLOCK_NETWORK_OUTBOUND_INVALID_CODE);
          assert.match(err.message, new RegExp(MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV));
          assert.match(err.message, /"1"/);
          return true;
        },
        `env value ${JSON.stringify(value)}`,
      );
    }
  });

  it("lets a winning flag bypass a malformed env value", () => {
    assert.deepEqual(
      resolveMatchlockNetworkOutbound({
        flag: true,
        env: { [MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV]: "definitely-not-valid" },
      }),
      { unrestricted: true, source: "flag" },
    );
  });
});

describe("assertMatchlockNetworkOutboundCompatible conflict matrix", () => {
  const refusal = (fn: () => void, snippets: string[]): void => {
    assert.throws(fn, (err: unknown) => {
      assert.ok(err instanceof MatchlockNetworkOutboundError);
      assert.equal(err.code, MATCHLOCK_NETWORK_OUTBOUND_CONFLICT_CODE);
      for (const snippet of snippets) {
        assert.ok(
          err.message.includes(snippet),
          `refusal must name ${JSON.stringify(snippet)}: ${err.message}`,
        );
      }
      return true;
    });
  };

  it("does nothing when the RESOLVED selection is intercepted, even with every conflict input present", () => {
    assert.doesNotThrow(() =>
      assertMatchlockNetworkOutboundCompatible({
        resolved: { unrestricted: false, source: "default" },
        allowPrivateEntries: ["192.168.107.74"],
        allowPrivateEnvRaw: "10.0.0.0/8",
        dnsPriorityFlags: [MATCHLOCK_PRIORITIZE_IPV6_FLAG],
        dnsPriorityEnvRaw: "ipv6",
      }),
    );
    assert.doesNotThrow(() =>
      assertMatchlockNetworkOutboundCompatible({
        allowPrivateEntries: ["192.168.107.74"],
        allowPrivateEnvRaw: "10.0.0.0/8",
        dnsPriorityFlags: [MATCHLOCK_PRIORITIZE_IPV4_FLAG],
        dnsPriorityEnvRaw: "ipv4",
      }),
    );
  });

  it("refuses flag + allow-private entries naming both sides", () => {
    refusal(
      () =>
        assertMatchlockNetworkOutboundCompatible({
          resolved: FLAG_SELECTED,
          allowPrivateEntries: ["192.168.107.74", "example.com:8443"],
        }),
      [NETWORK_FLAG, "--matchlock-allow-private"],
    );
  });

  it("refuses flag + non-empty allow-private env naming both sides", () => {
    refusal(
      () =>
        assertMatchlockNetworkOutboundCompatible({
          resolved: FLAG_SELECTED,
          allowPrivateEnvRaw: "192.168.107.74,example.com:8443",
        }),
      [NETWORK_FLAG, MATCHLOCK_ALLOW_PRIVATE_ENV],
    );
  });

  it("names the flag (not the env) when flag entries are the effective list", () => {
    refusal(
      () =>
        assertMatchlockNetworkOutboundCompatible({
          resolved: FLAG_SELECTED,
          allowPrivateEntries: ["example.com"],
          allowPrivateEnvRaw: "10.0.0.0/8",
        }),
      [NETWORK_FLAG, "--matchlock-allow-private"],
    );
  });

  it("refuses flag + each DNS-priority flag, naming both sides", () => {
    for (const dnsFlag of [MATCHLOCK_PRIORITIZE_IPV4_FLAG, MATCHLOCK_PRIORITIZE_IPV6_FLAG]) {
      refusal(
        () =>
          assertMatchlockNetworkOutboundCompatible({
            resolved: FLAG_SELECTED,
            dnsPriorityFlags: [dnsFlag],
          }),
        [NETWORK_FLAG, dnsFlag],
      );
    }
  });

  it("refuses flag + non-empty DNS-priority env naming both sides", () => {
    refusal(
      () =>
        assertMatchlockNetworkOutboundCompatible({
          resolved: FLAG_SELECTED,
          dnsPriorityEnvRaw: "ipv6",
        }),
      [NETWORK_FLAG, MATCHLOCK_DNS_PRIORITY_ENV],
    );
  });

  // R4/R6/R7: the matrix is keyed on the RESOLVED selection, so the ENV form is
  // refused identically (it is NOT exempt and never silently wins).
  it("refuses env-selected + allow-private entries naming both sides", () => {
    refusal(
      () =>
        assertMatchlockNetworkOutboundCompatible({
          resolved: ENV_SELECTED,
          allowPrivateEntries: ["192.168.107.74"],
        }),
      [ENV_LABEL, "--matchlock-allow-private"],
    );
  });

  it("refuses env-selected + non-empty allow-private env naming both sides", () => {
    refusal(
      () =>
        assertMatchlockNetworkOutboundCompatible({
          resolved: ENV_SELECTED,
          allowPrivateEnvRaw: "10.0.0.0/8",
        }),
      [ENV_LABEL, MATCHLOCK_ALLOW_PRIVATE_ENV],
    );
  });

  it("refuses env-selected + each DNS-priority flag naming both sides", () => {
    for (const dnsFlag of [MATCHLOCK_PRIORITIZE_IPV4_FLAG, MATCHLOCK_PRIORITIZE_IPV6_FLAG]) {
      refusal(
        () =>
          assertMatchlockNetworkOutboundCompatible({
            resolved: ENV_SELECTED,
            dnsPriorityFlags: [dnsFlag],
          }),
        [ENV_LABEL, dnsFlag],
      );
    }
  });

  it("refuses env-selected + non-empty DNS-priority env naming both sides", () => {
    refusal(
      () =>
        assertMatchlockNetworkOutboundCompatible({
          resolved: ENV_SELECTED,
          dnsPriorityEnvRaw: "ipv6",
        }),
      [ENV_LABEL, MATCHLOCK_DNS_PRIORITY_ENV],
    );
  });

  it("does NOT refuse empty or whitespace allow-private/DNS values in either source", () => {
    for (const resolved of [FLAG_SELECTED, ENV_SELECTED]) {
      for (const raw of [undefined, "", " ", "\t\n"]) {
        assert.doesNotThrow(() =>
          assertMatchlockNetworkOutboundCompatible({
            resolved,
            allowPrivateEntries: [],
            allowPrivateEnvRaw: raw,
            dnsPriorityFlags: [],
            dnsPriorityEnvRaw: raw,
          }),
        );
      }
    }
  });

  it("does NOT treat blank entries as effective", () => {
    assert.doesNotThrow(() =>
      assertMatchlockNetworkOutboundCompatible({
        resolved: FLAG_SELECTED,
        allowPrivateEntries: ["", "   "],
        allowPrivateEnvRaw: undefined,
      }),
    );
  });

  it("performs no VM/create work (pure function, returns undefined)", () => {
    assert.equal(
      assertMatchlockNetworkOutboundCompatible({ resolved: FLAG_SELECTED }),
      undefined,
    );
  });
});

describe("formatMatchlockNetworkOutboundSelectionLabel", () => {
  it("renders the truthful flag/env wording and keeps code drift out", () => {
    assert.equal(formatMatchlockNetworkOutboundSelectionLabel(FLAG_SELECTED), NETWORK_FLAG);
    assert.equal(formatMatchlockNetworkOutboundSelectionLabel(ENV_SELECTED), ENV_LABEL);
    assert.equal(
      formatMatchlockNetworkOutboundSelectionLabel({ unrestricted: true, source: "default" }),
      "unrestricted outbound networking",
    );
    assert.equal(formatMatchlockNetworkOutboundSelectionLabel(undefined), "unrestricted outbound networking");
  });
});

describe("formatMatchlockNetworkOutboundSummary", () => {
  it("renders intercepted(default) for absent/default/false", () => {
    assert.equal(
      formatMatchlockNetworkOutboundSummary(),
      " network=intercepted(default)",
    );
    assert.equal(
      formatMatchlockNetworkOutboundSummary({ unrestricted: false, source: "default" }),
      " network=intercepted(default)",
    );
  });

  it("renders the flag and env selections", () => {
    assert.equal(
      formatMatchlockNetworkOutboundSummary({ unrestricted: true, source: "flag" }),
      " network=unrestricted-outbound(flag)",
    );
    assert.equal(
      formatMatchlockNetworkOutboundSummary({ unrestricted: true, source: "env" }),
      " network=unrestricted-outbound(env)",
    );
  });

  it("renders the defensive default-source unrestricted spelling", () => {
    assert.equal(
      formatMatchlockNetworkOutboundSummary({ unrestricted: true, source: "default" }),
      " network=unrestricted-outbound(default)",
    );
  });
});

describe("resume surfaces", () => {
  it("detects the flag in both spellings and ignores unrelated arguments", () => {
    assert.equal(hasMatchlockUnrestrictedOutboundFlag(["--matchlock-unrestricted-outbound-networking"]), true);
    assert.equal(hasMatchlockUnrestrictedOutboundFlag(["run-abc", `${NETWORK_FLAG}=1`]), true);
    assert.equal(hasMatchlockUnrestrictedOutboundFlag(["run-abc", "--matchlock"]), false);
    assert.equal(hasMatchlockUnrestrictedOutboundFlag([]), false);
  });

  it("states the fixed-at-admission rule and the remedy, naming the flag and the typed code", () => {
    const message = formatMatchlockNetworkOutboundResumeRefusal();
    assert.match(message, new RegExp(NETWORK_FLAG));
    assert.match(message, /network mode is fixed at admission/);
    assert.match(message, /Create a new run/);
    assert.equal(MATCHLOCK_NETWORK_OUTBOUND_RESUME_REFUSED_CODE, "matchlock_network_outbound_fixed_at_admission");
    const error = new MatchlockNetworkOutboundError(message, MATCHLOCK_NETWORK_OUTBOUND_RESUME_REFUSED_CODE);
    assert.equal(error.code, MATCHLOCK_NETWORK_OUTBOUND_RESUME_REFUSED_CODE);
  });
});
