/**
 * LEDGER-DIAG-2 US-010 — documentation and tracked-contract regression.
 *
 * Pins the AGENTS.md suite-ledger/TSTX section (the full-log path and
 * `suite_results.log_path` column, the tail composer rules, the update-warning
 * suppression matrix, the cleanChildEnv/static-guard test-child isolation and
 * the evidence-prune owner bead) and the tracked run contract
 * `torture-test/impl-tasks/ledger-diag-contract.json`.
 *
 * Pure filesystem reads (no child_process, no daemon, no VM, no network), so
 * this file stays in the parallel lane and needs no tests/serial-files.txt
 * entry. The host copy of the contract at
 * `/home/kaladin/matchlock-work/ledger-diag-contract.json` is checked only
 * when present — no test depends on it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const AGENTS_MD = resolve(REPO_ROOT, "AGENTS.md");
const CONTRACT = resolve(REPO_ROOT, "torture-test/impl-tasks/ledger-diag-contract.json");
const HOST_CONTRACT = "/home/kaladin/matchlock-work/ledger-diag-contract.json";

/** Markdown emphasis/backticks are cosmetic; flatten whitespace for matching. */
function flatten(text: string): string {
  return text.replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

describe("LEDGER-DIAG-2 docs: AGENTS.md suite ledger / TSTX section (US-010)", () => {
  let flat: string;

  try {
    flat = flatten(readFileSync(AGENTS_MD, "utf-8"));
  } catch {
    flat = "";
  }

  it("carries the dedicated Suite ledger full logs section", () => {
    assert.ok(
      flat.includes("Suite ledger full logs (LEDGER-DIAG / TSTX)"),
      "AGENTS.md must carry a 'Suite ledger full logs (LEDGER-DIAG / TSTX)' section",
    );
  });

  it("documents the full-log path and the suite_results.log_path column", () => {
    assert.ok(flat.includes("suite-logs"), "must name the suite-logs directory");
    assert.ok(
      flat.includes("<state dir>/suite-logs/<row id>.log"),
      "must document the per-row full-log path",
    );
    assert.ok(flat.includes("log_path"), "must name the suite_results.log_path column");
    assert.ok(flat.includes("suite_results.log_path"), "must name the fully-qualified column");
    assert.ok(flat.includes("v13 -> v14"), "must document the v13 -> v14 migration step");
    assert.ok(flat.includes("NULL"), "must state older rows keep log_path NULL");
  });

  it("documents the tail composer rules and the 20 KB cap", () => {
    assert.ok(flat.includes("composeLogTail(fullOutput, capBytes)"), "must name composeLogTail");
    assert.ok(flat.includes("src/suite/log-tail.ts"), "must name the composer module");
    assert.ok(flat.includes("LOG_TAIL_KB"), "must name LOG_TAIL_KB");
    assert.ok(flat.includes("20 KB"), "must document the 20 KB cap");
    assert.ok(
      flat.includes("✖ failing tests:"),
      "must document the complete failing-tests block retention",
    );
    assert.ok(
      flat.includes("Serial lane:") && flat.includes("Parallel lane:"),
      "must document the lane verdict lines",
    );
    assert.ok(flat.includes("deduped"), "must state repeated markers are deduped");
    assert.ok(
      flat.includes("never exceeding the cap"),
      "must state the composed tail never exceeds the cap",
    );
    assert.ok(
      flat.includes("no node:child_process") ||
        flat.includes("imports no node:child_process"),
      "must state the composer imports no node:child_process",
    );
  });

  it("documents the update-warning suppression matrix", () => {
    assert.ok(
      flat.includes("shouldSuppressUpdateWarning"),
      "must name the suppression decision function",
    );
    assert.ok(flat.includes("TAMANDUA_TEST_GUARD"), "must name the test-guard suppression input");
    assert.ok(
      flat.includes("not an interactive TTY") || flat.includes("not a TTY"),
      "must document the non-TTY suppression input",
    );
    assert.ok(
      flat.includes("TAMANDUA_FORCE_UPDATE_WARNING"),
      "must document the force-warning escape hatch",
    );
    assert.ok(flat.includes("dashboard version banner"), "must state the dashboard banner is unchanged");
  });

  it("documents the cleanChildEnv test-child isolation and the static guard", () => {
    assert.ok(flat.includes("cleanChildEnv"), "must name cleanChildEnv");
    assert.ok(flat.includes("tests/helpers/test-env.ts"), "must name the helper module");
    assert.ok(
      flat.includes("<temp HOME>/.tamandua"),
      "must document the forced temp state directory",
    );
    for (const marker of [
      "TAMANDUA_RUN_ID",
      "TAMANDUA_WORKER_JOB_ID",
      "TAMANDUA_DAEMON_INSTANCE",
      "TAMANDUA_WORKER_PID",
      "TAMANDUA_DAEMON_PID",
    ]) {
      assert.ok(flat.includes(marker), `must document stripping ${marker}`);
    }
    assert.ok(
      flat.includes("findIsolationEnvViolations"),
      "must name the static isolation-env guard",
    );
    assert.ok(
      flat.includes("tests/test-isolation-guard.test.ts"),
      "must name the guard test",
    );
  });

  it("names the evidence-prune owner bead", () => {
    assert.ok(flat.includes("6sy.69"), "must name bead 6sy.69 (evidence prune)");
    assert.ok(flat.includes("deleted automatically"), "must state nothing is auto-deleted");
  });

  it("names the tracked contract and the host copy", () => {
    assert.ok(
      flat.includes("torture-test/impl-tasks/ledger-diag-contract.json"),
      "must point at the tracked contract path",
    );
    assert.ok(
      flat.includes("/home/kaladin/matchlock-work/ledger-diag-contract.json"),
      "must point at the host copy path",
    );
  });
});

describe("LEDGER-DIAG-2 tracked contract (US-010)", () => {
  let raw: string;
  let doc: Record<string, unknown>;

  try {
    raw = readFileSync(CONTRACT, "utf-8");
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    raw = "";
    doc = {};
  }

  it("exists and parses as valid JSON", () => {
    assert.ok(existsSync(CONTRACT), `contract must exist at ${CONTRACT}`);
    assert.ok(raw.length > 0, "contract must not be empty");
    assert.ok(isRecord(doc) && Object.keys(doc).length > 0, "contract must be a JSON object");
  });

  it("carries exactly the required top-level keys", () => {
    for (const key of [
      "migration",
      "tailComposer",
      "suppression",
      "isolationGuard",
      "gateCommands",
    ]) {
      assert.ok(key in doc, `contract must carry a top-level '${key}' key`);
      assert.ok(doc[key] !== null && doc[key] !== undefined, `contract.${key} must be non-empty`);
    }
  });

  it("records the v13 -> v14 suite_results.log_path migration", () => {
    const migration = doc.migration;
    assert.ok(isRecord(migration), "migration must be an object");
    assert.equal(migration.schemaVersionBefore, 13, "migration.schemaVersionBefore must be 13");
    assert.equal(migration.schemaVersionAfter, 14, "migration.schemaVersionAfter must be 14");
    assert.equal(migration.column, "suite_results.log_path", "migration.column must match");
    assert.equal(migration.nullable, true, "migration.nullable must be true");
    assert.equal(migration.backfill, "none", "migration.backfill must be none");
    assert.equal(migration.idempotent, true, "migration.idempotent must be true");
    assert.equal(migration.lineageClassification, "pre-v14", "migration lineage must be pre-v14");
    assert.ok(
      isNonEmptyString(migration.guard) && migration.guard.includes("pragma_table_info"),
      "migration.guard must use the pragma_table_info guard",
    );
    assert.equal(migration.testFile, "src/db.test.ts", "migration.testFile must be src/db.test.ts");
  });

  it("records the tail composer rules and the three required shapes", () => {
    const composer = doc.tailComposer;
    assert.ok(isRecord(composer), "tailComposer must be an object");
    assert.equal(composer.module, "src/suite/log-tail.ts", "tailComposer.module must match");
    assert.equal(
      composer.export,
      "composeLogTail(fullOutput, capBytes)",
      "tailComposer.export must match",
    );
    assert.equal(composer.capBytes, 20480, "tailComposer.capBytes must be 20480");
    assert.equal(composer.logTailKb, 20, "tailComposer.logTailKb must be 20");
    assert.equal(
      composer.importsChildProcess,
      false,
      "tailComposer.importsChildProcess must be false",
    );
    assert.ok(
      isStringArray(composer.priority) && composer.priority.length === 3,
      "tailComposer.priority must list the three priority tiers in order",
    );
    assert.ok(isStringArray(composer.rules), "tailComposer.rules must be a string array");

    const shapes = composer.shapes;
    assert.ok(Array.isArray(shapes), "tailComposer.shapes must be an array");
    const names = (shapes as Array<Record<string, unknown>>).map((shape) => shape.name);
    for (const required of ["serial-red-parallel-green", "both-red", "green"]) {
      assert.ok(
        names.includes(required),
        `tailComposer.shapes must include the '${required}' shape`,
      );
    }
  });

  it("records the suppression matrix with the guard, non-TTY and interactive cases", () => {
    const suppression = doc.suppression;
    assert.ok(isRecord(suppression), "suppression must be an object");
    assert.equal(
      suppression.function,
      "shouldSuppressUpdateWarning",
      "suppression.function must match",
    );
    assert.equal(suppression.module, "src/cli/shared.ts", "suppression.module must match");
    assert.equal(
      suppression.interactiveKeepsWarning,
      true,
      "suppression.interactiveKeepsWarning must be true",
    );
    assert.equal(
      suppression.dashboardBanner,
      "unchanged (separate server code path)",
      "suppression.dashboardBanner must be unchanged",
    );

    const matrix = suppression.matrix;
    assert.ok(Array.isArray(matrix) && matrix.length >= 4, "suppression.matrix must be populated");
    const entries = matrix as Array<Record<string, unknown>>;
    for (const [index, entry] of entries.entries()) {
      assert.ok(isNonEmptyString(entry.case), `suppression.matrix[${index}].case must be set`);
      assert.ok(isRecord(entry.env), `suppression.matrix[${index}].env must be an object`);
      assert.equal(
        typeof entry.stderrIsTTY,
        "boolean",
        `suppression.matrix[${index}].stderrIsTTY must be a boolean`,
      );
      assert.equal(
        typeof entry.suppressed,
        "boolean",
        `suppression.matrix[${index}].suppressed must be a boolean`,
      );
    }

    const guardCase = entries.find((entry) => String(entry.case).includes("TAMANDUA_TEST_GUARD set"));
    assert.ok(guardCase, "matrix must carry the TAMANDUA_TEST_GUARD set case");
    assert.equal(guardCase?.suppressed, true, "the guard case must suppress");

    const interactiveCase = entries.find((entry) => String(entry.case).includes("interactive"));
    assert.ok(interactiveCase, "matrix must carry the interactive case");
    assert.equal(interactiveCase?.suppressed, false, "the interactive case must keep the warning");

    const nonTtyCase = entries.find((entry) => String(entry.case).includes("non-TTY"));
    assert.ok(nonTtyCase, "matrix must carry the non-TTY case");
    assert.equal(nonTtyCase?.suppressed, true, "the non-TTY case must suppress");
  });

  it("records the isolation guard and the forced temp state dir", () => {
    const guard = doc.isolationGuard;
    assert.ok(isRecord(guard), "isolationGuard must be an object");
    assert.equal(
      guard.helper,
      "tests/helpers/test-env.ts#cleanChildEnv",
      "isolationGuard.helper must match",
    );
    assert.equal(
      guard.forcedStateDir,
      "<temp HOME>/.tamandua",
      "isolationGuard.forcedStateDir must match",
    );
    assert.equal(
      guard.injectedStateDirIgnored,
      true,
      "isolationGuard.injectedStateDirIgnored must be true",
    );
    assert.ok(isStringArray(guard.strippedMarkers), "isolationGuard.strippedMarkers must be an array");
    for (const marker of [
      "TAMANDUA_RUN_ID",
      "TAMANDUA_WORKER_JOB_ID",
      "TAMANDUA_DAEMON_INSTANCE",
      "TAMANDUA_WORKER_PID",
      "TAMANDUA_DAEMON_PID",
    ]) {
      assert.ok(
        (guard.strippedMarkers as string[]).includes(marker),
        `isolationGuard.strippedMarkers must include ${marker}`,
      );
    }
    assert.equal(
      guard.staticGuard,
      "tests/helpers/isolation-env-guard.ts#findIsolationEnvViolations",
      "isolationGuard.staticGuard must match",
    );
    assert.equal(
      guard.guardTest,
      "tests/test-isolation-guard.test.ts",
      "isolationGuard.guardTest must match",
    );
  });

  it("records the exact gate commands and expected exits", () => {
    const gates = doc.gateCommands;
    assert.ok(Array.isArray(gates) && gates.length > 0, "gateCommands must be a non-empty array");
    const entries = gates as Array<Record<string, unknown>>;
    for (const [index, gate] of entries.entries()) {
      assert.ok(isNonEmptyString(gate.command), `gateCommands[${index}].command must be set`);
      assert.equal(
        typeof gate.expectedExit,
        "number",
        `gateCommands[${index}].expectedExit must be a number`,
      );
    }
    const commands = entries.map((gate) => String(gate.command));
    for (const required of [
      "npm run build",
      "src/db.test.ts",
      "src/suite/log-tail.test.ts",
      "src/suite/shim.test.ts",
      "tests/helpers/clean-child-env.test.ts",
      "tests/cli-version-warning.test.ts",
      "tamandua-test",
      "./run-all-e2e-tests",
    ]) {
      assert.ok(
        commands.some((command) => command.includes(required)),
        `gateCommands must include a command mentioning ${required}`,
      );
    }
    const fullSuite = entries.find((gate) => String(gate.command).includes("tamandua-test"));
    assert.equal(fullSuite?.expectedExit, 0, "the full-suite shim gate must expect exit 0");
  });

  it("matches the host copy byte-for-byte when it is present", { skip: !existsSync(HOST_CONTRACT) ? `host copy absent at ${HOST_CONTRACT}` : false }, () => {
    const hostRaw = readFileSync(HOST_CONTRACT, "utf-8");
    assert.equal(hostRaw, raw, "the host copy must match the tracked contract byte-for-byte");
  });
});