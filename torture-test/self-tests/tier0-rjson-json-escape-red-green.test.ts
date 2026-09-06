// RJSON US-001 — pure red/green regression for tt-recorder's _json_escape.
//
// Beads tamandua-0j7.4.2 defect: bin/tt-recorder's _json_escape piped its
// input through a LINE-ORIENTED sed filter, so embedded and trailing LF
// never reached the s/\x0a/\\n/ substitution and survived as literal line
// breaks; wrapping the output in quotes made JSON.parse reject it. Other C0
// controls were replaced with '?' (lossy), and the GNU `\xHH` sed escapes /
// bracket classes are fragile on BSD/macOS sed.
//
// This regression exercises the ACTUAL helper — it sources the live repo
// file torture-test/bin/tt-recorder in a fresh bash subprocess and calls
// _json_escape on synthetic inputs (whole-file sourcing is safe: main() only
// runs when BASH_SOURCE == $0, and the top level performs no I/O or state
// writes). It is a pure red/green guard: run it against the unmodified
// (broken) helper and the confirmed LF / control cases fail (RED); after the
// escaping-boundary fix the same file passes (GREEN). Evidence for both
// phases is recorded in torture-test/impl-tasks/RJSON-us001-json-escape-
// red-green-evidence/.
//
// Hermetic and bounded: spawns only `bash` subprocesses that source the repo
// file and call the pure helper; no temp dirs, no process scans, no ports,
// no user state, no writes outside the child's stdout. The child inherits
// the runner's environment, so the test isolation guard stays ENABLED — the
// pure helper never imports tamandua modules or touches tamandua state, so
// nothing can trip it. No NUL case exists by construction: a NUL byte cannot
// be carried in a shell variable (or an argv element), so NUL can never
// reach _json_escape — the helper states that limitation in a comment rather
// than pretending to handle it.
//
// Picked up by self-tests/run.sh's `tier0-*.test.ts` glob (no run.sh edit).
// Zero tokens; confined to torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const recorderRel = path.join("torture-test", "bin", "tt-recorder");
const recorderPath = path.join(repoRoot, recorderRel);

assert.ok(
  fs.existsSync(recorderPath),
  `cannot find the real helper at ${recorderPath} — run this test from the repo root`,
);
const recorderText = fs.readFileSync(recorderPath, "utf8");
assert.ok(
  /_json_escape\(\)/.test(recorderText),
  `${recorderRel} must still define the _json_escape helper (interface pin)`,
);

// ── helpers ────────────────────────────────────────────────────────────

/** Source the live repo tt-recorder in a fresh bash and run
 *  `_json_escape "$2"` on `input`; returns the helper's stdout (the JSON
 *  string CONTENT, no surrounding quotes, no trailing newline). The child
 *  inherits the runner's environment untouched — the test isolation guard
 *  stays ENABLED (no TAMANDUA_TEST_GUARD=0 / NODE_TEST_CONTEXT removal):
 *  the child is plain `bash` executing pure builtins against argv data, so
 *  it neither imports tamandua modules nor touches tamandua state, and the
 *  guard has nothing to trip on. */
function escapeThroughHelper(input: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(
    "bash",
    [
      "-c",
      // $0 = "rjson-escape" (so the BASH_SOURCE == $0 guard skips main),
      // $1 = recorder path, $2 = the synthetic input (argv data — never
      // interpolated into the script text).
      'source "$1" >/dev/null || { echo "source failed" >&2; exit 90; }; _json_escape "$2"',
      "rjson-escape",
      recorderPath,
      input,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

/** Assert the exact JSON.parse round trip for one synthetic input:
 *  JSON.parse('"' + escaped + '"') must return the input bytes exactly,
 *  and the escaped content must contain no physical LF/CR byte (the JSONL
 *  one-physical-line-per-record contract). */
function assertRoundTrip(name: string, input: string): string {
  const { status, stdout, stderr } = escapeThroughHelper(input);
  assert.equal(
    status,
    0,
    `${name}: _json_escape exited ${status}; stderr: ${JSON.stringify(stderr)}`,
  );
  assert.ok(
    !stdout.includes("\n") && !stdout.includes("\r"),
    `${name}: escaped output contains a physical line-break byte: ${JSON.stringify(stdout)}`,
  );
  let parsed: unknown;
  try {
    // Plain concatenation (never a template literal): the escaped content is
    // data, and '$'/'`' inside it must not be re-interpreted.
    parsed = JSON.parse('"' + stdout + '"');
  } catch (err) {
    assert.fail(
      `${name}: JSON.parse rejected the escaped content ${JSON.stringify(stdout)}: ${String(err)}`,
    );
  }
  assert.equal(parsed, input, `${name}: JSON.parse round trip mismatch`);
  return stdout;
}

/** Assert the escaped content for a one-special-char input is exactly the
 *  documented JSON escape (lossless control encoding, never '?' / raw). */
function assertExactEscape(name: string, input: string, expected: string): void {
  const escaped = assertRoundTrip(name, input);
  assert.equal(escaped, expected, `${name}: exact escape mismatch`);
}

// ── the guard ──────────────────────────────────────────────────────────

describe("RJSON US-001 — _json_escape valid lossless JSON string content (pure red/green)", () => {
  it("round-trips every representable input exactly through JSON.parse", () => {
    const cases: Array<{ name: string; input: string }> = [
      { name: "empty string", input: "" },
      { name: "plain ASCII", input: "plain text 123!@#" },
      { name: "double quote", input: 'say "hi" there' },
      { name: "backslash", input: "a\\b\\c" },
      { name: "quote + backslash mix", input: 'q"b\\q" end' },
      { name: "single quote passthrough", input: "it's fine" },
      { name: "leading LF", input: "\nlead" },
      { name: "embedded LF", input: "a\nb" },
      { name: "trailing LF", input: "trail\n" },
      { name: "consecutive LF", input: "a\n\n\nb\n" },
      { name: "CRLF then LF", input: "a\r\nb\nc" },
      { name: "CR only", input: "a\rb" },
      { name: "tab", input: "a\tb\t" },
      { name: "C0 boundary 0x01", input: "\x01" },
      { name: "C0 boundary 0x07", input: "\x07" },
      { name: "C0 boundary 0x0b (VT)", input: "\x0b" },
      { name: "C0 boundary 0x0e", input: "\x0e" },
      { name: "C0 boundary 0x1f", input: "\x1f" },
      { name: "DEL 0x7f", input: "\x7f" },
      { name: "non-ASCII UTF-8 multibyte", input: "héllo wörld — 日本語 ☃ 🚀" },
      {
        name: "kitchen sink (LF/CRLF/tab/quote/backslash/C0/DEL/unicode/trailing LF)",
        input: "line1 \"q\" \\ \t tab\r\nline2\x01\x1f\x7f end\n",
      },
      { name: "trailing LF after unicode", input: "café\n" },
    ];
    for (const c of cases) {
      assertRoundTrip(c.name, c.input);
    }
  });

  it("escapes every C0 control and DEL losslessly in one sweep (no raw bytes, no '?')", () => {
    // Every C0 byte representable in a shell variable (0x01-0x1f; NUL cannot
    // be carried in a shell variable, so it is absent by construction) plus
    // DEL, in one multiline string.
    const sweep = "\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f" +
      "\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f\x7f";
    const escaped = assertRoundTrip("full C0 + DEL sweep", sweep);
    for (const ch of sweep) {
      assert.ok(
        !escaped.includes(ch),
        `escaped output still contains the raw byte ${JSON.stringify(ch)} — controls must be JSON-escaped`,
      );
    }
    assert.ok(!escaped.includes("?"), "escaped output must never replace controls with '?'");
    // Exact escape spellings for the named JSON short forms.
    assertExactEscape("backspace maps to \\b", "\b", "\\b");
    assertExactEscape("tab maps to \\t", "\t", "\\t");
    assertExactEscape("LF maps to \\n", "\n", "\\n");
    assertExactEscape("FF maps to \\f", "\f", "\\f");
    assertExactEscape("CR maps to \\r", "\r", "\\r");
    assertExactEscape("quote maps to \\\"", '"', '\\"');
    assertExactEscape("backslash maps to \\\\", "\\", "\\\\");
    assertExactEscape("0x01 maps to \\u0001", "\x01", "\\u0001");
    assertExactEscape("0x1f maps to \\u001f", "\x1f", "\\u001f");
    assertExactEscape("DEL maps to \\u007f", "\x7f", "\\u007f");
  });

  it("emits exactly one physical output line for multiline framing", () => {
    const multiline = "first \"line\" \\ here\nsecond line\r\nthird\ttabbed\n";
    const escaped = assertRoundTrip("multiline framing", multiline);
    assert.equal(
      (escaped.match(/\n/g) ?? []).length,
      0,
      `escaped content must contain zero physical LF bytes, got ${JSON.stringify(escaped)}`,
    );
    // The whole escaped content is one physical line: when written to a file
    // it must not split the record.
    const physicalLines = escaped.split("\n");
    assert.equal(physicalLines.length, 1, "escaped content must be a single physical line");
  });

  it("handles long inputs in bounded time (no per-byte blowup) with exact round trips", () => {
    // The repair must not regress the recorder's per-sample budget: a
    // per-byte substring/append loop took >5 s on a 64 KiB cmdline, while a
    // bounded whole-string substitution chain is milliseconds. These cases
    // are generous and bounded; timings are RECORDED (printed to the test
    // output) rather than asserted on tight machine-dependent margins — only
    // a 5 s ceiling that separates the two algorithm classes is asserted.
    const plain = "a".repeat(65_536);
    const chunk = "cmd \"quoted\" \\path\\ line1\nline2\tend\x01\x1f\x7f café\n";
    const mixed = chunk.repeat(Math.ceil(65_536 / chunk.length)).slice(0, 65_536);

    for (const { name, input } of [
      { name: "long plain input (64 KiB, nothing to escape)", input: plain },
      { name: "long mixed-escape input (64 KiB)", input: mixed },
    ]) {
      const t0 = performance.now();
      const { status, stdout, stderr } = escapeThroughHelper(input);
      const elapsedMs = performance.now() - t0;
      assert.equal(status, 0, `${name}: helper exited ${status}; stderr: ${JSON.stringify(stderr)}`);
      assert.ok(
        !stdout.includes("\n") && !stdout.includes("\r"),
        `${name}: escaped output contains a physical line-break byte`,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse('"' + stdout + '"');
      } catch (err) {
        assert.fail(`${name}: JSON.parse rejected the long escaped content: ${String(err)}`);
      }
      assert.equal(parsed, input, `${name}: long-input round trip mismatch`);
      console.log(`${name}: escaped ${input.length} input chars in ${elapsedMs.toFixed(1)} ms`);
      assert.ok(
        elapsedMs < 5_000,
        `${name}: escaping took ${elapsedMs.toFixed(0)} ms — far above the bounded-pass class (regression)`,
      );
    }
  });
});
