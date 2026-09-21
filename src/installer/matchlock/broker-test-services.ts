/**
 * TEST-ONLY in-memory AuthoritativeStepServices for the broker/guest bridge
 * contract tests (parallel broker tests + serial subprocess tests). Ships in
 * dist only so the tests can import it from there like production modules.
 *
 * The fake ENFORCES the broker contract rather than returning unconditional
 * success:
 *   - every call asserts the passed HostBinding matches the identity the fake
 *     was created for (binding mismatch => service error);
 *   - claim replacement is checked ATOMICALLY inside submitCompletion/
 *     submitFail against the expectedClaimId captured by the broker (stale /
 *     foreign / reassigned claims are rejected without mutation);
 *   - submit-time expects validation never mutates, so REJECTED retains the
 *     claim and the retry budget.
 *
 * Step semantics are a small approximation of native step-ops designed to
 * exercise the boundary contract: done/retry/failed verdicts, retry budget
 * exhaustion, duplicate/terminal blocking. The production adapter later wires
 * the REAL step state machine (documented in broker-services.ts); this fake is
 * not a substitute for it.
 */

import type {
  AuthoritativeStepServices,
  ClaimOutcome,
  CompleteOutcome,
  FailOutcome,
  HostBinding,
  HostClaim,
  PeekVerdict,
  ValidationDiagnostic,
} from "./broker-services.js";
import type { HostQueryServices } from "./host-query-services.js";
import type { GuestLogsPayload, GuestStoriesPayload, GuestStoryItem } from "./guest-protocol.js";
import { prefixRunId } from "../../lib/id-prefix.js";

export interface FakeStepRow {
  stepId: string; // bare uuid
  agentId: string;
  runId: string; // bare uuid
  status: "waiting" | "pending" | "running" | "done" | "failed" | "blocked";
  expects: string;
  input: string;
  retryCount: number;
  maxRetries: number;
  claimId: string | null;
  output?: string;
}

export interface FakeServicesOptions {
  runId: string; // bare uuid
  agentId: string;
  steps: FakeStepRow[];
  /** Optional artificial delay (ms) on every delegated op (cancel tests). */
  delayMs?: number;
}

export class FakeStepServices implements AuthoritativeStepServices {
  readonly events: Array<Record<string, unknown>> = [];
  /** Records optional seam calls: broker-driven in-flight authority revocation. */
  readonly revocations: Array<{ invocationId: string; reason: string }> = [];
  private claimCounter = 0;
  private readonly boundRunId: string;
  private readonly boundAgentId: string;
  private readonly delayMs?: number;

  constructor(private readonly opts: FakeServicesOptions) {
    this.boundRunId = opts.runId;
    this.boundAgentId = opts.agentId;
    this.delayMs = opts.delayMs;
  }

  private async gate(): Promise<void> {
    if (this.delayMs) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
  }

  private assertBinding(binding: HostBinding): void {
    if (binding.runId !== this.boundRunId || binding.agentId !== this.boundAgentId) {
      throw new Error(
        `FakeStepServices: binding mismatch (service bound to run ${this.boundRunId}/agent ${this.boundAgentId}, got run ${binding.runId}/agent ${binding.agentId})`,
      );
    }
  }

  private stepsFor(binding: HostBinding): FakeStepRow[] {
    this.assertBinding(binding);
    return this.opts.steps.filter(
      (s) => s.runId === binding.runId && s.agentId === binding.agentId,
    );
  }

  private runningClaim(binding: HostBinding): FakeStepRow | null {
    return this.stepsFor(binding).find((s) => s.status === "running" && s.claimId !== null) ?? null;
  }

  private firstPending(binding: HostBinding): FakeStepRow | null {
    return this.stepsFor(binding).find((s) => s.status === "pending") ?? null;
  }

  // ── AuthoritativeStepServices ─────────────────────────────────────────

  async readClaim(binding: HostBinding): Promise<HostClaim | null> {
    await this.gate();
    const row = this.runningClaim(binding);
    if (!row) return null;
    return {
      stepId: row.stepId,
      runId: row.runId,
      agentId: row.agentId,
      claimId: row.claimId!,
      expects: row.expects,
      input: row.input,
    };
  }

  async peek(binding: HostBinding): Promise<PeekVerdict> {
    await this.gate();
    return this.firstPending(binding) ? "HAS_WORK" : "NO_WORK";
  }

  async claim(binding: HostBinding): Promise<ClaimOutcome> {
    await this.gate();
    this.assertBinding(binding);
    const held = this.runningClaim(binding);
    if (held) {
      return { found: true, stepId: held.stepId, runId: held.runId, input: held.input };
    }
    const pending = this.firstPending(binding);
    if (!pending) return { found: false };
    pending.status = "running";
    this.claimCounter += 1;
    pending.claimId = `claim-${this.claimCounter}`;
    return { found: true, stepId: pending.stepId, runId: pending.runId, input: pending.input };
  }

  async validateCompletion(binding: HostBinding, stepId: string, output: string): Promise<ValidationDiagnostic> {
    await this.gate();
    const row = this.stepsFor(binding).find((s) => s.stepId === stepId);
    if (!row || row.status !== "running" || row.claimId === null) {
      return { verdict: "reject", code: "CLAIM_NOT_HELD", message: `step ${stepId} is not currently claimed`, missingKeys: [], invalidKeys: [] };
    }
    const err = validateExpectsLike(output, row.expects);
    if (err) {
      const diagnostic = diagnosticFromValidation(err);
      this.events.push({
        event: "step.submit.rejected",
        runId: row.runId,
        stepId,
        claimId: row.claimId,
        validationCode: "EXPECTS_REJECTED",
        diagnosticCode: diagnostic.code,
        missingKeys: diagnostic.missingKeys,
        invalidKeys: diagnostic.invalidKeys,
        ts: new Date().toISOString(),
      });
      this.events.push({
        event: "step.expects.validated",
        runId: row.runId,
        stepId,
        claimId: row.claimId,
        outcome: "rejected",
        verdict: null,
        diagnosticCode: diagnostic.code,
        transitionAction: "retry",
        ts: new Date().toISOString(),
      });
      return { verdict: "reject", message: err, ...diagnostic };
    }
    return { verdict: "accept", code: "EXPECTS_SATISFIED", message: "", missingKeys: [], invalidKeys: [] };
  }

  async submitCompletion(
    binding: HostBinding,
    expectedClaimId: string,
    stepId: string,
    output: string,
  ): Promise<CompleteOutcome> {
    await this.gate();
    this.assertBinding(binding);
    const row = this.stepsFor(binding).find((s) => s.stepId === stepId);
    if (!row) return { status: "blocked", mutated: false, detail: `step not found: ${stepId}` };
    if (row.status === "done" || row.status === "failed" || row.status === "blocked") {
      return { status: "blocked", mutated: false, detail: `step already ${row.status}` };
    }
    // ATOMIC claim check: a stale/foreign/reassigned claim is rejected here,
    // inside the mutation — an async precheck alone is insufficient.
    if (row.status !== "running" || row.claimId === null || row.claimId !== expectedClaimId) {
      return {
        status: "blocked",
        mutated: false,
        detail: `stale claim rejected: expected ${expectedClaimId}, authoritative claim is ${row.claimId ?? "none"}`,
      };
    }
    // Acceptance-time expects check (native re-validates inside completeStep).
    const verdict = output.match(/^STATUS:\s*(done|retry|failed)\s*$/mi)?.[1]?.toLowerCase() ?? "done";
    row.output = output;

    const emitValidated = (outcome: "accepted", finalVerdict: string, transitionAction: string): void => {
      this.events.push({
        event: "step.expects.validated",
        runId: row!.runId,
        stepId: row!.stepId,
        claimId: row!.claimId,
        outcome,
        verdict: finalVerdict === "done" ? "done" : finalVerdict,
        diagnosticCode: "EXPECTS_SATISFIED",
        transitionAction,
        ts: new Date().toISOString(),
      });
    };

    if (verdict === "retry") {
      row.retryCount += 1;
      if (row.retryCount > row.maxRetries) {
        row.status = "failed";
        row.claimId = null;
        emitValidated("accepted", "retry", "fail");
        return { status: "failed", mutated: true };
      }
      row.status = "pending";
      row.claimId = null;
      this.events.push({ event: "step.retry", runId: row.runId, stepId: row.stepId, ts: new Date().toISOString() });
      emitValidated("accepted", "retry", "retry");
      return { status: "retrying", detail: "STATUS: retry verdict", mutated: true };
    }
    if (verdict === "failed") {
      row.status = "failed";
      row.claimId = null;
      emitValidated("accepted", "failed", "fail");
      return { status: "failed", mutated: true };
    }
    row.status = "done";
    row.claimId = null;
    emitValidated("accepted", "done", "done");
    return { status: "advanced", mutated: true };
  }

  async submitFail(binding: HostBinding, expectedClaimId: string, stepId: string, reason: string): Promise<FailOutcome> {
    await this.gate();
    this.assertBinding(binding);
    const row = this.stepsFor(binding).find((s) => s.stepId === stepId);
    if (!row) return { status: "blocked", mutated: false };
    if (row.status !== "running" || row.claimId === null || row.claimId !== expectedClaimId) {
      return {
        status: "blocked",
        mutated: false,
      };
    }
    row.output = reason;
    row.retryCount += 1;
    if (row.retryCount > row.maxRetries) {
      row.status = "failed";
      row.claimId = null;
      this.events.push({ event: "step.failed", runId: row.runId, stepId: row.stepId, detail: reason, ts: new Date().toISOString() });
      return { status: "failed", mutated: true };
    }
    row.status = "pending";
    row.claimId = null;
    this.events.push({ event: "step.retry", runId: row.runId, stepId: row.stepId, detail: reason, ts: new Date().toISOString() });
    return { status: "retrying", mutated: true };
  }

  /** Optional narrow seam: broker-driven in-flight authority revocation. */
  revokeInvocationAuthority(invocationId: string, reason: string): void {
    this.revocations.push({ invocationId, reason });
  }

  emit(event: Record<string, unknown>): void {
    this.events.push(event);
  }

  // ── test helpers ───────────────────────────────────────────────────────

  held(): FakeStepRow | null {
    return this.opts.steps.find((s) => s.status === "running" && s.claimId !== null) ?? null;
  }

  row(stepId: string): FakeStepRow | undefined {
    return this.opts.steps.find((s) => s.stepId === stepId);
  }

  /** Simulate host-side claim replacement (orphan recovery / reassignment). */
  reassignClaim(stepId: string, newClaimId: string): void {
    const row = this.row(stepId);
    if (row) row.claimId = newClaimId;
  }
}

// ── TEST-ONLY run-scoped query services (US-004) ────────────────────────

export interface FakeQueryFixture {
  stories?: GuestStoryItem[];
  status?: Record<string, unknown>;
  logLines?: string[];
  logTruncated?: boolean;
  logLimit?: number;
}

/**
 * TEST-ONLY in-memory HostQueryServices for the broker/guest bridge query
 * contract tests. Enforces the same binding rule as the production adapter
 * (only its own bound run may be read) and records every call so a refusal
 * path can assert that NO host read happened.
 */
export class FakeQueryServices implements HostQueryServices {
  /** Invocations in order: "stories" | "workflowStatus" | "runLogs". */
  readonly calls: string[] = [];
  private readonly boundRunId: string;
  private readonly delayMs: number;

  constructor(
    private readonly opts: {
      runId: string;
      fixture: FakeQueryFixture;
      /** Optional artificial delay (ms) before answering (cancel tests). */
      delayMs?: number;
    },
  ) {
    this.boundRunId = opts.runId;
    this.delayMs = opts.delayMs ?? 0;
  }

  private async gate(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
  }

  private assertBinding(binding: HostBinding): void {
    if (binding.runId !== this.boundRunId) {
      throw new Error(
        `FakeQueryServices: binding mismatch (service bound to run ${this.boundRunId}, got run ${binding.runId})`,
      );
    }
  }

  async stories(binding: HostBinding): Promise<GuestStoriesPayload> {
    await this.gate();
    this.assertBinding(binding);
    this.calls.push("stories");
    return { runId: prefixRunId(this.boundRunId), stories: this.opts.fixture.stories ?? [] };
  }

  async workflowStatus(binding: HostBinding): Promise<Record<string, unknown>> {
    await this.gate();
    this.assertBinding(binding);
    this.calls.push("workflowStatus");
    return this.opts.fixture.status ?? {};
  }

  async runLogs(binding: HostBinding, limit: number): Promise<GuestLogsPayload> {
    await this.gate();
    this.assertBinding(binding);
    this.calls.push("runLogs");
    return {
      runId: prefixRunId(this.boundRunId),
      lines: this.opts.fixture.logLines ?? [],
      truncated: this.opts.fixture.logTruncated ?? false,
      // Echo the broker-passed bounded limit unless the fixture pins one.
      limit: this.opts.fixture.logLimit ?? limit,
    };
  }
}

/** Simplified native validateExpects (literal lines + regex: lines). */
export function validateExpectsLike(output: string, expects: string): string | null {
  if (!expects || expects.trim() === "") return null;
  const statusMatch = output.match(/^STATUS:\s*(\S+)/m);
  if (statusMatch) {
    const variant = statusMatch[1].trim();
    if (variant.toLowerCase() !== "done" && expects.split("\n").some((l) => l.trim() === `STATUS: ${variant}`)) {
      return null;
    }
  }
  for (const line of expects.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("regex:")) {
      const pattern = trimmed.slice("regex:".length);
      try {
        const re = new RegExp(pattern, "m");
        if (!re.test(output)) return `Output does not match expects regex: ${pattern}`;
      } catch {
        return `Invalid expects regex pattern: ${pattern}`;
      }
    } else if (!output.includes(trimmed)) {
      return `Output missing expects string: "${trimmed}"`;
    }
  }
  return null;
}

export function diagnosticFromValidation(validationError: string): {
  code: string;
  missingKeys: string[];
  invalidKeys: string[];
} {
  const missing = validationError.match(/^Output missing expects string: "([A-Z][A-Z0-9_]*):/);
  if (missing) return { missingKeys: [missing[1]], invalidKeys: [], code: `EXPECTS_MISSING_${missing[1]}` };
  const invalid = /^Invalid expects regex pattern:/.test(validationError);
  return {
    missingKeys: [],
    invalidKeys: invalid ? ["EXPECTS_REGEX"] : ["EXPECTS_MATCH"],
    code: invalid ? "EXPECTS_INVALID_REGEX" : "EXPECTS_REGEX_MISMATCH",
  };
}
