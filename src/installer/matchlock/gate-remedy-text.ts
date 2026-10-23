/**
 * Matchlock launch-gate remedy renderer (G9 EXIT-CODE-AND-REMEDIES, US-003).
 *
 * The launch gate refuses BEFORE any VM is created and before any mount is
 * made, so the only thing the operator receives is text: which stores failed,
 * under which reason codes, what the observed evidence was, and what to do
 * about it. This module renders that text from a {@link GateVerdict} plus a
 * {@link HolderDetection}. It is a PURE function of its single argument: no
 * filesystem access, no process probe, no clock, no environment read, no
 * randomness and no writes. Rendering a remedy never changes a verdict.
 *
 * GENERATED PER FAILING STORE, NEVER ONE BOILERPLATE BLOB. Report production
 * (a static paragraph repeated for every refusal) tells an operator nothing
 * about WHICH store to fix. Each failing store gets its own section carrying
 * its own path, its own codes in the evaluator's canonical order and its own
 * remedy. Set-scoped findings (an incomplete inventory, a fresh profile) come
 * first under a store-set section, because they are not about one store; store
 * sections follow in FIRST-APPEARANCE order in `verdict.findings`, which is
 * the evaluator's input order. Within one store, codes follow
 * {@link REMEDY_CODE_ORDER}, a local copy of the evaluator's
 * `REASON_CODE_ORDER` that the test pins to it. The copy exists because this
 * module is deliberately dependency-free at runtime (type-only imports only),
 * so it must not import the evaluator's value; a test proves the two lists are
 * identical, so the order cannot drift silently.
 *
 * TYPED EVIDENCE, NEVER A PARSED PROSE DETAIL. A finding's `detail` is printed
 * VERBATIM for the operator, and it is never re-read to infer state: the
 * sidecar remedy is chosen from `EvaluatedStore.sidecars`, the header advice
 * from `EvaluatedStore.header`, and so on. Inferring state from prose is how a
 * renderer starts disagreeing with the decision it is describing.
 *
 * THE THREE SIDECAR CASES STAY DISTINCT (GATE-IMPLEMENTATION-SPEC.md sections 8
 * and 11). A nonempty `-wal` may legitimately be checkpointed. A nonempty
 * `-journal` is a ROLLBACK journal, not a write-ahead-log, so a checkpoint is
 * NOT a treatment for it: the refusal may be TRANSIENT while a healthy
 * delete-journal transaction is in flight, so the operator is directed to
 * quiescence plus the supported recovery/conversion path, and never told to
 * delete it. A nonempty `-shm` without a nonempty `-wal` is REPORTED ONLY; the
 * gate is not an integrity checker, so no corruption or inconsistency is
 * diagnosed and the operator is sent to evidence collection instead.
 *
 * HOLDERS ARE INFORMATIONAL. Each store section lists the live processes whose
 * detected store paths contain that store's caller spelling or canonical
 * spelling, with pid, start identity and a SANITIZED command description.
 * Nothing here is an ownership claim, a lease or a reason code: a failed
 * holder probe is reported as informational and never adds a finding, changes
 * the verdict or blocks a launch (spec section 3 and section 5).
 *
 * NO PATTERN-KILL TEXT ANYWHERE. Process arguments can carry API keys, tokens
 * and credentials, so raw argv is never rendered: a description is defensively
 * re-sanitized here (an `sk-` credential token, `Bearer <value>`, a
 * credential-named `name=value`, control characters and newlines are all
 * removed or replaced) even though the holder detector already sanitizes it,
 * because a renderer is the last surface before an operator's terminal. The
 * words `pkill` and `killall` never survive into the rendered text either:
 * recorded pids are named, so the operator decides what, if anything, to do.
 *
 * WORDING STAYS LAUNCH-SCOPED. The text talks about refusing and relaunching a
 * Matchlock launch. It never calls a store "unsafe", "broken" or "corrupt",
 * and it never widens the closed set of ten reason codes: operational failures
 * (a receipt that could not be written, a revalidation that could not run) are
 * a separate class that is never renumbered into them.
 */

import type {
  EvaluatedStore,
  Finding,
  GateVerdict,
  ReasonCode,
  SidecarState,
} from "./launch-gate.js";
import type {
  Holder,
  HolderDetection,
  ProbeFailure,
} from "./store-holder-detect.js";

/**
 * Canonical code order, mirroring the evaluator's `REASON_CODE_ORDER`.
 *
 * Kept local so this module stays dependency-free at runtime. The test asserts
 * this list is identical, element for element and in order, to the evaluator's
 * exported array, so a reordering or an added code fails loudly here rather
 * than producing text in a different order from the verdict that produced it.
 */
const REMEDY_CODE_ORDER: readonly ReasonCode[] = [
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
];

/** Rank of a code in {@link REMEDY_CODE_ORDER}; unknown codes sort last. */
function reasonRank(code: ReasonCode): number {
  const index = REMEDY_CODE_ORDER.indexOf(code);
  return index === -1 ? REMEDY_CODE_ORDER.length : index;
}

/** Complete SQLite header length required by the gate's reader. */
const DATABASE_HEADER_SIZE = 100;

/** Bounded size for any free-form text this module renders. */
const MAX_DESCRIPTION_LENGTH = 240;

/** Marker substituted for credential-shaped or pattern-kill text. */
const REDACTED = "[redacted]";

/** Placeholder for a description the caller did not supply. */
const DESCRIPTION_UNAVAILABLE = "(command unavailable)";

/**
 * Credential NAME suffixes: a `name=value` whose name ends with one of these
 * carries a secret value, so the value is never rendered.
 */
const SECRET_NAME_SUFFIXES = [
  "token",
  "key",
  "secret",
  "password",
  "passwd",
  "authorization",
] as const;

/** Pattern-kill vocabulary that must never survive into rendered text. */
const PATTERN_KILL_WORDS = ["pkill", "killall"] as const;

/**
 * Bare flags (leading dashes ignored) whose NEXT argument carries a secret.
 *
 * `name=value` forms are handled by the assignment rule; this covers the
 * space-separated form (`--api-key <secret>`), which would otherwise survive
 * as an identifying argument.
 */
const SECRET_FLAG_NAMES = new Set<string>([
  "token",
  "key",
  "secret",
  "password",
  "passwd",
  "authorization",
  "api-key",
  "api_key",
  "access-token",
  "access_token",
  "api-token",
  "api_token",
]);

/** One generated remedy step. The command is optional. */
interface RemedyLine {
  text: string;
  command?: string;
}

/** The complete input to {@link renderGateRemedyText}. */
export interface GateRemedyInput {
  /** The evaluator's verdict. Its findings drive every refusal statement. */
  verdict: GateVerdict;
  /** Informational holder listing from the detector; never a verdict input. */
  holderDetection: HolderDetection;
  /** The observed stores, used for typed evidence and identity matching. */
  stores: readonly EvaluatedStore[];
  /** Exact command that launches the session again once remediated. */
  relaunchCommand: string;
  /**
   * Path of the configuration the GUEST reads, when known. Named in the
   * `not-delete-config` remedy so an operator edits the guest-visible config
   * and not the host's.
   */
  guestConfigPath?: string | null;
}

/** Strip control characters, collapse whitespace, trim, and bound length. */
function sanitizeText(value: string): string {
  const flattened = value
    // Control bytes (including newlines and NUL) plus the Unicode line and
    // paragraph separators, which some terminals still treat as newlines.
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (flattened.length <= MAX_DESCRIPTION_LENGTH) return flattened;
  return `${flattened.slice(0, MAX_DESCRIPTION_LENGTH - 3)}...`;
}

/** Strip leading dashes and lowercase a flag or assignment name. */
function normalizeName(name: string): string {
  return name.replace(/^-+/, "").toLowerCase();
}

/** True when a `name=value` NAME marks its value as a credential. */
function isCredentialName(name: string): boolean {
  const normalized = normalizeName(name);
  if (normalized.length === 0) return false;
  return SECRET_NAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** True when a bare flag (leading dashes ignored) takes a secret value. */
function isCredentialFlag(token: string): boolean {
  return SECRET_FLAG_NAMES.has(normalizeName(token));
}

/**
 * Redact the space-separated flag form: when a token is a credential flag and
 * not an assignment, the token after it is a secret value.
 */
function redactCredentialFlags(text: string): string {
  const tokens = text.split(" ");
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.includes("=")) continue;
    if (isCredentialFlag(token)) {
      tokens[index + 1] = REDACTED;
    }
  }
  return tokens.join(" ");
}

/**
 * Replace credential-shaped text: `sk-` credentials, `Bearer <value>`,
 * `name=value` assignments whose name marks the value as a secret, and the
 * space-separated form of a credential flag.
 *
 * The `sk-` form requires at least eight credential characters after the
 * prefix and a boundary before it, so an ordinary word such as `task-runner`
 * is left alone. The `Bearer` spelling is canonicalized in the output.
 */
function redactCredentialShapes(text: string): string {
  let value = text;

  value = value.replace(
    /(^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}/g,
    (_match, prefix: string) => `${prefix}${REDACTED}`,
  );

  value = value.replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`);

  value = value.replace(/([^\s=]+)=(\S*)/g, (match, name: string) =>
    isCredentialName(name) ? `${name}=${REDACTED}` : match,
  );

  return redactCredentialFlags(value);
}

/** Replace pattern-kill vocabulary, including the force-kill form. */
function redactPatternKill(text: string): string {
  let value = text;
  for (const word of PATTERN_KILL_WORDS) {
    value = value.replace(new RegExp(word, "gi"), REDACTED);
  }
  return value.replace(/\bkill\s+-9(?:\s+\d+)?\b/gi, REDACTED);
}

/**
 * Defensive sanitization of a process command description.
 *
 * The holder detector already sanitizes what it records, and this repeats the
 * work because the renderer is the surface an operator actually reads: the
 * input here is any caller-supplied string, which may have bypassed the
 * detector or carried a description written before the detector's rules
 * existed. A description is identification, never a transcript.
 */
function sanitizeCommandDescription(description: unknown): string {
  const raw = typeof description === "string" ? description : "";
  const flattened = sanitizeText(raw);
  if (flattened.length === 0) return DESCRIPTION_UNAVAILABLE;
  return sanitizeText(redactPatternKill(redactCredentialShapes(flattened)));
}

/** Sanitize a short identifier (a start identity or probe scope). */
function sanitizeIdentifier(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const flattened = sanitizeText(raw);
  return flattened.length === 0 ? "(unrecorded)" : flattened;
}

/** True when the two sidecar collections carry no unresolved state. */
function isUnresolvedSidecar(state: SidecarState): boolean {
  return state === "presentNonEmpty" || state === "unreadable";
}

/** The path commands may name: canonical when known, caller spelling otherwise. */
function commandPath(store: EvaluatedStore | null, requestedPath: string): string {
  if (store === null) return requestedPath;
  return store.identity === null ? requestedPath : store.identity.canonicalPath;
}

/** The supported conversion to the delete journal mode, verbatim. */
function convertCommand(path: string): string {
  return `hermes sessions set-journal-mode delete --db ${path}`;
}

/** The exact reverse conversion for a quiescent native store, verbatim. */
function reverseCommand(path: string): string {
  return `hermes sessions set-journal-mode wal --db ${path}`;
}

/**
 * Lead-in for the conversion step, worded from the OBSERVED on-disk format.
 *
 * A store whose header is already rollback-format must not be told to
 * "convert to rollback-format": the remaining work there is the effective
 * configuration, and the same command re-applies the delete journal mode. The
 * lead-in depends on the store, never on the reason code, so two codes on one
 * store produce the same line and the command is still printed once.
 */
function conversionLeadIn(store: EvaluatedStore | null): string {
  const header = store === null ? null : store.header;
  if (header !== null && header.headerFormat === "wal") {
    return "Convert the store to rollback-format with the delete journal mode:";
  }
  return "Apply the delete journal mode to the store so its on-disk format matches the guest-visible configuration:";
}

/** The two conversion commands, in order, for a store that needs converting. */
function conversionLines(
  store: EvaluatedStore | null,
  path: string,
): RemedyLine[] {
  return [
    {
      text: "Quiesce every writer before converting: a conversion under a live writer is not safe.",
    },
    {
      text: conversionLeadIn(store),
      command: convertCommand(path),
    },
    {
      text: "For a quiescent NATIVE store, the exact reverse conversion restores the wal journal mode:",
      command: reverseCommand(path),
    },
  ];
}

/** Describe a header version pair without interpreting it as a journal mode. */
function describePair(pair: [number, number] | null): string {
  return pair === null ? "unobserved" : `(${pair[0]},${pair[1]})`;
}

/**
 * The typed evidence line for one store.
 *
 * This is what lets an operator act on a refusal without reading the
 * evaluator's source: presence, the effective config value and its source, the
 * header classification with its raw version pair and size, and each sidecar's
 * state. Every field is either an observed value or the word `unobserved`;
 * nothing is inferred from prose and nothing is omitted to look tidier.
 */
function evidenceText(store: EvaluatedStore | null): string {
  if (store === null) {
    return "no store observation was supplied for this path";
  }

  const parts: string[] = [
    `presence=${store.presence}`,
    `required=${store.required === true ? "yes" : "no"}`,
  ];

  const config = store.config;
  parts.push(
    config === null
      ? "config=unobserved"
      : `config="${config.journalMode}" source=${config.source} observed=${
          config.observed === true ? "yes" : "no"
        }`,
  );

  const header = store.header;
  parts.push(
    header === null
      ? "header=unobserved"
      : `header=${header.headerFormat} pair=${describePair(header.rawBytes1819)} bytes=${
          header.fileSize === null ? "unobserved" : String(header.fileSize)
        }`,
  );

  const sidecars = store.sidecars;
  parts.push(
    sidecars === null
      ? "sidecars=unobserved"
      : `sidecars: -wal=${sidecars.wal} -shm=${sidecars.shm} -journal=${sidecars.journal}`,
  );

  return parts.join("; ");
}

/**
 * Sidecar-specific remedy lines chosen from TYPED evidence.
 *
 * The three sidecar kinds are not interchangeable (spec section 8) and an
 * unreadable sidecar of any kind means "cannot determine", which is a refusal
 * and never an absence. A missing observation proves nothing and says so.
 */
function sidecarLines(store: EvaluatedStore | null, path: string): RemedyLine[] {
  const sidecars = store === null ? null : store.sidecars;
  if (sidecars === null) {
    return [
      {
        text: "No sidecar observation is available, so the absence of unresolved -wal, -shm and -journal sidecars is not proven. Re-observe them and fix permissions or I/O errors before relaunching.",
      },
    ];
  }

  const lines: RemedyLine[] = [];

  if (isUnresolvedSidecar(sidecars.journal)) {
    lines.push({
      text: "The -journal sidecar is nonempty: this is a ROLLBACK journal, not a write-ahead-log, so a checkpoint is NOT a treatment for it.",
    });
    lines.push({
      text: "The refusal may be TRANSIENT while a healthy delete-journal transaction is in flight: wait for quiescence (every writer stopped), then re-observe the store before relaunching.",
    });
    lines.push({
      text: "If the -journal sidecar persists after quiescence, use the supported recovery/conversion path. The -journal file is never deleted.",
      command: convertCommand(path),
    });
    lines.push({
      text: "For a quiescent NATIVE store, the exact reverse conversion restores the wal journal mode:",
      command: reverseCommand(path),
    });
  }

  if (isUnresolvedSidecar(sidecars.wal)) {
    lines.push({
      text: "The -wal sidecar is nonempty; checkpointing it is legitimate. Quiesce every writer, then checkpoint the write-ahead-log so the sidecar can be removed before relaunching.",
    });
  }

  if (isUnresolvedSidecar(sidecars.shm)) {
    const withoutWal = isUnresolvedSidecar(sidecars.wal)
      ? ""
      : " It is present without a nonempty -wal sidecar.";
    lines.push({
      text: `The -shm sidecar is reported as observed and is not diagnosed: the gate makes no claim about database integrity.${withoutWal} Collect the store and its sidecars as evidence before relaunching.`,
    });
  }

  // An unreadable sidecar of any kind means "cannot determine": fix the read
  // problem and re-observe, never treat it as absent.
  for (const [name, state] of [
    ["-wal", sidecars.wal],
    ["-shm", sidecars.shm],
    ["-journal", sidecars.journal],
  ] as const) {
    if (state === "unreadable") {
      lines.push({
        text: `The ${name} sidecar could not be read; cannot-determine is not absence. Fix permissions or I/O errors, then re-observe it before relaunching.`,
      });
    }
  }

  if (lines.length === 0) {
    // Defensive: a sidecar-unresolved finding should always carry a bad state,
    // but a remedy list must never be empty.
    lines.push({
      text: "Re-observe the store's sidecars and resolve any unreadable state before relaunching.",
    });
  }

  return lines;
}

/**
 * The generated remedy for one reason code, per store.
 *
 * Every code in {@link REMEDY_CODE_ORDER} produces at least one line, so a
 * refusal can never render an empty remedy. Wording is launch-scoped and never
 * widens the ten-code vocabulary.
 */
function remedyForCode(
  code: ReasonCode,
  store: EvaluatedStore | null,
  requestedPath: string,
  guestConfigPath: string | null,
): RemedyLine[] {
  const path = commandPath(store, requestedPath);

  switch (code) {
    case "not-delete-config": {
      const guestTarget =
        guestConfigPath === null
          ? "the configuration the GUEST reads"
          : `the configuration the GUEST reads (${guestConfigPath})`;
      return [
        {
          text: `Set \`database.journal_mode: delete\` in ${guestTarget}, not in the host's configuration. A missing, malformed or unrecognised value resolves fail-safe to wal, so the guest-visible value must be explicit.`,
        },
        ...conversionLines(store, path),
      ];
    }

    case "wal-header":
      return conversionLines(store, path);

    case "header-unreadable": {
      const header = store === null ? null : store.header;
      const pair = header === null ? null : header.rawBytes1819;
      const pairNote =
        pair === null
          ? ""
          : ` The observed version pair is ${describePair(pair)}; it is not rollback-format.`;
      return [
        {
          text: `Re-observe the store header with every writer quiescent, then relaunch.${pairNote}`,
        },
        {
          text: "If the header stays unreadable, collect the store and its sidecars as evidence and restore the store from a known-good copy before relaunching.",
        },
      ];
    }

    case "header-not-sqlite":
      return [
        {
          text: "The file is not a SQLite database. Move it aside so it cannot be opened as a store, then initialise natively first and relaunch.",
        },
        {
          text: "A fresh or absent store must be initialised natively first; the gate never creates a store.",
        },
      ];

    case "header-truncated": {
      const header = store === null ? null : store.header;
      const size = header === null ? null : header.fileSize;
      const sizeText =
        size === null
          ? "the observed header is shorter than that"
          : `the observed header is ${size} bytes`;
      return [
        {
          text: `A complete ${DATABASE_HEADER_SIZE}-byte SQLite header is required; ${sizeText}.`,
        },
        {
          text: "Restore the store from a backup, or initialise natively first, then relaunch.",
        },
      ];
    }

    case "sidecar-unresolved":
      return sidecarLines(store, path);

    case "store-missing":
      return [
        {
          text: "This required store is absent. A fresh or absent store must be initialised natively first; the gate never creates a store.",
        },
        {
          text: "Relaunch only after the store exists natively.",
        },
      ];

    case "inventory-incomplete":
      return [
        {
          text: "Fix store enumeration and re-run the gate. An incomplete inventory means the store set is unknown and is never evidence that no stores exist.",
        },
        {
          text: "Collect the incomplete reasons above and re-observe every store before relaunching.",
        },
      ];

    case "path-unresolved":
      return [
        {
          text: "Resolve the path or permission error so the store path can be determined, then re-run the gate. Cannot-determine is not absence.",
        },
      ];

    case "permission-denied":
      return [
        {
          text: "Grant read access to the store path, or use a readable location, then re-run the gate. A permission failure is never absence.",
        },
      ];
  }
}

/** Append one remedy line, skipping a duplicate already printed for this store. */
function appendRemedyLine(
  lines: string[],
  seen: Set<string>,
  remedy: RemedyLine,
): void {
  const key = `${remedy.text}\u0000${remedy.command ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);

  lines.push(`    - ${remedy.text}`);
  if (remedy.command !== undefined) {
    lines.push(`      command: ${remedy.command}`);
  }
}

/** True when a holder was detected against either spelling of this store. */
function holderMatchesStore(
  holder: Holder,
  store: EvaluatedStore | null,
  requestedPath: string,
): boolean {
  const paths = [
    requestedPath,
    ...(store !== null && store.identity !== null
      ? [store.identity.canonicalPath]
      : []),
  ];
  const storePaths = Array.isArray(holder.storePaths) ? holder.storePaths : [];
  return storePaths.some((candidate) => paths.includes(candidate));
}

/** Render the informational holder listing for one store. */
function holderLines(
  holders: readonly Holder[],
  store: EvaluatedStore | null,
  requestedPath: string,
): string[] {
  const matching = holders.filter((holder) =>
    holderMatchesStore(holder, store, requestedPath),
  );

  if (matching.length === 0) {
    return ["  holders: none observed"];
  }

  const lines = ["  holders (informational):"];
  for (const holder of matching) {
    const pid = Number.isInteger(holder.pid) ? String(holder.pid) : "(unrecorded)";
    lines.push(
      `    - pid ${pid}, start ${sanitizeIdentifier(holder.startIdentity)}, command: ${sanitizeCommandDescription(
        holder.commandDescription,
      )}`,
    );
  }
  return lines;
}

/** Render the final informational holder-probe section. */
function holderProbeBlock(
  holderDetection: HolderDetection,
  probeFailures: readonly ProbeFailure[],
): string[] {
  const lines: string[] = ["HOLDER PROBE (informational)"];
  lines.push(
    `  observation complete: ${
      holderDetection.observationComplete === true ? "yes" : "no"
    }`,
  );

  if (probeFailures.length === 0) {
    lines.push("  probe failures: none recorded");
  } else {
    for (const failure of probeFailures) {
      const reason = sanitizeCommandDescription(failure.reason);
      lines.push(
        `  probe failure [${sanitizeIdentifier(failure.scope)}]: ${
          reason === DESCRIPTION_UNAVAILABLE ? "(no reason recorded)" : reason
        }`,
      );
    }
  }

  lines.push(
    "  A failed holder probe is informational: no reason code covers it, it adds no finding and it never changes the verdict.",
  );
  return lines;
}

/**
 * Render the operator-facing refusal text.
 *
 * Pure and deterministic: the output depends only on `input`, carries no
 * timestamp and no random data, and repeated calls with the same input produce
 * byte-identical text. It never throws for any in-contract input, and a
 * malformed or partial observation narrows the evidence rather than failing
 * the render.
 */
export function renderGateRemedyText(input: GateRemedyInput): string {
  const verdict = input.verdict;
  const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
  const stores = Array.isArray(input.stores) ? input.stores : [];
  const holders = Array.isArray(input.holderDetection.holders)
    ? input.holderDetection.holders
    : [];
  const probeFailures = Array.isArray(input.holderDetection.probeFailures)
    ? input.holderDetection.probeFailures
    : [];

  // Partition findings: set-scoped first, then per-store in first-appearance
  // order. A `Map` preserves insertion order, which is the finding order the
  // evaluator produced, so store sections follow the evaluator's input order.
  const setScoped: Finding[] = [];
  const storeScoped = new Map<string, Finding[]>();
  for (const finding of findings) {
    const storePath = typeof finding.store === "string" ? finding.store : "";
    if (storePath.length === 0) {
      setScoped.push(finding);
      continue;
    }
    const bucket = storeScoped.get(storePath);
    if (bucket === undefined) {
      storeScoped.set(storePath, [finding]);
    } else {
      bucket.push(finding);
    }
  }

  const refused = verdict.action !== "allow";

  const blocks: string[] = [];

  // --- header --------------------------------------------------------------
  const header: string[] = [
    refused
      ? "MATCHLOCK LAUNCH GATE: LAUNCH REFUSED"
      : "MATCHLOCK LAUNCH GATE: LAUNCH ALLOWED",
    `stores evaluated: ${stores.length}`,
    `stores failing: ${storeScoped.size}`,
    `findings: ${findings.length}`,
    `store-set findings: ${setScoped.length}`,
    `holders observed: ${holders.length}`,
    refused
      ? "The gate runs before any VM is created and before any mount is made: this refusal launched nothing and mounted nothing."
      : "The gate runs before any VM is created and before any mount is made: the launch may proceed.",
  ];
  if (refused) {
    header.push(
      "The ten reason codes are closed; operational failures (receipt write, revalidation, evaluation crash) are a separate class and are never renumbered into them.",
    );
  } else {
    header.push(
      "No findings were produced: every evaluated store is rollback-format and the effective configuration requests the delete journal mode.",
    );
  }
  header.push(
    "Holders are informational only: they identify live processes so this text is actionable, and they are never a lease, an ownership claim or a reason code.",
  );
  blocks.push(header.join("\n"));

  // --- set-scoped findings -------------------------------------------------
  if (setScoped.length > 0) {
    const lines: string[] = ["STORE SET"];
    const seen = new Set<string>();

    for (const finding of [...setScoped].sort(
      (left, right) => reasonRank(left.code) - reasonRank(right.code),
    )) {
      lines.push(`  finding [${finding.code}]: ${finding.detail}`);
    }

    lines.push("  remedy:");
    for (const finding of [...setScoped].sort(
      (left, right) => reasonRank(left.code) - reasonRank(right.code),
    )) {
      for (const remedy of remedyForCode(
        finding.code,
        null,
        "(store set)",
        input.guestConfigPath ?? null,
      )) {
        if (remedy.command === undefined) {
          appendRemedyLine(lines, seen, remedy);
          continue;
        }
        // A set-scoped finding names no store, so a per-store command must not
        // be printed with an invented path: tell the operator to run the same
        // step per store instead.
        appendRemedyLine(lines, seen, {
          text: `${remedy.text} Run it per store, naming that store's path.`,
        });
      }
    }
    blocks.push(lines.join("\n"));
  }

  // --- one section per failing store --------------------------------------
  let index = 0;
  for (const [storePath, sectionFindings] of storeScoped) {
    index += 1;
    const store =
      stores.find((candidate) => candidate.requestedPath === storePath) ?? null;
    const ordered = [...sectionFindings].sort(
      (left, right) => reasonRank(left.code) - reasonRank(right.code),
    );

    const lines: string[] = [
      `STORE ${index}/${storeScoped.size}: ${storePath}`,
      `  presence: ${store === null ? "unobserved (no store observation supplied)" : store.presence}`,
      `  codes: ${ordered.map((finding) => finding.code).join(", ")}`,
      `  evidence: ${evidenceText(store)}`,
    ];

    for (const finding of ordered) {
      lines.push(`  finding [${finding.code}]: ${finding.detail}`);
    }

    const seen = new Set<string>();
    lines.push("  remedy:");
    for (const finding of ordered) {
      for (const remedy of remedyForCode(
        finding.code,
        store,
        storePath,
        input.guestConfigPath ?? null,
      )) {
        appendRemedyLine(lines, seen, remedy);
      }
    }

    lines.push(...holderLines(holders, store, storePath));
    blocks.push(lines.join("\n"));
  }

  // --- holder probe --------------------------------------------------------
  blocks.push(
    holderProbeBlock(input.holderDetection, probeFailures).join("\n"),
  );

  // --- relaunch ------------------------------------------------------------
  // The relaunch line carries the caller's own command verbatim on its own
  // `Relaunch:` line, so an operator can copy it without editing prose out of
  // the sentence around it.
  blocks.push(
    [
      "RELAUNCH",
      "  Launch again only after every finding above is addressed.",
      `  Relaunch: ${sanitizeText(
        typeof input.relaunchCommand === "string" ? input.relaunchCommand : "",
      )}`,
    ].join("\n"),
  );

  return `${blocks.join("\n\n")}\n`;
}
