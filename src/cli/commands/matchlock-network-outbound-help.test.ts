/**
 * NAT-EGRESS US-011 — documentation/help consistency guard.
 *
 * Every user-visible Matchlock help surface must advertise the SAME feature
 * contract for `--matchlock-unrestricted-outbound-networking`:
 *
 *   - the exact flag and the exact `TAMANDUA_MATCHLOCK_UNRESTRICTED_NETWORKING=1`
 *     environment form (both come from the leaf module, so a rename cannot
 *     silently drift away from the help text),
 *   - the default (interception stays ON, private destinations stay blocked),
 *   - EVERY conflict name that can be refused,
 *   - the "mode is chosen at CREATION" lifecycle rule and the resume refusal,
 *   - NO advertisement of a network-mode transition/resume-transition (out of
 *     scope for this feature),
 *   - NO claim of real-VM networking qualification (this change is
 *     implementation + unit/fast tests only; real-VM UDP/private/TCP
 *     qualification happens after it lands).
 *
 * The four interactive subcommand helps embed the shared options block, so they
 * are asserted alongside the group help — a subcommand cannot drop the flag.
 *
 * Serial lane: the command modules reach spawn-capable installer modules, so
 * this file is registered in `tests/serial-files.txt`. Nothing here spawns a
 * process or creates a VM.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getMatchlockHelp,
  getMatchlockHermesHelp,
  getMatchlockHermesShellHelp,
  getMatchlockPiHelp,
  getMatchlockPiShellHelp,
} from "../../../dist/cli/commands/matchlock.js";
import { getWorkflowRunHelp } from "../../../dist/cli/commands/workflow.js";
import {
  MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV,
  MATCHLOCK_UNRESTRICTED_OUTBOUND_FLAG,
} from "../../../dist/installer/matchlock/network-outbound.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/** The documented spellings. Frozen here so a rename must touch both sides. */
const FLAG = "--matchlock-unrestricted-outbound-networking";
const ENV = "TAMANDUA_MATCHLOCK_UNRESTRICTED_NETWORKING";

/** Collapse the wrapped help layout so phrase assertions are layout-proof. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const INTERACTIVE_SURFACES: Array<{ name: string; text: () => string }> = [
  { name: "tamandua matchlock --help", text: getMatchlockHelp },
  { name: "tamandua matchlock pi --help", text: getMatchlockPiHelp },
  { name: "tamandua matchlock pi-shell --help", text: getMatchlockPiShellHelp },
  { name: "tamandua matchlock hermes --help", text: getMatchlockHermesHelp },
  { name: "tamandua matchlock hermes-shell --help", text: getMatchlockHermesShellHelp },
];

/** Every conflict side documented for the interactive surfaces. */
const INTERACTIVE_CONFLICT_NAMES = [
  "--matchlock-allow-private",
  "TAMANDUA_MATCHLOCK_ALLOW_PRIVATE",
  "--matchlock-prioritize-ipv4-dns-resolution",
  "--matchlock-prioritize-ipv6-dns-resolution",
  "TAMANDUA_MATCHLOCK_DNS_PRIORITY",
];

/**
 * Every conflict side documented for `workflow run`. The workflow surface
 * exposes no per-run DNS-priority FLAG (documented explicitly), so the DNS
 * conflict is the environment variable.
 */
const WORKFLOW_CONFLICT_NAMES = [
  "--matchlock-allow-private",
  "TAMANDUA_MATCHLOCK_ALLOW_PRIVATE",
  "TAMANDUA_MATCHLOCK_DNS_PRIORITY",
];

/**
 * No help text (or doc) may advertise a network-mode transition. There is no
 * transition endpoint and no resume transition: the mode is fixed at creation.
 */
function assertNoTransitionAdvertisement(surface: string, normalized: string): void {
  assert.doesNotMatch(
    normalized,
    /\btransition\b/i,
    `${surface} must not advertise a network-mode transition/resume-transition`,
  );
  assert.doesNotMatch(
    normalized,
    /\b(?:switch|change)\s+(?:the\s+)?(?:network|egress|outbound)\s+mode\b/i,
    `${surface} must not advertise changing the network mode of an existing run`,
  );
}

/** No surface may claim real-VM networking qualification for this change. */
function assertNoRealVmQualificationClaim(surface: string, text: string): void {
  assert.doesNotMatch(
    text,
    /real[-\s]?VM/i,
    `${surface} must not claim real-VM networking qualification for this change`,
  );
}

describe("NAT-EGRESS docs/help consistency", () => {
  it("the leaf constants match the documented flag/env spellings", () => {
    assert.equal(MATCHLOCK_UNRESTRICTED_OUTBOUND_FLAG, FLAG);
    assert.equal(MATCHLOCK_UNRESTRICTED_OUTBOUND_ENV, ENV);
  });

  for (const surface of INTERACTIVE_SURFACES) {
    describe(surface.name, () => {
      it("documents the exact flag and the exact env form", () => {
        const text = surface.text();
        assert.ok(text.includes(FLAG), `${surface.name} must document ${FLAG}`);
        assert.ok(
          text.includes(`${ENV}=1`),
          `${surface.name} must document ${ENV}=1 as the environment form`,
        );
      });

      it("states the default-interception wording and the flag source precedence", () => {
        const normalized = normalize(surface.text());
        assert.ok(
          normalized.includes(
            "egress interception stays ON and private destinations stay blocked",
          ),
          `${surface.name} must state the default (interception ON, private blocked)`,
        );
        assert.match(normalized, /default intercepted/i);
        assert.match(
          normalized,
          /network --matchlock-unrestricted-outbound-networking > TAMANDUA_MATCHLOCK_UNRESTRICTED_NETWORKING=1 > default intercepted/,
        );
      });

      it("names every conflict side", () => {
        const normalized = normalize(surface.text());
        for (const conflict of INTERACTIVE_CONFLICT_NAMES) {
          assert.ok(
            normalized.includes(conflict),
            `${surface.name} must name the conflict side ${conflict}`,
          );
        }
      });

      it("does not advertise a network-mode transition", () => {
        assertNoTransitionAdvertisement(surface.name, normalize(surface.text()));
      });

      it("does not claim real-VM networking qualification", () => {
        assertNoRealVmQualificationClaim(surface.name, surface.text());
      });
    });
  }

  describe("tamandua workflow run --help", () => {
    it("documents the exact flag, env form and opt-in requirement", () => {
      const normalized = normalize(getWorkflowRunHelp());
      assert.ok(normalized.includes(FLAG));
      assert.ok(normalized.includes(`${ENV}=1`));
      assert.match(normalized, /Requires --matchlock or --matchlock-image <image>/);
    });

    it("states the default-interception wording", () => {
      const normalized = normalize(getWorkflowRunHelp());
      assert.ok(
        normalized.includes(
          "Default (neither flag nor env): egress interception stays ON and private destinations stay blocked",
        ),
        "workflow run help must state the default interception behaviour",
      );
      assert.match(normalized, /default intercepted/i);
    });

    it("names every applicable conflict side and the missing DNS-priority flag", () => {
      const normalized = normalize(getWorkflowRunHelp());
      for (const conflict of WORKFLOW_CONFLICT_NAMES) {
        assert.ok(normalized.includes(conflict), `must name the conflict side ${conflict}`);
      }
      assert.match(
        normalized,
        /workflow run exposes no per-run DNS-priority flag/,
        "workflow run help must state that it exposes no per-run DNS-priority flag",
      );
    });

    it("states that the mode is fixed at creation and resume refuses the flag", () => {
      const normalized = normalize(getWorkflowRunHelp());
      assert.match(normalized, /mode is fixed when the run is CREATED/);
      assert.match(
        normalized,
        /passing this flag to ["']?workflow resume["']? is refused \(create a new run instead\)/,
      );
    });

    it("does not advertise a network-mode transition", () => {
      assertNoTransitionAdvertisement("tamandua workflow run --help", normalize(getWorkflowRunHelp()));
    });

    it("does not claim real-VM networking qualification and keeps the synthetic-fixture statement", () => {
      const text = getWorkflowRunHelp();
      assertNoRealVmQualificationClaim("tamandua workflow run --help", text);
      assert.match(
        normalize(text),
        /Matchlock paths in this build are synthetic-fixture qualified, not real-model acceptance/,
      );
    });
  });

  describe("README Matchlock outbound networking section", () => {
    function readmeNetworkSection(): string {
      const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
      const start = readme.indexOf("Matchlock outbound networking");
      assert.notEqual(start, -1, "README must document the outbound networking flag");
      const rest = readme.slice(start);
      const nextHeading = rest.search(/\n#{3,6} /);
      return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    }

    it("documents the flag, env form and the creation-time rule", () => {
      const section = readmeNetworkSection();
      assert.ok(section.includes(FLAG));
      assert.ok(section.includes(`${ENV}=1`));
      assert.match(normalize(section), /interception ON by default/i);
      assert.match(
        normalize(section),
        /mode is chosen when the run\/session is \*\*created\*\*/i,
      );
      assert.match(normalize(section), /can never be widened/i);
    });

    it("does not claim real-VM networking qualification", () => {
      assertNoRealVmQualificationClaim("README outbound networking section", readmeNetworkSection());
    });
  });
});
