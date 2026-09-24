/**
 * DIAG-PRUNE US-007 — unit tests for the harness session-path collector.
 *
 * `collect-sessions.ts` imports `src/installer/dsh-usage.ts`, which owns a
 * `node:child_process` import (its zstd binary fallback), so this file is
 * registered in `tests/serial-files.txt`.
 *
 * All fixtures are real files under isolated temp dirs passed through the
 * `homes` env bag, so no process env mutation and no real session store is
 * touched. The collector only stats/lists — these tests assert paths and
 * sizes, never contents.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  collectSessionPaths,
  piSessionProjectDir,
  resolvePiHome,
} from "../../dist/diagnostics/collect-sessions.js";
import { projectKey } from "../../dist/installer/dsh-usage.js";
import { resolveHermesHome } from "../../dist/installer/hermes-usage.js";

const WORKDIR = "/home/user/project";

const created: string[] = [];

function makeHome(prefix: string): string {
  const dir = tamanduaTempDir(prefix);
  created.push(dir);
  return dir;
}

after(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(full: string, content: string): void {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function entryFor(entries: ReturnType<typeof collectSessionPaths>["entries"], harness: string) {
  const entry = entries.find((candidate) => candidate.harness === harness);
  assert.ok(entry, `expected a ${harness} entry`);
  return entry;
}

describe("collectSessionPaths — resolved stores", () => {
  it("resolves the pi session store and lists existing .jsonl files with sizes", () => {
    const piHome = makeHome("diag-sessions-pi-");
    const storeDir = piSessionProjectDir(piHome, WORKDIR);
    writeFile(path.join(storeDir, "2026-01-01T00-00-00-000Z_abc.jsonl"), "pi-session");
    // A non-session file is not part of the pi listing.
    writeFile(path.join(storeDir, "notes.txt"), "not a session");

    const result = collectSessionPaths({
      workdir: WORKDIR,
      homes: { PI_HOME: piHome },
    });

    assert.equal(result.workdir, WORKDIR);
    const pi = entryFor(result.entries, "pi");
    assert.equal(pi.status, "present");
    assert.equal(pi.storeDir, storeDir);
    assert.deepEqual(pi.candidatePaths, [storeDir]);
    assert.equal(pi.files.length, 1);
    assert.equal(pi.files[0].path, path.join(storeDir, "2026-01-01T00-00-00-000Z_abc.jsonl"));
    assert.equal(pi.files[0].sizeBytes, "pi-session".length);
    assert.equal(result.status, "present");
  });

  it("resolves the dsh session store listing nested v3 session files", () => {
    const dshHome = makeHome("diag-sessions-dsh-");
    const storeDir = path.join(dshHome, "sessions", projectKey(WORKDIR));
    const v3 = path.join(storeDir, "session-1111", "session.v3.jsonl.zstd");
    writeFile(v3, "dsh-session-bytes");
    writeFile(path.join(storeDir, "session-1111", "session.lock"), "lock");

    const result = collectSessionPaths({
      workdir: WORKDIR,
      homes: { DSH_HOME: dshHome },
    });

    const dsh = entryFor(result.entries, "dsh");
    assert.equal(dsh.status, "present");
    assert.equal(dsh.storeDir, storeDir);
    assert.ok(dsh.files.some((file) => file.path === v3 && file.sizeBytes === "dsh-session-bytes".length));
    assert.ok(dsh.files.some((file) => file.path.endsWith("session.lock")));
  });

  it("resolves the hermes state.db path without opening the database", () => {
    const hermesHome = makeHome("diag-sessions-hermes-");
    const dbPath = path.join(hermesHome, "state.db");
    fs.writeFileSync(dbPath, "sqlite-bytes");

    const result = collectSessionPaths({
      workdir: WORKDIR,
      homes: { HERMES_HOME: hermesHome },
    });

    const hermes = entryFor(result.entries, "hermes");
    assert.equal(hermes.status, "present");
    assert.equal(hermes.storeDir, hermesHome);
    assert.deepEqual(hermes.candidatePaths, [dbPath]);
    assert.deepEqual(hermes.files, [{ path: dbPath, sizeBytes: "sqlite-bytes".length }]);
  });

  it("bounds the listed files with maxFiles", () => {
    const piHome = makeHome("diag-sessions-cap-");
    const storeDir = piSessionProjectDir(piHome, WORKDIR);
    for (let i = 0; i < 5; i++) {
      writeFile(path.join(storeDir, `session-${i}.jsonl`), `s${i}`);
    }

    const result = collectSessionPaths({
      workdir: WORKDIR,
      homes: { PI_HOME: piHome },
      maxFiles: 2,
    });

    const pi = entryFor(result.entries, "pi");
    assert.equal(pi.status, "present");
    assert.equal(pi.files.length, 2);
  });
});

describe("collectSessionPaths — absent sources never throw", () => {
  it("reports each missing store 'absent' with its candidate path", () => {
    const piHome = makeHome("diag-sessions-absent-pi-");
    const dshHome = makeHome("diag-sessions-absent-dsh-");
    const hermesHome = makeHome("diag-sessions-absent-hermes-");

    const result = collectSessionPaths({
      workdir: WORKDIR,
      homes: { PI_HOME: piHome, DSH_HOME: dshHome, HERMES_HOME: hermesHome },
    });

    const pi = entryFor(result.entries, "pi");
    assert.equal(pi.status, "absent");
    assert.equal(pi.candidatePaths[0], piSessionProjectDir(piHome, WORKDIR));
    assert.match(pi.absenceReason ?? "", /not found/);

    const dsh = entryFor(result.entries, "dsh");
    assert.equal(dsh.status, "absent");
    assert.equal(dsh.candidatePaths[0], path.join(dshHome, "sessions", projectKey(WORKDIR)));

    const hermes = entryFor(result.entries, "hermes");
    assert.equal(hermes.status, "absent");
    assert.equal(hermes.candidatePaths[0], path.join(hermesHome, "state.db"));

    assert.equal(result.status, "absent");
  });

  it("reports 'empty' when a store root exists but holds no session files", () => {
    const piHome = makeHome("diag-sessions-empty-");
    const dshHome = makeHome("diag-sessions-empty-dsh-");
    const hermesHome = makeHome("diag-sessions-empty-hermes-");
    fs.mkdirSync(piSessionProjectDir(piHome, WORKDIR), { recursive: true });

    const result = collectSessionPaths({
      workdir: WORKDIR,
      homes: { PI_HOME: piHome, DSH_HOME: dshHome, HERMES_HOME: hermesHome },
    });

    const pi = entryFor(result.entries, "pi");
    assert.equal(pi.status, "empty");
    assert.deepEqual(pi.files, []);
    assert.equal(result.status, "empty");
  });

  it("reports an empty workdir as absent pi/dsh stores without throwing", () => {
    const hermesHome = makeHome("diag-sessions-emptywd-");
    fs.writeFileSync(path.join(hermesHome, "state.db"), "db");

    const result = collectSessionPaths({
      workdir: "",
      homes: { PI_HOME: makeHome("diag-sessions-emptywd-pi-"), HERMES_HOME: hermesHome },
    });

    const pi = entryFor(result.entries, "pi");
    assert.equal(pi.status, "absent");
    assert.equal(pi.storeDir, null);
    assert.match(pi.absenceReason ?? "", /pi session key/);
    const dsh = entryFor(result.entries, "dsh");
    assert.equal(dsh.status, "absent");
    assert.match(dsh.absenceReason ?? "", /dsh session key/);
    // The hermes store is workdir-independent and still resolves.
    assert.equal(entryFor(result.entries, "hermes").status, "present");
    assert.equal(result.status, "present");
  });

  it("does not loop when a store contains a symlink cycle", () => {
    const piHome = makeHome("diag-sessions-loop-");
    const storeDir = piSessionProjectDir(piHome, WORKDIR);
    writeFile(path.join(storeDir, "one.jsonl"), "x");
    fs.symlinkSync(storeDir, path.join(storeDir, "self"));

    const result = collectSessionPaths({
      workdir: WORKDIR,
      homes: { PI_HOME: piHome },
    });

    const pi = entryFor(result.entries, "pi");
    assert.equal(pi.status, "present");
    assert.equal(pi.files.length, 1);
  });
});

describe("session home resolution exports", () => {
  it("resolveHermesHome honours an explicit HERMES_HOME", () => {
    const home = makeHome("diag-sessions-hermes-export-");
    assert.equal(resolveHermesHome({ HERMES_HOME: home }), home);
  });

  it("resolvePiHome honours an explicit PI_HOME", () => {
    const home = makeHome("diag-sessions-pi-export-");
    assert.equal(resolvePiHome({ PI_HOME: home }), home);
  });
});