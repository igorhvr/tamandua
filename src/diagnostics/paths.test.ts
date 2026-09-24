/**
 * DIAG-PRUNE US-001 — unit tests for the diagnostics path layout.
 *
 * Pure (no child_process, no temp files, no daemon) — stays in the parallel
 * lane.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  bareRunId,
  sanitizeSegment,
  InvalidPathSegmentError,
  resolveDiagnosticsRoot,
  resolveDiagnosticsBundleDir,
  resolveRunEvidenceDir,
  resolveSuiteLogsDir,
  resolveDaemonLogFiles,
  isPathInside,
} from "../../dist/diagnostics/paths.js";

const STATE = "/state";

describe("bareRunId", () => {
  it("strips a run- prefix", () => {
    assert.equal(bareRunId("run-abc-123"), "abc-123");
  });

  it("returns a bare id unchanged", () => {
    assert.equal(bareRunId("abc-123"), "abc-123");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(bareRunId("  run-abc  "), "abc");
  });
});

describe("sanitizeSegment", () => {
  it("passes an already-safe segment through unchanged", () => {
    assert.equal(sanitizeSegment("abc-123_X.Y"), "abc-123_X.Y");
  });

  it("maps unsafe characters to '_'", () => {
    assert.equal(
      sanitizeSegment("2026-09-23T02:26:19.865Z"),
      "2026-09-23T02_26_19.865Z",
    );
  });

  it("rejects '..'", () => {
    assert.throws(() => sanitizeSegment(".."), InvalidPathSegmentError);
  });

  it("rejects '.'", () => {
    assert.throws(() => sanitizeSegment("."), InvalidPathSegmentError);
  });

  it("rejects forward and back path separators", () => {
    assert.throws(() => sanitizeSegment("a/b"), InvalidPathSegmentError);
    assert.throws(() => sanitizeSegment("a\\b"), InvalidPathSegmentError);
  });

  it("rejects a traversal segment like '../x'", () => {
    assert.throws(() => sanitizeSegment("../x"), InvalidPathSegmentError);
  });

  it("rejects the empty segment", () => {
    assert.throws(() => sanitizeSegment(""), InvalidPathSegmentError);
  });

  it("rejects a NUL byte", () => {
    assert.throws(() => sanitizeSegment("a\0b"), InvalidPathSegmentError);
  });
});

describe("resolveDiagnosticsRoot", () => {
  it("is <state>/diagnostics", () => {
    assert.equal(resolveDiagnosticsRoot(STATE), path.join(STATE, "diagnostics"));
  });
});

describe("resolveDiagnosticsBundleDir", () => {
  it("defaults to <state>/diagnostics/<bareRunId>-<sanitized-ts>", () => {
    const dir = resolveDiagnosticsBundleDir({
      stateDir: STATE,
      runId: "run-abc",
      timestamp: "2026-09-23T02:26:19.865Z",
    });
    assert.equal(
      dir,
      path.join(STATE, "diagnostics", "abc-2026-09-23T02_26_19.865Z"),
    );
  });

  it("uses <outRoot>/<bareRunId> when outRoot is supplied", () => {
    const dir = resolveDiagnosticsBundleDir({
      stateDir: STATE,
      runId: "run-abc",
      outRoot: "/out",
      timestamp: "ignored",
    });
    assert.equal(dir, path.join("/out", "abc"));
  });

  it("derives a sanitized timestamp by default without separators", () => {
    const dir = resolveDiagnosticsBundleDir({ stateDir: STATE, runId: "run-abc" });
    assert.ok(dir.startsWith(path.join(STATE, "diagnostics", "abc-")), dir);
    const name = path.basename(dir);
    assert.ok(!name.includes("/") && !name.includes(":"), name);
  });
});

describe("resolveRunEvidenceDir", () => {
  it("is <state>/runs/<bareRunId>", () => {
    assert.equal(
      resolveRunEvidenceDir(STATE, "run-abc"),
      path.join(STATE, "runs", "abc"),
    );
  });
});

describe("resolveSuiteLogsDir", () => {
  it("is <state>/suite-logs", () => {
    assert.equal(resolveSuiteLogsDir(STATE), path.join(STATE, "suite-logs"));
  });
});

describe("resolveDaemonLogFiles", () => {
  it("enumerates the current log plus .1 through .5", () => {
    const files = resolveDaemonLogFiles(STATE);
    assert.equal(files.length, 6);
    assert.equal(files[0], path.join(STATE, "tamandua.log"));
    for (let i = 1; i <= 5; i++) {
      assert.equal(files[i], path.join(STATE, `tamandua.log.${i}`));
    }
  });
});

describe("isPathInside", () => {
  it("accepts a strict descendant", () => {
    assert.equal(isPathInside(STATE, path.join(STATE, "runs", "abc")), true);
  });

  it("rejects the parent itself", () => {
    assert.equal(isPathInside(STATE, STATE), false);
  });

  it("rejects a sibling sharing a name prefix", () => {
    assert.equal(isPathInside("/a/b", "/a/bc"), false);
  });

  it("rejects a path that escapes via '..'", () => {
    assert.equal(isPathInside(STATE, path.join(STATE, "..", "etc")), false);
  });

  it("returns false for empty inputs", () => {
    assert.equal(isPathInside("", "/a"), false);
    assert.equal(isPathInside("/a", ""), false);
  });
});