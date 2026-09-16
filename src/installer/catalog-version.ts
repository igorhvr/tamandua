import fs from "node:fs";
import path from "node:path";
import { resolveWorkflowRoot } from "./paths.js";
import { nowIso } from "../lib/instant.js";
import { getBuildVersion } from "../lib/version.js";

/**
 * CATA-VSN — 20260705 — bundled-prompt-freshness guard
 *
 * At install/update time we record a stamp under the installed-catalog root
 * so tamandua doctor and `tamandua workflow run` can tell users their
 * installed prompts are older than the bundled catalog.
 *
 * Choice: build version (tamandua --version) over content hash because:
 *   - Already injected at build time, zero extra work.
 *   - The version changes on every commit (YYYYMMDD + hash), giving
 *     us a cheap per-commit staleness signal.
 *   - A content hash over workflows/ + agents/ + skills/ would require
 *     walking/checksumming the whole tree at every check, which violates
 *     the "one stat + one read" constraint.
 */

export interface CatalogStamp {
  version: string;
  sourcePath: string;
  installedAt: string;
}

const CATALOG_STAMP_FILENAME = ".catalog-version.json";

/**
 * Resolves the path to the catalog version stamp file.
 */
export function resolveCatalogVersionPath(): string {
  return path.join(resolveWorkflowRoot(), CATALOG_STAMP_FILENAME);
}

/**
 * Generates a catalog stamp object with the current build version,
 * source path, and timestamp.
 */
export function generateCatalogStamp(sourcePath: string): CatalogStamp {
  return {
    version: getBuildVersion(),
    sourcePath,
    installedAt: nowIso(),
  };
}

/**
 * Writes the catalog stamp to ~/.tamandua/workflows/.catalog-version.json.
 * Creates the parent directory if it doesn't exist.
 */
export function writeCatalogStamp(sourcePath: string): void {
  const stamp: CatalogStamp = generateCatalogStamp(sourcePath);
  const stampPath = resolveCatalogVersionPath();
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(stampPath, JSON.stringify(stamp, null, 2) + "\n", "utf-8");
}

/**
 * Performs a cheap synchronous check (stat + read + string compare — no network,
 * no git) comparing the installed catalog stamp against the current build version.
 *
 * @returns A one-line warning string if the catalog is stale or the stamp is missing,
 *          or an empty string if the catalog is current.
 */
export function checkCatalogStalenessWarning(): string {
  const stamp = readInstalledCatalogStamp();
  if (!stamp) {
    return "Warning: installed catalog is older than bundled catalog. Run tamandua update --force to apply latest workflow/persona fixes.";
  }
  const currentVersion = getBuildVersion();
  if (currentVersion === "unknown" || stamp.version !== currentVersion) {
    return "Warning: installed catalog is older than bundled catalog. Run tamandua update --force to apply latest workflow/persona fixes.";
  }
  return "";
}

/**
 * Reads the installed catalog stamp.
 *
 * @returns The parsed CatalogStamp, or null if the file doesn't exist or is invalid.
 */
export function readInstalledCatalogStamp(): CatalogStamp | null {
  const stampPath = resolveCatalogVersionPath();
  try {
    const raw = fs.readFileSync(stampPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.version === "string" &&
      parsed.version.length > 0 &&
      typeof parsed.sourcePath === "string" &&
      typeof parsed.installedAt === "string"
    ) {
      return {
        version: parsed.version,
        sourcePath: parsed.sourcePath,
        installedAt: parsed.installedAt,
      };
    }
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    // Unparseable / permission error → treat as missing
    return null;
  }
}
