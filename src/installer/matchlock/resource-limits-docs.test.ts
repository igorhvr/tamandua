/**
 * MTLK-VM-SIZE US-005 — committed-source documentation regression for the
 * operator-configurable Matchlock VM resources.
 *
 * Pure filesystem reads (no child_process, no daemon, no VM, no network), so
 * this file stays in the parallel lane and needs no tests/serial-files.txt
 * entry. It pins the operator-facing artifacts US-005 required:
 *   - README Matchlock section: the `--matchlock-*` size flags plus the swap
 *     flags, the `TAMANDUA_MATCHLOCK_*` env defaults, the host-derived built-in
 *     defaults and the standing caps, the launch line and `workflow status`;
 *   - skills/tamandua-agents/SKILL.md: the brief Matchlock VM resources note.
 *
 * MTLK-ISO-SLICE1 (US-011) extends the guard to the standard-image opt-in
 * grammar (`--matchlock` / `--matchlock-image <image>`), the swap default
 * (8192 MB), the off switch (`--matchlock-no-swap` /
 * `TAMANDUA_MATCHLOCK_SWAP_MB=off`) and matchlock's 65536 MB swap cap.
 *
 * The design doc (`/home/kaladin/tamandua-matchlock-design.md`) is outside the
 * repo and is not committed, so it is deliberately not asserted here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

/** Slice from an exact heading line to the next named heading (exclusive). */
function sliceSection(text: string, heading: string, nextHeading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const end = text.indexOf(nextHeading, start + heading.length);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

const readme = readRepoFile("README.md");
const skill = readRepoFile("skills/tamandua-agents/SKILL.md");

// README slice from the Matchlock H5 heading to the next H5, so assertions
// cannot pass by matching an unrelated section.
const matchlockHeading = "##### Matchlock Execution (`--matchlock`)";
const matchlockSection = sliceSection(readme, matchlockHeading, "##### Doctor Contract Check");

const skillHeading = "#### Matchlock VM resources";
const skillSection = sliceSection(skill, skillHeading, "### Worktree management");

const REQUIRED_FLAGS = ["--matchlock-cpus", "--matchlock-memory", "--matchlock-disk"];
const REQUIRED_SWAP_FLAGS = ["--matchlock-swap", "--matchlock-no-swap"];
const REQUIRED_ENV = [
  "TAMANDUA_MATCHLOCK_CPUS",
  "TAMANDUA_MATCHLOCK_MEMORY_MB",
  "TAMANDUA_MATCHLOCK_DISK_MB",
  "TAMANDUA_MATCHLOCK_SWAP_MB",
];
const REQUIRED_DEFAULTS = [
  "min(8, host CPUs)",
  "min(16384 MB, 50% of host RAM)",
  "20480 MB",
  "8192 MB",
];
const REQUIRED_CAPS = [
  "cpus <= 16",
  "host online CPUs",
  "memory <= 75% of host MemTotal",
  "finite positive",
  "65536 MB",
];
const LAUNCH_LINE =
  "matchlock: <image> cpus=<n> memory=<MB>MB disk=<MB>MB swap=<n>MB|off";

function assertDocumentsVmResources(section: string, label: string): void {
  for (const flag of REQUIRED_FLAGS) {
    assert.ok(section.includes(flag), `${label} must document ${flag}`);
  }
  for (const flag of REQUIRED_SWAP_FLAGS) {
    assert.ok(section.includes(flag), `${label} must document ${flag}`);
  }
  for (const envName of REQUIRED_ENV) {
    assert.ok(section.includes(envName), `${label} must document env ${envName}`);
  }
  for (const fallback of REQUIRED_DEFAULTS) {
    assert.ok(section.includes(fallback), `${label} must document the default ${fallback}`);
  }
  for (const cap of REQUIRED_CAPS) {
    assert.ok(section.includes(cap), `${label} must document the cap ${cap}`);
  }
}

describe("README documents Matchlock VM resources (MTLK-VM-SIZE US-005)", () => {
  it("has the Matchlock H5 section", () => {
    assert.ok(matchlockSection.length > 0, `README must contain '${matchlockHeading}'`);
  });

  it("documents the three size flags, the swap flags and the MB/<n>g syntax", () => {
    assertDocumentsVmResources(matchlockSection, "README Matchlock section");
    assert.ok(matchlockSection.includes("--matchlock-memory <MB|16g>"));
    assert.ok(matchlockSection.includes("--matchlock-disk <MB|40g>"));
    assert.ok(matchlockSection.includes("--matchlock-swap <MB|8g>"));
  });

  it("documents the env defaults, precedence and the launch/status surfaces", () => {
    assert.ok(matchlockSection.includes("flag > env >"));
    assert.ok(matchlockSection.includes(LAUNCH_LINE), "README must show the launch line");
    assert.match(matchlockSection, /workflow status/);
  });

  it("requires the size flags to be paired with either opt-in form", () => {
    assert.match(
      matchlockSection,
      /Any of the four\s+requires an opt-in\s+\(`--matchlock` or `--matchlock-image <image>`\)/,
    );
  });

  it("documents the swap default, the off switch and the matchlock cap", () => {
    assert.match(matchlockSection, /TAMANDUA_MATCHLOCK_SWAP_MB=off/);
    assert.match(matchlockSection, /--matchlock-no-swap/);
  });
});

describe("SKILL.md documents Matchlock VM resources (MTLK-VM-SIZE US-005)", () => {
  it("has the Matchlock VM resources subsection", () => {
    assert.ok(skillSection.length > 0, `SKILL.md must contain '${skillHeading}'`);
  });

  it("documents the three flags, env defaults and caps", () => {
    assertDocumentsVmResources(skillSection, "SKILL.md Matchlock VM resources section");
  });

  it("documents the launch line and workflow status", () => {
    assert.ok(skillSection.includes(LAUNCH_LINE), "SKILL.md must show the launch line");
    assert.match(skillSection, /workflow status/);
  });
});
