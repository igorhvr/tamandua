/**
 * Regression tests: the launch-gate remedy command must be shell-safe.
 *
 * The gate's remedy text is the DOCUMENTED migration path, so the operator
 * pastes `hermes sessions set-journal-mode delete|wal --db <path>` into a
 * shell. The renderer used to interpolate the pathname bare, which meant the
 * pasting shell — not the renderer — decided where the argument ended:
 *
 *  - a space, tab or newline split one pathname into two argv words and the
 *    conversion silently targeted the WRONG file (hermes exits 0);
 *  - an apostrophe made the quoting odd and `sh` died with a parse error;
 *  - `$(...)`, backticks and `;` were executed/re-parsed by the shell.
 *
 * These tests go through the REAL renderer (`renderGateRemedyText`) and the
 * REAL evaluator-derived command list, then execute every emitted command with
 * `/bin/sh -c` against a stub `hermes` that journals `$#` and `"$@"`. They
 * assert the resulting argv, not a re-derived string, so a future unquoting
 * regression fails here. The launch-gate producer is covered too, and a parity
 * assertion keeps both producers byte-identical.
 *
 * The file spawns `/bin/sh`, so it is listed in tests/serial-files.txt.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import {
  evaluateGate,
  type EvaluatedStore,
  type GateVerdict,
} from "../../../dist/installer/matchlock/launch-gate.js";
import { renderGateRemedyText } from "../../../dist/installer/matchlock/gate-remedy-text.js";

const RELAUNCH = "tamandua matchlock hermes --profile demo";

/** A present store that fails BOTH conversion codes (config wal + wal header). */
function failingStore(storePath: string): EvaluatedStore {
  return {
    requestedPath: storePath,
    presence: "present",
    identity: {
      canonicalPath: storePath,
      dev: "2049",
      ino: "424242",
      fstype: "ext4",
    },
    required: true,
    config: { journalMode: "wal", source: "guest-config", observed: true },
    header: {
      headerFormat: "wal",
      rawBytes1819: [2, 2],
      magicOk: true,
      readable: true,
      fileSize: 4096,
    },
    sidecars: { wal: "absent", shm: "absent", journal: "absent" },
    findingCodesFromReader: [],
  };
}

function verdictFor(storePath: string): GateVerdict {
  return evaluateGate({
    inventoryComplete: true,
    incompleteReasons: [],
    stores: [failingStore(storePath)],
  });
}

/** Render through the real renderer for one store path. */
function renderTextFor(storePath: string): string {
  return renderGateRemedyText({
    verdict: verdictFor(storePath),
    stores: [failingStore(storePath)],
    holderDetection: {
      observationComplete: true,
      holders: [],
      probeFailures: [],
    },
    relaunchCommand: RELAUNCH,
  });
}

/** Every `      command:` the renderer emitted, in order (may span lines). */
function renderedCommands(storePath: string): string[] {
  const lines = renderTextFor(storePath).split("\n");
  const commands: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("      command: ")) continue;
    let command = lines[i].slice("      command: ".length);
    // A pathname may carry a newline, so the command is not one physical line.
    // It ends at the next remedy bullet or section-level field.
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next === "" || next.startsWith("    - ") || /^  \S/.test(next)) break;
      command += `\n${next}`;
      i += 1;
    }
    commands.push(command);
  }
  return commands;
}

/** Every command the launch-gate evaluator attached to a remedy, in order. */
function evaluatorCommands(storePath: string): string[] {
  const commands: string[] = [];
  for (const finding of verdictFor(storePath).findings) {
    for (const remedy of finding.remedy) {
      if (remedy.command !== undefined) commands.push(remedy.command);
    }
  }
  // The evaluator repeats the delete conversion for both codes; the renderer
  // prints a duplicate line once. Compare the deduplicated command list.
  return [...new Set(commands)];
}

/** Single-quote one pathname the way the producers must (for expectations). */
function quoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface ShellResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/** Execute one command under /bin/sh with the stub `hermes` first on PATH. */
function runInShell(
  command: string,
  cwd: string,
  binDir: string,
  journalPath: string,
): { result: ShellResult; argc: number | null; argv: string[] } {
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: `${binDir}:/bin:/usr/bin`,
      HERMES_STUB_JOURNAL: journalPath,
    },
  });

  const raw = fs.existsSync(journalPath)
    ? fs.readFileSync(journalPath)
    : Buffer.alloc(0);
  const args = raw.toString("utf8").split("\0");
  // The stub writes "$#\n" then every argument NUL-terminated, so the trailing
  // split element is always empty and the first one starts with the count.
  const newline = args[0].indexOf("\n");
  const argc = newline === -1 ? null : Number.parseInt(args[0].slice(0, newline), 10);
  const argv =
    newline === -1
      ? []
      : [args[0].slice(newline + 1), ...args.slice(1, -1)];

  return {
    result: {
      status: result.status,
      signal: result.signal,
      stderr: result.stderr,
    },
    argc,
    argv,
  };
}

interface Case {
  label: string;
  storePath: string;
  /** Second command of an unquoted line must not have run. */
  touchesWhenUnquoted?: boolean;
}

const CASES: readonly Case[] = [
  { label: "plain", storePath: "/stores/hermes/main.db" },
  { label: "space", storePath: "/stores/hermes data/main.db" },
  { label: "tab", storePath: "/stores/hermes\tdata/main.db" },
  { label: "apostrophe", storePath: "/stores/hermes'data/main.db" },
  { label: "dollar", storePath: "/stores/$(id -u)/main.db" },
  { label: "backtick", storePath: "/stores/`id -u`/main.db" },
  {
    label: "semicolon",
    storePath: "/stores/a;touch PWNED/main.db",
    touchesWhenUnquoted: true,
  },
  { label: "newline", storePath: "/stores/hermes\ndata/main.db" },
  {
    label: "pathological",
    storePath: "/stores/hermes data'$(id -u);x/main.db",
  },
];

const root = tamanduaShortTempDir("gate-remedy-quoting-");
const binDir = path.join(root, "bin");
const stubPath = path.join(binDir, "hermes");

fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(
  stubPath,
  [
    "#!/bin/sh",
    "{",
    '  printf \'%s\\n\' "$#"',
    '  for arg in "$@"; do',
    '    printf \'%s\\0\' "$arg"',
    "  done",
    '} > "$HERMES_STUB_JOURNAL"',
    "exit 0",
    "",
  ].join("\n"),
);
fs.chmodSync(stubPath, 0o755);

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("gate remedy command shell quoting", () => {
  for (const testCase of CASES) {
    it(`emits an exact single argv word for a ${testCase.label} pathname`, () => {
      const commands = renderedCommands(testCase.storePath);

      // Both directions are present and both name the path quoted.
      assert.deepEqual(commands, [
        `hermes sessions set-journal-mode delete --db ${quoted(testCase.storePath)}`,
        `hermes sessions set-journal-mode wal --db ${quoted(testCase.storePath)}`,
      ]);

      const caseDir = path.join(root, `case-${testCase.label}`);
      fs.mkdirSync(caseDir, { recursive: true });
      if (testCase.touchesWhenUnquoted === true) {
        // If the `;` were bare, `touch PWNED/main.db` would run in this cwd.
        fs.mkdirSync(path.join(caseDir, "PWNED"), { recursive: true });
        // The pathname's own prefix is irrelevant to the shell.
        fs.mkdirSync(path.join(root, "stores"), { recursive: true });
      }

      for (const command of commands) {
        const journalPath = path.join(root, `journal-${testCase.label}.bin`);
        fs.rmSync(journalPath, { force: true });

        const { result, argc, argv } = runInShell(
          command,
          caseDir,
          binDir,
          journalPath,
        );

        assert.equal(result.signal, null, `${command}: ${result.stderr}`);
        assert.equal(result.status, 0, `${command}: ${result.stderr}`);
        assert.equal(argc, 5, `${command}: argc ${String(argc)}`);
        assert.deepEqual(argv, [
          "sessions",
          "set-journal-mode",
          command.includes(" delete ") ? "delete" : "wal",
          "--db",
          testCase.storePath,
        ]);
      }

      if (testCase.touchesWhenUnquoted === true) {
        assert.ok(
          !fs.existsSync(path.join(caseDir, "PWNED", "main.db")),
          "the trailing `touch` must not run",
        );
      }
    });
  }

  it("pre-fix control: the space case is quoted in the rendered text", () => {
    // Deliberately literal (not built by `quoted`) so the assertion fails on
    // the old unquoted renderer instead of restating the helper.
    assert.ok(
      renderTextFor("/stores/hermes data/main.db").includes(
        "--db '/stores/hermes data/main.db'",
      ),
    );
  });

  it("keeps the two producers byte-identical for every case", () => {
    for (const testCase of CASES) {
      assert.deepEqual(
        renderedCommands(testCase.storePath),
        evaluatorCommands(testCase.storePath),
        testCase.label,
      );
    }
  });

  it("the harness would catch an unquoted space (sanity control)", () => {
    // Exactly the pre-fix rendering of the space case: rc=0, but the pathname
    // silently splits into two argv words and targets the wrong file.
    const preFix =
      "hermes sessions set-journal-mode delete --db /stores/hermes data/main.db";
    const caseDir = path.join(root, "unquoted-control");
    fs.mkdirSync(caseDir, { recursive: true });

    const { result, argc, argv } = runInShell(
      preFix,
      caseDir,
      binDir,
      path.join(root, "journal-unquoted-control.bin"),
    );

    assert.equal(result.status, 0, result.stderr ?? "");
    assert.equal(argc, 6);
    assert.deepEqual(argv, ["sessions", "set-journal-mode", "delete", "--db", "/stores/hermes", "data/main.db"]);
  });
});
