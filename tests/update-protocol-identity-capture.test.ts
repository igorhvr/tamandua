import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { captureProcessIdentity, validateProcessIdentity } from "../scripts/update-protocol.mjs";

const CCI = "Cannot capture process identity";
const IPI = "Invalid process identifier";

describe("captureProcessIdentity", () => {
  it("captures the current process identity and returns validated output", () => {
    const p = process.platform;
    if (p === "linux" || p === "darwin") {
      const id = captureProcessIdentity(process.pid);
      assert.strictEqual(typeof id, "string");
      assert.ok(Buffer.byteLength(id, "utf-8") <= 256);
      const accepted = validateProcessIdentity(id);
      assert.strictEqual(accepted, id);
      const o = JSON.parse(id);
      if (p === "linux") {
        assert.deepStrictEqual(Object.keys(o), ["boot_id", "start_ticks"]);
        assert.strictEqual(typeof o.boot_id, "string");
        assert.strictEqual(typeof o.start_ticks, "string");
        assert.strictEqual(JSON.stringify(o), id);
        assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(o.boot_id));
        assert.ok(/^(?:0|[1-9][0-9]{0,19})$/.test(o.start_ticks));
      } else {
        assert.deepStrictEqual(Object.keys(o), ["lstart"]);
        assert.strictEqual(typeof o.lstart, "string");
        assert.strictEqual(JSON.stringify(o), id);
        assert.ok(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [1-9]|[12][0-9]|3[01]) (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] [0-9]{4}$/.test(o.lstart));
      }
    } else {
      assert.throws(() => captureProcessIdentity(process.pid), { message: CCI });
    }
  });

  it("rejects invalid PID values without coercion", () => {
    let coercionFlag = false;
    const sentinel = Symbol("coercion-sentinel");
    const coerciveObj = Object.create(null, {
      [Symbol.toPrimitive]: {
        value() { coercionFlag = true; throw sentinel; },
      },
      toString: {
        value() { coercionFlag = true; throw sentinel; },
      },
      valueOf: {
        value() { coercionFlag = true; throw sentinel; },
      },
    });

    const invalid = [
      0, -1, 3.14, Number.MAX_SAFE_INTEGER + 1, NaN,
      Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      "123", null, undefined, {}, coerciveObj,
    ];

    for (const v of invalid) {
      assert.throws(() => captureProcessIdentity(v), { message: IPI });
    }
    assert.strictEqual(coercionFlag, false);
  });

  it("surfaces hermetic Linux failures and passes through validateProcessIdentity", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const originalReadFileSync = fs.readFileSync;
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      const validBootId = "00000000-0000-0000-0000-000000000000";
      const validStartTicks = "12345";
      const statLine = `1234 (my space ) cmd) S 1000 1234 1234 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 ${validStartTicks} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;

      // Boot read throws
      fs.readFileSync = (p, enc) => { throw new Error("EIO"); };
      assert.throws(() => captureProcessIdentity(1), { message: CCI });

      // Stat read throws
      let callCount = 0;
      fs.readFileSync = (p, enc) => {
        callCount++;
        if (callCount === 1) return `${validBootId}\n`;
        throw new Error("EIO");
      };
      assert.throws(() => captureProcessIdentity(1), { message: CCI });

      // Malformed stat (no closing paren)
      callCount = 0;
      fs.readFileSync = (p, enc) => {
        callCount++;
        if (callCount === 1) return `${validBootId}\n`;
        return "1234 mycommand S 1000";
      };
      assert.throws(() => captureProcessIdentity(1), { message: CCI });

      // Valid stat with spaces+parens in comm name, but invalid boot ID — proves validateProcessIdentity is called
      callCount = 0;
      fs.readFileSync = (p, enc) => {
        callCount++;
        if (callCount === 1) return "xyz\n";
        return statLine;
      };
      assert.throws(() => captureProcessIdentity(1), { message: "Invalid process identity" });
    } finally {
      fs.readFileSync = originalReadFileSync;
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });
});
