/**
 * G8 ADMISSION-INTEGRATION (US-003) — the interactive Hermes launch gate.
 *
 * `tamandua matchlock hermes` and `tamandua matchlock hermes-shell` admit a
 * disposable VM that mounts the caller's EFFECTIVE Hermes profile read-write.
 * Stock Hermes may open stores in the write-ahead-log format, which the
 * Matchlock guest cannot safely roll back on crash; the launch gate exists so
 * an unconverted store can never boot a VM. This module is the PRODUCTION
 * ADAPTER between the interactive plan (`planInteractiveSession`) and the one
 * wiring core (`launch-gate-wiring.ts`):
 *
 *   1. The scope's invocation kind is derived from the parsed command, so the
 *      receipt and the controller backstop can tell `interactive-hermes` from
 *      `interactive-hermes-shell` — they are different surfaces even though
 *      they evaluate the same profile.
 *   2. The profile home is the resolved selection's `hostEffectiveDir` (the
 *      directory the runtime will actually read) and the mount plan is the
 *      SAME identical-path RW plan the controller is handed
 *      (`interactiveStoreMountPlan`). The wiring never re-derives either.
 *   3. The view is bound to the artifacts admission actually pinned: before
 *      the gate runs, an ADMISSION ANCHOR record is written next to the
 *      invocation's receipt path naming the invocation kind, the pinned image
 *      digest/config digest admission returned and the profile the guest will
 *      read. The gate receipt schema is G9-owned and closed (it carries the
 *      invocation, the stores, the findings and the host revisions — not the
 *      admitted image), so the image identity is recorded in this anchored
 *      sidecar instead of being invented as a receipt field. A launch whose
 *      anchor cannot be recorded is refused operationally, because a verdict
 *      that cannot be bound to the artifacts it authorised is not evidence.
 *   4. The holder probe is the production probe
 *      (`store-holder-detect-runner.ts`) supplied ONLY here. The wiring core
 *      stays child_process-free, and holder detection remains informational:
 *      it never refuses a launch.
 *   5. A refusal throws the wiring's `LaunchGateRefusalError` UNCHANGED — with
 *      its G9 exit status — so the CLI surface maps it to the rendered remedy
 *      text and exits 78. A refusal is never re-wrapped into a success-shaped
 *      plan.
 *
 * SCOPE. Native pi runs are untouched: this adapter is called only for the
 * hermes harness, and `planInteractiveSession` never reaches it for pi. Raw
 * `matchlock run` with a Hermes payload is explicitly out of scope, and the
 * receipt's invocation kind is what records which surface was gated.
 *
 * ORDER. resolve profile+selection -> resolve mount plan -> build store set
 * (refuse when the inventory is incomplete) -> observe headers+sidecars+config
 * for every discoverable store -> evaluate aggregating ALL findings ->
 * revalidate membership+config by identity -> only then may the caller create
 * a VM. Zero create calls and no partial mount happen on a refusal.
 */

import fs from "node:fs";
import path from "node:path";

import { nowIso } from "../../lib/instant.js";
import { resolveStateDir } from "../../lib/tamandua-config.js";
import type { InteractiveSessionArgs } from "../../cli/matchlock-interactive-args.js";
import type { EffectiveJournalModeOptions } from "./doctor-gate.js";
import { interactiveStoreMountPlan } from "./doctor-gate.js";
import { exitCodeForGateOutcome } from "./gate-exit-code.js";
import {
  GATE_RECEIPT_UNREADABLE,
} from "./gate-receipt.js";
import { renderGateRemedyText } from "./gate-remedy-text.js";
import type { PinnedImageIdentity } from "./image.js";
import type { InteractiveHermesSelection } from "./interactive-hermes-selection.js";
import type { GateVerdict } from "./launch-gate.js";
import {
  evaluateAndRecordLaunchGate,
  LaunchGateRefusalError,
  resolveLaunchGateReceiptPath,
  type LaunchGateDecision,
  type LaunchGateHolderProbe,
  type LaunchGateInvocationKind,
  type LaunchGateRefusal,
  type LaunchGateWiringDeps,
} from "./launch-gate-wiring.js";
import type { HolderDetection } from "./store-holder-detect.js";
import { createDefaultHolderProbeDeps } from "./store-holder-detect-runner.js";

// ---------------------------------------------------------------------------
// invocation identity
// ---------------------------------------------------------------------------

/**
 * The invocation id binding one interactive plan to its verdict.
 *
 * `pid` + the plan's START instant + the subcommand: the same interactive
 * process re-running `hermes` later is a different invocation, and `hermes`
 * and `hermes-shell` are never the same invocation (the shell variant is its
 * own surface in the evidence). The instant is a stored UTC ISO-Z instant, so
 * it is comparable across processes; it is captured once, before any awaited
 * work, so a slow admission cannot make the id drift.
 */
export function interactiveLaunchGateInvocationId(input: {
  pid: number;
  startedAt: string;
  subcommand: string;
}): string {
  const pid = Number.isInteger(input?.pid) && input.pid > 0 ? input.pid : 0;
  const startedAt = typeof input?.startedAt === "string" ? input.startedAt : "";
  const subcommand = typeof input?.subcommand === "string" ? input.subcommand : "";
  return `interactive:${subcommand}:pid:${pid}:start:${startedAt}`;
}

// ---------------------------------------------------------------------------
// admission anchor (image identity, bound to the invocation)
// ---------------------------------------------------------------------------

/** Schema version of the admission anchor record. */
export const INTERACTIVE_ADMISSION_ANCHOR_SCHEMA_VERSION = 1 as const;

/** Identifies the sidecar so a reader never mistakes it for a gate receipt. */
export const INTERACTIVE_ADMISSION_ANCHOR_KIND = "matchlock-admission-anchor" as const;

/**
 * The admission anchor: what admission PINNED for this invocation.
 *
 * It is deliberate provenance, not a second gate: it carries no verdict, no
 * finding and no decision. A missing value stays {@link GATE_RECEIPT_UNREADABLE}
 * — never omitted and never fabricated — so a reader can tell "the digest was
 * not recorded" from "the digest was this".
 */
export interface InteractiveAdmissionAnchor {
  schemaVersion: typeof INTERACTIVE_ADMISSION_ANCHOR_SCHEMA_VERSION;
  recordKind: typeof INTERACTIVE_ADMISSION_ANCHOR_KIND;
  invocationId: string;
  kind: LaunchGateInvocationKind;
  subcommand: string;
  harness: "hermes";
  shell: boolean;
  image: {
    /** Bare reference the caller selected (never `:latest`-normalized here). */
    reference: string;
    /** Provenance of the reference: `explicit` or `standard`. */
    source: string;
    /** Content digest admission pinned; `unreadable` when not established. */
    digest: string;
    /** Config digest admission pinned; `unreadable` when not established. */
    configDigest: string;
    /** Tag admission pinned; `unreadable` when not established. */
    tag: string;
  };
  profile: {
    profile: string;
    /** Host directory mounted RW at its identical absolute guest path. */
    hostEffectiveDir: string;
    /** Approved guest `HERMES_HOME` the guest reads. */
    guestHermesHome: string;
  };
  /** The gate receipt path this anchor belongs to. */
  receiptPath: string;
  /** UTC ISO-Z instant the anchor was recorded. */
  recordedAt: string;
}

/** Outcome of one anchor write. A failure is typed, never thrown. */
export type AdmissionAnchorWriteResult =
  | { ok: true; path: string }
  | { ok: false; code: "anchor-write-failed"; path: string; detail: string };

/** Bound an error to one line so a write failure never dumps a stack. */
function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The anchor path for one invocation: the receipt path with `.json` replaced
 * by `.admission.json`, so the two evidence files can never be confused and a
 * reader holding one always knows where the other is.
 */
export function resolveInteractiveAdmissionAnchorPath(receiptPath: string): string {
  const resolved = typeof receiptPath === "string" ? receiptPath : "";
  if (resolved === "") return "";
  const directory = path.dirname(resolved);
  const base = path.basename(resolved);
  const stem = base.endsWith(".json") ? base.slice(0, -".json".length) : base;
  return path.join(directory, `${stem}.admission.json`);
}

/**
 * Write one anchor atomically (temp file + rename in the same directory, mode
 * 0600) so a reader never observes a half-written record. Deterministic JSON:
 * the key order is the declaration order above.
 */
export function writeInteractiveAdmissionAnchor(
  anchor: InteractiveAdmissionAnchor,
  options: { path: string },
): AdmissionAnchorWriteResult {
  const target = typeof options?.path === "string" ? options.path : "";
  if (target === "") {
    return {
      ok: false,
      code: "anchor-write-failed",
      path: "",
      detail: "no admission-anchor path was supplied",
    };
  }
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${JSON.stringify(anchor, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, target);
    return { ok: true, path: target };
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best effort: the typed failure below is the answer either way.
    }
    return {
      ok: false,
      code: "anchor-write-failed",
      path: target,
      detail: describeError(error),
    };
  }
}

// ---------------------------------------------------------------------------
// deps
// ---------------------------------------------------------------------------

/**
 * Everything the adapter needs. The wiring seams are forwarded unchanged (a
 * caller can pin `revalidate`, `observeStore`, the clock or the state dir); the
 * fields below are interactive-specific.
 */
export interface InteractiveLaunchGateDeps extends LaunchGateWiringDeps {
  /**
   * Binds the verdict to THIS invocation. Defaults to
   * `interactiveLaunchGateInvocationId(process.pid, <now>, subcommand)`; the
   * interactive plan always supplies the value it recorded.
   */
  invocationId?: string;
  /** Effective journal-mode observation options (managed scope, env). */
  configOptions?: EffectiveJournalModeOptions;
  /**
   * The pinned identity `admitMatchlockRun` returned for this invocation. It is
   * recorded in the admission anchor; absent means `unreadable`, never a
   * guessed digest.
   */
  admissionIdentity?: PinnedImageIdentity | null;
  /** Anchor writer seam (tests). Defaults to the atomic writer above. */
  writeAdmissionAnchor?: (
    anchor: InteractiveAdmissionAnchor,
    options: { path: string },
  ) => AdmissionAnchorWriteResult;
  /** Anchor path seam (tests). Defaults to the receipt path sibling. */
  admissionAnchorPath?: string;
}

/** The evaluation seam `planInteractiveSession` drives (tests inject a fake). */
export type EvaluateInteractiveLaunchGate = (
  selection: InteractiveHermesSelection,
  args: InteractiveSessionArgs,
  deps?: InteractiveLaunchGateDeps,
) => LaunchGateDecision;

// ---------------------------------------------------------------------------
// production holder probe (the only spawn-capable seam in this path)
// ---------------------------------------------------------------------------

/**
 * The production informational holder probe.
 *
 * It lives here — never in the wiring core — because the runner enumerates
 * processes (procfs / bounded `lsof`) and therefore owns the child_process
 * classification. A probe failure is caught by the wiring and recorded; it is
 * never a refusal.
 */
const productionHolderProbe: LaunchGateHolderProbe = (storePaths) =>
  createDefaultHolderProbeDeps().listOpenFileHolders(storePaths);

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

/** Map the parsed subcommand onto the receipt's invocation kind. */
export function interactiveLaunchGateKind(
  args: Pick<InteractiveSessionArgs, "harness" | "shell">,
): LaunchGateInvocationKind {
  return args.harness === "hermes" && args.shell === true
    ? "interactive-hermes-shell"
    : "interactive-hermes";
}

/** Build the admission anchor for one decision scope. */
function buildAdmissionAnchor(input: {
  selection: InteractiveHermesSelection;
  args: InteractiveSessionArgs;
  kind: LaunchGateInvocationKind;
  invocationId: string;
  receiptPath: string;
  identity: PinnedImageIdentity | null | undefined;
  recordedAt: string;
}): InteractiveAdmissionAnchor {
  const identity = input.identity ?? null;
  return {
    schemaVersion: INTERACTIVE_ADMISSION_ANCHOR_SCHEMA_VERSION,
    recordKind: INTERACTIVE_ADMISSION_ANCHOR_KIND,
    invocationId: input.invocationId,
    kind: input.kind,
    subcommand: input.args.subcommand,
    harness: "hermes",
    shell: input.args.shell === true,
    image: {
      reference: typeof input.args.image === "string" ? input.args.image : GATE_RECEIPT_UNREADABLE,
      source:
        typeof input.args.imageSource === "string"
          ? input.args.imageSource
          : GATE_RECEIPT_UNREADABLE,
      digest:
        typeof identity?.digest === "string" && identity.digest !== ""
          ? identity.digest
          : GATE_RECEIPT_UNREADABLE,
      configDigest:
        typeof identity?.config_digest === "string" && identity.config_digest !== ""
          ? identity.config_digest
          : GATE_RECEIPT_UNREADABLE,
      tag:
        typeof identity?.tag === "string" && identity.tag !== ""
          ? identity.tag
          : GATE_RECEIPT_UNREADABLE,
    },
    profile: {
      profile:
        typeof input.selection?.profile === "string" && input.selection.profile !== ""
          ? input.selection.profile
          : GATE_RECEIPT_UNREADABLE,
      hostEffectiveDir:
        typeof input.selection?.hostEffectiveDir === "string" &&
        input.selection.hostEffectiveDir !== ""
          ? input.selection.hostEffectiveDir
          : GATE_RECEIPT_UNREADABLE,
      guestHermesHome:
        typeof input.selection?.guestHermesHome === "string" &&
        input.selection.guestHermesHome !== ""
          ? input.selection.guestHermesHome
          : GATE_RECEIPT_UNREADABLE,
    },
    receiptPath: input.receiptPath,
    recordedAt: input.recordedAt,
  };
}

/**
 * Evaluate the launch gate for ONE interactive Hermes invocation.
 *
 * Returns the bound allow decision, or throws `LaunchGateRefusalError` (the
 * wiring's own object, unchanged) carrying the G9 exit status. The anchor is
 * recorded FIRST so even a refusal names the image the refused launch would
 * have booted.
 */
export const evaluateInteractiveLaunchGate: EvaluateInteractiveLaunchGate = (
  selection,
  args,
  deps = {},
) => {
  const now = deps.now ?? nowIso;
  const kind = interactiveLaunchGateKind(args);
  // The plan always passes a resolved selection; a caller that does not still
  // gets a RECORDED refusal (never a TypeError escaping the gate's exit-code
  // mapping). An empty home is refused operationally by the wiring because it
  // is not absolute.
  const profileHome =
    typeof selection?.hostEffectiveDir === "string" ? selection.hostEffectiveDir : "";
  const invocationId =
    typeof deps.invocationId === "string" && deps.invocationId !== ""
      ? deps.invocationId
      : interactiveLaunchGateInvocationId({
          pid: process.pid,
          startedAt: now(),
          subcommand: args.subcommand,
        });
  const receiptPath = resolveLaunchGateReceiptPath({
    stateDir: typeof deps.stateDir === "string" && deps.stateDir !== ""
      ? deps.stateDir
      : resolveStateDir(),
    invocationId,
  });

  // 1. Anchor the admitted artifacts to THIS invocation. A launch whose
  //    evidence cannot be bound to what admission pinned is refused: the gate
  //    verdict must never authorise an unidentified image.
  const anchorPath =
    typeof deps.admissionAnchorPath === "string" && deps.admissionAnchorPath !== ""
      ? deps.admissionAnchorPath
      : resolveInteractiveAdmissionAnchorPath(receiptPath);
  const anchor = buildAdmissionAnchor({
    selection,
    args,
    kind,
    invocationId,
    receiptPath,
    identity: deps.admissionIdentity ?? null,
    recordedAt: now(),
  });
  const anchored = (deps.writeAdmissionAnchor ?? writeInteractiveAdmissionAnchor)(anchor, {
    path: anchorPath,
  });
  if (anchored.ok !== true) {
    const detail =
      `the interactive launch was refused because the admission evidence could not be ` +
      `recorded at ${anchorPath}: ${anchored.detail}`;
    throw new LaunchGateRefusalError({
      kind: "operational",
      detail,
      receiptPath,
      receiptWritten: false,
      exitCode: exitCodeForGateOutcome({ action: "operational-refusal", detail }),
      verdict: null,
      findings: [],
    });
  }

  // 2. The ONE wiring core: final mount plan, store set, aggregate observation,
  //    evaluation, identity/config revalidation, receipt-first refusal.
  const decision = evaluateAndRecordLaunchGate(
    {
      kind,
      invocationId,
      profileHome,
      mountPlan: interactiveStoreMountPlan(profileHome),
      ...(deps.configOptions !== undefined ? { configOptions: deps.configOptions } : {}),
    },
    {
      ...deps,
      // The profile identity is KNOWN here (the plan resolved it), so the
      // receipt names it instead of the wiring's `unreadable` default. The
      // guest reads the identical-path mount, so that same directory is the
      // guest-visible config directory for an interactive session.
      selection: () => ({
        profile:
          typeof selection?.profile === "string" && selection.profile !== ""
            ? selection.profile
            : GATE_RECEIPT_UNREADABLE,
        profileHome,
        guestConfigDir: profileHome === "" ? null : profileHome,
      }),
      // The production probe is supplied HERE and nowhere else; a test seam
      // still wins so the suite never enumerates real processes.
      holderProbe: typeof deps.holderProbe === "function" ? deps.holderProbe : productionHolderProbe,
    },
  );

  // 3. A refusal is the wiring's own refusal, never re-wrapped.
  if (decision.action !== "allow") throw new LaunchGateRefusalError(decision.refusal);
  return decision;
};

// ---------------------------------------------------------------------------
// operator-facing refusal text
// ---------------------------------------------------------------------------

/** Inputs the CLI surface may pin when rendering a refusal. */
export interface RenderInteractiveRefusalOptions {
  /**
   * The copyable relaunch spelling, e.g. `tamandua matchlock hermes`. It is
   * built from the parsed SUBCOMMAND — never from raw argv, which can carry
   * credentials.
   */
  relaunchCommand?: string;
  /** Path of the configuration the GUEST reads, when the surface knows it. */
  guestConfigPath?: string | null;
}

/** Why the refusal text carries no holder listing. */
const REFUSAL_HOLDER_EVIDENCE_NOTE =
  "holder evidence is recorded in the gate receipt and is not carried on the refusal";

/**
 * The guest-visible config directory for one refusal, read from the admission
 * anchor written next to the receipt.
 *
 * The interactive mount is identical-path, so the anchor's
 * `profile.hostEffectiveDir` IS the directory the guest's Hermes reads — which
 * is exactly what a `not-delete-config` remedy must name (editing the host's
 * copy instead is the mistake that remedy exists to prevent). Absent or
 * unreadable evidence yields null; this never guesses a path.
 */
function guestConfigPathFromAnchor(refusal: LaunchGateRefusal): string | null {
  const receiptPath =
    typeof refusal?.receiptPath === "string" ? refusal.receiptPath : "";
  if (receiptPath === "") return null;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(resolveInteractiveAdmissionAnchorPath(receiptPath), "utf8"),
    ) as { profile?: { hostEffectiveDir?: unknown } };
    const directory = parsed?.profile?.hostEffectiveDir;
    return typeof directory === "string" && directory !== "" ? directory : null;
  } catch {
    return null;
  }
}

/**
 * Render the operator-facing text for one interactive launch-gate refusal:
 * G9's remedy text for the findings, then the refusal detail and the receipt
 * path. Pure and deterministic for a given refusal.
 */
export function renderInteractiveLaunchGateRefusal(
  refusal: LaunchGateRefusal,
  options: RenderInteractiveRefusalOptions = {},
): string {
  const verdict: GateVerdict =
    refusal?.verdict ?? { action: "refuse", findings: [] };
  // Holder detection is informational and the refusal does not carry it; say
  // that plainly instead of rendering an empty probe as "no failures".
  const holderDetection: HolderDetection = {
    observationComplete: false,
    holders: [],
    probeFailures: [{ scope: "holder-probe", reason: REFUSAL_HOLDER_EVIDENCE_NOTE }],
  };

  const remedyText = renderGateRemedyText({
    verdict,
    holderDetection,
    stores: [],
    relaunchCommand:
      typeof options.relaunchCommand === "string" && options.relaunchCommand !== ""
        ? options.relaunchCommand
        : "tamandua matchlock hermes",
    guestConfigPath:
      options.guestConfigPath ?? guestConfigPathFromAnchor(refusal),
  });

  const receiptState = refusal?.receiptWritten === true ? "" : " (NOT WRITTEN)";
  const detail =
    typeof refusal?.detail === "string" && refusal.detail !== ""
      ? refusal.detail
      : "no refusal detail was recorded";
  const receiptPath =
    typeof refusal?.receiptPath === "string" && refusal.receiptPath !== ""
      ? refusal.receiptPath
      : GATE_RECEIPT_UNREADABLE;

  return [
    remedyText,
    "",
    `REFUSAL: ${detail}`,
    `RECEIPT: ${receiptPath}${receiptState}`,
  ].join("\n");
}
