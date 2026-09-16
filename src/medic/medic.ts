/**
 * Medic — the tamandua health watchdog.
 *
 * Runs periodic health checks on workflow runs, detects stuck/stalled/dead state,
 * and takes corrective action where safe. Logs all findings to the medic_checks table.
 */
import { getDb } from "../db.js";
import { SQL_NOW_ISO } from "../lib/instant.js";
import { emitEvent } from "../installer/events.js";
import { teardownWorkflowCronsIfIdle } from "../installer/agent-scheduler.js";
import crypto from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────

export interface MedicFinding {
  severity: "info" | "warning" | "critical";
  message: string;
  action: "none" | "fail_run" | "teardown_crons";
  runId?: string;
  stepId?: string;
  workflowId?: string;
  remediated?: boolean;
}

// ── DB Migration ────────────────────────────────────────────────────

export function ensureMedicTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS medic_checks (
      id TEXT PRIMARY KEY,
      checked_at TEXT NOT NULL,
      issues_found INTEGER DEFAULT 0,
      actions_taken INTEGER DEFAULT 0,
      summary TEXT,
      details TEXT
    )
  `);
}

// ── Sync Checks ─────────────────────────────────────────────────────

const ZOMBIE_THRESHOLD_MINUTES = 60;

function getRunTokenSpend(runId: string): number | undefined {
  try {
    const db = getDb();
    const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as { tokens_spent: number } | undefined;
    return row?.tokens_spent;
  } catch {
    return undefined;
  }
}

function runSyncChecks(): MedicFinding[] {
  const findings: MedicFinding[] = [];
  const db = getDb();

  // Find zombie runs: all steps done/failed but run still "running"
  const zombieQuery = `
    SELECT r.id, r.workflow_id,
           (julianday('now') - julianday(r.updated_at)) * 24 * 60 AS idle_minutes
    FROM runs r
    WHERE r.status = 'running'
      AND (julianday('now') - julianday(r.updated_at)) * 24 * 60 > ?
      AND NOT EXISTS (
        SELECT 1 FROM steps s
        WHERE s.run_id = r.id AND s.status IN ('pending', 'running')
      )
  `;

  const zombies = db.prepare(zombieQuery).all(ZOMBIE_THRESHOLD_MINUTES) as Array<{
    id: string; workflow_id: string; idle_minutes: number;
  }>;

  for (const z of zombies) {
    findings.push({
      severity: "critical",
      message: `Run ${z.id.slice(0, 8)} is zombie — idle for ${Math.round(z.idle_minutes)}m with all steps terminal`,
      action: "fail_run",
      runId: z.id,
      workflowId: z.workflow_id,
    });
  }

  return findings;
}

// ── Remediation ─────────────────────────────────────────────────────

async function remediate(finding: MedicFinding): Promise<boolean> {
  const db = getDb();

  switch (finding.action) {
    case "fail_run": {
      if (!finding.runId) return false;
      const run = db.prepare("SELECT status, workflow_id FROM runs WHERE id = ?").get(finding.runId) as { status: string; workflow_id: string } | undefined;
      if (!run || run.status !== "running") return false;

      db.prepare(
        `UPDATE runs SET status = 'failed', updated_at = ${SQL_NOW_ISO} WHERE id = ?`
      ).run(finding.runId);
      db.prepare(
        `UPDATE steps SET status = 'failed', output = 'Medic: run marked as dead', updated_at = ${SQL_NOW_ISO} WHERE run_id = ? AND status IN ('waiting', 'pending', 'running')`
      ).run(finding.runId);
      emitEvent({
        ts: new Date().toISOString(),
        event: "run.failed",
        runId: finding.runId,
        workflowId: run.workflow_id,
        detail: "Medic: zombie run — all steps terminal but run still marked running",
        tokensSpent: getRunTokenSpend(finding.runId),
      });
      try { await teardownWorkflowCronsIfIdle(run.workflow_id); } catch {}
      return true;
    }

    case "teardown_crons": {
      const match = finding.message.match(/workflow "([^"]+)"/);
      if (!match) return false;
      try {
        await teardownWorkflowCronsIfIdle(match[1]);
        return true;
      } catch {
        return false;
      }
    }

    case "none":
    default:
      return false;
  }
}

// ── Main Check Runner ───────────────────────────────────────────────

export interface MedicCheckResult {
  id: string;
  checkedAt: string;
  issuesFound: number;
  actionsTaken: number;
  summary: string;
  findings: MedicFinding[];
}

export async function runMedicCheck(): Promise<MedicCheckResult> {
  ensureMedicTables();

  const findings: MedicFinding[] = runSyncChecks();

  // Remediate
  let actionsTaken = 0;
  for (const finding of findings) {
    if (finding.action !== "none") {
      const success = await remediate(finding);
      if (success) {
        finding.remediated = true;
        actionsTaken++;
      }
    }
  }

  // Build summary
  const parts: string[] = [];
  if (findings.length === 0) {
    parts.push("All clear — no issues found");
  } else {
    const critical = findings.filter(f => f.severity === "critical").length;
    const warnings = findings.filter(f => f.severity === "warning").length;
    if (critical > 0) parts.push(`${critical} critical`);
    if (warnings > 0) parts.push(`${warnings} warning(s)`);
    if (actionsTaken > 0) parts.push(`${actionsTaken} auto-fixed`);
  }
  const summary = parts.join(", ");

  // Log to DB
  const checkId = crypto.randomUUID();
  const checkedAt = new Date().toISOString();
  const db = getDb();
  db.prepare(
    "INSERT INTO medic_checks (id, checked_at, issues_found, actions_taken, summary, details) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(checkId, checkedAt, findings.length, actionsTaken, summary, JSON.stringify(findings));

  // Prune old checks (keep last 500)
  db.prepare(`
    DELETE FROM medic_checks WHERE id NOT IN (
      SELECT id FROM medic_checks ORDER BY checked_at DESC LIMIT 500
    )
  `).run();

  return {
    id: checkId,
    checkedAt,
    issuesFound: findings.length,
    actionsTaken,
    summary,
    findings,
  };
}

// ── Query Helpers ───────────────────────────────────────────────────

export interface MedicStatus {
  installed: boolean;
  lastCheck: { checkedAt: string; summary: string; issuesFound: number; actionsTaken: number } | null;
  recentChecks: number;
  recentIssues: number;
  recentActions: number;
}

export function getMedicStatus(): MedicStatus {
  try {
    ensureMedicTables();
    const db = getDb();

    const last = db.prepare(
      "SELECT checked_at, summary, issues_found, actions_taken FROM medic_checks ORDER BY checked_at DESC LIMIT 1"
    ).get() as { checked_at: string; summary: string; issues_found: number; actions_taken: number } | undefined;

    const stats = db.prepare(`
      SELECT COUNT(*) as checks, COALESCE(SUM(issues_found), 0) as issues, COALESCE(SUM(actions_taken), 0) as actions
      FROM medic_checks
      WHERE checked_at > datetime('now', '-24 hours')
    `).get() as { checks: number; issues: number; actions: number };

    return {
      installed: true,
      lastCheck: last ? {
        checkedAt: last.checked_at,
        summary: last.summary,
        issuesFound: last.issues_found,
        actionsTaken: last.actions_taken,
      } : null,
      recentChecks: stats.checks,
      recentIssues: stats.issues,
      recentActions: stats.actions,
    };
  } catch {
    return { installed: false, lastCheck: null, recentChecks: 0, recentIssues: 0, recentActions: 0 };
  }
}

export function getRecentMedicChecks(limit = 20): Array<{
  id: string;
  checkedAt: string;
  issuesFound: number;
  actionsTaken: number;
  summary: string;
  details: MedicFinding[];
}> {
  try {
    ensureMedicTables();
    const db = getDb();
    const rows = db.prepare(
      "SELECT * FROM medic_checks ORDER BY checked_at DESC LIMIT ?"
    ).all(limit) as Array<{
      id: string; checked_at: string; issues_found: number;
      actions_taken: number; summary: string; details: string;
    }>;

    return rows.map(r => ({
      id: r.id,
      checkedAt: r.checked_at,
      issuesFound: r.issues_found,
      actionsTaken: r.actions_taken,
      summary: r.summary,
      details: JSON.parse(r.details ?? "[]"),
    }));
  } catch {
    return [];
  }
}
