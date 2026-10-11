/**
 * MTLK-INTERACTIVE US-015 — interactive-session documentation contract.
 *
 * Pins the user-facing documentation for the four foreground interactive
 * commands (`tamandua matchlock pi|pi-shell|hermes|hermes-shell`) and the
 * completed dependency-contract gap list:
 *
 *   - README documents all four subcommands and the shared option set;
 *   - README keeps exactly ONE `##### Matchlock Execution` H5 heading (the
 *     existing docs tests rely on it) and nests the interactive section as an
 *     H6 inside it;
 *   - README documents the root gate, image/identity pinning, configuration and
 *     working-directory mounts, numeric uid/gid mapping, the pre-launch summary
 *     and confirmed cleanup, and the on-demand in-repo real-VM acceptance suite
 *     (with the synthetic fast-lane coverage);
 *   - SKILL.md enumerates the interactive commands in its command overview;
 *   - INTEGRATION-NOTES.md carries every provisional gap with reconciliation
 *     instructions and the explicit unavailable-real-launch-path list.
 *
 * Pure filesystem reads (no child_process, no dist import, no daemon, no VM, no
 * network), so this file stays in the parallel lane and needs no
 * tests/serial-files.txt entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const readme = readFileSync(resolve(repoRoot, "README.md"), "utf-8");
const skill = readFileSync(resolve(repoRoot, "skills", "tamandua-agents", "SKILL.md"), "utf-8");
const notes = readFileSync(resolve(repoRoot, "INTEGRATION-NOTES.md"), "utf-8");

const matchlockHeading = "##### Matchlock Execution (`--matchlock`)";
const interactiveHeading =
  "###### Interactive sessions (`tamandua matchlock pi|pi-shell|hermes|hermes-shell`)";
const nextH5 = "##### Doctor Contract Check";

const matchlockStart = readme.indexOf(matchlockHeading);
const interactiveStart = readme.indexOf(interactiveHeading);
const interactiveEnd = readme.indexOf(nextH5, interactiveStart);
const interactiveSection =
  interactiveStart >= 0 && interactiveEnd > interactiveStart
    ? readme.slice(interactiveStart, interactiveEnd)
    : "";

const GAP_IDS = Array.from({ length: 12 }, (_, i) => `GAP-${String(i + 1).padStart(2, "0")}`);

describe("README interactive Matchlock documentation (MTLK-INTERACTIVE US-015)", () => {
  it("keeps exactly one Matchlock Execution H5 and nests one interactive H6 inside it", () => {
    const h5 = readme.match(/^##### Matchlock Execution/gm) ?? [];
    assert.equal(h5.length, 1, "README must carry exactly one `##### Matchlock Execution` section");
    const h6 = readme.match(/^###### Interactive sessions/gm) ?? [];
    assert.equal(h6.length, 1, "README must carry exactly one interactive sessions subsection");
    assert.ok(matchlockStart >= 0, "README must have the Matchlock Execution section");
    assert.ok(interactiveStart > matchlockStart, "interactive section must be inside the Matchlock section");
    assert.ok(interactiveEnd > interactiveStart, "interactive section must end at the next H5");
    assert.ok(interactiveSection.length > 0, "interactive section must not be empty");
  });

  it("documents all four subcommands", () => {
    for (const command of [
      "tamandua matchlock pi",
      "tamandua matchlock pi-shell",
      "tamandua matchlock hermes",
      "tamandua matchlock hermes-shell",
    ]) {
      assert.ok(interactiveSection.includes(command), `README must document \`${command}\``);
    }
  });

  it("documents the shared option set, precedence and help", () => {
    for (const token of [
      "--working-directory-for-harness",
      "--matchlock-image",
      "--matchlock-cpus",
      "--matchlock-memory",
      "--matchlock-disk",
      "--matchlock-swap",
      "--matchlock-no-swap",
      "--matchlock-allow-private",
      "--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs",
      "TAMANDUA_MATCHLOCK_IMAGE",
      "TAMANDUA_MATCHLOCK_ALLOW_PRIVATE",
      "igorhvr/tamandua",
      "--help",
    ]) {
      assert.ok(interactiveSection.includes(token), `README must document ${token}`);
    }
    assert.match(interactiveSection, /unknown options are refused/i);
  });

  it("documents the root gate ordering, refusal and exact override", () => {
    assert.match(interactiveSection, /root gate/i);
    assert.match(interactiveSection, /before any Matchlock interaction/i);
    assert.match(interactiveSection, /refused unless the exact override/i);
    assert.match(interactiveSection, /session-scoped/i);
    assert.match(interactiveSection, /never inferred from `SUDO_UID`/);
  });

  it("documents image and identity pinning with no host fallback", () => {
    assert.match(interactiveSection, /tamandua matchlock setup/);
    assert.match(interactiveSection, /pinned and verified/i);
    assert.match(interactiveSection, /no host fallback/i);
    assert.match(interactiveSection, /nothing is pulled, built/i);
  });

  it("documents the configuration and working-directory mounts", () => {
    assert.match(interactiveSection, /identical absolute guest path/i);
    assert.match(interactiveSection, /`PI_CODING_AGENT_DIR`/);
    assert.match(interactiveSection, /guest `HERMES_HOME`/);
    assert.match(interactiveSection, /host `HOME` is never mounted/);
    assert.match(interactiveSection, /recursively chowned or\s+chmodded/);
  });

  it("documents the numeric uid/gid mapping", () => {
    assert.match(interactiveSection, /`owner_uid`\/`owner_gid`/);
    assert.ok(
      interactiveSection.includes('user="<uid>:<gid>"'),
      'README must document the exec user="<uid>:<gid>" mapping',
    );
    assert.match(interactiveSection, /never a host `chown`\/`chmod`/);
  });

  it("documents the pre-launch summary and confirmed cleanup", () => {
    assert.match(interactiveSection, /Before entering the TUI or shell/);
    assert.match(interactiveSection, /pinned digests/);
    assert.match(interactiveSection, /positively confirmed/i);
    assert.match(interactiveSection, /exit status is propagated as the CLI exit status/);
    assert.match(interactiveSection, /killing the RPC child alone is never proof/i);
  });

  it("states the two-level qualification: synthetic fast coverage plus the on-demand real-VM suite", () => {
    // Fast lanes stay synthetic and hermetic; no real VM under `npm test`.
    assert.match(interactiveSection, /synthetically/i);
    assert.match(interactiveSection, /no real VM, no real model call/i);
    assert.match(interactiveSection, /nothing in it runs in `npm test`/i);

    // The in-repo acceptance suite and its flags are documented.
    assert.ok(
      interactiveSection.includes("scripts/tests/matchlock/run-interactive-suite.sh"),
      "README must name the in-repo real-VM acceptance suite entrypoint",
    );
    assert.match(interactiveSection, /--tier t1\|t2\|t3\|t4/);
    assert.match(interactiveSection, /--mode candidate\|installed/);

    // Every tier's scope is described.
    for (const token of [
      "real-VM mechanics",
      "live-model TUI turns",
      "scheduled M7 spot-run",
      "PTY driver self-test",
    ]) {
      assert.ok(interactiveSection.includes(token), `README must describe ${token}`);
    }

    // On demand, operator-run, under the shared gate lock, and NOT deferred.
    assert.match(interactiveSection, /on demand only/i);
    assert.match(interactiveSection, /operator runs/i);
    assert.match(interactiveSection, /gate lock/);
    assert.match(interactiveSection, /vaivm-gate\.lock/);
    assert.doesNotMatch(
      interactiveSection,
      /deferred/i,
      "README must no longer claim real-VM PTY qualification is deferred",
    );
  });

  it("states the writable-mount security caveat", () => {
    assert.match(interactiveSection, /concurrent VMs do not isolate shared files/);
    assert.match(interactiveSection, /execution\s+isolation, not mounted-data protection/);
  });
});

describe("SKILL.md interactive Matchlock documentation (MTLK-INTERACTIVE US-015)", () => {
  it("enumerates the four interactive commands in the command overview", () => {
    for (const command of [
      "tamandua matchlock pi",
      "tamandua matchlock pi-shell",
      "tamandua matchlock hermes",
      "tamandua matchlock hermes-shell",
    ]) {
      assert.ok(skill.includes(command), `SKILL.md must enumerate \`${command}\``);
    }
  });

  it("documents the root override, setup remedy and synthetic-only status", () => {
    assert.ok(
      skill.includes("--force-matchlock-usage-as-root-not-recommended-per-matchlock-docs"),
      "SKILL.md must name the exact root override flag",
    );
    assert.match(skill, /tamandua matchlock setup/);
    assert.match(skill, /synthetically only/i);
    assert.match(skill, /Real-VM PTY qualification/i);

    const start = skill.indexOf("**Interactive Matchlock sessions.**");
    assert.ok(start >= 0, "SKILL.md must carry the interactive sessions paragraph");
    const end = skill.indexOf("\n### ", start);
    const interactive = skill.slice(start, end > start ? end : undefined);
    assert.ok(
      interactive.includes("scripts/tests/matchlock/run-interactive-suite.sh"),
      "SKILL.md must point at the on-demand in-repo real-VM suite",
    );
    assert.doesNotMatch(
      interactive,
      /deferred/i,
      "SKILL.md must no longer claim real-VM qualification is deferred",
    );
  });
});

describe("INTEGRATION-NOTES.md complete provisional gap list (MTLK-INTERACTIVE US-015)", () => {
  it("enumerates every provisional gap with a status and reconciliation instruction", () => {
    for (const gapId of GAP_IDS) {
      assert.match(notes, new RegExp(`^### ${gapId} —`, "m"), `missing gap heading ${gapId}`);
    }

    const gapsStart = notes.indexOf("## 4. Provisional gaps and reconciliation");
    const gapsEnd = notes.indexOf("## 5. Explicitly unavailable real launch paths");
    assert.ok(gapsStart >= 0 && gapsEnd > gapsStart, "gap section must exist");
    const gaps = notes.slice(gapsStart, gapsEnd);
    const parts = gaps.split(/\n### /).slice(1);
    assert.equal(parts.length, GAP_IDS.length, "gap count must match the enumerated list");
    for (const part of parts) {
      const id = part.slice(0, 6);
      assert.match(part, /Reconciliation:/, `${id} must carry reconciliation instructions`);
      assert.match(part, /\*\*Status \(/, `${id} must carry an implementation status line`);
    }
  });

  it("lists the explicitly unavailable real launch paths", () => {
    const unavailableStart = notes.indexOf("## 5. Explicitly unavailable real launch paths");
    assert.ok(unavailableStart >= 0, "unavailable-paths section must exist");
    const unavailable = notes.slice(unavailableStart);
    assert.match(unavailable, /real-VM/i);
    assert.match(unavailable, /pi/i);
    assert.match(unavailable, /hermes/i);
    assert.match(unavailable, /synthetic/i);
    assert.match(unavailable, /clean-refusal scaffolding is NOT feature\s+completion/i);
  });
});
