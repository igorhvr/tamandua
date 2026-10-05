/**
 * warnings.test.ts — MTLK-ISO-SLICE2 US-013.
 *
 * Unit coverage for the shared advisory `warnings` channel (spec C §4.6 /
 * spec B §4.6): the `{ code, message }` vocabulary, the PRESENT-only-when-
 * non-empty contract (absent — never `[]` — on a clean run), the bounded
 * one-line text rendering, and the untrusted-input parser.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CONSENT_GRANTED_ON_RESUME_CODE,
  CONSENT_GRANTED_ON_RESUME_MESSAGE,
  ROOT_USAGE_OVERRIDE_CODE,
  ROOT_USAGE_OVERRIDE_MESSAGE,
  buildWorkflowWarnings,
  formatWorkflowWarningLine,
  parseWorkflowWarnings,
  withWorkflowWarnings,
} from "../../../dist/installer/matchlock/warnings.js";

describe("US-013: shared warnings channel helper", () => {
  it("returns an EMPTY array on a clean run", () => {
    assert.deepEqual(buildWorkflowWarnings(), []);
    assert.deepEqual(buildWorkflowWarnings({}), []);
    assert.deepEqual(
      buildWorkflowWarnings({ rootUsageConsent: false, consentGrantedOnResume: false }),
      [],
    );
  });

  it("emits root_usage_override when the persisted policy records rootUsageConsent true", () => {
    const warnings = buildWorkflowWarnings({ rootUsageConsent: true });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, ROOT_USAGE_OVERRIDE_CODE);
    assert.equal(warnings[0].message, ROOT_USAGE_OVERRIDE_MESSAGE);
    // The message states root execution is AUTHORIZED and never claims that
    // execution actually occurred as root (a non-root caller may record
    // consent), and carries no secret/variable content.
    assert.match(warnings[0].message, /AUTHORIZED/);
    assert.doesNotMatch(warnings[0].message, /executed as root/);
  });

  it("emits consent_granted_on_resume when a resume grants root consent", () => {
    const warnings = buildWorkflowWarnings({ consentGrantedOnResume: true });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, CONSENT_GRANTED_ON_RESUME_CODE);
    assert.equal(warnings[0].message, CONSENT_GRANTED_ON_RESUME_MESSAGE);
    assert.match(warnings[0].message, /consent was granted/);
  });

  it("prefers consent_granted_on_resume over root_usage_override for the same grant", () => {
    const warnings = buildWorkflowWarnings({
      consentGrantedOnResume: true,
      rootUsageConsent: true,
    });
    assert.deepEqual(warnings.map((w) => w.code), [CONSENT_GRANTED_ON_RESUME_CODE]);
  });

  it("adds the warnings key ONLY when non-empty (absent, never [])", () => {
    const clean = { runId: "run-1", status: "running" };
    const unchanged = withWorkflowWarnings(clean, []);
    assert.equal(unchanged, clean, "an empty channel must not clone or add a key");
    assert.equal(Object.prototype.hasOwnProperty.call(unchanged, "warnings"), false);

    const withOne = withWorkflowWarnings(clean, buildWorkflowWarnings({ rootUsageConsent: true }));
    assert.notEqual(withOne, clean);
    assert.deepEqual(withOne.warnings, [
      { code: ROOT_USAGE_OVERRIDE_CODE, message: ROOT_USAGE_OVERRIDE_MESSAGE },
    ]);
    // The entry is a plain { code, message } copy (JSON-serializable).
    assert.deepEqual(Object.keys((withOne.warnings as unknown[])[0]), ["code", "message"]);
  });

  it("renders a bounded single-line stderr rendering", () => {
    const line = formatWorkflowWarningLine({
      code: ROOT_USAGE_OVERRIDE_CODE,
      message: "first line\nsecond\tline",
    });
    assert.equal(line, `warning[${ROOT_USAGE_OVERRIDE_CODE}]: first line second line`);
    assert.doesNotMatch(line, /\n/);
  });

  it("parses only well-formed untrusted entries", () => {
    assert.deepEqual(parseWorkflowWarnings(undefined), []);
    assert.deepEqual(parseWorkflowWarnings("nope"), []);
    assert.deepEqual(parseWorkflowWarnings([{ code: "unknown", message: "x" }]), []);
    assert.deepEqual(parseWorkflowWarnings([{ code: ROOT_USAGE_OVERRIDE_CODE }]), []);
    assert.deepEqual(
      parseWorkflowWarnings([{ code: ROOT_USAGE_OVERRIDE_CODE, message: "ok" }]),
      [{ code: ROOT_USAGE_OVERRIDE_CODE, message: "ok" }],
    );
  });
});
