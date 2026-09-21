/**
 * TEST-SUPPORT utilities for the MTLK-STEP native-step-* suites.
 *
 * Ships in dist (like broker-test-services.ts) so the parallel/serial tests
 * import it from dist. Provides a per-test isolated real DB (fresh HOME /
 * TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH, opened through the REAL getDb()
 * migration path so every suite runs against the true candidate schema),
 * row-seeding helpers and run-event reading. Spawns nothing.
 */

import fs from "node:fs";
import { tamanduaTempDir } from "../../lib/temp-dir.js";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb } from "../../db.js";
import { SQL_NOW_ISO } from "../../lib/instant.js";
import type { HostBinding } from "./broker-services.js";

export const RUN = "11111111-1111-4111-8111-111111111111";
export const AGENT = "feature-dev-merge_developer";
export const JOB_ID = "job-11111111-1111-4111-8111-111111111111";

export interface RunSeed {
  id?: string;
  workflowId?: string;
  status?: string;
  context?: string;
}

export interface StepSeed {
  id: string;
  stepId?: string;
  agentId?: string;
  runId?: string;
  stepIndex?: number;
  inputTemplate?: string;
  expects?: string;
  status?: string;
  retryCount?: number;
  maxRetries?: number;
  type?: string;
  loopConfig?: string | null;
  currentStoryId?: string | null;
  output?: string | null;
  claimJobId?: string | null;
  claimPid?: number | null;
  claimUpdatedAt?: string | null;
}

export interface StorySeed {
  id: string;
  runId?: string;
  storyIndex?: number;
  storyId?: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  status?: string;
  retryCount?: number;
  maxRetries?: number;
}

/** Make a HostBinding for a given invocation (fresh per invocation). */
export function bindingFor(invocationId: string, over: Partial<HostBinding> = {}): HostBinding {
  return {
    runId: RUN,
    invocationId,
    agentId: AGENT,
    jobId: JOB_ID,
    role: "developer",
    admittedRoots: ["/work"],
    helperProtocolVersion: "bv+p1",
    helperBuildVersion: "bv",
    ...over,
  };
}

export function freshUuid(): string {
  return randomUUID();
}

export interface IsolatedState {
  root: string;
  homeDir: string;
  stateDir: string;
  dbPath: string;
  /** Open migrated real DB handle. */
  open(): void;
  insertRun(seed?: RunSeed): string;
  insertStep(seed: StepSeed): void;
  insertStory(seed: StorySeed): string;
  /** Read run-scoped event JSONL lines emitted so far. */
  readRunEvents(runId: string): Array<Record<string, unknown>>;
  readAllEvents(): Array<Record<string, unknown>>;
  /** Close the module DB handle, restore the caller-provided env, remove this tree. */
  dispose(restoreEnv: Record<string, string | undefined>): void;
}

/**
 * Create a fresh isolated state tree and point the module-level env at it.
 * `applySticky`/restore semantics are handled by the caller (see the
 * step-ops test sticky-env pattern) so late fire-and-forget continuations
 * never resolve against the operator's real state.
 */
export function createIsolatedState(tag: string): IsolatedState {
  const root = tamanduaTempDir(`mtlk-${tag}-`);
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const dbPath = path.join(stateDir, "tamandua.db");
  fs.mkdirSync(stateDir, { recursive: true });

  const apply = (): void => {
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = dbPath;
  };

  return {
    root,
    homeDir,
    stateDir,
    dbPath,
    open() {
      apply();
      getDb();
    },
    insertRun(seed: RunSeed = {}): string {
      const db = getDb();
      const id = seed.id ?? RUN;
      db.prepare(
        `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ${SQL_NOW_ISO}, ${SQL_NOW_ISO})`,
      ).run(id, seed.workflowId ?? "test", "test task", seed.status ?? "running", seed.context ?? "{}");
      return id;
    },
    insertStep(seed: StepSeed): void {
      const db = getDb();
      const runId = seed.runId ?? RUN;
      db.prepare(
        `INSERT INTO steps (
           id, run_id, step_id, agent_id, step_index, input_template, expects,
           status, output, retry_count, max_retries, type, loop_config,
           current_story_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO}, ${SQL_NOW_ISO})`,
      ).run(
        seed.id,
        runId,
        seed.stepId ?? "plan",
        seed.agentId ?? AGENT,
        seed.stepIndex ?? 0,
        seed.inputTemplate ?? "plain task text",
        seed.expects ?? "",
        seed.status ?? "pending",
        seed.output ?? null,
        seed.retryCount ?? 0,
        seed.maxRetries ?? 4,
        seed.type ?? "single",
        seed.loopConfig ?? null,
        seed.currentStoryId ?? null,
      );
      if (seed.claimJobId !== undefined || seed.claimPid !== undefined || seed.claimUpdatedAt !== undefined) {
        db.prepare(
          "UPDATE steps SET claim_job_id = ?, claim_pid = ?, claim_updated_at = ? WHERE id = ?",
        ).run(seed.claimJobId ?? null, seed.claimPid ?? null, seed.claimUpdatedAt ?? null, seed.id);
      }
    },
    insertStory(seed: StorySeed): string {
      const db = getDb();
      const runId = seed.runId ?? RUN;
      db.prepare(
        `INSERT INTO stories (
           id, run_id, story_index, story_id, title, description,
           acceptance_criteria, status, output, retry_count, max_retries,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO}, ${SQL_NOW_ISO})`,
      ).run(
        seed.id,
        runId,
        seed.storyIndex ?? 0,
        seed.storyId ?? "US-001",
        seed.title ?? "Story title",
        seed.description ?? "",
        JSON.stringify(seed.acceptanceCriteria ?? []),
        seed.status ?? "pending",
        null,
        seed.retryCount ?? 0,
        seed.maxRetries ?? 4,
      );
      return seed.id;
    },
    readRunEvents(runId: string): Array<Record<string, unknown>> {
      const file = path.join(stateDir, "events", `${runId}.jsonl`);
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, "utf-8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    readAllEvents(): Array<Record<string, unknown>> {
      const file = path.join(stateDir, "events", "all.jsonl");
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, "utf-8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    dispose(restoreEnv) {
      try {
        closeDb();
      } catch {
        /* ignore */
      }
      for (const [key, value] of Object.entries(restoreEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup of our own fixture tree */
      }
    },
  };
}

/** Snapshot of the current HOME/STATE/DB env for restoration. */
export function snapshotEnv(): Record<string, string | undefined> {
  return {
    HOME: process.env.HOME,
    TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
    TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
  };
}

export function applyEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
