import { describe, it, before } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Doc-contract audit for the TIME-CLOCKS work (US-015). Pins the ONE
// clock/staleness rule in AGENTS.md and the monotonic-helper references in
// tests/MOTOR-CONTRACT.md so a reviewer (or a future change) cannot silently
// drop the contract. The behavior itself is pinned by
// tests/time-clocks-wall-jump.test.ts (US-013) and mechanically guarded by
// tests/time-clocks-guard.test.ts (US-014).

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentsPath = resolve(__dirname, "..", "AGENTS.md");
const contractPath = resolve(__dirname, "MOTOR-CONTRACT.md");

describe("TIME-CLOCKS docs contract (US-015)", () => {
  let agents: string;
  let contract: string;

  before(() => {
    assert.ok(readFileSync(agentsPath, "utf-8").length > 0);
    agents = readFileSync(agentsPath, "utf-8");
    assert.ok(readFileSync(contractPath, "utf-8").length > 0);
    contract = readFileSync(contractPath, "utf-8");
  });

  it("AGENTS.md has the clocks/staleness contract section", () => {
    assert.match(
      agents,
      /^### Time and staleness \(TIME-CLOCKS\)$/m,
      "AGENTS.md must carry a '### Time and staleness (TIME-CLOCKS)' section"
    );
  });

  it("AGENTS.md states the monotonic-helper rule (rule 1)", () => {
    assert.match(
      agents,
      /Rule 1 — in-process intervals and deadlines are monotonic/,
      "AGENTS.md must name rule 1 and that in-process intervals/deadlines are monotonic"
    );
    for (const helper of ["monotonicNow()", "Stopwatch", "Deadline"]) {
      assert.ok(
        agents.includes(helper),
        `AGENTS.md rule 1 must name the monotonic helper ${helper}`
      );
    }
    assert.match(
      agents,
      /\*\*never\*\* a difference of `Date\.now\(\)` values/,
      "AGENTS.md must forbid measuring intervals as a difference of Date.now() values"
    );
  });

  it("AGENTS.md states the durable-instant and explicit-tolerance rule (rule 2)", () => {
    assert.match(
      agents,
      /Rule 2 — durable instants are UTC ISO-Z, compared numerically/,
      "AGENTS.md must name rule 2 and the UTC ISO-Z durable-instant shape"
    );
    for (const helper of [
      "nowIso()",
      "SQL_NOW_ISO",
      "parseInstant()",
      "instantAgeMs()",
      "isOlderThan()",
    ]) {
      assert.ok(
        agents.includes(helper),
        `AGENTS.md rule 2 must name the durable-instant helper ${helper}`
      );
    }
    assert.match(
      agents,
      /Each\s+call site passes an explicit tolerance and documents why/,
      "AGENTS.md must require an explicit documented tolerance at each call site"
    );
    assert.match(
      agents,
      /unparseable\s+or missing instant is never stale/,
      "AGENTS.md must state that an unparseable/missing instant is never stale"
    );
  });

  it("AGENTS.md forbids string comparisons of instants", () => {
    assert.match(
      agents,
      /\*\*never as string comparisons\*\*/,
      "AGENTS.md must forbid comparing instants as strings"
    );
  });

  it("AGENTS.md states the file-mtime OS-epoch rule (rule 3)", () => {
    assert.match(
      agents,
      /Rule 3 — file mtimes keep OS-epoch semantics/,
      "AGENTS.md must name rule 3 and that file mtimes keep OS-epoch semantics"
    );
    assert.match(
      agents,
      /pidfile \/ start\s+lock provenance and dsh session "created since spawn"/,
      "AGENTS.md must name the pidfile/start-lock and dsh session mtime sites"
    );
    assert.match(
      agents,
      /age\/since-spawn decision still\s+routes through the same `instantAgeMs\(\)` \/ `isOlderThan\(\)` helpers/,
      "AGENTS.md must route mtime decisions through the same instant helpers"
    );
  });

  it("AGENTS.md points at the guard and wall-jump enforcement tests", () => {
    assert.ok(
      agents.includes("tests/time-clocks-guard.test.ts"),
      "AGENTS.md must reference the US-014 guard test"
    );
    assert.ok(
      agents.includes("tests/time-clocks-wall-jump.test.ts"),
      "AGENTS.md must reference the US-013 wall-jump regression test"
    );
    assert.ok(
      agents.includes("tests/time-clocks-guard.allowlist.json"),
      "AGENTS.md must reference the guard allow-list"
    );
  });

  it("MOTOR-CONTRACT.md timing model references the monotonic contract and helpers", () => {
    assert.match(
      contract,
      /### Timing model \(TIME-CLOCKS\)/,
      "MOTOR-CONTRACT.md must keep the Timing model (TIME-CLOCKS) section"
    );
    assert.match(
      contract,
      /measured with the monotonic clock\s+\(`monotonicNow\(\)` \/ `Stopwatch` \/ `Deadline` in `src\/lib\/instant\.ts`\)/,
      "the timing model must name the monotonic helper module"
    );
    assert.match(
      contract,
      /never\s+as a difference of `Date\.now\(\)` values/,
      "the timing model must forbid Date.now() interval math"
    );
  });

  it("MOTOR-CONTRACT.md covers backoff, adapter elapsed/remaining, stale-claim sweep and teardown grace", () => {
    assert.match(
      contract,
      /retry\s+backoff\s+\(`armInstantFailBackoff` \/ `isInstantFailBackoffActive`/,
      "the timing model must map retry backoff to the monotonic backoff helpers"
    );
    assert.match(
      contract,
      /adapter elapsed\/remaining wall budgets \(`roundElapsedMs\(watch\)` over the\s+round's `Stopwatch`/,
      "the timing model must map adapter elapsed/remaining to roundElapsedMs/Stopwatch"
    );
    assert.match(
      contract,
      /stale-claim sweep\s+\(`cleanupAbandonedSteps`/,
      "the timing model must name the stale-claim sweeper (cleanupAbandonedSteps)"
    );
    assert.match(
      contract,
      /run teardown grace\s+\(`HARNESS_TEARDOWN_GRACE_MS`/,
      "the timing model must name the run teardown grace constant"
    );
    // The dedicated sections must cross-reference the timing model too.
    assert.match(
      contract,
      /This grace is part of the\s+\[Timing model \(TIME-CLOCKS\)\]/,
      "the post-grace cleanup section must reference the timing model"
    );
  });
});
