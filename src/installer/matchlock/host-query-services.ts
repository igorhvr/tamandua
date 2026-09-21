/**
 * Host broker: run-scoped read-only QUERY service contract (US-004).
 *
 * The guest bounded query surface (step stories / workflow status / bounded
 * run-scoped logs) is served by the host broker through an OPTIONAL injected
 * query service — a sibling of the suite bridge, NOT an extension of the
 * authoritative STEP services. Read-only queries must not require an opKey
 * and must never mutate invocation state; they only ever read the INVOCATION'S
 * OWN BOUND RUN (stories, run status, run events) and return native-shaped
 * payloads the guest CLI renders byte-identically to the native CLI.
 *
 * Authority model:
 *   - The broker validates the request wire shape (validateQueryBridgeParams)
 *     and refuses with a typed BINDING error BEFORE any host read when the
 *     requested run differs from the immutable HostBinding runId. A query
 *     service is therefore only ever reached for the bound run.
 *   - Defense in depth (mirrors NativeStepServices.assertBinding): every
 *     service method asserts the passed HostBinding.runId equals the run the
 *     service was constructed for; a mis-scoped adapter/broker can never read
 *     a different run's data.
 *   - Implementations are constructed ONLY from immutable controller-admitted
 *     scope (a bare run uuid from the HostBinding) — never from guest input.
 *   - Guest/context/env magic cannot enable queries: an absent injected
 *     service means the broker refuses every query op UNSUPPORTED.
 */

import type { HostBinding } from "./broker-services.js";
import type { GuestLogsPayload, GuestStoriesPayload } from "./guest-protocol.js";

/**
 * Optional host query service injected into the host broker. Implementations
 * read the bound run's stories / workflow status / recent run events through
 * the REAL native readers (step-ops.getStories, status.getWorkflowStatus +
 * buildWorkflowStatusJson, events.getRunEvents + logs-tail-format) and return
 * native-shaped payloads. All methods are read-only: no SQLite write, no
 * invocation state mutation, no idempotency ledger participation.
 */
export interface HostQueryServices {
  /**
   * Stories for the bound run. Returns a native-shaped GuestStoriesPayload
   * (prefixed run id + per-story presentation fields). Empty story plan is a
   * valid answer ({ stories: [] }), never an error.
   */
  stories(binding: HostBinding): Promise<GuestStoriesPayload>;
  /**
   * The native `workflow status <run> --json` run-JSON object for the bound
   * run (identical to the native CLI's buildWorkflowStatusJson output). A
   * vanished run row is surfaced as a service error, never fabricated.
   */
  workflowStatus(binding: HostBinding): Promise<Record<string, unknown>>;
  /**
   * Bounded run-scoped log lines for the bound run: the most recent
   * `limit` (bounded by the wire maximum) run events rendered with the
   * native logs-tail formatter, byte-bounded by GUEST_RUN_LOG_PAYLOAD_BYTES.
   */
  runLogs(binding: HostBinding, limit: number): Promise<GuestLogsPayload>;
}
