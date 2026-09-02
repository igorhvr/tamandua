// MJAV US-005 — surface mvnw failure tails in fail-closed bootstrap reasons.
//
// The golden bootstrap (bin/tt-golden-bootstrap.mjs) previously used
// `res.stderr || res.stdout` for its fail-closed tail, which dropped every
// line of stdout whenever stderr carried even one byte. build-golden.sh
// captures `./mvnw ... 2>&1`, so on darwin the real mvnw failure tail was on
// stdout and vanished from the provision log. This pins:
//   * AC1: failureTail concatenates stdout+stderr and returns the last n lines
//          (markers from both streams survive).
//   * AC2: buildGoldenBare no longer uses the stdout-dropping `stderr || stdout`
//          pattern, and its fail-closed tail is built via failureTail.
//   * AC3: tt-java's build-golden.sh and validate-e2e.sh surface every captured
//          mvnw output with a `tail -20` print on their fail-closed paths.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { failureTail } from "../bin/tt-golden-bootstrap.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const bootstrapPath = path.join(ttRoot, "bin", "tt-golden-bootstrap.mjs");

describe("failureTail (MJAV US-005)", () => {
  it("AC1: concatenates stdout+stderr and returns the last n lines with markers from both streams", () => {
    const stdout = ["STDOUT-1", "STDOUT-2", "STDOUT-3"].join("\n");
    const stderr = ["STDERR-1", "STDERR-2"].join("\n");
    const tail = failureTail(stdout, stderr, 4);
    assert.deepEqual(tail, ["STDOUT-2", "STDOUT-3", "STDERR-1", "STDERR-2"]);
    assert.ok(tail.includes("STDOUT-3"), "tail must include a stdout marker");
    assert.ok(tail.includes("STDERR-2"), "tail must include a stderr marker");
  });

  it("AC1: returns all lines when there are fewer than n total lines", () => {
    assert.deepEqual(failureTail("a", "b", 10), ["a", "b"]);
  });

  it("AC1: treats undefined/null streams as empty and never throws", () => {
    assert.deepEqual(failureTail(undefined, undefined, 3), [""]);
    assert.deepEqual(failureTail("only-stdout", null, 2), ["only-stdout"]);
    assert.deepEqual(failureTail(null, "only-stderr", 2), ["only-stderr"]);
  });

  it("AC2: buildGoldenBare no longer uses the stdout-dropping stderr || stdout pattern", () => {
    const src = fs.readFileSync(bootstrapPath, "utf8");
    assert.ok(
      !/res\.stderr\s*\|\|\s*res\.stdout/.test(src),
      "tt-golden-bootstrap.mjs must not use `res.stderr || res.stdout`",
    );
    assert.match(
      src,
      /tail: failureTail\(res\.stdout, res\.stderr, 20\)/,
      "fail-closed build tail must use failureTail(stdout, stderr, 20)",
    );
    assert.match(
      src,
      /build_tail: failureTail\(res\.stdout, res\.stderr, 8\)/,
      "post-build verify-fail tail must use failureTail",
    );
  });

  it("AC3: tt-java mvnw capture sites each print a tail -20 on fail-closed paths", () => {
    const buildGolden = fs.readFileSync(
      path.join(ttRoot, "fixtures-src", "tt-java", "build-golden.sh"),
      "utf8",
    );
    const validateE2e = fs.readFileSync(
      path.join(ttRoot, "fixtures-src", "tt-java", "validate-e2e.sh"),
      "utf8",
    );

    const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

    // build-golden.sh: three MVN_OUT failure branches + one TEST_OUTPUT
    // unexpected-green branch.
    assert.equal(
      count(buildGolden, /printf '%s\\n' "\$MVN_OUT" \| tail -20/g),
      3,
      "every MVN_OUT mvnw failure path in build-golden.sh must print a tail -20",
    );
    assert.equal(
      count(buildGolden, /printf '%s\\n' "\$TEST_OUTPUT" \| tail -20/g),
      1,
      "the BRK unexpected-green path must print the captured TEST_OUTPUT tail",
    );

    // validate-e2e.sh: baseline + fix-restores-green MVN_OUT paths, and both
    // seed-colour mismatch SEED_OUT paths.
    assert.equal(
      count(validateE2e, /printf '%s\\n' "\$MVN_OUT" \| tail -20 >&2/g),
      2,
      "baseline + fix-restores-green mvnw failure paths must print a tail -20",
    );
    assert.equal(
      count(validateE2e, /printf '%s\\n' "\$SEED_OUT" \| tail -20 >&2/g),
      2,
      "both seed-colour mismatch paths must print the captured SEED_OUT tail",
    );
  });
});
