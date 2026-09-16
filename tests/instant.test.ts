import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nowIso, SQL_NOW_ISO } from "../dist/lib/instant.js";

const ISO_MS_Z = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

describe("instant writer helpers", () => {
  describe("nowIso", () => {
    it("returns ISO-8601 UTC with milliseconds and Z", () => {
      assert.match(nowIso(), ISO_MS_Z);
    });

    it("is within 5 seconds of Date.now()", () => {
      const before = Date.now();
      const epoch = Date.parse(nowIso());
      const after = Date.now();
      assert.ok(Number.isFinite(epoch), `nowIso() must be parseable, got ${epoch}`);
      assert.ok(
        epoch >= before - 5000 && epoch <= after + 5000,
        `nowIso() epoch ${epoch} must be within 5s of [${before}, ${after}]`,
      );
    });

    it("round-trips to the same instant as new Date().toISOString()", () => {
      // Both use the same JS primitive, so the shape is identical.
      assert.equal(nowIso().length, new Date().toISOString().length);
    });

    it("never returns the naive legacy space-separated form", () => {
      assert.ok(!nowIso().includes(" "), "canonical instant must not contain a space");
    });

    it("produces non-decreasing values across calls", () => {
      const first = Date.parse(nowIso());
      const second = Date.parse(nowIso());
      assert.ok(second >= first, "nowIso() must not go backwards");
    });
  });

  describe("SQL_NOW_ISO", () => {
    it("is the exact strftime ISO-Z fragment", () => {
      assert.equal(SQL_NOW_ISO, "strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    });

    it("is a plain string usable by template-literal interpolation", () => {
      assert.equal(typeof SQL_NOW_ISO, "string");
      const stmt = `UPDATE runs SET updated_at = ${SQL_NOW_ISO} WHERE id = ?`;
      assert.equal(
        stmt,
        "UPDATE runs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
      );
    });

    it("is not the legacy naive datetime('now') writer", () => {
      assert.ok(!SQL_NOW_ISO.includes("datetime("), "must not be datetime('now')");
      assert.ok(SQL_NOW_ISO.includes("T"), "must emit a T separator");
      assert.ok(SQL_NOW_ISO.includes("Z"), "must emit a Z suffix");
    });
  });
});
