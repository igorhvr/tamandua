/**
 * Matchlock host-side launch-gate evaluator (pure observation consumer).
 *
 * G4 LAUNCH-GATE-EVALUATOR (bead tamandua-7p5.1.4). This module answers one
 * question: given observations gathered elsewhere, may this launch proceed?
 * It consumes data only. It performs no filesystem access, starts no process,
 * reads no clock, uses no randomness and reads no environment: the entire
 * verdict is a deterministic function of its one argument. Reading files,
 * inspecting sidecars and resolving paths belong to the observer modules
 * (`store-set.ts`, `store-header.ts`); this module never imports them.
 *
 * The evaluator defines the observation shape it needs instead of importing
 * `StoreObservation` from the I/O layer, so its type surface cannot pull a
 * non-pure module into its dependency graph. In particular the `SidecarState`
 * union is duplicated locally on purpose.
 *
 * PRESENCE IS THE AXIS. A store path is one of three things:
 *
 *  - `present`           the store was observed. Every required observation
 *                        (config, header, sidecars) must then be present and
 *                        positively prove compliance; a missing, unreadable or
 *                        unrecognised observation is a REFUSAL, never a pass.
 *  - `confirmed-absent`  a definitive ENOENT proved the path does not exist.
 *                        A required store is then `store-missing`; an optional
 *                        or inactive store is expected to be absent and gets
 *                        no finding for itself. A confirmed absence has no
 *                        inode, so its `identity` is `null` and its `header`
 *                        and `config` are correctly `null` too.
 *  - `unresolved`        existence could not be determined (EACCES/EPERM,
 *                        I/O error, unlistable parent). This is ignorance, not
 *                        absence: it is always `path-unresolved`.
 *
 * POLICY IS COMPILE-TIME, NOT A PARAMETER. The three policy constants below
 * are internal `const`s. `evaluateGate` takes exactly one argument; there is no
 * options object, no configuration override and no environment read.
 *
 * WORDING RULE: the version pair (1, 1) means "rollback-format". It covers
 * every rollback-journal flavour (including TRUNCATE and PERSIST), so no
 * comment, detail string, remedy or test may describe it as proof of a
 * particular journal sub-mode. The pair (2, 2) is a write-ahead-log ("wal")
 * header. Any other pair is unrecognised and is reported as
 * `header-unreadable` with the actual pair named, never relabelled "wal".
 *
 * INVENTORY AND FRESH PROFILES. An enumeration that did not complete is
 * reported once as a set-scoped `inventory-incomplete`; it is never treated as
 * an empty set. A complete enumeration that provably found nothing is a fresh
 * profile and is refused with one set-scoped `store-missing`. The set-scoped
 * findings come first, then per-store findings.
 *
 * AGGREGATION. Every store is evaluated. A failure in one store never hides a
 * finding for another. Findings follow input store order; within one store the
 * codes follow {@link REASON_CODE_ORDER}. `action` is `allow` exactly when the
 * findings array is empty.
 *
 * Out of scope by design: holder detection, coordination between concurrent
 * writers, and retry/settle logic for transient journals. A live holder is
 * informational and is never a reason to refuse.
 */

/** Byte length of a complete SQLite database header. */
const DATABASE_HEADER_SIZE = 100;

/** Compile-time policy: the runtime must request the `delete` journal mode. */
const REQUIRE_CONFIG_DELETE = true;

/** Compile-time policy: the header must be rollback-format. */
const REQUIRE_ROLLBACK_HEADER = true;

/** Compile-time policy: a fresh profile is never allowed implicitly. */
const ALLOW_FRESH_STORE = false;

/**
 * Every reason the gate may refuse a launch. The list is closed: operational
 * failures (receipt write, revalidation) are a separate class and are never
 * renumbered into these ten codes.
 */
export type ReasonCode =
  | "not-delete-config"
  | "wal-header"
  | "header-unreadable"
  | "header-not-sqlite"
  | "header-truncated"
  | "sidecar-unresolved"
  | "store-missing"
  | "inventory-incomplete"
  | "path-unresolved"
  | "permission-denied";

/**
 * Canonical ordering. Per-store findings are emitted as a subsequence of this
 * array, so identical input always yields an identical verdict.
 */
export const REASON_CODE_ORDER = [
  "not-delete-config",
  "wal-header",
  "header-unreadable",
  "header-not-sqlite",
  "header-truncated",
  "sidecar-unresolved",
  "store-missing",
  "inventory-incomplete",
  "path-unresolved",
  "permission-denied",
] as const satisfies readonly ReasonCode[];

/** One actionable step in a remedy. A command is optional. */
export interface RemedyStep {
  description: string;
  command?: string;
}

/** One refusal reason, optionally scoped to a store. */
export interface Finding {
  code: ReasonCode;
  /** The caller's spelling of the affected store; omitted for set-scoped findings. */
  store?: string | null;
  detail: string;
  remedy: RemedyStep[];
}

/** The verdict: allow exactly when no findings were produced. */
export interface GateVerdict {
  action: "allow" | "refuse";
  findings: Finding[];
}

/** Classification of one sidecar path. `unreadable` is never `absent`. */
export type SidecarState =
  | "absent"
  | "presentEmpty"
  | "presentNonEmpty"
  | "unreadable";

/** Filesystem identity of a store. Valid only when the store is present. */
export interface StoreIdentityObservation {
  canonicalPath: string;
  dev: string;
  ino: string;
  fstype: string | null;
}

/** The effective journal-mode setting the runtime reads for this profile. */
export interface StoreConfigObservation {
  journalMode: "delete" | "wal" | "other" | "unreadable";
  source: string;
  observed: boolean;
}

/** Byte-level header observation for one store. */
export interface StoreHeaderObservation {
  headerFormat: "rollback" | "wal" | "unknown";
  rawBytes1819: [number, number] | null;
  magicOk: boolean;
  readable: boolean;
  fileSize: number | null;
}

/** The three sidecars a store may carry, observed independently. */
export interface StoreSidecars {
  wal: SidecarState;
  shm: SidecarState;
  journal: SidecarState;
}

/** One store as observed for the gate. Pure data, safe to deep-compare. */
export interface EvaluatedStore {
  /** The caller's spelling, always retained verbatim. */
  requestedPath: string;
  /** Three-state presence. Never collapse this to a boolean. */
  presence: "present" | "confirmed-absent" | "unresolved";
  /**
   * Non-null only when `presence === "present"`. A confirmed-absent path has
   * no inode, so no canonical identity may be synthesized for it.
   */
  identity: StoreIdentityObservation | null;
  /** Classification from the store-set contract. */
  required: boolean;
  /** Per-profile effective setting, repeated per store for convenience. */
  config: StoreConfigObservation | null;
  header: StoreHeaderObservation | null;
  sidecars: StoreSidecars | null;
  /** Advisory only. Never the sole basis for a decision. */
  findingCodesFromReader: string[];
}

/** The complete gate input. */
export interface GateInput {
  inventoryComplete: boolean;
  incompleteReasons: string[];
  stores: EvaluatedStore[];
}

/** Rank of a code in {@link REASON_CODE_ORDER}; used for deterministic order. */
function reasonRank(code: ReasonCode): number {
  return REASON_CODE_ORDER.indexOf(code);
}

/** The path a command may name: canonical when known, caller spelling otherwise. */
function commandPath(store: EvaluatedStore): string {
  return store.identity === null ? store.requestedPath : store.identity.canonicalPath;
}

/**
 * Quote one pathname as a single shell word.
 *
 * The remedy command is copy-paste advice, so it is the pasting shell that
 * decides where the argument ends. Single-quote wrapping keeps every byte
 * literal and an embedded `'` is emitted as `'\''` (close quote, escaped
 * quote, reopen quote). Double quotes would leave `$`, a backtick and `\\`
 * live. The pathname is quoted verbatim, never sanitized first: sanitizing
 * collapses whitespace and would point the command at the wrong file.
 */
function shellQuoted(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Build a store-scoped finding. */
function storeFinding(
  store: EvaluatedStore,
  code: ReasonCode,
  detail: string,
  remedy: RemedyStep[],
): Finding {
  return { code, store: store.requestedPath, detail, remedy };
}

/**
 * Build a set-scoped finding. `Finding.store` is optional, so a finding about
 * the whole store set (an incomplete inventory or a fresh profile) omits it
 * instead of inventing a placeholder path.
 */
function setScopedFinding(
  code: ReasonCode,
  detail: string,
  remedy: RemedyStep[],
): Finding {
  return { code, detail, remedy };
}

/** Build one remedy step; the command is omitted when the task names none. */
function step(description: string, command?: string): RemedyStep {
  return command === undefined ? { description } : { description, command };
}

/** A remedy step for a sidecar whose state could not be determined. */
function unreadableSidecarStep(name: string): RemedyStep {
  return step(
    `The -${name} sidecar could not be read; fix permissions or I/O errors, then re-observe it before relaunching.`,
  );
}

/**
 * Sidecar-specific remedies derived from the observed sidecar states.
 *
 * The three sidecar kinds are not interchangeable:
 *  - a nonempty `-wal` may be check-pointed after the writers are quiesced;
 *  - a nonempty `-journal` is a ROLLBACK journal, for which a checkpoint is
 *    not the treatment; the refusal may be transient, so the operator is
 *    directed to quiescence;
 *  - a nonempty or unreadable `-shm` is reported and never diagnosed.
 * An unreadable sidecar of any kind means fix permissions or I/O and
 * re-observe.
 */
function sidecarRemedies(store: EvaluatedStore): RemedyStep[] {
  const sidecars = store.sidecars;
  if (sidecars === null) {
    return [
      step(
        "Re-observe the store's sidecars; the absence of orphaned -wal, -shm and -journal sidecars is not proven. Fix permissions or I/O errors before relaunching.",
      ),
    ];
  }

  const steps: RemedyStep[] = [];

  if (sidecars.wal === "unreadable") {
    steps.push(unreadableSidecarStep("wal"));
  }
  if (sidecars.journal === "unreadable") {
    steps.push(unreadableSidecarStep("journal"));
  }

  if (sidecars.wal === "presentNonEmpty") {
    steps.push(
      step(
        "The -wal sidecar is nonempty; quiesce all writers, then checkpoint the write-ahead-log once it is safe so the sidecar can be removed before relaunching.",
      ),
    );
  }

  if (sidecars.journal === "presentNonEmpty") {
    steps.push(
      step(
        "The -journal sidecar is nonempty: this is a rollback journal, not a write-ahead-log. The refusal may be transient, so direct the operator to quiescence (all writers stopped) and re-observe the store before relaunching.",
      ),
    );
  }

  if (sidecars.shm === "unreadable" || sidecars.shm === "presentNonEmpty") {
    const withoutWal =
      sidecars.wal === "presentNonEmpty"
        ? ""
        : " It is present without a nonempty -wal sidecar.";
    const fix =
      sidecars.shm === "unreadable"
        ? " Fix permissions or I/O errors, then re-observe it before relaunching."
        : "";
    steps.push(
      step(
        `The -shm sidecar is ${sidecars.shm}; it is reported as observed and not diagnosed.${withoutWal}${fix}`,
      ),
    );
  }

  if (steps.length === 0) {
    // Defensive: a sidecar-unresolved finding always carries a missing or bad
    // state, but a remedy array must never be empty.
    steps.push(
      step(
        "Re-observe the store's sidecars and resolve any unreadable state before relaunching.",
      ),
    );
  }

  return steps;
}

/**
 * Complete, per-code remedies for one store-scoped finding. Command paths use
 * the canonical identity when it is known; a confirmed-absent path has no
 * identity, so commands (when the code names one) use the caller's spelling.
 */
function remediesFor(store: EvaluatedStore, code: ReasonCode): RemedyStep[] {
  const path = commandPath(store);
  switch (code) {
    case "not-delete-config":
      return [
        step(
          "Set `database.journal_mode: delete` where the guest reads it, not in the host's configuration, then relaunch.",
          `hermes sessions set-journal-mode delete --db ${shellQuoted(path)}`,
        ),
        step(
          "Relaunch the session after the guest-visible configuration requests the delete journal mode.",
        ),
      ];
    case "wal-header":
      return [
        step(
          "Quiesce writers, then identify the holder by PID and a sanitized command description (never raw argv).",
        ),
        step(
          "Convert the store to rollback-format with the delete journal mode.",
          `hermes sessions set-journal-mode delete --db ${shellQuoted(path)}`,
        ),
        step(
          "Relaunch the session after the store is rollback-format with the delete journal mode.",
        ),
        step(
          "For a quiescent native store, the reverse conversion restores the wal journal mode.",
          `hermes sessions set-journal-mode wal --db ${shellQuoted(path)}`,
        ),
      ];
    case "header-unreadable": {
      const pair = store.header === null ? null : store.header.rawBytes1819;
      return [
        step(
          "Quiesce writers and identify the holder by PID and a sanitized command description (never raw argv), then re-observe the store header before relaunching." +
            (pair === null
              ? ""
              : ` The observed version pair is ${pairText(pair)}; it is not rollback-format.`),
        ),
        step(
          "Re-observe the header after the writers are quiescent, then relaunch the session.",
        ),
        step(
          "If the header stays unreadable, restore the store from a known-good copy before relaunching.",
        ),
      ];
    }
    case "header-not-sqlite":
      return [
        step(
          "Move the non-SQLite file aside so it cannot be opened as a store.",
        ),
        step(
          "Then initialise natively first, and relaunch the session once the store exists.",
        ),
      ];
    case "header-truncated": {
      const size = store.header === null ? null : store.header.fileSize;
      return [
        step(
          `At least ${DATABASE_HEADER_SIZE} header bytes are required; the observed header is ${
            size === null ? "shorter than that" : `${size} bytes`
          }.`,
        ),
        step(
          "Restore the store from backup or initialise natively first, then relaunch the session.",
        ),
      ];
    }
    case "sidecar-unresolved":
      return sidecarRemedies(store);
    case "store-missing":
      return [
        step(
          "This required store is absent; initialise natively first, then relaunch the session.",
        ),
        step("Relaunch the session after the store exists natively."),
      ];
    case "inventory-incomplete":
      return inventoryRemedy([]);
    case "path-unresolved":
      return [
        step(
          "Resolve the path or permission error so the store path can be determined, then re-run the gate; cannot-determine is not absence.",
        ),
      ];
    case "permission-denied":
      return [
        step(
          "Grant read access to the store path or use a readable location, then re-run the gate; a permission failure is never absence.",
        ),
      ];
    default:
      // Exhaustiveness guard: an unknown code cannot silently pass.
      return [
        step(
          "Re-observe the store and resolve the reported condition before relaunching.",
        ),
      ];
  }
}

/** Build a store-scoped finding with the code's complete remedy. */
function findingFor(store: EvaluatedStore, code: ReasonCode, detail: string): Finding {
  return storeFinding(store, code, detail, remediesFor(store, code));
}

/** Describe one header version pair without interpreting it as a journal mode. */
function pairText(pair: [number, number]): string {
  return `(${pair[0]},${pair[1]})`;
}

/** True when a sidecar state is neither absent nor acceptably empty. */
function isUnresolvedSidecarState(state: SidecarState): boolean {
  return state === "presentNonEmpty" || state === "unreadable";
}

/** List the bad sidecar names/states for a detail string. */
function badSidecars(sidecars: StoreSidecars): string[] {
  const bad: string[] = [];
  if (isUnresolvedSidecarState(sidecars.wal)) {
    bad.push(`-wal=${sidecars.wal}`);
  }
  if (isUnresolvedSidecarState(sidecars.shm)) {
    bad.push(`-shm=${sidecars.shm}`);
  }
  if (isUnresolvedSidecarState(sidecars.journal)) {
    bad.push(`-journal=${sidecars.journal}`);
  }
  return bad;
}

/** True when this store's sidecars are missing or carry a bad state. */
function hasUnresolvedSidecars(sidecars: StoreSidecars | null): boolean {
  // A null observation proves nothing. It is never evidence that sidecars are
  // absent, so it also cannot support a fresh-profile conclusion.
  if (sidecars === null) return true;
  return badSidecars(sidecars).length > 0;
}

/** True when the inventory itself is incomplete. */
function inventoryIsIncomplete(input: GateInput): boolean {
  return input.inventoryComplete !== true || input.incompleteReasons.length > 0;
}

/**
 * A fresh profile is a COMPLETE enumeration that provably found nothing:
 * every listed store is optional and confirmed absent, every sidecar was
 * observed and none is non-empty or unreadable, and no required store is
 * listed. An incomplete inventory is never fresh, and a store whose existence
 * is unresolved is ignorance rather than absence.
 */
function isFreshProfile(input: GateInput): boolean {
  if (inventoryIsIncomplete(input)) return false;
  for (const store of input.stores) {
    if (store.presence !== "confirmed-absent") return false;
    if (store.required) return false;
    if (hasUnresolvedSidecars(store.sidecars)) return false;
  }
  return true;
}

/** Set-scoped remedy for an incomplete inventory. */
function inventoryRemedy(reasons: string[]): RemedyStep[] {
  return [
    step(
      "Fix store enumeration and re-run the gate. An incomplete inventory means the store set is unknown and is never evidence that no stores exist.",
    ),
    ...(reasons.length === 0
      ? []
      : [step(`Enumeration reported: ${reasons.join("; ")}.`)]),
  ];
}

/** Set-scoped remedy for a profile that is provably bare. */
function freshProfileRemedy(): RemedyStep[] {
  return [
    step(
      "A fresh profile must initialise natively first before any launch; create the profile with native tooling.",
    ),
    step("Relaunch the session after the profile exists natively."),
  ];
}

/**
 * Evaluate one PRESENT store. Every required observation must be present and
 * must positively prove compliance. The returned array is already ordered by
 * {@link REASON_CODE_ORDER}.
 */
function evaluatePresentStore(store: EvaluatedStore): Finding[] {
  const findings: Finding[] = [];

  // --- config -------------------------------------------------------------
  // The effective config the runtime reads must request `delete`. A null or
  // unobserved config is absence of evidence, which is never compliance.
  const config = store.config;
  const configCompliant =
    REQUIRE_CONFIG_DELETE &&
    config !== null &&
    config.observed === true &&
    config.journalMode === "delete";
  if (!configCompliant) {
    let detail: string;
    if (config === null) {
      detail =
        "No effective journal-mode configuration was observed; the runtime must request the delete journal mode.";
    } else if (config.observed !== true) {
      detail =
        `The effective journal-mode configuration (source ${config.source}) was not observed; ` +
        "the runtime must request the delete journal mode.";
    } else {
      detail =
        `The effective journal-mode configuration (source ${config.source}) requests ` +
        `"${config.journalMode}"; the runtime must request the delete journal mode.`;
    }
    findings.push(findingFor(store, "not-delete-config", detail));
  }

  // --- header -------------------------------------------------------------
  // A present store must have a readable, complete, SQLite, rollback-format
  // header. Truncation is checked before the version pair: a torn header has
  // no trustworthy pair, so it must not also be reported by its unknown pair.
  const header = store.header;
  if (header === null || header.readable !== true) {
    findings.push(
      findingFor(
        store,
        "header-unreadable",
        header === null
          ? "No store header was observed; a readable rollback-format header is required."
          : "The store header could not be read; a readable rollback-format header is required.",
      ),
    );
  } else if (header.fileSize === null) {
    findings.push(
      findingFor(
        store,
        "header-unreadable",
        "The store header size could not be observed; a complete 100-byte header is required.",
      ),
    );
  } else if (header.fileSize < DATABASE_HEADER_SIZE) {
    findings.push(
      findingFor(
        store,
        "header-truncated",
        `The store header is ${header.fileSize} bytes; a complete ${DATABASE_HEADER_SIZE}-byte header is required.`,
      ),
    );
  } else if (!header.magicOk) {
    findings.push(
      findingFor(
        store,
        "header-not-sqlite",
        "The store header does not carry the SQLite file signature.",
      ),
    );
  } else {
    const pair = header.rawBytes1819;
    if (pair !== null) {
      // The raw version pair is authoritative when present.
      if (pair[0] === 1 && pair[1] === 1) {
        // rollback-format; compliant.
      } else if (pair[0] === 2 && pair[1] === 2) {
        findings.push(
          findingFor(
            store,
            "wal-header",
            `The store header carries the write-ahead-log version pair ${pairText(pair)}; rollback-format is required.`,
          ),
        );
      } else {
        findings.push(
          findingFor(
            store,
            "header-unreadable",
            `The store header carries the unrecognised version pair ${pairText(pair)}; rollback-format is required.`,
          ),
        );
      }
    } else if (REQUIRE_ROLLBACK_HEADER && header.headerFormat === "wal") {
      findings.push(
        findingFor(
          store,
          "wal-header",
          "The store header is classified as write-ahead-log; rollback-format is required.",
        ),
      );
    } else {
      // `unknown` and `rollback` without raw bytes: the pair could not be
      // observed, so rollback-format is not proven. Never call this wal.
      findings.push(
        findingFor(
          store,
          "header-unreadable",
          `The store header version pair could not be observed (header format "${header.headerFormat}"); rollback-format is required.`,
        ),
      );
    }
  }

  // --- sidecars -----------------------------------------------------------
  // Sidecars must have been observed, and none may be non-empty or
  // unreadable. `presentEmpty` and `absent` are acceptable for a present
  // store; a missing sidecar observation is not.
  if (store.sidecars === null) {
    findings.push(
      findingFor(
        store,
        "sidecar-unresolved",
        "No sidecar observation was available; absence of unresolved sidecars is not proven.",
      ),
    );
  } else {
    const bad = badSidecars(store.sidecars);
    if (bad.length > 0) {
      findings.push(
        findingFor(
          store,
          "sidecar-unresolved",
          `Unresolved sidecar state: ${bad.join(", ")}.`,
        ),
      );
    }
  }

  return findings.sort((a, b) => reasonRank(a.code) - reasonRank(b.code));
}

/**
 * Evaluate one non-present store.
 *
 * A required confirmed absence is `store-missing`; no canonical identity is
 * synthesized because a path with no file has no inode. Its sidecars are still
 * inspected when observed: the main database being gone does not prove `-wal`,
 * `-shm` or `-journal` are gone, so an orphaned non-empty or unreadable sidecar
 * is also `sidecar-unresolved`. A null sidecar observation adds only
 * `store-missing`.
 *
 * An optional or inactive confirmed absence gets no finding for the store
 * itself, because a path with no file has no header or config to demand. Its
 * sidecars are still inspected for orphans.
 *
 * An unresolved path is always `path-unresolved` and never `store-missing`.
 * Because a reader permission failure is one form of cannot-determine, a
 * reader code `permission-denied` adds a `permission-denied` finding stating
 * that a permission failure is never absence.
 */
function evaluateNonPresentStore(store: EvaluatedStore): Finding[] {
  if (store.presence === "confirmed-absent") {
    if (store.required) {
      // A required absence is missing whether or not sidecars were observed.
      // `Finding.store` is the caller's spelling: an absent path has no inode,
      // so no canonical identity exists and none may be synthesized or
      // reported. A null sidecar observation adds nothing beyond this finding.
      const findings: Finding[] = [
        findingFor(
          store,
          "store-missing",
          "The store is required but definitively absent (ENOENT); an absent path has no identity and no canonical path is synthesized.",
        ),
      ];
      if (store.sidecars !== null) {
        const bad = badSidecars(store.sidecars);
        if (bad.length > 0) {
          findings.push(
            findingFor(
              store,
              "sidecar-unresolved",
              `The store is required but definitively absent, yet unresolved sidecars remain: ${bad.join(", ")}.`,
            ),
          );
        }
      }
      return findings.sort((a, b) => reasonRank(a.code) - reasonRank(b.code));
    }
    return evaluateAbsentOptionalStoreSidecars(store);
  }

  // presence === "unresolved": cannot-determine is not absence. This is the
  // only uncertainty state, so it always yields `path-unresolved` and never
  // `store-missing`. A reader-reported permission failure is a refinement of
  // that same state, never the sole basis for a separate refusal.
  const findings: Finding[] = [
    findingFor(
      store,
      "path-unresolved",
      "The store path could not be resolved; cannot-determine is not absence.",
    ),
  ];
  if (store.findingCodesFromReader.includes("permission-denied")) {
    findings.push(
      findingFor(
        store,
        "permission-denied",
        "Resolving the store path failed with a permission error; a permission failure is never absence.",
      ),
    );
  }
  return findings.sort((a, b) => reasonRank(a.code) - reasonRank(b.code));
}

/**
 * Inspect the sidecars of an optional confirmed-absent store. The store itself
 * is correctly absent, but orphaned sidecars may remain behind.
 */
function evaluateAbsentOptionalStoreSidecars(store: EvaluatedStore): Finding[] {
  if (store.sidecars === null) {
    return [
      findingFor(
        store,
        "sidecar-unresolved",
        "The store is confirmed absent but no sidecar observation was available; absence of orphaned -wal, -shm and -journal sidecars is not proven.",
      ),
    ];
  }
  const bad = badSidecars(store.sidecars);
  if (bad.length === 0) {
    return [];
  }
  return [
    findingFor(
      store,
      "sidecar-unresolved",
      `The store is confirmed absent but orphaned unresolved sidecars remain: ${bad.join(", ")}.`,
    ),
  ];
}

/**
 * Evaluate the launch gate.
 *
 * Pure: the verdict depends only on `input`. All stores are evaluated, even
 * after a failure. Findings follow input store order, and per-store codes
 * follow {@link REASON_CODE_ORDER}. `action` is `"allow"` exactly when no
 * findings were produced.
 */
export function evaluateGate(input: GateInput): GateVerdict {
  const findings: Finding[] = [];

  // Inventory precheck. An enumeration that did not complete is ignorance,
  // not an empty set: it must never be reported as a fresh profile. Per-store
  // evaluation still runs below so an incomplete scan cannot hide findings.
  if (inventoryIsIncomplete(input)) {
    const reasons =
      input.incompleteReasons.length === 0
        ? "no reasons were supplied"
        : input.incompleteReasons.join("; ");
    findings.push(
      setScopedFinding(
        "inventory-incomplete",
        `Store enumeration did not complete (${reasons}); the store set is unknown, so no conclusion may be drawn about which stores exist.`,
        inventoryRemedy(input.incompleteReasons),
      ),
    );
  } else if (isFreshProfile(input)) {
    // A complete enumeration that provably found nothing is a fresh profile.
    // With required stores listed, their per-store `store-missing` findings
    // are the refusal and no set-scoped duplicate is added.
    findings.push(
      setScopedFinding(
        "store-missing",
        "No store exists in this profile and no required stores are listed; a fresh profile is not allowed implicitly.",
        freshProfileRemedy(),
      ),
    );
  }

  for (const store of input.stores) {
    const storeFindings =
      store.presence === "present"
        ? evaluatePresentStore(store)
        : evaluateNonPresentStore(store);
    findings.push(...storeFindings);
  }

  return {
    action: findings.length === 0 ? "allow" : "refuse",
    findings,
  };
}
