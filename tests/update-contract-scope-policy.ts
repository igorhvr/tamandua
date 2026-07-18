import fs from "node:fs";
import path from "node:path";

export type ScanLimits = {
  maxVisitedEntries: number;
  maxCandidateFiles: number;
  maxBytesPerFile: number;
  maxAggregateBytes: number;
};

export type ProductionFile = {
  relativePath: string;
  source: string;
};

export type PhaseFlag = {
  path: string;
  value: unknown;
};

export const DEFAULT_SCAN_LIMITS: Readonly<ScanLimits> = Object.freeze({
  maxVisitedEntries: 50_000,
  maxCandidateFiles: 10_000,
  maxBytesPerFile: 2 * 1024 * 1024,
  maxAggregateBytes: 64 * 1024 * 1024,
});

export const REQUIRED_PHASE_FLAG_PATHS: readonly string[] = Object.freeze([
  "UPDATE_CONTRACT.admission.productionWired",
  "UPDATE_CONTRACT.artifactContract.productionWired",
  "UPDATE_CONTRACT.capabilityLifecycle.implementedMismatch.productionWired",
  "UPDATE_CONTRACT.controlFlow.productionWired",
  "UPDATE_CONTRACT.downstreamScopes.productionWired",
  "UPDATE_CONTRACT.faultContract.productionWired",
  "UPDATE_CONTRACT.implementation.foundation.productionWired",
  "UPDATE_CONTRACT.implementation.productionLifecycle.claimsLiveSafety",
  "UPDATE_CONTRACT.implementation.productionLifecycle.productionWired",
  "UPDATE_CONTRACT.lifecycle.implementedFoundation.productionWired",
  "UPDATE_CONTRACT.lifecycle.productionWired",
  "UPDATE_CONTRACT.readiness.productionWired",
  "UPDATE_CONTRACT.terminalProtocol.productionWired",
  "UPDATE_CONTRACT.topologies.current.productionWired",
  "UPDATE_CONTRACT.topologies.legacy.productionWired",
]);

const DIRECTORY_ROOTS = ["bin", "src", "scripts", "workflows"] as const;
const EXACT_FILES = ["build", "install", "build-and-install", "package.json"] as const;
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".git",
  "__fixtures__",
  "__tests__",
  "coverage",
  "dist",
  "docs",
  "fixtures",
  "generated",
  "node_modules",
  "tests",
  "vendor",
]);
const TEXT_EXTENSIONS = new Set([
  ".bash",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

export function unicodeCodePointCompare(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function normalized(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function isExcluded(relativePath: string, directory: boolean): boolean {
  const normalizedPath = normalized(relativePath);
  if (normalizedPath === "scripts/update-contract.mjs") return true;
  const segments = normalizedPath.split("/");
  if (directory && EXCLUDED_DIRECTORY_NAMES.has(segments.at(-1)!)) return true;
  if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return true;
  return /(?:^|\.)[^/]*\.(?:test|spec)\.[^/]+$/u.test(segments.at(-1)!);
}

function isRelevantTextFile(relativePath: string, exact: boolean): boolean {
  if (exact) return true;
  const basename = path.basename(relativePath);
  return !basename.includes(".") || TEXT_EXTENSIONS.has(path.extname(basename).toLowerCase());
}

function validatedLimits(overrides: Partial<ScanLimits>): ScanLimits {
  const limits = { ...DEFAULT_SCAN_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`update contract scope policy requires ${name} to be a non-negative safe integer`);
    }
  }
  return limits;
}

export function collectProductionFiles(
  repoRoot: string,
  overrides: Partial<ScanLimits> = {},
): ProductionFile[] {
  const limits = validatedLimits(overrides);
  const root = path.resolve(repoRoot);
  const candidates: string[] = [];
  let visitedEntries = 0;

  const addCandidate = (relativePath: string, exact = false): void => {
    const policyPath = normalized(relativePath);
    if (isExcluded(policyPath, false) || !isRelevantTextFile(policyPath, exact)) return;
    candidates.push(policyPath);
    if (candidates.length > limits.maxCandidateFiles) {
      throw new Error(
        `update contract scope policy maximum candidate files (${limits.maxCandidateFiles}) exceeded at ${policyPath}`,
      );
    }
  };

  const walk = (relativeDirectory: string): void => {
    const absoluteDirectory = path.join(root, relativeDirectory);
    let rootStat: fs.Stats;
    try {
      rootStat = fs.lstatSync(absoluteDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;

    const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => unicodeCodePointCompare(left.name, right.name));
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const policyPath = normalized(relativePath);
      visitedEntries += 1;
      if (visitedEntries > limits.maxVisitedEntries) {
        throw new Error(
          `update contract scope policy maximum visited directory entries (${limits.maxVisitedEntries}) exceeded at ${policyPath}`,
        );
      }
      if (entry.isSymbolicLink() || isExcluded(policyPath, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        walk(relativePath);
      } else if (entry.isFile()) {
        addCandidate(relativePath);
      }
    }
  };

  for (const directory of DIRECTORY_ROOTS) walk(directory);
  for (const exactFile of EXACT_FILES) {
    const absolutePath = path.join(root, exactFile);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isFile()) addCandidate(exactFile, true);
  }

  candidates.sort(unicodeCodePointCompare);
  const files: ProductionFile[] = [];
  let aggregateBytes = 0;
  for (const relativePath of candidates) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile()) continue;
    if (stat.size > limits.maxBytesPerFile) {
      throw new Error(
        `update contract scope policy maximum bytes per file (${limits.maxBytesPerFile}) exceeded by ${relativePath} (${stat.size} bytes)`,
      );
    }
    aggregateBytes += stat.size;
    if (aggregateBytes > limits.maxAggregateBytes) {
      throw new Error(
        `update contract scope policy maximum aggregate bytes (${limits.maxAggregateBytes}) exceeded at ${relativePath} (${aggregateBytes} bytes)`,
      );
    }
    files.push({ relativePath, source: fs.readFileSync(absolutePath, "utf8") });
  }
  return files;
}

/**
 * Deliberately broad while the contract is unwired: canonical identifier text or
 * the module basename, including whitespace/quote/concatenation-separated forms,
 * is treated as a production reference. A wired phase must replace this blanket
 * rejection with a reviewed policy naming exact surfaces and callers.
 */
function containsContractSignal(source: string): boolean {
  if (/tamandua\.upgx\.contract/u.test(source)) return true;
  const constructionCollapsed = source.replace(/[\s"'`+]/gu, "");
  return /update-contract\.mjs/iu.test(constructionCollapsed);
}

export function findContractReferencePaths(files: readonly ProductionFile[]): string[] {
  return files
    .filter((file) => containsContractSignal(file.source))
    .map((file) => file.relativePath)
    .sort(unicodeCodePointCompare);
}

export function assertNoProductionContractReferences(
  repoRoot: string,
  overrides: Partial<ScanLimits> = {},
): void {
  const offenders = findContractReferencePaths(collectProductionFiles(repoRoot, overrides));
  if (offenders.length > 0) {
    throw new Error(
      `target-only update contract is referenced by production paths:\n${offenders.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }
}

export function collectPhaseFlags(contract: unknown): PhaseFlag[] {
  const flags: PhaseFlag[] = [];
  const ancestors = new Set<object>();
  const visit = (value: unknown, location: string): void => {
    if (value === null || typeof value !== "object") return;
    if (ancestors.has(value)) {
      throw new Error(`update contract phase policy cannot inspect cyclic data at ${location}`);
    }
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort(unicodeCodePointCompare)) {
      const childLocation = `${location}.${key}`;
      if (key === "productionWired" || key === "claimsLiveSafety") {
        flags.push({ path: childLocation, value: record[key] });
      }
      visit(record[key], childLocation);
    }
    ancestors.delete(value);
  };
  visit(contract, "UPDATE_CONTRACT");
  return flags.sort((left, right) => unicodeCodePointCompare(left.path, right.path));
}

function displayValue(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function assertUnwiredPhasePolicy(contract: unknown): void {
  const flags = collectPhaseFlags(contract);
  const present = new Set(flags.map((flag) => flag.path));
  const missing = REQUIRED_PHASE_FLAG_PATHS.filter((requiredPath) => !present.has(requiredPath));
  if (missing.length > 0) {
    throw new Error(`update contract required phase flags missing: ${missing.join(", ")}`);
  }

  const transitioned = flags.filter((flag) => flag.value !== false);
  if (transitioned.length > 0) {
    const details = transitioned
      .map((flag) => `${flag.path}=${displayValue(flag.value)}`)
      .join(", ");
    throw new Error(
      "update contract phase transition requires a reviewed allow-policy naming exact allowed production surfaces and callers; " +
      `non-false flags: ${details}`,
    );
  }
}
