// MACP5 US-004 — GNU-ism sweep fixes in the scripted scenario path
// (BSD sed -i, grep -oP, date %N).
//
// The mac's W2 cells hit "sed: 1: ... command i expects \ followed by text"
// — GNU-only sed `i`/`-i` syntax (BSD/macOS sed needs a suffix arg for -i
// and then misparses the file as a script). This file pins the fixes:
//   * install-scenario-workflows rewrites the workflow.yml id WITHOUT sed -i,
//     proven behavioral red-then-green with a BSD-sed shim on PATH (the shim
//     exits non-zero on `-i`, mimicking macOS sed; the pre-fix installer is
//     reproduced as a synthetic self-contained script and must fail, the live
//     installer must pass).
//   * bin/daemon-control has no grep -P / grep -oP (grep pin) — the
//     lingering-listener pid extraction is grep -Eo + sed prefix-strip,
//     which preserves the exact first-pid semantics on GNU and BSD.
//   * scripted-runtimes/test.sh timing uses a portable node hrtime clock
//     (portable_ns) instead of GNU date's %N.
//   * tt-provision-home's sed -i is fixed portably too: it IS mac-reachable
//     in the bare-tier1 campaign path — tt-controller's real-case preflight
//     (runRealPreflight → home-provision leg → tt-provision-home
//     --fail-closed) engages on ANY host because realPreflightRequired is
//     manifest-based (the tier1 manifest carries real cases and a bare run
//     is not --scripted-only), even when the real cells are later
//     predicate-excluded. So no US-005 allowlist entry is needed for it.
//   * Hard-gate sweep: the strict scripted scenario path (scenarios/, env/,
//     scripted-runtimes/, bin/daemon-control) carries ZERO GNU-isms of the
//     classes sed -i / sed i\ / grep -P / readlink -f / date %N / GNU
//     timeout / setsid on comment-masked lines.
//
// Scope notes:
//   * The strict path is the shell surface reachable from
//     run-scripted-scenario: scenarios/, env/, scripted-runtimes/ and
//     bin/daemon-control. bin/tt-recorder (readlink -f), bin/tt-daemon-up
//     and bin/tt-kill-sentinel (date +%N) are linux-side-only tools OUTSIDE
//     this path — they become documented allowlist entries in US-005, not
//     fixes here.
//   * The scan is comment- and single-quote-aware (maskLine, the
//     tier0-bash32-compat-lint convention): a `#` comment or single-quoted
//     literal may mention a pattern (documentation, not code).
//   * Zero tokens; confined to torture-test/; the live 33xx daemon is never
//     touched. Picked up by self-tests/run.sh's `tier0-*.test.ts` glob.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const TT_ROOT = path.join(repoRoot, "torture-test");

// ── strict-path shell-surface discovery ─────────────────────────────────

/** Tracked shell files (`.sh` or bash shebang) under the strict scripted
 *  scenario path: scenarios/, env/, scripted-runtimes/ + bin/daemon-control. */
function collectStrictShellFiles(root: string): string[] {
  const result = spawnSync(
    "git",
    [
      "ls-files",
      "torture-test/scenarios",
      "torture-test/env",
      "torture-test/scripted-runtimes",
      "torture-test/bin/daemon-control",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`);
  const files: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const rel = line.trim();
    if (rel === "") continue;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    if (rel.endsWith(".sh")) {
      files.push(rel);
      continue;
    }
    const first = fs.readFileSync(abs, "utf8").split(/\r?\n/, 1)[0] ?? "";
    if (/^#!.*\bbash\b/.test(first)) files.push(rel);
  }
  return files.sort();
}

// ── line masking (comment / single-quote awareness) ─────────────────────

/** Return `line` with comment tails and single-quoted spans replaced by
 *  spaces (positions preserved). Double-quoted content is kept — real
 *  commands live inside double quotes. Same helper as tier0-bash32-compat. */
function maskLine(line: string): string {
  const out: string[] = new Array<string>(line.length).fill("");
  let inSingle = false;
  let inDouble = false;
  let prev = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      out[i] = " ";
      if (ch === "'") inSingle = false;
      prev = ch;
      continue;
    }
    if (inDouble) {
      out[i] = ch;
      if (ch === "\\") {
        if (i + 1 < line.length) {
          out[i + 1] = line[i + 1];
          i++;
        }
      } else if (ch === '"') {
        inDouble = false;
      }
      prev = ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out[i] = " ";
      prev = ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out[i] = ch;
      prev = ch;
      continue;
    }
    // A `#` begins a comment when it starts a word: at line start, or after
    // whitespace / a command separator.
    if (ch === "#" && (prev === "" || /\s/.test(prev) || /[;|&(){}]/.test(prev))) {
      for (let j = i; j < line.length; j++) out[j] = " ";
      break;
    }
    out[i] = ch;
    prev = ch;
  }
  return out.join("");
}

// ── GNU-ism pattern classes (the MACP5 US-004 list) ─────────────────────

interface GnuiClass {
  name: string;
  re: RegExp;
}

/** Each class is applied to a comment-masked line. `\b` word boundaries keep
 *  `--timeout`-style CLI flags and `timeout_ms` variables out of the timeout
 *  class (the story bans the GNU coreutils `timeout <n> <cmd>` COMMAND).
 *  MACP5 US-005: the timeout regex previously used POSIX `[[:space:]]`
 *  character classes, which JavaScript does not support (they match literal
 *  `:space:` characters, never whitespace) — the GNU-timeout arm never fired.
 *  Corrected to JS `\s`; the strict path has no GNU timeout (MACP4 cleared
 *  it), so the live gate stays green while the arm now actually enforces. */
const GNU_ISM_CLASSES: GnuiClass[] = [
  { name: "sed -i (GNU in-place)", re: /\bsed\s+-[a-zA-Z]*i\b|\bsed\s+--in-place\b/ },
  { name: "sed i\\ (GNU insert)", re: /\bsed\b[^|]*\bi\\/ },
  { name: "grep -P", re: /\bgrep\s+-[a-zA-Z]*P[a-zA-Z]*\b|\bgrep\s+--perl-regexp\b/ },
  { name: "readlink -f", re: /\breadlink\s+-[a-zA-Z]*f[a-zA-Z]*\b|\breadlink\s+--canonicalize\b/ },
  { name: "date %N", re: /%N/ },
  { name: "GNU timeout cmd", re: /(^|[;&|(\s])timeout(\s+-{1,2}[^\s]+)*\s+[0-9]+[smhd]?/ },
  { name: "setsid cmd", re: /\bsetsid\b/ },
];

/** Scan `contents` (rel path → file text) for GNU-isms on comment-masked
 *  lines. Returns `file:line: class` diagnostics. */
function gnuIismViolations(contents: Record<string, string>): string[] {
  const violations: string[] = [];
  for (const rel of Object.keys(contents).sort()) {
    const lines = contents[rel].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const masked = maskLine(lines[i]);
      for (const cls of GNU_ISM_CLASSES) {
        if (cls.re.test(masked)) {
          violations.push(`${rel}:${i + 1}: ${cls.name}`);
        }
      }
    }
  }
  return violations;
}

function readStrictContents(root: string): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const rel of collectStrictShellFiles(root)) {
    contents[rel] = fs.readFileSync(path.join(root, rel), "utf8");
  }
  return contents;
}

// ── BSD-sed shim + installer fixture ────────────────────────────────────

/** A temp dir with `bin/sed` (a BSD-sed shim: exits non-zero on `-i`, else
 *  delegates to /usr/bin/sed; logs every invocation to bin/sed.log) and a
 *  fake workflow dir under `state/workflows/base-wf/workflow.yml`. */
function makeInstallerFixture(): { root: string; sedLog: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "macp5-us004-installer-"));
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "state", "workflows", "base-wf"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "state", "workflows", "base-wf", "workflow.yml"),
    "id: base-wf\nagents:\n  - id: doer\n",
  );
  const sedLog = path.join(root, "bin", "sed.log");
  fs.writeFileSync(
    path.join(root, "bin", "sed"),
    `#!/usr/bin/env bash
for arg in "$@"; do
  if [ "$arg" = "-i" ]; then
    echo "sed: 1: \\"$2\\" command i expects \\\\ followed by text" >&2
    exit 1
  fi
done
echo "invoked" >> "\${SED_LOG:-/dev/null}"
exec /usr/bin/sed "$@"
`,
    { mode: 0o755 },
  );
  return { root, sedLog };
}

function runInstaller(installerPath: string, fixtureRoot: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(installerPath, ["base-wf", "scen1", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TAMANDUA_STATE_DIR: path.join(fixtureRoot, "state"),
      PATH: `${path.join(fixtureRoot, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      SED_LOG: path.join(fixtureRoot, "bin", "sed.log"),
    },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

describe("tier0 macp5 gnu-ism sweep (US-004)", () => {
  it("hard gate: the strict scripted scenario path has zero GNU-isms on comment-masked lines", () => {
    // Live-tree green run of the sweep: scenarios/, env/, scripted-runtimes/
    // and bin/daemon-control must be free of sed -i / sed i\ / grep -P /
    // readlink -f / date %N / GNU timeout / setsid. MACP4 already cleared
    // timeout/setsid/%N there; US-004 clears the sed -i / grep -oP / %N
    // stragglers.
    const violations = gnuIismViolations(readStrictContents(repoRoot));
    assert.deepEqual(
      violations,
      [],
      `strict scripted scenario path has GNU-isms (MACP5 US-004 must fix):\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("grep pin: daemon-control contains no grep -oP / grep -P anywhere (comments included)", () => {
    const source = fs.readFileSync(path.join(TT_ROOT, "bin", "daemon-control"), "utf8");
    for (const literal of ["grep -oP", "grep -Po", "grep -P", "grep --perl-regexp", "grep -aP"]) {
      assert.ok(
        !source.includes(literal),
        `daemon-control must not contain the GNU grep perl-regex form '${literal}'`,
      );
    }
    // Structural pin: the lingering-listener pid extraction is the portable
    // grep -Eo + sed prefix-strip form (first-pid semantics preserved).
    assert.match(source, /grep -Eo 'pid=\[0-9\]\+' \| head -1 \| sed 's\/\^pid=\/\//);
    assert.match(source, /grep -Eo '\[0-9\]\+' \| head -1 \|\| true\)/);
  });

  it("install-scenario-workflows rewrites the workflow.yml id WITH a BSD-sed shim on PATH (green)", () => {
    const fixture = makeInstallerFixture();
    try {
      const installer = path.join(TT_ROOT, "scripted-runtimes", "install-scenario-workflows");
      const run = runInstaller(installer, fixture.root);
      assert.equal(run.status, 0, `installer failed: ${run.stderr}`);
      // The shim must actually have been on PATH (it logs each invocation).
      assert.ok(
        fs.readFileSync(fixture.sedLog, "utf8").includes("invoked"),
        "the BSD-sed shim was never invoked — PATH interception failed",
      );
      const dstYml = path.join(fixture.root, "state", "workflows", "base-wf-scen1", "workflow.yml");
      const rewritten = fs.readFileSync(dstYml, "utf8");
      assert.match(rewritten, /^id: base-wf-scen1\s*$/m, `id must be rewritten, got:\n${rewritten}`);
      assert.match(rewritten, /^  - id: doer$/m, "agents section must survive the rewrite");
      // The behaviors fragment must carry the fully-qualified key.
      assert.match(run.stdout, /\{"base-wf-scen1_doer":\{\}\}/, `stdout: ${run.stdout}`);
      // The source workflow is untouched.
      const srcYml = fs.readFileSync(path.join(fixture.root, "state", "workflows", "base-wf", "workflow.yml"), "utf8");
      assert.match(srcYml, /^id: base-wf\s*$/m);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("red proof: the pre-fix installer fails with the same BSD-sed shim (command i expects)", () => {
    // Self-contained red-then-green documentation arm (MACP5.1): the ACTUAL
    // pre-US-004 install-scenario-workflows performed the GNU-only `sed -i`
    // id rewrite (line 90 of the pre-fix tree) — the mac's exact failure.
    // The pre-fix installer is reproduced as a minimal SYNTHETIC script (NOT
    // materialized from git history: the US-004 commit exists only on the
    // authoring branch and is unreachable on merged main) and run through the
    // BSD-sed shim: it must fail with the observed error and leave the
    // destination workflow.yml unrewritten (fail closed). The live installer
    // is asserted green by the test above.
    const fixture = makeInstallerFixture();
    try {
      const preFixInstaller = path.join(fixture.root, "installer-pre-fix");
      fs.writeFileSync(
        preFixInstaller,
        [
          "#!/usr/bin/env bash",
          "# Synthetic pre-US-004 installer — self-contained red fixture",
          "# (MACP5.1): performs the GNU-only in-place id rewrite exactly as",
          "# the pre-fix install-scenario-workflows did.",
          "set -euo pipefail",
          'BASE_WORKFLOW="$1"',
          'SCENARIO_ID="$2"',
          'NEW_ID="${BASE_WORKFLOW}-${SCENARIO_ID}"',
          'WORKFLOWS_DIR="$TAMANDUA_STATE_DIR/workflows"',
          'SRC_DIR="$WORKFLOWS_DIR/$BASE_WORKFLOW"',
          'DST_DIR="$WORKFLOWS_DIR/$NEW_ID"',
          'cp -a "$SRC_DIR" "$DST_DIR"',
          'YML="$DST_DIR/workflow.yml"',
          'sed -i "s/^id: ${BASE_WORKFLOW}[[:space:]]*$/id: ${NEW_ID}/" "$YML"',
          'echo "{\\"${NEW_ID}_doer\\":{}}"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const run = runInstaller(preFixInstaller, fixture.root);
      assert.notEqual(run.status, 0, "pre-fix installer must fail under a BSD-sed shim");
      assert.match(
        run.stderr,
        /command i expects \\ followed by text/,
        `pre-fix stderr must carry the BSD sed error, got: ${run.stderr}`,
      );
      // Fail closed: the destination workflow.yml is NOT rewritten.
      const dstYml = path.join(fixture.root, "state", "workflows", "base-wf-scen1", "workflow.yml");
      const dst = fs.readFileSync(dstYml, "utf8");
      assert.match(dst, /^id: base-wf\s*$/m, `pre-fix must NOT rewrite the id, got:\n${dst}`);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("tt-provision-home's sed -i is fixed portably (mac-reachable via the bare-tier1 preflight)", () => {
    // Reachability verdict (recorded for US-005): tt-provision-home is NOT
    // reachable from run-scripted-scenario, but it IS mac-reachable in the
    // bare-tier1 campaign path — tt-controller's real-case preflight
    // (runRealPreflight → home-provision leg) engages on ANY host because
    // realPreflightRequired is manifest-based (the tier1 manifest carries
    // real cases and a bare run is not --scripted-only), even when the real
    // cells are later predicate-excluded. So the sed must be portable here
    // too; no US-005 allowlist entry is needed for tt-provision-home.
    const source = fs.readFileSync(path.join(TT_ROOT, "bin", "tt-provision-home"), "utf8");
    for (const line of source.split(/\r?\n/)) {
      const masked = maskLine(line);
      assert.ok(
        !/\bsed\s+-[a-zA-Z]*i\b|\bsed\s+--in-place\b/.test(masked),
        `tt-provision-home must not use GNU sed in-place: ${line.trim()}`,
      );
    }
    // Structural pin: the audited-content rewrite is the portable
    // temp-file + atomic-mv form.
    assert.match(
      source,
      /sed "s\|\$\{sed_real_home\}\|\$\{sed_dest_dir\}\|g" "\$tmp" > "\$tmp\.rewrite" && mv "\$tmp\.rewrite" "\$tmp"/,
      "tt-provision-home must rewrite via tmp + mv",
    );
  });

  it("scripted-runtimes/test.sh timing uses the portable node clock (no GNU date %N)", () => {
    const source = fs.readFileSync(path.join(TT_ROOT, "scripted-runtimes", "test.sh"), "utf8");
    for (const line of source.split(/\r?\n/)) {
      const masked = maskLine(line);
      assert.ok(
        !/%N/.test(masked),
        `scripted-runtimes/test.sh must not use GNU date %N on a code line: ${line.trim()}`,
      );
    }
    // The portable clock helper exists and the four timing sites use it.
    assert.match(source, /portable_ns\(\) \{\s*\n\s*"\$NODE_BIN" -e 'process\.stdout\.write\(String\(process\.hrtime\.bigint\(\)\)\)'/);
    assert.equal((source.match(/start_ns="\$\(portable_ns\)"/g) ?? []).length, 2);
    assert.equal((source.match(/end_ns="\$\(portable_ns\)"/g) ?? []).length, 2);
  });
});
