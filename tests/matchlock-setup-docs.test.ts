/**
 * MTLK-SETUP US-016 — the user-facing docs describe host provisioning through
 * `tamandua matchlock setup`.
 *
 * Pinned here:
 *   - README.md Matchlock section documents provisioning with the command, the
 *     four phases, the re-login caveat, the offline-readiness contract (R11)
 *     and the local-shadow override, and points at the US-014 help text as the
 *     single source for the exhaustive flag reference.
 *   - docs/matchlock-dsh-qualification.md points its provisioning assumption at
 *     the command instead of an unstated manual matchlock install.
 *
 * Pure filesystem reads (no `dist` import, no `child_process`, no daemon, no VM,
 * no network), so this file stays in the PARALLEL lane and MUST NOT be listed in
 * tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

function readRepoFile(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), "utf-8");
}

const readme = readRepoFile("README.md");
const qualification = readRepoFile("docs/matchlock-dsh-qualification.md");

/**
 * Collapse Markdown line-wrapping (and blockquote markers) to single spaces so
 * phrase assertions do not depend on how a paragraph happens to be wrapped.
 */
function flatten(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join("\n")
    .replace(/\s+/g, " ");
}

const readmeFlat = flatten(readme);
const qualificationFlat = flatten(qualification);

// Slice the single Matchlock Execution section so the assertions below cannot
// pass by matching an unrelated README section.
const matchlockHeading = "##### Matchlock Execution (`--matchlock`)";
const matchlockStart = readme.indexOf(matchlockHeading);
const matchlockEnd =
  matchlockStart >= 0 ? readme.indexOf("##### Doctor Contract Check", matchlockStart) : -1;
const matchlockSection =
  matchlockStart >= 0 && matchlockEnd > matchlockStart
    ? flatten(readme.slice(matchlockStart, matchlockEnd))
    : "";

function assertIn(haystack: string, needle: string, message: string): void {
  assert.ok(haystack.includes(needle), message);
}

describe("README documents `tamandua matchlock setup` provisioning (US-016)", () => {
  it("has one Matchlock Execution section and a dedicated provisioning subsection", () => {
    const headings = readme.match(/^##### Matchlock Execution/gm) ?? [];
    assert.equal(headings.length, 1, "README must carry exactly one Matchlock Execution section");
    assert.match(matchlockSection, /^##### Matchlock Execution/);
    assert.ok(
      matchlockSection.includes(
        "###### Provisioning the host with `tamandua matchlock setup`",
      ),
      "README Matchlock section must carry the provisioning subsection",
    );
  });

  it("names `tamandua matchlock setup` as the provisioning command", () => {
    assertIn(
      matchlockSection,
      "`tamandua matchlock setup` performs that provisioning end to end",
      "README must state the command performs provisioning",
    );
    assertIn(matchlockSection, "tamandua matchlock setup", "README must name the command");
  });

  it("documents all four phases with their distinct behavior", () => {
    assertIn(matchlockSection, "The four phases, in order:", "README must introduce the phases");
    assertIn(matchlockSection, "**Binaries (fail-closed).**", "README must document phase 1");
    assertIn(matchlockSection, "**Host setup (Linux only).**", "README must document phase 2");
    assertIn(matchlockSection, "**Boot assets.**", "README must document phase 3");
    assertIn(matchlockSection, "**Verify + report.**", "README must document phase 4");
    // Phase-1 fail-closed prerequisite, the phase-2 sudo shape and the phase-3
    // image + kernel warm wording that distinguish the phases.
    assertIn(matchlockSection, "git submodule update --init matchlock", "phase 1 sync");
    assertIn(matchlockSection, "GOTOOLCHAIN=local", "phase 1 Go gate");
    assertIn(matchlockSection, "setup linux", "phase 2 host setup");
    assertIn(matchlockSection, "matchlock pull [--force] <reference>", "phase 3 image pull");
    assertIn(matchlockSection, "kernel pull", "phase 3 kernel warm");
  });

  it("documents the re-login caveat and the --smoke refusal", () => {
    assertIn(matchlockSection, "**Re-login caveat.**", "README must have the re-login caveat");
    assertIn(
      matchlockSection,
      "takes effect only in a NEW login session",
      "README must state group changes need a new login session",
    );
    assertIn(
      matchlockSection,
      "refuses `--smoke`",
      "README must state --smoke is refused while re-login is pending",
    );
  });

  it("documents the offline-readiness contract (R11) separating assets from runnability", () => {
    assertIn(
      matchlockSection,
      "**Offline-readiness contract (R11).**",
      "README must have the offline-readiness contract",
    );
    assertIn(
      matchlockSection,
      "leaves the standard image in the local matchlock store and the guest kernel warmed for this host",
      "README must state image + warmed kernel are left locally",
    );
    assertIn(matchlockSection, "`assets: offline-ready`", "README must state the assets verdict");
    assertIn(matchlockSection, "`runnability`", "README must separate runnability");
    assertIn(
      matchlockSection,
      "needs no public-internet access on the host",
      "README must state the offline guarantee",
    );
  });

  it("documents the local-shadow override and the --refresh-image update channel", () => {
    assertIn(
      matchlockSection,
      "locally built/imported image shadows the standard reference",
      "README must document the local shadow override",
    );
    assertIn(
      matchlockSection,
      "never deleted or re-tagged",
      "README must state a shadow is never deleted or re-tagged",
    );
    assertIn(
      matchlockSection,
      "`--refresh-image` is the standard image's update channel",
      "README must name the update channel",
    );
  });

  it("points at the help text as the single source for the flag reference", () => {
    assertIn(
      matchlockSection,
      "`tamandua matchlock setup --help`",
      "README must reference the setup help text",
    );
    assertIn(
      matchlockSection,
      "`src/cli/commands/matchlock.ts`",
      "README must name the help implementation module",
    );
  });
});

describe("docs/matchlock-dsh-qualification.md points provisioning at the command (US-016)", () => {
  it("states the provisioning assumption using `tamandua matchlock setup`", () => {
    assertIn(
      qualificationFlat,
      "**Provisioning assumption.**",
      "recipe must state its provisioning assumption",
    );
    assertIn(
      qualificationFlat,
      "assumes a host provisioned with `tamandua matchlock setup` (MTLK-SETUP), not a manual matchlock install",
      "recipe must name the command as the provisioning path",
    );
    assertIn(
      qualificationFlat,
      "The \"system `/usr/local/bin/matchlock`\" below is that installed binary",
      "recipe must bind the PATH-resolved binary to the provisioned install",
    );
  });

  it("states the provisioning prerequisite in the real production recipe", () => {
    assertIn(
      qualificationFlat,
      "**Prerequisite — provision the host.**",
      "recipe must have the provisioning prerequisite",
    );
    assertIn(
      qualificationFlat,
      "Run `tamandua matchlock setup` (§3) as the ordinary user first",
      "recipe must direct the operator at the command",
    );
    assertIn(
      qualificationFlat,
      "Do not hand-install `matchlock`.",
      "recipe must forbid the unstated manual install",
    );
  });

  it("keeps the unpinned runtime assertions the existing guards pin", () => {
    assert.doesNotMatch(qualification, /a278f9c1|f76f00fb/);
    assert.match(qualification, /unpinned/i);
    assert.match(qualification, /runtime-observed\.txt/);
  });

  it("exists in the tree (sanity)", () => {
    assert.ok(
      existsSync(resolve(repoRoot, "docs/matchlock-dsh-qualification.md")),
      "recipe must exist",
    );
  });
});
