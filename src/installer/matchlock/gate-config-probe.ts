/**
 * Matchlock GUEST-side effective-config probe (G8 ADMISSION-INTEGRATION US-010,
 * bead tamandua-7p5.1.8).
 *
 * WHY THIS FILE EXISTS
 *
 * The launch gate's `database.journal_mode` observation is a HOST-side read
 * (`doctor-gate.ts` `resolveEffectiveJournalMode`). A host-side read does not
 * establish what the guest's Hermes actually sees: the effective config is the
 * merge of the layers visible INSIDE that guest — the mounted profile
 * `config.yaml` plus whatever managed layer the guest image provides (or
 * `$HERMES_MANAGED_DIR` names there), and the guest image can differ from the
 * host. US-010 therefore measures the same fact from the guest's own
 * perspective and records it next to the gate receipt.
 *
 * WHAT THIS MODULE IS
 *
 * The COMPILED form of this module is packed into the read-only guest helper
 * pack (`guest-pack-builder.ts` `WALK_ROOTS`) and executed with `node` inside
 * the still-owned VM, so it must be Node-core only — no `yaml` package, no
 * native module, no database driver — and it must run standalone:
 *
 *     node <pack>/lib/installer/matchlock/gate-config-probe.js -- '<json>'
 *
 * It writes ONE bounded JSON line per requested store to stdout and exits 0 for
 * every handled outcome:
 *
 *     {"store":"/workspace/config/hermes/state.db",
 *      "journalMode":"delete"|"wal"|"unreadable",
 *      "source":"guest-observed: user config ..., then managed scope ...",
 *      "readable":true|false}
 *
 * It NEVER writes, creates, repairs, converts or deletes anything, and it never
 * decides anything: it is evidence for the qualification record, not a second
 * gate. An unreadable layer is reported as `unreadable`/`readable:false` — never
 * as a guessed `delete` and never as a fabricated `wal`.
 *
 * THE SEMANTICS IT MIRRORS (stock Hermes `resolve_journal_mode()`)
 *
 *  1. start at `wal`;
 *  2. apply `<hermesHome>/config.yaml` (`database.journal_mode`) when present;
 *  3. apply the managed layer LAST, so a managed leaf wins;
 *  4. only the exact strings `delete`/`wal` after trim+lowercase are recognised
 *     (`" DELETE "` and `"Wal"` count, `"truncate"` does not) and every other
 *     value fails safe to `wal` — it never fails to `delete`;
 *  5. a missing file / missing `database` section / missing `journal_mode` key
 *     is NOT a value: the layer contributes nothing;
 *  6. an unreadable or unparseable layer is `unreadable` — inability to inspect
 *     a config the writer reads is never rendered as a pass.
 *
 * DELIBERATE LIMIT OF THE YAML READER
 *
 * The packed helper cannot import a YAML parser (the pack is Node-core only), so
 * this module scans the `database:` mapping with a bounded, tab-free,
 * block-style reader. A flow-style mapping (`database: {journal_mode: delete}`)
 * or a tab-indented document is reported as `unreadable`/`readable:false`
 * instead of being guessed. That is the safe direction: the qualification
 * record then says "not established from inside the guest", and the record's
 * `provenance` still reflects that the measurement ran.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The managed-scope directory the stock runtime falls back to. */
const DEFAULT_MANAGED_DIR = "/etc/hermes";

/** The environment variable the runtime honours for the managed scope. */
const MANAGED_DIR_ENV = "HERMES_MANAGED_DIR";

/**
 * The environment variable the stock writer IGNORES. Named only so the emitted
 * `source` text can say so explicitly (honouring it would fail in the dangerous
 * direction, admitting a store the writer treats as WAL).
 */
const IGNORED_JOURNAL_MODE_ENV = "HERMES_JOURNAL_MODE";

/** Upper bound on one emitted `source` string, so a line stays bounded. */
export const GUEST_CONFIG_PROBE_MAX_SOURCE_CHARS = 400;

/** The closed set of journal modes the guest probe may report. */
export type GuestJournalMode = "delete" | "wal" | "unreadable";

/** One request field set the host sends (JSON on argv). */
export interface GuestConfigProbeRequest {
  /** Guest HERMES_HOME (the mounted effective profile directory). */
  hermesHome?: string;
  /** Guest-visible store paths this observation is attributed to. */
  stores?: string[];
  /**
   * Managed-scope directory override:
   *  - omitted → resolve like the runtime (env, then `/etc/hermes`);
   *  - `null`  → NO managed layer (deterministic fixture tests);
   *  - string  → exactly that directory.
   */
  managedDir?: string | null;
  /** Environment used for `$HERMES_MANAGED_DIR` (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
}

/** One emitted line (exactly the four fields the host parses). */
export interface GuestConfigProbeLine {
  store: string;
  journalMode: GuestJournalMode;
  source: string;
  readable: boolean;
}

/** One config layer's `database.journal_mode` leaf. */
type JournalLeaf =
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string }
  | { kind: "leaf"; mode: "delete" | "wal" };

/** True for errno shapes that mean "this path does not exist". */
function isAbsentError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Identify the start of a YAML comment in a scalar (` #...` outside quotes), or
 * -1. A `#` that is not preceded by whitespace is part of the value.
 */
function commentStart(value: string): number {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && i > 0 && /\s/.test(value[i - 1])) return i;
  }
  return -1;
}

/** Scalar text of one `key: value` value, with quotes and comments removed. */
function scalarText(raw: string): string {
  let value = raw.trim();
  const hash = commentStart(value);
  if (hash >= 0) value = value.slice(0, hash).trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
    }
  }
  return value.trim();
}

/** Leading indentation width, or -1 when a tab is used for indentation. */
function indentWidth(line: string): number {
  let width = 0;
  while (width < line.length && line[width] === " ") width += 1;
  if (line[width] === "\t") return -1;
  return width;
}

/** A line carrying no YAML content (blank or a whole-line comment). */
function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/**
 * Read one config layer's `database.journal_mode` leaf, mirroring the stock
 * resolver (see the module doc block). Never throws.
 */
export function readGuestJournalModeLeaf(configPath: string): JournalLeaf {
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (isAbsentError(error)) return { kind: "absent" };
    const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
    return { kind: "unreadable", detail: `unreadable:${code}` };
  }

  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));

  // A sequence document is not a mapping: no `database` leaf can be read.
  const firstSignificant = lines.find((line) => !isBlankOrComment(line));
  if (firstSignificant !== undefined && firstSignificant.trimStart().startsWith("-")) {
    return { kind: "unreadable", detail: "not-a-mapping" };
  }

  let databaseIndex = -1;
  let databaseInline = "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    const indent = indentWidth(line);
    if (indent < 0) return { kind: "unreadable", detail: "tab-indented" };
    if (indent !== 0) continue;
    const match = /^database\s*:(.*)$/.exec(line);
    if (match !== null) {
      databaseIndex = i;
      databaseInline = match[1];
    }
  }
  if (databaseIndex < 0) return { kind: "absent" };

  // A flow-style mapping cannot be read by this bounded reader: say so instead
  // of guessing a mode.
  if (scalarText(databaseInline) !== "") {
    return { kind: "unreadable", detail: "flow-style-mapping" };
  }

  for (let i = databaseIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    const indent = indentWidth(line);
    if (indent < 0) return { kind: "unreadable", detail: "tab-indented" };
    if (indent === 0) break; // next top-level key: the `database` block ended
    const match = /^\s+journal_mode\s*:(.*)$/.exec(line);
    if (match === null) continue;
    const value = scalarText(match[1]);
    if (value === "") return { kind: "absent" };
    return { kind: "leaf", mode: value.toLowerCase() === "delete" ? "delete" : "wal" };
  }

  return { kind: "absent" };
}

/** The managed scope this guest resolves, plus how it was chosen. */
interface GuestManagedScope {
  dir: string | null;
  provenance: string;
}

/**
 * Resolve the managed layer EXACTLY as the runtime visible inside this guest
 * does: an explicit request override wins, then `$HERMES_MANAGED_DIR` when it
 * names an existing directory, then `/etc/hermes` when it exists, else none.
 */
function resolveGuestManagedScope(
  request: GuestConfigProbeRequest,
  env: Readonly<Record<string, string | undefined>>,
): GuestManagedScope {
  if (Object.prototype.hasOwnProperty.call(request, "managedDir")) {
    if (request.managedDir === null) {
      return { dir: null, provenance: "explicitly disabled for this probe" };
    }
    if (typeof request.managedDir === "string" && request.managedDir.trim() !== "") {
      return { dir: request.managedDir.trim(), provenance: "explicit managed scope" };
    }
  }
  const fromEnv = env[MANAGED_DIR_ENV];
  if (typeof fromEnv === "string" && fromEnv.length > 0 && isDirectory(fromEnv)) {
    return { dir: fromEnv, provenance: `${MANAGED_DIR_ENV} names an existing directory` };
  }
  if (isDirectory(DEFAULT_MANAGED_DIR)) {
    return { dir: DEFAULT_MANAGED_DIR, provenance: "default managed scope" };
  }
  return { dir: null, provenance: "none present" };
}

/** Bound one `source` string (deterministic, never file contents). */
function boundSource(text: string): string {
  return text.length > GUEST_CONFIG_PROBE_MAX_SOURCE_CHARS
    ? `${text.slice(0, GUEST_CONFIG_PROBE_MAX_SOURCE_CHARS)}...`
    : text;
}

/** The effective guest-visible journals mode for one profile home. */
export interface GuestConfigResolution {
  journalMode: GuestJournalMode;
  source: string;
  readable: boolean;
}

/**
 * Resolve the effective `database.journal_mode` as seen from INSIDE the guest.
 *
 * The emitted `source` always starts with `guest-observed:` so a reader can
 * never mistake it for the host-side observation (whose provenance text starts
 * with `host-observed:`), and it names every layer that was read.
 */
export function resolveGuestVisibleConfig(
  request: GuestConfigProbeRequest,
): GuestConfigResolution {
  const env = request.env ?? process.env;
  const hermesHome = typeof request.hermesHome === "string" ? request.hermesHome.trim() : "";
  const managed = resolveGuestManagedScope(request, env);

  const userConfigPath = hermesHome === "" ? null : path.join(hermesHome, "config.yaml");
  const managedConfigPath =
    managed.dir === null ? null : path.join(managed.dir, "config.yaml");

  const layers: Array<{ name: string; configPath: string }> = [];
  if (userConfigPath !== null) {
    layers.push({ name: "user config", configPath: userConfigPath });
  }
  if (managedConfigPath !== null) {
    layers.push({
      name: `managed scope (${managed.provenance}; managed layer wins per leaf)`,
      configPath: managedConfigPath,
    });
  }

  const managedText =
    managed.dir === null
      ? `managed scope: none (${managed.provenance})`
      : `managed scope: ${managedConfigPath} (${managed.provenance}; managed layer wins per leaf)`;
  const prefix =
    userConfigPath === null
      ? `guest-observed: no HERMES_HOME supplied, ${managedText}`
      : `guest-observed: user config ${userConfigPath}, then ${managedText}`;
  const suffix = `; ${IGNORED_JOURNAL_MODE_ENV} is not consulted by the writer or this observation`;

  let journalMode: GuestJournalMode = "wal";
  for (const layer of layers) {
    const leaf = readGuestJournalModeLeaf(layer.configPath);
    if (leaf.kind === "unreadable") {
      return {
        journalMode: "unreadable",
        source: boundSource(`${prefix}; ${layer.name} could not be read (${leaf.detail})${suffix}`),
        readable: false,
      };
    }
    if (leaf.kind === "leaf") journalMode = leaf.mode;
  }

  return { journalMode, source: boundSource(`${prefix}${suffix}`), readable: true };
}

/** Parse the request JSON the host passes as the last argv element. */
export function parseGuestConfigProbeRequest(raw: string | undefined): GuestConfigProbeRequest {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as GuestConfigProbeRequest;
  } catch {
    return {};
  }
}

/** The store list a request asks about (non-empty strings only, order kept). */
function requestedStores(request: GuestConfigProbeRequest): string[] {
  if (!Array.isArray(request.stores)) return [];
  const stores: string[] = [];
  for (const entry of request.stores) {
    if (typeof entry === "string" && entry.trim() !== "") stores.push(entry.trim());
  }
  return stores;
}

/**
 * Build one bounded JSON line per requested store. Pure apart from the config
 * reads; a request with no stores emits NO line (there is nothing to attribute).
 */
export function buildGuestConfigProbeLines(
  request: GuestConfigProbeRequest,
): GuestConfigProbeLine[] {
  const stores = requestedStores(request);
  if (stores.length === 0) return [];
  const resolution = resolveGuestVisibleConfig(request);
  return stores.map((store) => ({
    store,
    journalMode: resolution.journalMode,
    source: resolution.source,
    readable: resolution.readable,
  }));
}

/** Exit status for an unusable invocation (the host treats it as unmeasured). */
export const GUEST_CONFIG_PROBE_USAGE_EXIT_CODE = 2;

/** True when this module is the process entry point (never when imported). */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry === "") return false;
  try {
    const here = fs.realpathSync(fileURLToPath(import.meta.url));
    const there = fs.realpathSync(entry);
    return pathToFileURL(here).href === pathToFileURL(there).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const raw = process.argv.length > 0 ? process.argv[process.argv.length - 1] : undefined;
  const request = parseGuestConfigProbeRequest(raw);
  const stores = requestedStores(request);
  if (stores.length === 0) {
    process.stderr.write(
      "tamandua-gate-config-probe: no store paths were supplied; nothing to report\n",
    );
    process.exit(GUEST_CONFIG_PROBE_USAGE_EXIT_CODE);
  }
  for (const line of buildGuestConfigProbeLines(request)) {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
  process.exit(0);
}
