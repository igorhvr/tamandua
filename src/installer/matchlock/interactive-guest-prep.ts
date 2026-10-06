/**
 * MTLK-INTERACTIVE US-006 (PROVISIONAL GAP GAP-05) — in-guest user preparation.
 *
 * `planInteractiveGuestPrep` turns the selected numeric caller identity, the
 * admitted guest paths and an OBSERVED guest-state report into an ordered,
 * deterministic list of preparation commands plus the launch environment for a
 * foreground interactive Matchlock session.
 *
 * Design constraints (spec L32; INTEGRATION-NOTES GAP-05):
 *   - The planner is PURE: it imports only `node:path`, performs no I/O, no
 *     `child_process`, and no VM interaction, so it is fully unit-testable.
 *   - Commands run INSIDE the disposable guest only. Every target is a guest
 *     absolute path; the captured host HOME is provenance only and is never
 *     mounted, imported or named by a command.
 *   - passwd/group entries are emitted ONLY when the observed guest state says
 *     the numeric uid/gid is absent. The planner never rewrites an existing
 *     entry.
 *   - The guest-local HOME is created writable by the selected identity and
 *     missing guest parent directories of HOME, the configuration override and
 *     the working directory are created at most once, top-down, deterministically.
 *   - NO command ever performs a recursive `chown`/`chmod`, and no command
 *     targets a host-mount destination (home must not be, or live inside, a
 *     host-backed mount). Ownership is applied at creation with `install -d`,
 *     never by a recursive ownership walk.
 *   - Fail-closed typed refusals: missing configuration, an unsupported
 *     required external dependency, and an image whose harness/shell cannot run
 *     as the selected numeric user are refused BEFORE any VM create. There is
 *     no automatic installation, no shell substitution and no root retry.
 *
 * The returned plan is data-only so the session controller (US-010) can execute
 * the commands through the shipped transport, and so the planner can later be
 * re-expressed over shipped guest-preparation machinery without a second
 * execution path (reconciliation instruction in INTEGRATION-NOTES GAP-05).
 */

import path from "node:path";

/** Typed refusal: the selected configuration could not be captured. */
export const INTERACTIVE_GUEST_CONFIG_UNAVAILABLE_CODE =
  "interactive_guest_config_unavailable" as const;

/** Typed refusal: a REQUIRED external dependency is unsupported/unmounted. */
export const INTERACTIVE_GUEST_EXTERNAL_DEPENDENCY_UNSUPPORTED_CODE =
  "interactive_guest_external_dependency_unsupported" as const;

/** Typed refusal: the image harness/shell cannot run as the selected user. */
export const INTERACTIVE_GUEST_HARNESS_UNUSABLE_CODE =
  "interactive_guest_harness_unusable" as const;

/** Typed refusal: the preparation inputs are internally inconsistent. */
export const INTERACTIVE_GUEST_PREP_REJECTED_CODE = "interactive_guest_prep_rejected" as const;

/** Typed, actionable refusal for an in-guest preparation planning failure. */
export class InteractiveGuestPrepError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InteractiveGuestPrepError";
    this.code = code;
  }
}

/** The two interactive harnesses the planner supports. */
export type InteractiveGuestPrepHarness = "pi" | "hermes";

/** Captured numeric caller identity (never inferred from `SUDO_UID`). */
export interface InteractiveGuestPrepIdentity {
  uid: number;
  gid: number;
  /** Captured host HOME — provenance only; NEVER mounted or imported. */
  hostHomeDir?: string | null;
}

/** The harness or shell binary resolved inside the image. */
export interface InteractiveGuestPrepBinaryFact {
  /** Absolute guest path of the resolved binary, or null when absent. */
  path: string | null;
  /** True ONLY when the binary is executable by the selected numeric user. */
  runnableAsUser: boolean;
}

/**
 * An outside-scope entry reported by the harness adapter (e.g. Hermes).
 * `required: true` means the guest harness genuinely needs it; the planner
 * refuses rather than auto-mounting or broadening the mount scope.
 */
export interface InteractiveGuestExternalDependency {
  name: string;
  required: boolean;
  detail?: string;
}

/**
 * Observed guest state, supplied by the session controller's bounded probe.
 * Everything is optional; absent state is treated conservatively (an absent
 * passwd/group entry is "not present"; an absent binary report refuses because
 * the harness cannot be confirmed runnable).
 */
export interface InteractiveGuestFacts {
  /** Numeric uid entries already present in the guest passwd database. */
  passwdUids?: number[];
  /** Numeric gid entries already present in the guest group database. */
  groupGids?: number[];
  /** Guest directories that already exist (probed by the controller). */
  existingDirs?: string[];
  /** The image's effective guest PATH; preserved verbatim, never a host default. */
  imagePath?: string | null;
  /** Terminal type to forward (`TERM`), when present. */
  term?: string | null;
  /** Terminal color hint to forward (`COLORTERM`), when present. */
  colorTerm?: string | null;
  /** Resolved harness/shell binary inside the image. */
  binary?: InteractiveGuestPrepBinaryFact | null;
  /** Outside-scope dependencies reported by the harness adapter. */
  externalDependencies?: InteractiveGuestExternalDependency[];
}

/** Inputs for {@link planInteractiveGuestPrep}. */
export interface PlanInteractiveGuestPrepInput {
  harness: InteractiveGuestPrepHarness;
  /** True for the `*-shell` variants (an image-provided zsh instead of the harness). */
  shell: boolean;
  identity: InteractiveGuestPrepIdentity;
  /** Guest working directory (mount destination; identical host/guest path). */
  guestWorkingDirectory: string;
  /** Approved guest configuration override (`PI_CODING_AGENT_DIR` / `HERMES_HOME`). */
  guestConfigurationRoot: string;
  /** Captured host configuration source; missing/blank is a typed refusal. */
  hostConfigurationRoot?: string | null;
  /** Guest-local HOME override; defaults to `/root` for uid 0, else `/home/u<uid>`. */
  guestHome?: string;
  /** Guest destinations backed by host mounts (never a preparation target). */
  hostMountDestinations?: string[];
  /** Observed guest state (injectable; defaults are conservative). */
  facts?: InteractiveGuestFacts;
}

/** Deterministic preparation command ids. */
export type InteractiveGuestPrepCommandId =
  | "groupadd"
  | "useradd"
  | "create_parent_dir"
  | "create_home";

/** One ordered in-guest preparation command. */
export interface InteractiveGuestPrepCommand {
  id: InteractiveGuestPrepCommandId;
  /** Exact command to run inside the disposable guest. */
  command: string;
  /** Guest path the command creates, when it creates one. */
  target?: string;
  /** True when the command requires guest root. */
  privileged: boolean;
}

/** The ordered, data-only preparation plan for one interactive session. */
export interface InteractiveGuestPrepPlan {
  harness: InteractiveGuestPrepHarness;
  /** True for the `*-shell` variants. */
  shell: boolean;
  uid: number;
  gid: number;
  /** Deterministic guest user name written only when the uid is absent. */
  user: string;
  /** Deterministic guest group name written only when the gid is absent. */
  group: string;
  /** Guest-local HOME created writable by the selected identity. */
  guestHome: string;
  /** Approved guest configuration override. */
  guestConfigurationRoot: string;
  /** Guest working directory (mount destination). */
  guestWorkingDirectory: string;
  /** Ordered preparation commands (see the module header for the phases). */
  commands: InteractiveGuestPrepCommand[];
  /** Launch environment for the prepared guest identity. */
  env: Record<string, string>;
}

/** Deterministic guest user/group name written for the numeric identity. */
export const INTERACTIVE_GUEST_USER_NAME = "tamandua" as const;
/** Deterministic guest group name written for the numeric gid. */
export const INTERACTIVE_GUEST_GROUP_NAME = "tamandua" as const;

/** Default guest-local HOME for a numeric uid (`/root` for 0, else `/home/u<uid>`). */
export function defaultInteractiveGuestHome(uid: number): string {
  return uid === 0 ? "/root" : `/home/u${uid}`;
}

function refuse(code: string, message: string): never {
  throw new InteractiveGuestPrepError(code, message);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Normalize and validate a guest absolute path (rejecting traversal). */
function normalizeGuestPath(raw: unknown, label: string): string {
  if (typeof raw !== "string") {
    refuse(
      INTERACTIVE_GUEST_PREP_REJECTED_CODE,
      `Refusing interactive guest preparation: ${label} must be an absolute guest path (got ${JSON.stringify(raw)}).`,
    );
  }
  const value = raw.trim();
  if (value === "" || !value.startsWith("/")) {
    refuse(
      INTERACTIVE_GUEST_PREP_REJECTED_CODE,
      `Refusing interactive guest preparation: ${label} must be an absolute guest path (got ${JSON.stringify(raw)}).`,
    );
  }
  const segments = value.split("/");
  if (segments.includes("..")) {
    refuse(
      INTERACTIVE_GUEST_PREP_REJECTED_CODE,
      `Refusing interactive guest preparation: ${label} must not contain ".." (got ${JSON.stringify(raw)}).`,
    );
  }
  const normalized = path.posix.normalize(value);
  return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
}

/** True when `candidate` is `root` itself or nested inside it. */
function isSameOrInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = path.posix.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.posix.isAbsolute(rel);
}

/** Missing ancestors of `target`, top-down, EXCLUDING `target` itself. */
function missingAncestors(target: string): string[] {
  const dirs: string[] = [];
  let current = path.posix.dirname(target);
  while (current !== "/" && current !== "." && current !== "") {
    dirs.push(current);
    const parent = path.posix.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs.reverse();
}

/**
 * Defensive guard: the planner must never emit a recursive ownership command.
 * It never does, but asserting keeps the invariant explicit if the command
 * shapes are ever edited.
 */
function assertNoRecursiveOwnershipCommands(commands: InteractiveGuestPrepCommand[]): void {
  for (const entry of commands) {
    const recursiveOwnership =
      /\b(?:chown|chmod)\b/.test(entry.command) || /(?:^|\s)(?:-R|--recursive)(?:\s|$)/.test(entry.command);
    if (recursiveOwnership) {
      refuse(
        INTERACTIVE_GUEST_PREP_REJECTED_CODE,
        `Refusing interactive guest preparation: command "${entry.id}" would perform a recursive ownership change (${entry.command}); ` +
          "ownership is applied at creation only, never by a recursive chown/chmod of a mount.",
      );
    }
  }
}

/** Inputs for {@link buildInteractiveGuestLaunchEnv}. */
export interface InteractiveGuestLaunchEnvInput {
  harness: InteractiveGuestPrepHarness;
  /** Guest-local HOME (already normalized). */
  guestHome: string;
  /** Approved guest configuration override. */
  guestConfigurationRoot: string;
  /** Captured host HOME — provenance only; NEVER imported. */
  hostHomeDir?: string | null;
  /**
   * Guest destinations backed by host mounts. The guest-local HOME must not be
   * (or live inside) one of these; the configuration override MAY be, because
   * an interactive session mounts the config at its identical host path.
   */
  hostMountDestinations?: string[];
  /** The image's effective guest PATH; preserved verbatim, never a host default. */
  imagePath?: string | null;
  /** Terminal type to forward (`TERM`), when present. */
  term?: string | null;
  /** Terminal color hint to forward (`COLORTERM`), when present. */
  colorTerm?: string | null;
}

/**
 * Build the guest launch environment shared by the guest-prep planner and the
 * orchestration's pre-create env: a guest-local HOME, the admitted configuration
 * override, the image PATH preserved verbatim and only terminal settings. The
 * captured host HOME is NEVER imported; a guest-local HOME that is (or lives
 * inside) an ACTUAL host mount is a typed refusal. The configuration override
 * is deliberately allowed to be host-backed (the interactive identical-path
 * contract), so the check is mount-aware rather than a textual comparison.
 */
export function buildInteractiveGuestLaunchEnv(
  input: InteractiveGuestLaunchEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: input.guestHome,
    ...(input.harness === "hermes"
      ? { HERMES_HOME: input.guestConfigurationRoot }
      : { PI_CODING_AGENT_DIR: input.guestConfigurationRoot }),
  };
  const imagePath = typeof input.imagePath === "string" ? input.imagePath.trim() : "";
  if (imagePath !== "") env.PATH = imagePath;
  const term = typeof input.term === "string" ? input.term.trim() : "";
  if (term !== "") env.TERM = term;
  const colorTerm = typeof input.colorTerm === "string" ? input.colorTerm.trim() : "";
  if (colorTerm !== "") env.COLORTERM = colorTerm;

  // The guest HOME must be guest-local: if the caller actually mounted the host
  // HOME (or an ancestor), importing it as HOME is refused. A config override
  // nested under the host HOME is fine (D5 mounts it at its identical path).
  const guestHome = normalizeGuestPath(input.guestHome, "the guest HOME");
  const hostMountDestinations = (input.hostMountDestinations ?? [])
    .map((destination) => normalizeGuestPath(destination, "a host-mount destination"))
    .filter((destination) => destination !== "/");
  if (hostMountDestinations.some((destination) => isSameOrInside(guestHome, destination))) {
    refuse(
      INTERACTIVE_GUEST_PREP_REJECTED_CODE,
      `Refusing interactive guest preparation: the guest HOME ${guestHome} would be, or live inside, a host mount ` +
        `(${hostMountDestinations.join(", ")}); the host HOME is never mounted or imported.`,
    );
  }
  return env;
}

/**
 * Plan the in-guest preparation for ONE interactive pi/hermes session.
 *
 * Fail-closed refusals, in order:
 *   - missing/blank captured host configuration -> {@link INTERACTIVE_GUEST_CONFIG_UNAVAILABLE_CODE};
 *   - a REQUIRED external dependency -> {@link INTERACTIVE_GUEST_EXTERNAL_DEPENDENCY_UNSUPPORTED_CODE};
 *   - an absent or not-user-runnable image harness/shell ->
 *     {@link INTERACTIVE_GUEST_HARNESS_UNUSABLE_CODE};
 *   - inconsistent guest paths (home inside a host mount, non-absolute paths,
 *     traversal) -> {@link INTERACTIVE_GUEST_PREP_REJECTED_CODE}.
 */
export function planInteractiveGuestPrep(input: PlanInteractiveGuestPrepInput): InteractiveGuestPrepPlan {
  // 1. Configuration must have been captured; a missing source is refused.
  const hostConfigurationRoot =
    typeof input.hostConfigurationRoot === "string" ? input.hostConfigurationRoot.trim() : "";
  if (hostConfigurationRoot === "") {
    refuse(
      INTERACTIVE_GUEST_CONFIG_UNAVAILABLE_CODE,
      `Refusing interactive guest preparation: no host configuration source was captured for harness "${input.harness}". ` +
        "Mounting the entire selected configuration directory is required; refusing to substitute an image default.",
    );
  }
  const guestConfigurationRoot = normalizeGuestPath(
    input.guestConfigurationRoot,
    "the guest configuration override",
  );

  // 2. A required outside-scope dependency is never auto-mounted or broadened.
  const requiredDependencies = (input.facts?.externalDependencies ?? []).filter(
    (dependency) => dependency.required,
  );
  if (requiredDependencies.length > 0) {
    const names = requiredDependencies.map((dependency) => dependency.name).join(", ");
    refuse(
      INTERACTIVE_GUEST_EXTERNAL_DEPENDENCY_UNSUPPORTED_CODE,
      `Refusing interactive guest preparation: the selected harness requires unsupported external ` +
        `dependenc${requiredDependencies.length === 1 ? "y" : "ies"} (${names}). ` +
        "Missing configuration and unsupported external dependencies are explicit refusals; resolve the dependency " +
        "before launching. Mounts are never broadened to compensate.",
    );
  }

  // 3. The image harness/shell must be confirmed present AND runnable as the user.
  const binaryLabel = input.shell ? "zsh" : input.harness;
  const binary = input.facts?.binary;
  if (!binary || binary.path === null || typeof binary.path !== "string" || binary.path.trim() === "") {
    refuse(
      INTERACTIVE_GUEST_HARNESS_UNUSABLE_CODE,
      `Refusing interactive guest preparation: the image does not provide a ${binaryLabel} executable for the selected session. ` +
        "An image whose harness cannot run as the selected user fails clearly; there is no automatic installation and no root retry.",
    );
  }
  if (binary.runnableAsUser !== true) {
    refuse(
      INTERACTIVE_GUEST_HARNESS_UNUSABLE_CODE,
      `Refusing interactive guest preparation: the image ${binaryLabel} at ${binary.path} is not runnable as the selected user ` +
        `${input.identity.uid}:${input.identity.gid}. An image whose harness cannot run as the selected user fails clearly; ` +
        "there is no automatic installation and no root retry.",
    );
  }

  // 4. Numeric identity and paths.
  const { uid, gid } = input.identity;
  if (!isNonNegativeInteger(uid) || !isNonNegativeInteger(gid)) {
    refuse(
      INTERACTIVE_GUEST_PREP_REJECTED_CODE,
      `Refusing interactive guest preparation: uid/gid must be non-negative integers (got uid=${String(uid)} gid=${String(gid)}).`,
    );
  }
  const guestWorkingDirectory = normalizeGuestPath(
    input.guestWorkingDirectory,
    "the guest working directory",
  );
  const guestHome = normalizeGuestPath(
    input.guestHome ?? defaultInteractiveGuestHome(uid),
    "the guest HOME",
  );
  if (guestHome === "/") {
    refuse(
      INTERACTIVE_GUEST_PREP_REJECTED_CODE,
      "Refusing interactive guest preparation: the guest HOME must be a dedicated directory, not the filesystem root.",
    );
  }

  // 5. Host-mount destinations. No preparation target may be (or live inside)
  //    a host-backed mount, and the HOME itself must be guest-local.
  const hostMountDestinations = (input.hostMountDestinations ?? []).map((destination) =>
    normalizeGuestPath(destination, "a host-mount destination"),
  );
  if (hostMountDestinations.some((destination) => isSameOrInside(guestHome, destination))) {
    refuse(
      INTERACTIVE_GUEST_PREP_REJECTED_CODE,
      `Refusing interactive guest preparation: the guest HOME ${guestHome} must not be, or live inside, a host mount ` +
        `(${hostMountDestinations.join(", ")}). A writable HOME is created guest-locally; host mounts are never chowned or chmodded.`,
    );
  }

  const existingDirs = new Set(
    (input.facts?.existingDirs ?? []).map((dir) => normalizeGuestPath(dir, "an existing guest directory")),
  );
  const homeExists = existingDirs.has(guestHome);

  // 6. Missing parent directories of HOME, configuration override and working
  //    directory, top-down and deduplicated. Never a host mount, never "/".
  const candidateDirs: string[] = [];
  const addAncestors = (target: string): void => {
    for (const dir of missingAncestors(target)) {
      if (dir === "/" || existingDirs.has(dir)) continue;
      if (hostMountDestinations.some((destination) => isSameOrInside(dir, destination))) continue;
      if (!candidateDirs.includes(dir)) candidateDirs.push(dir);
    }
  };
  addAncestors(guestHome);
  addAncestors(guestWorkingDirectory);
  addAncestors(guestConfigurationRoot);
  candidateDirs.sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length;
    return depth !== 0 ? depth : a.localeCompare(b);
  });

  // 7. Ordered deterministic command phases: group entry (when absent), user
  //    entry (when absent), missing parent directories, writable HOME.
  const commands: InteractiveGuestPrepCommand[] = [];
  const groupExists = (input.facts?.groupGids ?? []).includes(gid);
  const userExists = (input.facts?.passwdUids ?? []).includes(uid);

  if (!groupExists) {
    commands.push({
      id: "groupadd",
      command: `groupadd --gid ${gid} ${INTERACTIVE_GUEST_GROUP_NAME}`,
      privileged: true,
    });
  }
  if (!userExists) {
    commands.push({
      id: "useradd",
      command:
        `useradd --uid ${uid} --gid ${gid} --home-dir ${guestHome} ` +
        `--no-create-home --shell /bin/sh ${INTERACTIVE_GUEST_USER_NAME}`,
      privileged: true,
    });
  }
  for (const dir of candidateDirs) {
    commands.push({
      id: "create_parent_dir",
      command: `install -d -m 0755 -o ${uid} -g ${gid} ${dir}`,
      target: dir,
      privileged: true,
    });
  }
  if (!homeExists) {
    commands.push({
      id: "create_home",
      command: `install -d -m 0700 -o ${uid} -g ${gid} ${guestHome}`,
      target: guestHome,
      privileged: true,
    });
  }

  assertNoRecursiveOwnershipCommands(commands);

  // 8. The launch environment preserves the image PATH, sets the admitted
  //    configuration override and forwards only terminal settings. The captured
  //    host HOME is NEVER imported.
  const env = buildInteractiveGuestLaunchEnv({
    harness: input.harness,
    guestHome,
    guestConfigurationRoot,
    hostHomeDir: input.identity.hostHomeDir,
    hostMountDestinations,
    imagePath: input.facts?.imagePath,
    term: input.facts?.term,
    colorTerm: input.facts?.colorTerm,
  });
  // No preparation command may target a host-backed mount. `addAncestors`
  // already skips host-mount destinations and the HOME is checked above, but
  // asserting the invariant explicitly keeps command shapes from ever editing
  // a host mount.
  for (const entry of commands) {
    if (entry.target === undefined) continue;
    const target = normalizeGuestPath(entry.target, "a preparation command target");
    if (hostMountDestinations.some((destination) => isSameOrInside(target, destination))) {
      refuse(
        INTERACTIVE_GUEST_PREP_REJECTED_CODE,
        `Refusing interactive guest preparation: command "${entry.id}" targets a host mount (${target}); ` +
          "preparation commands target guest-local paths only.",
      );
    }
  }

  return {
    harness: input.harness,
    shell: input.shell,
    uid,
    gid,
    user: INTERACTIVE_GUEST_USER_NAME,
    group: INTERACTIVE_GUEST_GROUP_NAME,
    guestHome,
    guestConfigurationRoot,
    guestWorkingDirectory,
    commands,
    env,
  };
}
