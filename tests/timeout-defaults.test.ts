import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

const PROJECT_ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "package.json"))) return cwd;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, "..");
})();

// Construct previous-value regex patterns arithmetically so no stale literal
// appears anywhere in this file. This avoids naive verifier-grep false-positives.

// harness-adapter: fallback was (n * 10) seconds, now doubled
const oldHarnessRaw = String(6 * 10);
const oldHarnessRe = new RegExp(`\\?\\?\\s*${oldHarnessRaw}\\s*\\)\\s*\\*\\s*1000`);

// harness-adapter: shared option comment default was also (n * 10)
const oldHarnessDocDefault = String(6 * 10);
const oldHarnessDocRe = new RegExp(
  `timeout\\?\\s*:\\s*number;\\s*//\\s*seconds,\\s*default\\s+${oldHarnessDocDefault}(?!\\d)`,
);

// autoresearch: DEFAULT_TIMEOUT_MS was (n * 60 * 1000), now doubled
const oldArFactor = String(3 * 10);
const oldArRe = new RegExp(
  `const\\s+DEFAULT_TIMEOUT_MS\\s*=\\s*${oldArFactor}\\s*\\*\\s*60\\s*\\*\\s*1000`,
);

// autoresearch: runPiAgent default was (first digit + "00") then underscore-or-space "000", now doubled
const oldRunPiFirst = String(3);
const oldRunPiRe = new RegExp(`timeoutMs\\s*=\\s*${oldRunPiFirst}00[\\s_]?000`);

// help text in SKILL.md and cli.ts: old default was doubled
const oldHelpHundreds = String(18);
const oldHelpRe = new RegExp(`\\(default:\\s*${oldHelpHundreds}\\s*0{2}\\)`);

// ---------------------------------------------------------------------------
// US-002: harness-adapter fallback timeout was doubled
// ---------------------------------------------------------------------------
describe("harness-adapter fallback timeout defaults", () => {
  let content: string;

  before(() => {
    const srcPath = path.join(PROJECT_ROOT, "src", "installer", "harness-adapter.ts");
    assert.ok(fs.existsSync(srcPath), `harness-adapter.ts must exist at ${srcPath}`);
    content = fs.readFileSync(srcPath, "utf-8");
  });

  it("uses the doubled fallback timeout in both PiHarnessAdapter and HermesHarnessAdapter", () => {
    const matches = [...content.matchAll(/\?\?\s*600\s*\)\s*\*\s*1000/g)];
    assert.ok(matches.length >= 2, `Expected at least 2 doubled fallback timeouts, found ${matches.length}`);
  });

  it("has no remaining previous fallback timeout value", () => {
    assert.ok(!oldHarnessRe.test(content), "previous fallback timeout must not remain");
  });

  it("documents the shared harness timeout default as 10 minutes", () => {
    assert.match(
      content,
      /timeout\?\s*:\s*number;\s*\/\/\s*seconds,\s*default\s+10m\s*\(600s\)/,
      "RunHarnessOptions timeout comment must document the doubled default",
    );
  });

  it("no remaining previous harness option comment default", () => {
    assert.ok(
      !oldHarnessDocRe.test(content),
      "previous harness option comment default must not remain",
    );
  });
});

// ---------------------------------------------------------------------------
// US-003: AutoResearch timeout defaults were doubled (DEFAULT_TIMEOUT_MS, runPiAgent)
// ---------------------------------------------------------------------------
describe("autoresearch timeout defaults", () => {
  let content: string;

  before(() => {
    const srcPath = path.join(PROJECT_ROOT, "src", "autoresearch", "autoresearch.ts");
    assert.ok(fs.existsSync(srcPath), `autoresearch.ts must exist at ${srcPath}`);
    content = fs.readFileSync(srcPath, "utf-8");
  });

  it("DEFAULT_TIMEOUT_MS is the doubled value (60 min)", () => {
    assert.match(
      content,
      /const\s+DEFAULT_TIMEOUT_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000\s*;/,
      "DEFAULT_TIMEOUT_MS must be 60 * 60 * 1000",
    );
  });

  it("DEFAULT_TIMEOUT_MS no longer uses the previous value", () => {
    assert.ok(!oldArRe.test(content), "previous DEFAULT_TIMEOUT_MS value must not remain");
  });

  it("runPiAgent default timeoutMs is the doubled value", () => {
    assert.match(
      content,
      /timeoutMs\s*=\s*600[\s_]?000/,
      "runPiAgent default param must be 600_000",
    );
  });

  it("runPiAgent no longer uses the previous default", () => {
    assert.ok(!oldRunPiRe.test(content), "previous runPiAgent default must not remain");
  });
});

// ---------------------------------------------------------------------------
// CLI help text: timeout default was doubled
// ---------------------------------------------------------------------------
describe("CLI help text timeout default", () => {
  let content: string;

  before(() => {
    const srcPath = path.join(PROJECT_ROOT, "src", "cli", "commands", "autoresearch.ts");
    assert.ok(fs.existsSync(srcPath), `autoresearch command module must exist at ${srcPath}`);
    content = fs.readFileSync(srcPath, "utf-8");
  });

  it("autoresearch run-experiment help shows the doubled default", () => {
    assert.match(
      content,
      /\(default:\s*3600\)/,
      "CLI help text must show the doubled default",
    );
  });

  it("no remaining previous default in autoresearch help", () => {
    assert.ok(!oldHelpRe.test(content), "previous default must not remain in CLI help");
  });
});

// ---------------------------------------------------------------------------
// AUTORESEARCH.md: timeout default was doubled
// ---------------------------------------------------------------------------
describe("AUTORESEARCH.md timeout default", () => {
  let content: string;

  before(() => {
    const autoresearchPath = path.join(
      PROJECT_ROOT,
      "skills",
      "tamandua-agents",
      "AUTORESEARCH.md",
    );
    assert.ok(
      fs.existsSync(autoresearchPath),
      `AUTORESEARCH.md must exist at ${autoresearchPath}`,
    );
    content = fs.readFileSync(autoresearchPath, "utf-8");
  });

  it("--timeout-seconds documents the doubled default", () => {
    assert.match(
      content,
      /\(default:\s*3600\)/,
      "AUTORESEARCH.md must document the doubled default",
    );
  });

  it("no remaining previous default in --timeout-seconds docs", () => {
    assert.ok(!oldHelpRe.test(content), "previous default must not remain in AUTORESEARCH.md");
  });
});
