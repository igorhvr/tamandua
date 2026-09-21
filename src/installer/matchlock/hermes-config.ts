/**
 * Matchlock Hermes configuration parsing and read guard.
 *
 * MTLK-HERMES US-001: a narrow, typed view over the selected Hermes
 * `config.yaml`. Parsing uses the supported `yaml` dependency (not fragile
 * line regex), and every field is optional so the adapter never assumes the
 * user's whole configuration shape.
 *
 * MTLK-HERMES-GUARD: this module is the descriptor-stage admission guard for
 * the effective terminal backend. The adapter reads configuration read-only;
 * it never rewrites the live YAML or injects env to hide an incompatibility.
 *
 * The guard's contract with native behavior (hermes_cli/config.py
 * `_read_raw_config_impl` / `load_config`, tools/terminal_tool*):
 *
 * - A genuinely ABSENT `config.yaml` under a VALID config root is the only
 *   case where native built-in defaults apply (default terminal backend is
 *   "local"). It is reported as `{ status: "absent" }`, never as an error.
 * - An existing-but-unusable config (unreadable file, non-regular file at the
 *   config path — directory/FIFO/socket/device — or EISDIR/ENOTDIR layout,
 *   invalid config root, malformed YAML, non-mapping top level, non-mapping
 *   `terminal` section, non-string `terminal.backend`) is reported as a
 *   structured bounded `problem`. The local-backend admission MUST NOT turn
 *   any of these into `{ ok: true }` — `assertLocalTerminalBackend` refuses a
 *   parse result whose `ok` is false just as loudly as it refuses a remote
 *   backend, so passing a failed parse straight into the check can never
 *   admit local.
 * - An explicit non-"local" `terminal.backend` (known remote backend such as
 *   docker/ssh/modal/singularity/daytona/vercel_sandbox, or an unrecognized
 *   name) is refused by `assertLocalTerminalBackend`. Env injection cannot
 *   repair an explicitly remote backend, so Matchlock fails closed.
 * - Backend STRING values are classified EXACTLY as parsed: native Hermes
 *   bridges the raw scalar verbatim to TERMINAL_ENV, so only the exact string
 *   "local" (or an unset/empty backend) is guest-local. Whitespace-padded
 *   (`" local "`), whitespace-only (`"   "`) and block-scalar (`"local\n"`)
 *   values are unrecognized backends — never normalized to "local" — and are
 *   refused as `terminal-backend-unknown` without echoing the value.
 * - Diagnostics never copy raw configuration lines, YAML-parser messages,
 *   credentials, dotenv values or arbitrary values back into reasons. Only
 *   bounded codes, field names, errno tokens and numeric line/column
 *   locations are returned. We do not promise to sanitize arbitrary config
 *   content; we avoid copying it into diagnostics in the first place.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/** Terminal backends that are effectively guest-local and therefore allowed. */
const LOCAL_TERMINAL_BACKENDS = ["local"] as const;

/**
 * Built-in backends present in the inspected native CLI
 * (tools/terminal_tool_backends.py `_ENV_BUILDERS`) that execute OUTSIDE the
 * guest. Used for classification only; the adapter refuses them instead of
 * editing the config or injecting env. Plugin backends and any other string
 * are not in this set and are refused as unknown.
 */
const KNOWN_REMOTE_TERMINAL_BACKENDS = new Set<string>([
  "docker",
  "ssh",
  "modal",
  "singularity",
  "daytona",
  "vercel_sandbox",
]);

/**
 * Bounded classification codes for every way the effective config can fail to
 * establish a guest-local terminal backend. Codes are stable enum tokens —
 * never derived from config content.
 */
export type HermesConfigProblemCode =
  | "unreadable" // existing config file cannot be read (EACCES/EIO/...)
  | "not-a-file" // config path is a directory, FIFO/socket/device, or its parent is not a dir (EISDIR/ENOTDIR)
  | "invalid-root" // selected config root is missing or not a directory
  | "malformed-yaml" // YAML could not be parsed
  | "top-level-not-mapping" // parsed document root is not a YAML mapping
  | "terminal-not-mapping" // `terminal` is present but not a mapping
  | "terminal-backend-type" // `terminal.backend` present but not a string
  | "terminal-backend-remote" // `terminal.backend` names a known remote backend
  | "terminal-backend-unknown"; // `terminal.backend` string is not recognized

/** Bounded 1-based YAML error location (line/column numbers only). */
export interface HermesConfigLocation {
  line: number;
  column: number;
}

/**
 * Structured, bounded problem description. Never contains raw config lines,
 * parser messages, credentials, dotenv values or arbitrary config values.
 */
export interface HermesConfigProblem {
  code: HermesConfigProblemCode;
  /** Bounded field name (e.g. "config.yaml", "terminal", "terminal.backend") or null. */
  field: string | null;
  /** Numeric YAML error location; only meaningful for `malformed-yaml`. */
  location: HermesConfigLocation | null;
  /** Bounded fs errno token when the problem came from the filesystem. */
  errno: string | null;
  /** Bounded, actionable text. Static prose only. */
  detail: string;
}

/**
 * Parsed Hermes config: a single object that doubles as the typed view (ok)
 * and the bounded problem carrier (ok:false). `ok:false` results are NEVER a
 * usable config and `assertLocalTerminalBackend` refuses them, so a failed
 * parse can never be mistaken for an unset-backend default.
 */
export interface ParsedHermesConfig {
  /** true = parseable typed view; false = blocking problem (see `problem`). */
  ok: boolean;
  /** Sticky/selected profile id (e.g. from `active_profile`), when ok. */
  activeProfile?: string;
  /**
   * Raw `terminal.backend` scalar exactly as configured, only when explicitly
   * set to a non-empty string. Verbatim — never trimmed or normalized: native
   * Hermes bridges this exact value to TERMINAL_ENV, so a whitespace-padded,
   * whitespace-only or block-scalar value must stay distinguishable from
   * "local". Admission (`assertLocalTerminalBackend`) requires the exact
   * string "local".
   */
  terminalBackend?: string;
  /** Effective primary model id, if configured (read-only note), when ok. */
  model?: string;
  /** Effective inference provider, if configured (read-only note), when ok. */
  provider?: string;
  /** Bounded blocking problem; present exactly when `ok` is false. */
  problem?: HermesConfigProblem;
}

/**
 * Result of reading the effective Hermes config file:
 * - `absent`: the file is genuinely missing and the selected config root is a
 *   valid directory — native built-in defaults (=> local backend) apply.
 * - `ok`: a usable parsed config was read (`config.ok === true`); backend
 *   admission is a separate check.
 * - `error`: a bounded problem (unreadable / not-a-file / invalid-root /
 *   malformed YAML / invalid top-level / terminal section or backend type).
 */
export type HermesConfigReadResult =
  | { status: "absent" }
  | { status: "ok"; config: ParsedHermesConfig }
  | { status: "error"; problem: HermesConfigProblem };

/** Result of asserting an effective local terminal backend. */
export type LocalBackendCheck =
  | { ok: true }
  | {
      ok: false;
      code: HermesConfigProblemCode;
      /** Bounded actionable reason; never raw config lines or unknown values. */
      reason: string;
    };

/**
 * TEST-ONLY deterministic fs seam. Production callers of `readHermesConfig`
 * MUST omit it (the real fs is used); only synthetic tests pass stub
 * `statSync`/`readFileSync` so root-DAC-independent failures (EACCES, fake
 * non-regular Stats) can be exercised deterministically. Never accept an fs
 * implementation influenced by the submitting user/controller.
 */
export interface HermesConfigFsDeps {
  statSync: (p: string) => fs.Stats;
  readFileSync: (p: string, encoding: "utf8") => string;
}

const REAL_FS: HermesConfigFsDeps = {
  statSync: (p) => fs.statSync(p),
  readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** First string value among candidate keys (top-level), or undefined. */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** Read a nested string value, e.g. `agent.model`. */
function pickNestedString(
  obj: Record<string, unknown>,
  parentKey: string,
  childKey: string,
): string | undefined {
  const parent = obj[parentKey];
  if (!isRecord(parent)) return undefined;
  const v = parent[childKey];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** Bound an fs error to a safe errno token (never the raw message). */
function errnoOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(code) ? code : null;
}

/** Extract only numeric line/column from a yaml parse error (never its message). */
function yamlLocation(err: unknown): HermesConfigLocation | null {
  const linePos = (err as { linePos?: unknown } | null)?.linePos;
  if (Array.isArray(linePos) && linePos.length > 0 && isRecord(linePos[0])) {
    const { line, col } = linePos[0];
    if (
      typeof line === "number" &&
      Number.isInteger(line) &&
      line > 0 &&
      typeof col === "number" &&
      Number.isInteger(col) &&
      col > 0
    ) {
      return { line, column: col };
    }
  }
  return null;
}

function malformedYamlProblem(err: unknown): HermesConfigProblem {
  return {
    code: "malformed-yaml",
    field: "config.yaml",
    location: yamlLocation(err),
    errno: null,
    detail:
      "config.yaml is not valid YAML; Matchlock cannot establish the effective terminal backend from it (no raw config content is reported).",
  };
}

const TOP_LEVEL_NOT_MAPPING_PROBLEM: HermesConfigProblem = {
  code: "top-level-not-mapping",
  field: "config.yaml",
  location: null,
  errno: null,
  detail:
    "config.yaml does not contain a YAML mapping at the top level; Matchlock cannot establish the effective terminal backend from it.",
};

const TERMINAL_NOT_MAPPING_PROBLEM: HermesConfigProblem = {
  code: "terminal-not-mapping",
  field: "terminal",
  location: null,
  errno: null,
  detail:
    'The "terminal" section is not a mapping; an explicit terminal backend cannot be read, so Matchlock cannot establish a guest-local backend from it.',
};

const TERMINAL_BACKEND_TYPE_PROBLEM: HermesConfigProblem = {
  code: "terminal-backend-type",
  field: "terminal.backend",
  location: null,
  errno: null,
  detail:
    '"terminal.backend" is present but is not a string; the configured backend cannot be established, so Matchlock cannot treat it as guest-local.',
};

function unreadableProblem(errno: string | null): HermesConfigProblem {
  return {
    code: "unreadable",
    field: "config.yaml",
    location: null,
    errno,
    detail:
      "config.yaml exists but cannot be read; Matchlock cannot establish the effective terminal backend from an unreadable config file.",
  };
}

function notAFileProblem(errno: string | null): HermesConfigProblem {
  return {
    code: "not-a-file",
    field: "config.yaml",
    location: null,
    errno,
    detail:
      "config.yaml is not a regular file (directory, FIFO, socket, device, or missing parent); Matchlock will not read it to establish the effective terminal backend.",
  };
}

function invalidRootProblem(errno: string | null): HermesConfigProblem {
  return {
    code: "invalid-root",
    field: "config.yaml",
    location: null,
    errno,
    detail:
      "The selected Hermes config root is missing or not a directory; a missing root is not treated as the built-in default by the Matchlock guard.",
  };
}

function okConfig(): ParsedHermesConfig {
  return { ok: true };
}

function failedConfig(problem: HermesConfigProblem): ParsedHermesConfig {
  return { ok: false, problem };
}

/**
 * Parse Hermes `config.yaml` text. Malformed YAML and invalid
 * top-level/terminal/backend shapes return `ok:false` with a bounded problem —
 * they are NEVER silently treated as an unset (default-local) view, and the
 * raw YAML-parser message is never copied into the returned problem.
 *
 * Backend string values are kept VERBATIM (never trimmed): native Hermes
 * bridges the raw scalar to TERMINAL_ENV, so `" local "` / `"   "` / block
 * scalars must survive into the typed view where the exact-value check
 * (`assertLocalTerminalBackend`) classifies them — padding is never folded
 * into "local". Only an explicit empty string behaves as unset/empty
 * (native built-in default-local).
 */
export function parseHermesConfig(yamlText: string): ParsedHermesConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    return failedConfig(malformedYamlProblem(err));
  }
  // Empty document / explicit `null` root: no overrides -> built-in defaults.
  if (raw === null || raw === undefined) return okConfig();
  if (!isRecord(raw)) return failedConfig(TOP_LEVEL_NOT_MAPPING_PROBLEM);

  const view = okConfig();
  const model =
    pickString(raw, ["model"]) ??
    pickNestedString(raw, "agent", "model") ??
    pickNestedString(raw, "inference", "model");
  const provider =
    pickString(raw, ["provider"]) ??
    pickNestedString(raw, "agent", "provider") ??
    pickNestedString(raw, "inference", "provider");
  const activeProfile = pickString(raw, ["active_profile", "activeProfile"]);
  if (activeProfile !== undefined) view.activeProfile = activeProfile;
  if (model !== undefined) view.model = model;
  if (provider !== undefined) view.provider = provider;

  // `terminal` section. Absent or null behaves as unset (default local).
  const terminal = raw["terminal"];
  if (terminal === undefined || terminal === null) {
    return view;
  }
  if (!isRecord(terminal)) {
    return failedConfig(TERMINAL_NOT_MAPPING_PROBLEM);
  }
  // `terminal.backend`: absent/null behave as unset (native default local).
  const backend = terminal["backend"];
  if (backend === undefined || backend === null) {
    return view;
  }
  if (typeof backend !== "string") {
    return failedConfig(TERMINAL_BACKEND_TYPE_PROBLEM);
  }
  // Exact empty string behaves as unset/empty (native default local); every
  // other string — including whitespace-only and whitespace-padded values —
  // is kept verbatim so the exact-value check can refuse it as unrecognized.
  if (backend === "") return view;
  view.terminalBackend = backend;
  return view;
}

/**
 * Read and parse the effective Hermes config.yaml.
 *
 * Native semantics preserved: a genuinely absent file under a valid config
 * root is `{ status: "absent" }` (built-in defaults => local backend).
 *
 * Every other failure is distinguished with a bounded structured problem
 * (unreadable, not-a-file — a directory, FIFO/socket/device at the config
 * path, or EISDIR/ENOTDIR layout — invalid root, malformed YAML, invalid
 * top-level/terminal/backend shape). None of these may ever be conflated with
 * absence or default to local, and no read is attempted on a known
 * non-regular file (a FIFO would block indefinitely).
 *
 * `testOnlyFs` is an optional TEST-ONLY fs seam used ONLY by deterministic
 * synthetic tests (running as root, chmod-based DAC cannot simulate EACCES or
 * a fake non-regular Stats). Production callers MUST omit it and use the real
 * fs.
 */
export function readHermesConfig(
  configPath: string,
  testOnlyFs: Partial<HermesConfigFsDeps> = {},
): HermesConfigReadResult {
  const fsx: HermesConfigFsDeps = { ...REAL_FS, ...testOnlyFs };
  const root = path.dirname(configPath);

  let st: fs.Stats;
  try {
    st = fsx.statSync(configPath);
  } catch (err) {
    const errno = errnoOf(err);
    if (errno === "ENOENT") return resolveAbsence(root, fsx);
    if (errno === "ENOTDIR" || errno === "EISDIR") {
      return { status: "error", problem: notAFileProblem(errno) };
    }
    return { status: "error", problem: unreadableProblem(errno) };
  }

  if (!st.isFile()) {
    // config.yaml is a directory (a read would raise EISDIR) or a non-regular
    // file such as a FIFO/socket/device (a read would block or misbehave).
    // Never attempt the read: bounded not-a-file classification instead.
    return {
      status: "error",
      problem: notAFileProblem(st.isDirectory() ? "EISDIR" : null),
    };
  }

  let text: string;
  try {
    text = fsx.readFileSync(configPath, "utf8");
  } catch (err) {
    const errno = errnoOf(err);
    if (errno === "ENOENT") return resolveAbsence(root, fsx);
    return { status: "error", problem: unreadableProblem(errno) };
  }

  const parsed = parseHermesConfig(text);
  if (!parsed.ok) return { status: "error", problem: parsed.problem ?? malformedYamlProblem(null) };
  return { status: "ok", config: parsed };
}

/**
 * Classify a config-path ENOENT: built-in defaults apply ONLY when the
 * selected config root is a real directory; otherwise the root is invalid.
 */
function resolveAbsence(root: string, fsx: HermesConfigFsDeps): HermesConfigReadResult {
  try {
    const rootStat = fsx.statSync(root);
    if (rootStat.isDirectory()) return { status: "absent" };
    return { status: "error", problem: invalidRootProblem(null) };
  } catch (err) {
    return { status: "error", problem: invalidRootProblem(errnoOf(err)) };
  }
}

/**
 * Assert the effective `terminal.backend` is guest-local. `null` means the
 * config is genuinely absent (native built-in defaults: local). A parse
 * result with `ok:false` is refused — a failed parse (malformed YAML, invalid
 * top-level/terminal/backend shape) can never assert local. An unset or exact
 * empty backend defaults to local and is acceptable. An explicit backend is
 * admitted ONLY when its exact parsed value is the string "local": native
 * Hermes bridges the raw scalar verbatim to TERMINAL_ENV, where any other
 * string — whitespace-padded, whitespace-only or block-scalar variants
 * included — is an unrecognized backend (never local). A known remote backend
 * (docker/ssh/modal/singularity/daytona/vercel_sandbox) cannot be repaired by
 * injecting `TERMINAL_ENV`, so it fails loudly as `terminal-backend-remote`;
 * every other explicit string is refused as `terminal-backend-unknown` —
 * Matchlock never guesses that an unknown backend is local.
 *
 * Reasons are bounded: known remote names are echoed because they are static
 * enum tokens (and only the exact known token reaches that branch);
 * unrecognized or whitespace-variant values are never copied into diagnostics.
 */
export function assertLocalTerminalBackend(
  config: ParsedHermesConfig | null,
): LocalBackendCheck {
  // Only an explicit ok:false parse result is refused. null (absent config)
  // and empty/unset configs (`{}` / `{ok:true}` with no backend) default local.
  if (config !== null && config.ok === false) {
    const problem = config.problem ?? malformedYamlProblem(null);
    return {
      ok: false,
      code: problem.code,
      reason: problem.detail,
    };
  }
  // Exact-value classification: only the exact string "local" is admitted.
  // Native bridges the raw scalar verbatim to TERMINAL_ENV, so a padded /
  // whitespace-only / block-scalar backend value is an unrecognized backend,
  // never guest-local — do not trim before comparing.
  const backend = config?.terminalBackend;
  if (backend === undefined || backend === "") return { ok: true };
  if ((LOCAL_TERMINAL_BACKENDS as readonly string[]).includes(backend)) {
    return { ok: true };
  }
  if (KNOWN_REMOTE_TERMINAL_BACKENDS.has(backend)) {
    return {
      ok: false,
      code: "terminal-backend-remote",
      reason: `Effective terminal.backend is "${backend}"; Matchlock requires a guest-local terminal backend and cannot fix this from env alone.`,
    };
  }
  return {
    ok: false,
    code: "terminal-backend-unknown",
    reason:
      'Effective terminal.backend names an unrecognized backend; Matchlock admits only an unset (built-in local) or an explicit "local" terminal backend.',
  };
}
