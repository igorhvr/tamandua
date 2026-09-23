import { describe, it } from "node:test";
import assert from "node:assert";
import {
  MATCHLOCK_ALLOW_PRIVATE_ENV,
  MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRIES,
  MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRY_LENGTH,
  MATCHLOCK_ALLOW_PRIVATE_GRAMMAR,
  isAllowPrivateEntryShape,
  validateAllowPrivateEntry,
  normalizeAllowPrivateEntries,
  parseAllowPrivateEnv,
  assertAllowPrivateEntries,
} from "../../../dist/installer/matchlock/allow-private.js";

describe("matchlock allow-private entry shape validator", () => {
  it("exports the env name, bounds and grammar", () => {
    assert.equal(MATCHLOCK_ALLOW_PRIVATE_ENV, "TAMANDUA_MATCHLOCK_ALLOW_PRIVATE");
    assert.equal(MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRIES, 64);
    assert.ok(MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRY_LENGTH >= 256);
    assert.match(MATCHLOCK_ALLOW_PRIVATE_GRAMMAR, /:port/);
  });
});

describe("accepted entry shapes", () => {
  const accepted = [
    "example.com",
    "example.com:8443",
    "host-name.local:65535",
    "192.168.107.74",
    "192.168.107.74:8888",
    "127.0.0.1:1",
    "0.0.0.0:1234",
    "::1",
    "fe80::1",
    "200:1234::1",
    "[::1]:443",
    "[200:1234::1]:8443",
    "10.0.0.0/8",
    "192.168.0.0/16",
    "10.0.0.0/8:8443",
    "fd00::/8",
    "200::/7",
    "fd00::/8:37811",
    "[fd00::/8]:37811",
    // Host-name-shaped tokens (the grammar is deliberately permissive: a token
    // of [A-Za-z0-9._-]+ with an alphanumeric is a name, so a mistyped dotted
    // quad is still shape-valid and simply never matches after resolution).
    "01.2.3.4",
    "300.1.1.1",
    "1.2.3.4.5",
  ];

  for (const entry of accepted) {
    it(`accepts ${JSON.stringify(entry)}`, () => {
      const result = validateAllowPrivateEntry(entry);
      assert.deepEqual(result, { ok: true });
      assert.equal(isAllowPrivateEntryShape(entry), true);
    });
  }
});

describe("rejected entry shapes", () => {
  const rejected: Array<[string, RegExp]> = [
    ["", /non-empty/],
    ["   ", /whitespace|non-empty/],
    ["host name", /whitespace/],
    ["host\tname", /control|whitespace/],
    ["host\u0000name", /control/],
    ["host:0", /port must be an integer in the range 1-65535/],
    ["host:70000", /port must be an integer in the range 1-65535/],
    ["host:99999", /port must be an integer in the range 1-65535/],
    ["host:abc", /port must be an integer in the range 1-65535/],
    ["host:", /port must be an integer in the range 1-65535/],
    ["host:80:90", /must be a host name/],
    [":80", /must be a host name/],
    ["1.2.3.4:0", /port must be an integer in the range 1-65535/],
    ["---", /must be a host name|bracketed/],
    ["10.0.0.0/33", /CIDR/],
    ["fd00::/129", /CIDR/],
    ["10.0.0.0/abc", /CIDR/],
    ["10.0.0.0/", /CIDR/],
    ["[::1]", /malformed brackets/],
    ["[::1]:", /port must be an integer in the range 1-65535/],
    ["[::1]:0", /port must be an integer in the range 1-65535/],
    ["[::1:443", /malformed brackets/],
    ["::1]:443", /malformed brackets/],
    ["[host]:abc", /port must be an integer in the range 1-65535/],
  ];

  for (const [entry, pattern] of rejected) {
    it(`rejects ${JSON.stringify(entry)}`, () => {
      const result = validateAllowPrivateEntry(entry);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.reason, pattern);
        // The reason must name the offending entry (except for the empty entry,
        // which is rendered as "").
        assert.match(result.reason, /invalid allow-private entry/);
      }
      assert.equal(isAllowPrivateEntryShape(entry), false);
    });
  }

  it("rejects an IPv6-looking token whose base is a bare IPv6 literal plus a port", () => {
    // Nine groups is not a valid IPv6 literal, so the trailing :9 is read as a
    // port on a bare IPv6 literal — which is not allowed; brackets are required.
    const result = validateAllowPrivateEntry("1:2:3:4:5:6:7:8:9");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /bare IPv6 literal carries no port/);
  });

  it("rejects non-string values", () => {
    assert.equal(isAllowPrivateEntryShape(42), false);
    assert.equal(isAllowPrivateEntryShape(null), false);
    assert.equal(isAllowPrivateEntryShape(undefined), false);
    assert.equal(isAllowPrivateEntryShape({}), false);
  });

  it("rejects zone-id IPv6 literals", () => {
    assert.equal(isAllowPrivateEntryShape("fe80::1%eth0"), false);
  });
});

describe("normalizeAllowPrivateEntries", () => {
  it("trims, drops blanks and dedupes preserving first-seen order", () => {
    assert.deepEqual(
      normalizeAllowPrivateEntries(["  b ", "a", "", "  ", "b", "a", "c"]),
      ["b", "a", "c"],
    );
  });

  it("returns an empty list for an empty input", () => {
    assert.deepEqual(normalizeAllowPrivateEntries([]), []);
  });
});

describe("parseAllowPrivateEnv", () => {
  it("splits on commas, trims and dedupes", () => {
    assert.deepEqual(
      parseAllowPrivateEnv(" 192.168.107.74:8888 , example.com,,example.com , ,10.0.0.0/8"),
      ["192.168.107.74:8888", "example.com", "10.0.0.0/8"],
    );
  });

  it("returns an empty list for missing/blank/non-string input", () => {
    assert.deepEqual(parseAllowPrivateEnv(null), []);
    assert.deepEqual(parseAllowPrivateEnv(undefined), []);
    assert.deepEqual(parseAllowPrivateEnv(""), []);
    assert.deepEqual(parseAllowPrivateEnv(" , ,, "), []);
  });

  it("preserves a single entry verbatim apart from surrounding whitespace", () => {
    assert.deepEqual(parseAllowPrivateEnv(" [fd00::/8]:37811 "), ["[fd00::/8]:37811"]);
  });
});

describe("assertAllowPrivateEntries", () => {
  it("validates, trims and dedupes, returning the normalized list", () => {
    assert.deepEqual(
      assertAllowPrivateEntries(["  example.com:443 ", "example.com:443", "10.0.0.0/8"], "--matchlock-allow-private"),
      ["example.com:443", "10.0.0.0/8"],
    );
  });

  it("throws an Error naming the offending entry", () => {
    assert.throws(
      () => assertAllowPrivateEntries(["ok.example", "host:70000"], "--matchlock-allow-private"),
      (err: Error) =>
        err instanceof Error &&
        err.message.includes("--matchlock-allow-private") &&
        err.message.includes("host:70000") &&
        /port must be an integer in the range 1-65535/.test(err.message),
    );
  });

  it("throws for an explicit empty entry", () => {
    assert.throws(
      () => assertAllowPrivateEntries([""], "TAMANDUA_MATCHLOCK_ALLOW_PRIVATE"),
      /TAMANDUA_MATCHLOCK_ALLOW_PRIVATE.*non-empty/,
    );
  });

  it("enforces the bounded list size", () => {
    const tooMany = Array.from(
      { length: MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRIES + 1 },
      (_, i) => `host-${i}.example`,
    );
    assert.throws(
      () => assertAllowPrivateEntries(tooMany, "--matchlock-allow-private"),
      /too many allow-private entries/,
    );
    const atBound = tooMany.slice(0, MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRIES);
    assert.equal(assertAllowPrivateEntries(atBound, "--matchlock-allow-private").length, MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRIES);
  });

  it("throws for a non-list input", () => {
    assert.throws(
      () => assertAllowPrivateEntries(undefined as unknown as string[], "--matchlock-allow-private"),
      /must be a list/,
    );
  });
});
