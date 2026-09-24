/**
 * DIAG-PRUNE US-001 — unit tests for secret redaction.
 *
 * Pure (no child_process, no temp files, no daemon) — stays in the parallel
 * lane.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  redactSecrets,
  isSecretKey,
  REDACTED_VALUE,
  CIRCULAR_VALUE,
  MAX_REDACT_DEPTH,
} from "../../dist/diagnostics/redact.js";

describe("isSecretKey", () => {
  it("matches the expected credential-shaped keys case-insensitively", () => {
    for (const key of [
      "token",
      "TOKEN",
      "accessToken",
      "secret",
      "clientSecret",
      "password",
      "PASSWORD",
      "apiKey",
      "api_key",
      "api-key",
      "Authorization",
      "authorization",
      "credential",
      "credentials",
    ]) {
      assert.equal(isSecretKey(key), true, `expected ${key} to be secret`);
    }
  });

  it("does not match ordinary field names", () => {
    for (const key of ["name", "path", "runId", "branch", "status"]) {
      assert.equal(isSecretKey(key), false, `expected ${key} to be public`);
    }
  });
});

describe("redactSecrets", () => {
  it("redacts top-level secret-looking keys and preserves others", () => {
    const out = redactSecrets({
      token: "abc",
      name: "keep",
      count: 3,
      enabled: true,
    });
    assert.deepEqual(out, {
      token: REDACTED_VALUE,
      name: "keep",
      count: 3,
      enabled: true,
    });
  });

  it("redacts nested keys in objects and arrays while preserving structure", () => {
    const out = redactSecrets({
      name: "run",
      nested: {
        apiKey: "x",
        password: "y",
        items: [
          { secret: "z", value: 1 },
          { Authorization: "Bearer x", value: 2 },
        ],
      },
    });
    assert.deepEqual(out, {
      name: "run",
      nested: {
        apiKey: REDACTED_VALUE,
        password: REDACTED_VALUE,
        items: [
          { secret: REDACTED_VALUE, value: 1 },
          { Authorization: REDACTED_VALUE, value: 2 },
        ],
      },
    });
  });

  it("preserves array length and order", () => {
    const out = redactSecrets([{ token: "a" }, { value: 1 }, "plain"]) as unknown[];
    assert.equal(out.length, 3);
    assert.deepEqual(out[0], { token: REDACTED_VALUE });
    assert.deepEqual(out[1], { value: 1 });
    assert.equal(out[2], "plain");
  });

  it("never throws on non-objects and returns them unchanged", () => {
    assert.equal(redactSecrets("str"), "str");
    assert.equal(redactSecrets(42), 42);
    assert.equal(redactSecrets(null), null);
    assert.equal(redactSecrets(undefined), undefined);
    assert.equal(redactSecrets(true), true);
  });

  it("handles a real object cycle without throwing or looping", () => {
    const node: Record<string, unknown> = { name: "a", token: "t" };
    node.self = node;
    const out = redactSecrets(node);
    assert.equal(out.name, "a");
    assert.equal(out.token, REDACTED_VALUE);
    assert.doesNotThrow(() => JSON.stringify(out));
    assert.equal(out.self, CIRCULAR_VALUE);
  });

  it("handles deeply nested input bounded by the depth limit", () => {
    let deep: unknown = { token: "leaf" };
    for (let i = 0; i < MAX_REDACT_DEPTH + 20; i++) {
      deep = { child: deep };
    }
    let out: unknown;
    assert.doesNotThrow(() => {
      out = redactSecrets(deep);
    });
    assert.doesNotThrow(() => JSON.stringify(out));
  });

  it("leaves non-plain objects (e.g. Date) intact", () => {
    const date = new Date("2026-09-23T00:00:00.000Z");
    const out = redactSecrets({ createdAt: date }) as Record<string, unknown>;
    assert.ok(out.createdAt instanceof Date);
  });
});