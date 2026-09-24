import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Robust recursive scan walker (TEST-HYGIENE-0923 item 3a / bead tamandua-6sy.88).
 *
 * Why this exists: source-tree scanners (the vocabulary guard that forbids the
 * retired checkout label across src/ and e2e-tests/ is the original consumer)
 * walk a large, LIVE tree and then read every collected file. Other test files
 * run concurrently in the same lane and some of them create scratch fixtures
 * INSIDE the scanned tree and delete them again in a `finally` block
 * (tests/e2e-syntax-check.test.ts historically mkdtemps'd
 * `e2e-tests/fixtures/syntax-gate-test-<rand>/` and rm -rf'd it; TEST-HYGIENE-0923
 * item 3b moved those scratch dirs out of the tree, and the pattern below is kept
 * as defence in depth for any current or future in-tree scratch fixture). A
 * one-shot `readFileSync` walk therefore died with ENOENT on a file that was
 * perfectly fine when it was listed (Mac unit lane 15:26Z), and a scanner that
 * merely swallowed every error would instead hide real findings. This module
 * separates the two:
 *
 *  - files/directories matching the documented TRANSIENT_FIXTURE_PATTERNS are
 *    never collected (they are scratch state owned by another test, not
 *    repository content, so they can never be a legitimate offender);
 *  - a listed file that disappears before it is read (ENOENT/ENOTDIR) is
 *    recorded as vanished and skipped — never an offender, never a throw;
 *  - a listed file that STILL EXISTS is always returned with its contents, so
 *    a genuine offender can never be swallowed;
 *  - any other read/walk error (EACCES, EIO, ...) is rethrown: this walker is
 *    tolerated about racing transients, not about real I/O failures;
 *  - a scanned root that is missing, or that is removed mid-walk, contributes
 *    nothing instead of throwing.
 *
 * Deliberately imports only node:fs / node:path (no node:child_process) so a
 * test file that uses it stays in the parallel lane
 * (tests/serial-classification-guard.test.ts).
 */

/**
 * Documented transient-fixture patterns.
 *
 * These three namespaces are scratch state: paths whose basename matches are
 * produced and removed by other tests inside the scanned tree. They are
 * documented here so a future contributor adding a transient fixture can see
 * the conventions, and so a scanner can never be blamed for skipping them.
 */
export const TRANSIENT_FIXTURE_PATTERNS: readonly TransientFixturePattern[] = [
  {
    id: "syntax-gate-test",
    description:
      "syntax-gate scratch dir syntax-gate-test-<rand>/ — created and removed by tests/e2e-syntax-check.test.ts; since TEST-HYGIENE-0923 item 3b it is created OUTSIDE the repository tree, the pattern is kept for any in-tree scratch dir of that shape",
    matches: (_relativePath, name) => name.startsWith("syntax-gate-test-"),
  },
  {
    id: "dot-tmp-prefix",
    description: "generic scratch entries named .tmp-<something>",
    matches: (_relativePath, name) => name.startsWith(".tmp-"),
  },
  {
    id: "dot-tmp-suffix",
    description: "generic scratch files named <something>.tmp",
    matches: (_relativePath, name) => name.endsWith(".tmp"),
  },
];

export interface TransientFixturePattern {
  /** Stable identifier used in the skip report and in tests. */
  id: string;
  /** Human-readable rationale, printed/documented for contributors. */
  description: string;
  /** Matches an entry by its scanned-relative path and by its basename. */
  matches(relativePath: string, name: string): boolean;
}

/** Directory names never descended into. */
export const DEFAULT_SKIPPED_DIR_NAMES: readonly string[] = ["node_modules", ".git"];

export interface ScanWalkDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink?(): boolean;
}

/**
 * Injectable filesystem surface. Defaults are the real node:fs calls; tests
 * script them to reproduce a directory that vanishes mid-walk deterministically.
 */
export interface ScanWalkDeps {
  readDir(dir: string): ScanWalkDirent[];
  readFile(path: string): string;
  /** Returns null when the path does not exist (or is not a directory). */
  isDirectory(path: string): boolean | null;
  isSymbolicLink?(path: string): boolean;
  statIsDirectory?(path: string): boolean | null;
}

export interface ScanWalkOptions {
  /** Roots to scan, absolute or relative to `cwd`. */
  roots: readonly string[];
  /** File extensions to collect (compared case-insensitively), e.g. ".ts". */
  extensions: readonly string[];
  /** Base directory for relative-path reporting; defaults to process.cwd(). */
  cwd?: string;
  /** Directory basenames pruned from the walk (defaults to DEFAULT_SKIPPED_DIR_NAMES). */
  skippedDirNames?: readonly string[];
  /** Transient-fixture patterns (defaults to TRANSIENT_FIXTURE_PATTERNS). */
  transientPatterns?: readonly TransientFixturePattern[];
  deps?: Partial<ScanWalkDeps>;
}

export interface ScanWalkCollection {
  /** Collected file paths, in walk order, as passed in (absolute or cwd-relative). */
  files: string[];
  /** Scanned-relative paths skipped because they match a transient pattern. */
  skippedTransientPaths: string[];
}

export interface ScanWalkResult {
  files: string[];
  /** Files that were collected and then found still present, with contents. */
  contents: Array<{ path: string; text: string }>;
  /** Collected files that vanished (ENOENT/ENOTDIR) before they could be read. */
  vanishedPaths: string[];
  skippedTransientPaths: string[];
}

function isToleratedRacingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * True when ANY path component of `relativePath` matches a documented transient
 * pattern. Checking every component (not just the basename) means a caller that
 * inspects a full path — and the walk itself, which checks each entry as it
 * descends — agrees on what is transient.
 */
export function isTransientFixturePath(
  relativePath: string,
  patterns: readonly TransientFixturePattern[] = TRANSIENT_FIXTURE_PATTERNS,
): boolean {
  const components = relativePath.split(/[/\\]+/).filter((component) => component.length > 0);
  return components.some((name) => patterns.some((pattern) => pattern.matches(relativePath, name)));
}

function defaultDeps(): ScanWalkDeps {
  return {
    readDir(dir: string): ScanWalkDirent[] {
      return readdirSync(dir, { withFileTypes: true }) as unknown as ScanWalkDirent[];
    },
    readFile(path: string): string {
      return readFileSync(path, "utf8");
    },
    isDirectory(path: string): boolean | null {
      try {
        return statSync(path).isDirectory();
      } catch (error) {
        if (isToleratedRacingError(error)) return null;
        throw error;
      }
    },
    isSymbolicLink(path: string): boolean {
      try {
        return lstatSync(path).isSymbolicLink();
      } catch (error) {
        if (isToleratedRacingError(error)) return false;
        throw error;
      }
    },
    statIsDirectory(path: string): boolean | null {
      try {
        return statSync(path).isDirectory();
      } catch (error) {
        if (isToleratedRacingError(error)) return null;
        throw error;
      }
    },
  };
}

/** Path used for transient matching and skip reporting: relative to `cwd`. */
function toScannedRelative(root: string, fullPath: string, cwd: string): string {
  if (fullPath.startsWith(root)) {
    const rest = fullPath.slice(root.length).replace(/^[/\\]+/, "");
    return rest === "" ? basename(fullPath) : rest;
  }
  return fullPath.startsWith(cwd) ? fullPath.slice(cwd.length).replace(/^[/\\]+/, "") : fullPath;
}

function normalizeExtensions(extensions: readonly string[]): string[] {
  return extensions.map((ext) => (ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`));
}

/**
 * Collects files under `roots` whose name matches one of `extensions`,
 * pruning transient-fixture paths and the default skipped directories.
 */
export function collectScanFiles(options: ScanWalkOptions): ScanWalkCollection {
  const cwd = options.cwd ?? process.cwd();
  const deps = { ...defaultDeps(), ...options.deps };
  const extensions = normalizeExtensions(options.extensions);
  const skippedDirNames = new Set(options.skippedDirNames ?? DEFAULT_SKIPPED_DIR_NAMES);
  const transientPatterns = options.transientPatterns ?? TRANSIENT_FIXTURE_PATTERNS;

  const files: string[] = [];
  const skippedTransientPaths: string[] = [];
  const visitedDirectories = new Set<string>();

  const walk = (dir: string, root: string): void => {
    if (visitedDirectories.has(dir)) return;
    visitedDirectories.add(dir);

    let entries: ScanWalkDirent[];
    try {
      entries = deps.readDir(dir);
    } catch (error) {
      // The directory itself vanished (or stopped being a directory) mid-walk.
      if (isToleratedRacingError(error)) return;
      throw error;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);
      const relativePath = toScannedRelative(root, full, cwd);

      if (isTransientFixturePath(relativePath, transientPatterns)) {
        skippedTransientPaths.push(relativePath);
        continue;
      }

      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink?.() && deps.statIsDirectory) {
        // A symlink to a directory is descended into only when the stat says so.
        isDirectory = deps.statIsDirectory(full) === true;
      }

      if (isDirectory) {
        if (skippedDirNames.has(entry.name)) continue;
        walk(full, root);
        continue;
      }

      if (!entry.isFile()) continue;
      const lowerName = entry.name.toLowerCase();
      if (extensions.some((ext) => lowerName.endsWith(ext))) files.push(full);
    }
  };

  for (const root of options.roots) {
    const absoluteRoot = root.startsWith("/") ? root : join(cwd, root);
    const rootIsDirectory = deps.isDirectory(absoluteRoot);
    // A missing/unreadable-in-a-racing-way root contributes nothing.
    if (rootIsDirectory !== true) continue;
    walk(absoluteRoot, absoluteRoot);
  }

  return { files, skippedTransientPaths };
}

/**
 * Reads every collected file. Files that vanished after collection are
 * recorded in `vanishedPaths` and excluded from `contents`; everything else is
 * returned verbatim so a real finding can never be dropped.
 */
export function readCollectedFiles(
  files: readonly string[],
  options: { deps?: Partial<ScanWalkDeps> } = {},
): { contents: Array<{ path: string; text: string }>; vanishedPaths: string[] } {
  const deps = { ...defaultDeps(), ...options.deps };
  const contents: Array<{ path: string; text: string }> = [];
  const vanishedPaths: string[] = [];

  for (const file of files) {
    try {
      contents.push({ path: file, text: deps.readFile(file) });
    } catch (error) {
      if (isToleratedRacingError(error)) {
        vanishedPaths.push(file);
        continue;
      }
      // A real I/O problem (permission, hardware) must not be swallowed.
      throw error;
    }
  }

  return { contents, vanishedPaths };
}

/**
 * Collect-and-read in one call: the shape a source scanner wants. Returns the
 * collected file list, the readable contents, the files that vanished
 * mid-walk, and the transient paths that were skipped.
 */
export function scanRootsForContents(options: ScanWalkOptions): ScanWalkResult {
  const collection = collectScanFiles(options);
  const { contents, vanishedPaths } = readCollectedFiles(collection.files, { deps: options.deps });
  return {
    files: collection.files,
    contents,
    vanishedPaths,
    skippedTransientPaths: collection.skippedTransientPaths,
  };
}