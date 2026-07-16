import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateProcessIdentity } from "../scripts/update-protocol.mjs";

const MSG = "Invalid process identity";
const p = process.platform;

describe("validateProcessIdentity", () => {
  it("accepts a deterministic valid identity for the current platform", () => {
    if (p === "linux") {
      const id = JSON.stringify({ boot_id: "00000000-0000-0000-0000-000000000000", start_ticks: "0" });
      const r = validateProcessIdentity(id);
      assert.strictEqual(r, id);
      assert.ok(Buffer.byteLength(r, "utf-8") <= 256);
      const o = JSON.parse(r);
      assert.deepStrictEqual(Object.keys(o), ["boot_id", "start_ticks"]);
      assert.strictEqual(typeof o.boot_id, "string");
      assert.strictEqual(typeof o.start_ticks, "string");
      assert.strictEqual(JSON.stringify(o), id);
      assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(o.boot_id));
      assert.ok(/^(?:0|[1-9][0-9]{0,19})$/.test(o.start_ticks));
    } else if (p === "darwin") {
      const id = JSON.stringify({ lstart: "Sun Jan  5 00:00:00 2025" });
      const r = validateProcessIdentity(id);
      assert.strictEqual(r, id);
      assert.ok(Buffer.byteLength(r, "utf-8") <= 256);
      const o = JSON.parse(r);
      assert.deepStrictEqual(Object.keys(o), ["lstart"]);
      assert.strictEqual(typeof o.lstart, "string");
      assert.strictEqual(JSON.stringify(o), id);
      assert.ok(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [1-9]|[12][0-9]|3[01]) (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] [0-9]{4}$/.test(o.lstart));
    } else {
      assert.throws(() => validateProcessIdentity(JSON.stringify({})), { message: MSG });
    }
  });

  it("rejects a thorough set of invalid inputs", () => {
    const R = (v) => assert.throws(() => validateProcessIdentity(v), { message: MSG });

    // Malformed/non-canonical JSON
    R("not json"); R("{"); R('{"a":1');
    R('"a string"'); R("42"); R("true"); R("false"); R("null");
    R("[]");
    R('[{"boot_id":"00000000-0000-0000-0000-000000000000","start_ticks":"0"}]');
    R(' {"boot_id":"00000000-0000-0000-0000-000000000000","start_ticks":"0"}');
    R('{"boot_id":"00000000-0000-0000-0000-000000000000", "start_ticks":"0"}');
    R('{"boot_id":"00000000-0000-0000-0000-000000000000","start_ticks":"0"} ');
    R('{\n"boot_id":"00000000-0000-0000-0000-000000000000","start_ticks":"0"\n}');

    // Length overflow (258 UTF-8 bytes)
    R('"' + "é".repeat(129) + '"');

    // Non-string types
    R(undefined); R(null); R(42); R(true); R([]); R({});

    // Coercion sentinel
    const s = Symbol.for("sentinel");
    const c = Object.create(null, {
      [Symbol.toPrimitive]: { value() { throw s; } },
      toString: { value() { throw s; } },
      valueOf: { value() { throw s; } },
    });
    assert.throws(() => validateProcessIdentity(c), { message: MSG });

    if (p === "linux") {
      R('{"start_ticks":"0","boot_id":"00000000-0000-0000-0000-000000000000"}');
      R('{"boot_id":"00000000-0000-0000-0000-000000000000","start_ticks":"0","boot_id":"11111111-1111-1111-1111-111111111111"}');
      R('{"boot_id":"00000000-0000-0000-0000-000000000000"}');
      R('{"boot_id":"00000000-0000-0000-0000-000000000000","start_ticks":"0","extra":1}');
      R('{"boot_id":"00000000-0000-0000-0000-000000000000","start_ticks":0}');
      R('{"boot_id":42,"start_ticks":"0"}');
      R('{"boot_id":"00000000-0000-0000-0000-00000000000G","start_ticks":"0"}');
      R('{"boot_id":"00000000-0000-0000-0000-00000000000","start_ticks":"0"}');
      R('{"boot_id":"00000000-0000-0000-0000-000000000000","start_ticks":"-1"}');
      R('{"boot_id":"00000000-0000-0000-0000-000000000000","start_ticks":"01"}');
      R('{"boot_id":"00000000-0000-0000-0000-000000000000","start_ticks":"123456789012345678901"}');
      R('{"lstart":"Sun Jan  5 00:00:00 2025"}');
    }

    if (p === "darwin") {
      R('{"lstart":"Sun Jan  5 00:00:00 2025","lstart":"Mon Feb  6 01:01:01 2025"}');
      R("{}");
      R('{"lstart":"Sun Jan  5 00:00:00 2025","extra":1}');
      R('{"lstart":42}');
      R('{"lstart":"Fak Jan  5 00:00:00 2025"}');
      R('{"lstart":"Sun Fak  5 00:00:00 2025"}');
      R('{"lstart":"Sun Jan 5 00:00:00 2025"}');
      R('{"lstart":"Sun Jan 05 00:00:00 2025"}');
      R('{"lstart":"Sun Jan 32 00:00:00 2025"}');
      R('{"lstart":"Sun Jan 00 00:00:00 2025"}');
      R('{"lstart":"Sun Jan  5 24:00:00 2025"}');
      R('{"lstart":"Sun Jan  5 00:60:00 2025"}');
      R('{"lstart":"Sun Jan  5 00:00:60 2025"}');
      R('{"lstart":"Sun Jan  5 00:00:00 99"}');
      R('{"lstart":"Sun Jan \t5 00:00:00 2025"}');
      R('{"lstart":"Sun Jan   5 00:00:00 2025"}');
      R('{"lstart":"Sun Jan  5 00:00:00 2025 "}');
      R('{"boot_id":"00000000-0000-0000-0000-000000000000","start_ticks":"0"}');
    }
  });
});
