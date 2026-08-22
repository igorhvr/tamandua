/**
 * Merge event identity end-to-end (TATR facet 1, US-010).
 *
 * Integration proof that a run-scoped merge landing emits merge.landed into
 * events/<runId>.jsonl AND the global events/all.jsonl with the run id, that a
 * genuinely runless manual merge (no --run-id, no TAMANDUA_RUN_ID env) emits
 * runId "" into events/.jsonl, and that the target ref's reflog carries a
 * structured message naming the run (or the "(manual)" marker).
 *
 * Scope:
 *  - runPlumbingMerge (dist) invoked with an explicit runId (library path),
 *  - the CLI (node dist/cli/cli.js merge-branch) with --run-id,
 *  - the CLI with TAMANDUA_RUN_ID env (fallback), and
 *  - the CLI with neither (documented runless manual merge).
 *
 * Each test creates an isolated temp HOME + TAMANDUA_STATE_DIR (createTempHome)
 * and seeds a runs row for the known run id in a temp DB (subprocess that
 * imports getDb from dist, so the schema is created by migrate()).
 *
 * Serial lane: spawns git + node subprocesses (node:child_process import).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";

const repoRoot = process.cwd();
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");

const cleanup: string[] = [];

// ── Git helpers ──────────────────────────────────────────────────────

function rawGit(repo: string, args: string[]) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? -1,
  };
}

function git(repo: string, args: string[]): string {
  const result = rawGit(repo, args);
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

/** Init a repo on main with a base commit; returns the repo path + initial tip. */
function createRepo(): { repo: string; initial: string } {
  const repo = tamanduaTempDir("tamandua-merge-identity-repo-");
  cleanup.push(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "test@tamandua.local"]);
  git(repo, ["config", "user.name", "Tamandua Test"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf-8");
  git(repo, ["add", "base.txt"]);
  git(repo, ["commit", "-m", "base"]);
  return { repo, initial: git(repo, ["rev-parse", "HEAD"]) };
}

/** Create a feature branch (a real landing — NOT an ancestor of main) and return to main. */
function createFeature(repo: string, start: string): void {
  git(repo, ["switch", "-c", "feature", start]);
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n", "utf-8");
  git(repo, ["add", "feature.txt"]);
  git(repo, ["commit", "-m", "feature"]);
  git(repo, ["switch", "main"]);
}

// ── Subprocess helpers (isolated env via cleanChildEnv) ──────────────

/** Spawn `node --input-type=module -e <script>` with the isolated env. */
function runNodeEval(script: string, env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: cleanChildEnv(env),
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

/** Spawn the merge-branch CLI (node dist/cli/cli.js merge-branch ...). */
function runMergeCli(args: string[], env: Record<string, string>) {
  const result = spawnSync(process.execPath, [cliPath, "merge-branch", ...args], {
    cwd: repoRoot,
    env: cleanChildEnv(env),
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

function mergeCliArgs(repo: string, expectTip: string, into = "main"): string[] {
  return [
    "--origin", repo,
    "--branch", "feature",
    "--into", into,
    "--expect-tip", expectTip,
    "--message", "Land feature",
  ];
}

// ── State helpers ────────────────────────────────────────────────────

/** Read a JSONL events file as parsed records (missing file → []). */
function readEvents(eventsPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(eventsPath)) return [];
  const contents = fs.readFileSync(eventsPath, "utf-8").trim();
  if (!contents) return [];
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Seed a runs row for runId in the temp DB. Done in a subprocess that imports
 * getDb from dist so migrate() creates the schema (the in-process test env
 * never opens the temp DB through the getDb singleton).
 */
function seedRunRow(homeDir: string, stateDir: string, runId: string): void {
  const script = `
    import { getDb } from "./dist/db.js";
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-merge-identity', 'merge event identity integration', 'running', '{}', 0, ?, ?)"
    ).run(${JSON.stringify(runId)}, now, now);
    console.log("seeded");
  `;
  const result = runNodeEval(script, { HOME: homeDir, TAMANDUA_STATE_DIR: stateDir });
  assert.equal(result.status, 0, `seed run row failed:\n${result.stdout}\n${result.stderr}`);
}

/** Read back the seeded runs row for runId (undefined when absent). */
function readRunRow(stateDir: string, runId: string): { id: string } | undefined {
  const dbPath = path.join(stateDir, "tamandua.db");
  if (!fs.existsSync(dbPath)) return undefined;
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT id FROM runs WHERE id = ?").get(runId) as { id: string } | undefined;
  } finally {
    db.close();
  }
}

/** First (most recent) reflog subject of the target ref. */
function targetReflogFirstLine(repo: string, target = "main"): string {
  return git(repo, ["reflog", "show", "--format=%gs", `refs/heads/${target}`]).split("\n")[0] ?? "";
}

// ── Shared assertion helpers ─────────────────────────────────────────

/** Assert the run-scoped + global streams carry exactly one merge.landed with runId. */
function assertMergeLandedStreams(stateDir: string, runId: string): void {
  const runEvents = readEvents(path.join(stateDir, "events", `${runId}.jsonl`));
  assert.equal(runEvents.length, 1, `expected 1 event in events/${runId}.jsonl`);
  assert.equal(runEvents[0]?.event, "merge.landed");
  assert.equal(runEvents[0]?.runId, runId);

  const allEvents = readEvents(path.join(stateDir, "events", "all.jsonl"));
  assert.equal(allEvents.length, 1, "expected 1 event in events/all.jsonl");
  assert.equal(allEvents[0]?.event, "merge.landed");
  assert.equal(allEvents[0]?.runId, runId);
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("merge event identity end-to-end (TATR US-010)", () => {
  it("runPlumbingMerge with a run id lands merge.landed in events/<runId>.jsonl and all.jsonl", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, initial);
    const env = createTempHome("tamandua-merge-identity-runplumbing-");
    cleanup.push(env.root);
    const runId = crypto.randomUUID();

    // The run id belongs to a real run: seed a runs row in the temp DB.
    seedRunRow(env.homeDir, env.tamanduaDir, runId);

    const script = `
      import { runPlumbingMerge } from "./dist/installer/merge-branch.js";
      const result = runPlumbingMerge({
        origin: ${JSON.stringify(repo)},
        branch: "feature",
        into: "main",
        expectTip: ${JSON.stringify(initial)},
        message: "land feature",
        runId: ${JSON.stringify(runId)},
      });
      console.log(JSON.stringify({ status: result.status, mergedTree: result.mergedTree, mergedCommit: result.mergedCommit }));
    `;
    const result = runNodeEval(script, { HOME: env.homeDir, TAMANDUA_STATE_DIR: env.tamanduaDir });
    assert.equal(result.status, 0, `runPlumbingMerge failed:\n${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(
      result.stdout.trim().split(/\r?\n/).filter(Boolean).pop()!,
    ) as { status: string; mergedTree: string; mergedCommit: string };
    assert.equal(parsed.status, "landed");

    assertMergeLandedStreams(env.tamanduaDir, runId);

    // The run the merge was attributed to exists in the DB.
    assert.equal(readRunRow(env.tamanduaDir, runId)?.id, runId);

    // The target ref's reflog carries the structured message with the run id + tree.
    assert.equal(
      targetReflogFirstLine(repo),
      `tamandua: merge.landed run=${runId} tree=${parsed.mergedTree}`,
    );
  });

  it("CLI merge-branch --run-id lands merge.landed in the run-scoped and global streams", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, initial);
    const env = createTempHome("tamandua-merge-identity-cli-runid-");
    cleanup.push(env.root);
    const runId = crypto.randomUUID();
    seedRunRow(env.homeDir, env.tamanduaDir, runId);

    const result = runMergeCli(
      [...mergeCliArgs(repo, initial), "--run-id", runId],
      { HOME: env.homeDir, TAMANDUA_STATE_DIR: env.tamanduaDir },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^STATUS: landed$/m);

    assertMergeLandedStreams(env.tamanduaDir, runId);
    assert.equal(readRunRow(env.tamanduaDir, runId)?.id, runId);

    const mergedTree = git(repo, ["rev-parse", "refs/heads/main^{tree}"]);
    assert.equal(targetReflogFirstLine(repo), `tamandua: merge.landed run=${runId} tree=${mergedTree}`);
  });

  it("CLI merge-branch falls back to TAMANDUA_RUN_ID env for run-scoped events", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, initial);
    const env = createTempHome("tamandua-merge-identity-cli-env-");
    cleanup.push(env.root);
    const runId = crypto.randomUUID();
    seedRunRow(env.homeDir, env.tamanduaDir, runId);

    // No --run-id: runPlumbingMerge falls back to TAMANDUA_RUN_ID (US-003).
    const result = runMergeCli(mergeCliArgs(repo, initial), {
      HOME: env.homeDir,
      TAMANDUA_STATE_DIR: env.tamanduaDir,
      TAMANDUA_RUN_ID: runId,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^STATUS: landed$/m);

    assertMergeLandedStreams(env.tamanduaDir, runId);
    assert.equal(readRunRow(env.tamanduaDir, runId)?.id, runId);

    const mergedTree = git(repo, ["rev-parse", "refs/heads/main^{tree}"]);
    assert.equal(targetReflogFirstLine(repo), `tamandua: merge.landed run=${runId} tree=${mergedTree}`);
  });

  it("runless CLI merge (no --run-id, no env) emits runId '' to events/.jsonl with a (manual) reflog marker", () => {
    const { repo, initial } = createRepo();
    createFeature(repo, initial);
    const env = createTempHome("tamandua-merge-identity-runless-");
    cleanup.push(env.root);

    // cleanChildEnv strips ambient TAMANDUA_RUN_ID (not in BASE_ENV_KEYS), so
    // this invocation is genuinely runless.
    const result = runMergeCli(mergeCliArgs(repo, initial), {
      HOME: env.homeDir,
      TAMANDUA_STATE_DIR: env.tamanduaDir,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^STATUS: landed$/m);

    // Documented runless manual-merge behavior: runId "" in the global stream
    // and in events/.jsonl (the run-scoped file for an empty run id).
    const allEvents = readEvents(path.join(env.tamanduaDir, "events", "all.jsonl"));
    assert.equal(allEvents.length, 1, "expected 1 event in events/all.jsonl");
    assert.equal(allEvents[0]?.event, "merge.landed");
    assert.equal(allEvents[0]?.runId, "");

    const runlessEvents = readEvents(path.join(env.tamanduaDir, "events", ".jsonl"));
    assert.equal(runlessEvents.length, 1, "expected 1 event in events/.jsonl");
    assert.equal(runlessEvents[0]?.event, "merge.landed");
    assert.equal(runlessEvents[0]?.runId, "");

    // The reflog carries the "(manual)" marker instead of a run id.
    const mergedTree = git(repo, ["rev-parse", "refs/heads/main^{tree}"]);
    assert.equal(targetReflogFirstLine(repo), `tamandua: merge.landed (manual) tree=${mergedTree}`);
  });
});
