#!/usr/bin/env node

/**
 * Inject the build version into the built CLI and write dist/version.
 * Computes ISO8601_refhash from git state (committer timestamp + full SHA1),
 * falls back to package.json version if git commands fail (e.g., no .git dir).
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const pkgPath = path.join(repoRoot, "package.json");
const versionPath = path.join(repoRoot, "dist", "version");

// The standalone command module owns BUILT_VERSION after the SPL2 extraction.
const injectTargets = [
  path.join(repoRoot, "dist", "cli", "commands", "standalone.js"),
];

/**
 * Compute build version from git state.
 * Format: YYYYMMDDTHHMMSSZ_40-char-hex-sha1
 * Timestamp is the committer date converted to UTC.
 * Returns null if git commands fail.
 */
function getGitVersion() {
  try {
    // Get Unix timestamp of HEAD committer date
    const unixTimestamp = execSync("git log -1 --format=%ct HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const date = new Date(parseInt(unixTimestamp, 10) * 1000);
    const Y = date.getUTCFullYear();
    const M = String(date.getUTCMonth() + 1).padStart(2, "0");
    const D = String(date.getUTCDate()).padStart(2, "0");
    const h = String(date.getUTCHours()).padStart(2, "0");
    const m = String(date.getUTCMinutes()).padStart(2, "0");
    const s = String(date.getUTCSeconds()).padStart(2, "0");
    const timestamp = `${Y}${M}${D}T${h}${m}${s}Z`;

    // Get full 40-char SHA1
    const sha1 = execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    return `${timestamp}_${sha1}`;
  } catch {
    return null;
  }
}

function getFallbackVersion() {
  if (!fs.existsSync(pkgPath)) {
    console.error("package.json not found at", pkgPath);
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  return pkg.version ?? "0.0.0";
}

const version = getGitVersion() ?? getFallbackVersion();

// Write dist/version
fs.mkdirSync(path.dirname(versionPath), { recursive: true });
fs.writeFileSync(versionPath, version + "\n", "utf-8");
console.log(`Build version: ${version}`);

// Inject version into built files, replacing __VERSION__ placeholder
for (const targetPath of injectTargets) {
  if (!fs.existsSync(targetPath)) continue;

  let source = fs.readFileSync(targetPath, "utf-8");

  if (source.includes("__VERSION__")) {
    source = source.replace(/"__VERSION__"/g, JSON.stringify(version));
    fs.writeFileSync(targetPath, source, "utf-8");
    console.log(`Injected version into ${path.relative(repoRoot, targetPath)}`);
  }
}

if (injectTargets.every(p => !fs.existsSync(p))) {
  console.error("No dist CLI files found — run 'npm run build' first");
  process.exit(1);
}
