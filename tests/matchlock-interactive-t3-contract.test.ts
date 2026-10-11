/**
 * MTLK-INTERACTIVE-SUITE US-008 — T3 live-model case contract (M5/M6).
 *
 * `scripts/tests/matchlock/cases/M5.json` and `M6.json` are the configuration-
 * bound T3 (real-VM + live-model) TUI-turn cases: M5 drives `tamandua matchlock
 * pi`, M6 drives `tamandua matchlock hermes`. They are a faithful port of the
 * ACCEPTED W2 `vaimetal` case JSONs
 * (`W2-toolsets-20261009.tar.gz:matrix-v2-w2/vaimetal/cases/M5.json`/`M6.json`);
 * the only changes are the same configuration rebindings US-007 applied to
 * M0–M4 (argv[0]/cwd/workdir/allow-private/digest/uid/gid as `{{MTLK_*}}`
 * placeholders, and the host `env` block dropped because the runner owns the
 * private per-run environment). No assertion is weakened.
 *
 * The live-model tier is env-gated: `lib/common.sh` exposes `mtlk_t3_ready`
 * (explicit `MTLK_T3_ENABLED` AND credentials), `mtlk_t3_notrun_reason` /
 * `mtlk_t3_gate` (a declared NOT-RUN with a reason — never a pass) and
 * `mtlk_t3_disclosure` (an explicit per-run token-spend disclosure line).
 *
 * This file is pure filesystem reads (no child_process, no dist import, no
 * daemon, no VM, no network, no model), so it stays in the parallel lane and
 * needs no tests/serial-files.txt entry. The functional gate behaviour is
 * exercised by the serial `tests/matchlock-interactive-common-config.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const casesDir = path.join(repoRoot, "scripts", "tests", "matchlock", "cases");
const commonPath = path.join(repoRoot, "scripts", "tests", "matchlock", "lib", "common.sh");

const PROMPT_TEXT =
  "What is 111 + 222? Reply with exactly ZX- followed by your answer. Nothing else.";
const ZX_REQUIRE = "ZX\\s*-\\s*333";
/** U+276F, the hermes TUI prompt character. */
const HERMES_PROMPT = "\u276f";
const SHARED_FORBID = ["panicked", "Unhandled [Ee]rror"];

interface CaseEvent {
  wait_for?: string;
  regex?: boolean;
  send?: string;
  send_ctrl?: string;
  sleep?: number;
  required?: boolean;
  timeout_s?: number;
  [key: string]: unknown;
}

interface CaseJson {
  name: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout_s?: number;
  grace_s?: number;
  any_exit?: boolean;
  forbid?: string[];
  events: CaseEvent[];
  [key: string]: unknown;
}

function loadCase(id: string): CaseJson {
  const file = path.join(casesDir, `${id}.json`);
  assert.ok(existsSync(file), `missing T3 case ${file}`);
  return JSON.parse(readFileSync(file, "utf-8")) as CaseJson;
}

function waitFors(c: CaseJson): string[] {
  return c.events.filter((e) => typeof e.wait_for === "string").map((e) => e.wait_for as string);
}

function sends(c: CaseJson): string[] {
  return c.events.filter((e) => typeof e.send === "string").map((e) => e.send as string);
}

/** Extract a top-level `name() { ... }` function body from shell source. */
function functionBody(text: string, name: string): string {
  const marker = `\n${name}() {`;
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `common.sh must define ${name}()`);
  const lines = text.slice(start + 1).split("\n");
  const body: string[] = [];
  for (const line of lines) {
    body.push(line);
    if (body.length > 1 && line === "}") break;
  }
  assert.equal(body[body.length - 1], "}", `could not find the end of ${name}()`);
  return body.join("\n");
}

describe("Matchlock interactive T3 live-model case contract (MTLK-INTERACTIVE-SUITE US-008)", () => {
  it("ships parseable configuration-bound live-model cases M5 and M6", () => {
    const m5 = loadCase("M5");
    const m6 = loadCase("M6");
    assert.match(m5.name, /M5/);
    assert.match(m6.name, /M6/);
    for (const [id, c, command] of [
      ["M5", m5, "pi"],
      ["M6", m6, "hermes"],
    ] as const) {
      assert.equal(c.argv[0], "{{MTLK_TAMANDUA_ARGV0}}", `${id} argv[0] must bind the tamandua token`);
      assert.ok(c.argv.includes("matchlock"), `${id} must invoke the matchlock subcommand`);
      assert.ok(c.argv.includes(command), `${id} must run \`${command}\``);
      assert.ok(c.argv.includes("{{MTLK_WORKDIR}}"), `${id} workdir must bind {{MTLK_WORKDIR}}`);
      assert.ok(c.argv.includes("--matchlock-allow-private"), `${id} must pass --matchlock-allow-private`);
      assert.ok(c.argv.includes("{{MTLK_ALLOW_PRIVATE}}"), `${id} allow-private must bind {{MTLK_ALLOW_PRIVATE}}`);
      assert.equal(c.cwd, "{{MTLK_CWD}}", `${id} cwd must bind {{MTLK_CWD}}`);
      assert.equal(c.env, undefined, `${id} must not carry a host env block; the runner owns env`);
      assert.equal(typeof c.timeout_s, "number", `${id} timeout_s must stay configurable`);
      assert.equal(typeof c.grace_s, "number", `${id} grace_s must stay configurable`);
    }
  });

  it("preserves the M5 '(auto)' mode indicator and the ONE-burst prompt + CR", () => {
    const m5 = loadCase("M5");
    const w = waitFors(m5);
    assert.ok(w.includes("\\(auto\\)"), "M5 must wait for the '(auto)' mode indicator");
    assert.ok(
      m5.events.some((e) => e.send === `${PROMPT_TEXT}\r`),
      "M5 must send the prompt as ONE burst terminated by a single CR",
    );
    assert.ok(!m5.events.some((e) => e.sleep === 2.5), "M5 must NOT split the prompt across a pause");
  });

  it("preserves the M6 telemetry-consent settle, U+276F prompt and SPLIT-SEND pause", () => {
    const m6 = loadCase("M6");
    const w = waitFors(m6);
    assert.ok(w.includes("Help improve Hermes\\?"), "M6 must handle the optional telemetry-consent screen");
    const consent = m6.events.find((e) => e.wait_for === "Help improve Hermes\\?");
    assert.equal(consent?.required, false, "the telemetry-consent wait must stay optional/deterministic");
    assert.ok(
      m6.events.some((e) => e.send === "\r"),
      "M6 must settle the optional consent screen with Enter (deterministic when absent)",
    );
    assert.ok(w.includes(HERMES_PROMPT), "M6 must wait for the U+276F prompt character");
    assert.equal(HERMES_PROMPT.codePointAt(0), 0x276f, "the waited-for character must be U+276F");

    const idx = m6.events.findIndex((e) => e.send === PROMPT_TEXT);
    assert.ok(idx > 0, "M6 must send the prompt text");
    assert.equal(m6.events[idx + 1]?.sleep, 2.5, "M6 must pause ~2.5s between text and CR");
    assert.equal(m6.events[idx + 2]?.send, "\r", "M6 must send the CR as a separate write");
  });

  it("requires ZX-333 on both live-model turns", () => {
    for (const id of ["M5", "M6"]) {
      const c = loadCase(id);
      const zx = c.events.filter((e) => e.wait_for === ZX_REQUIRE);
      assert.equal(zx.length, 1, `${id} must wait exactly once for ${ZX_REQUIRE}`);
      assert.equal(zx[0].regex, true, `${id} ZX requirement must stay a regex`);
    }
  });

  it("keeps any_exit true and the shared forbid list on both cases", () => {
    for (const id of ["M5", "M6"]) {
      const c = loadCase(id);
      assert.equal(c.any_exit, true, `${id} any_exit must be true`);
      assert.deepEqual(c.forbid, SHARED_FORBID, `${id} forbid list changed`);
      assert.equal(c.expected_exit_code, undefined, `${id} must not pin an exit code`);
    }
  });

  it("contains no 64-hex digest literal, host path, endpoint literal or backend name", () => {
    for (const id of ["M5", "M6"]) {
      const text = readFileSync(path.join(casesDir, `${id}.json`), "utf-8");
      assert.doesNotMatch(text, /\b[0-9a-f]{64}\b/i, `${id} must not contain a literal 64-hex digest`);
      assert.doesNotMatch(text, /\b(?:firecracker|qemu)\b/i, `${id} must not name a matchlock backend`);
      for (const literal of ["/home/", "/Users/", "li155-matrix", "dogfood", "/opt/tamandua", "ai.iasylum.net"]) {
        assert.ok(!text.includes(literal), `${id} must not contain the host literal ${literal}`);
      }
      for (const match of text.matchAll(/\{\{(MTLK_[A-Za-z0-9_]*)\}\}/g)) {
        const declared = [
          "MTLK_TAMANDUA_ARGV0",
          "MTLK_CWD",
          "MTLK_WORKDIR",
          "MTLK_ALLOW_PRIVATE",
          "MTLK_MODEL_HOST",
          "MTLK_EXPECT_DIGEST",
          "MTLK_UID",
          "MTLK_GID",
        ];
        assert.ok(declared.includes(match[1]), `${id} references undeclared placeholder ${match[0]}`);
      }
    }
  });

  it("gates T3 on MTLK_T3_ENABLED AND credentials and records NOT-RUN with a reason", () => {
    const common = readFileSync(commonPath, "utf-8");
    const ready = functionBody(common, "mtlk_t3_ready");
    assert.match(ready, /mtlk_is_truthy[^\n]*MTLK_T3_ENABLED/, "T3 must require explicit MTLK_T3_ENABLED");
    assert.match(ready, /mtlk_t3_credentials_present/, "T3 must require model credentials");

    const reason = functionBody(common, "mtlk_t3_notrun_reason");
    assert.match(reason, /t3-disabled:MTLK_T3_ENABLED-not-set/, "a disabled T3 must have a declared reason");
    assert.match(reason, /t3-credentials-absent:/, "absent credentials must have a declared reason");

    const gate = functionBody(common, "mtlk_t3_gate");
    assert.match(gate, /mtlk_t3_ready/, "the gate must consult the ready check");
    assert.match(gate, /T3-NOTRUN %s/, "the gate must print an explicit T3-NOTRUN verdict");
    assert.match(gate, /verdict=NOTRUN/, "the gate must record verdict=NOTRUN evidence");
    assert.match(gate, /t3-notrun\.txt/, "the NOT-RUN reason must be recorded as evidence");
    assert.ok(!/\bPASS\b/.test(gate), "the gate must never manufacture a T3 PASS");
  });

  it("records an explicit token-spend disclosure when T3 executes", () => {
    const common = readFileSync(commonPath, "utf-8");
    const line = functionBody(common, "mtlk_t3_disclosure_line");
    assert.match(line, /TOKEN-SPEND-DISCLOSURE/, "there must be an explicit token-spend disclosure line");
    assert.match(line, /tier=t3/, "the disclosure must name the T3 tier");
    assert.match(line, /MTLK_MODEL_ENDPOINT/, "the disclosure must name the configured endpoint");

    const disclosure = functionBody(common, "mtlk_t3_disclosure");
    assert.match(disclosure, /mtlk_t3_disclosure_line/, "the disclosure writer must use the line");
    assert.match(disclosure, /token-spend\.txt/, "the disclosure must be recorded as evidence");

    const gate = functionBody(common, "mtlk_t3_gate");
    assert.match(gate, /mtlk_t3_disclosure/, "a ready T3 gate must record the token-spend disclosure");
  });
});
