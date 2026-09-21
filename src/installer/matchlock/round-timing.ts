/**
 * round-timing.ts — the Matchlock in-VM round timing contract.
 *
 * The instant-fail / pre-claim-death classifier classifies on HARNESS wall time
 * (guest exec start → exit) and NEVER on whole-round wall time, so an in-VM
 * provider refusal that dies after a short round is still counted even when VM
 * boot took tens of seconds. A Matchlock invocation therefore reports THREE
 * separate intervals on its `HarnessRoundResult`:
 *
 *   - `durationMs`   — the WHOLE round (admission → teardown), unchanged;
 *   - `vmSetupMs`    — VM create/boot start → harness exec start (pre-exec VM
 *                      setup, incl. the guest bridge + broker handshake);
 *   - `harnessWallMs`— harness exec start → process exit (NEVER folded into
 *                      setup, and setup never folded into it).
 *
 * This tracker is the SINGLE place those seams are measured so the pi/hermes
 * runners (and the dsh route that composes the pi runner) cannot drift: both
 * runners drive the same class and report {@link MatchlockRoundTiming.harnessFields}
 * verbatim.
 *
 * TIME-CLOCKS rule 1: every interval uses the monotonic clock via `Stopwatch`
 * (never a `Date.now()` difference). The constructor accepts an injected
 * `ClockFn` so deterministic tests can prove the split without a VM.
 */

import { Stopwatch, monotonicNow, type ClockFn } from "../../lib/instant.js";

/** Timing fields reported on `HarnessRoundResult` for one Matchlock round. */
export interface MatchlockHarnessTimingFields {
  /** Harness exec start → exit (ms). Absent when the harness never started. */
  harnessWallMs?: number;
  /** VM setup start → harness exec start (ms). Absent when the harness never started. */
  vmSetupMs?: number;
}

/**
 * One Matchlock invocation's monotonic timing split. Construct at the very top
 * of the runner (the whole-round origin); the three marks then carve out the
 * setup and harness intervals:
 *
 * ```ts
 * const timing = new MatchlockRoundTiming(opts.clock);
 * // … admission / pack validation …
 * timing.startVmSetup();                    // immediately before create/boot
 * const created = await controller.prepareAndCreate(pin);
 * // … guest bridge + broker handshake (still setup) …
 * timing.startHarnessExec();                // immediately before the harness exec
 * const handle = controller.execPipe(harnessCommand, …);
 * // … exec settles / times out / is canceled …
 * timing.endHarnessExec();                  // as soon as the exec settled
 * return { durationMs: timing.roundMs, ...timing.harnessFields() };
 * ```
 *
 * An aborted/pre-create round that never started the harness exec reports NO
 * `harnessWallMs`/`vmSetupMs` — the fields remain absent rather than a
 * fabricated zero (a zero would be classified as an instant-fail).
 */
export class MatchlockRoundTiming {
  private readonly clock: ClockFn;
  private readonly roundWatch: Stopwatch;
  private setupStartMs: number | null = null;
  private setupEndMs: number | null = null;
  private harnessStartMs: number | null = null;
  private harnessEndMs: number | null = null;

  constructor(clock: ClockFn = monotonicNow) {
    this.clock = clock;
    this.roundWatch = new Stopwatch(clock);
  }

  /**
   * Mark the start of VM create/boot (immediately before the first create
   * attempt). Idempotent: the FIRST mark wins so a retried create cannot
   * shrink or re-base the setup interval.
   */
  startVmSetup(): void {
    if (this.setupStartMs !== null) return;
    this.setupStartMs = this.clock();
  }

  /**
   * Mark the moment the guest harness exec begins. This is where VM setup ends,
   * so it also closes the setup interval. Idempotent: the FIRST mark wins.
   */
  startHarnessExec(): void {
    if (this.harnessStartMs !== null) return;
    const now = this.clock();
    this.harnessStartMs = now;
    if (this.setupStartMs !== null) this.setupEndMs = now;
  }

  /**
   * Mark the moment the guest harness process settled (exit, rejection,
   * timeout or cancel). A round that never started the harness exec has
   * nothing to close and stays `undefined` (never fabricated). Idempotent.
   */
  endHarnessExec(): void {
    if (this.harnessEndMs !== null) return;
    if (this.harnessStartMs === null) return;
    this.harnessEndMs = this.clock();
  }

  /**
   * Whole-round wall time (ms) since the tracker was constructed — the same
   * value the runners already report as `durationMs`.
   */
  get roundMs(): number {
    return this.roundWatch.elapsedMs();
  }

  /**
   * VM setup interval (ms): create/boot start → harness exec start. Absent
   * until BOTH marks were made (an aborted pre-exec round never fabricates a
   * setup time).
   */
  get vmSetupMs(): number | undefined {
    if (this.setupStartMs === null || this.setupEndMs === null) return undefined;
    return Math.max(0, this.setupEndMs - this.setupStartMs);
  }

  /**
   * Harness exec → exit interval (ms). Absent until an exec started AND
   * settled; the value can never include VM setup by construction.
   */
  get harnessWallMs(): number | undefined {
    if (this.harnessStartMs === null || this.harnessEndMs === null) return undefined;
    return Math.max(0, this.harnessEndMs - this.harnessStartMs);
  }

  /**
   * The `HarnessRoundResult` timing fields for this round. The optional fields
   * are OMITTED (not set to `undefined`) when no harness exec started, so an
   * aborted/pre-create round carries no timing signal at all.
   */
  harnessFields(): MatchlockHarnessTimingFields {
    const fields: MatchlockHarnessTimingFields = {};
    const harnessWallMs = this.harnessWallMs;
    if (harnessWallMs !== undefined) fields.harnessWallMs = harnessWallMs;
    const vmSetupMs = this.vmSetupMs;
    if (vmSetupMs !== undefined) fields.vmSetupMs = vmSetupMs;
    return fields;
  }
}
