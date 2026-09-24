/**
 * DIAG-PRUNE US-004 — unit tests for the run event stream collector.
 *
 * Pure filesystem fixtures under an isolated temp state dir (no daemon, no
 * child_process, no DB) — stays in the parallel lane. Every fixture writes
 * real JSONL into a temp `<state>/events/` tree so the collector's file order,
 * dedupe, runId filtering and corrupt-line classification are exercised end to
 * end.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { collectRunEvents } from "../../dist/diagnostics/collect-events.js";

const BARE = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER = "bbbbbbbb-2222-4222-8222-222222222222";

const created: string[] = [];

function makeState(prefix = "diag-events-"): string {
  const dir = tamanduaTempDir(prefix);
  created.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function eventsDir(stateDir: string): string {
  return path.join(stateDir, "events");
}

function evtLine(runId: string, event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: "2026-01-01T00:00:00.000Z",
    event,
    runId,
    ...extra,
  });
}

after(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("collectRunEvents", () => {
  it("returns run-scoped events in order and appends matching rotated global lines without duplicates", () => {
    const state = makeState();
    const dir = eventsDir(state);
    const e1 = evtLine(BARE, "run.one");
    const e2 = evtLine(BARE, "run.two");
    const ga = evtLine(BARE, "global.a");
    const gp = evtLine(`run-${BARE}`, "global.prefixed");
    const g3 = evtLine(BARE, "global.three");
    const g4 = evtLine(BARE, "global.four");
    const other = evtLine(OTHER, "global.other");

    // Run-scoped file: the authoritative ordered stream.
    writeFile(path.join(dir, `${BARE}.jsonl`), `${e1}\n${e2}\n`);
    // Global rotations, oldest (.3) to newest; e2 is a byte-identical global
    // copy of the run-scoped line and must not be duplicated.
    writeFile(path.join(dir, "all.jsonl.3"), `${ga}\n`);
    writeFile(path.join(dir, "all.jsonl.2"), `${gp}\n`);
    writeFile(path.join(dir, "all.jsonl.1"), `${e2}\n${g3}\n`);
    writeFile(path.join(dir, "all.jsonl"), `${g4}\n${other}\n`);

    const result = collectRunEvents({ stateDir: state, bareRunId: BARE });

    assert.equal(result.status, "present");
    assert.deepEqual(
      result.events.map((event) => event.event),
      ["run.one", "run.two", "global.a", "global.prefixed", "global.three", "global.four"],
    );
    assert.equal(result.corrupt.length, 0);
    assert.deepEqual(result.files, [
      path.join(dir, `${BARE}.jsonl`),
      path.join(dir, "all.jsonl.3"),
      path.join(dir, "all.jsonl.2"),
      path.join(dir, "all.jsonl.1"),
      path.join(dir, "all.jsonl"),
    ]);
  });

  it("accepts a run- prefixed selector and never mutates a source file", () => {
    const state = makeState();
    const dir = eventsDir(state);
    const file = path.join(dir, `${BARE}.jsonl`);
    writeFile(file, `${evtLine(BARE, "run.one")}\n`);
    const before = fs.readFileSync(file);

    const result = collectRunEvents({ stateDir: state, bareRunId: `run-${BARE}` });

    assert.equal(result.status, "present");
    assert.deepEqual(result.events.map((event) => event.event), ["run.one"]);
    assert.deepEqual(fs.readFileSync(file), before);
  });

  it("reports 'absent' when no event source files exist", () => {
    const state = makeState();

    const result = collectRunEvents({ stateDir: state, bareRunId: BARE });

    assert.equal(result.status, "absent");
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.corrupt, []);
    assert.deepEqual(result.files, []);
    assert.match(result.absenceReason ?? "", /no event source files present/);
  });

  it("reports 'empty' when files exist but hold no matching run events", () => {
    const state = makeState();
    writeFile(path.join(eventsDir(state), "all.jsonl"), `${evtLine(OTHER, "global.other")}\n`);

    const result = collectRunEvents({ stateDir: state, bareRunId: BARE });

    assert.equal(result.status, "empty");
    assert.deepEqual(result.events, []);
    assert.equal(result.files.length, 1);
  });

  it("classifies a corrupt interior line without throwing and keeps the valid events", () => {
    const state = makeState();
    const dir = eventsDir(state);
    const file = path.join(dir, `${BARE}.jsonl`);
    writeFile(file, `${evtLine(BARE, "run.one")}\n{not valid json\n${evtLine(BARE, "run.two")}\n`);

    const result = collectRunEvents({ stateDir: state, bareRunId: BARE });

    assert.equal(result.status, "present");
    assert.deepEqual(result.events.map((event) => event.event), ["run.one", "run.two"]);
    assert.equal(result.corrupt.length, 1);
    assert.equal(result.corrupt[0].file, file);
    assert.match(result.corrupt[0].preview, /\{not valid json/);
    assert.ok(result.corrupt[0].length > 0);
  });

  it("ignores a torn trailing line and still reports the complete events", () => {
    const state = makeState();
    const dir = eventsDir(state);
    writeFile(path.join(dir, `${BARE}.jsonl`), `${evtLine(BARE, "run.one")}\n{"torn":`);

    const result = collectRunEvents({ stateDir: state, bareRunId: BARE });

    assert.equal(result.status, "present");
    assert.deepEqual(result.events.map((event) => event.event), ["run.one"]);
    assert.equal(result.corrupt.length, 0);
  });

  it("reports 'empty' when the only content is corrupt", () => {
    const state = makeState();
    writeFile(path.join(eventsDir(state), `${BARE}.jsonl`), "oops\n");

    const result = collectRunEvents({ stateDir: state, bareRunId: BARE });

    assert.equal(result.status, "empty");
    assert.deepEqual(result.events, []);
    assert.equal(result.corrupt.length, 1);
  });
});