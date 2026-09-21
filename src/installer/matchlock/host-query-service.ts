/**
 * Production host query service (US-004): real native readers behind the
 * broker's run-scoped read-only query ops.
 *
 * Constructed ONLY from immutable controller-admitted scope — the bare run
 * uuid of the HostBinding (never guest input). It reads the BOUND run's
 * stories / workflow status / recent run events through the REAL native
 * readers and returns native-shaped payloads:
 *
 *   stories()        getStories(runId) + native story presentation fields
 *   workflowStatus() getWorkflowStatus(runId) + buildWorkflowStatusJson
 *                    (the exact object `tamandua workflow status --json`
 *                    prints — shared builder, byte-identical)
 *   runLogs()        getRunEvents(runId, boundedLimit) +
 *                    formatLogsTailLines, byte-bounded so a huge run event
 *                    file can never push an oversized frame into the guest
 *                    bridge
 *
 * Authority: every method asserts the passed HostBinding.runId equals the
 * run the service was constructed for (defense in depth — the broker already
 * refuses any non-bound run with a typed BINDING error BEFORE delegating).
 * All reads are read-only and never touch invocation state or the ledger.
 *
 * This module is HOST-side (imports native ../status / ../step-ops /
 * ../events / ../logs-tail-format) — it is never part of the portable RO
 * guest pack closure, which is why the pack can stay Node-core only.
 */

import { prefixRunId } from "../../lib/id-prefix.js";
import { getStories } from "../step-ops.js";
import { getWorkflowStatus, buildWorkflowStatusJson } from "../status.js";
import { getRunEvents, countRunEvents } from "../events.js";
import { formatLogsTailLines } from "../logs-tail-format.js";
import type { HostBinding } from "./broker-services.js";
import type { HostQueryServices } from "./host-query-services.js";
import {
  GUEST_RUN_LOG_DEFAULT_LIMIT,
  GUEST_RUN_LOG_LIMIT_MAX,
  GUEST_RUN_LOG_PAYLOAD_BYTES,
  type GuestLogsPayload,
  type GuestStoriesPayload,
} from "./guest-protocol.js";

export interface NativeQueryServicesOptions {
  /** Bound run id (bare uuid) — from the immutable HostBinding, never guest input. */
  runId: string;
  /** Optional uniform delay (ms) before every query so cancellation tests are deterministic. */
  serviceDelayMs?: number;
}

/**
 * Production HostQueryServices over the REAL native readers for the bound run.
 */
export class NativeQueryServices implements HostQueryServices {
  private readonly runId: string;
  private readonly delayMs: number;

  constructor(opts: NativeQueryServicesOptions) {
    this.runId = opts.runId;
    this.delayMs = opts.serviceDelayMs ?? 0;
  }

  /** Defense in depth: only the service's own bound run may ever be read. */
  private assertBinding(binding: HostBinding): void {
    if (binding.runId !== this.runId) {
      throw new Error(
        `NativeQueryServices: binding mismatch (service bound to run ${this.runId}, got run ${binding.runId})`,
      );
    }
  }

  private async gate(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
  }

  async stories(binding: HostBinding): Promise<GuestStoriesPayload> {
    await this.gate();
    this.assertBinding(binding);
    const stories = getStories(this.runId).map((s) => ({
      storyId: s.storyId,
      title: s.title,
      status: s.status,
      retryCount: s.retryCount,
      resumeResetCount: s.resumeResetCount ?? 0,
      ...(s.abandonedCount !== undefined ? { abandonedCount: s.abandonedCount } : {}),
      ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
    }));
    return { runId: prefixRunId(this.runId), stories };
  }

  async workflowStatus(binding: HostBinding): Promise<Record<string, unknown>> {
    await this.gate();
    this.assertBinding(binding);
    const result = getWorkflowStatus(this.runId);
    return buildWorkflowStatusJson(result);
  }

  async runLogs(binding: HostBinding, limit: number): Promise<GuestLogsPayload> {
    await this.gate();
    this.assertBinding(binding);
    const bounded = Number.isInteger(limit) && limit >= 1
      ? Math.min(limit, GUEST_RUN_LOG_LIMIT_MAX)
      : GUEST_RUN_LOG_DEFAULT_LIMIT;
    // Native bounded tail: the last `bounded` valid run events, chronological.
    const events = getRunEvents(this.runId, bounded);
    const totalEvents = countRunEvents(this.runId);
    let truncated = totalEvents > events.length;

    // Byte-bound the response: keep the NEWEST native log lines that fit the
    // payload budget (drop the oldest first) so a giant detail field can never
    // blow the bounded bridge frame.
    let lines = formatLogsTailLines(events);
    let bytes = 0;
    for (const line of lines) bytes += Buffer.byteLength(line, "utf-8");
    let dropFront = 0;
    while (lines.length - dropFront > 0 && bytes > GUEST_RUN_LOG_PAYLOAD_BYTES) {
      bytes -= Buffer.byteLength(lines[dropFront], "utf-8");
      dropFront += 1;
    }
    if (dropFront > 0) {
      lines = lines.slice(dropFront);
      truncated = true;
    }
    return {
      runId: prefixRunId(this.runId),
      lines,
      truncated,
      limit: bounded,
    };
  }
}
