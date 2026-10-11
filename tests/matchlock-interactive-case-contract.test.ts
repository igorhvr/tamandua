/**
 * MTLK-INTERACTIVE-SUITE US-007 — T2 mechanics case contract (M0–M4).
 *
 * `scripts/tests/matchlock/cases/M0.json` … `M4.json` are the configuration-bound
 * T2 (real-VM, model-free) mechanics cases. They are a faithful port of the
 * ACCEPTED W2 `vaimetal` case JSONs
 * (`W2-toolsets-20261009.tar.gz:matrix-v2-w2/vaimetal/cases/M0..M4.json`); the
 * only changes are configuration rebindings, which may never weaken an
 * assertion:
 *
 *   - `argv[0]` -> `{{MTLK_TAMANDUA_ARGV0}}` (the resolved tamandua token);
 *   - the harness workdir / mount-write-through path -> `{{MTLK_WORKDIR}}`;
 *   - `--matchlock-allow-private` -> `{{MTLK_ALLOW_PRIVATE}}` (the egress URL
 *     uses the same spelling; the DNS diagnostic uses `{{MTLK_MODEL_HOST}}`);
 *   - the image digest -> `{{MTLK_EXPECT_DIGEST}}` (never a literal);
 *   - the guest identity -> `{{MTLK_UID}}`/`{{MTLK_GID}}` (host-derived, so ONE
 *     case set serves vaimetal and mac);
 *   - `cwd` -> `{{MTLK_CWD}}`;
 *   - the historical per-case `env` block (host state dir + host PATH) is
 *     DROPPED: the runner owns the environment so the private per-run
 *     HOME/TMPDIR/TAMANDUA_STATE_DIR/PATH is never clobbered. `env` carried no
 *     assertion.
 *
 * Everything else — every `require`, `forbid`, `wait_for` pattern, the swap
 * banner spellings, the `[30,100]` resize, `any_exit`/`require_terminal_restored`
 * and the exit codes — is preserved exactly (the round-trip against the W2
 * source is tracked in the port report, US-013).
 *
 * This file is pure filesystem reads (no child_process, no dist import, no
 * daemon, no VM, no network), so it stays in the parallel lane and needs no
 * tests/serial-files.txt entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const casesDir = path.join(repoRoot, "scripts", "tests", "matchlock", "cases");

const CASE_IDS = ["M0", "M1", "M2", "M3", "M4"] as const;
type CaseId = (typeof CASE_IDS)[number];

interface CaseEvent {
  wait_for?: string;
  regex?: boolean;
  send?: string;
  send_ctrl?: string;
  sleep?: number;
  resize?: [number, number];
  close_master?: boolean;
  signal?: string;
  timeout_s?: number;
  required?: boolean;
  [key: string]: unknown;
}

interface CaseJson {
  name: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  term?: string;
  rows?: number;
  cols?: number;
  timeout_s?: number;
  grace_s?: number;
  expected_exit_code?: number;
  expected_exit_codes?: number[];
  any_exit?: boolean;
  require_terminal_restored?: boolean;
  forbid?: string[];
  require?: string[];
  mntchk?: boolean;
  events: CaseEvent[];
  [key: string]: unknown;
}

/** The PROTECTED require sets, copied verbatim from the accepted W2 cases. */
const PROTECTED_REQUIRE: Record<CaseId, string[]> = {
  M0: [
    "MNT-[0-9]+-END",
    "EGRESS http=200",
    "TOOL pi: /",
    "TOOL hermes: /",
    "TOOL zsh: /",
    "TOOL curl: /",
    "TOOL node: /",
    "TOOL bash: /",
  ],
  M1: ["SWAPCHK-8[0-9]{6}-END", "30 100", "MNT-[0-9]+-END"],
  M2: ["SWAPCHK-4[0-9]{6}-END", "MNT-[0-9]+-END"],
  M3: ["SWAPCHK-0-END", "MNT-[0-9]+-END"],
  M4: ["MNT-[0-9]+-END"],
};

/** The PROTECTED forbid lists, copied verbatim from the accepted W2 cases. */
const PROTECTED_FORBID: Record<CaseId, string[]> = {
  M0: ["panicked", "Unhandled [Ee]rror"],
  M1: ["panicked", "Unhandled [Ee]rror", "no such file or directory: .*matchlock"],
  M2: ["panicked", "Unhandled [Ee]rror", "no such file or directory: .*matchlock"],
  M3: ["panicked", "Unhandled [Ee]rror", "no such file or directory: .*matchlock"],
  M4: ["panicked", "Unhandled [Ee]rror", "no such file or directory: .*matchlock"],
};

const IMAGE_IDENTITY =
  "image identity: tag=igorhvr/tamandua digest={{MTLK_EXPECT_DIGEST}} config=sha256:[0-9a-f]{64}";
const GUEST_IDENTITY = "guest identity: uid={{MTLK_UID}} gid={{MTLK_GID}}";
const IMAGE_PROVENANCE = "image provenance: standard";

/** The exact accepted swap banner, with the swap spelling substituted. */
function banner(swap: string): string {
  return `matchlock: igorhvr/tamandua( \\(standard image\\))? cpus=\\d+ memory=\\d+MB disk=\\d+MB swap=${swap}`;
}

/** All `wait_for` patterns in event order. */
function waitFors(c: CaseJson): string[] {
  return c.events.filter((e) => typeof e.wait_for === "string").map((e) => e.wait_for as string);
}

/** All `send` payloads in event order. */
function sends(c: CaseJson): string[] {
  return c.events.filter((e) => typeof e.send === "string").map((e) => e.send as string);
}

function loadCase(id: CaseId): CaseJson {
  const file = path.join(casesDir, `${id}.json`);
  assert.ok(existsSync(file), `missing T2 case ${file}`);
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as CaseJson;
  assert.equal(typeof parsed, "object");
  return parsed;
}

describe("Matchlock interactive T2 mechanics case contract (MTLK-INTERACTIVE-SUITE US-007)", () => {
  it("ships parseable configuration-bound cases M0–M4", () => {
    for (const id of CASE_IDS) {
      const c = loadCase(id);
      assert.equal(typeof c.name, "string", `${id} must have a name`);
      assert.ok(Array.isArray(c.argv), `${id} must have an argv array`);
      assert.ok(Array.isArray(c.events), `${id} must have an events array`);
      // Executable + cwd are configuration-bound, never host literals.
      assert.equal(c.argv[0], "{{MTLK_TAMANDUA_ARGV0}}", `${id} argv[0] must bind the tamandua token`);
      assert.equal(c.cwd, "{{MTLK_CWD}}", `${id} cwd must bind {{MTLK_CWD}}`);
      // The runner owns the environment (private state/HOME/TMPDIR/PATH).
      assert.equal(c.env, undefined, `${id} must not carry a host env block; the runner owns env`);
      assert.equal(typeof c.timeout_s, "number", `${id} timeout_s must stay a configurable number`);
      assert.equal(typeof c.grace_s, "number", `${id} grace_s must stay a configurable number`);
    }
  });

  it("preserves every protected require set and forbid list exactly", () => {
    for (const id of CASE_IDS) {
      const c = loadCase(id);
      assert.deepEqual(c.require, PROTECTED_REQUIRE[id], `${id} require set changed`);
      assert.deepEqual(c.forbid, PROTECTED_FORBID[id], `${id} forbid list changed`);
    }
  });

  it("preserves the image provenance/identity + guest identity + mount assertions (M0–M4)", () => {
    for (const id of CASE_IDS) {
      const c = loadCase(id);
      const w = waitFors(c);
      assert.ok(w.includes(IMAGE_PROVENANCE), `${id} must wait for image provenance`);
      assert.ok(w.includes(IMAGE_IDENTITY), `${id} must wait for the image identity/digest`);
      assert.ok(w.includes(GUEST_IDENTITY), `${id} must wait for the guest identity`);
      assert.equal(c.mntchk, true, `${id} must declare the mount write-through check`);
      assert.ok(
        sends(c).some((s) => s.includes(`MNTCHK-${id}-`) && s.includes(`{{MTLK_WORKDIR}}/.mntchk-${id}.txt`)),
        `${id} must write the mount nonce through the bound workdir`,
      );
    }
  });

  it("preserves the M1 PTY resize and duplicate swap spellings exactly", () => {
    const c = loadCase("M1");
    const w = waitFors(c);
    assert.ok(w.includes(banner("8192MB")), "M1 banner swap=8192MB spelling changed");
    assert.ok(w.includes("24 80"), "M1 must observe the initial 24x80 size");
    assert.ok(w.includes("30 100"), "M1 must observe the resized 30x100 size");
    const resizes = c.events.filter((e) => Array.isArray(e.resize)).map((e) => e.resize);
    assert.deepEqual(resizes, [[30, 100]], "M1 must resize the PTY to [30,100]");
    assert.ok(
      sends(c).some((s) => s.includes("/proc/swaps") && s.includes("SWAPCHK-%s-END")),
      "M1 must read the exact /proc/swaps sum",
    );
    assert.equal(c.expected_exit_code, 0, "M1 must exit 0");
  });

  it("preserves the M2 hermes-shell --matchlock-swap 4096 semantics", () => {
    const c = loadCase("M2");
    assert.ok(c.argv.includes("hermes-shell"), "M2 must run hermes-shell");
    assert.ok(c.argv.includes("--matchlock-swap") && c.argv.includes("4096"), "M2 must pass --matchlock-swap 4096");
    assert.ok(waitFors(c).includes(banner("4096MB")), "M2 banner swap=4096MB spelling changed");
    assert.equal(c.expected_exit_code, 0, "M2 must exit 0");
  });

  it("preserves the M3 no-swap / exit-code-7 semantics", () => {
    const c = loadCase("M3");
    assert.ok(c.argv.includes("--matchlock-no-swap"), "M3 must pass --matchlock-no-swap");
    assert.ok(waitFors(c).includes(banner("off")), "M3 banner swap=off spelling changed");
    assert.ok(
      c.events.some((e) => e.send === "printf 'SWAPCHK-%s-END\\n' \"$(awk 'NR>1{s+=$3} END{print s+0}' /proc/swaps)\"\n"),
      "M3 must read the exact /proc/swaps sum",
    );
    assert.ok(c.events.some((e) => e.wait_for === "SWAPCHK-0-END"), "M3 must require SWAPCHK-0-END exactly");
    assert.ok(sends(c).includes("exit 7\n"), "M3 must exit the guest shell with 7");
    assert.equal(c.expected_exit_code, 7, "M3 expected_exit_code must be 7");
  });

  it("preserves the M4 close_master disconnect permissiveness", () => {
    const c = loadCase("M4");
    assert.ok(waitFors(c).includes(banner("8192MB")), "M4 banner swap=8192MB spelling changed");
    assert.ok(
      c.events.some((e) => e.close_master === true),
      "M4 must close the PTY master to simulate a disconnect",
    );
    assert.equal(c.any_exit, true, "M4 any_exit must be true");
    assert.equal(c.require_terminal_restored, false, "M4 must not require terminal restoration");
    assert.equal(c.expected_exit_code, undefined, "M4 must not pin an exit code");
    assert.ok(!sends(c).includes("exit\n"), "M4 must disconnect, not send an explicit exit");
  });

  it("binds the M0 preflight to configuration, not host literals", () => {
    const c = loadCase("M0");
    const a = c.argv;
    assert.ok(a.includes("--working-directory-for-harness"), "M0 must pass the harness workdir");
    assert.ok(a.includes("{{MTLK_WORKDIR}}"), "M0 workdir must be the {{MTLK_WORKDIR}} binding");
    assert.ok(a.includes("--matchlock-allow-private"), "M0 must pass --matchlock-allow-private");
    assert.ok(a.includes("{{MTLK_ALLOW_PRIVATE}}"), "M0 allow-private must be the {{MTLK_ALLOW_PRIVATE}} binding");
    const s = sends(c).join("\n");
    assert.ok(s.includes("getent ahosts {{MTLK_MODEL_HOST}}"), "M0 DNS diagnostic must bind {{MTLK_MODEL_HOST}}");
    assert.ok(
      s.includes("http://{{MTLK_ALLOW_PRIVATE}}/v1/models"),
      "M0 egress probe must bind {{MTLK_ALLOW_PRIVATE}}",
    );
    assert.ok(
      s.includes("for t in pi hermes zsh curl node bash"),
      "M0 must check the exact tool set pi hermes zsh curl node bash",
    );
    assert.equal(c.expected_exit_code, 0, "M0 must exit 0");
  });

  it("contains no 64-hex image digest literal and no backend name", () => {
    const files = readdirSync(casesDir).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= CASE_IDS.length, "expected the M0–M4 JSON files in cases/");
    for (const file of files) {
      const text = readFileSync(path.join(casesDir, file), "utf-8");
      assert.doesNotMatch(text, /\b[0-9a-f]{64}\b/i, `${file} must not contain a literal 64-hex digest`);
      assert.doesNotMatch(text, /\b(?:firecracker|qemu)\b/i, `${file} must not name a matchlock backend`);
    }
  });

  it("contains no host-specific path or endpoint literal", () => {
    const files = readdirSync(casesDir).filter((f) => f.endsWith(".json"));
    const forbidden = ["/home/", "/Users/", "li155-matrix", "dogfood", "/opt/tamandua"];
    for (const file of files) {
      const text = readFileSync(path.join(casesDir, file), "utf-8");
      for (const literal of forbidden) {
        assert.ok(!text.includes(literal), `${file} must not contain the host literal ${literal}`);
      }
    }
  });

  it("uses only declared {{MTLK_*}} placeholders", () => {
    const declared = new Set([
      "MTLK_TAMANDUA_ARGV0",
      "MTLK_CWD",
      "MTLK_WORKDIR",
      "MTLK_ALLOW_PRIVATE",
      "MTLK_MODEL_HOST",
      "MTLK_EXPECT_DIGEST",
      "MTLK_UID",
      "MTLK_GID",
    ]);
    const files = readdirSync(casesDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const text = readFileSync(path.join(casesDir, file), "utf-8");
      for (const match of text.matchAll(/\{\{(MTLK_[A-Za-z0-9_]*)\}\}/g)) {
        assert.ok(
          declared.has(match[1]),
          `${file} references undeclared placeholder ${match[0]}; add the binding or use an existing one`,
        );
      }
    }
    // Every declared configuration binding must actually be exercised by the set.
    const all = files.map((f) => readFileSync(path.join(casesDir, f), "utf-8")).join("\n");
    for (const name of declared) {
      assert.ok(all.includes(`{{${name}}}`), `no case exercises the {{${name}}} binding`);
    }
  });
});
