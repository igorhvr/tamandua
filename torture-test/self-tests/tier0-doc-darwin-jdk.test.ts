// Tier-0 doc gate for MJAV / US-006: the darwin java-stub behavior and the
// JDK resolution contract must be documented in the spec and in the tt-java
// fixture README so an operator knows nix maven alone is sufficient and never
// confuses Apple's `/usr/bin/java` stub with a JDK.
//
// This is a grep audit, not a runtime resolver proof (that lives in
// tier0-jdk-discovery / tier0-tt-java-jdk-wiring). It pins the DOCUMENTED
// contract so the docs and the resolver can never silently drift apart.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");

const SPEC_ENV = path.join(ttRoot, "tamandua-torture-test-spec", "01-environment-and-isolation.md");
const SPEC_FIXTURES = path.join(ttRoot, "tamandua-torture-test-spec", "02-fixture-projects.md");
const TT_JAVA_README = path.join(ttRoot, "fixtures-src", "tt-java", "README.md");

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

// Ordered resolution contract, expressed loosely enough to survive prose
// wrapping while still proving the order JAVA_HOME -> mvn runtime -> PATH java.
const ORDERED_RESOLUTION =
  /JAVA_HOME[\s\S]{0,500}?mvn -v[\s\S]{0,300}?runtime[\s\S]{0,300}?working PATH java/;

describe("Darwin java-stub / JDK resolution documentation (US-006)", () => {
  it("02-fixture-projects.md documents Apple's java stub and the shared resolver", () => {
    const text = read(SPEC_FIXTURES);
    assert.match(text, /Apple ships a `java` stub/i,
      "tt-java section must name Apple's /usr/bin/java stub");
    assert.match(text, /torture-test\/lib\/jdk-discovery\.sh/,
      "tt-java section must reference the shared resolver path");
  });

  it("02-fixture-projects.md documents the JDK resolution order and nix maven sufficiency", () => {
    const text = read(SPEC_FIXTURES);
    assert.match(text, ORDERED_RESOLUTION,
      "tt-java section must state the order JAVA_HOME -> mvn -v runtime -> working PATH java");
    assert.match(text, /nix maven alone is\s+sufficient/i,
      "tt-java section must state nix maven alone is sufficient");
  });

  it("01-environment-and-isolation.md records the darwin java-stub platform fact", () => {
    const text = read(SPEC_ENV);
    assert.match(text, /Apple ships a.*\/usr\/bin\/java.*stub/i,
      "platform-facts table must name Apple's /usr/bin/java stub");
    assert.match(text, ORDERED_RESOLUTION,
      "platform-facts table must state the JDK resolution order");
    assert.match(text, /nix maven alone is\s+sufficient/i,
      "platform-facts table must state nix maven alone is sufficient");
  });

  it("tt-java README documents the darwin operator note", () => {
    const text = read(TT_JAVA_README);
    assert.match(text, /Darwin operator note/i,
      "tt-java README must carry a darwin operator note");
    assert.match(text, /Apple ships a `java` stub/i,
      "tt-java README must name Apple's /usr/bin/java stub");
    assert.match(text, /torture-test\/lib\/jdk-discovery\.sh/,
      "tt-java README must reference the shared resolver");
    assert.match(text, /nix maven alone is\s+sufficient/i,
      "tt-java README must state nix maven alone is sufficient");
  });
});
