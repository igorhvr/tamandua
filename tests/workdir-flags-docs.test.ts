/**
 * WORKDIR-FLAGS US-008 — the operator/agent docs quote the refuse/queue/allow
 * contract verbatim.
 *
 * The refusal text is owned by the pure US-001 module
 * (src/installer/workdir-collision.ts). These tests import those constants and
 * assert the docs embed the exact same strings, so documentation drift fails
 * the suite. They also pin the human-facing contract: default refuse with exit
 * code 75, --queue-behind-holder restoring the `waiting` behavior,
 * --allow-multiple-runs-in-one-working-directory / TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1
 * for concurrency, and worktree variants never colliding.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  WORKDIR_ALLOW_ENV_VAR,
  WORKDIR_REFUSAL_EXIT_CODE,
  WORKDIR_REFUSAL_HEADLINE_TEMPLATE,
  WORKDIR_REFUSAL_OPTIONS_TEXT,
} from "../dist/installer/workdir-collision.js";

const repoRoot = resolve(import.meta.dirname, "..");

function readDoc(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), "utf-8");
}

const README = "README.md";
const SKILL = "skills/tamandua-agents/SKILL.md";
const AGENTS = "AGENTS.md";
const ALL_DOCS = [README, SKILL, AGENTS];

const ALLOW_FLAG = "--allow-multiple-runs-in-one-working-directory";
const QUEUE_FLAG = "--queue-behind-holder";
const EXIT_CODE_TEXT = `exit code ${WORKDIR_REFUSAL_EXIT_CODE}`;
const ENV_FORM = `${WORKDIR_ALLOW_ENV_VAR}=1`;

describe("workdir-flags documentation (WORKDIR-FLAGS US-008)", () => {
  for (const name of ALL_DOCS) {
    describe(name, () => {
      const content = readDoc(name);

      it("quotes WORKDIR_REFUSAL_HEADLINE_TEMPLATE verbatim", () => {
        assert.ok(
          content.includes(WORKDIR_REFUSAL_HEADLINE_TEMPLATE),
          `${name} must embed WORKDIR_REFUSAL_HEADLINE_TEMPLATE verbatim`,
        );
      });

      it("quotes WORKDIR_REFUSAL_OPTIONS_TEXT verbatim", () => {
        assert.ok(
          content.includes(WORKDIR_REFUSAL_OPTIONS_TEXT),
          `${name} must embed WORKDIR_REFUSAL_OPTIONS_TEXT verbatim`,
        );
      });

      it("names both ways out, the env form and the exit code", () => {
        assert.ok(content.includes(QUEUE_FLAG), `${name} must name ${QUEUE_FLAG}`);
        assert.ok(content.includes(ALLOW_FLAG), `${name} must name ${ALLOW_FLAG}`);
        assert.ok(content.includes(ENV_FORM), `${name} must name the env form ${ENV_FORM}`);
        assert.ok(content.includes(EXIT_CODE_TEXT), `${name} must state the refusal ${EXIT_CODE_TEXT}`);
      });
    });
  }

  describe("the default is REFUSE and the queue flag restores waiting", () => {
    for (const name of [README, AGENTS]) {
      const content = readDoc(name);

      it(`${name} describes the default as refuse`, () => {
        assert.match(content, /refused by default/i, `${name} must state the default is refuse`);
        assert.ok(content.includes(QUEUE_FLAG), `${name} must name the queue flag as a way out`);
      });

      it(`${name} ties the queue flag to the waiting machinery`, () => {
        assert.match(content, /waiting/i, `${name} must describe the waiting behavior`);
        assert.match(
          content,
          /reconcil|admit/i,
          `${name} must state the queued run is admitted when the holder releases the directory`,
        );
      });
    }
  });

  describe("worktree-mode runs are untouched", () => {
    for (const name of [README, AGENTS]) {
      const content = readDoc(name);

      it(`${name} states worktree runs never collide`, () => {
        assert.match(content, /never collide/i, `${name} must state -worktree variants never collide`);
        assert.match(
          content,
          /worktree-mode runs are untouched/i,
          `${name} must state worktree-mode runs are untouched`,
        );
      });
    }
  });

  describe("SKILL.md governs the allow flag for agents", () => {
    const content = readDoc(SKILL);

    it("states when the allow flag is appropriate", () => {
      assert.match(content, /independent files/i, "SKILL.md must mention independent files");
      assert.match(content, /read-mostly/i, "SKILL.md must mention read-mostly tasks");
      assert.ok(content.includes(ALLOW_FLAG), `SKILL.md must name ${ALLOW_FLAG}`);
      assert.ok(content.includes(ENV_FORM), `SKILL.md must name ${ENV_FORM}`);
    });

    it("makes git-writing runs in one checkout the caller's responsibility", () => {
      assert.match(
        content,
        /git (state|writes)[\s\S]{0,120}caller's responsibility/i,
        "SKILL.md must state concurrent git writes in one checkout are the caller's responsibility",
      );
    });
  });
});
